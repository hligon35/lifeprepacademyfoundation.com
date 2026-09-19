import { getSessionUser } from "./auth-magic-link.js";

const PROGRAM_MANAGER_ROLES = new Set(["super_admin", "program_administrator"]);
const DEFAULT_PROGRAM_ID = "paducah-go-soccer-league";
const SQUARE_PRODUCTION_API = "https://connect.squareup.com";
const SQUARE_SANDBOX_API = "https://connect.squareupsandbox.com";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function json(data, status = 200, request) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
  const origin = request?.headers?.get("Origin");
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function denied(message = "Commerce access denied") {
  return json({ ok: false, error: message }, 403);
}

function roleIds(context, programId) {
  const roles = new Set(
    (context?.roles || [])
      .filter((role) => role.program_id === programId)
      .map((role) => role.id),
  );
  (context?.assignments || [])
    .filter((assignment) => assignment.program_id === programId && assignment.status === "active")
    .forEach((assignment) => roles.add(assignment.role_id));
  if (context?.isSuperAdmin) roles.add("super_admin");
  return roles;
}

function canView(context, programId) {
  return Boolean(context?.isSuperAdmin || (context?.programs || []).some((program) => program.id === programId));
}

function canManage(context, programId) {
  if (context?.isSuperAdmin) return true;
  const roles = roleIds(context, programId);
  return [...PROGRAM_MANAGER_ROLES].some((role) => roles.has(role));
}

function normalizeVariants(value, fallbackPrice) {
  const input = Array.isArray(value) ? value : [];
  const variants = input.map((variant) => ({
    name: text(variant?.name) || "Standard",
    sku: text(variant?.sku) || null,
    priceCents: Math.max(0, Math.round(Number(variant?.priceCents ?? fallbackPrice ?? 0))),
    inventoryCount: Number.isFinite(Number(variant?.inventoryCount)) ? Math.max(-1, Math.floor(Number(variant.inventoryCount))) : -1,
    squareCatalogObjectId: text(variant?.squareCatalogObjectId) || null,
    squareCheckoutUrl: text(variant?.squareCheckoutUrl) || null,
  }));
  return variants.length ? variants : [{
    name: "Standard",
    sku: null,
    priceCents: Math.max(0, Math.round(Number(fallbackPrice || 0))),
    inventoryCount: -1,
    squareCatalogObjectId: null,
    squareCheckoutUrl: null,
  }];
}

async function readProducts(env, programId, includeArchived = false) {
  const products = await env.DB.prepare(
    "SELECT id, program_id, name, description, image_url, category, sort_order, visible, price_cents, status, created_at, updated_at FROM products WHERE program_id = ? " + (includeArchived ? "" : "AND status = 'active' AND visible = 1 ") + "ORDER BY sort_order, name",
  ).bind(programId).all();
  const rows = products.results || [];
  if (!rows.length) return [];
  const ids = rows.map((product) => product.id);
  const placeholders = ids.map(() => "?").join(",");
  const [variants, images] = await Promise.all([
    env.DB.prepare("SELECT id, product_id, name, sku, price_cents, inventory_count, reserved_count, square_catalog_object_id, square_checkout_url, status FROM product_variants WHERE product_id IN (" + placeholders + ") AND status = 'active' ORDER BY name").bind(...ids).all(),
    env.DB.prepare("SELECT id, product_id, image_url, alt_text, sort_order FROM product_images WHERE product_id IN (" + placeholders + ") ORDER BY sort_order").bind(...ids).all(),
  ]);
  const variantsByProduct = new Map();
  (variants.results || []).forEach((variant) => {
    if (!variantsByProduct.has(variant.product_id)) variantsByProduct.set(variant.product_id, []);
    variantsByProduct.get(variant.product_id).push({
      ...variant,
      available_count: Number(variant.inventory_count) < 0 ? null : Math.max(0, Number(variant.inventory_count) - Number(variant.reserved_count || 0)),
    });
  });
  const imagesByProduct = new Map();
  (images.results || []).forEach((image) => {
    if (!imagesByProduct.has(image.product_id)) imagesByProduct.set(image.product_id, []);
    imagesByProduct.get(image.product_id).push(image);
  });
  return rows.map((product) => ({
    ...product,
    variants: variantsByProduct.get(product.id) || [],
    images: imagesByProduct.get(product.id) || [],
  }));
}

