(() => {
  const $ = (selector) => document.querySelector(selector);
  const isAppHost = location.hostname === "app.lifeprepacademyfoundation.com";
  const dashboardPath = isAppHost ? "/dashboard" : "/admin";
  const showAccessRequired = (message, mode = "login") => {
    $("#auth-loading").hidden = true;
    $("#programs-content").hidden = true;
    $("#access-required").hidden = false;
    $("#access-message").textContent = message || "Cloudflare Access authentication is required.";
    $("#access-heading").textContent = mode === "forbidden" ? "Access not approved" : "Sign in to continue";
    $("#access-login-link").hidden = mode === "forbidden";
  };
  const redirectToLogin = () => {
    if (!isAppHost) return showAccessRequired("Cloudflare Access must approve this staff account before the Programs Dashboard can load.");
    const loginUrl = new URL("/cdn-cgi/access/login", window.location.origin);
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.set("auth_reason", "login");
    returnUrl.searchParams.set("auth_attempt", "1");
    loginUrl.searchParams.set("redirect_url", returnUrl.toString());
    window.location.replace(loginUrl.toString());
  };
  fetch("/api/admin/session", { credentials: "include" }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      if (response.status === 401 && isAppHost && !new URLSearchParams(window.location.search).has("auth_attempt")) redirectToLogin();
      else showAccessRequired(response.status === 403 ? (payload?.error || "Your Google account is recognized, but it is not approved for this dashboard.") : (payload?.error || "Secure authentication is required."), response.status === 403 ? "forbidden" : "login");
      return;
    }
    $("#auth-loading").hidden = true;
    $("#programs-content").hidden = false;
    const status = $("#admin-status");
    if (status) { status.textContent = `Signed in: ${payload.user?.displayName || payload.user?.email || "admin"}`; status.className = "status-pill status-pill--active"; }
  }).catch(() => { showAccessRequired("The secure admin service is unavailable. Try again after Cloudflare Access is configured."); });
  document.getElementById("admin-brand-link")?.setAttribute("href", dashboardPath);
  $("#access-login-link")?.setAttribute("href", dashboardPath);
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
