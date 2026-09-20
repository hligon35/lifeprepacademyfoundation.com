import { adminError, getAdminContext, normalizeProgram } from "./admin-auth.js";
import { getRegistrationOverview } from "./registration-status.js";
import { handleOperationsApi } from "./operations-api.js";
import { handleCommerceApi } from "./commerce-api.js";
import { importSheetRegistrants, parseCsv } from "./registrant-import.js";


const PROGRAM_MANAGER_ROLES = new Set(["super_admin", "program_administrator"]);
const REGISTRATION_MANAGER_ROLES = new Set(["super_admin", "program_administrator", "registration_manager"]);
const STAFF_ASSIGNABLE_ROLES = new Set([
  "program_administrator",
  "registration_manager",
  "roster_manager",
  "coach",
  "volunteer",
  "read_only_reviewer",
]);

function programRoleIds(context, programId) {
  if (context.isSuperAdmin) return new Set(["super_admin"]);
  return new Set(
    (context.roles || [])
      .filter((role) => role.program_id === programId)
      .map((role) => role.id),
  );
}

function canViewProgram(context, programId) {
  return Boolean(
    context.isSuperAdmin ||
      (context.programs || []).some((program) => program.id === programId),
  );
}

function canManageProgram(context, programId) {
  if (context.isSuperAdmin) return true;
  const roles = programRoleIds(context, programId);
  return [...PROGRAM_MANAGER_ROLES].some((role) => roles.has(role));
}

function canManageRegistration(context, programId) {
  if (context.isSuperAdmin) return true;
  const roles = programRoleIds(context, programId);
  return [...REGISTRATION_MANAGER_ROLES].some((role) => roles.has(role));
}

function denied(message = "Program access denied") {
  return json({ ok: false, error: message }, 403);
}

async function recordAudit(env, context, action, entityType, entityId, programId, metadata = {}) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, actor_admin_user_id, action, entity_type, entity_id, program_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    ).bind(
      crypto.randomUUID(),
      context.user?.id || null,
      action,
      entityType,
      entityId || null,
      programId || null,
      JSON.stringify(metadata),
    ).run();
  } catch (error) {
    console.warn("phase-one-audit-write-failed", error);
  }
}

async function selectedSeason(env, programId, seasonId) {
  if (seasonId) {
    return env.DB.prepare(
      "SELECT id, program_id, name, status, starts_on, ends_on, created_at, updated_at FROM seasons WHERE id = ? AND program_id = ? LIMIT 1",
    ).bind(seasonId, programId).first();
  }
  return env.DB.prepare(
    "SELECT id, program_id, name, status, starts_on, ends_on, created_at, updated_at FROM seasons WHERE program_id = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END, starts_on DESC, created_at DESC LIMIT 1",
  ).bind(programId).first();
}

async function getProgramWorkspace(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canViewProgram(context, programId)) return denied();

  const [program, seasons, season, registration, counts, participantCount, teamCount, announcementCount, staffCount] =
    await Promise.all([
      env.DB.prepare("SELECT id, name, status FROM programs WHERE id = ? LIMIT 1").bind(programId).first(),
      env.DB.prepare("SELECT id, program_id, name, status, starts_on, ends_on FROM seasons WHERE program_id = ? ORDER BY starts_on DESC, created_at DESC").bind(programId).all(),
      selectedSeason(env, programId, text(url.searchParams.get("seasonId"))),
      getRegistrationOverview(env, programId),
      env.DB.prepare("SELECT status, COUNT(*) AS count FROM registrations WHERE program_id = ? GROUP BY status ORDER BY status").bind(programId).all(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM registration_participants p JOIN registrations r ON r.id = p.registration_id WHERE r.program_id = ? AND r.status != 'withdrawn'").bind(programId).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM roster_teams WHERE program_id = ? AND (season_id = ? OR ? IS NULL)").bind(programId, text(url.searchParams.get("seasonId")) || null, text(url.searchParams.get("seasonId")) || null).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM announcements WHERE program_id = ? AND status IN ('published', 'scheduled')").bind(programId).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM admin_assignments WHERE program_id = ? AND status = 'active'").bind(programId).first(),
    ]);

  if (!program) return json({ ok: false, error: "Program not found" }, 404);
  let seasonSettings = null;
  if (season) {
    seasonSettings = await env.DB.prepare(
      "SELECT season_id, program_id, registration_mode, registration_capacity, target_team_size, target_games_per_team, generation_status FROM season_settings WHERE season_id = ? LIMIT 1",
    ).bind(season.id).first();
  }

  const registrationsByStatus = {};
  (counts.results || []).forEach((row) => { registrationsByStatus[row.status] = Number(row.count || 0); });
  return json({
    ok: true,
    program,
    seasons: seasons.results || [],
    season,
    seasonSettings,
    registration: {
      settings: registration.settings,
      activeDrafts: registration.activeDrafts,
      submittedCount: registration.submittedCount,
    },
    metrics: {
      registrations: Object.values(registrationsByStatus).reduce((sum, value) => sum + value, 0),
      submitted: registration.submittedCount,
      paid: registrationsByStatus.complete || 0,
      participants: Number(participantCount?.count || 0),
      teams: Number(teamCount?.count || 0),
      activeAnnouncements: Number(announcementCount?.count || 0),
      staffAssignments: Number(staffCount?.count || 0),
    },
    registrationsByStatus,
    viewer: {
      user: context.user,
      isSuperAdmin: context.isSuperAdmin,
      roles: context.roles,
      assignments: context.assignments || [],
    },
  });
}

