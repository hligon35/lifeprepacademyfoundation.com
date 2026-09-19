(() => {
  "use strict";

  const PROGRAM_ID = "paducah-go-soccer-league";
  const $ = (selector) => document.querySelector(selector);
  const state = {
    session: null,
    workspace: null,
    announcements: [],
    assignments: [],
    directory: [],
    activity: [],
    view: "dashboard",
    seasonId: "",
    canManage: false
  };

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[character]));

  const api = async (path, options = {}) => {
    const response = await fetch(path, Object.assign({ credentials: "include" }, options));
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      throw new Error(payload && payload.error ? payload.error : "Request failed");
    }
    return payload;
  };

  const formatDate = (value) => {
    if (!value) return "—";
    const parsed = new Date(String(value).replace(" ", "T") + (String(value).endsWith("Z") ? "" : "Z"));
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  };

  const formatDay = (value) => {
    if (!value) return "—";
    const parsed = new Date(String(value) + "T00:00:00");
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString([], { dateStyle: "medium" });
  };

  const showNotice = (message) => {
    const node = $("#notice");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("show", Boolean(message));
    if (message) window.setTimeout(() => {
      if (node.textContent === message) {
        node.textContent = "";
        node.classList.remove("show");
      }
    }, 5000);
  };

  const showAccessRequired = (message) => {
    $("#admin-shell").hidden = true;
    $("#access-required").hidden = false;
    $("#access-message").textContent = message || "Cloudflare Access authentication is required.";
    const status = $("#access-status");
    status.textContent = "Access required";
    status.className = "status status-bad";
  };

  const roleIds = () => {
    if (state.session && state.session.isSuperAdmin) return ["super_admin"];
    return (state.session && state.session.roles || [])
      .filter((role) => role.program_id === PROGRAM_ID)
      .map((role) => role.id);
  };

  const canManageProgram = () => state.session && (
    state.session.isSuperAdmin ||
    roleIds().includes("program_administrator")
  );

  const pageHead = (eyebrow, title, description, action) =>
    '<div class="page-head"><div><p class="eyebrow">' + esc(eyebrow) + "</p><h1>" +
    esc(title) + "</h1><p>" + esc(description) + "</p></div>" + (action || "") + "</div>";

  const button = (label, id, className) =>
    '<button class="button ' + (className || "button-quiet") + '" type="button" id="' + esc(id) + '">' + esc(label) + "</button>";

  const empty = (title, message) =>
    '<div class="empty"><strong>' + esc(title) + "</strong><p>" + esc(message) + "</p></div>";

  const currentSeason = () => state.workspace && state.workspace.season;
  const seasonOptions = () => (state.workspace && state.workspace.seasons || [])
    .map((season) => '<option value="' + esc(season.id) + '"' + (season.id === state.seasonId ? " selected" : "") + ">" + esc(season.name) + "</option>")
    .join("");

  function setActiveNav() {
    document.querySelectorAll("[data-view]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.view === state.view);
    });
  }

  function setView(view, push) {
    state.view = view || "dashboard";
    setActiveNav();
    if (push) history.pushState({}, "", location.pathname + "#" + state.view);
    renderView().catch((error) => {
      $("#view").innerHTML = '<div class="error"><strong>Unable to load this view</strong><p>' + esc(error.message) + "</p></div>";
    });
  }

  function renderMetrics(metrics) {
    const values = [
      ["Registrations", metrics.registrations || 0],
      ["Submitted", metrics.submitted || 0],
      ["Complete", metrics.paid || 0],
      ["Teams", metrics.teams || 0],
      ["Announcements", metrics.activeAnnouncements || 0]
    ];
    return '<div class="metric-grid">' + values.map((item) =>
      '<div class="metric"><span>' + esc(item[0]) + "</span><strong>" + esc(item[1]) + "</strong></div>"
    ).join("") + "</div>";
  }

  function announcementStatus(announcement) {
    return '<span class="pill pill-' + esc(announcement.status) + '">' + esc(announcement.status) + "</span>";
  }

  function renderDashboard() {
    const workspace = state.workspace;
    const settings = workspace.registration && workspace.registration.settings || {};
    const status = settings.registrationStatus === "open" ? "open" : "closed";
    const hero = state.announcements.find((item) => item.status === "published" && Number(item.show_in_hero) === 1);
    const heroMarkup = hero
      ? '<div class="announcement"><div><h3>' + esc(hero.title) + "</h3><p>" + esc(hero.body) + '</p><div class="announcement-meta">' + announcementStatus(hero) + " · " + esc(hero.audience_type) + "</div></div><div class=\"announcement-side\"><small>" + formatDate(hero.published_at || hero.created_at) + "</small></div></div>"
      : empty("No hero announcement", "Publish a program, season, or team announcement and choose “Show in hero” to place it on the staff dashboard.");
    $("#view").innerHTML =
      pageHead("Paducah GO Soccer", "League operations dashboard", "Monitor the selected season, registration activity, staff assignments, and communication from one workspace.", button("Refresh data", "refresh-dashboard", "button-quiet")) +
      renderMetrics(workspace.metrics || {}) +
      '<div class="grid">' +
        '<section class="card span-8 hero"><p class="eyebrow">Current season</p><h2>' + esc(workspace.season ? workspace.season.name : "No season selected") + "</h2><p>" +
          (workspace.season ? esc(formatDay(workspace.season.starts_on) + " – " + formatDay(workspace.season.ends_on)) : "Create a season to start organizing league operations.") +
          '</p><div class="actions">' + button("Manage registration", "open-registration", "button-gold") + button("Review registrants", "open-registrants", "button-quiet") + "</div></section>" +
        '<section class="card span-4"><div class="section-head"><h2>Registration</h2>' + (status === "open" ? '<span class="pill pill-open">Open</span>' : '<span class="pill pill-closed">Closed</span>') + "</div>" +
          '<div class="status-card"><div><strong>' + esc(status === "open" ? "Accepting new registrations" : "Not accepting public registrations") + "</strong><span class=\"muted\">" + esc(workspace.registration.submittedCount || 0) + " submitted · " + esc(workspace.registration.activeDrafts || 0) + " active drafts</span></div>" +
          (canManageProgram() ? button(status === "open" ? "Close registration" : "Open registration", "toggle-registration", status === "open" ? "button-danger" : "button-gold") : "") + "</div></section>" +
        '<section class="card span-6"><div class="section-head"><h2>Hero announcement</h2>' + button("Manage", "open-announcements", "button-quiet") + "</div>" + heroMarkup + "</section>" +
        '<section class="card span-6"><div class="section-head"><h2>Next operating actions</h2></div><div class="activity-list">' +
          '<div class="activity"><strong>Team placement</strong><div class="activity-meta">Phase Two will add the balanced team recommendation workflow.</div></div>' +
          '<div class="activity"><strong>Schedule generation</strong><div class="activity-meta">Season rules are stored now for the schedule engine.</div></div>' +
          '<div class="activity"><strong>Staff coverage</strong><div class="activity-meta">' + esc(workspace.metrics.staffAssignments || 0) + " active assignment(s) in this program.</div></div>" +
        "</div></section>" +
      "</div>";
    $("#refresh-dashboard").onclick = () => loadWorkspace(true);
    $("#open-registration").onclick = () => setView("registration", true);
    $("#open-registrants").onclick = () => setView("registrants", true);
    $("#open-announcements").onclick = () => setView("announcements", true);
    $("#toggle-registration") && ($("#toggle-registration").onclick = toggleRegistration);
  }

  function renderRegistration() {
    const settings = state.workspace.registration && state.workspace.registration.settings || {};
    const status = settings.registrationStatus === "open" ? "open" : "closed";
    const managed = canManageProgram();
    $("#view").innerHTML =
      pageHead("Season operations", "Registration control", "This server-side control governs the public Paducah GO registration pages while preserving draft-resume and private-access behavior.", managed ? button(status === "open" ? "Close registration" : "Open registration", "toggle-registration-page", status === "open" ? "button-danger" : "button-gold") : "") +
      '<div class="grid">' +
        '<section class="card span-6"><div class="section-head"><h2>Public registration</h2>' + (status === "open" ? '<span class="pill pill-open">Open</span>' : '<span class="pill pill-closed">Closed</span>') + "</div>" +
          '<p>' + esc(status === "open" ? "Families can begin new registrations." : "New public registrations are blocked. Existing draft or private links follow their configured rules.") + "</p>" +
          '<div class="status-card"><div><strong>Current status</strong><span class="muted">Updated ' + esc(formatDate(settings.updatedAt)) + '</span></div><strong>' + esc(status.toUpperCase()) + '</strong></div>' +
        "</section>" +
        '<section class="card span-6"><h2>Current controls</h2><div class="activity-list">' +
          '<div class="activity"><strong>Draft resume</strong><div class="activity-meta">' + esc(settings.allowDraftResume ? "Allowed for eligible saved registrations." : "Disabled.") + "</div></div>" +
          '<div class="activity"><strong>Private access</strong><div class="activity-meta">' + esc(settings.allowPrivateAccess ? "Enabled for authorized links." : "Disabled.") + "</div></div>" +
          '<div class="activity"><strong>Reopen date</strong><div class="activity-meta">' + esc(settings.reopensAt ? formatDate(settings.reopensAt) : "Not scheduled") + "</div></div>" +
        "</div></section>" +
        '<section class="card span-12"><h2>Registration pipeline</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Status</th><th>Count</th><th>Meaning</th></tr></thead><tbody>' +
          Object.entries(state.workspace.registrationsByStatus || {}).map((item) => "<tr><td>" + esc(item[0]) + "</td><td>" + esc(item[1]) + "</td><td class=\"muted\">" + esc(statusDescription(item[0])) + "</td></tr>").join("") +
        "</tbody></table></div></section>" +
      "</div>";
    $("#toggle-registration-page") && ($("#toggle-registration-page").onclick = toggleRegistration);
  }

  function statusDescription(status) {
    return ({
      incomplete: "Started but not submitted.",
      submitted: "Submitted and awaiting review.",
      scholarship_pending: "Scholarship review is pending.",
      agreement_pending: "Agreement completion is pending.",
      payment_pending: "Payment is pending.",
      complete: "Completed registration.",
      withdrawn: "Withdrawn from the season."
    }[status] || "Registration record.");
  }

  async function loadRegistrants() {
    const status = $("#registrant-status") ? $("#registrant-status").value : "all";
    const search = $("#registrant-search") ? $("#registrant-search").value.trim() : "";
    const payload = await api("/api/admin/registrants?programId=" + encodeURIComponent(PROGRAM_ID) + "&status=" + encodeURIComponent(status) + "&search=" + encodeURIComponent(search));
    state.registrants = payload.registrants || [];
    const list = $("#registrant-list");
    if (!list) return;
    if (!state.registrants.length) {
      list.innerHTML = empty("No registrants found", "Try another status or search term.");
      return;
    }
    list.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Family</th><th>Player(s)</th><th>Status</th><th>Payment</th><th>Agreement</th><th>Submitted</th></tr></thead><tbody>' +
      state.registrants.map((row) => "<tr><td><strong>" + esc((row.parent_first_name || "") + " " + (row.parent_last_name || "")) + "</strong><br><span class=\"muted\">" + esc(row.parent_email) + "</span></td><td>" + esc(row.participant_names || "—") + "</td><td>" + esc(row.status) + "</td><td>" + esc(row.payment_status || "unpaid") + "</td><td>" + esc(row.agreement_status || "pending") + "</td><td>" + esc(formatDate(row.submitted_at || row.created_at)) + "</td></tr>").join("") +
      "</tbody></table></div>";
  }

  async function renderRegistrants() {
    $("#view").innerHTML =
      pageHead("People", "Registrants", "Review the registration pipeline for the selected Paducah GO program. Sensitive fields remain server-authorized and are not exposed to coaches or volunteers.", "") +
      '<section class="card span-12"><div class="toolbar"><input class="form-control" id="registrant-search" placeholder="Search family or player"><select class="form-control" id="registrant-status"><option value="all">All statuses</option><option value="submitted">Submitted</option><option value="payment_pending">Payment pending</option><option value="complete">Complete</option><option value="withdrawn">Withdrawn</option></select>' +
      button("Search", "search-registrants", "button-quiet") + "</div><div id=\"registrant-list\"><div class=\"loading\">Loading registrants…</div></div></section>";
    $("#search-registrants").onclick = () => loadRegistrants().catch((error) => showNotice(error.message));
    await loadRegistrants();
  }

  function renderSeasons() {
    const season = currentSeason();
    const settings = state.workspace.seasonSettings || {};
    $("#view").innerHTML =
      pageHead("Configuration", "Seasons", "Create and configure seasons without changing the existing public registration workflow.", canManageProgram() ? button("Create season", "create-season", "button-gold") : "") +
      '<div class="grid">' +
        '<section class="card span-6"><h2>Selected season</h2>' + (season ? '<div class="activity-list"><div class="activity"><strong>' + esc(season.name) + '</strong><div class="activity-meta">' + esc(season.status) + " · " + esc(formatDay(season.starts_on)) + " – " + esc(formatDay(season.ends_on)) + "</div></div><div class=\"activity\"><strong>Team placement target</strong><div class=\"activity-meta\">" + esc(settings.target_team_size || 10) + " players per team</div></div><div class=\"activity\"><strong>Games per team</strong><div class=\"activity-meta\">" + esc(settings.target_games_per_team || 8) + " scheduled games</div></div></div>" : empty("No season selected", "Create a season to establish the operating configuration.")) + "</section>" +
        '<section class="card span-6"><h2>Season rules</h2><p>These settings become inputs for the Phase Two team and schedule tools.</p><div class="activity-list"><div class="activity"><strong>Registration mode</strong><div class="activity-meta">' + esc(settings.registration_mode || "inherit") + "</div></div><div class=\"activity\"><strong>Team generation</strong><div class=\"activity-meta\">" + esc(settings.generation_status || "not_started") + "</div></div></div></section>" +
      "</div>";
    $("#create-season") && ($("#create-season").onclick = showSeasonForm);
  }

  function showSeasonForm() {
    $("#view").insertAdjacentHTML("beforeend",
      '<section class="card span-12" id="season-form-card"><div class="section-head"><h2>Create season</h2></div><form id="season-form" class="form-grid">' +
      '<div class="field"><label for="season-name">Name</label><input class="form-control" id="season-name" required placeholder="2027 Spring Season"></div>' +
      '<div class="field"><label for="season-status">Status</label><select class="form-control" id="season-status"><option value="upcoming">Upcoming</option><option value="active">Active</option><option value="closed">Closed</option></select></div>' +
      '<div class="field"><label for="season-start">Starts</label><input class="form-control" id="season-start" type="date"></div>' +
      '<div class="field"><label for="season-end">Ends</label><input class="form-control" id="season-end" type="date"></div>' +
      '<div class="field"><label for="team-size">Target players per team</label><input class="form-control" id="team-size" type="number" min="2" max="30" value="10"></div>' +
      '<div class="field"><label for="games-per-team">Target games per team</label><input class="form-control" id="games-per-team" type="number" min="1" max="40" value="8"></div>' +
      '<div class="field full"><div class="actions">' + button("Save season", "save-season", "button-gold") + button("Cancel", "cancel-season", "button-outline") + "</div></div></form></section>");
    $("#cancel-season").onclick = () => $("#season-form-card").remove();
    $("#season-form").onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api("/api/admin/seasons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          programId: PROGRAM_ID,
          name: $("#season-name").value,
          status: $("#season-status").value,
          startsOn: $("#season-start").value,
          endsOn: $("#season-end").value,
          targetTeamSize: Number($("#team-size").value),
          targetGamesPerTeam: Number($("#games-per-team").value)
        })});
        showNotice("Season created.");
        await loadWorkspace(false);
        setView("seasons", false);
      } catch (error) { showNotice(error.message); }
    };
  }

  async function loadAnnouncements() {
    const payload = await api("/api/admin/announcements?programId=" + encodeURIComponent(PROGRAM_ID) + "&seasonId=" + encodeURIComponent(state.seasonId || ""));
    state.announcements = payload.announcements || [];
  }

  async function renderAnnouncements() {
    await loadAnnouncements();
    const list = state.announcements.length
      ? '<div class="announcement-list">' + state.announcements.map((item) =>
        '<article class="announcement"><div><h3>' + esc(item.title) + " " + announcementStatus(item) + "</h3><p>" + esc(item.body) + '</p><div class="announcement-meta">' + esc(item.audience_type) + " · priority " + esc(item.priority) + " · " + esc(formatDate(item.created_at)) + (Number(item.show_in_hero) === 1 ? " · hero" : "") + "</div></div><div class=\"announcement-side\">" +
        (canManageProgram() ? '<button class="button button-quiet" data-announcement-action="publish" data-announcement-id="' + esc(item.id) + '" type="button">Publish</button><button class="button button-danger" data-announcement-action="archive" data-announcement-id="' + esc(item.id) + '" type="button">Archive</button>' : "") +
        "</div></article>"
      ).join("") + "</div>"
      : empty("No announcements yet", "Create the first program or season announcement.");
    $("#view").innerHTML =
      pageHead("Communication", "Announcements", "Broadcast updates to the program, current season, staff, or a team. Hero messages are shown on the staff dashboard.", "") +
      '<div class="grid"><section class="card span-6"><h2>Create announcement</h2><form id="announcement-form" class="form-grid">' +
        '<div class="field full"><label for="announcement-title">Title</label><input class="form-control" id="announcement-title" required maxlength="160"></div>' +
        '<div class="field full"><label for="announcement-body">Message</label><textarea class="form-control" id="announcement-body" required maxlength="4000"></textarea></div>' +
        '<div class="field"><label for="announcement-audience">Audience</label><select class="form-control" id="announcement-audience"><option value="program">Entire program</option><option value="season">Selected season</option><option value="staff">Staff only</option><option value="team">Specific team</option></select></div>' +
        '<div class="field"><label for="announcement-status">Status</label><select class="form-control" id="announcement-status"><option value="draft">Draft</option><option value="published">Publish now</option><option value="scheduled">Scheduled</option></select></div>' +
        '<div class="field"><label for="announcement-priority">Priority</label><select class="form-control" id="announcement-priority"><option value="0">Normal</option><option value="1">Important</option><option value="2">High</option><option value="3">Urgent</option></select></div>' +
        '<div class="field"><label for="announcement-audience-id">Audience ID (optional)</label><input class="form-control" id="announcement-audience-id" placeholder="Team or division ID"></div>' +
        '<div class="field full"><label class="checkbox"><input type="checkbox" id="announcement-hero"> Show in dashboard hero</label></div>' +
        '<div class="field full"><div class="actions">' + button("Save announcement", "save-announcement", "button-gold") + "</div></div></form></section>" +
        '<section class="card span-6"><h2>Published and draft messages</h2>' + list + "</section></div>";
    $("#announcement-form").onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api("/api/admin/announcements?programId=" + encodeURIComponent(PROGRAM_ID), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          title: $("#announcement-title").value,
          body: $("#announcement-body").value,
          seasonId: state.seasonId || null,
          audienceType: $("#announcement-audience").value,
          audienceId: $("#announcement-audience-id").value,
          priority: Number($("#announcement-priority").value),
          showInHero: $("#announcement-hero").checked,
          status: $("#announcement-status").value
        })});
        showNotice("Announcement saved.");
        await loadAnnouncements();
        renderAnnouncements();
      } catch (error) { showNotice(error.message); }
    };
    document.querySelectorAll("[data-announcement-action]").forEach((item) => {
      item.onclick = () => updateAnnouncement(item.dataset.announcementId, item.dataset.announcementAction);
    });
  }

  async function updateAnnouncement(id, action) {
    const current = state.announcements.find((item) => item.id === id);
    if (!current) return;
    try {
      await api("/api/admin/announcements/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        title: current.title,
        body: current.body,
        seasonId: current.season_id,
        audienceType: current.audience_type,
        audienceId: current.audience_id,
        priority: current.priority,
        showInHero: Number(current.show_in_hero) === 1,
        status: action === "publish" ? "published" : "archived"
      })});
      showNotice(action === "publish" ? "Announcement published." : "Announcement archived.");
      await renderAnnouncements();
    } catch (error) { showNotice(error.message); }
  }

  async function loadStaff() {
    const payload = await api("/api/admin/staff/assignments?programId=" + encodeURIComponent(PROGRAM_ID));
    state.assignments = payload.assignments || [];
    state.directory = payload.directory || [];
  }

  async function renderStaff() {
    await loadStaff();
    const assignmentList = state.assignments.length
      ? '<div class="assignment-list">' + state.assignments.map((item) =>
        '<div class="assignment"><div><strong>' + esc(item.display_name || item.email) + "</strong><div class=\"assignment-meta\">" + esc(item.role_name) + " · " + esc(item.scope_type) + (item.season_name ? " · " + esc(item.season_name) : "") + " · " + esc(item.email) + "</div></div>" +
        (canManageProgram() ? '<button class="button button-danger" data-remove-assignment="' + esc(item.id) + '" type="button">Remove</button>' : "") + "</div>"
      ).join("") + "</div>"
      : empty("No scoped assignments", "Assign a league administrator, coach, volunteer, or reviewer to this program.");
    const directory = state.directory.map((item) => '<option value="' + esc(item.id) + '">' + esc(item.display_name || item.email) + " · " + esc(item.email) + "</option>").join("");
    $("#view").innerHTML =
      pageHead("People & permissions", "Staff and assignments", "Assign access by program or season. Team-scoped assignments are ready for the roster phase.", "") +
      '<div class="grid"><section class="card span-5"><h2>Assign staff</h2>' + (canManageProgram() ? '<form id="staff-form" class="form-grid"><div class="field full"><label for="staff-user">Staff user</label><select class="form-control" id="staff-user" required><option value="">Choose a user</option>' + directory + "</select></div>" +
        '<div class="field"><label for="staff-role">Role</label><select class="form-control" id="staff-role"><option value="program_administrator">League Admin</option><option value="registration_manager">Registration Manager</option><option value="roster_manager">Roster Manager</option><option value="coach">Coach</option><option value="volunteer">Volunteer</option><option value="read_only_reviewer">Read-only Reviewer</option></select></div>' +
        '<div class="field"><label for="staff-scope">Scope</label><select class="form-control" id="staff-scope"><option value="program">Program</option><option value="season">Season</option><option value="team">Team</option></select></div>' +
        '<div class="field"><label for="staff-season">Season</label><select class="form-control" id="staff-season"><option value="">None</option>' + seasonOptions() + "</select></div>" +
        '<div class="field"><label for="staff-team">Team ID</label><input class="form-control" id="staff-team" placeholder="For Phase Two team scope"></div>' +
        '<div class="field full"><label for="staff-expires">Expires</label><input class="form-control" id="staff-expires" type="date"></div>' +
        '<div class="field full"><div class="actions">' + button("Save assignment", "save-staff", "button-gold") + "</div></div></form>" : '<p class=\"muted\">Only a super admin or league admin can assign staff.</p>') + "</section>" +
      '<section class="card span-7"><h2>Active assignments</h2>' + assignmentList + "</section></div>";
    $("#staff-form") && ($("#staff-form").onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api("/api/admin/staff/assignments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          programId: PROGRAM_ID,
          adminUserId: $("#staff-user").value,
          roleId: $("#staff-role").value,
          scopeType: $("#staff-scope").value,
          seasonId: $("#staff-season").value || null,
          teamId: $("#staff-team").value,
          expiresAt: $("#staff-expires").value || null
        })});
        showNotice("Staff assignment saved.");
        renderStaff();
      } catch (error) { showNotice(error.message); }
    });
    document.querySelectorAll("[data-remove-assignment]").forEach((item) => {
      item.onclick = async () => {
        try {
          await api("/api/admin/staff/assignments/" + encodeURIComponent(item.dataset.removeAssignment), { method: "DELETE" });
          showNotice("Assignment removed.");
          renderStaff();
        } catch (error) { showNotice(error.message); }
      };
    });
  }

  async function renderActivity() {
    const payload = await api("/api/admin/activity-log?programId=" + encodeURIComponent(PROGRAM_ID));
    state.activity = payload.entries || [];
    $("#view").innerHTML =
      pageHead("Accountability", "Activity log", "Review important program configuration, communication, and staff assignment changes.", "") +
      '<section class="card span-12"><div class="activity-list">' +
      (state.activity.length ? state.activity.map((item) => '<div class="activity"><strong>' + esc(item.action) + '</strong><div class="activity-meta">' + esc(item.actor_name) + " · " + esc(item.entity_type) + " · " + esc(formatDate(item.created_at)) + '</div><div class="muted">' + esc(item.metadata_json || "") + "</div></div>").join("") : empty("No activity yet", "Changes made through the Phase One console will appear here.")) +
      "</div></section>";
  }

  async function renderView() {
    setActiveNav();
    if (!state.workspace) return;
    if (state.view === "dashboard") return renderDashboard();
    if (state.view === "registration") return renderRegistration();
    if (state.view === "registrants") return renderRegistrants();
    if (state.view === "seasons") return renderSeasons();
    if (state.view === "announcements") return renderAnnouncements();
    if (state.view === "staff") return renderStaff();
    if (state.view === "activity") return renderActivity();
    state.view = "dashboard";
    return renderDashboard();
  }

  async function loadWorkspace(refreshAnnouncements) {
    const query = "/api/admin/program-workspace?programId=" + encodeURIComponent(PROGRAM_ID) + "&seasonId=" + encodeURIComponent(state.seasonId || "");
    state.workspace = await api(query);
    state.seasonId = state.workspace.season ? state.workspace.season.id : "";
    const select = $("#season-select");
    if (select) {
      select.innerHTML = seasonOptions();
      select.value = state.seasonId;
    }
    if (refreshAnnouncements !== false) {
      await loadAnnouncements().catch(() => {});
    }
    await renderView();
  }

  async function toggleRegistration() {
    const settings = state.workspace.registration && state.workspace.registration.settings || {};
    const next = settings.registrationStatus === "open" ? "closed" : "open";
    if (!window.confirm("Change Paducah GO public registration to " + next.toUpperCase() + "?")) return;
    try {
      await api("/api/admin/registration-status?programId=" + encodeURIComponent(PROGRAM_ID), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          registrationStatus: next,
          allowDraftResume: Boolean(settings.allowDraftResume),
          allowPrivateAccess: Boolean(settings.allowPrivateAccess),
          closedMessage: settings.closedMessage,
          publicMessage: settings.publicMessage,
          reopensAt: settings.reopensAt
        })
      });
      showNotice("Registration is now " + next + ".");
      await loadWorkspace(true);
    } catch (error) { showNotice(error.message); }
  }

  async function loadSession() {
    const payload = await api("/api/admin/session");
    state.session = payload;
    const status = $("#access-status");
    status.textContent = "Signed in: " + (payload.user && (payload.user.displayName || payload.user.email) || "admin");
    status.className = "status status-good";
    state.canManage = canManageProgram();
    $("#admin-shell").hidden = false;
    $("#access-required").hidden = true;
    const pathView = location.pathname.split("/").filter(Boolean).pop();
    const hashView = location.hash.replace("#", "");
    if (["dashboard", "registration", "registrants", "seasons", "announcements", "staff", "activity"].includes(hashView)) state.view = hashView;
    else if (["registration", "registrants", "seasons", "announcements", "staff", "activity"].includes(pathView)) state.view = pathView;
    document.querySelectorAll("[data-view]").forEach((item) => {
      item.addEventListener("click", () => setView(item.dataset.view, true));
    });
    $("#season-select").onchange = async () => {
      state.seasonId = $("#season-select").value;
      await loadWorkspace(true).catch((error) => showNotice(error.message));
    };
    window.addEventListener("popstate", () => {
      const next = location.hash.replace("#", "") || "dashboard";
      setView(next, false);
    });
    window.addEventListener("hashchange", () => {
      const next = location.hash.replace("#", "") || "dashboard";
      setView(next, false);
    });
  }

  $("#logout-button").onclick = () => {
    window.location.href = "/cdn-cgi/access/logout?returnTo=" + encodeURIComponent("https://lifeprepacademyfoundation.com/admin");
  };

  loadSession().then(() => loadWorkspace(true)).catch((error) => showAccessRequired(error.message));
})();
