(() => {
  const params = new URLSearchParams(window.location.search);
  const role = (params.get("role") || window.location.pathname.split("/").filter(Boolean).pop() || "parent").toLowerCase();
  const roleLabels = { parent: "Player / Parent", coach: "Coach", volunteer: "Volunteer" };
  const copy = {
    parent: "Your registration status, team information, schedule, and program updates will appear here.",
    coach: "Your assigned roster, schedule, uniform information, and coach resources will appear here.",
    volunteer: "Your volunteer assignments, schedule, forms, and program updates will appear here.",
  };
  document.querySelector("#pgs-role-label").textContent = roleLabels[role] || roleLabels.parent;
  document.querySelector("#pgs-dashboard-copy").textContent = copy[role] || copy.parent;
  document.querySelector("#pgs-greeting").textContent = `Welcome to Paducah GO Soccer`;
  document.querySelector("#pgs-participants").textContent = "Coming soon";
  document.querySelector("#pgs-registration-status").textContent = "Ready";
  document.querySelector("#pgs-logout")?.addEventListener("click", () => { window.location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(window.location.origin)}`; });
  const status = document.querySelector("#pgs-status");
  status.textContent = "Program app";
  status.className = "status-pill status-pill--active";
})();