async function listRegistrants(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canViewProgram(context, programId)) return denied();
  const status = text(url.searchParams.get("status"));
  const search = text(url.searchParams.get("search"));
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const values = [programId];
  const where = ["r.program_id = ?"];
  if (status && status !== "all") {
    where.push("r.status = ?");
    values.push(status);
  }
  if (search) {
    where.push("(LOWER(COALESCE(r.parent_first_name, '') || ' ' || COALESCE(r.parent_last_name, '')) LIKE ? OR LOWER(COALESCE(r.parent_email, '')) LIKE ? OR LOWER(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) LIKE ?)");
    const needle = "%" + search.toLowerCase() + "%";
    values.push(needle, needle, needle);
  }
  const rows = await env.DB.prepare(
    "SELECT r.id, r.submission_id, r.registration_type, r.status, r.payment_status, r.agreement_status, r.scholarship_requested, r.parent_first_name, r.parent_last_name, r.parent_email, r.raw_payload_json, r.created_at, r.submitted_at, COUNT(CASE WHEN p.participant_type = 'player' THEN p.id END) AS participant_count, COALESCE((SELECT GROUP_CONCAT(player_name, '||') FROM (SELECT TRIM(COALESCE(p2.first_name, '') || ' ' || COALESCE(p2.last_name, '')) AS player_name FROM registration_participants p2 WHERE p2.registration_id = r.id AND p2.participant_type = 'player' AND TRIM(COALESCE(p2.first_name, '') || ' ' || COALESCE(p2.last_name, '')) <> '' ORDER BY p2.slot_index ASC, p2.created_at ASC)), '') AS participant_names, CASE WHEN (EXISTS (SELECT 1 FROM registration_documents d WHERE d.registration_id = r.id AND d.document_type = 'ppf_liability' AND d.status IN ('generated', 'viewed')) OR LOWER(COALESCE(json_extract(r.raw_payload_json, '$.agree_ppf_liability'), '')) IN ('yes', 'true', '1', 'on')) THEN 1 ELSE 0 END AS agreement_lpaf_complete, CASE WHEN (LOWER(COALESCE(json_extract(r.raw_payload_json, '$.agree_marketing'), '')) IN ('yes', 'true', '1', 'on') OR LOWER(COALESCE(json_extract(r.raw_payload_json, '$.agree_privacy'), '')) IN ('yes', 'true', '1', 'on')) THEN 1 ELSE 0 END AS agreement_media_complete, CASE WHEN (EXISTS (SELECT 1 FROM registration_documents d WHERE d.registration_id = r.id AND d.document_type = 'player_agreement' AND d.status IN ('generated', 'viewed')) OR LOWER(COALESCE(r.agreement_status, '')) IN ('complete', 'completed', 'signed', 'generated', 'viewed')) THEN 1 ELSE 0 END AS agreement_plyr_complete FROM registrations r LEFT JOIN registration_participants p ON p.registration_id = r.id WHERE " + where.join(" AND ") + " GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?",
  ).bind(...values, limit).all();
  const registrants = (rows.results || []).map((row) => {
    const fallback = registrationNameFallback(row.raw_payload_json);
    const agreementLpafComplete = Number(row.agreement_lpaf_complete) === 1;
    const agreementMediaComplete = Number(row.agreement_media_complete) === 1;
    const agreementPlyrComplete = Number(row.agreement_plyr_complete) === 1;
    const parentFirst = text(row.parent_first_name) || fallback.parentFirst;
    const parentLast = text(row.parent_last_name) || fallback.parentLast;
    const participantNames = text(row.participant_names) || fallback.participantNames;
    const { raw_payload_json: _rawPayload, ...safeRow } = row;
    return {
      ...safeRow,
      parent_first_name: parentFirst,
      parent_last_name: parentLast,
      participant_names: participantNames,
      agreement_lpaf_complete: agreementLpafComplete,
      agreement_media_complete: agreementMediaComplete,
      agreement_plyr_complete: agreementPlyrComplete,
      agreements_received: [agreementLpafComplete, agreementMediaComplete, agreementPlyrComplete].filter(Boolean).length,
    };
  });
  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS count FROM registrations WHERE program_id = ? GROUP BY status ORDER BY status",
  ).bind(programId).all();
  return json({ ok: true, registrants, counts: counts.results || [], viewer: context.user });
}

async function importRegistrants(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  if (!programId || !canManageRegistration(context, programId)) {
    return denied("Registration import denied");
  }
  const rows = Array.isArray(payload?.rows)
    ? payload.rows
    : parseCsv(payload?.csv || "");
  if (!rows.length) return json({ ok: false, error: "No CSV rows were found" }, 400);

  const result = await importSheetRegistrants(env, {
    programId,
    seasonId: text(payload?.seasonId) || null,
    rows,
  });
  await recordAudit(env, context, "registrants.imported", "registration_import", programId, programId, {
    source: "google_sheets_csv",
    imported: result.imported,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.errors.length,
  });
  return json({ ok: true, ...result });
}

async function listAnnouncements(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canViewProgram(context, programId)) return denied();
  const seasonId = text(url.searchParams.get("seasonId"));
  const values = [programId];
  let where = "program_id = ?";
  if (seasonId) {
    where += " AND (season_id = ? OR season_id IS NULL)";
    values.push(seasonId);
  }
  const result = await env.DB.prepare(
    "SELECT id, program_id, season_id, audience_type, audience_id, title, body, priority, show_in_hero, status, starts_at, expires_at, created_by, published_at, created_at, updated_at FROM announcements WHERE " + where + " ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, priority DESC, created_at DESC LIMIT 100",
  ).bind(...values).all();
  return json({ ok: true, announcements: result.results || [] });
}

