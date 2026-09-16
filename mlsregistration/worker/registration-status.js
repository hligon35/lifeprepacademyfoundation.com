// Server-side (D1-backed) registration open/closed control for Paducah GO Soccer League.
// Deliberately scoped to a single program_id today; every function takes programId as a
// parameter so Paducah NFL Flag Football / Clinic get their own isolated rows later without
// code changes here.

const PADUCAH_GO_PROGRAM_ID = "paducah-go-soccer-league";

const DEFAULT_CLOSED_MESSAGE =
  "MLS GO registration is closed until next season. Please check back for future registration dates.";

function normalizeSettingsRow(row, programId) {
  if (!row) {
    // No row for this program = fail closed. This is the safe default if the migration hasn't
    // run yet, D1 is unreachable, or a program has no configuration at all.
    return {
      programId,
      registrationStatus: "closed",
      allowDraftResume: false,
      allowPrivateAccess: false,
      privateAccessTokenHash: null,
      publicMessage: null,
      closedMessage: DEFAULT_CLOSED_MESSAGE,
      reopensAt: null,
      updatedAt: null,
      updatedBy: null,
    };
  }
  return {
    programId: row.program_id,
    registrationStatus: row.registration_status === "open" ? "open" : "closed",
    allowDraftResume: Boolean(row.allow_draft_resume),
    allowPrivateAccess: Boolean(row.allow_private_access),
    privateAccessTokenHash: row.private_access_token_hash || null,
    publicMessage: row.public_message || null,
    closedMessage: row.closed_message || DEFAULT_CLOSED_MESSAGE,
    reopensAt: row.reopens_at || null,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Not a true constant-time comparison over network timing, but avoids short-circuit string
// equality on secret hash values; adequate since the compared values are already SHA-256 hashes.
function timingSafeEqual(a, b) {
  const strA = String(a || "");
  const strB = String(b || "");
  if (strA.length !== strB.length) return false;
  let diff = 0;
  for (let i = 0; i < strA.length; i += 1) {
    diff |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  }
  return diff === 0;
}

async function getRegistrationSettings(env, programId = PADUCAH_GO_PROGRAM_ID) {
  if (!env?.DB) {
    return normalizeSettingsRow(null, programId);
  }
  try {
    const row = await env.DB.prepare(
      "SELECT * FROM registration_settings WHERE program_id = ?",
    )
      .bind(programId)
      .first();
    return normalizeSettingsRow(row, programId);
  } catch (error) {
    console.error("registration-settings-read-failed", error);
    return normalizeSettingsRow(null, programId);
  }
}

async function isPrivateAccessTokenValid(settings, providedToken) {
  const token = String(providedToken || "").trim();
  if (!settings?.allowPrivateAccess || !settings?.privateAccessTokenHash || !token) {
    return false;
  }
  const hash = await sha256Hex(token);
  return timingSafeEqual(hash, settings.privateAccessTokenHash);
}

// Re-checks a resume token against the existing Apps Script continuation service. Used so a
// registrant with a still-valid resume link can continue past a public closure, without the
// Worker maintaining its own copy of token state.
async function verifyResumeTokenActive(env, resumeToken, fetchImpl = fetch) {
  const token = String(resumeToken || "").trim();
  if (!token) return false;
  const webAppUrl = String(env?.CONTINUATION_WEB_APP_URL || "").trim();
  const sharedSecret = String(env?.CONTINUATION_WORKER_SHARED_SECRET || "").trim();
  if (!/^https:\/\/script\.google\.com\//i.test(webAppUrl) || !sharedSecret) {
    return false;
  }
  try {
    const response = await fetchImpl(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume_context", resumeToken: token, sharedSecret }),
    });
    const parsed = await response.json().catch(() => null);
    return Boolean(parsed?.ok && parsed?.context);
  } catch (error) {
    console.error("resume-token-verify-failed", error);
    return false;
  }
}

// Central gate used by every public registration mutation route. `requireResumeReverification`
// should be true for routes that don't themselves validate the resume token (forms/upsert,
// final-confirmation) and false for routes that validate it as part of their own job
// (resume/context, resume/complete), so the token isn't checked against Apps Script twice.
async function evaluateRegistrationAccess(env, options = {}) {
  const { settings, resumeToken, privateAccessToken, requireResumeReverification = false, fetchImpl } = options;

  if (settings.registrationStatus === "open") {
    return { allowed: true, via: "open" };
  }

  if (await isPrivateAccessTokenValid(settings, privateAccessToken)) {
    return { allowed: true, via: "private_access" };
  }

  if (settings.allowDraftResume && String(resumeToken || "").trim()) {
    if (!requireResumeReverification) {
      return { allowed: true, via: "resume" };
    }
    const valid = await verifyResumeTokenActive(env, resumeToken, fetchImpl);
    if (valid) return { allowed: true, via: "resume" };
  }

  return { allowed: false, via: "blocked" };
}

function registrationClosedPayload(settings) {
  return {
    ok: false,
    error: settings.closedMessage || DEFAULT_CLOSED_MESSAGE,
    code: "registration_closed",
    reopensAt: settings.reopensAt || null,
  };
}

async function getRegistrationOverview(env, programId = PADUCAH_GO_PROGRAM_ID) {
  const settings = await getRegistrationSettings(env, programId);
  let activeDrafts = 0;
  let submittedCount = 0;

  if (env?.DB) {
    try {
      const draftsRow = await env.DB.prepare(
        "SELECT COUNT(*) as c FROM registration_drafts WHERE program_id = ? AND completed_at IS NULL AND expires_at > datetime('now')",
      )
        .bind(programId)
        .first();
      activeDrafts = Number(draftsRow?.c || 0);
    } catch (error) {
      console.error("registration-overview-drafts-failed", error);
    }

    try {
      const submittedRow = await env.DB.prepare(
        "SELECT COUNT(*) as c FROM registrations WHERE program_id = ? AND status != 'incomplete'",
      )
        .bind(programId)
        .first();
      submittedCount = Number(submittedRow?.c || 0);
    } catch (error) {
      console.error("registration-overview-submissions-failed", error);
    }
  }

  return { settings, activeDrafts, submittedCount };
}

async function insertAuditLogEntry(env, entry) {
  if (!env?.DB) return;
  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor_admin_user_id, action, entity_type, entity_id, program_id, metadata_json, created_at)
     VALUES (?, NULL, ?, 'registration_settings', ?, ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      entry.action,
      entry.programId,
      entry.programId,
      JSON.stringify(entry.metadata || {}),
    )
    .run();
}

