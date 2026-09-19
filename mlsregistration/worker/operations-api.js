const PROGRAM_MANAGER_ROLES = new Set(["super_admin", "program_administrator"]);
const TEAM_MANAGER_ROLES = new Set(["super_admin", "program_administrator", "roster_manager"]);
const TEAM_STAFF_ROLES = new Set(["coach", "volunteer"]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

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

function roleIdsForProgram(context, programId) {
  const roles = new Set(
    (context.roles || [])
      .filter((role) => role.program_id === programId)
      .map((role) => role.id),
  );
  (context.assignments || [])
    .filter((assignment) => assignment.program_id === programId && assignment.status === "active")
    .forEach((assignment) => roles.add(assignment.role_id));
  if (context.isSuperAdmin) roles.add("super_admin");
  return roles;
}

function canViewProgram(context, programId) {
  return Boolean(
    context.isSuperAdmin ||
      (context.programs || []).some((program) => program.id === programId),
  );
}

function canManageProgram(context, programId) {
  if (context.isSuperAdmin) return true;
  const roles = roleIdsForProgram(context, programId);
  return [...PROGRAM_MANAGER_ROLES].some((role) => roles.has(role));
}

function canManageTeams(context, programId) {
  if (context.isSuperAdmin) return true;
  const roles = roleIdsForProgram(context, programId);
  return [...TEAM_MANAGER_ROLES].some((role) => roles.has(role));
}

function canAccessTeam(context, programId, teamId) {
  if (canManageTeams(context, programId)) return true;
  return (context.assignments || []).some((assignment) =>
    assignment.program_id === programId &&
    assignment.team_id === teamId &&
    assignment.status === "active" &&
    TEAM_STAFF_ROLES.has(assignment.role_id),
  );
}

function canRecordGameResult(context, programId, teamId) {
  if (canManageProgram(context, programId)) return true;
  return (context.assignments || []).some((assignment) =>
    assignment.program_id === programId &&
    assignment.team_id === teamId &&
    assignment.status === "active" &&
    assignment.role_id === "coach",
  );
}

function denied(message = "Operations access denied") {
  return json({ ok: false, error: message }, 403);
}

async function audit(env, context, action, entityType, entityId, programId, metadata = {}) {
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
    console.warn("phase-two-audit-write-failed", error);
  }
}

function validFormat(value) {
  const format = text(value) || "7v7";
  return ["5v5", "6v6", "7v7", "8v8", "9v9", "10v10", "11v11"].includes(format)
    ? format
    : "7v7";
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value).split(",").map((item) => item.trim()).filter(Boolean);
}

async function getSeason(env, programId, seasonId) {
  return env.DB.prepare(
    "SELECT id, program_id, name, status, starts_on, ends_on FROM seasons WHERE id = ? AND program_id = ? LIMIT 1",
  ).bind(seasonId, programId).first();
}

async function getRosterGeneration(env, context, generationId) {
  const generation = await env.DB.prepare(
    "SELECT * FROM roster_generations WHERE id = ? LIMIT 1",
  ).bind(generationId).first();
  if (!generation) return json({ ok: false, error: "Roster generation not found" }, 404);
  if (!canViewProgram(context, generation.program_id)) return denied();

  const [teams, assignments] = await Promise.all([
    env.DB.prepare(
      "SELECT rt.id, rt.name, rt.league_format, rt.status FROM roster_generation_teams rgt JOIN roster_teams rt ON rt.id = rgt.team_id WHERE rgt.generation_id = ? ORDER BY rt.name",
    ).bind(generationId).all(),
    env.DB.prepare(
      "SELECT ra.id, ra.team_id, rt.name AS team_name, rt.status AS team_status, p.id AS participant_id, p.first_name, p.last_name, p.grade_or_age, p.favorite_club, p.assigned_uniform_club, ra.manual_override, ra.assignment_reason, ra.warnings_json, ra.is_current FROM roster_assignments ra JOIN registration_participants p ON p.id = ra.participant_id LEFT JOIN roster_teams rt ON rt.id = ra.team_id WHERE ra.roster_generation_id = ? ORDER BY rt.name, p.last_name, p.first_name",
    ).bind(generationId).all(),
  ]);
  return json({
    ok: true,
    generation,
    teams: teams.results || [],
    assignments: assignments.results || [],
  });
}

