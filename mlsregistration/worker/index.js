import PostalMime from "postal-mime";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { AGREEMENT_TEMPLATES } from "./template-hashes.js";
import {
  PLAYER_AGREEMENT_FIELD_MAP,
  PPF_LIABILITY_FIELD_MAP,
  VOLUNTEER_AGREEMENT_FIELD_MAP,
} from "./pdf-field-maps.js";
import { buildPaymentConfig } from "./payment-config.js";
import { parseQuestReceiptEmail } from "./receipt-parser.mjs";
import {
  PADUCAH_GO_PROGRAM_ID,
  getRegistrationSettings,
  isPrivateAccessTokenValid,
  verifyResumeTokenActive,
  evaluateRegistrationAccess,
  registrationClosedPayload,
  getRegistrationOverview,
  updateRegistrationSettings,
  isAuthorizedForSettingsChange,
} from "./registration-status.js";
import {
  findPaymentRegistrationInD1,
  getRegistrationFromD1,
  recordSheetsSync,
  updateAgreementInD1,
  updatePaymentInD1,
  upsertRegistrationToD1,
} from "./d1-registration.js";
import {
  requestMagicLink,
  verifyMagicLink,
  getSessionUser,
  revokeSession,
  createHandoffCode,
  createHandoffCodeForUser,
  redeemHandoffCode,
} from "./auth-magic-link.js";
import { adminError, getAdminContext } from "./admin-auth.js";
import { handleAdminApi } from "./admin-api.js";
import {
  createCheckout,
  handleSquareWebhook,
  listUserOrders,
  publicProducts,
} from "./commerce-api.js";

const MAX_SIGNATURE_DATA_URL_BYTES = 1024 * 1024;
const MAX_TYPED_SIGNATURE_LEN = 120;
const RATE_LIMIT_PER_MINUTE = 30;
const DEFAULT_SIGNER_LINK_TTL_MS = 1000 * 60 * 30;
const EMAIL_SIGNER_LINK_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SIGNATURE_FONT_PATH = "/fonts/GreatVibes-Regular.ttf";
const PRIMARY_APP_ORIGIN =
  "https://mlsregistration.lifeprepacademyfoundation.com";
const LEGACY_REGISTRATION_HOST = "mlsregistration.lifeprepacademyfoundation.com";
const CANONICAL_REGISTRATION_ORIGIN =
  "https://paducahgo.lifeprepacademyfoundation.com";