async function publicProducts(request, env) {
  const programId = text(new URL(request.url).searchParams.get("programId")) || DEFAULT_PROGRAM_ID;
  if (!env?.DB) return json({ ok: true, products: [] }, 200, request);
  try {
    const products = await readProducts(env, programId);
    return json({
      ok: true,
      products: products.map((product) => ({
        ...product,
        variants: product.variants.map(({ reserved_count, square_catalog_object_id, square_checkout_url, ...variant }) => variant),
      })),
    }, 200, request);
  } catch (error) {
    console.error("public-products-read-failed", error);
    return json({ ok: true, products: [] }, 200, request);
  }
}

async function adminProducts(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canView(context, programId)) return denied();
  return json({ ok: true, products: await readProducts(env, programId, true) }, 200, request);
}

async function createProduct(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  if (!programId || !canManage(context, programId)) return denied("Merchandise management denied");
  const name = text(payload?.name);
  if (!name) return json({ ok: false, error: "Product name is required" }, 400, request);
  const variants = normalizeVariants(payload?.variants, payload?.priceCents);
  const productId = crypto.randomUUID();
  const now = "datetime('now')";
  const firstPrice = variants[0].priceCents;
  await env.DB.prepare(
    "INSERT INTO products (id, program_id, name, price_cents, description, image_url, category, sort_order, visible, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))",
  ).bind(productId, programId, name, firstPrice, text(payload?.description) || null, text(payload?.imageUrl) || null, text(payload?.category) || "merchandise", Math.floor(Number(payload?.sortOrder || 0)), payload?.visible === false ? 0 : 1).run();
  for (const variant of variants) {
    await env.DB.prepare(
      "INSERT INTO product_variants (id, product_id, name, sku, price_cents, inventory_count, square_catalog_object_id, square_checkout_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    ).bind(crypto.randomUUID(), productId, variant.name, variant.sku, variant.priceCents, variant.inventoryCount, variant.squareCatalogObjectId, variant.squareCheckoutUrl).run();
  }
  await auditCommerce(env, context, "commerce.product.created", "product", productId, programId, { variantCount: variants.length });
  return json({ ok: true, products: await readProducts(env, programId, true) }, 201, request);
}

async function uploadProductImage(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canManage(context, programId)) return denied("Merchandise management denied");
  if (!env.SITE_STATIC || typeof env.SITE_STATIC.put !== "function") return json({ ok: false, error: "Public media storage is not configured." }, 503, request);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file.arrayBuffer !== "function") return json({ ok: false, error: "Choose an image file to upload." }, 400, request);
  const contentType = text(file.type).toLowerCase();
  if (!contentType.startsWith("image/")) return json({ ok: false, error: "Merchandise images must be image files." }, 415, request);
  if (Number(file.size || 0) > 8 * 1024 * 1024) return json({ ok: false, error: "Merchandise images must be 8 MB or smaller." }, 413, request);
  const extension = contentType.split("/")[1].replace(/[^a-z0-9]/g, "") || "bin";
  const key = "commerce/" + programId + "/" + crypto.randomUUID() + "." + extension;
  await env.SITE_STATIC.put(key, await file.arrayBuffer(), { httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" } });
  return json({ ok: true, imageUrl: new URL("/media/" + key, request.url).toString() }, 201, request);
}

async function updateProduct(request, env, context, productId) {
  const existing = await env.DB.prepare("SELECT id, program_id FROM products WHERE id = ? LIMIT 1").bind(productId).first();
  if (!existing) return json({ ok: false, error: "Product not found" }, 404, request);
  if (!canManage(context, existing.program_id)) return denied("Merchandise management denied");
  const payload = await request.json().catch(() => null);
  const fields = [];
  const values = [];
  const add = (column, value) => { if (value !== undefined) { fields.push(column + " = ?"); values.push(value); } };
  add("name", text(payload?.name));
  add("description", text(payload?.description) || null);
  add("image_url", text(payload?.imageUrl) || null);
  add("category", text(payload?.category) || "merchandise");
  if (payload?.sortOrder !== undefined) add("sort_order", Math.floor(Number(payload.sortOrder || 0)));
  if (payload?.visible !== undefined) add("visible", payload.visible ? 1 : 0);
  if (payload?.status !== undefined && ["active", "archived"].includes(text(payload.status))) add("status", text(payload.status));
  if (!fields.length) return json({ ok: true }, 200, request);
  fields.push("updated_at = datetime('now')");
  values.push(productId);
  await env.DB.prepare("UPDATE products SET " + fields.join(", ") + " WHERE id = ?").bind(...values).run();
  await auditCommerce(env, context, "commerce.product.updated", "product", productId, existing.program_id, { fields: fields.map((field) => field.split(" ")[0]) });
  return json({ ok: true }, 200, request);
}

async function createVariant(request, env, context, productId) {
  const product = await env.DB.prepare("SELECT id, program_id FROM products WHERE id = ? LIMIT 1").bind(productId).first();
  if (!product) return json({ ok: false, error: "Product not found" }, 404, request);
  if (!canManage(context, product.program_id)) return denied("Merchandise management denied");
  const payload = await request.json().catch(() => null);
  const variant = normalizeVariants([payload], 0)[0];
  await env.DB.prepare(
    "INSERT INTO product_variants (id, product_id, name, sku, price_cents, inventory_count, square_catalog_object_id, square_checkout_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
  ).bind(crypto.randomUUID(), productId, variant.name, variant.sku, variant.priceCents, variant.inventoryCount, variant.squareCatalogObjectId, variant.squareCheckoutUrl).run();
  return json({ ok: true }, 201, request);
}

async function updateVariant(request, env, context, variantId) {
  const variant = await env.DB.prepare("SELECT pv.id, p.program_id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = ? LIMIT 1").bind(variantId).first();
  if (!variant) return json({ ok: false, error: "Variant not found" }, 404, request);
  if (!canManage(context, variant.program_id)) return denied("Merchandise management denied");
  const payload = await request.json().catch(() => null);
  const fields = [];
  const values = [];
  const add = (column, value) => { if (value !== undefined) { fields.push(column + " = ?"); values.push(value); } };
  add("name", text(payload?.name));
  add("sku", text(payload?.sku) || null);
  if (payload?.priceCents !== undefined) add("price_cents", Math.max(0, Math.round(Number(payload.priceCents || 0))));
  if (payload?.inventoryCount !== undefined) add("inventory_count", Math.max(-1, Math.floor(Number(payload.inventoryCount))));
  if (payload?.squareCatalogObjectId !== undefined) add("square_catalog_object_id", text(payload.squareCatalogObjectId) || null);
  if (payload?.squareCheckoutUrl !== undefined) add("square_checkout_url", text(payload.squareCheckoutUrl) || null);
  if (payload?.status !== undefined && ["active", "archived"].includes(text(payload.status))) add("status", text(payload.status));
  if (!fields.length) return json({ ok: true }, 200, request);
  fields.push("updated_at = datetime('now')");
  values.push(variantId);
  await env.DB.prepare("UPDATE product_variants SET " + fields.join(", ") + " WHERE id = ?").bind(...values).run();
  return json({ ok: true }, 200, request);
}

async function adminOrders(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canManage(context, programId)) return denied("Order management denied");
  const status = text(url.searchParams.get("status"));
  const values = [programId];
  const where = ["o.program_id = ?"];
  if (status && status !== "all") { where.push("o.status = ?"); values.push(status); }
  const orders = await env.DB.prepare(
    "SELECT o.id, o.status, o.fulfillment_status, o.total_cents, o.customer_name, o.customer_email, o.created_at, o.updated_at, GROUP_CONCAT(oi.product_name || CASE WHEN oi.variant_name IS NULL THEN '' ELSE ' · ' || oi.variant_name END || ' ×' || oi.quantity, ', ') AS item_summary FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id WHERE " + where.join(" AND ") + " GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100",
  ).bind(...values).all();
  return json({ ok: true, orders: orders.results || [] }, 200, request);
}

