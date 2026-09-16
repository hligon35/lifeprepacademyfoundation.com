import { adminError, getAdminContext } from "./admin-auth.js";

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
      return json({ ok: true, user: context.user, identity: context.identity, roles: context.roles, programs: context.programs });
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