const DEFAULT_ALLOWED_ORIGINS = [
  PRIMARY_APP_ORIGIN,
  "https://lifeprepacademyfoundation.com",
  "https://www.lifeprepacademyfoundation.com",
  "https://preview.lifeprepacademyfoundation.com",
  "https://lpaf-mls.hligon.workers.dev",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
];
function splitName(fullName) {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function appendPaymentParamVariants(url, keys, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return;
  keys.forEach((key) => {
    url.searchParams.set(key, normalized);
  });
}

function buildPlayerRegistrationPaymentUrl(options = {}) {
  const base = "https://quest.build/get-tickets/1598/71794/info?teamId=686";
  const firstName = String(options.firstName || "").trim();
  const lastName = String(options.lastName || "").trim();
  const email = String(options.email || "").trim();
  const zip = String(options.zip || "").trim();
  const submissionId = String(options.submissionId || "").trim();
  const amount = String(options.amount || "").trim();
  const currency = String(options.currency || "USD").trim();

  try {
    const url = new URL(base);
    appendPaymentParamVariants(
      url,
      ["firstName", "firstname", "first_name", "givenName", "given_name"],
      firstName,
    );
    appendPaymentParamVariants(
      url,
      ["lastName", "lastname", "last_name", "familyName", "family_name"],
      lastName,
    );
    appendPaymentParamVariants(
      url,
      ["fullName", "full_name", "name"],
      [firstName, lastName].filter(Boolean).join(" "),
    );
    appendPaymentParamVariants(
      url,
      [
        "email",
        "emailAddress",
        "email_address",
        "customerEmail",
        "customer_email",
      ],
      email,
    );
    appendPaymentParamVariants(
      url,
      ["zip", "zipCode", "zipcode", "postalCode", "postal_code", "postal"],
      zip,
    );
    appendPaymentParamVariants(
      url,
      [
        "registration_submission_id",
        "submission_id",
        "submissionId",
        "registrationId",
        "reference",
        "external_reference",
      ],
      submissionId,
    );
    appendPaymentParamVariants(
      url,
      ["payment_amount", "amount", "total"],
      amount,
    );
    appendPaymentParamVariants(
      url,
      ["payment_currency", "currency"],
      currency || "USD",
    );
    return url.toString();
  } catch (_error) {
    return base;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Keep the legacy registration hostname available for APIs, documents, and
    // agreement links, but move its public root to the canonical Paducah GO form.
    if (
      isLegacyRegistrationHost(url.hostname) &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const target = new URL("/register", CANONICAL_REGISTRATION_ORIGIN);
      target.search = url.search;
      return Response.redirect(target.toString(), 301);
    }

    if (isPgsHost(url.hostname)) {
      if (url.pathname === "/auth/handoff" && request.method === "GET") {
        return handleAuthHandoffGet(request, env);
      }
      if (
        (url.pathname === "/admin" || url.pathname === "/admin/" ||
          (url.pathname.startsWith("/admin/") && !/\.[a-z0-9]+$/i.test(url.pathname))) &&
        request.method === "GET"
      ) {
        return handleAdminAssetPage(request, env, "/admin/programs/pgs/console.html");
      }
      if (url.pathname === "/register" || url.pathname === "/register/") {
        // The public registration form must pass through the same server-side
        // D1 registration gate as the legacy registration root. Serving the
        // asset directly here would leave the form visually open after an
        // administrator closes registration.
        return handleRegistrationLandingPage(request, env, "/index.html");
      }
      // The Paducah GO hostname is a route-driven application shell. Static assets
      // continue through ASSETS; every application path resolves to the shell.
      if (!url.pathname.startsWith("/api/") && !/\.[a-z0-9]+$/i.test(url.pathname)) {
        return handleAdminAssetPage(request, env, "/admin/programs/pgs/index.html");
      }
    }

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return handleApiOptions(request, env);
    }

    if (url.pathname === "/api/public-config" && request.method === "GET") {
      return handlePublicConfig(env, request);
    }
    if (url.pathname === "/api/public/program-announcements" && request.method === "GET") {
      return handlePublicProgramAnnouncements(request, env);
    }
    if (url.pathname === "/api/public/program-schedule" && request.method === "GET") {
      return handlePublicProgramSchedule(request, env);
    }
    if (url.pathname === "/api/public/program-products" && request.method === "GET") {
      return publicProducts(request, env);
    }
    if (url.pathname === "/api/commerce/orders/checkout" && request.method === "POST") {
      return createCheckout(request, env);
    }
    if (url.pathname === "/api/commerce/orders" && request.method === "GET") {
      return listUserOrders(request, env);
    }
    if (url.pathname === "/api/webhooks/square" && request.method === "POST") {
      return handleSquareWebhook(request, env);
    }
    if (url.pathname.startsWith("/media/commerce/") && request.method === "GET") {
      return handleCommerceMedia(request, env);
    }
    if (url.pathname === "/api/payment-session" && request.method === "GET") {
      return handlePaymentSession(request, env);
    }
    if (url.pathname === "/api/public-config") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (url.pathname === "/api/site-submissions" && request.method === "POST") {
      return handleSiteSubmission(request, env);
    }
    if (url.pathname === "/api/site-submissions") {
      return json({ ok: false, error: "Method not allowed" }, 405, request, env);
    }

    if (url.pathname === "/api/sign-agreement" && request.method === "POST") {
      return handleSignAgreement(request, env, ctx);
    }
    if (url.pathname === "/api/sign-agreement") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (url.pathname === "/api/forms/upsert" && request.method === "POST") {
      return handleFormUpsert(request, env);
    }
    if (url.pathname === "/api/forms/upsert") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (url.pathname === "/api/forms/ppf-pdf" && request.method === "POST") {
      return handlePpfPdfRender(request, env);
    }
    if (url.pathname === "/api/forms/ppf-pdf") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (
      url.pathname === "/api/forms/final-confirmation" &&
      request.method === "POST"
    ) {
      return handleFinalConfirmationEmail(request, env);
    }
    if (url.pathname === "/api/forms/final-confirmation") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (url.pathname === "/api/resume/context" && request.method === "POST") {
      return handleResumeContext(request, env);
    }
    if (url.pathname === "/api/resume/context") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (url.pathname === "/api/resume/complete" && request.method === "POST") {
      return handleResumeComplete(request, env);
    }
    if (url.pathname === "/api/resume/complete") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (
      url.pathname === "/api/resume/withdraw/verify" &&
      request.method === "POST"
    ) {
      return handleResumeWithdrawVerify(request, env);
    }
    if (url.pathname === "/api/resume/withdraw/verify") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (
      url.pathname === "/api/resume/withdraw/confirm" &&
      request.method === "POST"
    ) {
      return handleResumeWithdrawConfirm(request, env);
    }
    if (url.pathname === "/api/resume/withdraw/confirm") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (
      url.pathname === "/api/payment-webhook/cornerstone" &&
      (request.method === "POST" || request.method === "GET")
    ) {
      return handlePaymentWebhook(request, env);
    }
    if (url.pathname === "/api/payment-webhook/cornerstone") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (
      url.pathname.startsWith("/api/signer/agreement/") &&
      request.method === "GET"
    ) {
      return handleSignerDownload(request, env);
    }
    if (url.pathname.startsWith("/api/signer/agreement/")) {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (
      url.pathname.startsWith("/api/admin/agreement/") &&
      request.method === "GET"
    ) {
      return handleAdminDownload(request, env);
    }
    if (url.pathname.startsWith("/api/admin/agreement/")) {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (
      url.pathname === "/api/admin/registration-status" &&
      request.method === "GET"
    ) {
      return handleAdminRegistrationStatusGet(request, env);
    }
    if (
      url.pathname === "/api/admin/registration-status" &&
      request.method === "PUT"
    ) {
      return handleAdminRegistrationStatusUpdate(request, env);
    }
    if (url.pathname === "/api/admin/registration-status") {
      return json(
        { ok: false, error: "Method not allowed" },
        405,
        request,
        env,
      );
    }

    if (url.pathname === "/api/auth/request-link" && request.method === "POST") {
      return handleAuthRequestLink(request, env);
    }
    if (url.pathname === "/api/auth/verify" && request.method === "GET") {
      return handleAuthVerify(request, env);
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      return handleAuthSession(request, env);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return handleAuthLogout(request, env);
    }
    if (url.pathname === "/api/auth/access-exchange" && request.method === "POST") {
      return handleAuthAccessExchange(request, env);
    }
    if (url.pathname === "/api/auth/handoff/create" && request.method === "POST") {
      return handleAuthHandoffCreate(request, env);
    }
    if (url.pathname === "/api/auth/handoff/redeem" && request.method === "POST") {
      return handleAuthHandoffRedeem(request, env);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdminApi(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Not found" }, 404, request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return handleRegistrationLandingPage(request, env);
    }

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return handleAdminAssetPage(request, env, "/admin/index.html");
    }
    if (url.pathname === "/admin/dashboard" || url.pathname === "/admin/dashboard/") {
      return handleAdminAssetPage(request, env, "/admin/index.html");
    }
    if (url.pathname === "/admin/programs" || url.pathname === "/admin/programs/") {
      return handleAdminAssetPage(request, env, "/admin/programs/index.html");
    }
    if (
      url.pathname === "/admin/programs/paducah-go-soccer-league" ||
      url.pathname === "/admin/programs/paducah-go-soccer-league/"
    ) {
      return handleAdminAssetPage(request, env, "/admin/programs/pgs/index.html");
    }

    if (isAppHost(url.hostname)) {
      if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
        const access = await getAdminContext(request, env);
        if (!access.ok && !request.headers.get("CF-Access-Jwt-Assertion") && !url.searchParams.has("auth_attempt")) {
          const loginUrl = new URL("/cdn-cgi/access/login", url.origin);
          const returnUrl = new URL(url.toString());
          returnUrl.searchParams.set("auth_reason", "login");
          returnUrl.searchParams.set("auth_attempt", "1");
          loginUrl.searchParams.set("redirect_url", returnUrl.toString());
          return Response.redirect(loginUrl.toString(), 302);
        }
        return handleAdminAssetPage(request, env, "/admin/index.html");
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return handleAdminAssetPage(request, env, "/admin/index.html");
      }
      if (url.pathname === "/programs" || url.pathname === "/programs/") {
        return handleAdminAssetPage(request, env, "/admin/programs/index.html");
      }
    }

    return env.ASSETS.fetch(request);
  },
  async email(message, env, ctx) {
    await handlePaymentReceiptEmail(message, env, ctx);
  },
};

function isPgsHost(hostname) {
  return String(hostname || "").toLowerCase() === "paducahgo.lifeprepacademyfoundation.com";
}

function isLegacyRegistrationHost(hostname) {
  return String(hostname || "").toLowerCase() === LEGACY_REGISTRATION_HOST;
}

function isAppHost(hostname) {
  return String(hostname || "").toLowerCase() === "app.lifeprepacademyfoundation.com";
}

async function handleCommerceMedia(request, env) {
  if (!env?.SITE_STATIC) return new Response("Not found", { status: 404 });
  const key = new URL(request.url).pathname.replace(/^\/media\//, "");
  const object = await env.SITE_STATIC.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function handleAuthRequestLink(request, env) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const result = await requestMagicLink(env, {
    email: body?.email,
    requestOrigin: url.origin,
    returnTo: body?.returnTo,
  });
  return json(result, 200, request, env);
}

async function handleAuthVerify(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const result = await verifyMagicLink(env, { token, host: url.hostname });
  if (!result.ok) return json(result, 401, request, env);

  const returnTo = result.returnTo || "/dashboard";
  const headers = new Headers({ Location: returnTo, "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    buildSessionCookie(result.sessionToken, result.expiresAt),
  );
  return new Response(null, { status: 302, headers });
}

async function handleAuthHandoffCreate(request, env) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const sessionToken = getCookie(request, "session");
  const code = await createHandoffCode(env, {
    sessionToken,
    sourceHost: url.hostname,
    targetHost: body?.targetHost,
  });
  if (!code) return json({ ok: false, error: "not_authenticated" }, 401, request, env);
  return json({ ok: true, code }, 200, request, env);
}


async function handleAuthSession(request, env) {
  const sessionToken = getSessionToken(request);
  const sessionUser = await getSessionUser(env, sessionToken);
  if (!sessionUser) return json({ ok: false, error: sessionToken ? "session_expired" : "authentication_required" }, 401, request, env);
  const memberships = await env.DB.prepare(
    "SELECT program_id AS programId, role, status FROM program_memberships WHERE user_id = ? AND status = 'active' ORDER BY program_id, role",
  ).bind(sessionUser.id).all();
  return json({
    ok: true,
    user: sessionUser,
    roles: (memberships.results || []).map((item) => item.role),
    memberships: memberships.results || [],
  }, 200, request, env);
}

async function handleAuthLogout(request, env) {
  await revokeSession(env, getSessionToken(request));
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearSessionCookie());
  headers.append("Set-Cookie", "session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleAuthAccessExchange(request, env) {
  const context = await getAdminContext(request, env);
  if (!context.ok) return adminError(context);
  const payload = await request.json().catch(() => ({}));
  const targetHost = String(payload?.targetHost || "").trim().toLowerCase();
  const allowedTargets = new Set([
    "app.lifeprepacademyfoundation.com",
    "paducahgo.lifeprepacademyfoundation.com",
    "pnffl.lifeprepacademyfoundation.com",
    "pnffc.lifeprepacademyfoundation.com",
  ]);
  if (!allowedTargets.has(targetHost)) return json({ ok: false, error: "invalid_target_host" }, 400, request, env);

  const email = String(context.identity.email || "").trim().toLowerCase();
  let user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1").bind(email).first();
  if (!user) {
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING",
    ).bind(userId, email, context.identity.name || email).run();
    user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1").bind(email).first();
  }
  if (!user) return json({ ok: false, error: "application_user_unavailable" }, 503, request, env);
  await env.DB.prepare(
    "INSERT INTO program_memberships (id, user_id, program_id, role) VALUES (?, ?, 'paducah-go-soccer-league', 'staff') ON CONFLICT(user_id, program_id, role) DO NOTHING",
  ).bind(crypto.randomUUID(), user.id).run();

  const code = await createHandoffCodeForUser(env, {
    userId: user.id,
    sourceHost: new URL(request.url).hostname,
    targetHost,
  });
  if (!code) return json({ ok: false, error: "handoff_unavailable" }, 503, request, env);
  return json({ ok: true, code }, 200, request, env);
}

async function handleAuthHandoffGet(request, env) {
  const url = new URL(request.url);
  const result = await redeemHandoffCode(env, { code: url.searchParams.get("code"), targetHost: url.hostname });
  if (!result.ok) return new Response("This sign-in handoff is invalid or expired.", { status: 401 });
  const returnTo = String(url.searchParams.get("returnTo") || "/dashboard");
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") && !returnTo.startsWith("/api/") && !returnTo.startsWith("/cdn-cgi/") && !returnTo.includes("\\") ? returnTo : "/dashboard";
  const headers = new Headers({ Location: safeReturnTo, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", buildSessionCookie(result.sessionToken, result.expiresAt));
  return new Response(null, { status: 302, headers });
}

async function handleAuthHandoffRedeem(request, env) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const result = await redeemHandoffCode(env, { code: body?.code, targetHost: url.hostname });
  if (!result.ok) return json(result, 401, request, env);

  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    buildSessionCookie(result.sessionToken, result.expiresAt),
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function getSessionToken(request) {
  return getCookie(request, "__Host-lp_session") || getCookie(request, "session");
}

function buildSessionCookie(token, expiresAt) {
  return `__Host-lp_session=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
}

function clearSessionCookie() {
  return "__Host-lp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
}

function handleAdminAssetPage(request, env, assetPath, role = "") {
  const url = new URL(request.url);
  url.pathname = assetPath;
  if (role) url.searchParams.set("role", role);
  const assetRequest = new Request(url.toString(), request);
  return env.ASSETS.fetch(assetRequest).then((response) => {
    // Admin shells must pick up new asset references immediately after a
    // deployment. Static CSS/JS remains cache-busted by its query version.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store, max-age=0, must-revalidate");
    headers.set("CDN-Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}

async function handleResumeContext(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }

  const payload = await request.json().catch(() => null);
  const resumeToken = String(payload?.resumeToken || "").trim();
  if (!resumeToken)
    return json({ ok: false, error: "Missing resumeToken" }, 400, request, env);

  const registrationGate = await evaluateResumeGate(env, payload);
  if (!registrationGate.allowed) {
    return json(
      registrationClosedPayload(registrationGate.settings),
      403,
      request,
      env,
    );
  }

  return proxyContinuationRequest(request, env, {
    action: "resume_context",
    resumeToken,
  });
}

async function handleResumeComplete(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }

  const payload = await request.json().catch(() => null);
  const resumeToken = String(payload?.resumeToken || "").trim();
  const registrationSubmissionId = String(
    payload?.registrationSubmissionId || "",
  ).trim();
  const playerCount = Math.max(
    0,
    Math.min(4, Number(payload?.playerCount || 0)),
  );
  if (!resumeToken || !registrationSubmissionId) {
    return json(
      { ok: false, error: "Missing continuation completion data" },
      400,
      request,
      env,
    );
  }

  const registrationGate = await evaluateResumeGate(env, payload);
  if (!registrationGate.allowed) {
    return json(
      registrationClosedPayload(registrationGate.settings),
      403,
      request,
      env,
    );
  }

  return proxyContinuationRequest(request, env, {
    action: "resume_complete",
    resumeToken,
    registrationSubmissionId,
    playerCount,
  });
}

// resume/context and resume/complete validate the resume token themselves (by proxying to the
// continuation service), so the gate here only needs to check the allow-resume/private-access
// flags - it must not re-verify the token itself or every resume call doubles its Apps Script hits.
async function evaluateResumeGate(env, payload) {
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);
  if (settings.registrationStatus === "open") {
    return { allowed: true, settings };
  }
  if (await isPrivateAccessTokenValid(settings, payload?.privateAccessToken)) {
    return { allowed: true, settings };
  }
  return { allowed: settings.allowDraftResume, settings };
}

async function handleResumeWithdrawVerify(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rate = await doFetch(env, "/rate-limit", {
    method: "POST",
    body: JSON.stringify({ key: `withdraw:${ip}`, limit: 5 }),
  });
  if (!rate.ok) {
    return json(
      {
        ok: false,
        error:
          "Too many verification attempts. Please wait a minute and try again.",
      },
      429,
      request,
      env,
    );
  }

  const payload = await request.json().catch(() => null);
  const resumeToken = String(payload?.resumeToken || "").trim();
  const subjectType = String(payload?.subjectType || "").trim();
  const playerIndex = payload?.playerIndex;
  const dob = String(payload?.dob || "").trim();
  if (!resumeToken || !subjectType || !dob) {
    return json(
      { ok: false, error: "Missing withdrawal verification data" },
      400,
      request,
      env,
    );
  }

  return proxyContinuationRequest(request, env, {
    action: "resume_withdraw_verify",
    resumeToken,
    subjectType,
    playerIndex,
    dob,
  });
}

async function handleResumeWithdrawConfirm(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }

  const payload = await request.json().catch(() => null);
  const resumeToken = String(payload?.resumeToken || "").trim();
  const verificationToken = String(payload?.verificationToken || "").trim();
  if (!resumeToken || !verificationToken) {
    return json(
      { ok: false, error: "Missing withdrawal confirmation data" },
      400,
      request,
      env,
    );
  }

  return proxyContinuationRequest(request, env, {
    action: "resume_withdraw_confirm",
    resumeToken,
    verificationToken,
  });
}

async function proxyContinuationRequest(request, env, payload) {
  const webAppUrl = String(env.CONTINUATION_WEB_APP_URL || "").trim();
  const sharedSecret = String(
    env.CONTINUATION_WORKER_SHARED_SECRET || "",
  ).trim();
  if (!/^https:\/\/script\.google\.com\//i.test(webAppUrl) || !sharedSecret) {
    return json(
      {
        ok: false,
        error: "Registration continuation service is not configured",
      },
      503,
      request,
      env,
    );
  }

  try {
    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sharedSecret }),
      redirect: "follow",
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json(
        { ok: false, error: "Continuation service returned unreadable data" },
        502,
        request,
        env,
      );
    }

    if (!parsed?.ok) {
      return json(
        {
          ok: false,
          error: parsed?.error || "Continuation service request failed",
        },
        502,
        request,
        env,
      );
    }
    return json(parsed, 200, request, env);
  } catch (error) {
    return json(
      { ok: false, error: String(error?.message || error) },
      502,
      request,
      env,
    );
  }
}

async function handleSiteSubmission(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (origin && !isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }
  if (!env?.DB) return json({ ok: false, error: "D1 binding is not configured" }, 503, request, env);

  const contentType = request.headers.get("Content-Type") || "";
  let values = {};
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) return json({ ok: false, error: "Invalid form data" }, 400, request, env);
    for (const [key, value] of form.entries()) values[key] = String(value);
  } else {
    values = await request.json().catch(() => null);
  }
  if (!values || typeof values !== "object") {
    return json({ ok: false, error: "Invalid submission" }, 400, request, env);
  }

  if (String(values.hp_field || "").trim()) {
    return json({ status: "success", message: "Processed." }, 200, request, env);
  }

  const name = String(values.name || "").trim().slice(0, 160);
  const email = String(values.email || "").trim().toLowerCase().slice(0, 320);
  const subject = String(values.subject || "Website Contact").trim().slice(0, 240);
  const message = String(values.message || "").trim().slice(0, 10000);
  const formType = String(values.form_type || "contact").trim().toLowerCase().slice(0, 80) || "contact";
  const pageUrl = String(values.page || "").trim().slice(0, 1000);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 10) {
    return json({ status: "error", message: "Please provide a valid name, email, subject, and message." }, 422, request, env);
  }

  const turnstileSecret = String(env.TURNSTILE_SECRET || "").trim();
  const turnstileToken = String(values.cf_turnstile_response || "").trim();
  if (turnstileSecret) {
    if (!turnstileToken) return json({ status: "error", message: "CAPTCHA required." }, 400, request, env);
    const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: turnstileSecret, response: turnstileToken, remoteip: request.headers.get("CF-Connecting-IP") || "" }),
    }).then((response) => response.json()).catch(() => null);
    if (!verification?.success) return json({ status: "error", message: "CAPTCHA verification failed." }, 403, request, env);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO site_submissions
      (id, form_type, name, email, subject, message, page_url, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'website', 'new', datetime('now'), datetime('now'))`,
  ).bind(id, formType, name, email, subject, message, pageUrl || null).run();

  return json({ status: "success", ok: true, id, message: "Thank you! Your message has been received." }, 201, request, env);
}

async function handlePublicConfig(env, request) {
  const googleMapsApiKey = String(env.GOOGLE_MAPS_API_KEY || "").trim();
  const corsHeaders = buildCorsHeaders(request, env);
  const paymentConfig = buildPaymentConfig({
    feePerPlayer: 75,
    playerCount: 1,
    currency: "USD",
  });
  const registrationSettings = await getRegistrationSettings(
    env,
    PADUCAH_GO_PROGRAM_ID,
  );
  const registration = {
    status: registrationSettings.registrationStatus,
    message:
      registrationSettings.registrationStatus === "open"
        ? registrationSettings.publicMessage || null
        : registrationSettings.closedMessage,
    allowDraftResume: registrationSettings.allowDraftResume,
    reopensAt: registrationSettings.reopensAt,
  };

  return new Response(
    JSON.stringify({ googleMapsApiKey, payment: paymentConfig, registration }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        ...corsHeaders,
      },
    },
  );
}

function canViewRegistrationProgram(context, programId) {
  return Boolean(
    context?.isSuperAdmin ||
      (context?.programs || []).some((program) => program.id === programId),
  );
}

function canManageRegistrationProgram(context, programId) {
  if (context?.isSuperAdmin) return true;
  return (context?.roles || []).some(
    (role) =>
      role.program_id === programId &&
      ["program_administrator", "registration_manager"].includes(role.id),
  );
}

async function getRegistrationAdminContext(request, env, programId, requireManage = false) {
  if (isAuthorizedForSettingsChange(request, env)) {
    return { ok: true, identity: { email: "settings-token" }, via: "settings-token" };
  }
  const context = await getAdminContext(request, env);
  if (!context.ok) return context;
  const allowed = requireManage
    ? canManageRegistrationProgram(context, programId)
    : canViewRegistrationProgram(context, programId);
  if (!allowed) return { ok: false, status: 403, error: "Registration access denied" };
  return context;
}

async function handleAdminRegistrationStatusGet(request, env) {
  const url = new URL(request.url);
  const programId = url.searchParams.get("programId") || PADUCAH_GO_PROGRAM_ID;
  const context = await getRegistrationAdminContext(request, env, programId);
  if (!context.ok) return adminError(context);
  const overview = await getRegistrationOverview(env, programId);
  return json(
    {
      ok: true,
      programId,
      settings: overview.settings,
      activeDrafts: overview.activeDrafts,
      submittedCount: overview.submittedCount,
    },
    200,
    request,
    env,
  );
}

async function handleAdminRegistrationStatusUpdate(request, env) {
  const url = new URL(request.url);
  const programId = url.searchParams.get("programId") || PADUCAH_GO_PROGRAM_ID;
  const context = await getRegistrationAdminContext(request, env, programId, true);
  if (!context.ok) return adminError(context);
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return json({ ok: false, error: "Invalid JSON" }, 400, request, env);
  }
  if (payload.confirm !== true) {
    return json(
      { ok: false, error: "Missing explicit confirm flag" },
      400,
      request,
      env,
    );
  }
  const actorLabel =
    String(payload.actorLabel || "").trim() ||
    context.identity?.email ||
    "unknown admin";
  try {
    const settings = await updateRegistrationSettings(
      env,
      programId,
      payload,
      actorLabel,
    );
    return json({ ok: true, programId, settings }, 200, request, env);
  } catch (error) {
    return json(
      { ok: false, error: String(error?.message || error) },
      500,
      request,
      env,
    );
  }
}

