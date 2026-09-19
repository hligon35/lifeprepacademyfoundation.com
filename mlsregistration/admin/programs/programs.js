(() => {
  const $ = (selector) => document.querySelector(selector);
  const isAppHost = location.hostname === "app.lifeprepacademyfoundation.com";
  const dashboardPath = isAppHost ? "/dashboard" : "/admin";
  const redirectToLogin = () => {
    if (!isAppHost) return window.location.href = dashboardPath;
    const loginUrl = new URL("/cdn-cgi/access/login", window.location.origin);
    loginUrl.searchParams.set("redirect_url", window.location.href);
    window.location.replace(loginUrl.toString());
  };
  fetch("/api/admin/session", { credentials: "include" }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      redirectToLogin();
      return;
    }
    const status = $("#admin-status");
    if (status) { status.textContent = `Signed in: ${payload.user?.displayName || payload.user?.email || "admin"}`; status.className = "status-pill status-pill--active"; }
  }).catch(() => { redirectToLogin(); });
  document.getElementById("admin-brand-link")?.setAttribute("href", dashboardPath);
  $("#logout-button")?.addEventListener("click", () => { window.location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${window.location.origin}${dashboardPath}`)}`; });
  document.querySelectorAll("[data-program-target]").forEach((link) => {
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const target = link.getAttribute("data-program-target");
      link.setAttribute("aria-busy", "true");
      try {
        const response = await fetch("/api/auth/access-exchange", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ targetHost: new URL(target).hostname }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.code) throw new Error(payload?.error || "handoff_failed");
        window.location.href = target + "/auth/handoff?code=" + encodeURIComponent(payload.code) + "&returnTo=%2Fadmin";
      } catch (error) {
        link.removeAttribute("aria-busy");
        window.location.href = target + "/admin";
      }
    });
  });
})();
