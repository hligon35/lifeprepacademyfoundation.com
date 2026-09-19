(() => {
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
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
  const updateProgram = async (programId, body) => {
    const response = await fetch("/api/admin/programs/" + encodeURIComponent(programId), {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Program update failed");
    renderPrograms(payload.programs || [], payload.isSuperAdmin);
  };
  const renderPrograms = (programs = [], isSuperAdmin = false) => {
    const grid = $("#program-grid");
    if (!grid) return;
    if (!programs.length) {
      grid.innerHTML = `<div class="empty-state"><p>No programs are assigned to this account yet.</p></div>`;
      return;
    }
    grid.innerHTML = programs.map((program, index) => {
      const host = String(program.host || "").trim();
      const target = host ? `https://${host}` : "";
      const status = program.status === "active" ? "Active" : program.status === "hidden" ? "Foundation setup" : "Inactive";
      const className = index === 0 ? "program-card--wide" : "";
      return `<article class="program-card ${className}">
        <img src="${esc(program.logo_url || "https://www.lifeprepacademyfoundation.com/icons/icon-192.png")}" alt="${esc(program.name)} logo" />
        <h2>${esc(program.name)}</h2><span class="program-card__status">${esc(status)}${program.is_configured ? "" : " · Not configured"}</span>
        ${target ? `<a class="program-card__open" href="${esc(`${target}/admin`)}" data-program-target="${esc(target)}">Open dashboard</a>` : "<span class=\"program-card__open is-disabled\">Host not configured</span>"}
        ${isSuperAdmin ? `<div class="program-card__controls" data-program-controls="${esc(program.id)}"><label>Status <select data-program-status="${esc(program.id)}"><option value="active"${program.status === "active" ? " selected" : ""}>Active</option><option value="inactive"${program.status === "inactive" ? " selected" : ""}>Inactive</option><option value="hidden"${program.status === "hidden" ? " selected" : ""}>Hidden</option></select></label><label><input type="checkbox" data-program-public="${esc(program.id)}"${Number(program.public_enabled) === 1 ? " checked" : ""}> Public hub enabled</label><label><input type="checkbox" data-program-registration="${esc(program.id)}"${Number(program.registration_enabled) === 1 ? " checked" : ""}> Registration enabled</label></div>` : ""}
      </article>`;
    }).join("");
    grid.querySelectorAll("[data-program-target]").forEach((link) => {
      link.addEventListener("click", async (event) => {
        const target = link.getAttribute("data-program-target");
        if (!target) { event.preventDefault(); return; }
        event.preventDefault();
        link.setAttribute("aria-busy", "true");
        try {
          const response = await fetch("/api/auth/access-exchange", {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" },
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
    grid.querySelectorAll("[data-program-status]").forEach((control) => control.addEventListener("change", () => updateProgram(control.dataset.programStatus, { status: control.value }).catch((error) => window.alert(error.message))));
    grid.querySelectorAll("[data-program-public]").forEach((control) => control.addEventListener("change", () => updateProgram(control.dataset.programPublic, { publicEnabled: control.checked }).catch((error) => window.alert(error.message))));
    grid.querySelectorAll("[data-program-registration]").forEach((control) => control.addEventListener("change", () => updateProgram(control.dataset.programRegistration, { registrationEnabled: control.checked }).catch((error) => window.alert(error.message))));
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
    renderPrograms(payload.programs || [], payload.isSuperAdmin);
    const status = $("#admin-status");
    if (status) { status.textContent = `Signed in: ${payload.user?.displayName || payload.user?.email || "admin"}`; status.className = "status-pill status-pill--active"; }
  }).catch(() => { showAccessRequired("The secure admin service is unavailable. Try again after Cloudflare Access is configured."); });
  document.getElementById("admin-brand-link")?.setAttribute("href", dashboardPath);
  $("#access-login-link")?.setAttribute("href", dashboardPath);
  $("#logout-button")?.addEventListener("click", () => { window.location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${window.location.origin}${dashboardPath}`)}`; });
})();
