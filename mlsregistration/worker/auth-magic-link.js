// Family/staff-adjacent app-session auth: passwordless magic links via email (Layer B),
// distinct from the Cloudflare Access JWT staff layer in admin-auth.js.
import { sendEmail } from "./email-senders.js";

const LINK_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes to click the link
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 day session
const HANDOFF_CODE_TTL_MS = 60 * 1000; // 60 seconds to redeem on the target host

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
async function requestMagicLink(env, { email, requestOrigin }) {
  if (!isValidEmail(email)) return { ok: true };

  const db = env.DB;
  const user = await findOrCreateUser(db, email);
  if (user.status !== "active") return { ok: true };

  const rawToken = randomToken();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();

  await db
    .prepare(
      "INSERT INTO auth_sessions (id, user_id, token_hash, issued_host, expires_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), user.id, `pending:${tokenHash}`, requestOrigin || "", expiresAt)
    .run();

  const verifyUrl = `${requestOrigin}/api/auth/verify?token=${rawToken}`;
  await sendEmail(env, {
    to: user.email,
    fromName: "LifePrep Youth Programs",
    subject: "Your sign-in link",
    html: `<p>Click to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
    plainText: `Sign in: ${verifyUrl}\nThis link expires in 15 minutes.`,
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
      "SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE token_hash = ?"
    )
    .bind(pendingHash)
    .first();

  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "invalid_or_expired" };
  }

  const sessionToken = randomToken();
  const sessionHash = await sha256Hex(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await db
    .prepare(
      "UPDATE auth_sessions SET token_hash = ?, issued_host = ?, expires_at = ? WHERE id = ?"
    )
    .bind(sessionHash, host || "", sessionExpiresAt, row.id)
    .run();

  return { ok: true, sessionToken, expiresAt: sessionExpiresAt, userId: row.user_id };
}

async function getSessionUser(env, sessionToken) {
  if (!sessionToken) return null;
  const db = env.DB;
  const tokenHash = await sha256Hex(sessionToken);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, s.expires_at, s.revoked_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first();
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return { id: row.id, email: row.email, displayName: row.display_name };
}

// Mints a one-time code the source host embeds in a redirect URL so the target subdomain
// (which cannot read the source host's cookie) can exchange it for its own session cookie.
async function createHandoffCode(env, { sessionToken, sourceHost, targetHost }) {
  const user = await getSessionUser(env, sessionToken);
  if (!user) return null;

  const db = env.DB;
  const rawCode = randomToken();
  const codeHash = await sha256Hex(rawCode);
  const expiresAt = new Date(Date.now() + HANDOFF_CODE_TTL_MS).toISOString();

  await db
    .prepare(
      "INSERT INTO auth_handoff_codes (id, code_hash, user_id, source_host, target_host, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), codeHash, user.id, sourceHost, targetHost, expiresAt)
    .run();

  return rawCode;
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
      "INSERT INTO auth_sessions (id, user_id, token_hash, issued_host, expires_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), row.user_id, sessionHash, targetHost, sessionExpiresAt)
    .run();

  return { ok: true, sessionToken, expiresAt: sessionExpiresAt };
}

export {
  requestMagicLink,
  verifyMagicLink,
  getSessionUser,
  createHandoffCode,
  redeemHandoffCode,
};
