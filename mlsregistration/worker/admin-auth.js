const jwksCache = new Map();

const PROGRAM_METADATA_DEFAULTS = Object.freeze({
  "paducah-go-soccer-league": {
    slug: "paducah-go",
    host: "paducahgo.lifeprepacademyfoundation.com",
    description: "Paducah GO Soccer League operations, registration, teams, schedules, and merchandise.",
    logo_url: "/PGSlogo.png",
    display_order: 1,
  },
  "paducah-nfl-flag-football": {
    slug: "pnffl",
    host: "pnffl.lifeprepacademyfoundation.com",
    description: "Paducah NFL Flag Football League foundation.",
    logo_url: "/NFLFlagBlue.png",
    display_order: 2,
  },
  "paducah-nfl-flag-football-clinic": {
    slug: "pnffc",
    host: "pnffc.lifeprepacademyfoundation.com",
    description: "Paducah NFL Flag Football Clinic foundation.",
    logo_url: "/pffLogo.png",
    display_order: 3,
  },
});

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function bootstrapEmails(value) {
  return new Set(
    text(value)
      .split(/[;,\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeProgram(program) {
  const defaults = PROGRAM_METADATA_DEFAULTS[program?.id];
  if (!defaults) return program;
  const metadataMissing = !program.slug && !program.host && !program.logo_url;
  return {
    ...program,
    slug: program.slug || defaults.slug,
    host: program.host || defaults.host,
    description: program.description || defaults.description,
    logo_url: program.logo_url || defaults.logo_url,
    display_order: Number(program.display_order || 0) || defaults.display_order,
    is_configured: Number(program.is_configured || 0) === 1 || metadataMissing ? 1 : 0,
  };
}

function base64UrlToBytes(value) {
  const normalized = text(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

function normalizedTeamDomain(value) {
  const raw = text(value);
  if (!raw) return "";
  const url = /^https:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
  return url.origin;
}

async function getJwks(teamDomain, fetchImpl = fetch) {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Cloudflare Access JWKS request failed (${response.status})`);
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(teamDomain, { keys, expiresAt: Date.now() + 10 * 60 * 1000 });
  return keys;
}

async function verifyAccessJwt(token, env, fetchImpl = fetch) {
  const parts = text(token).split(".");
  if (parts.length !== 3) return null;

  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header?.alg !== "RS256" || !header?.kid) return null;

  const teamDomain = normalizedTeamDomain(env?.CF_ACCESS_TEAM_DOMAIN);
  const audience = text(env?.CF_ACCESS_AUD);
  if (!teamDomain || !audience) return null;

  const issuer = text(claims?.iss);
  if (issuer && issuer !== teamDomain) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(claims?.exp)) || Number(claims.exp) <= now) return null;
  if (claims?.nbf && Number(claims.nbf) > now + 30) return null;

  const audiences = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!audiences.map(text).includes(audience)) return null;

  const keyData = (await getJwks(teamDomain, fetchImpl)).find((key) => key.kid === header.kid);
  if (!keyData) return null;

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlToBytes(parts[2]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    signingInput,
  );
  if (!valid) return null;

  const email = text(claims.email || claims.preferred_username).toLowerCase();
  if (!email) return null;
  return {
    email,
    name: text(claims.name || claims.email || email),
    subject: text(claims.sub),
    issuer: teamDomain,
  };
}

async function getAdminIdentity(request, env, options = {}) {
  const assertion = request.headers.get("CF-Access-Jwt-Assertion");
  if (assertion) {
    try {
      const identity = await verifyAccessJwt(assertion, env, options.fetchImpl || fetch);
      if (identity) return { ok: true, via: "cloudflare_access", identity };
    } catch (error) {
      console.error("cloudflare-access-verification-failed", error);
    }
  }

  // Local-only escape hatch for Wrangler development. Do not configure this in production.
  const localToken = text(env?.ADMIN_DEV_TOKEN);
  const localEmail = text(env?.ADMIN_DEV_EMAIL).toLowerCase();
  const authorization = request.headers.get("Authorization") || "";
  if (localToken && localEmail && authorization === `Bearer ${localToken}`) {
    return {
      ok: true,
      via: "local_dev",
      identity: { email: localEmail, name: localEmail, subject: "local-dev" },
    };
  }

  return { ok: false, status: 401, error: "Cloudflare Access authentication required" };
}

async function getAdminContext(request, env, options = {}) {
  const authentication = await getAdminIdentity(request, env, options);
  if (!authentication.ok) return authentication;
  if (!env?.DB) return { ok: false, status: 503, error: "D1 binding is not configured" };

  const identity = authentication.identity;
  let user = await env.DB.prepare(
    "SELECT * FROM admin_users WHERE LOWER(email) = ? AND status = 'active' LIMIT 1",
  ).bind(identity.email).first();

  const isBootstrapAdmin = bootstrapEmails(env.ADMIN_BOOTSTRAP_EMAIL).has(identity.email);
  if (!user && isBootstrapAdmin) {
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO admin_users (id, email, display_name, status, last_login_at)
       VALUES (?, ?, ?, 'active', datetime('now'))
       ON CONFLICT(email) DO UPDATE SET status = 'active', last_login_at = datetime('now'), updated_at = datetime('now')`,
    ).bind(userId, identity.email, identity.name).run();
    user = await env.DB.prepare(
      "SELECT * FROM admin_users WHERE LOWER(email) = ? AND status = 'active' LIMIT 1",
    ).bind(identity.email).first();
    const programs = await env.DB.prepare("SELECT id FROM programs").all();
    for (const program of programs.results || []) {
      await env.DB.prepare(
        `INSERT INTO admin_user_programs (id, admin_user_id, program_id, role_id)
         VALUES (?, ?, ?, 'super_admin') ON CONFLICT(admin_user_id, program_id, role_id) DO NOTHING`,
      ).bind(crypto.randomUUID(), user.id, program.id).run();
    }
  }

  if (!user) return { ok: false, status: 403, error: "Your account is not approved for LPAF Admin" };

  await env.DB.prepare(
    "UPDATE admin_users SET last_login_at = datetime('now'), updated_at = datetime('now'), display_name = COALESCE(?, display_name) WHERE id = ?",
  ).bind(identity.name || null, user.id).run();

  const roles = await env.DB.prepare(
    `SELECT r.id, r.name, r.description, aup.program_id
     FROM admin_user_programs aup
     JOIN roles r ON r.id = aup.role_id
     WHERE aup.admin_user_id = ?`,
  ).bind(user.id).all();
  const isSuperAdmin = Boolean(isBootstrapAdmin) || (roles.results || []).some((role) => role.id === "super_admin");
  let programs = await env.DB.prepare(
    isSuperAdmin
      ? "SELECT id, name, status, slug, host, description, logo_url, display_order, is_configured FROM programs ORDER BY display_order, CASE WHEN status = 'active' THEN 0 ELSE 1 END, name"
      : `SELECT DISTINCT p.id, p.name, p.status, p.slug, p.host, p.description, p.logo_url, p.display_order, p.is_configured
         FROM programs p JOIN admin_user_programs aup ON aup.program_id = p.id
         WHERE aup.admin_user_id = ? ORDER BY p.display_order, p.name`,
  ).bind(...(isSuperAdmin ? [] : [user.id])).all();
  programs = { results: (programs.results || []).map(normalizeProgram) };

  let assignments = [];
  try {
    const assignmentRows = await env.DB.prepare(
      `SELECT aa.id, aa.program_id, aa.season_id, aa.team_id, aa.role_id,
              aa.scope_type, aa.status, aa.expires_at,
              r.name AS role_name, s.name AS season_name
       FROM admin_assignments aa
       JOIN roles r ON r.id = aa.role_id
       LEFT JOIN seasons s ON s.id = aa.season_id
       WHERE aa.admin_user_id = ? AND aa.status = 'active'
         AND (aa.expires_at IS NULL OR aa.expires_at >= datetime('now'))
       ORDER BY aa.program_id, aa.scope_type, aa.created_at`,
    ).bind(user.id).all();
    assignments = assignmentRows.results || [];
  } catch (error) {
    // The assignment table is introduced by the Phase One migration. Keep the
    // existing admin session usable while an older preview database is migrating.
    console.warn("admin-assignments-read-skipped", error);
  }

  if (!isSuperAdmin && assignments.length) {
    const existingPrograms = new Map((programs.results || []).map((program) => [program.id, program]));
    const assignmentProgramIds = [...new Set(assignments.map((assignment) => assignment.program_id))];
    try {
      const placeholders = assignmentProgramIds.map(() => "?").join(", ");
      const assignmentPrograms = await env.DB.prepare(
        "SELECT id, name, status, slug, host, description, logo_url, display_order, is_configured FROM programs WHERE id IN (" + placeholders + ") ORDER BY display_order, name",
      ).bind(...assignmentProgramIds).all();
      (assignmentPrograms.results || []).map(normalizeProgram).forEach((program) => existingPrograms.set(program.id, program));
      programs = { results: [...existingPrograms.values()] };
    } catch (error) {
      console.warn("assignment-programs-read-skipped", error);
    }
  }

  return {
    ok: true,
    via: authentication.via,
    identity,
    user: { id: user.id, email: user.email, displayName: user.display_name, status: user.status },
    roles: roles.results || [],
    assignments,
    isSuperAdmin,
    programs: programs.results || [],
  };
}

function adminError(context) {
  return new Response(JSON.stringify({ ok: false, error: context.error || "Unauthorized" }), {
    status: context.status || 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export { adminError, getAdminContext, getAdminIdentity, normalizeProgram, verifyAccessJwt };
