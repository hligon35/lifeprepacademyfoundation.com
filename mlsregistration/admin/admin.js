(() => {
  const state = { filter: "all" };
  const api = (path, options = {}) => fetch(path, { credentials: "include", ...options });
  const $ = (selector) => document.querySelector(selector);
  const isAppHost = location.hostname === "app.lifeprepacademyfoundation.com";
  const dashboardPath = isAppHost ? "/dashboard" : "/admin";
  const programsPath = isAppHost ? "/programs" : "/admin/programs";

  document.getElementById("admin-brand-link")?.setAttribute("href", dashboardPath);
  document.getElementById("open-programs-link")?.setAttribute("href", programsPath);
  document.getElementById("access-login-link")?.setAttribute("href", dashboardPath);

  function setAccessStatus(text, tone) {
    const el = $("#admin-status");
    if (!el) return;
    el.textContent = text;
    el.className = `status-pill status-pill--${tone}`;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"));
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function setAccessRequired(message) {
    $("#admin-dashboard").hidden = true;
    $("#access-required").hidden = false;
    if (message) $("#access-message").textContent = message;
    setAccessStatus("Access required", "error");
  }

  async function loadSession() {
    const response = await api("/api/admin/session");
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      setAccessRequired(payload?.error || "Cloudflare Access authentication is required.");
      return false;
    }
    setAccessStatus(`Signed in: ${payload.user?.displayName || payload.user?.email || "admin"}`, "active");
    $("#admin-dashboard").hidden = false;
    $("#access-required").hidden = true;
    return true;
  }

  function renderMetrics(metrics = {}) {
    $("#metric-registrations").textContent = metrics.registrationTotal ?? "0";
    $("#metric-paid").textContent = metrics.paidRegistrations ?? "0";
    $("#metric-submissions").textContent = metrics.submissionTotal ?? "0";
    $("#metric-unread").textContent = metrics.unreadSubmissions ?? "0";
  }

  function renderSubmissions(submissions = []) {
    const list = $("#submission-list");
    if (!submissions.length) {
      list.innerHTML = `<div class="empty-state"><p>No submissions match this filter.</p></div>`;
      return;
    }
    list.innerHTML = submissions.map((submission) => `
      <article class="submission-row ${submission.status === "new" ? "is-new" : ""}">
        <div><div class="submission-name">${escapeHtml(submission.name)}</div><div class="submission-meta">${escapeHtml(submission.email)}</div></div>
        <div><div class="submission-type">${escapeHtml(submission.form_type || "other")}</div><div class="submission-subject">${escapeHtml(submission.subject)}</div></div>
        <div class="submission-meta">${escapeHtml(formatDate(submission.created_at))}</div>
        <div class="submission-actions">${submission.status === "new" ? `<button class="button button--quiet" data-mark-read="${escapeHtml(submission.id)}" type="button">Mark read</button>` : `<span class="status-pill status-pill--active">${escapeHtml(submission.status)}</span>`}</div>
        <div class="submission-message">${escapeHtml(submission.message)}</div>
      </article>`).join("");
    list.querySelectorAll("[data-mark-read]").forEach((button) => button.addEventListener("click", () => updateSubmission(button.dataset.markRead, "read")));
  }

  async function loadInbox() {
    const message = $("#inbox-message");
    message.textContent = "Loading submissions…";
    const query = new URLSearchParams({ type: state.filter });
    const response = await api(`/api/admin/submissions?${query}`);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) { message.textContent = payload?.error || "Unable to load submissions."; return; }
    message.textContent = `${payload.submissions.length} submission${payload.submissions.length === 1 ? "" : "s"}`;
    renderSubmissions(payload.submissions);
  }

  async function updateSubmission(id, status) {
    const response = await api(`/api/admin/submissions/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (response.ok) await Promise.all([loadInbox(), loadAnalytics()]);
  }

  async function loadAnalytics() {
    const response = await api("/api/admin/analytics/overview");
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok) renderMetrics(payload.metrics);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  $("#logout-button")?.addEventListener("click", () => {
    window.location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${window.location.origin}${dashboardPath}`)}`;
  });
  $("#refresh-inbox")?.addEventListener("click", () => Promise.all([loadInbox(), loadAnalytics()]));
  document.querySelectorAll("[data-filter]").forEach((chip) => chip.addEventListener("click", () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === chip));
    loadInbox();
  }));

  loadSession().then((authenticated) => {
    if (!authenticated) return;
    loadInbox();
    loadAnalytics();
  }).catch(() => setAccessRequired("The secure admin service is unavailable. Try again after Cloudflare Access is configured."));
})();