async function listRosters(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  const seasonId = text(url.searchParams.get("seasonId"));
  if (!programId || !seasonId || !canViewProgram(context, programId)) return denied();
  const [generations, teams] = await Promise.all([
    env.DB.prepare(
      "SELECT id, program_id, season_id, league_format, team_count, target_team_size, status, constraints_json, created_by, created_at, published_at, locked_at FROM roster_generations WHERE program_id = ? AND season_id = ? ORDER BY created_at DESC",
    ).bind(programId, seasonId).all(),
    env.DB.prepare(
      "SELECT id, name, league_format, status, created_at, updated_at FROM roster_teams WHERE program_id = ? AND season_id = ? ORDER BY status, name",
    ).bind(programId, seasonId).all(),
  ]);
  return json({ ok: true, generations: generations.results || [], teams: teams.results || [] });
}

function sortPlayers(a, b) {
  return String(a.grade_or_age || "").localeCompare(String(b.grade_or_age || ""), undefined, { numeric: true }) ||
    String(a.favorite_club || "").localeCompare(String(b.favorite_club || "")) ||
    String(a.last_name || "").localeCompare(String(b.last_name || "")) ||
    String(a.first_name || "").localeCompare(String(b.first_name || ""));
}

async function generateRoster(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  const seasonId = text(payload?.seasonId);
  if (!programId || !seasonId || !canManageTeams(context, programId)) return denied("Roster generation denied");
  const season = await getSeason(env, programId, seasonId);
  if (!season) return json({ ok: false, error: "Season not found" }, 404);

  const playersResult = await env.DB.prepare(
    "SELECT p.id, p.first_name, p.last_name, p.grade_or_age, p.favorite_club, p.league_team_id, p.manual_override FROM registration_participants p JOIN registrations r ON r.id = p.registration_id WHERE r.program_id = ? AND (r.season_id = ? OR r.season_id IS NULL) AND r.status = 'complete' AND p.participant_type = 'player' AND p.eligibility_status != 'ineligible' ORDER BY p.last_name, p.first_name",
  ).bind(programId, seasonId).all();
  const players = (playersResult.results || []).sort(sortPlayers);
  if (!players.length) return json({ ok: false, error: "No eligible completed player registrations are available for this season." }, 400);

  const lockedResult = await env.DB.prepare(
    "SELECT rt.id, rt.name, rt.status FROM roster_teams rt WHERE rt.program_id = ? AND rt.season_id = ? AND rt.status IN ('published', 'locked') ORDER BY rt.name",
  ).bind(programId, seasonId).all();
  const lockedTeams = lockedResult.results || [];
  const lockedIds = new Set(lockedTeams.map((team) => team.id));
  const lockedPlayers = new Map();
  players.forEach((player) => {
    if (player.league_team_id && lockedIds.has(player.league_team_id)) lockedPlayers.set(player.id, player.league_team_id);
  });

  const targetTeamSize = Math.min(30, Math.max(2, Number(payload?.targetTeamSize || 10)));
  const requestedCount = Math.max(1, Number(payload?.teamCount || Math.ceil(players.length / targetTeamSize)));
  const unassignedPlayers = players.filter((player) => !lockedPlayers.has(player.id));
  const minimumTeamCount = lockedTeams.length + (unassignedPlayers.length ? 1 : 0);
  const teamCount = Math.max(requestedCount, minimumTeamCount);
  const draftTeamCount = Math.max(0, teamCount - lockedTeams.length);
  const leagueFormat = validFormat(payload?.leagueFormat);
  const teamNames = parseList(payload?.teamNames);
  const generationId = crypto.randomUUID();
  const draftTeams = [];
  const statements = [];

  for (let index = 0; index < draftTeamCount; index += 1) {
    const teamId = crypto.randomUUID();
    const name = teamNames[index] || "Paducah GO Team " + (lockedTeams.length + index + 1);
    draftTeams.push({ id: teamId, name });
    statements.push(
      env.DB.prepare(
        "INSERT INTO roster_teams (id, program_id, season_id, league_format, name, status) VALUES (?, ?, ?, ?, ?, 'draft')",
      ).bind(teamId, programId, seasonId, leagueFormat, name),
      env.DB.prepare(
        "INSERT INTO roster_generation_teams (generation_id, team_id) VALUES (?, ?)",
      ).bind(generationId, teamId),
    );
  }
  lockedTeams.forEach((team) => {
    statements.push(
      env.DB.prepare(
        "INSERT INTO roster_generation_teams (generation_id, team_id) VALUES (?, ?)",
      ).bind(generationId, team.id),
    );
  });
  statements.unshift(
    env.DB.prepare(
      "INSERT INTO roster_generations (id, program_id, season_id, league_format, team_count, target_team_size, constraints_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      generationId,
      programId,
      seasonId,
      leagueFormat,
      teamCount,
      targetTeamSize,
      JSON.stringify({
        requestedTeamCount: requestedCount,
        lockedTeamCount: lockedTeams.length,
        preservedPublishedAssignments: lockedPlayers.size,
        balancing: ["grade_or_age", "favorite_club", "alphabetical_snake_distribution"],
      }),
      context.user.id,
    ),
  );

  const availableDraftTeams = draftTeams.map((team) => team.id);
  const assignments = [];
  let draftIndex = 0;
  players.forEach((player, index) => {
    const teamId = lockedPlayers.get(player.id) || availableDraftTeams[
      availableDraftTeams.length
        ? (Math.floor(draftIndex / availableDraftTeams.length) % 2 === 0
            ? draftIndex % availableDraftTeams.length
            : availableDraftTeams.length - 1 - (draftIndex % availableDraftTeams.length))
        : 0
    ];
    if (!lockedPlayers.has(player.id)) draftIndex += 1;
    if (!teamId) return;
    const reason = lockedPlayers.has(player.id)
      ? "Preserved published or locked assignment."
      : "Balanced draft recommendation using age/grade, favorite club, and snake distribution.";
    assignments.push({ player, teamId, reason });
    statements.push(
      env.DB.prepare(
        "INSERT INTO roster_assignments (id, roster_generation_id, participant_id, team_id, manual_override, assignment_reason, warnings_json, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      ).bind(
        crypto.randomUUID(),
        generationId,
        player.id,
        teamId,
        player.manual_override ? 1 : 0,
        reason,
        JSON.stringify([]),
      ),
    );
  });

  await env.DB.batch(statements);
  await env.DB.prepare(
    "UPDATE season_settings SET generation_status = 'draft', updated_at = datetime('now') WHERE season_id = ?",
  ).bind(seasonId).run();
  await audit(env, context, "roster.generation.created", "roster_generation", generationId, programId, {
    teamCount,
    playerCount: assignments.length,
    lockedPlayerCount: lockedPlayers.size,
  });
  return getRosterGeneration(env, context, generationId);
}