async function handlePublicProgramAnnouncements(request, env) {
  const url = new URL(request.url);
  const programId = url.searchParams.get("programId") || PADUCAH_GO_PROGRAM_ID;
  if (!env?.DB) return json({ ok: true, announcements: [] }, 200, request, env);
  try {
    const result = await env.DB.prepare(
      "SELECT id, program_id, title, body, priority, show_in_hero, published_at, created_at FROM announcements WHERE program_id = ? AND audience_type = 'program' AND status = 'published' AND (starts_at IS NULL OR starts_at <= datetime('now')) AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY priority DESC, COALESCE(published_at, created_at) DESC LIMIT 10",
    ).bind(programId).all();
    return json({ ok: true, announcements: result.results || [] }, 200, request, env);
  } catch (error) {
    console.error("public-program-announcements-read-failed", error);
    return json({ ok: true, announcements: [] }, 200, request, env);
  }
}

async function handlePublicProgramSchedule(request, env) {
  const url = new URL(request.url);
  const programId = url.searchParams.get("programId") || PADUCAH_GO_PROGRAM_ID;
  if (!env?.DB) return json({ ok: true, version: null, games: [] }, 200, request, env);
  try {
    const version = await env.DB.prepare(
      "SELECT id, season_id, games_per_team, published_at FROM schedule_versions WHERE program_id = ? AND status = 'published' ORDER BY published_at DESC, created_at DESC LIMIT 1",
    ).bind(programId).first();
    if (!version) return json({ ok: true, version: null, games: [] }, 200, request, env);
    const games = await env.DB.prepare(
      "SELECT sg.id, sg.round_number, sg.starts_at, sg.field_name, sg.status, home.name AS home_team_name, away.name AS away_team_name, gr.home_score, gr.away_score FROM schedule_games sg JOIN roster_teams home ON home.id = sg.home_team_id JOIN roster_teams away ON away.id = sg.away_team_id LEFT JOIN game_results gr ON gr.game_id = sg.id WHERE sg.version_id = ? ORDER BY sg.round_number, sg.starts_at, home.name",
    ).bind(version.id).all();
    return json({ ok: true, version, games: games.results || [] }, 200, request, env);
  } catch (error) {
    console.error("public-program-schedule-read-failed", error);
    return json({ ok: true, version: null, games: [] }, 200, request, env);
  }
}

// Server-renders the registration landing page's open/closed shell (via HTMLRewriter) so the
// correct state is present in the HTML itself, not applied afterward by client JS.
async function handleRegistrationLandingPage(request, env, assetPath = "") {
  const assetUrl = new URL(request.url);
  if (assetPath) assetUrl.pathname = assetPath;
  const assetRequest = new Request(assetUrl.toString(), request);
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  const contentType = assetResponse.headers.get("Content-Type") || "";
  if (!assetResponse.ok || !contentType.includes("text/html")) {
    return assetResponse;
  }

  const url = new URL(request.url);
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);

  let effectivelyOpen = settings.registrationStatus === "open";
  if (!effectivelyOpen) {
    const privateOk = await isPrivateAccessTokenValid(
      settings,
      url.searchParams.get("pk"),
    );
    if (privateOk) {
      effectivelyOpen = true;
    } else if (settings.allowDraftResume) {
      const resumeToken = url.searchParams.get("resume") || "";
      if (resumeToken && (await verifyResumeTokenActive(env, resumeToken))) {
        effectivelyOpen = true;
      }
    }
  }

  const flowParam = (url.searchParams.get("flow") || "").toLowerCase();
  const isPrivilegedFlow = flowParam === "volunteer" || flowParam === "coach";
  const showClosedNotice = !effectivelyOpen && !isPrivilegedFlow;

  const rewriter = new HTMLRewriter()
    .on("html", {
      element(el) {
        if (showClosedNotice) el.setAttribute("class", "registration-is-closed");
        el.setAttribute(
          "data-registration-status",
          showClosedNotice ? "closed" : "open",
        );
        if (settings.reopensAt) {
          el.setAttribute("data-registration-reopens-at", settings.reopensAt);
        }
      },
    })
    .on("#registration-closed-message", {
      element(el) {
        el.setInnerContent(settings.closedMessage);
      },
    });

  const rewritten = rewriter.transform(assetResponse);
  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers,
  });
}

async function handleAdminPage(request, env) {
  const url = new URL(request.url);
  // Extensionless path matches the assets binding's canonical URL, avoiding its .html redirect.
  url.pathname = "/admin-registration-status";
  return env.ASSETS.fetch(new Request(url.toString(), request));
}

function handlePaymentSession(request, env) {
  const corsHeaders = buildCorsHeaders(request, env);
  const playerCount = Number(
    new URL(request.url).searchParams.get("playerCount") || 1,
  );
  const paymentConfig = buildPaymentConfig({
    feePerPlayer: 75,
    playerCount,
    currency: "USD",
  });

  return new Response(JSON.stringify({ ok: true, payment: paymentConfig }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...corsHeaders,
    },
  });
}