function announcementPayload(payload) {
  const title = text(payload?.title).slice(0, 160);
  const body = text(payload?.body).slice(0, 4000);
  const audienceType = text(payload?.audienceType || payload?.audience_type) || "program";
  const status = text(payload?.status) || "draft";
  const priority = Math.min(3, Math.max(0, Number(payload?.priority || 0)));
  if (!title || !body) return { error: "Announcement title and message are required" };
  if (!["program", "season", "division", "team", "staff"].includes(audienceType)) return { error: "Invalid announcement audience" };
  if (!["draft", "scheduled", "published", "expired", "archived"].includes(status)) return { error: "Invalid announcement status" };
  return {
    title,
    body,
    audienceType,
    audienceId: text(payload?.audienceId || payload?.audience_id) || null,
    seasonId: text(payload?.seasonId || payload?.season_id) || null,
    priority,
    showInHero: payload?.showInHero === true || payload?.show_in_hero === true ? 1 : 0,
    status,
    startsAt: text(payload?.startsAt || payload?.starts_at) || null,
    expiresAt: text(payload?.expiresAt || payload?.expires_at) || null,
  };
}

async function createAnnouncement(request, env, context) {
  const payload = announcementPayload(await request.json().catch(() => null));
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId") || payload.programId);
  if (payload.error) return json({ ok: false, error: payload.error }, 400);
  if (!programId || !canManageProgram(context, programId)) return denied("Announcement management denied");
  const id = crypto.randomUUID();
  const publishedAt = payload.status === "published" ? new Date().toISOString() : null;
  await env.DB.prepare(
    "INSERT INTO announcements (id, program_id, season_id, audience_type, audience_id, title, body, priority, show_in_hero, status, starts_at, expires_at, created_by, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
  ).bind(id, programId, payload.seasonId, payload.audienceType, payload.audienceId, payload.title, payload.body, payload.priority, payload.showInHero, payload.status, payload.startsAt, payload.expiresAt, context.user.id, publishedAt).run();
  await recordAudit(env, context, "announcement.created", "announcement", id, programId, { status: payload.status, audienceType: payload.audienceType });
  return json({ ok: true, announcement: await env.DB.prepare("SELECT * FROM announcements WHERE id = ?").bind(id).first() }, 201);
}

