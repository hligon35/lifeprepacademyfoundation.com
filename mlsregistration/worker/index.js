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

const MAX_SIGNATURE_DATA_URL_BYTES = 1024 * 1024;
const MAX_TYPED_SIGNATURE_LEN = 120;
const RATE_LIMIT_PER_MINUTE = 30;
const DEFAULT_SIGNER_LINK_TTL_MS = 1000 * 60 * 30;
const EMAIL_SIGNER_LINK_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SIGNATURE_FONT_PATH = "/fonts/GreatVibes-Regular.ttf";
const PRIMARY_APP_ORIGIN =
  "https://mlsregistration.lifeprepacademyfoundation.com";
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

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return handleApiOptions(request, env);
    }

    if (url.pathname === "/api/public-config" && request.method === "GET") {
      return handlePublicConfig(env, request);
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

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Not found" }, 404, request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return handleRegistrationLandingPage(request, env);
    }

    return env.ASSETS.fetch(request);
  },
  async email(message, env, ctx) {
    await handlePaymentReceiptEmail(message, env, ctx);
  },
};

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

async function handleAdminRegistrationStatusGet(request, env) {
  if (!isAuthorizedForSettingsChange(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const overview = await getRegistrationOverview(env, PADUCAH_GO_PROGRAM_ID);
  return json(
    {
      ok: true,
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
  if (!isAuthorizedForSettingsChange(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
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
  const actorLabel = String(payload.actorLabel || "").trim() || "unknown admin";
  try {
    const settings = await updateRegistrationSettings(
      env,
      PADUCAH_GO_PROGRAM_ID,
      payload,
      actorLabel,
    );
    return json({ ok: true, settings }, 200, request, env);
  } catch (error) {
    return json(
      { ok: false, error: String(error?.message || error) },
      500,
      request,
      env,
    );
  }
}

// Server-renders the registration landing page's open/closed shell (via HTMLRewriter) so the
// correct state is present in the HTML itself, not applied afterward by client JS.
async function handleRegistrationLandingPage(request, env) {
  const assetResponse = await env.ASSETS.fetch(request);
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

  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return json(
      { ok: false, error: "Apps Script update configuration is missing" },
      500,
      request,
      env,
    );
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
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const text = response.text;
    const parsed = response.parsed;

    if (!parsed?.ok) {
      return json(
        {
          ok: false,
          error: parsed?.error || "Apps Script upsert failed",
          details: parsed || text.slice(0, 500),
        },
        502,
        request,
        env,
      );
    }

    let email = { ok: true, skipped: true, deferred: deferConfirmationEmail };
    if (!deferConfirmationEmail && formType === "mls_registration") {
      email = await postRegistrationEmailAction(
        env,
        "send_registration_receipt_email",
        {
          registration_submission_id: values.registration_submission_id || "",
          parent_email: values.parent_email || "",
          parent_name:
            `${values.parent_first_name || ""} ${values.parent_last_name || ""}`.trim(),
          participant_names: buildParticipantNames(values),
        },
      );
    } else if (
      !deferConfirmationEmail &&
      (formType === "volunteer_application" ||
        formType === "coaching_application")
    ) {
      email = await sendVolunteerCoachConfirmationEmail(env, {
        formType,
        submissionId: values.submission_id || "",
      });
    }

    return json({ ok: true, result: parsed, email }, 200, request, env);
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
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script lookup configuration" };
  }

  const params = new URLSearchParams();
  params.append("action", "get_registration_context");
  params.append("form_type", "mls_registration");
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
        error: parsed?.error || "Apps Script context lookup failed",
      };
    }
    return {
      ok: true,
      parentEmail: String(parsed.parentEmail || "").trim(),
      parentName: String(parsed.parentName || "").trim(),
      participantNames: String(parsed.participantNames || "").trim(),
      transactionId: String(parsed.transactionId || "").trim(),
      signedAt: String(parsed.signedAt || "").trim(),
      paymentStatus: String(parsed.paymentStatus || "").trim(),
      paymentTransactionId: String(parsed.paymentTransactionId || "").trim(),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function lookupRegistrationForPaymentReceipt(env, input) {
  if (!env.APPS_SCRIPT_URL || !hasAppsScriptUpdateToken(env)) {
    return { ok: false, error: "Missing Apps Script lookup configuration" };
  }

  const params = new URLSearchParams();
  params.append("action", "lookup_registration_for_payment_receipt");
  params.append("form_type", "mls_registration");
  params.append(
    "parent_email",
    String(input.parentEmail || "")
      .trim()
      .toLowerCase(),
  );
  params.append("parent_name", String(input.parentName || "").trim());
  params.append("payment_amount", String(input.amount || "").trim());
  params.append("payment_paid_at", String(input.paidAt || "").trim());
  params.append(
    "payment_transaction_id",
    String(input.paymentTransactionId || "").trim(),
  );
  params.append("payment_receipt_url", String(input.receiptUrl || "").trim());
  params.append("event_name", String(input.eventName || "").trim());
  params.append("player_count", String(input.playerCount || "").trim());

  try {
    const response = await postAppsScriptFormWithUpdateTokenFallback(
      env,
      params,
    );
    const parsed = response.parsed;
    if (!parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error || "Apps Script payment receipt lookup failed",
      };
    }
    return {
      ok: true,
      submissionId: String(parsed.submissionId || "").trim(),
      parentEmail: String(parsed.parentEmail || "").trim(),
      parentName: String(parsed.parentName || "").trim(),
      participantNames: String(parsed.participantNames || "").trim(),
      transactionId: String(parsed.transactionId || "").trim(),
      signedAt: String(parsed.signedAt || "").trim(),
      paymentStatus: String(parsed.paymentStatus || "").trim(),
      paymentTransactionId: String(parsed.paymentTransactionId || "").trim(),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
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
