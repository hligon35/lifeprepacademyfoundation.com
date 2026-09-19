// Centralized Paducah GO route registry. Single source of truth for path -> access rules,
// so guards and navigation never have to duplicate role checks per component.
export const ROLE = {
  GUARDIAN: "guardian",
  PLAYER: "player",
  COACH: "coach",
  VOLUNTEER: "volunteer",
  STAFF: "staff", // program-admin role for this program
};

// access: "public" | "auth" (any authenticated user) | array of allowed roles.
export const ROUTES = [
  { path: "/", access: "public", view: "home", title: "Paducah GO Soccer League" },
  { path: "/season", access: "public", view: "season", title: "Season Info" },
  { path: "/register", access: "public", view: "register", title: "Register" },
  { path: "/schedule", access: "public", view: "schedule", title: "Schedule" },
  { path: "/shop", access: "public", view: "shop", title: "Shop" },
  { path: "/contact", access: "public", view: "contact", title: "Contact" },
  { path: "/about", access: "public", view: "about", title: "About" },
  { path: "/faq", access: "public", view: "faq", title: "FAQ" },

  { path: "/dashboard", access: "auth", view: "dashboard", title: "Dashboard" },
  { path: "/profile", access: "auth", view: "profile", title: "Profile" },
  { path: "/notifications", access: "auth", view: "notifications", title: "Notifications" },
  { path: "/messages", access: "auth", view: "messages", title: "Messages" },
  { path: "/programs", access: "auth", view: "programs", title: "Switch Program" },

  { path: "/family", access: [ROLE.GUARDIAN], view: "family", title: "Family" },
  { path: "/family/children", access: [ROLE.GUARDIAN], view: "familyChildren", title: "Children" },
  { path: "/family/registrations", access: [ROLE.GUARDIAN], view: "familyRegistrations", title: "Registrations" },
  { path: "/family/registrations/:registrationId", access: [ROLE.GUARDIAN], view: "familyRegistrationDetail", title: "Registration" },
  { path: "/family/payments", access: [ROLE.GUARDIAN], view: "familyPayments", title: "Payments" },
  { path: "/family/documents", access: [ROLE.GUARDIAN], view: "familyDocuments", title: "Documents" },
  { path: "/family/schedule", access: [ROLE.GUARDIAN], view: "familySchedule", title: "Family Schedule" },
  { path: "/family/orders", access: [ROLE.GUARDIAN], view: "familyOrders", title: "Orders" },
  { path: "/family/messages", access: [ROLE.GUARDIAN], view: "familyMessages", title: "Family Messages" },

  { path: "/player", access: [ROLE.PLAYER], view: "player", title: "Player Home" },
  { path: "/player/team", access: [ROLE.PLAYER], view: "playerTeam", title: "My Team" },
  { path: "/player/schedule", access: [ROLE.PLAYER], view: "playerSchedule", title: "Player Schedule" },
  { path: "/player/announcements", access: [ROLE.PLAYER], view: "playerAnnouncements", title: "Announcements" },
  { path: "/player/profile", access: [ROLE.PLAYER], view: "playerProfile", title: "Player Profile" },

  { path: "/coach", access: [ROLE.COACH], view: "coach", title: "Coach Home" },
  { path: "/coach/teams", access: [ROLE.COACH], view: "coachTeams", title: "My Teams" },
  { path: "/coach/teams/:teamId", access: [ROLE.COACH], view: "coachTeamDetail", title: "Team" },
  { path: "/coach/teams/:teamId/roster", access: [ROLE.COACH], view: "coachTeamRoster", title: "Roster" },
  { path: "/coach/teams/:teamId/schedule", access: [ROLE.COACH], view: "coachTeamSchedule", title: "Team Schedule" },
  { path: "/coach/teams/:teamId/announcements", access: [ROLE.COACH], view: "coachTeamAnnouncements", title: "Announcements" },
  { path: "/coach/teams/:teamId/messages", access: [ROLE.COACH], view: "coachTeamMessages", title: "Team Messages" },
  { path: "/coach/profile", access: [ROLE.COACH], view: "coachProfile", title: "Coach Profile" },

  { path: "/volunteer", access: [ROLE.VOLUNTEER], view: "volunteer", title: "Volunteer Home" },
  { path: "/volunteer/assignments", access: [ROLE.VOLUNTEER], view: "volunteerAssignments", title: "Assignments" },
  { path: "/volunteer/schedule", access: [ROLE.VOLUNTEER], view: "volunteerSchedule", title: "Volunteer Schedule" },
  { path: "/volunteer/announcements", access: [ROLE.VOLUNTEER], view: "volunteerAnnouncements", title: "Announcements" },
  { path: "/volunteer/messages", access: [ROLE.VOLUNTEER], view: "volunteerMessages", title: "Volunteer Messages" },

  { path: "/program-admin", access: [ROLE.STAFF], view: "programAdmin", title: "Program Admin" },
  { path: "/program-admin/registrations", access: [ROLE.STAFF], view: "programAdminRegistrations", title: "Registrations" },
  { path: "/program-admin/players", access: [ROLE.STAFF], view: "programAdminPlayers", title: "Players" },
  { path: "/program-admin/teams", access: [ROLE.STAFF], view: "programAdminTeams", title: "Teams" },
  { path: "/program-admin/coaches", access: [ROLE.STAFF], view: "programAdminCoaches", title: "Coaches" },
  { path: "/program-admin/volunteers", access: [ROLE.STAFF], view: "programAdminVolunteers", title: "Volunteers" },
  { path: "/program-admin/schedule", access: [ROLE.STAFF], view: "programAdminSchedule", title: "Schedule" },
  { path: "/program-admin/announcements", access: [ROLE.STAFF], view: "programAdminAnnouncements", title: "Announcements" },
  { path: "/program-admin/messages", access: [ROLE.STAFF], view: "programAdminMessages", title: "Program Messages" },
  { path: "/program-admin/settings", access: [ROLE.STAFF], view: "programAdminSettings", title: "Settings" },
];

// Legacy path -> canonical path redirects (kept so old links/bookmarks still work).
export const LEGACY_REDIRECTS = {
  "/parent": "/family",
  "/coach-home": "/coach",
  "/volunteer-home": "/volunteer",
};

function pathToMatcher(routePath) {
  const paramNames = [];
  const pattern = routePath
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}/?$`), paramNames };
}

const COMPILED_ROUTES = ROUTES.map((route) => ({ ...route, ...pathToMatcher(route.path) }));

// Resolves a pathname to its route definition + extracted params, or null if unmatched.
export function matchRoute(pathname) {
  const normalized = LEGACY_REDIRECTS[pathname] || pathname;
  for (const route of COMPILED_ROUTES) {
    const match = normalized.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, index) => {
        params[name] = match[index + 1];
      });
      return { route, params, redirectedFrom: normalized !== pathname ? pathname : null };
    }
  }
  return null;
}

export function isPublicRoute(route) {
  return route.access === "public";
}

export function routeAllowsRole(route, roles) {
  if (route.access === "public" || route.access === "auth") return true;
  return route.access.some((role) => roles.includes(role));
}