async function publishRoster(request, env, context, generationId) {
  const generation = await env.DB.prepare("SELECT * FROM roster_generations WHERE id = ? LIMIT 1").bind(generationId).first();
  if (!generation) return json({ ok: false, error: "Roster generation not found" }, 404);
  if (!canManageTeams(context, generation.program_id)) return denied("Roster publication denied");
  if (generation.status !== "draft") return json({ ok: false, error: "Only draft rosters can be published." }, 409);

  const assignments = await env.DB.prepare(
    "SELECT participant_id, team_id FROM roster_assignments WHERE roster_generation_id = ?",
  ).bind(generationId).all();
  const statements = [
    env.DB.prepare("UPDATE roster_teams SET status = 'published', updated_at = datetime('now') WHERE id IN (SELECT team_id FROM roster_generation_teams WHERE generation_id = ?) AND status = 'draft'").bind(generationId),
    env.DB.prepare("UPDATE roster_assignments SET is_current = 0 WHERE participant_id IN (SELECT participant_id FROM roster_assignments WHERE roster_generation_id = ?)").bind(generationId),
    env.DB.prepare("UPDATE roster_assignments SET is_current = 1 WHERE roster_generation_id = ?").bind(generationId),
    env.DB.prepare("UPDATE roster_generations SET status = 'published', published_at = datetime('now') WHERE id = ?").bind(generationId),
    env.DB.prepare("UPDATE season_settings SET generation_status = 'published', updated_at = datetime('now') WHERE season_id = ?").bind(generation.season_id),
  ];
  for (const assignment of assignments.results || []) {
    statements.push(
      env.DB.prepare("UPDATE registration_participants SET league_team_id = ?, updated_at = datetime('now') WHERE id = ?").bind(assignment.team_id, assignment.participant_id),
    );
  }
  await env.DB.batch(statements);
  await audit(env, context, "roster.generation.published", "roster_generation", generationId, generation.program_id);
  return getRosterGeneration(env, context, generationId);
}