async function updateOrder(request, env, context, orderId) {
  const order = await env.DB.prepare("SELECT id, program_id FROM orders WHERE id = ? LIMIT 1").bind(orderId).first();
  if (!order) return json({ ok: false, error: "Order not found" }, 404, request);
  if (!canManage(context, order.program_id)) return denied("Order management denied");
  const payload = await request.json().catch(() => null);
  const status = text(payload?.status);
  const fulfillmentStatus = text(payload?.fulfillmentStatus);
  if (status && !["pending", "paid", "cancelled", "refunded"].includes(status)) return json({ ok: false, error: "Invalid order status" }, 400, request);
  if (fulfillmentStatus && !["unfulfilled", "ready", "fulfilled", "cancelled"].includes(fulfillmentStatus)) return json({ ok: false, error: "Invalid fulfillment status" }, 400, request);
  const fields = [];
  const values = [];
  if (status) { fields.push("status = ?"); values.push(status); }
  if (fulfillmentStatus) { fields.push("fulfillment_status = ?"); values.push(fulfillmentStatus); }
  if (!fields.length) return json({ ok: true }, 200, request);
  fields.push("updated_at = datetime('now')");
  values.push(orderId);
  await env.DB.prepare("UPDATE orders SET " + fields.join(", ") + " WHERE id = ?").bind(...values).run();
  await auditCommerce(env, context, "commerce.order.updated", "order", orderId, order.program_id, { status, fulfillmentStatus });
  return json({ ok: true }, 200, request);
}