export class SigningTransactionsDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/rate-limit" && request.method === "POST") {
      const { key, limit = RATE_LIMIT_PER_MINUTE } = await request.json();
      const minuteKey = `${key}:${Math.floor(Date.now() / 60000)}`;
      const current = (await this.state.storage.get(minuteKey)) || 0;
      if (current >= limit) {
        return json({ ok: false, allowed: false }, 429);
      }
      await this.state.storage.put(minuteKey, current + 1, {
        expirationTtl: 180,
      });
      return json({ ok: true, allowed: true });
    }

    if (url.pathname === "/transaction" && request.method === "GET") {
      const txId = url.searchParams.get("txId");
      if (!txId) return json({ ok: false, error: "Missing txId" }, 400);
      const row = await this.state.storage.get(`tx:${txId}`);
      return json({ ok: true, value: row || null });
    }

    if (url.pathname === "/transaction" && request.method === "POST") {
      const body = await request.json();
      const { txId, value, ifAbsent = false } = body;
      if (!txId) return json({ ok: false, error: "Missing txId" }, 400);
      const key = `tx:${txId}`;
      if (ifAbsent) {
        const existing = await this.state.storage.get(key);
        if (existing)
          return json({ ok: true, created: false, value: existing });
      }
      await this.state.storage.put(key, value);
      return json({ ok: true, created: true, value });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
}

async function handleSignAgreement(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rate = await doFetch(env, "/rate-limit", {
    method: "POST",
    body: JSON.stringify({ key: `ip:${ip}`, limit: RATE_LIMIT_PER_MINUTE }),
  });
  if (!rate.ok) {
    return json({ ok: false, error: "Too many requests" }, 429, request, env);
  }

  const payload = await request.json().catch(() => null);
  if (!payload)
    return json({ ok: false, error: "Invalid JSON" }, 400, request, env);

  const validation = validateSigningPayload(payload, env);
  if (!validation.ok) return json(validation, 400, request, env);

  const { agreementType, formType, submissionId } = payload;
  const template = AGREEMENT_TEMPLATES[agreementType];
  if (!template)
    return json(
      { ok: false, error: "Unknown agreement type" },
      400,
      request,
      env,
    );

  const txId = payload.transactionId || crypto.randomUUID();
  const existing = await doFetch(
    env,
    `/transaction?txId=${encodeURIComponent(txId)}`,
  );
  if (existing.value?.status === "viewed") {
    const signerUrl = await buildSignerUrl(request.url, txId, env);
    const emailDownloadUrl = await buildSignerUrl(
      request.url,
      txId,
      env,
      EMAIL_SIGNER_LINK_TTL_MS,
    );
    return json(
      {
        ok: true,
        transactionId: txId,
        signerDownloadUrl: signerUrl,
        emailDownloadUrl,
        alreadyExisted: true,
      },
      200,
      request,
      env,
    );
  }

  await doFetch(env, "/transaction", {
    method: "POST",
    body: JSON.stringify({
      txId,
      ifAbsent: true,
      value: {
        status: "processing",
        createdAt: new Date().toISOString(),
        agreementType,
        submissionId,
        formType,
      },
    }),
  });

  try {
    const templateBytes = await readTemplateBytes(env, template.key);
    if (!templateBytes) {
      await markTransactionFailed(env, txId, "Template not found");
      await updateAgreementInSheets(env, {
        formType,
        submissionId,
        agreementType,
        signerName: payload.signer.printedName,
        signedAt: payload.audit.viewedAtUtc,
        transactionId: txId,
        fileId: "",
        pdfUrl: "",
        sha256: "",
        status: "Generation Failed",
        agreementVersion: template.version,
      });
      return json(
        { ok: false, error: "Template not found" },
        500,
        request,
        env,
      );
    }

    const templateHash = await sha256Hex(templateBytes);
    if (templateHash !== template.hash) {
      await markTransactionFailed(env, txId, "Template hash mismatch");
      await updateAgreementInSheets(env, {
        formType,
        submissionId,
        agreementType,
        signerName: payload.signer.printedName,
        signedAt: payload.audit.viewedAtUtc,
        transactionId: txId,
        fileId: "",
        pdfUrl: "",
        sha256: "",
        status: "Generation Failed",
        agreementVersion: template.version,
      });
      return json(
        { ok: false, error: "Template hash mismatch" },
        409,
        request,
        env,
      );
    }

    const completedPdf = await generateSignedPdf({
      payload,
      templateBytes,
      env,
      txId,
      templateHash,
    });
    const completedHash = await sha256Hex(completedPdf);

    const objectKey = buildObjectKey(agreementType, submissionId, txId);
    await env.SIGNED_AGREEMENTS.put(objectKey, completedPdf, {
      customMetadata: {
        transaction_id: txId,
        agreement_type: agreementType,
        submission_id: submissionId,
        completed_sha256: completedHash,
        template_sha256: templateHash,
      },
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `attachment; filename="${agreementType}-agreement-${txId}.pdf"`,
      },
    });

    const adminUrl = buildAdminUrl(request.url, txId);
    const signerUrl = await buildSignerUrl(request.url, txId, env);
    const emailDownloadUrl = await buildSignerUrl(
      request.url,
      txId,
      env,
      EMAIL_SIGNER_LINK_TTL_MS,
    );

    await doFetch(env, "/transaction", {
      method: "POST",
      body: JSON.stringify({
        txId,
        value: {
          status: "generated",
          agreementType,
          formType,
          submissionId,
          objectKey,
          templateHash,
          completedHash,
          transactionId: txId,
          signerName: payload.signer.printedName,
          viewedAt: payload.audit.viewedAtUtc,
        },
      }),
    });

    const sheetUpdate = await updateAgreementInSheets(env, {
      formType,
      submissionId,
      agreementType,
      signerName: payload.signer.printedName,
      signedAt: payload.audit.viewedAtUtc,
      transactionId: txId,
      fileId: objectKey,
      pdfUrl: emailDownloadUrl,
      sha256: completedHash,
      status: "Viewed",
      agreementVersion: template.version,
    });
    if (!sheetUpdate.ok) {
      console.warn("agreement-sheet-update-failed", {
        txId,
        submissionId,
        formType,
        error: sheetUpdate.error,
      });
      await markTransactionFailed(
        env,
        txId,
        String(sheetUpdate.error || "Sheet update failed"),
      );
      return json(
        {
          ok: false,
          error: `Agreement sheet update failed: ${String(sheetUpdate.error || "Sheet update failed")}`,
          sheetUpdate,
        },
        502,
        request,
        env,
      );
    }

    await doFetch(env, "/transaction", {
      method: "POST",
      body: JSON.stringify({
        txId,
        value: {
          status: "viewed",
          agreementType,
          formType,
          submissionId,
          objectKey,
          templateHash,
          completedHash,
          transactionId: txId,
          signerName: payload.signer.printedName,
          viewedAt: payload.audit.viewedAtUtc,
        },
      }),
    });

    return json(
      {
        ok: true,
        transactionId: txId,
        agreementType,
        viewedAt: payload.audit.viewedAtUtc,
        signerDownloadUrl: signerUrl,
        emailDownloadUrl,
        sheetUpdate: {
          ok: Boolean(sheetUpdate.ok),
          error: sheetUpdate.ok
            ? ""
            : String(sheetUpdate.error || "Sheet update failed"),
        },
      },
      200,
      request,
      env,
    );
  } catch (error) {
    console.error("sign-agreement-failed", {
      txId,
      agreementType,
      formType,
      submissionId,
      error: String(error?.message || error),
      stack: error?.stack || null,
    });
    await markTransactionFailed(env, txId, String(error?.message || error));
    await updateAgreementInSheets(env, {
      formType,
      submissionId,
      agreementType,
      signerName: payload.signer.printedName,
      viewedAt: payload.audit.viewedAtUtc,
      transactionId: txId,
      fileId: "",
      pdfUrl: "",
      sha256: "",
      status: "Generation Failed",
      agreementVersion: template.version,
    });
    return json(
      { ok: false, error: "Agreement generation failed" },
      500,
      request,
      env,
    );
  }
}

async function handleFormUpsert(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return json({ ok: false, error: "Invalid JSON" }, 400, request, env);
  }

  const formType = String(payload.formType || "").trim();
  const values =
    payload.values && typeof payload.values === "object"
      ? payload.values
      : null;
  const deferConfirmationEmail =
    String(values?.defer_confirmation_email || "")
      .trim()
      .toLowerCase() === "yes";
  if (!formType || !values) {
    return json(
      { ok: false, error: "Missing formType or values" },
      400,
      request,
      env,
    );
  }

  // Only player (mls_registration) drafts/submissions are gated by the closed-registration
  // control; volunteer/coaching applications remain unaffected, matching current behavior.
  if (formType === "mls_registration") {
    const registrationSettings = await getRegistrationSettings(
      env,
      PADUCAH_GO_PROGRAM_ID,
    );
    const access = await evaluateRegistrationAccess(env, {
      settings: registrationSettings,
      resumeToken: payload.resumeToken,
      privateAccessToken: payload.privateAccessToken,
      requireResumeReverification: true,
    });
    if (!access.allowed) {
      return json(
        registrationClosedPayload(registrationSettings),
        403,
        request,
        env,
      );
    }
  }

  let d1Result;
  try {
    d1Result = await upsertRegistrationToD1(env, { formType, values });
  } catch (error) {
    return json(
      { ok: false, error: "Registration could not be saved to the primary database" },
      503,
      request,
      env,
    );
  }

  // Google Apps Script is now a backup Sheet mirror only. D1 is authoritative;
  // a mirror outage must not make the successful D1 registration fail.
  const params = new URLSearchParams();
  params.append("form_type", formType);
  Object.entries(values).forEach(([key, value]) => {
    if (!key) return;
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length) params.append(key, value.join(", "));
      return;
    }
    const text = String(value).trim();
    if (text) params.append(key, text);
  });

  try {
    let mirror = { ok: false, error: "Apps Script mirror is not configured" };
    if (env.APPS_SCRIPT_URL && hasAppsScriptUpdateToken(env)) {
      const response = await postAppsScriptFormWithUpdateTokenFallback(env, params);
      mirror = response.parsed?.ok
        ? { ok: true }
        : { ok: false, error: response.parsed?.error || "Sheet mirror failed" };
    }
    await recordSheetsSync(env, {
      registrationId: d1Result.registrationId,
      ok: mirror.ok,
      error: mirror.error,
    });

    return json({
      ok: true,
      result: {
        ...d1Result,
        primaryStore: "d1",
        googleSheetsMirror: mirror,
      },
      email: { ok: true, skipped: true, deferred: deferConfirmationEmail, provider: "d1-migration-pending" },
    }, 200, request, env);
  } catch (error) {
    return json(
      { ok: false, error: String(error?.message || error) },
      502,
      request,
      env,
    );
  }
}

