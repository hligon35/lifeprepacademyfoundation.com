// Master on/off switch for player registration. Flip to true and deploy to reopen.
// Keep in sync with the REGISTRATION_OPEN flag in mls-go.html.
const REGISTRATION_OPEN = false;

// Marks registration as closed unless the volunteer/coach flow is requested, or
// registration is open. Runs synchronously (no defer) so the class is set before
// first paint.
const registrationFlow = new URLSearchParams(window.location.search).get("flow");
const isPrivilegedFlow = registrationFlow === "volunteer" || registrationFlow === "coach";
if (!REGISTRATION_OPEN && !isPrivilegedFlow) {
  document.documentElement.classList.add("registration-is-closed");
}