async function refundOrder(request, env, context, orderId) {
  const order = await env.DB.prepare("SELECT id, program_id, status, total_cents FROM orders WHERE id = ? LIMIT 1").bind(orderId).first();
  if (!order) return json({ ok: false, error: "Order not found" }, 404, request);
  if (!canManage(context, order.program_id)) return denied("Order management denied");
  if (order.status !== "paid") return json({ ok: false, error: "Only paid orders can be refunded." }, 409, request);
  const payment = await env.DB.prepare("SELECT square_payment_id FROM payments WHERE order_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1").bind(orderId).first();
  if (!text(env.SQUARE_ACCESS_TOKEN) || !payment?.square_payment_id) return json({ ok: false, error: "This order does not have a Square payment available for an automatic refund." }, 409, request);
  const idempotencyKey = "refund-" + orderId;
  const base = text(env.SQUARE_ENVIRONMENT).toLowerCase() === "sandbox" ? SQUARE_SANDBOX_API : SQUARE_PRODUCTION_API;
  const response = await fetch(base + "/v2/refunds", {
    method: "POST",
    headers: { Authorization: "Bearer " + text(env.SQUARE_ACCESS_TOKEN), "Content-Type": "application/json", "Square-Version": text(env.SQUARE_API_VERSION) || "2025-10-16" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, payment_id: payment.square_payment_id, amount_money: { amount: Number(order.total_cents), currency: "USD" }, reason: "Paducah GO merchandise order refund" }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.refund?.id) return json({ ok: false, error: payload?.errors?.[0]?.detail || "Square refund could not be created." }, 502, request);
  await env.DB.prepare("INSERT INTO commerce_refunds (id, order_id, idempotency_key, square_refund_id, amount_cents, status, updated_at) VALUES (?, ?, ?, ?, ?, 'completed', datetime('now')) ON CONFLICT(idempotency_key) DO UPDATE SET square_refund_id = excluded.square_refund_id, status = 'completed', updated_at = datetime('now')").bind(crypto.randomUUID(), orderId, idempotencyKey, payload.refund.id, order.total_cents).run();
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status = 'refunded', fulfillment_status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(orderId),
    env.DB.prepare("UPDATE payments SET status = 'refunded' WHERE order_id = ? AND status = 'paid'").bind(orderId),
  ]);
  return json({ ok: true, refundId: payload.refund.id }, 200, request);
}