async function handleFinalConfirmationEmail(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return json({ ok: false, error: "Origin not allowed" }, 403, request, env);
  }

  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return json(
      { ok: false, error: "Apps Script email configuration is missing" },
      500,
      request,
      env,
    );
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return json({ ok: false, error: "Invalid JSON" }, 400, request, env);
  }

  // Only gate the player-registration final confirmation (identified by
  // registrationSubmissionId); volunteer/coaching confirmations are unaffected.
  if (payload.registrationSubmissionId) {
    const registrationSettings = await getRegistrationSettings(
      env,
      PADUCAH_GO_PROGRAM_ID,
    );
    const access = await evaluateRegistrationAccess(env, {
      settings: registrationSettings,
      resumeToken: payload.resumeToken,
      privateAccessToken: payload.privateAccessToken,
      requireResumeReverification: true,
    });
    if (!access.allowed) {
      return json(
        registrationClosedPayload(registrationSettings),
        403,
        request,
        env,
      );
    }
  }

  const recipientEmail = String(payload.recipientEmail || "").trim();
  const submissionId = String(
    payload.submissionId ||
      payload.registrationSubmissionId ||
      payload.volunteerSubmissionId ||
      payload.coachingSubmissionId ||
      "",
  ).trim();
  const emailType = String(payload.emailType || "").trim();
  if (!recipientEmail || !submissionId || !emailType) {
    return json(
      {
        ok: false,
        error: "Missing recipientEmail, submissionId, or emailType",
      },
      400,
      request,
      env,
    );
  }

  try {
    const scholarshipRequested =
      String(payload.scholarshipRequested || "No")
        .trim()
        .toLowerCase() === "yes";
    const signedDocumentUrls = Array.isArray(payload.signedDocumentUrls)
      ? [...payload.signedDocumentUrls]
      : [];
    let scholarshipDocumentUrl = "";

    if (scholarshipRequested) {
      const scholarshipResult = await acceptScholarshipApplication(env, {
        registrationSubmissionId: String(
          payload.registrationSubmissionId || submissionId || "",
        ).trim(),
        parentEmail: recipientEmail,
        parentName:
          `${String(payload.applicantFirstName || "").trim()} ${String(payload.applicantLastName || "").trim()}`.trim(),
        participantNames: Array.isArray(payload.participantNames)
          ? payload.participantNames.join(", ")
          : String(payload.participantNames || "").trim(),
      });
      if (!scholarshipResult.ok) {
        return json(
          {
            ok: false,
            error:
              scholarshipResult.error ||
              "Apps Script scholarship acceptance failed",
          },
          502,
          request,
          env,
        );
      }
      scholarshipDocumentUrl = String(
        scholarshipResult.documentUrl || "",
      ).trim();
      if (scholarshipDocumentUrl) {
        signedDocumentUrls.push({
          label: "Scholarship Guidelines",
          url: scholarshipDocumentUrl,
        });
      }
    }

    const params = new URLSearchParams();
    params.append("action", "send_flow_confirmation_email");
    params.append("submission_id", submissionId);
    params.append(
      "registration_submission_id",
      String(payload.registrationSubmissionId || "").trim(),
    );
    params.append(
      "volunteer_submission_id",
      String(payload.volunteerSubmissionId || "").trim(),
    );
    params.append(
      "coaching_submission_id",
      String(payload.coachingSubmissionId || "").trim(),
    );
    params.append("email_type", emailType);
    params.append("recipient_email", recipientEmail);
    params.append(
      "applicant_first_name",
      String(payload.applicantFirstName || "").trim(),
    );
    params.append(
      "applicant_last_name",
      String(payload.applicantLastName || "").trim(),
    );
    params.append(
      "participant_names",
      Array.isArray(payload.participantNames)
        ? payload.participantNames.join(", ")
        : String(payload.participantNames || "").trim(),
    );
    params.append(
      "forms_recorded_json",
      JSON.stringify(
        Array.isArray(payload.formsRecorded) ? payload.formsRecorded : [],
      ),
    );
    params.append(
      "agreements_recorded_json",
      JSON.stringify(
        Array.isArray(payload.agreementsRecorded)
          ? payload.agreementsRecorded
          : [],
      ),
    );
    params.append(
      "scholarship_requested",
      String(payload.scholarshipRequested || "No").trim(),
    );
    params.append("payment_required", payload.paymentRequired ? "yes" : "no");
    params.append("payment_url", String(payload.paymentUrl || "").trim());
    params.append("payment_amount", String(payload.paymentAmount || "").trim());
    params.append(
      "signed_document_urls_json",
      JSON.stringify(signedDocumentUrls),
    );
    params.append("source_url", String(payload.sourceUrl || "").trim());

    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return json(
        {
          ok: false,
          error: parsed?.error || "Apps Script final confirmation email failed",
        },
        502,
        request,
        env,
      );
    }
    return json(
      { ok: true, result: { ...parsed, scholarshipDocumentUrl } },
      200,
      request,
      env,
    );
  } catch (error) {
    return json(
      { ok: false, error: String(error?.message || error) },
      502,
      request,
      env,
    );
  }
}

async function acceptScholarshipApplication(env, input) {
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return {
      ok: false,
      error: "Missing Apps Script scholarship configuration",
    };
  }

  const params = new URLSearchParams();
  params.append("action", "accept_scholarship_application");
  params.append(
    "registration_submission_id",
    String(input.registrationSubmissionId || "").trim(),
  );
  params.append(
    "parent_email",
    String(input.parentEmail || "")
      .trim()
      .toLowerCase(),
  );
  params.append("parent_name", String(input.parentName || "").trim());
  params.append(
    "participant_names",
    String(input.participantNames || "").trim(),
  );

  try {
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error || "Apps Script scholarship acceptance failed",
      };
    }
    return {
      ok: true,
      documentUrl: String(parsed.documentUrl || "").trim(),
      participantDocumentCount: Number(parsed.participantDocumentCount || 0),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function buildParticipantNames(values) {
  const names = [];
  for (let index = 1; index <= 4; index += 1) {
    const name =
      `${values[`player_${index}_first_name`] || ""} ${values[`player_${index}_last_name`] || ""}`.trim();
    if (name) names.push(name);
  }
  return names.join(", ");
}

async function handlePaymentWebhook(request, env) {
  if (!isAuthorizedWebhookRequest(request, env.PAYMENT_WEBHOOK_TOKEN || "")) {
    return json({ ok: false, error: "Unauthorized webhook" }, 401);
  }

  const payload = await parseWebhookPayload(request);
  if (!payload) {
    return json({ ok: false, error: "Invalid webhook payload" }, 400);
  }

  const normalized = normalizePaymentWebhookPayload(payload);
  if (!normalized.submissionId) {
    return json(
      { ok: false, error: "Missing registration_submission_id" },
      400,
    );
  }
  if (!normalized.paid) {
    return json(
      { ok: true, ignored: true, reason: "Payment not completed" },
      202,
    );
  }

  const context = await getRegistrationContext(env, normalized.submissionId);
  if (!context.ok) {
    return json(
      {
        ok: false,
        error: context.error || "Registration context lookup failed",
      },
      404,
    );
  }
  if (String(context.paymentStatus || "").toLowerCase() === "paid") {
    return json({
      ok: true,
      duplicate: true,
      submissionId: normalized.submissionId,
    });
  }

  const agreementTxId =
    context.transactionId || normalized.agreementTransactionId;
  if (!agreementTxId) {
    return json({ ok: false, error: "Missing agreement transaction id" }, 404);
  }

  const signedDocumentUrl = await buildSignerUrl(
    request.url,
    agreementTxId,
    env,
    EMAIL_SIGNER_LINK_TTL_MS,
  );
  const paymentUpdate = await updatePaymentInSheets(env, {
    submissionId: normalized.submissionId,
    paymentStatus: "Paid",
    paymentAmount: normalized.amount,
    paymentCurrency: normalized.currency,
    paymentPaidAt: normalized.paidAt,
    paymentTransactionId: normalized.paymentTransactionId,
    paymentReceiptUrl: normalized.receiptUrl,
  });
  if (!paymentUpdate.ok) {
    return json(
      {
        ok: false,
        error: paymentUpdate.error || "Payment sheet update failed",
      },
      502,
    );
  }

  const emailResult = await sendRegistrationPaidEmail(env, {
    submissionId: normalized.submissionId,
    parentEmail: context.parentEmail,
    parentName: context.parentName,
    participantNames: context.participantNames,
    signedAt: context.signedAt,
    signedDocumentUrl,
    paymentUrl: buildPlayerRegistrationPaymentUrl({
      firstName: splitName(context.parentName).firstName,
      lastName: splitName(context.parentName).lastName,
      email: context.parentEmail || "",
      zip: "",
      submissionId: normalized.submissionId,
      amount: normalized.amount || "75",
      currency: normalized.currency || "USD",
    }),
    paymentReceiptUrl: normalized.receiptUrl,
    registrationFeeAmount: normalized.amount || "75",
    paidAt: normalized.paidAt,
  });
  if (!emailResult.ok) {
    return json(
      {
        ok: false,
        error: emailResult.error || "Payment confirmation email failed",
      },
      502,
    );
  }

  return json({
    ok: true,
    paid: true,
    emailed: true,
    submissionId: normalized.submissionId,
  });
}

async function handlePaymentReceiptEmail(message, env, ctx) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBuffer);
  const receipt = parseQuestReceiptEmail({
    subject: parsed.subject || message.headers.get("subject") || "",
    text: parsed.text || "",
    html: parsed.html || "",
    date: message.headers.get("date") || "",
  });

  if (!receipt) {
    console.log("payment-receipt-email-ignored", {
      from: message.from,
      to: message.to,
      subject: parsed.subject || message.headers.get("subject") || "",
    });
    return;
  }

  const resolved = await resolvePaymentReceiptContext(env, receipt);
  if (!resolved.ok) {
    console.warn("payment-receipt-email-unmatched", {
      orderId: receipt.orderId,
      parentEmail: receipt.parentEmail,
      error: resolved.error,
    });
    return;
  }

  const { submissionId, context } = resolved;
  if (
    String(context.paymentStatus || "")
      .trim()
      .toLowerCase() === "paid"
  ) {
    console.log("payment-receipt-email-duplicate", {
      submissionId,
      orderId: receipt.orderId,
      parentEmail: context.parentEmail,
    });
    return;
  }

  const paymentUpdate = await updatePaymentInSheets(env, {
    submissionId,
    paymentStatus: "Paid",
    paymentAmount: receipt.amount,
    paymentCurrency: receipt.currency,
    paymentPaidAt: receipt.paidAt,
    paymentTransactionId: receipt.paymentTransactionId,
    paymentReceiptUrl: receipt.receiptUrl,
  });
  if (!paymentUpdate.ok) {
    console.warn("payment-receipt-sheet-update-failed", {
      submissionId,
      orderId: receipt.orderId,
      error: paymentUpdate.error,
    });
    return;
  }

  let signedDocumentUrl = "";
  if (context.transactionId) {
    try {
      signedDocumentUrl = await buildSignerUrl(
        `${PRIMARY_APP_ORIGIN}/`,
        context.transactionId,
        env,
        EMAIL_SIGNER_LINK_TTL_MS,
      );
    } catch (error) {
      console.warn("payment-receipt-signer-url-failed", {
        submissionId,
        transactionId: context.transactionId,
        error: String(error?.message || error),
      });
    }
  }

  const emailWork = sendRegistrationPaidEmail(env, {
    submissionId,
    parentEmail: context.parentEmail,
    parentName: context.parentName,
    participantNames: context.participantNames,
    signedAt: context.signedAt,
    signedDocumentUrl,
    paymentUrl: buildPlayerRegistrationPaymentUrl({
      firstName: splitName(context.parentName).firstName,
      lastName: splitName(context.parentName).lastName,
      email: context.parentEmail || receipt.parentEmail,
      zip: receipt.postalCode || "",
      submissionId,
      amount: receipt.amount || "75",
      currency: receipt.currency || "USD",
    }),
    paymentReceiptUrl: receipt.receiptUrl,
    registrationFeeAmount: receipt.amount || "75",
    paidAt: receipt.paidAt,
  })
    .then((result) => {
      if (!result.ok) {
        console.warn("payment-receipt-email-send-failed", {
          submissionId,
          orderId: receipt.orderId,
          error: result.error,
        });
      }
      return result;
    })
    .catch((error) => {
      console.warn("payment-receipt-email-send-failed", {
        submissionId,
        orderId: receipt.orderId,
        error: String(error?.message || error),
      });
      return { ok: false, error: String(error?.message || error) };
    });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(emailWork);
  } else {
    await emailWork;
  }
}