async function updateAnnouncement(request, env, context, id) {
  const current = await env.DB.prepare("SELECT * FROM announcements WHERE id = ? LIMIT 1").bind(id).first();
  if (!current) return json({ ok: false, error: "Announcement not found" }, 404);
  if (!canManageProgram(context, current.program_id)) return denied("Announcement management denied");
  const patch = announcementPayload(await request.json().catch(() => null));
  if (patch.error) return json({ ok: false, error: patch.error }, 400);
  const publishedAt = patch.status === "published" ? (current.published_at || new Date().toISOString()) : current.published_at;
  await env.DB.prepare(
    "UPDATE announcements SET season_id = ?, audience_type = ?, audience_id = ?, title = ?, body = ?, priority = ?, show_in_hero = ?, status = ?, starts_at = ?, expires_at = ?, published_at = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(patch.seasonId, patch.audienceType, patch.audienceId, patch.title, patch.body, patch.priority, patch.showInHero, patch.status, patch.startsAt, patch.expiresAt, publishedAt, id).run();
  await recordAudit(env, context, "announcement.updated", "announcement", id, current.program_id, { status: patch.status });
  return json({ ok: true, announcement: await env.DB.prepare("SELECT * FROM announcements WHERE id = ?").bind(id).first() });
}

async function createSeason(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  if (!programId || !canManageProgram(context, programId)) return denied("Season management denied");
  const name = text(payload?.name).slice(0, 120);
  if (!name) return json({ ok: false, error: "Season name is required" }, 400);
  const id = text(payload?.id).replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || crypto.randomUUID();
  const status = ["upcoming", "active", "closed", "archived"].includes(text(payload?.status)) ? text(payload.status) : "upcoming";
  const teamSize = Math.min(30, Math.max(2, Number(payload?.targetTeamSize || 10)));
  const games = Math.min(40, Math.max(1, Number(payload?.targetGamesPerTeam || 8)));
  const mode = ["inherit", "open", "closed", "waitlist"].includes(text(payload?.registrationMode)) ? text(payload.registrationMode) : "inherit";
  try {
    await env.DB.prepare(
      "INSERT INTO seasons (id, program_id, name, status, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, programId, name, status, text(payload?.startsOn) || null, text(payload?.endsOn) || null).run();
    await env.DB.prepare(
      "INSERT INTO season_settings (season_id, program_id, registration_mode, registration_capacity, target_team_size, target_games_per_team) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, programId, mode, Number(payload?.registrationCapacity) || null, teamSize, games).run();
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 400);
  }
  await recordAudit(env, context, "season.created", "season", id, programId, { name, status });
  return json({ ok: true, season: await env.DB.prepare("SELECT * FROM seasons WHERE id = ?").bind(id).first() }, 201);
}

async function updateSeason(request, env, context, id) {
  const current = await env.DB.prepare("SELECT * FROM seasons WHERE id = ? LIMIT 1").bind(id).first();
  if (!current) return json({ ok: false, error: "Season not found" }, 404);
  if (!canManageProgram(context, current.program_id)) return denied("Season management denied");
  const payload = await request.json().catch(() => null);
  const name = text(payload?.name || current.name).slice(0, 120);
  const status = ["upcoming", "active", "closed", "archived"].includes(text(payload?.status)) ? text(payload.status) : current.status;
  await env.DB.prepare("UPDATE seasons SET name = ?, status = ?, starts_on = ?, ends_on = ?, updated_at = datetime('now') WHERE id = ?").bind(name, status, text(payload?.startsOn || current.starts_on) || null, text(payload?.endsOn || current.ends_on) || null, id).run();
  if (payload?.targetTeamSize || payload?.targetGamesPerTeam || payload?.registrationMode || payload?.registrationCapacity) {
    await env.DB.prepare(
      "UPDATE season_settings SET registration_mode = ?, registration_capacity = ?, target_team_size = ?, target_games_per_team = ?, updated_at = datetime('now') WHERE season_id = ?",
    ).bind(
      text(payload?.registrationMode) || "inherit",
      Number(payload?.registrationCapacity) || null,
      Math.min(30, Math.max(2, Number(payload?.targetTeamSize || 10))),
      Math.min(40, Math.max(1, Number(payload?.targetGamesPerTeam || 8))),
      id,
    ).run();
  }
  await recordAudit(env, context, "season.updated", "season", id, current.program_id, { status });
  return json({ ok: true, season: await env.DB.prepare("SELECT * FROM seasons WHERE id = ?").bind(id).first() });
}

async function listStaffAssignments(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canViewProgram(context, programId)) return denied();
  const [assignments, directory] = await Promise.all([
    env.DB.prepare(
      "SELECT aa.id, aa.program_id, aa.season_id, aa.team_id, aa.role_id, aa.scope_type, aa.status, aa.expires_at, aa.created_at, u.email, u.display_name, r.name AS role_name, s.name AS season_name FROM admin_assignments aa JOIN admin_users u ON u.id = aa.admin_user_id JOIN roles r ON r.id = aa.role_id LEFT JOIN seasons s ON s.id = aa.season_id WHERE aa.program_id = ? AND aa.status = 'active' ORDER BY u.display_name, r.name",
    ).bind(programId).all(),
    env.DB.prepare(
      "SELECT id, email, display_name, status FROM admin_users WHERE status IN ('active', 'invited') ORDER BY display_name, email",
    ).all(),
  ]);
  return json({ ok: true, assignments: assignments.results || [], directory: directory.results || [] });
}

async function createStaffAssignment(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  if (!programId || !canManageProgram(context, programId)) return denied("Staff assignment denied");
  const adminUserId = text(payload?.adminUserId);
  const roleId = text(payload?.roleId);
  if (!adminUserId || !STAFF_ASSIGNABLE_ROLES.has(roleId)) return json({ ok: false, error: "A valid staff user and role are required" }, 400);
  const user = await env.DB.prepare("SELECT id, status FROM admin_users WHERE id = ? LIMIT 1").bind(adminUserId).first();
  if (!user || !["active", "invited"].includes(user.status)) return json({ ok: false, error: "Staff user is not available" }, 400);
  const seasonId = text(payload?.seasonId) || null;
  const scopeType = ["program", "season", "team"].includes(text(payload?.scopeType)) ? text(payload.scopeType) : (seasonId ? "season" : "program");
  if (scopeType === "season" && !seasonId) return json({ ok: false, error: "Season-scoped assignments require a season" }, 400);
  if (seasonId) {
    const season = await env.DB.prepare("SELECT id FROM seasons WHERE id = ? AND program_id = ? LIMIT 1").bind(seasonId, programId).first();
    if (!season) return json({ ok: false, error: "Season does not belong to this program" }, 400);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO admin_assignments (id, admin_user_id, program_id, season_id, team_id, role_id, scope_type, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, adminUserId, programId, seasonId, text(payload?.teamId) || null, roleId, scopeType, text(payload?.expiresAt) || null, context.user.id).run();
  await recordAudit(env, context, "staff_assignment.created", "admin_assignment", id, programId, { roleId, scopeType, seasonId });
  return json({ ok: true, assignment: await env.DB.prepare("SELECT * FROM admin_assignments WHERE id = ?").bind(id).first() }, 201);
}

async function removeStaffAssignment(request, env, context, id) {
  const current = await env.DB.prepare("SELECT * FROM admin_assignments WHERE id = ? LIMIT 1").bind(id).first();
  if (!current) return json({ ok: false, error: "Assignment not found" }, 404);
  if (!canManageProgram(context, current.program_id)) return denied("Staff assignment denied");
  await env.DB.prepare("UPDATE admin_assignments SET status = 'inactive', updated_at = datetime('now') WHERE id = ?").bind(id).run();
  await recordAudit(env, context, "staff_assignment.removed", "admin_assignment", id, current.program_id);
  return json({ ok: true });
}

async function getActivityLog(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  if (!programId || !canViewProgram(context, programId)) return denied();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const result = await env.DB.prepare(
    "SELECT a.id, a.action, a.entity_type, a.entity_id, a.program_id, a.metadata_json, a.created_at, COALESCE(u.display_name, u.email, 'System') AS actor_name FROM audit_log a LEFT JOIN admin_users u ON u.id = a.actor_admin_user_id WHERE a.program_id = ? ORDER BY a.created_at DESC LIMIT ?",
  ).bind(programId, limit).all();
  return json({ ok: true, entries: result.results || [] });
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizedKey(key) {
  return text(key)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizedPayload(payload) {
  const values = {};
  Object.entries(payload || {}).forEach(([key, value]) => {
    values[key] = value;
    const normalized = normalizedKey(key);
    if (normalized && values[normalized] === undefined) values[normalized] = value;
  });
  return values;
}

function firstValue(values, ...keys) {
  for (const key of keys) {
    const value = text(values?.[key] ?? values?.[normalizedKey(key)]);
    if (value) return value;
  }
  return "";
}

function registrationNameFallback(rawPayload) {
  let parsed;
  try {
    parsed = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  } catch {
    return { parentFirst: "", parentLast: "", participantNames: "" };
  }
  const values = normalizedPayload(parsed);
  const parentFirst = firstValue(values, "parent_first_name", "parent_guardian_first_name", "guardian_first_name");
  const parentLast = firstValue(values, "parent_last_name", "parent_guardian_last_name", "guardian_last_name");
  const players = [];
  for (let index = 1; index <= 4; index += 1) {
    const first = firstValue(values, `player_${index}_first_name`, `player${index}_first_name`, `player_${index}_firstname`, `player${index}firstname`);
    const last = firstValue(values, `player_${index}_last_name`, `player${index}_last_name`, `player_${index}_lastname`, `player${index}lastname`);
    const name = `${first} ${last}`.trim();
    if (name) players.push(name);
  }
  const existingNames = firstValue(values, "participant_names", "players");
  return {
    parentFirst,
    parentLast,
    participantNames: players.length
      ? players.join("||")
      : existingNames.split(/\s*\|\|\s*|\s*,\s*/).filter(Boolean).join("||"),
  };
}

function canAccessProgram(context, programId) {
  return context.isSuperAdmin || context.programs.some((program) => program.id === programId);
}

async function listSubmissions(request, env, context) {
  const url = new URL(request.url);
  const type = text(url.searchParams.get("type"));
  const status = text(url.searchParams.get("status"));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") || DEFAULT_LIMIT)));
  const where = [];
  const values = [];
  if (type && type !== "all") {
    if (type === "volunteer") {
      where.push("form_type IN ('volunteer', 'volunteer_application', 'coaching_application')");
    } else if (type === "other") {
      where.push("form_type NOT IN ('contact', 'youth', 'volunteer', 'volunteer_application', 'coaching_application')");
    } else {
      where.push("form_type = ?");
      values.push(type);
    }
  }
  if (status && status !== "all") {
    where.push("status = ?");
    values.push(status);
  }
  const result = await env.DB.prepare(
    `SELECT id, form_type, name, email, subject, message, page_url, status, created_at, updated_at, read_at, archived_at
     FROM site_submissions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'read' THEN 1 ELSE 2 END, created_at DESC
     LIMIT ?`,
  ).bind(...values, limit).all();
  return json({ ok: true, submissions: result.results || [], viewer: context.user });
}

async function updateSubmission(request, env, context, id) {
  const payload = await request.json().catch(() => null);
  const status = text(payload?.status);
  if (!['new', 'read', 'archived'].includes(status)) return json({ ok: false, error: "Invalid submission status" }, 400);
  const result = await env.DB.prepare(
    `UPDATE site_submissions
     SET status = ?, updated_at = datetime('now'),
         read_at = CASE WHEN ? = 'read' THEN COALESCE(read_at, datetime('now')) ELSE read_at END,
         archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, datetime('now')) ELSE archived_at END
     WHERE id = ?`,
  ).bind(status, status, status, id).run();
  if (!Number(result?.meta?.changes || 0)) return json({ ok: false, error: "Submission not found" }, 404);
  return json({ ok: true, status });
}

async function getAnalytics(env) {
  const [daily, registrations, submissions] = await Promise.all([
    env.DB.prepare(
      `SELECT metric_date, SUM(page_views) AS page_views, SUM(unique_visitors_est) AS unique_visitors_est,
              SUM(registrations_started) AS registrations_started, SUM(registrations_submitted) AS registrations_submitted,
              SUM(registrations_abandoned) AS registrations_abandoned
       FROM analytics_daily_metrics GROUP BY metric_date ORDER BY metric_date DESC LIMIT 30`,
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status NOT IN ('complete', 'withdrawn') THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid
       FROM registrations`,
    ).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS unread FROM site_submissions`,
    ).first(),
  ]);
  return {
    ok: true,
    metrics: {
      registrationTotal: Number(registrations?.total || 0),
      activeRegistrations: Number(registrations?.active || 0),
      paidRegistrations: Number(registrations?.paid || 0),
      submissionTotal: Number(submissions?.total || 0),
      unreadSubmissions: Number(submissions?.unread || 0),
    },
    daily: daily.results || [],
  };
}

async function getProgramOverview(env, context, programId) {
  if (!canAccessProgram(context, programId)) return json({ ok: false, error: "Program access denied" }, 403);
  const program = await env.DB.prepare("SELECT id, name, status FROM programs WHERE id = ? LIMIT 1").bind(programId).first();
  if (!program) return json({ ok: false, error: "Program not found" }, 404);
  const [registrationCounts, participants, settings] = await Promise.all([
    env.DB.prepare(
      `SELECT status, COUNT(*) AS count FROM registrations WHERE program_id = ? GROUP BY status ORDER BY status`,
    ).bind(programId).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM registration_participants p
       JOIN registrations r ON r.id = p.registration_id WHERE r.program_id = ?`,
    ).bind(programId).first(),
    env.DB.prepare(
      "SELECT registration_status, allow_draft_resume, reopens_at FROM registration_settings WHERE program_id = ? LIMIT 1",
    ).bind(programId).first(),
  ]);
  return json({
    ok: true,
    program,
    registrationsByStatus: registrationCounts.results || [],
    participantCount: Number(participants?.count || 0),
    registrationSettings: settings || null,
  });
}

function accessibleProgramIds(context) {
  return [...new Set((context.programs || []).map((program) => program.id).filter(Boolean))];
}

async function listProgramCatalog(env, context) {
  const ids = accessibleProgramIds(context);
  if (!context.isSuperAdmin && !ids.length) return json({ ok: true, programs: [], isSuperAdmin: false });
  const where = context.isSuperAdmin ? "" : "WHERE p.id IN (" + ids.map(() => "?").join(",") + ")";
  const result = await env.DB.prepare(
    `SELECT p.id, p.name, p.status, p.slug, p.host, p.description, p.logo_url, p.display_order, p.is_configured,
            ps.public_enabled, ps.registration_enabled, ps.contact_email, ps.support_phone, ps.features_json
     FROM programs p LEFT JOIN program_settings ps ON ps.program_id = p.id ${where}
     ORDER BY p.display_order, CASE WHEN p.status = 'active' THEN 0 ELSE 1 END, p.name`,
  ).bind(...(context.isSuperAdmin ? [] : ids)).all();
  return json({ ok: true, programs: (result.results || []).map(normalizeProgram), isSuperAdmin: context.isSuperAdmin });
}

async function getOrganizationOverview(env, context) {
  const ids = accessibleProgramIds(context);
  if (!context.isSuperAdmin && !ids.length) return json({ ok: true, programs: [], totals: {} });
  const where = context.isSuperAdmin ? "" : "WHERE p.id IN (" + ids.map(() => "?").join(",") + ")";
  const catalog = await env.DB.prepare(
    `SELECT p.id, p.name, p.status, p.slug, p.host, p.description, p.logo_url, p.display_order, p.is_configured,
            COALESCE(ps.public_enabled, 0) AS public_enabled,
            COALESCE(ps.registration_enabled, 0) AS registration_enabled,
            ps.contact_email, ps.support_phone, ps.features_json
     FROM programs p LEFT JOIN program_settings ps ON ps.program_id = p.id ${where}
     ORDER BY p.display_order, p.name`,
  ).bind(...(context.isSuperAdmin ? [] : ids)).all();
  const programs = await Promise.all((catalog.results || []).map(async (program) => {
    program = normalizeProgram(program);
    const [registrations, participants, teams, announcements, staff, orders] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status NOT IN ('incomplete', 'withdrawn') THEN 1 ELSE 0 END) AS submitted, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete, SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid FROM registrations WHERE program_id = ?").bind(program.id).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM registration_participants p JOIN registrations r ON r.id = p.registration_id WHERE r.program_id = ? AND r.status != 'withdrawn'").bind(program.id).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM roster_teams WHERE program_id = ? AND status != 'archived'").bind(program.id).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM announcements WHERE program_id = ? AND status IN ('published', 'scheduled')").bind(program.id).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM admin_assignments WHERE program_id = ? AND status = 'active'").bind(program.id).first(),
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid, COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents ELSE 0 END), 0) AS paid_cents FROM orders WHERE program_id = ?").bind(program.id).first(),
    ]);
    return {
      ...program,
      metrics: {
        registrations: Number(registrations?.total || 0),
        submitted: Number(registrations?.submitted || 0),
        complete: Number(registrations?.complete || 0),
        paidRegistrations: Number(registrations?.paid || 0),
        participants: Number(participants?.count || 0),
        teams: Number(teams?.count || 0),
        activeAnnouncements: Number(announcements?.count || 0),
        staffAssignments: Number(staff?.count || 0),
        orders: Number(orders?.total || 0),
        paidOrders: Number(orders?.paid || 0),
        paidOrderCents: Number(orders?.paid_cents || 0),
      },
    };
  }));
  const totals = programs.reduce((summary, program) => {
    Object.keys(program.metrics).forEach((key) => { summary[key] = (summary[key] || 0) + program.metrics[key]; });
    return summary;
  }, {});
  return json({ ok: true, programs, totals, isSuperAdmin: context.isSuperAdmin });
}

async function updateProgram(request, env, context, programId) {
  const current = await env.DB.prepare("SELECT * FROM programs WHERE id = ? LIMIT 1").bind(programId).first();
  if (!current) return json({ ok: false, error: "Program not found" }, 404);
  if (!canManageProgram(context, programId)) return denied("Program management denied");
  const payload = await request.json().catch(() => null);
  const coreFields = [];
  const coreValues = [];
  const addCore = (column, value) => { if (value !== undefined) { coreFields.push(column + " = ?"); coreValues.push(value); } };
  if (context.isSuperAdmin) {
    addCore("name", text(payload?.name).slice(0, 160) || current.name);
    addCore("status", ["active", "inactive", "hidden"].includes(text(payload?.status)) ? text(payload.status) : current.status);
    addCore("slug", text(payload?.slug).slice(0, 80).toLowerCase().replace(/[^a-z0-9-]/g, "-") || current.slug);
    addCore("host", text(payload?.host).slice(0, 255).toLowerCase() || current.host);
    addCore("display_order", Math.max(0, Math.floor(Number(payload?.displayOrder ?? current.display_order ?? 0))));
    addCore("is_configured", payload?.isConfigured === undefined ? current.is_configured : (payload.isConfigured ? 1 : 0));
  }
  addCore("description", payload?.description === undefined ? current.description : text(payload.description).slice(0, 1000));
  addCore("logo_url", payload?.logoUrl === undefined ? current.logo_url : text(payload.logoUrl).slice(0, 500));
  if (coreFields.length) {
    coreFields.push("updated_at = datetime('now')");
    await env.DB.prepare("UPDATE programs SET " + coreFields.join(", ") + " WHERE id = ?").bind(...coreValues, programId).run();
  }
  const settings = await env.DB.prepare("SELECT * FROM program_settings WHERE program_id = ? LIMIT 1").bind(programId).first();
  const settingsPayload = payload?.settings || payload || {};
  const settingKeys = ["publicEnabled", "registrationEnabled", "contactEmail", "supportPhone", "features"];
  const hasSettingChange = Boolean(payload?.settings) || settingKeys.some((key) => Object.prototype.hasOwnProperty.call(settingsPayload, key));
  let settingSummary = {};
  if (hasSettingChange || !settings) {
    const settingValues = [
      settingsPayload.publicEnabled === undefined ? Number(settings?.public_enabled || 0) : (settingsPayload.publicEnabled ? 1 : 0),
      settingsPayload.registrationEnabled === undefined ? Number(settings?.registration_enabled || 0) : (settingsPayload.registrationEnabled ? 1 : 0),
      settingsPayload.contactEmail === undefined ? (settings?.contact_email || null) : (text(settingsPayload.contactEmail) || null),
      settingsPayload.supportPhone === undefined ? (settings?.support_phone || null) : (text(settingsPayload.supportPhone) || null),
      settingsPayload.features === undefined ? (settings?.features_json || "{}") : JSON.stringify(settingsPayload.features || {}),
      context.user.id,
    ];
    await env.DB.prepare(
      `INSERT INTO program_settings (program_id, public_enabled, registration_enabled, contact_email, support_phone, features_json, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(program_id) DO UPDATE SET public_enabled = excluded.public_enabled,
         registration_enabled = excluded.registration_enabled, contact_email = excluded.contact_email,
         support_phone = excluded.support_phone, features_json = excluded.features_json, updated_at = datetime('now')`,
    ).bind(programId, ...settingValues).run();
    settingSummary = { publicEnabled: settingValues[0], registrationEnabled: settingValues[1] };
  }
  await recordAudit(env, context, "program.updated", "program", programId, programId, { status: payload?.status, ...settingSummary });
  return listProgramCatalog(env, context);
}

async function listSeasonTemplates(request, env, context) {
  const url = new URL(request.url);
  const requestedProgram = text(url.searchParams.get("programId"));
  if (requestedProgram && !canViewProgram(context, requestedProgram)) return denied();
  const values = [];
  let where = "status = 'active'";
  if (requestedProgram) {
    where += " AND (program_id = ? OR program_id IS NULL)";
    values.push(requestedProgram);
  } else if (!context.isSuperAdmin) {
    const ids = accessibleProgramIds(context);
    if (!ids.length) return json({ ok: true, templates: [] });
    where += " AND (program_id IS NULL OR program_id IN (" + ids.map(() => "?").join(",") + "))";
    values.push(...ids);
  }
  const result = await env.DB.prepare(
    "SELECT st.*, p.name AS program_name FROM season_templates st LEFT JOIN programs p ON p.id = st.program_id WHERE " + where + " ORDER BY CASE WHEN st.program_id IS NULL THEN 0 ELSE 1 END, st.name",
  ).bind(...values).all();
  return json({ ok: true, templates: result.results || [] });
}

function templatePayload(payload, current = {}) {
  const name = text(payload?.name || current.name).slice(0, 160);
  if (!name) return { error: "Template name is required" };
  const registrationMode = ["inherit", "open", "closed", "waitlist"].includes(text(payload?.registrationMode || current.registration_mode)) ? text(payload?.registrationMode || current.registration_mode) : "inherit";
  let settings = {};
  try {
    settings = payload?.settings ?? (current.settings_json ? JSON.parse(current.settings_json) : {});
  } catch (error) {
    return { error: "Template settings must be valid JSON" };
  }
  return {
    name,
    description: text(payload?.description ?? current.description).slice(0, 1000) || null,
    sport: text(payload?.sport ?? current.sport).slice(0, 80) || null,
    leagueFormat: text(payload?.leagueFormat || current.league_format) || "7v7",
    targetTeamSize: Math.min(30, Math.max(2, Number(payload?.targetTeamSize ?? current.target_team_size ?? 10))),
    targetGamesPerTeam: Math.min(40, Math.max(1, Number(payload?.targetGamesPerTeam ?? current.target_games_per_team ?? 8))),
    registrationMode,
    registrationCapacity: Number(payload?.registrationCapacity ?? current.registration_capacity) || null,
    settingsJson: JSON.stringify(settings && typeof settings === "object" ? settings : {}),
  };
}

async function createSeasonTemplate(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId) || null;
  if (programId ? !canManageProgram(context, programId) : !context.isSuperAdmin) return denied("Season template management denied");
  const normalized = templatePayload(payload);
  if (normalized.error) return json({ ok: false, error: normalized.error }, 400);
  const id = text(payload?.id).replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO season_templates (id, program_id, name, description, sport, league_format, target_team_size, target_games_per_team, registration_mode, registration_capacity, settings_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, programId, normalized.name, normalized.description, normalized.sport, normalized.leagueFormat, normalized.targetTeamSize, normalized.targetGamesPerTeam, normalized.registrationMode, normalized.registrationCapacity, normalized.settingsJson, context.user.id).run();
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 400);
  }
  await recordAudit(env, context, "season_template.created", "season_template", id, programId, { name: normalized.name });
  return json({ ok: true, template: await env.DB.prepare("SELECT * FROM season_templates WHERE id = ?").bind(id).first() }, 201);
}

async function updateSeasonTemplate(request, env, context, id) {
  const current = await env.DB.prepare("SELECT * FROM season_templates WHERE id = ? LIMIT 1").bind(id).first();
  if (!current) return json({ ok: false, error: "Season template not found" }, 404);
  if (current.program_id ? !canManageProgram(context, current.program_id) : !context.isSuperAdmin) return denied("Season template management denied");
  const payload = await request.json().catch(() => null);
  const normalized = templatePayload(payload, current);
  if (normalized.error) return json({ ok: false, error: normalized.error }, 400);
  const status = ["active", "archived"].includes(text(payload?.status)) ? text(payload.status) : current.status;
  await env.DB.prepare(
    "UPDATE season_templates SET name = ?, description = ?, sport = ?, league_format = ?, target_team_size = ?, target_games_per_team = ?, registration_mode = ?, registration_capacity = ?, settings_json = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(normalized.name, normalized.description, normalized.sport, normalized.leagueFormat, normalized.targetTeamSize, normalized.targetGamesPerTeam, normalized.registrationMode, normalized.registrationCapacity, normalized.settingsJson, status, id).run();
  await recordAudit(env, context, "season_template.updated", "season_template", id, current.program_id, { status });
  return json({ ok: true, template: await env.DB.prepare("SELECT * FROM season_templates WHERE id = ?").bind(id).first() });
}

async function createSeasonFromTemplate(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  const templateId = text(payload?.templateId);
  if (!programId || !templateId || !canManageProgram(context, programId)) return denied("Season management denied");
  const template = await env.DB.prepare("SELECT * FROM season_templates WHERE id = ? AND status = 'active' LIMIT 1").bind(templateId).first();
  if (!template || (template.program_id && template.program_id !== programId)) return json({ ok: false, error: "Template is not available for this program" }, 400);
  const name = text(payload?.name).slice(0, 120);
  if (!name) return json({ ok: false, error: "Season name is required" }, 400);
  const id = text(payload?.id).replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || crypto.randomUUID();
  const status = ["upcoming", "active", "closed", "archived"].includes(text(payload?.status)) ? text(payload.status) : "upcoming";
  try {
    await env.DB.prepare("INSERT INTO seasons (id, program_id, name, status, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?)").bind(id, programId, name, status, text(payload?.startsOn) || null, text(payload?.endsOn) || null).run();
    await env.DB.prepare("INSERT INTO season_settings (season_id, program_id, registration_mode, registration_capacity, target_team_size, target_games_per_team) VALUES (?, ?, ?, ?, ?, ?)").bind(id, programId, text(payload?.registrationMode) || template.registration_mode, Number(payload?.registrationCapacity ?? template.registration_capacity) || null, Number(payload?.targetTeamSize || template.target_team_size || 10), Number(payload?.targetGamesPerTeam || template.target_games_per_team || 8)).run();
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 400);
  }
  await recordAudit(env, context, "season.created_from_template", "season", id, programId, { templateId, name, status });
  return json({ ok: true, season: await env.DB.prepare("SELECT * FROM seasons WHERE id = ?").bind(id).first(), templateId }, 201);
}

async function handleAdminApi(request, env) {
  const context = await getAdminContext(request, env);
  if (!context.ok) return adminError(context);
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === "/api/admin/session" && request.method === "GET") {
      return json({
        ok: true,
        user: context.user,
        identity: context.identity,
        roles: context.roles,
        assignments: context.assignments || [],
        programs: context.programs,
        isSuperAdmin: context.isSuperAdmin,
      });
    }
    if (path === "/api/admin/submissions" && request.method === "GET") {
      return listSubmissions(request, env, context);
    }
    if (path.startsWith("/api/admin/submissions/") && request.method === "PATCH") {
      return updateSubmission(request, env, context, decodeURIComponent(path.split("/").pop()));
    }
    if (path === "/api/admin/analytics/overview" && request.method === "GET") {
      return getAnalytics(env);
    }
    if (path === "/api/admin/organization/overview" && request.method === "GET") {
      return getOrganizationOverview(env, context);
    }
    if (path === "/api/admin/program-catalog" && request.method === "GET") {
      return listProgramCatalog(env, context);
    }
    if (path === "/api/admin/programs" && request.method === "GET") {
      return listProgramCatalog(env, context);
    }
    if (path.startsWith("/api/admin/programs/") && request.method === "PATCH") {
      return updateProgram(request, env, context, decodeURIComponent(path.split("/").pop()));
    }
    if (
      path === "/api/admin/operations" ||
      path.startsWith("/api/admin/rosters") ||
      path.startsWith("/api/admin/schedules") ||
      path.startsWith("/api/admin/attendance") ||
      path.startsWith("/api/admin/volunteer-duties")
    ) {
      return handleOperationsApi(request, env, context);
    }
    if (path.startsWith("/api/admin/commerce/")) {
      return handleCommerceApi(request, env, context);
    }
    if (path === "/api/admin/program-workspace" && request.method === "GET") {
      return getProgramWorkspace(request, env, context);
    }
    if (path === "/api/admin/registrants" && request.method === "GET") {
      return listRegistrants(request, env, context);
    }
    if (path === "/api/admin/registrants/import" && request.method === "POST") {
      return importRegistrants(request, env, context);
    }
    if (path === "/api/admin/announcements" && request.method === "GET") {
      return listAnnouncements(request, env, context);
    }
    if (path === "/api/admin/announcements" && request.method === "POST") {
      return createAnnouncement(request, env, context);
    }
    if (path.startsWith("/api/admin/announcements/") && request.method === "PATCH") {
      return updateAnnouncement(request, env, context, decodeURIComponent(path.split("/").pop()));
    }
    if (path === "/api/admin/seasons" && request.method === "POST") {
      return createSeason(request, env, context);
    }
    if (path === "/api/admin/seasons/from-template" && request.method === "POST") {
      return createSeasonFromTemplate(request, env, context);
    }
    if (path.startsWith("/api/admin/seasons/") && request.method === "PATCH") {
      return updateSeason(request, env, context, decodeURIComponent(path.split("/").pop()));
    }
    if (path === "/api/admin/season-templates" && request.method === "GET") {
      return listSeasonTemplates(request, env, context);
    }
    if (path === "/api/admin/season-templates" && request.method === "POST") {
      return createSeasonTemplate(request, env, context);
    }
    if (path.startsWith("/api/admin/season-templates/") && request.method === "PATCH") {
      return updateSeasonTemplate(request, env, context, decodeURIComponent(path.split("/").pop()));
    }
    if (path === "/api/admin/staff/assignments" && request.method === "GET") {
      return listStaffAssignments(request, env, context);
    }
    if (path === "/api/admin/staff/assignments" && request.method === "POST") {
      return createStaffAssignment(request, env, context);
    }
    if (path.startsWith("/api/admin/staff/assignments/") && request.method === "DELETE") {
      return removeStaffAssignment(request, env, context, decodeURIComponent(path.split("/").pop()));
    }
    if (path === "/api/admin/activity-log" && request.method === "GET") {
      return getActivityLog(request, env, context);
    }
    if (path.startsWith("/api/admin/programs/") && request.method === "GET") {
      return getProgramOverview(env, context, decodeURIComponent(path.split("/").pop()));
    }
    return json({ ok: false, error: "Admin endpoint not found" }, 404);
  } catch (error) {
    console.error("admin-api-failed", error);
    return json({ ok: false, error: "Admin request failed" }, 500);
  }
}

export { handleAdminApi };