async function createCheckout(request, env) {
  const user = await getSessionUser(env, getSessionToken(request));
  if (!user) return json({ ok: false, error: "authentication_required", loginRequired: true }, 401, request);
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId) || DEFAULT_PROGRAM_ID;
  const requested = Array.isArray(payload?.items) ? payload.items : [];
  if (!requested.length || requested.length > 20) return json({ ok: false, error: "Select at least one merchandise item." }, 400, request);
  const quantities = new Map();
  requested.forEach((item) => {
    const id = text(item?.variantId);
    const quantity = Math.min(20, Math.max(0, Math.floor(Number(item?.quantity || 0))));
    if (id && quantity) quantities.set(id, (quantities.get(id) || 0) + quantity);
  });
  if (!quantities.size) return json({ ok: false, error: "Select a valid merchandise quantity." }, 400, request);
  const variants = [];
  for (const [variantId, quantity] of quantities) {
    const row = await env.DB.prepare(
      "SELECT pv.id AS variant_id, pv.product_id, pv.name AS variant_name, pv.sku, pv.price_cents, pv.inventory_count, pv.reserved_count, pv.square_checkout_url, p.name AS product_name, p.program_id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = ? AND p.program_id = ? AND p.status = 'active' AND p.visible = 1 AND pv.status = 'active' LIMIT 1",
    ).bind(variantId, programId).first();
    if (!row) return json({ ok: false, error: "One of the selected items is no longer available." }, 409, request);
    const available = Number(row.inventory_count) < 0 ? null : Number(row.inventory_count) - Number(row.reserved_count || 0);
    if (available !== null && available < quantity) return json({ ok: false, error: row.product_name + " is no longer available in that quantity." }, 409, request);
    variants.push({ ...row, quantity });
  }
  const totalCents = variants.reduce((sum, item) => sum + Number(item.price_cents) * item.quantity, 0);
  const orderId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO orders (id, program_id, user_id, status, total_cents, customer_name, customer_email, fulfillment_status, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, 'unfulfilled', datetime('now'))",
  ).bind(orderId, programId, user.id, totalCents, user.displayName || null, user.email).run();
  for (const item of variants) {
    await env.DB.prepare(
      "INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, variant_name, sku, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), orderId, item.product_id, item.variant_id, item.product_name, item.variant_name, item.sku, item.quantity, item.price_cents).run();
    if (Number(item.inventory_count) >= 0) {
      const reserved = await env.DB.prepare("UPDATE product_variants SET reserved_count = reserved_count + ?, updated_at = datetime('now') WHERE id = ? AND inventory_count - reserved_count >= ?").bind(item.quantity, item.variant_id, item.quantity).run();
      if (!reserved?.meta?.changes) {
        await cancelPendingOrder(env, orderId);
        return json({ ok: false, error: "Inventory changed while preparing checkout. Please try again." }, 409, request);
      }
    }
  }
  let payment = null;
  try {
    payment = await createSquarePaymentLink(env, request, { orderId, programId, totalCents, variants });
  } catch (error) {
    await cancelPendingOrder(env, orderId);
    return json({ ok: false, error: error.message || "Square checkout is not configured." }, 503, request);
  }
  await env.DB.prepare("UPDATE orders SET checkout_url = ?, square_payment_link_id = ?, square_order_id = ?, updated_at = datetime('now') WHERE id = ?").bind(payment.url, payment.paymentLinkId || null, payment.squareOrderId || null, orderId).run();
  return json({ ok: true, orderId, checkoutUrl: payment.url }, 201, request);
}