async function handleSignerDownload(request, env) {
  const url = new URL(request.url);
  const txId = url.pathname.split("/").pop();
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (!txId || !exp || !sig)
    return new Response("Invalid link", { status: 400 });
  if (Date.now() > Number(exp))
    return new Response("Link expired", { status: 410 });

  const expected = await hmacHex(
    env.SIGNER_LINK_SECRET || "",
    `${txId}:${exp}`,
  );
  if (!timingSafeEq(sig, expected))
    return new Response("Invalid link", { status: 403 });

  const tx = await doFetch(
    env,
    `/transaction?txId=${encodeURIComponent(txId)}`,
  );
  if (!tx.value?.objectKey)
    return new Response("Document unavailable", { status: 404 });

  const object = await env.SIGNED_AGREEMENTS.get(tx.value.objectKey, {
    type: "stream",
  });
  if (!object) return new Response("Document unavailable", { status: 404 });

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=agreement-copy.pdf",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Cache-Control": "private, no-store",
    },
  });
}

async function handleAdminDownload(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expected = env.ADMIN_DOWNLOAD_TOKEN || "";
  if (!expected || auth !== `Bearer ${expected}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const txId = new URL(request.url).pathname.split("/").pop();
  const tx = await doFetch(
    env,
    `/transaction?txId=${encodeURIComponent(txId)}`,
  );
  if (!tx.value?.objectKey)
    return new Response("Document unavailable", { status: 404 });

  const object = await env.SIGNED_AGREEMENTS.get(tx.value.objectKey, {
    type: "stream",
  });
  if (!object) return new Response("Document unavailable", { status: 404 });

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${tx.value.agreementType}-${txId}.pdf"`,
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Cache-Control": "private, no-store",
    },
  });
}

function validateSigningPayload(payload, env) {
  if (!payload || typeof payload !== "object")
    return { ok: false, error: "Missing payload" };
  if (!payload.agreementType || !AGREEMENT_TEMPLATES[payload.agreementType]) {
    return { ok: false, error: "Invalid agreementType" };
  }

  if (!payload.submissionId || typeof payload.submissionId !== "string") {
    return { ok: false, error: "Missing submissionId" };
  }

  if (!payload.formType || typeof payload.formType !== "string") {
    return { ok: false, error: "Missing formType" };
  }

  const consentVersion = payload.audit?.consentVersion;
  if (!consentVersion || consentVersion !== env.E_CONSENT_TEXT_VERSION) {
    return { ok: false, error: "Invalid or mismatched consent version" };
  }

  if (!payload.audit?.viewedAtUtc) {
    return { ok: false, error: "Missing viewed timestamp" };
  }

  if (payload.agreementType === "player") {
    const mode = env.PLAYER_SIGNATURE_PLACEMENT_MODE;
    if (mode !== "parent_guardian_only" && mode !== "both_signature_lines") {
      return { ok: false, error: "Invalid PLAYER_SIGNATURE_PLACEMENT_MODE" };
    }
  }

  if (payload.agreementType === "volunteer") {
    const age = Number(payload.signer?.ageYears || 0);
    if (!Number.isFinite(age) || age < 18) {
      return { ok: false, error: "Volunteer signer must be at least 18" };
    }
  }

  return { ok: true };
}

async function generateSignedPdf({
  payload,
  templateBytes,
  env,
  txId,
  templateHash,
}) {
  const pdfDoc = await PDFDocument.load(templateBytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const signatureFont = await embedSignatureFont(pdfDoc, env);

  const map =
    payload.agreementType === "player"
      ? PLAYER_AGREEMENT_FIELD_MAP
      : VOLUNTEER_AGREEMENT_FIELD_MAP;

  const pages = pdfDoc.getPages();
  const targetPage = pages[Math.max(0, pages.length - map.pageFromEnd)];

  const fieldData = payload.fields || {};
  for (const [fieldName, cfg] of Object.entries(map.fields)) {
    const value = normalizeAgreementPdfFieldValue(
      fieldName,
      fieldData[fieldName],
    );
    if (!value) continue;
    drawWrappedText(targetPage, value, cfg, helvetica);
  }

  const acceptedSignerName = String(payload.signer?.printedName || "").trim();
  if (acceptedSignerName && map.signatureBounds?.primary) {
    const signatureOptions =
      payload.agreementType === "volunteer" ? { maxFontSize: 16 } : {};
    drawTypedSignature(
      targetPage,
      acceptedSignerName,
      map.signatureBounds.primary,
      signatureFont,
      signatureOptions,
    );
  }

  return pdfDoc.save();
}

function normalizeAgreementPdfFieldValue(fieldName, rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return "";

  // Date of Birth is a calendar date, not a timestamp. Older refresh code
  // could stringify a Google Sheets Date object and send a verbose value such
  // as "Mon Nov 09 1981 00:00:00 GMT-0500 (...)". Never render that into the
  // agreement. Keep the exact month/day/year only.
  if (fieldName === "guardianDob") {
    return normalizeAgreementDateOnly(value);
  }

  return value;
}

function normalizeAgreementDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    return `${String(match[1]).padStart(2, "0")}/${String(match[2]).padStart(2, "0")}/${match[3]}`;
  }

  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (match) {
    return `${match[2]}/${match[3]}/${match[1]}`;
  }

  const months = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };

  match = raw.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\b/,
  );
  if (match) {
    return `${months[match[1]]}/${String(match[2]).padStart(2, "0")}/${match[3]}`;
  }

  return raw;
}

async function embedSignatureFont(pdfDoc, env) {
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = await readTemplateBytes(env, SIGNATURE_FONT_PATH);
  if (!fontBytes) {
    throw new Error(`Signature font not found: ${SIGNATURE_FONT_PATH}`);
  }
  return pdfDoc.embedFont(fontBytes, { subset: true });
}

function drawWrappedText(page, text, cfg, font) {
  const lines = wrapText(text, cfg.maxWidth, cfg.fontSize || 10, font);
  const lineHeight = (cfg.fontSize || 10) + 2;
  lines.forEach((line, idx) => {
    page.drawText(line, {
      x: cfg.x,
      y: cfg.y - idx * lineHeight,
      size: cfg.fontSize || 10,
      font,
      color: rgb(0.08, 0.08, 0.08),
    });
  });
}

function drawImageFit(page, img, bounds) {
  const scale = Math.min(bounds.width / img.width, bounds.height / img.height);
  const drawWidth = img.width * scale;
  const drawHeight = img.height * scale;
  const x = bounds.x + (bounds.width - drawWidth) / 2;
  const y = bounds.y + (bounds.height - drawHeight) / 2;
  page.drawImage(img, { x, y, width: drawWidth, height: drawHeight });
}

function drawTypedSignature(page, typed, bounds, font, options = {}) {
  const safe = String(typed || "")
    .trim()
    .slice(0, MAX_TYPED_SIGNATURE_LEN);
  if (!safe || !bounds || !font) return;

  const horizontalPadding = 4;
  const verticalPadding = 2;
  const maxWidth = Math.max(1, bounds.width - horizontalPadding * 2);
  const maxHeight = Math.max(1, bounds.height - verticalPadding * 2);
  const configuredMaxFontSize = Number(options.maxFontSize || 24);
  const maxFontSize = Number.isFinite(configuredMaxFontSize)
    ? Math.max(9, Math.min(24, configuredMaxFontSize))
    : 24;
  let size = Math.min(maxFontSize, Math.max(12, maxHeight * 0.95));
  const initialWidth = font.widthOfTextAtSize(safe, size);
  if (initialWidth > maxWidth) {
    size *= maxWidth / initialWidth;
  }
  size = Math.max(9, size);

  const textHeight =
    typeof font.heightAtSize === "function"
      ? font.heightAtSize(size, { descender: false })
      : size;
  const y =
    bounds.y + Math.max(verticalPadding, (bounds.height - textHeight) / 2 + 1);

  page.drawText(safe, {
    x: bounds.x + horizontalPadding,
    y,
    size,
    font,
    color: rgb(0.05, 0.05, 0.05),
  });
}

function appendCertificatePage(pdfDoc, cert, font, bold) {
  const page = pdfDoc.addPage([612, 792]);
  page.drawText("Electronic Signing Certificate", {
    x: 42,
    y: 750,
    size: 18,
    font: bold,
  });

  const rows = [
    ["Agreement Type", cert.payload.agreementType],
    ["Agreement/Template Version", cert.templateVersion],
    ["Template SHA-256", cert.templateHash],
    ["Registration/Application ID", cert.payload.submissionId],
    ["Printed Signer Name", cert.payload.signer?.printedName || ""],
    ["Signing Timestamp UTC", cert.payload.audit?.signedAtUtc || ""],
    ["Electronic Consent Version", cert.payload.audit?.consentVersion || ""],
    ["Signature Method", cert.payload.signature?.method || ""],
    ["Signing Transaction ID", cert.txId],
  ];

  let y = 716;
  rows.forEach(([k, v]) => {
    page.drawText(`${k}:`, { x: 42, y, size: 10, font: bold });
    page.drawText(String(v || ""), { x: 230, y, size: 10, font });
    y -= 22;
  });
}