async function lockRoster(request, env, context, generationId) {
  const generation = await env.DB.prepare("SELECT * FROM roster_generations WHERE id = ? LIMIT 1").bind(generationId).first();
  if (!generation) return json({ ok: false, error: "Roster generation not found" }, 404);
  if (!canManageProgram(context, generation.program_id)) return denied("Roster lock denied");
  if (generation.status !== "published") return json({ ok: false, error: "Only published rosters can be locked." }, 409);
  await env.DB.batch([
    env.DB.prepare("UPDATE roster_generations SET status = 'locked', locked_at = datetime('now') WHERE id = ?").bind(generationId),
    env.DB.prepare("UPDATE roster_teams SET status = 'locked', updated_at = datetime('now') WHERE id IN (SELECT team_id FROM roster_generation_teams WHERE generation_id = ?)").bind(generationId),
    env.DB.prepare("UPDATE season_settings SET generation_status = 'locked', updated_at = datetime('now') WHERE season_id = ?").bind(generation.season_id),
  ]);
  await audit(env, context, "roster.generation.locked", "roster_generation", generationId, generation.program_id);
  return getRosterGeneration(env, context, generationId);
}

function roundRobinRounds(teamIds, gamesPerTeam) {
  const ids = teamIds.slice();
  if (ids.length % 2 === 1) ids.push(null);
  if (ids.length < 2) return [];
  const fixed = ids[0];
  const rotating = ids.slice(1);
  const baseRounds = rotating.length;
  const rounds = [];
  const played = new Map(teamIds.map((id) => [id, 0]));
  let roundNumber = 0;
  while ([...played.values()].some((count) => count < gamesPerTeam) && roundNumber < gamesPerTeam * 3 + 3) {
    const current = [fixed].concat(rotating);
    const pairs = [];
    for (let index = 0; index < current.length / 2; index += 1) {
      const first = current[index];
      const second = current[current.length - 1 - index];
      if (first && second && played.get(first) < gamesPerTeam && played.get(second) < gamesPerTeam) {
        pairs.push({ home: roundNumber % 2 === 0 ? first : second, away: roundNumber % 2 === 0 ? second : first });
        played.set(first, played.get(first) + 1);
        played.set(second, played.get(second) + 1);
      }
    }
    if (pairs.length) rounds.push(pairs);
    rotating.unshift(rotating.pop());
    roundNumber += 1;
    if (roundNumber >= baseRounds && [...played.values()].every((count) => count >= gamesPerTeam)) break;
  }
  return rounds;
}

function scheduleConflicts(games) {
  const conflicts = [];
  const teamSlots = new Set();
  const fieldSlots = new Set();
  games.forEach((game) => {
    if (!game.startsAt) return;
    const teamKeyHome = game.homeTeamId + "|" + game.startsAt;
    const teamKeyAway = game.awayTeamId + "|" + game.startsAt;
    const fieldKey = (game.fieldName || "") + "|" + game.startsAt;
    if (teamSlots.has(teamKeyHome) || teamSlots.has(teamKeyAway)) conflicts.push("A team is scheduled twice at " + game.startsAt);
    if (fieldSlots.has(fieldKey) && game.fieldName) conflicts.push("A field is scheduled twice at " + game.startsAt);
    teamSlots.add(teamKeyHome);
    teamSlots.add(teamKeyAway);
    if (game.fieldName) fieldSlots.add(fieldKey);
  });
  return [...new Set(conflicts)];
}

async function listSchedules(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  const seasonId = text(url.searchParams.get("seasonId"));
  if (!programId || !seasonId || !canViewProgram(context, programId)) return denied();
  const versions = await env.DB.prepare(
    "SELECT id, program_id, season_id, games_per_team, status, constraints_json, created_at, published_at FROM schedule_versions WHERE program_id = ? AND season_id = ? ORDER BY created_at DESC",
  ).bind(programId, seasonId).all();
  return json({ ok: true, versions: versions.results || [] });
}

