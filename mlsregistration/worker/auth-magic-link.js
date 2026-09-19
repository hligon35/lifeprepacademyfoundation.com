// Family/staff-adjacent app-session auth: passwordless magic links via email (Layer B),
// distinct from the Cloudflare Access JWT staff layer in admin-auth.js.
import { sendEmail } from "./email-senders.js";

const LINK_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour to click the login ticket
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 day session
const HANDOFF_CODE_TTL_MS = 60 * 1000; // 60 seconds to redeem on the target host
const DEFAULT_RETURN_TO = "/dashboard";

function randomToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isValidEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function safeReturnTo(value, fallback = DEFAULT_RETURN_TO) {
  const candidate = String(value || "").trim();
  return candidate.startsWith("/") && !candidate.startsWith("//") && !candidate.startsWith("/api/") && !candidate.startsWith("/cdn-cgi/") && !candidate.includes("\\")
    ? candidate
    : fallback;
}

async function findOrCreateUser(db, email) {
  const normalized = email.trim().toLowerCase();
  const existing = await db
    .prepare("SELECT id, email, display_name, status FROM users WHERE email = ?")
    .bind(normalized)
    .first();
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
    .bind(id, normalized)
    .run();
  return { id, email: normalized, display_name: null, status: "active" };
}

// Issues a one-time login link emailed to the requester; always responds success to callers
// to avoid leaking which emails have accounts.
async function requestMagicLink(env, { email, requestOrigin, returnTo }) {
  if (!isValidEmail(email)) return { ok: true };

  const db = env.DB;
  const user = await findOrCreateUser(db, email);
  if (user.status !== "active") return { ok: true };

  // Keep a single address from generating an unbounded number of email tickets.
  // The response remains intentionally generic so account existence is not exposed.
  const recentTickets = await db
    .prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ? AND auth_method = 'magic_link_pending' AND created_at >= datetime('now', '-15 minutes')")
    .bind(user.id)
    .first();
  if (Number(recentTickets?.count || 0) >= 5) return { ok: true };

  const rawToken = randomToken();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();
  const safeDestination = safeReturnTo(returnTo);

  await db
    .prepare(
      "INSERT INTO auth_sessions (id, user_id, token_hash, issued_host, expires_at, auth_method, return_to) VALUES (?, ?, ?, ?, ?, 'magic_link_pending', ?)"
    )
    .bind(crypto.randomUUID(), user.id, `pending:${tokenHash}`, requestOrigin || "", expiresAt, safeDestination)
    .run();

  const verifyUrl = `${requestOrigin}/api/auth/verify?token=${rawToken}`;
  await sendEmail(env, {
    to: user.email,
    fromName: "LifePrep Youth Programs",
    subject: "Your sign-in link",
    html: `<p>Click to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This login ticket expires in 1 hour.</p>`,
    plainText: `Sign in: ${verifyUrl}\nThis login ticket expires in 1 hour.`,
  });

  return { ok: true };
}

// Verifies the emailed token and upgrades the pending row into an active session.
async function verifyMagicLink(env, { token, host }) {
  if (!token) return { ok: false, error: "missing_token" };
  const db = env.DB;
  const tokenHash = await sha256Hex(token);
  const pendingHash = `pending:${tokenHash}`;

  const row = await db
    .prepare(
      "SELECT id, user_id, expires_at, revoked_at, return_to FROM auth_sessions WHERE token_hash = ?"
    )
    .bind(pendingHash)
    .first();

  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "invalid_or_expired" };
  }

  const sessionToken = randomToken();
  const sessionHash = await sha256Hex(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const returnTo = safeReturnTo(row.return_to);

  await db
    .prepare(
      "UPDATE auth_sessions SET token_hash = ?, issued_host = ?, expires_at = ?, last_seen_at = datetime('now'), auth_method = 'magic_link' WHERE id = ?"
    )
    .bind(sessionHash, host || "", sessionExpiresAt, row.id)
    .run();

  return { ok: true, sessionToken, expiresAt: sessionExpiresAt, userId: row.user_id, returnTo };
}

async function getSessionUser(env, sessionToken) {
  if (!sessionToken) return null;
  const db = env.DB;
  const tokenHash = await sha256Hex(sessionToken);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.status AS user_status,
              s.id AS session_id, s.expires_at, s.revoked_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first();
  if (!row || row.user_status !== "active" || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  await db
    .prepare("UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .bind(row.session_id)
    .run();
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    sessionId: row.session_id,
    expiresAt: row.expires_at,
  };
}

async function revokeSession(env, sessionToken) {
  if (!sessionToken) return false;
  const tokenHash = await sha256Hex(sessionToken);
  const result = await env.DB
    .prepare("UPDATE auth_sessions SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(tokenHash)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}

// Mints a one-time code the source host embeds in a redirect URL so the target subdomain
// (which cannot read the source host's cookie) can exchange it for its own session cookie.
async function createHandoffCodeForUser(env, { userId, sourceHost, targetHost }) {
  if (!userId || !sourceHost || !targetHost) return null;
  const allowedHosts = new Set([
    "app.lifeprepacademyfoundation.com",
    "paducahgo.lifeprepacademyfoundation.com",
    "pnffl.lifeprepacademyfoundation.com",
    "pnffc.lifeprepacademyfoundation.com",
  ]);
  if (!allowedHosts.has(String(targetHost).toLowerCase())) return null;

  const db = env.DB;
  const rawCode = randomToken();
  const codeHash = await sha256Hex(rawCode);
  const expiresAt = new Date(Date.now() + HANDOFF_CODE_TTL_MS).toISOString();

  await db
    .prepare(
      "INSERT INTO auth_handoff_codes (id, code_hash, user_id, source_host, target_host, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), codeHash, userId, sourceHost, targetHost, expiresAt)
    .run();

  return rawCode;
}

async function createHandoffCode(env, { sessionToken, sourceHost, targetHost }) {
  const user = await getSessionUser(env, sessionToken);
  if (!user) return null;
  return createHandoffCodeForUser(env, {
    userId: user.id,
    sourceHost,
    targetHost,
  });
}

// Redeems a handoff code exactly once and issues a fresh session on the target host.
async function redeemHandoffCode(env, { code, targetHost }) {
  if (!code) return { ok: false, error: "missing_code" };
  const db = env.DB;
  const codeHash = await sha256Hex(code);

  const row = await db
    .prepare(
      "SELECT id, user_id, target_host, expires_at, consumed_at FROM auth_handoff_codes WHERE code_hash = ?"
    )
    .bind(codeHash)
    .first();

  if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "invalid_or_expired" };
  }
  if (row.target_host !== targetHost) {
    return { ok: false, error: "host_mismatch" };
  }

  await db
    .prepare("UPDATE auth_handoff_codes SET consumed_at = datetime('now') WHERE id = ?")
    .bind(row.id)
    .run();

  const sessionToken = randomToken();
  const sessionHash = await sha256Hex(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await db
    .prepare(
      "INSERT INTO auth_sessions (id, user_id, token_hash, issued_host, expires_at, last_seen_at, auth_method, return_to) VALUES (?, ?, ?, ?, ?, datetime('now'), 'handoff', ?)"
    )
    .bind(crypto.randomUUID(), row.user_id, sessionHash, targetHost, sessionExpiresAt, DEFAULT_RETURN_TO)
    .run();

  return { ok: true, sessionToken, expiresAt: sessionExpiresAt };
}

export {
  requestMagicLink,
  verifyMagicLink,
  getSessionUser,
  revokeSession,
  createHandoffCode,
  createHandoffCodeForUser,
  redeemHandoffCode,
};