function wrapText(text, maxWidth, fontSize, font) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, fontSize);
    if (width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function decodeDataUrl(dataUrl) {
  const b64 = dataUrl.split(",")[1] || "";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function updateAgreementInSheets(env, input) {
  await updateAgreementInD1(env, input);
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script update configuration" };
  }

  const params = new URLSearchParams();
  params.append("action", "update_agreement_metadata");
  params.append("form_type", input.formType);
  params.append("submission_id", input.submissionId);
  params.append("agreement_type", input.agreementType);
  params.append("agreement_status", input.status);
  params.append("agreement_version", input.agreementVersion);
  params.append("agreement_signed_at", input.signedAt);
  params.append("agreement_signer_name", input.signerName);
  params.append("agreement_file_id", input.fileId);
  params.append("agreement_pdf_url", input.pdfUrl);
  params.append("agreement_sha256", input.sha256);
  params.append("agreement_transaction_id", input.transactionId);

  try {
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return { ok: false, error: parsed?.error || "Apps Script update failed" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function handlePpfPdfRender(request, env) {
  const authorized = getAppsScriptUpdateTokenCandidates(env).some((token) =>
    isAuthorizedWebhookRequest(request, token),
  );

  if (!authorized) {
    return json({ ok: false, error: "Unauthorized" }, 403, request, env);
  }

  const payload = await parseWebhookPayload(request);
  if (!payload || typeof payload !== "object") {
    return json({ ok: false, error: "Invalid payload" }, 400, request, env);
  }

  const submissionId = String(
    payload.submissionId || payload.submission_id || "",
  ).trim();
  const parentName = String(
    payload.parentName || payload.parent_name || "",
  ).trim();
  const signingDate = String(
    payload.signingDate || payload.signing_date || "",
  ).trim();
  const participantRecords = normalizePpfParticipantRecords(
    payload.participants || payload.participantRecords,
  );

  if (!submissionId) {
    return json(
      { ok: false, error: "Missing submissionId" },
      400,
      request,
      env,
    );
  }
  if (!parentName) {
    return json({ ok: false, error: "Missing parentName" }, 400, request, env);
  }
  if (!participantRecords.length) {
    return json(
      { ok: false, error: "At least one participant is required" },
      400,
      request,
      env,
    );
  }

  const template = AGREEMENT_TEMPLATES.ppf;
  const templateBytes = await readTemplateBytes(env, template.key);
  if (!templateBytes) {
    return json(
      { ok: false, error: "PPF template not found" },
      500,
      request,
      env,
    );
  }

  const pdfBytes = await generatePpfLiabilityPdf({
    templateBytes,
    participants: participantRecords,
    parentName,
    signingDate,
    env,
  });

  return new Response(pdfBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="ppf-liability-${submissionId}.pdf"`,
    },
  });
}

async function updatePaymentInSheets(env, input) {
  await updatePaymentInD1(env, input);
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script update configuration" };
  }

  const params = new URLSearchParams();
  params.append("action", "update_payment_metadata");
  params.append("form_type", "mls_registration");
  params.append("submission_id", input.submissionId);
  params.append("payment_status", input.paymentStatus || "Paid");
  params.append("payment_amount", String(input.paymentAmount || ""));
  params.append("payment_currency", String(input.paymentCurrency || ""));
  params.append(
    "payment_paid_at",
    String(input.paymentPaidAt || new Date().toISOString()),
  );
  params.append(
    "payment_transaction_id",
    String(input.paymentTransactionId || ""),
  );
  params.append("payment_receipt_url", String(input.paymentReceiptUrl || ""));

  try {
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error || "Apps Script payment update failed",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function generatePpfLiabilityPdf({
  templateBytes,
  participants,
  parentName,
  signingDate,
  env,
}) {
  const sourcePdf = await PDFDocument.load(templateBytes);
  const combinedPdf = await PDFDocument.create();
  const helvetica = await combinedPdf.embedFont(StandardFonts.Helvetica);
  const signatureFont = await embedSignatureFont(combinedPdf, env);

  for (const participant of participants) {
    const copiedPages = await combinedPdf.copyPages(
      sourcePdf,
      sourcePdf.getPageIndices(),
    );
    copiedPages.forEach((page) => combinedPdf.addPage(page));
    const targetPage =
      copiedPages[
        Math.max(0, copiedPages.length - PPF_LIABILITY_FIELD_MAP.pageFromEnd)
      ];
    const fields = {
      participantSignatureDate: signingDate,
      participantName: String(participant.name || "").trim(),
      participantGrade: String(participant.grade || "").trim(),
      parentSignatureDate: signingDate,
      parentName,
    };

    for (const [fieldName, cfg] of Object.entries(
      PPF_LIABILITY_FIELD_MAP.fields,
    )) {
      const value = String(fields[fieldName] || "").trim();
      if (!value) continue;
      drawWrappedText(targetPage, value, cfg, helvetica);
    }

    drawTypedSignature(
      targetPage,
      parentName,
      PPF_LIABILITY_FIELD_MAP.signatureBounds.primary,
      signatureFont,
      { maxFontSize: 16 },
    );
  }

  return combinedPdf.save();
}

function normalizePpfParticipantRecords(value) {
  const records = Array.isArray(value)
    ? value
    : safeJsonParse(typeof value === "string" ? value : "[]");
  if (!Array.isArray(records)) return [];
  return records
    .map((participant) => ({
      name: String(
        participant?.name || participant?.participantName || "",
      ).trim(),
      grade: formatPpfParticipantDivisionLabel(
        participant?.grade || participant?.participantGrade || "",
        participant?.gender || participant?.participantGender || "",
      ),
    }))
    .filter((participant) => participant.name);
}

function formatPpfParticipantDivisionLabel(grade, gender) {
  const normalizedGrade = String(grade || "").trim();
  const normalizedGender = String(gender || "").trim();
  if (!normalizedGrade) return normalizedGender;
  if (/\b(Boys|Girls)\b/i.test(normalizedGrade)) return normalizedGrade;
  if (/^(Male|Boy|Boys)$/i.test(normalizedGender))
    return `${normalizedGrade} Boys`;
  if (/^(Female|Girl|Girls)$/i.test(normalizedGender))
    return `${normalizedGrade} Girls`;
  return normalizedGrade;
}

async function getRegistrationContext(env, submissionId) {
  const d1Context = await getRegistrationFromD1(env, submissionId);
  if (d1Context.ok) return d1Context;
  return d1Context;
}

async function lookupRegistrationForPaymentReceipt(env, input) {
  const d1Lookup = await findPaymentRegistrationInD1(env, input);
  if (d1Lookup.ok) return d1Lookup;
  return d1Lookup;
}

async function resolvePaymentReceiptContext(env, receipt) {
  if (receipt.submissionId) {
    const context = await getRegistrationContext(env, receipt.submissionId);
    if (!context.ok) return context;
    return { ok: true, submissionId: receipt.submissionId, context };
  }

  const lookup = await lookupRegistrationForPaymentReceipt(env, receipt);
  if (!lookup.ok) return lookup;
  if (!lookup.submissionId) {
    return { ok: false, error: "Receipt lookup returned no submission id" };
  }

  return {
    ok: true,
    submissionId: lookup.submissionId,
    context: {
      parentEmail: lookup.parentEmail,
      parentName: lookup.parentName,
      participantNames: lookup.participantNames,
      transactionId: lookup.transactionId,
      signedAt: lookup.signedAt,
      paymentStatus: lookup.paymentStatus,
      paymentTransactionId: lookup.paymentTransactionId,
    },
  };
}

async function readTemplateBytes(env, templatePath) {
  const url = new URL(templatePath, "https://assets.internal");
  const res = await env.ASSETS.fetch(new Request(url.toString()));
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

function buildObjectKey(agreementType, submissionId, txId) {
  const base =
    agreementType === "player" ? "player-agreements" : "volunteer-agreements";
  return `${base}/${submissionId}/${txId}.pdf`;
}

function buildAdminUrl(baseUrl, txId) {
  const base = new URL(baseUrl);
  return `${base.origin}/api/admin/agreement/${encodeURIComponent(txId)}`;
}

function buildSignerUrl(
  baseUrl,
  txId,
  env,
  ttlMs = DEFAULT_SIGNER_LINK_TTL_MS,
) {
  if (!env.SIGNER_LINK_SECRET) {
    throw new Error("Missing SIGNER_LINK_SECRET");
  }

  const exp = Date.now() + ttlMs;
  const payload = `${txId}:${exp}`;
  return hmacHex(env.SIGNER_LINK_SECRET, payload).then((sig) => {
    const base = new URL(baseUrl);
    return `${base.origin}/api/signer/agreement/${encodeURIComponent(txId)}?exp=${exp}&sig=${sig}`;
  });
}

async function sendRegistrationPaidEmail(env, input) {
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script email configuration" };
  }

  const parentEmail = String(input.parentEmail || "").trim();
  if (!parentEmail) {
    return { ok: false, error: "Missing parent email" };
  }

  const params = new URLSearchParams();
  params.append("action", "send_registration_paid_email");
  params.append("form_type", "mls_registration");
  params.append(
    "registration_submission_id",
    String(input.submissionId || "").trim(),
  );
  params.append("parent_email", parentEmail);
  params.append("parent_name", String(input.parentName || "").trim());
  params.append(
    "participant_names",
    String(input.participantNames || "").trim(),
  );
  params.append("signed_at", String(input.signedAt || "").trim());
  params.append(
    "signed_document_url",
    String(input.signedDocumentUrl || "").trim(),
  );
  params.append("payment_url", String(input.paymentUrl || "").trim());
  params.append(
    "payment_receipt_url",
    String(input.paymentReceiptUrl || "").trim(),
  );
  params.append("payment_paid_at", String(input.paidAt || "").trim());
  params.append(
    "registration_fee_amount",
    String(input.registrationFeeAmount || "75").trim(),
  );

  try {
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error || "Apps Script email send failed",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function sendRegistrationSubmissionEmail(env, input) {
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script email configuration" };
  }

  const parentEmail = String(input.parentEmail || "").trim();
  if (!parentEmail) {
    return { ok: false, error: "Missing parent email" };
  }

  const parentName = String(input.parentName || "").trim();
  const participantNames = String(input.participantNames || "").trim();
  const allResponseRows = Array.isArray(input.allResponseRows)
    ? input.allResponseRows
        .map((row) => ({
          label: String(row?.label || "").trim(),
          value: String(row?.value || "").trim(),
        }))
        .filter((row) => row.label && row.value)
    : [];

  const registrationFormValues = allResponseRows.length
    ? allResponseRows
    : [
        { label: "Parent/Guardian Full Name", value: parentName },
        {
          label: "Relationship to Child",
          value: String(input.relationshipToChild || "").trim(),
        },
        { label: "Email Address", value: parentEmail },
        {
          label: "Primary Phone Number",
          value: String(input.primaryPhone || "").trim(),
        },
        {
          label: "Alternate Phone Number",
          value: String(input.alternatePhone || "").trim(),
        },
        {
          label: "Emergency Contact Name",
          value: String(input.emergencyContactName || "").trim(),
        },
        {
          label: "Emergency Relationship",
          value: String(input.emergencyRelationship || "").trim(),
        },
        {
          label: "Emergency Contact Email",
          value: String(input.emergencyEmail || "").trim(),
        },
        {
          label: "Emergency Contact Phone",
          value: String(input.emergencyPhone || "").trim(),
        },
        {
          label: "Emergency Contact Address",
          value: [
            input.emergencyStreet,
            input.emergencyCity,
            input.emergencyState,
            input.emergencyZip,
          ]
            .filter(Boolean)
            .join(", "),
        },
        { label: "Participant(s)", value: participantNames },
      ].filter((row) => String(row.value || "").trim());

  const payload = {
    registration_submission_id: String(input.submissionId || "").trim(),
    submission_id: String(input.submissionId || "").trim(),
    parent_email: parentEmail,
    parent_name: parentName,
    participant_names: participantNames,
    relationship_to_child: String(input.relationshipToChild || "").trim(),
    primary_phone: String(input.primaryPhone || "").trim(),
    alternate_phone: String(input.alternatePhone || "").trim(),
    emergency_contact_name: String(input.emergencyContactName || "").trim(),
    emergency_relationship: String(input.emergencyRelationship || "").trim(),
    emergency_email: String(input.emergencyEmail || "").trim(),
    emergency_phone: String(input.emergencyPhone || "").trim(),
    emergency_street: String(input.emergencyStreet || "").trim(),
    emergency_city: String(input.emergencyCity || "").trim(),
    emergency_state: String(input.emergencyState || "").trim(),
    emergency_zip: String(input.emergencyZip || "").trim(),
    signed_at: String(input.signedAt || "").trim(),
    signed_document_url: String(input.signedDocumentUrl || "").trim(),
    payment_url: String(input.paymentUrl || "").trim(),
    registration_fee_amount: "75",
    all_response_rows_json: JSON.stringify(registrationFormValues),
    form_values_json: JSON.stringify(registrationFormValues),
  };

  const primary = await postRegistrationEmailAction(
    env,
    "send_registration_receipt_email",
    payload,
  );
  if (primary.ok) return primary;

  const fallback = await postRegistrationEmailAction(
    env,
    "send_registration_paid_email",
    payload,
  );
  if (fallback.ok) return fallback;

  if (!payload.registration_submission_id && !payload.submission_id) {
    return {
      ok: false,
      error:
        fallback.error ||
        primary.error ||
        "Apps Script registration email send failed",
    };
  }

  // Backward-compatible fallback for scripts only supporting the newer action name.
  return fallback;
}

async function sendVolunteerCoachConfirmationEmail(env, input) {
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script email configuration" };
  }

  const formType = String(input.formType || "").trim();
  const submissionId = String(input.submissionId || "").trim();
  if (!formType || !submissionId) {
    return { ok: false, error: "Missing formType or submissionId" };
  }

  const params = new URLSearchParams();
  params.append("action", "send_volunteer_coach_confirmation_email");
  params.append("form_type", formType);
  params.append("submission_id", submissionId);

  try {
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error || "Apps Script volunteer/coach email send failed",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function postRegistrationEmailAction(env, action, payload) {
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script email configuration" };
  }

  const params = new URLSearchParams();
  params.append("action", action);
  params.append("form_type", "mls_registration");

  Object.entries(payload).forEach(([key, value]) => {
    params.append(key, String(value || "").trim());
  });

  try {
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error || `Apps Script ${action} failed`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function isAuthorizedWebhookRequest(request, expectedToken) {
  if (!expectedToken) return false;

  const auth = request.headers.get("Authorization") || "";
  if (auth === `Bearer ${expectedToken}`) return true;

  const headerToken = request.headers.get("x-webhook-token") || "";
  if (headerToken === expectedToken) return true;

  const apiKeyHeader = request.headers.get("x-api-key") || "";
  if (apiKeyHeader === expectedToken) return true;

  const url = new URL(request.url);
  return url.searchParams.get("token") === expectedToken;
}

async function parseWebhookPayload(request) {
  if (request.method === "GET") {
    const out = {};
    const url = new URL(request.url);
    for (const [key, value] of url.searchParams.entries()) {
      out[key] = value;
    }
    return out;
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    return request.json().catch(() => null);
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData().catch(() => null);
    if (!formData) return null;
    const out = {};
    for (const [key, value] of formData.entries()) {
      out[key] = typeof value === "string" ? value : value?.name || "";
    }
    return out;
  }
  const text = await request.text().catch(() => "");
  if (!text) return null;
  return safeJsonParse(text);
}

function normalizePaymentWebhookPayload(payload) {
  const metadata =
    payload && typeof payload.metadata === "object" ? payload.metadata : {};
  const data = payload && typeof payload.data === "object" ? payload.data : {};
  const payment =
    payload && typeof payload.payment === "object" ? payload.payment : {};
  const transaction =
    payload && typeof payload.transaction === "object"
      ? payload.transaction
      : {};

  const paidStatus = String(
    payload.payment_status ||
      payload.status ||
      payload.event ||
      payload.event_type ||
      payload.transaction_status ||
      payload.result ||
      payload.outcome ||
      data.payment_status ||
      data.status ||
      payment.status ||
      transaction.status ||
      metadata.payment_status ||
      "",
  )
    .trim()
    .toLowerCase();

  const paidFlag = String(
    payload.paid ||
      payload.is_paid ||
      payload.success ||
      data.paid ||
      data.is_paid ||
      payment.paid ||
      payment.is_paid ||
      metadata.paid ||
      "",
  )
    .trim()
    .toLowerCase();

  return {
    submissionId: String(
      payload.registration_submission_id ||
        payload.submission_id ||
        payload.submissionId ||
        payload.registrationId ||
        payload.reference ||
        payload.external_reference ||
        payload.order_id ||
        payload.cart_id ||
        payload.invoice_id ||
        data.registration_submission_id ||
        data.submission_id ||
        data.reference ||
        payment.reference ||
        transaction.reference ||
        metadata.registration_submission_id ||
        metadata.submission_id ||
        metadata.reference ||
        metadata.external_reference ||
        "",
    ).trim(),
    agreementTransactionId: String(
      payload.agreement_transaction_id ||
        payload.transaction_id ||
        payload.agreementTxId ||
        data.agreement_transaction_id ||
        metadata.agreement_transaction_id ||
        "",
    ).trim(),
    paymentTransactionId: String(
      payload.payment_transaction_id ||
        payload.payment_id ||
        payload.gateway_transaction_id ||
        payload.charge_id ||
        payload.id ||
        data.payment_transaction_id ||
        data.payment_id ||
        payment.id ||
        transaction.id ||
        "",
    ).trim(),
    amount: String(
      payload.payment_amount ||
        payload.amount ||
        payload.total ||
        payload.gross_amount ||
        data.payment_amount ||
        data.amount ||
        payment.amount ||
        transaction.amount ||
        metadata.payment_amount ||
        "",
    ).trim(),
    currency: String(
      payload.payment_currency ||
        payload.currency ||
        data.payment_currency ||
        data.currency ||
        payment.currency ||
        transaction.currency ||
        metadata.payment_currency ||
        "USD",
    ).trim(),
    receiptUrl: String(
      payload.payment_receipt_url ||
        payload.receipt_url ||
        payload.receiptUrl ||
        payload.receipt ||
        payload.invoice_url ||
        data.payment_receipt_url ||
        data.receipt_url ||
        payment.receipt_url ||
        transaction.receipt_url ||
        metadata.payment_receipt_url ||
        "",
    ).trim(),
    paidAt: String(
      payload.payment_paid_at ||
        payload.paid_at ||
        payload.completed_at ||
        payload.updated_at ||
        payload.timestamp ||
        data.payment_paid_at ||
        data.paid_at ||
        data.completed_at ||
        payment.paid_at ||
        transaction.completed_at ||
        metadata.payment_paid_at ||
        new Date().toISOString(),
    ).trim(),
    paid:
      [
        "paid",
        "completed",
        "complete",
        "success",
        "succeeded",
        "captured",
        "approved",
      ].includes(paidStatus) || ["true", "1", "yes", "y"].includes(paidFlag),
  };
}

function isLocalDevUrl(urlValue) {
  try {
    const parsed = new URL(urlValue || "");
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    ) {
      return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}
function isLocalHttpVariantOfAllowedOrigin(origin, allowedOrigins, requestUrl) {
  try {
    const parsedOrigin = new URL(origin || "");
    const parsedRequestUrl = new URL(requestUrl || "");
    if (
      parsedOrigin.protocol !== "http:" ||
      parsedRequestUrl.protocol !== "http:"
    ) {
      return false;
    }
    return allowedOrigins.some((allowedOrigin) => {
      try {
        const parsedAllowedOrigin = new URL(allowedOrigin);
        return (
          parsedAllowedOrigin.protocol === "https:" &&
          parsedAllowedOrigin.hostname === parsedOrigin.hostname &&
          (parsedAllowedOrigin.port || "") === (parsedOrigin.port || "")
        );
      } catch (_error) {
        return false;
      }
    });
  } catch (_error) {
    return false;
  }
}

function isAllowedOrigin(origin, csv, requestUrl) {
  if (isLocalDevUrl(requestUrl)) return true;
  if (!origin) return false;
  if (isLocalDevUrl(origin)) return true;
  const allowed = [
    ...DEFAULT_ALLOWED_ORIGINS,
    ...csv
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ];
  return (
    allowed.includes(origin) ||
    isLocalHttpVariantOfAllowedOrigin(origin, allowed, requestUrl)
  );
}

function buildCorsHeaders(request, env) {
  const origin = request?.headers?.get("Origin") || "";
  const requestUrl = request?.url || "";
  const allowOrigin = isAllowedOrigin(
    origin,
    env.ALLOWED_ORIGINS || "",
    requestUrl,
  )
    ? origin
    : PRIMARY_APP_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-webhook-token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function handleApiOptions(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS || "", request.url)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request, env),
  });
}

async function markTransactionFailed(env, txId, reason) {
  await doFetch(env, "/transaction", {
    method: "POST",
    body: JSON.stringify({
      txId,
      value: {
        status: "failed",
        reason,
        updatedAt: new Date().toISOString(),
      },
    }),
  });
}

async function doFetch(env, path, init = {}) {
  const id = env.SIGNING_TRANSACTIONS.idFromName("global-signing-state");
  const stub = env.SIGNING_TRANSACTIONS.get(id);
  const req = new Request(`https://do.internal${path}`, {
    method: init.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    body: init.body,
  });
  const res = await stub.fetch(req);
  const payload = await res.json().catch(() => ({}));
  return payload;
}

async function sha256Hex(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(secret, value) {
  if (!secret) {
    throw new Error("Missing HMAC secret");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

async function postAppsScriptForm(url, params) {
  const body = typeof params === "string" ? params : params.toString();
  const res = await fetch(url, {
    method: "POST",
    body,
    redirect: "follow",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
  });

  return res.text();
}

function hasAppsScriptUpdateToken(env) {
  return getAppsScriptUpdateTokenCandidates(env).length > 0;
}

function getAppsScriptUpdateTokenCandidates(env) {
  return [
    ...new Set(
      [
        String(env?.APPS_SCRIPT_UPDATE_TOKEN || "").trim(),
        String(env?.AGREEMENT_UPDATE_TOKEN || "").trim(),
      ].filter(Boolean),
    ),
  ];
}

function cloneParamsWithoutUpdateTokens(params) {
  const clone = new URLSearchParams();
  params.forEach((value, key) => {
    if (
      key === "update_token" ||
      key === "token" ||
      key === "agreement_update_token"
    )
      return;
    clone.append(key, value);
  });
  return clone;
}

async function postAppsScriptFormWithUpdateTokenFallback(env, params) {
  const baseParams = cloneParamsWithoutUpdateTokens(params);
  const tokens = getAppsScriptUpdateTokenCandidates(env);

  if (!env.APPS_SCRIPT_URL || !tokens.length) {
    return {
      parsed: { ok: false, error: "Missing Apps Script update configuration" },
      text: "",
    };
  }

  let lastParsed = null;
  let lastText = "";

  for (const token of tokens) {
    const attemptParams = new URLSearchParams(baseParams);
    appendUpdateTokenParams(attemptParams, token);
    const text = await postAppsScriptForm(env.APPS_SCRIPT_URL, attemptParams);
    const parsed = safeJsonParse(text);
    if (parsed?.ok) {
      return { parsed, text };
    }
    lastParsed = parsed;
    lastText = text;
    if (parsed?.error !== "Unauthorized update token") {
      break;
    }
  }

  return { parsed: lastParsed, text: lastText };
}

function appendUpdateTokenParams(params, token) {
  const value = String(token || "").trim();
  params.append("update_token", value);
  // Backward compatibility with older Apps Script deployments.
  params.append("token", value);
  params.append("agreement_update_token", value);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function json(data, status = 200, request = null, env = null) {
  const corsHeaders = request && env ? buildCorsHeaders(request, env) : {};
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...corsHeaders,
    },
  });
}
