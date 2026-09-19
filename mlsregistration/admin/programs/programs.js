(() => {
  const $ = (selector) => document.querySelector(selector);
  const isAppHost = location.hostname === "app.lifeprepacademyfoundation.com";
  const dashboardPath = isAppHost ? "/dashboard" : "/admin";
  fetch("/api/admin/session", { credentials: "include" }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      window.location.href = `${dashboardPath}?reason=${encodeURIComponent(payload?.error || "Access required")}`;
      return;
    }
    const status = $("#admin-status");
    if (status) { status.textContent = `Signed in: ${payload.user?.displayName || payload.user?.email || "admin"}`; status.className = "status-pill status-pill--active"; }
  }).catch(() => { window.location.href = dashboardPath; });
  document.getElementById("admin-brand-link")?.setAttribute("href", dashboardPath);
  $("#logout-button")?.addEventListener("click", () => { window.location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${window.location.origin}${dashboardPath}`)}`; });
})();