async function createSquarePaymentLink(env, request, order) {
  const fallbackUrls = [...new Set(order.variants.map((item) => text(item.square_checkout_url)).filter(Boolean))];
  if (!text(env.SQUARE_ACCESS_TOKEN)) {
    if (order.variants.length === 1 && fallbackUrls.length === 1) return { url: fallbackUrls[0] };
    throw new Error("Square checkout is not configured for this merchandise.");
  }
  const base = text(env.SQUARE_ENVIRONMENT).toLowerCase() === "sandbox" ? SQUARE_SANDBOX_API : SQUARE_PRODUCTION_API;
  const body = {
    idempotency_key: order.orderId,
    order: {
      location_id: text(env.SQUARE_LOCATION_ID),
      reference_id: order.orderId,
      line_items: order.variants.map((item) => ({
        name: item.product_name + " — " + item.variant_name,
        quantity: String(item.quantity),
        base_price_money: { amount: Number(item.price_cents), currency: "USD" },
      })),
    },
    checkout_options: {
      redirect_url: new URL("/shop?checkout=success&order=" + encodeURIComponent(order.orderId), request.url).toString(),
    },
  };
  if (!body.order.location_id) throw new Error("Square location is not configured.");
  const response = await fetch(base + "/v2/online-checkout/payment-links", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + text(env.SQUARE_ACCESS_TOKEN),
      "Content-Type": "application/json",
      "Square-Version": text(env.SQUARE_API_VERSION) || "2025-10-16",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.payment_link?.url) throw new Error(payload?.errors?.[0]?.detail || "Square checkout could not be created.");
  return {
    url: payload.payment_link.url,
    paymentLinkId: payload.payment_link.id || null,
    squareOrderId: payload.related_resources?.orders?.[0]?.id || null,
  };
}

async function listUserOrders(request, env) {
  const user = await getSessionUser(env, getSessionToken(request));
  if (!user) return json({ ok: false, error: "authentication_required", loginRequired: true }, 401, request);
  const rows = await env.DB.prepare(
    "SELECT o.id, o.status, o.fulfillment_status, o.total_cents, o.created_at, o.updated_at, GROUP_CONCAT(oi.product_name || CASE WHEN oi.variant_name IS NULL THEN '' ELSE ' · ' || oi.variant_name END || ' ×' || oi.quantity, ', ') AS item_summary FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50",
  ).bind(user.id).all();
  return json({ ok: true, orders: rows.results || [] }, 200, request);
}

async function handleSquareWebhook(request, env) {
  const body = await request.text();
  const signature = request.headers.get("x-square-hmacsha256-signature") || "";
  const key = text(env.SQUARE_WEBHOOK_SIGNATURE_KEY);
  if (!key || !(await verifySquareSignature(body, signature, key, text(env.SQUARE_WEBHOOK_URL) || request.url))) return json({ ok: false, error: "Invalid webhook signature" }, 403, request);
  const payload = JSON.parse(body || "{}");
  const eventId = text(payload.event_id || payload.id);
  if (!eventId) return json({ ok: false, error: "Missing webhook event id" }, 400, request);
  const eventType = text(payload.type);
  const inserted = await env.DB.prepare(
    "INSERT INTO commerce_webhook_events (id, provider, external_event_id, event_type, payload_json, status) VALUES (?, 'square', ?, ?, ?, 'received') ON CONFLICT(external_event_id) DO NOTHING",
  ).bind(crypto.randomUUID(), eventId, eventType, body).run();
  if (!inserted?.meta?.changes) return json({ ok: true, duplicate: true }, 200, request);
  try {
    const payment = payload?.data?.object?.payment || payload?.data?.object?.payment_link || null;
    const orderId = text(payment?.order_id || payload?.data?.object?.order?.id || payload?.data?.object?.order_id);
    if (orderId) {
      const order = await env.DB.prepare("SELECT id, status FROM orders WHERE square_order_id = ? OR square_payment_link_id = ? LIMIT 1").bind(orderId, orderId).first();
      const completed = eventType === "payment.updated" && text(payment?.status).toUpperCase() === "COMPLETED";
      if (order && completed && order.status !== "paid") await markOrderPaid(env, order.id, payment);
    }
    await env.DB.prepare("UPDATE commerce_webhook_events SET status = 'processed', processed_at = datetime('now') WHERE external_event_id = ?").bind(eventId).run();
    return json({ ok: true }, 200, request);
  } catch (error) {
    await env.DB.prepare("UPDATE commerce_webhook_events SET status = 'failed' WHERE external_event_id = ?").bind(eventId).run();
    console.error("square-webhook-processing-failed", error);
    return json({ ok: false, error: "Webhook processing failed" }, 500, request);
  }
}

