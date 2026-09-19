import { adminError, getAdminContext } from "./admin-auth.js";
import { getRegistrationOverview } from "./registration-status.js";


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
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
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
    "SELECT r.id, r.submission_id, r.registration_type, r.status, r.payment_status, r.agreement_status, r.parent_first_name, r.parent_last_name, r.parent_email, r.created_at, r.submitted_at, COUNT(p.id) AS participant_count, COALESCE(GROUP_CONCAT(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), ', '), '') AS participant_names FROM registrations r LEFT JOIN registration_participants p ON p.registration_id = r.id WHERE " + where.join(" AND ") + " GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?",
  ).bind(...values, limit).all();
  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS count FROM registrations WHERE program_id = ? GROUP BY status ORDER BY status",
  ).bind(programId).all();
  return json({ ok: true, registrants: rows.results || [], counts: counts.results || [], viewer: context.user });
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
    if (path === "/api/admin/programs" && request.method === "GET") {
      return json({ ok: true, programs: context.programs, isSuperAdmin: context.isSuperAdmin });
    }
    if (path === "/api/admin/program-workspace" && request.method === "GET") {
      return getProgramWorkspace(request, env, context);
    }
    if (path === "/api/admin/registrants" && request.method === "GET") {
      return listRegistrants(request, env, context);
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
    if (path.startsWith("/api/admin/seasons/") && request.method === "PATCH") {
      return updateSeason(request, env, context, decodeURIComponent(path.split("/").pop()));
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


