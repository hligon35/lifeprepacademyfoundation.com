(() => {
  const API_ORIGIN = window.location.origin;
  const STATUS_ENDPOINT = `${API_ORIGIN}/api/admin/registration-status`;

  const loadBtn = document.getElementById("load-settings-btn");
  const statusMessage = document.getElementById("status-message");
  const overviewCard = document.getElementById("overview-card");
  const settingsForm = document.getElementById("settings-form");
  const closeWarning = document.getElementById("close-warning");
  const confirmCheckbox = document.getElementById("confirm-change");
  const applyBtn = document.getElementById("apply-btn");

  const fields = {
    open: document.getElementById("status-open"),
    closed: document.getElementById("status-closed"),
    allowDraftResume: document.getElementById("allow-draft-resume"),
    allowPrivateAccess: document.getElementById("allow-private-access"),
    privateAccessToken: document.getElementById("private-access-token"),
    closedMessage: document.getElementById("closed-message"),
    reopensAt: document.getElementById("reopens-at"),
    actorLabel: document.getElementById("actor-label"),
  };

  let currentSettings = null;

  function setMessage(text, tone) {
    statusMessage.textContent = text || "";
    if (tone) statusMessage.setAttribute("data-tone", tone);
    else statusMessage.removeAttribute("data-tone");
  }

  function updateWarningAndButton() {
    closeWarning.hidden = !fields.closed.checked;
    applyBtn.disabled = !confirmCheckbox.checked;
  }

  fields.open.addEventListener("change", updateWarningAndButton);
  fields.closed.addEventListener("change", updateWarningAndButton);
  confirmCheckbox.addEventListener("change", updateWarningAndButton);

  function renderOverview(payload) {
    currentSettings = payload.settings;
    document.getElementById("ov-status").textContent =
      currentSettings.registrationStatus === "open" ? "Open" : "Closed";
    document.getElementById("ov-updated-by").textContent = currentSettings.updatedBy || "—";
    document.getElementById("ov-updated-at").textContent = currentSettings.updatedAt || "—";
    document.getElementById("ov-reopens-at").textContent = currentSettings.reopensAt || "Not scheduled";
    document.getElementById("ov-active-drafts").textContent = String(payload.activeDrafts ?? 0);
    document.getElementById("ov-submitted-count").textContent = String(payload.submittedCount ?? 0);

    fields.open.checked = currentSettings.registrationStatus === "open";
    fields.closed.checked = currentSettings.registrationStatus === "closed";
    fields.allowDraftResume.checked = Boolean(currentSettings.allowDraftResume);
    fields.allowPrivateAccess.checked = Boolean(currentSettings.allowPrivateAccess);
    fields.privateAccessToken.value = "";
    fields.closedMessage.value = currentSettings.closedMessage || "";
    fields.reopensAt.value = "";
    confirmCheckbox.checked = false;

    overviewCard.hidden = false;
    settingsForm.hidden = false;
    updateWarningAndButton();
  }

  async function loadSettings() {
    setMessage("Loading current settings…");
    try {
      const response = await fetch(STATUS_ENDPOINT, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        setMessage("Unauthorized. Check the token and try again.", "error");
        overviewCard.hidden = true;
        settingsForm.hidden = true;
        return;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `Request failed (${response.status})`);
      }
      renderOverview(payload);
      setMessage("Settings loaded.", "success");
    } catch (error) {
      setMessage(String(error?.message || "Failed to load settings."), "error");
    }
  }

  async function applyChange() {
    if (!confirmCheckbox.checked) {
      setMessage("Please confirm the change before applying it.", "error");
      return;
    }

    const body = {
      confirm: true,
      registrationStatus: fields.closed.checked ? "closed" : "open",
      allowDraftResume: fields.allowDraftResume.checked,
      allowPrivateAccess: fields.allowPrivateAccess.checked,
      closedMessage: fields.closedMessage.value,
      reopensAt: fields.reopensAt.value || null,
      actorLabel: fields.actorLabel.value || "unknown admin",
    };
    const newToken = String(fields.privateAccessToken.value || "").trim();
    if (newToken) body.newPrivateAccessToken = newToken;

    applyBtn.disabled = true;
    setMessage("Applying change…");
    try {
      const response = await fetch(STATUS_ENDPOINT, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `Request failed (${response.status})`);
      }
      setMessage("Registration settings updated.", "success");
      await loadSettings();
    } catch (error) {
      setMessage(String(error?.message || "Failed to apply change."), "error");
    } finally {
      updateWarningAndButton();
    }
  }

  loadBtn.addEventListener("click", loadSettings);
  applyBtn.addEventListener("click", applyChange);

  loadSettings();
})();