// Applies a partial update to a program's registration settings, upserting the row and recording
// an audit_log entry in the same call. `patch` fields are all optional except registrationStatus.
async function updateRegistrationSettings(env, programId, patch, actorLabel) {
  if (!env?.DB) {
    throw new Error("D1 binding (env.DB) is not configured");
  }
  const current = await getRegistrationSettings(env, programId);

  const nextStatus = patch.registrationStatus === "open" ? "open" : "closed";
  const nextAllowDraftResume = Boolean(patch.allowDraftResume);
  const nextAllowPrivateAccess = Boolean(patch.allowPrivateAccess);
  const nextPublicMessage =
    patch.publicMessage != null ? String(patch.publicMessage).trim() || null : current.publicMessage;
  const nextClosedMessage = patch.closedMessage
    ? String(patch.closedMessage).trim()
    : current.closedMessage;
  const nextReopensAt = patch.reopensAt ? String(patch.reopensAt).trim() : null;

  let nextPrivateAccessTokenHash = current.privateAccessTokenHash;
  if (patch.newPrivateAccessToken) {
    nextPrivateAccessTokenHash = await sha256Hex(String(patch.newPrivateAccessToken).trim());
  } else if (patch.clearPrivateAccessToken) {
    nextPrivateAccessTokenHash = null;
  }

  await env.DB.prepare(
    `INSERT INTO registration_settings
      (program_id, registration_status, allow_draft_resume, allow_private_access, private_access_token_hash, public_message, closed_message, reopens_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT (program_id) DO UPDATE SET
       registration_status = excluded.registration_status,
       allow_draft_resume = excluded.allow_draft_resume,
       allow_private_access = excluded.allow_private_access,
       private_access_token_hash = excluded.private_access_token_hash,
       public_message = excluded.public_message,
       closed_message = excluded.closed_message,
       reopens_at = excluded.reopens_at,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`,
  )
    .bind(
      programId,
      nextStatus,
      nextAllowDraftResume ? 1 : 0,
      nextAllowPrivateAccess ? 1 : 0,
      nextPrivateAccessTokenHash,
      nextPublicMessage,
      nextClosedMessage,
      nextReopensAt,
      actorLabel,
    )
    .run();

  await insertAuditLogEntry(env, {
    action: current.registrationStatus === nextStatus ? "registration_settings.updated" : `registration_settings.${nextStatus}`,
    programId,
    metadata: {
      actorLabel,
      previousStatus: current.registrationStatus,
      newStatus: nextStatus,
      allowDraftResume: nextAllowDraftResume,
      allowPrivateAccess: nextAllowPrivateAccess,
      reopensAt: nextReopensAt,
    },
  });

  return getRegistrationSettings(env, programId);
}

// Mirrors the existing ADMIN_DOWNLOAD_TOKEN bearer-token pattern used for agreement downloads.
// Interim auth until Phase 10 (program-scoped RBAC) replaces this with real admin sessions.
function isAuthorizedForSettingsChange(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expected = String(env?.ADMIN_SETTINGS_TOKEN || "").trim();
  if (!expected) return false;
  return timingSafeEqual(auth, `Bearer ${expected}`);
}

module.exports = {
  PADUCAH_GO_PROGRAM_ID,
  DEFAULT_CLOSED_MESSAGE,
  normalizeSettingsRow,
  sha256Hex,
  timingSafeEqual,
  getRegistrationSettings,
  isPrivateAccessTokenValid,
  verifyResumeTokenActive,
  evaluateRegistrationAccess,
  registrationClosedPayload,
  getRegistrationOverview,
  updateRegistrationSettings,
  isAuthorizedForSettingsChange,
};