async function markOrderPaid(env, orderId, payment) {
  const order = await env.DB.prepare("SELECT id, status FROM orders WHERE id = ? LIMIT 1").bind(orderId).first();
  if (!order || order.status === "paid") return;
  await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status != 'paid'").bind(orderId).run();
  await env.DB.prepare("INSERT INTO payments (id, order_id, square_payment_id, amount_cents, status) VALUES (?, ?, ?, ?, 'paid') ON CONFLICT(square_payment_id) DO NOTHING").bind(crypto.randomUUID(), orderId, text(payment?.id) || null, Number(payment?.amount_money?.amount || 0)).run();
  const items = await env.DB.prepare("SELECT variant_id, quantity FROM order_items WHERE order_id = ? AND variant_id IS NOT NULL").bind(orderId).all();
  for (const item of items.results || []) {
    await env.DB.prepare("UPDATE product_variants SET inventory_count = CASE WHEN inventory_count < 0 THEN inventory_count ELSE inventory_count - ? END, reserved_count = CASE WHEN reserved_count < ? THEN 0 ELSE reserved_count - ? END, updated_at = datetime('now') WHERE id = ?").bind(item.quantity, item.quantity, item.quantity, item.variant_id).run();
  }
}

async function cancelPendingOrder(env, orderId) {
  await env.DB.prepare("UPDATE orders SET status = 'cancelled', fulfillment_status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(orderId).run();
  const items = await env.DB.prepare("SELECT variant_id, quantity FROM order_items WHERE order_id = ? AND variant_id IS NOT NULL").bind(orderId).all();
  for (const item of items.results || []) {
    await env.DB.prepare("UPDATE product_variants SET reserved_count = CASE WHEN reserved_count < ? THEN 0 ELSE reserved_count - ? END, updated_at = datetime('now') WHERE id = ?").bind(item.quantity, item.quantity, item.variant_id).run();
  }
}

async function auditCommerce(env, context, action, entityType, entityId, programId, metadata = {}) {
  try {
    await env.DB.prepare("INSERT INTO audit_log (id, actor_admin_user_id, action, entity_type, entity_id, program_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))").bind(crypto.randomUUID(), context?.user?.id || null, action, entityType, entityId, programId, JSON.stringify(metadata)).run();
  } catch (error) {
    console.warn("commerce-audit-write-failed", error);
  }
}

async function verifySquareSignature(body, signature, key, notificationUrl) {
  if (!signature) return false;
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(notificationUrl + body));
  const expected = new Uint8Array(digest);
  let actual;
  try { actual = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)); } catch { return false; }
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ actual[index];
  return difference === 0;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function getSessionToken(request) {
  return getCookie(request, "__Host-lp_session") || getCookie(request, "session");
}

async function handleCommerceApi(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/api/admin/commerce/products" && request.method === "GET") return adminProducts(request, env, context);
  if (path === "/api/admin/commerce/products" && request.method === "POST") return createProduct(request, env, context);
  if (path === "/api/admin/commerce/upload" && request.method === "POST") return uploadProductImage(request, env, context);
  if (path.startsWith("/api/admin/commerce/products/") && path.endsWith("/variants") && request.method === "POST") return createVariant(request, env, context, decodeURIComponent(path.split("/")[5]));
  if (path.startsWith("/api/admin/commerce/products/") && request.method === "PATCH") return updateProduct(request, env, context, decodeURIComponent(path.split("/").pop()));
  if (path.startsWith("/api/admin/commerce/variants/") && request.method === "PATCH") return updateVariant(request, env, context, decodeURIComponent(path.split("/").pop()));
  if (path === "/api/admin/commerce/orders" && request.method === "GET") return adminOrders(request, env, context);
  if (path.startsWith("/api/admin/commerce/orders/") && path.endsWith("/refund") && request.method === "POST") return refundOrder(request, env, context, decodeURIComponent(path.split("/")[5]));
  if (path.startsWith("/api/admin/commerce/orders/") && request.method === "PATCH") return updateOrder(request, env, context, decodeURIComponent(path.split("/").pop()));
  return json({ ok: false, error: "Commerce endpoint not found" }, 404, request);
}

export {
  handleCommerceApi,
  uploadProductImage,
  publicProducts,
  createCheckout,
  listUserOrders,
  handleSquareWebhook,
};