async function getSchedule(env, context, versionId) {
  const version = await env.DB.prepare("SELECT * FROM schedule_versions WHERE id = ? LIMIT 1").bind(versionId).first();
  if (!version) return json({ ok: false, error: "Schedule version not found" }, 404);
  if (!canViewProgram(context, version.program_id)) return denied();
  const games = await env.DB.prepare(
    "SELECT sg.*, home.name AS home_team_name, away.name AS away_team_name, gr.home_score, gr.away_score, gr.notes AS result_notes FROM schedule_games sg JOIN roster_teams home ON home.id = sg.home_team_id JOIN roster_teams away ON away.id = sg.away_team_id LEFT JOIN game_results gr ON gr.game_id = sg.id WHERE sg.version_id = ? ORDER BY sg.round_number, sg.starts_at, home.name",
  ).bind(versionId).all();
  return json({ ok: true, version, games: games.results || [] });
}

async function generateSchedule(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  const seasonId = text(payload?.seasonId);
  if (!programId || !seasonId || !canManageTeams(context, programId)) return denied("Schedule generation denied");
  const season = await getSeason(env, programId, seasonId);
  if (!season) return json({ ok: false, error: "Season not found" }, 404);
  const teamResult = await env.DB.prepare(
    "SELECT id, name FROM roster_teams WHERE program_id = ? AND season_id = ? AND status IN ('published', 'locked') ORDER BY name",
  ).bind(programId, seasonId).all();
  const teams = teamResult.results || [];
  if (teams.length < 2) return json({ ok: false, error: "Publish at least two teams before generating a schedule." }, 400);
  const settings = await env.DB.prepare("SELECT target_games_per_team FROM season_settings WHERE season_id = ? LIMIT 1").bind(seasonId).first();
  const gamesPerTeam = Math.min(30, Math.max(1, Number(payload?.gamesPerTeam || settings?.target_games_per_team || 8)));
  const rounds = roundRobinRounds(teams.map((team) => team.id), gamesPerTeam);
  const dates = parseList(payload?.dates);
  const times = parseList(payload?.timeSlots || payload?.times);
  const fields = parseList(payload?.fields);
  const games = [];
  rounds.forEach((round, roundIndex) => {
    round.forEach((pair, gameIndex) => {
      const date = dates[roundIndex % (dates.length || 1)] || "";
      const time = times[gameIndex % (times.length || 1)] || "";
      const startsAt = date ? date + (time ? "T" + time + ":00" : "T00:00:00") : null;
      games.push({
        roundNumber: roundIndex + 1,
        homeTeamId: pair.home,
        awayTeamId: pair.away,
        startsAt,
        fieldName: fields[gameIndex % (fields.length || 1)] || null,
      });
    });
  });
  const conflicts = scheduleConflicts(games);
  const versionId = crypto.randomUUID();
  const statements = [
    env.DB.prepare("INSERT INTO schedule_versions (id, program_id, season_id, games_per_team, constraints_json, created_by) VALUES (?, ?, ?, ?, ?, ?)").bind(versionId, programId, seasonId, gamesPerTeam, JSON.stringify({ dates, times, fields, conflicts }), context.user.id),
  ];
  games.forEach((game) => {
    statements.push(
      env.DB.prepare("INSERT INTO schedule_games (id, version_id, program_id, season_id, round_number, home_team_id, away_team_id, starts_at, field_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), versionId, programId, seasonId, game.roundNumber, game.homeTeamId, game.awayTeamId, game.startsAt, game.fieldName),
    );
  });
  await env.DB.batch(statements);
  await audit(env, context, "schedule.version.created", "schedule_version", versionId, programId, { gamesPerTeam, gameCount: games.length, conflicts });
  const response = await getSchedule(env, context, versionId);
  if (response.status === 200) {
    const data = await response.json();
    data.conflicts = conflicts;
    return json(data);
  }
  return response;
}

async function publishSchedule(request, env, context, versionId) {
  const version = await env.DB.prepare("SELECT * FROM schedule_versions WHERE id = ? LIMIT 1").bind(versionId).first();
  if (!version) return json({ ok: false, error: "Schedule version not found" }, 404);
  if (!canManageProgram(context, version.program_id)) return denied("Schedule publication denied");
  if (version.status !== "draft") return json({ ok: false, error: "Only draft schedules can be published." }, 409);
  const games = await env.DB.prepare("SELECT * FROM schedule_games WHERE version_id = ?").bind(versionId).all();
  const conflicts = scheduleConflicts((games.results || []).map((game) => ({
    homeTeamId: game.home_team_id,
    awayTeamId: game.away_team_id,
    startsAt: game.starts_at,
    fieldName: game.field_name,
  })));
  if (conflicts.length) return json({ ok: false, error: "Resolve schedule conflicts before publishing.", conflicts }, 409);
  await env.DB.batch([
    env.DB.prepare("UPDATE schedule_versions SET status = 'archived' WHERE program_id = ? AND season_id = ? AND status = 'published'").bind(version.program_id, version.season_id),
    env.DB.prepare("UPDATE schedule_versions SET status = 'published', published_at = datetime('now') WHERE id = ?").bind(versionId),
  ]);
  await audit(env, context, "schedule.version.published", "schedule_version", versionId, version.program_id);
  return getSchedule(env, context, versionId);
}

async function recordGameResult(request, env, context, versionId, gameId) {
  const game = await env.DB.prepare(
    "SELECT sg.*, sv.status AS version_status FROM schedule_games sg JOIN schedule_versions sv ON sv.id = sg.version_id WHERE sg.id = ? AND sg.version_id = ? LIMIT 1",
  ).bind(gameId, versionId).first();
  if (!game) return json({ ok: false, error: "Game not found" }, 404);
  if (!canRecordGameResult(context, game.program_id, game.home_team_id) && !canRecordGameResult(context, game.program_id, game.away_team_id)) return denied("Game result access denied");
  const payload = await request.json().catch(() => null);
  const homeScore = Math.max(0, Number(payload?.homeScore || 0));
  const awayScore = Math.max(0, Number(payload?.awayScore || 0));
  await env.DB.prepare(
    "INSERT INTO game_results (id, game_id, home_score, away_score, notes, entered_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(game_id) DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score, notes = excluded.notes, entered_by = excluded.entered_by, entered_at = datetime('now')",
  ).bind(crypto.randomUUID(), gameId, homeScore, awayScore, text(payload?.notes) || null, context.user.id).run();
  await env.DB.prepare("UPDATE schedule_games SET status = 'played' WHERE id = ?").bind(gameId).run();
  await audit(env, context, "game.result.recorded", "schedule_game", gameId, game.program_id, { homeScore, awayScore });
  return getSchedule(env, context, versionId);
}

async function listAttendance(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  const seasonId = text(url.searchParams.get("seasonId"));
  const teamId = text(url.searchParams.get("teamId"));
  const date = text(url.searchParams.get("date")) || new Date().toISOString().slice(0, 10);
  if (!programId || !seasonId || !teamId || !canAccessTeam(context, programId, teamId)) return denied("Attendance access denied");
  const team = await env.DB.prepare("SELECT id, name, status FROM roster_teams WHERE id = ? AND program_id = ? AND season_id = ? LIMIT 1").bind(teamId, programId, seasonId).first();
  if (!team) return json({ ok: false, error: "Team not found" }, 404);
  const rows = await env.DB.prepare(
    "SELECT p.id AS participant_id, p.first_name, p.last_name, p.grade_or_age, COALESCE(ar.status, 'unrecorded') AS attendance_status, ar.note FROM registration_participants p JOIN registrations r ON r.id = p.registration_id LEFT JOIN attendance_records ar ON ar.participant_id = p.id AND ar.team_id = ? AND ar.attendance_date = ? AND ar.event_id IS NULL AND ar.game_id IS NULL WHERE p.league_team_id = ? AND r.program_id = ? AND r.status != 'withdrawn' ORDER BY p.last_name, p.first_name",
  ).bind(teamId, date, teamId, programId).all();
  return json({ ok: true, team, attendanceDate: date, players: rows.results || [] });
}

async function recordAttendance(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  const seasonId = text(payload?.seasonId);
  const teamId = text(payload?.teamId);
  const attendanceDate = text(payload?.attendanceDate) || new Date().toISOString().slice(0, 10);
  if (!programId || !seasonId || !teamId || !canAccessTeam(context, programId, teamId)) return denied("Attendance access denied");
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const validParticipants = await env.DB.prepare(
    "SELECT p.id FROM registration_participants p JOIN registrations r ON r.id = p.registration_id WHERE p.league_team_id = ? AND r.program_id = ? AND r.status != 'withdrawn'",
  ).bind(teamId, programId).all();
  const allowedIds = new Set((validParticipants.results || []).map((row) => row.id));
  for (const record of records) {
    if (!allowedIds.has(text(record.participantId))) continue;
    const status = ["present", "absent", "excused", "late"].includes(text(record.status)) ? text(record.status) : "present";
    const existing = await env.DB.prepare(
      "SELECT id FROM attendance_records WHERE team_id = ? AND participant_id = ? AND attendance_date = ? AND event_id IS NULL AND game_id IS NULL LIMIT 1",
    ).bind(teamId, record.participantId, attendanceDate).first();
    if (existing) {
      await env.DB.prepare("UPDATE attendance_records SET status = ?, note = ?, recorded_by = ?, updated_at = datetime('now') WHERE id = ?").bind(status, text(record.note) || null, context.user.id, existing.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO attendance_records (id, program_id, season_id, team_id, participant_id, attendance_date, status, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), programId, seasonId, teamId, record.participantId, attendanceDate, status, text(record.note) || null, context.user.id).run();
    }
  }
  await audit(env, context, "attendance.updated", "roster_team", teamId, programId, { attendanceDate, count: records.length });
  return listAttendance(new Request(request.url + "?programId=" + encodeURIComponent(programId) + "&seasonId=" + encodeURIComponent(seasonId) + "&teamId=" + encodeURIComponent(teamId) + "&date=" + encodeURIComponent(attendanceDate)), env, context);
}

async function listVolunteerDuties(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  const seasonId = text(url.searchParams.get("seasonId"));
  if (!programId || !canViewProgram(context, programId)) return denied();
  const manager = canManageProgram(context, programId);
  const values = [programId];
  let where = "vd.program_id = ?";
  if (seasonId) {
    where += " AND (vd.season_id = ? OR vd.season_id IS NULL)";
    values.push(seasonId);
  }
  if (!manager) {
    where += " AND vd.admin_user_id = ?";
    values.push(context.user.id);
  }
  const rows = await env.DB.prepare(
    "SELECT vd.*, u.email, u.display_name, rt.name AS team_name FROM volunteer_duties vd JOIN admin_users u ON u.id = vd.admin_user_id LEFT JOIN roster_teams rt ON rt.id = vd.team_id WHERE " + where + " ORDER BY COALESCE(vd.starts_at, vd.created_at), u.display_name",
  ).bind(...values).all();
  return json({ ok: true, duties: rows.results || [] });
}

async function createVolunteerDuty(request, env, context) {
  const payload = await request.json().catch(() => null);
  const programId = text(payload?.programId);
  if (!programId || !canManageProgram(context, programId)) return denied("Volunteer duty management denied");
  const adminUserId = text(payload?.adminUserId);
  const dutyType = text(payload?.dutyType) || "other";
  if (!adminUserId || !["assistant_coach", "team_manager", "game_day", "field_coordinator", "check_in", "other"].includes(dutyType)) return json({ ok: false, error: "Volunteer and duty type are required" }, 400);
  const user = await env.DB.prepare("SELECT id, status FROM admin_users WHERE id = ? LIMIT 1").bind(adminUserId).first();
  if (!user || !["active", "invited"].includes(user.status)) return json({ ok: false, error: "Volunteer user is not available" }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO volunteer_duties (id, admin_user_id, program_id, season_id, team_id, event_id, duty_type, starts_at, ends_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, adminUserId, programId, text(payload?.seasonId) || null, text(payload?.teamId) || null, text(payload?.eventId) || null, dutyType, text(payload?.startsAt) || null, text(payload?.endsAt) || null, text(payload?.notes) || null, context.user.id).run();
  await audit(env, context, "volunteer.duty.created", "volunteer_duty", id, programId, { dutyType });
  return listVolunteerDuties(new Request(request.url + "?programId=" + encodeURIComponent(programId)), env, context);
}

async function updateVolunteerDuty(request, env, context, dutyId) {
  const duty = await env.DB.prepare("SELECT * FROM volunteer_duties WHERE id = ? LIMIT 1").bind(dutyId).first();
  if (!duty) return json({ ok: false, error: "Volunteer duty not found" }, 404);
  const manager = canManageProgram(context, duty.program_id);
  if (!manager && duty.admin_user_id !== context.user.id) return denied("Volunteer duty access denied");
  const payload = await request.json().catch(() => null);
  const status = text(payload?.status);
  if (!["assigned", "confirmed", "completed", "cancelled"].includes(status)) return json({ ok: false, error: "Invalid duty status" }, 400);
  await env.DB.prepare("UPDATE volunteer_duties SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, dutyId).run();
  await audit(env, context, "volunteer.duty.updated", "volunteer_duty", dutyId, duty.program_id, { status });
  return json({ ok: true });
}

async function operationsOverview(request, env, context) {
  const url = new URL(request.url);
  const programId = text(url.searchParams.get("programId"));
  const seasonId = text(url.searchParams.get("seasonId"));
  if (!programId || !seasonId || !canViewProgram(context, programId)) return denied();
  const teamSql = canManageTeams(context, programId)
    ? "SELECT id, name, status, league_format FROM roster_teams WHERE program_id = ? AND season_id = ? ORDER BY name"
    : "SELECT id, name, status, league_format FROM roster_teams WHERE program_id = ? AND season_id = ? AND id IN (SELECT team_id FROM admin_assignments WHERE admin_user_id = ? AND status = 'active' AND team_id IS NOT NULL)";
  const teamValues = canManageTeams(context, programId) ? [programId, seasonId] : [programId, seasonId, context.user.id];
  const [teams, schedules, duties] = await Promise.all([
    env.DB.prepare(teamSql).bind(...teamValues).all(),
    env.DB.prepare("SELECT id, status, games_per_team, created_at, published_at FROM schedule_versions WHERE program_id = ? AND season_id = ? ORDER BY created_at DESC").bind(programId, seasonId).all(),
    listVolunteerDuties(request, env, context).then((response) => response.json()).catch(() => ({ duties: [] })),
  ]);
  return json({ ok: true, teams: teams.results || [], schedules: schedules.results || [], duties: duties.duties || [], roles: [...roleIdsForProgram(context, programId)] });
}

async function handleOperationsApi(request, env, context) {
  const path = new URL(request.url).pathname;
  try {
    if (path === "/api/admin/operations" && request.method === "GET") return operationsOverview(request, env, context);
    if (path === "/api/admin/rosters" && request.method === "GET") return listRosters(request, env, context);
    if (path === "/api/admin/rosters/generate" && request.method === "POST") return generateRoster(request, env, context);
    if (path.startsWith("/api/admin/rosters/") && path.endsWith("/publish") && request.method === "POST") return publishRoster(request, env, context, decodeURIComponent(path.split("/")[4]));
    if (path.startsWith("/api/admin/rosters/") && path.endsWith("/lock") && request.method === "POST") return lockRoster(request, env, context, decodeURIComponent(path.split("/")[4]));
    if (path.startsWith("/api/admin/rosters/") && request.method === "GET") return getRosterGeneration(env, context, decodeURIComponent(path.split("/").pop()));
    if (path === "/api/admin/schedules" && request.method === "GET") return listSchedules(request, env, context);
    if (path === "/api/admin/schedules/generate" && request.method === "POST") return generateSchedule(request, env, context);
    if (path.startsWith("/api/admin/schedules/") && path.includes("/games/") && path.endsWith("/result") && request.method === "POST") {
      const parts = path.split("/");
      return recordGameResult(request, env, context, decodeURIComponent(parts[4]), decodeURIComponent(parts[6]));
    }
    if (path.startsWith("/api/admin/schedules/") && path.endsWith("/publish") && request.method === "POST") return publishSchedule(request, env, context, decodeURIComponent(path.split("/")[4]));
    if (path.startsWith("/api/admin/schedules/") && request.method === "GET") return getSchedule(env, context, decodeURIComponent(path.split("/").pop()));
    if (path === "/api/admin/attendance" && request.method === "GET") return listAttendance(request, env, context);
    if (path === "/api/admin/attendance" && request.method === "POST") return recordAttendance(request, env, context);
    if (path === "/api/admin/volunteer-duties" && request.method === "GET") return listVolunteerDuties(request, env, context);
    if (path === "/api/admin/volunteer-duties" && request.method === "POST") return createVolunteerDuty(request, env, context);
    if (path.startsWith("/api/admin/volunteer-duties/") && request.method === "PATCH") return updateVolunteerDuty(request, env, context, decodeURIComponent(path.split("/").pop()));
    return json({ ok: false, error: "Operations endpoint not found" }, 404);
  } catch (error) {
    console.error("operations-api-failed", error);
    return json({ ok: false, error: "Operations request failed" }, 500);
  }
}

export { handleOperationsApi };
