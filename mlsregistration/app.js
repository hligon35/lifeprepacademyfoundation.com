(function () {
  const FORM_ACTION =
    "https://docs.google.com/forms/d/e/1FAIpQLScCUTOgeNb7shvYUrpjbNKn5kh_K_U3tEwks8aJ4zvbXFKWLw/formResponse";
  const FBZX = "-3891024944817654155";

  const GOOGLE_MAPS_API_KEY_META =
    document.querySelector('meta[name="google-maps-api-key"]')?.content.trim() || "";

  const APP_ORIGIN = window.location.origin;

  const API_ORIGIN =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
      ? ""
      : "https://mlsregistration.lifeprepacademyfoundation.com";

  const REGISTRATION_ASSET_ORIGIN =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
      ? APP_ORIGIN
      : "https://mlsregistration.lifeprepacademyfoundation.com";

  const FORM_UPSERT_ENDPOINT = `${API_ORIGIN}/api/forms/upsert`;
  const PUBLIC_CONFIG_ENDPOINT = `${API_ORIGIN}/api/public-config`;

  const GOOGLE_APPS_SCRIPT_URL =
    document.querySelector('meta[name="google-apps-script-url"]')?.content.trim() || "";

  const MLS_PLAYER_WAIVER_URL =
    "https://cdn.mediavalet.com/usca/rcx/ViZqxKaKCkOG_lY1tHVXHQ/0NjqRSjMNUKvGw1yBUgd4Q/Original/2.1%20Player%20Registration%20Agreement%20-%20MLS%20GO.pdf";

  const MLS_PRIVACY_POLICY_URL =
    "https://www.mlssoccer.com/legal/privacy-policy";

  const MLS_TERMS_OF_SERVICE_URL =
    "https://www.mlssoccer.com/legal/terms-of-service";

  const PPF_LIABILITY_FORM_URL =
    `${REGISTRATION_ASSET_ORIGIN}/documents/PPF%20Liability%20Form.pdf`;

  const PLAYER_AGREEMENT_TEMPLATE_URL =
    `${REGISTRATION_ASSET_ORIGIN}/documents/MLS%20GO%20Player%20Registration%20Agreement.pdf`;

  const VOLUNTEER_AGREEMENT_TEMPLATE_URL =
    `${REGISTRATION_ASSET_ORIGIN}/documents/MLS%20GO%20Volunteer%20Agreement.pdf`;

  const SIGNING_ENDPOINT = `${API_ORIGIN}/api/sign-agreement`;

  const E_CONSENT_TEXT_VERSION = "v1-2026-08-06";

  const ELECTRONIC_CONSENT_TEXT =
    "I have reviewed the complete agreement and agree to its terms. By checking this box and submitting, I consent to conduct this transaction electronically and intend this electronic acceptance to serve as my signature.";

  const REGISTRATION_FEE_AMOUNT_PER_PLAYER = 75;

  const PAYMENT_MODE_QUERY_PARAM = "paymentMode";
  const PAYMENT_MODE_DEFAULT = "redirect";
  const PAYMENT_MODE = resolvePaymentMode();
  const PAYMENT_PROVIDER = PAYMENT_MODE === "redirect" ? "quest" : "none";

  const PAYMENT_PAUSED_MESSAGE =
    "Payment is temporarily paused while we transition to a new payment provider. Your registration is saved, and we will email a secure payment link when the service is available.";

  const PAYMENT_REDIRECT_URL =
    "https://quest.build/get-tickets/1598/71794/info?teamId=686";

  const PAYMENT_REDIRECT_DELAY_MS = 1200;
  const SCHOLARSHIP_GUIDELINES_DOCUMENT_VERSION = "1.0";

  let pendingPaymentRedirectTimeoutId = null;
  let lastPaymentRedirectUrl = "";

  const ENABLE_GOOGLE_FORM_MIRROR = false;
  const FORM_UPSERT_TIMEOUT_MS = 30000;
  const FINAL_CONFIRMATION_TIMEOUT_MS = 30000;

  const FLOW = {
    PLAYER: "player",
    VOLUNTEER: "volunteer",
    COACH: "coach",
    VOLUNTEER_AND_COACH: "volunteerAndCoach",
    COMPLETE: "complete",
  };

  const HELP_OPTION = {
    NO: "no",
    VOLUNTEER: "volunteer",
    COACH: "coach",
    BOTH: "both",
  };

  const FlowLogic = window.MlsRegistrationFlowLogic;
  if (!FlowLogic) {
    throw new Error("MLS registration flow logic failed to load.");
  }

  const {
    STAGES,
    buildRequiredStages,
    buildThankYouContent,
    getFlowDescriptor,
    isScholarshipRequested,
    normalizeHelpChoice,
    normalizeStandaloneFlow,
  } = FlowLogic;

  const FINAL_CONFIRMATION_ENDPOINT = `${API_ORIGIN}/api/forms/final-confirmation`;
  const RESUME_CONTEXT_ENDPOINT = `${API_ORIGIN}/api/resume/context`;
  const RESUME_COMPLETE_ENDPOINT = `${API_ORIGIN}/api/resume/complete`;
  const RESUME_WITHDRAW_VERIFY_ENDPOINT = `${API_ORIGIN}/api/resume/withdraw/verify`;
  const RESUME_WITHDRAW_CONFIRM_ENDPOINT = `${API_ORIGIN}/api/resume/withdraw/confirm`;
  const STAGE_SECTION_IDS = Object.freeze({
    [STAGES.PLAYER_REGISTRATION]: [
      "parent-section",
      "emergency-section",
      "player-section-1",
      "player-section-2",
      "player-section-3",
      "player-section-4",
      "scholarship-section",
      "help-section",
    ],
    [STAGES.PLAYER_AGREEMENT]: ["agreements-section"],
    [STAGES.SCHOLARSHIP_APPLICATION]: ["scholarship-application-section"],
    [STAGES.VOLUNTEER_APPLICATION]: [
      "volunteer-contact-section",
      "volunteer-role-section",
      "volunteer-experience-section",
    ],
    [STAGES.COACHING_APPLICATION]: [
      "volunteer-contact-section",
      "coaching-experience-section",
      "coaching-availability-section",
      "coaching-references-section",
      "coaching-certification-section",
    ],
    [STAGES.VOLUNTEER_AGREEMENT]: ["volunteer-agreement-section"],
  });

  const STAGE_META = Object.freeze({
    [STAGES.PLAYER_REGISTRATION]: {
      title: "MLS GO Registration",
      subtitle:
        "Registration fee is <strong>$75 per player</strong>. You can register up to four players in a single submission.",
      progressLabel: "Player registration",
      submitLabel: "Save Registration",
    },
    [STAGES.PLAYER_AGREEMENT]: {
      title: "Player Agreement",
      subtitle: "Review the required documents. We will generate and record the Player Agreement after you confirm this stage.",
      progressLabel: "Player agreement",
      submitLabel: "Record Player Agreement",
    },
    [STAGES.SCHOLARSHIP_APPLICATION]: {
      title: "Scholarship Guidelines",
      subtitle: "Review the scholarship guidelines below. Your agreement is preloaded from your registration. Accepting this page records your acceptance of the agreement.",
      progressLabel: "Scholarship guidelines",
      submitLabel: "Accept Scholarship Guidelines",
    },
    [STAGES.VOLUNTEER_APPLICATION]: {
      title: "Volunteer Application",
      subtitle: "Complete the volunteer application. The Volunteer Agreement will be recorded in the next stage.",
      progressLabel: "Volunteer application",
      submitLabel: "Submit Volunteer Application",
    },
    [STAGES.COACHING_APPLICATION]: {
      title: "Coaching Application",
      subtitle: "Complete the coaching application. The Volunteer Agreement will be recorded after the coaching application is complete.",
      progressLabel: "Coaching application",
      submitLabel: "Submit Coaching Application",
    },
    [STAGES.VOLUNTEER_AGREEMENT]: {
      title: "Volunteer Agreement",
      subtitle: "Review the Volunteer Agreement before we generate and record it for your application.",
      progressLabel: "Volunteer agreement",
      submitLabel: "Record Volunteer Agreement",
    },
  });

  const CLUB_OPTIONS = [
    "Atlanta United",
    "Austin FC",
    "Charlotte FC",
    "Chicago Fire FC",
    "FC Cincinnati",
    "Colorado Rapids",
    "Columbus Crew",
    "D.C. United",
    "FC Dallas",
    "Houston Dynamo FC",
    "Sporting Kansas City",
    "LA Galaxy",
    "Los Angeles Football Club",
    "Inter Miami FC",
    "Minnesota United",
    "CF Montreal",
    "Nashville SC",
    "New England Revolution",
    "New York Red Bulls",
    "New York City Football Club",
    "Orlando City",
    "Philadelphia Union",
    "Portland Timbers",
    "Real Salt Lake",
    "San Jose Earthquakes",
    "Seattle Sounders FC",
    "St Louis CITY SC",
    "Toronto FC",
    "Vancouver Whitecaps FC",
    "Do not have a favorite MLS team",
  ];

  const HEAR_ABOUT_OPTIONS = [
    "MLS GO Website",
    "MLS GO Social Media Platform",
    "MLS Website",
    "MLS Social Media Platform",
    "MLS Game/Event",
    "MLS Game Broadcast",
    "MLS Club Email",
    "Commercial",
    "News/Media Outlet",
    "RCX Sports (Social, Email, Event)",
    "Flyer",
    "Local Operator Social Media Platform",
    "Local Operator Email",
    "Friend/Family",
  ];

  const STATE_ABBREVIATIONS = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC", "PR",
  ];

  const EMAIL_FIELD_NAMES = new Set([
    "parentEmail",
    "emergencyEmail",
    "volEmail",
    "coachRef1Email",
  ]);

  const NAME_FIELD_PATTERN = /(FirstName|LastName|Name)$/i;

  const PLAYER_ENTRY_MAP = {
    1: {
      firstName: "925997673",
      lastName: "532782949",
      dob: "794964979",
      gender: "948988960",
      grade: "68551410",
      jersey: "96252862",
      shorts: "1653868038",
      socks: "606531095",
      race: "344887039",
      raceOther: "808819655",
      favoriteClub: "1383414731",
      hearAbout: "2134407522",
      addAnother: "132442608",
    },
    2: {
      firstName: "1352429219",
      lastName: "132205084",
      dob: "616106228",
      gender: "1017279017",
      grade: "492008333",
      jersey: "74117565",
      shorts: "2091822432",
      socks: "1277624888",
      race: "919396396",
      raceOther: "148933358",
      favoriteClub: "1501321341",
      hearAbout: "1052127738",
      addAnother: "287436182",
    },
    3: {
      firstName: "2087824710",
      lastName: "2110140915",
      dob: "1255070093",
      gender: "270070642",
      grade: "469937536",
      jersey: "839595072",
      shorts: "1118709557",
      socks: "653829530",
      race: "728187149",
      raceOther: "361075923",
      favoriteClub: "152390057",
      hearAbout: "2123216185",
      addAnother: "755902013",
    },
    4: {
      firstName: "1532414499",
      lastName: "1957523408",
      dob: "1725113999",
      gender: "1691185787",
      grade: "1650750414",
      jersey: "1359691308",
      shorts: "838505738",
      socks: "1868190364",
      race: "537384775",
      raceOther: "1820997950",
      favoriteClub: "1262218896",
      hearAbout: "865861505",
      addAnother: null,
    },
  };

  const PARENT_ENTRY_MAP = {
    firstName: "562145774",
    lastName: "1860068040",
    email: "1319950320",
    phone: "614132174",
    street: "1194206170",
    apt: "1158121566",
    city: "1446697066",
    state: "1759011168",
    zip: "212275520",
  };

  const AGREEMENT_ENTRY_MAP = {
    waiver: "1522719395",
    privacy: "481619757",
    marketing: "1538615941",
    signature: "1611060751",
  };

  const FLOW_META = {
    [FLOW.PLAYER]: {
      title: "MLS GO Registration",
      subtitle:
        "Registration fee is <strong>$75 per player</strong>. You can register up to four players in a single submission.",
      progressLabel: "Player registration",
      submitLabel: "Submit Registration",
    },
    [FLOW.VOLUNTEER]: {
      title: "Volunteer Application",
      subtitle:
        "Complete the volunteer form. Your registration details will stay in this browser while you finish.",
      progressLabel: "Volunteer application",
      submitLabel: "Submit Volunteer Application",
    },
    [FLOW.COACH]: {
      title: "Coaching Application",
      subtitle:
        "Complete the coaching form. We’ll ask for your contact details first, then a few coaching questions.",
      progressLabel: "Coaching application",
      submitLabel: "Submit Coaching Application",
    },
    coachSupplement: {
      title: "Coaching Application",
      subtitle:
        "You’ve finished the volunteer step. Please complete the coaching section.",
      progressLabel: "Coaching application",
      submitLabel: "Submit Coaching Application",
    },
  };

  const form = document.getElementById("registration-form");
  const sectionsRoot = document.getElementById("sections-root");
  const formTitle = document.getElementById("form-title");
  const formSubtitle = document.getElementById("form-subtitle");
  const formMessage = document.getElementById("form-message");
  const flowStatus = document.getElementById("flow-status");
  const paymentPageNote = document.getElementById("payment-page-note");
  const backBtn = document.getElementById("back-btn");
  const nextBtn = document.getElementById("next-btn");
  const skipBtn = document.getElementById("skip-btn");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const successPanel = document.getElementById("success-panel");

  const playerToggleNames = ["addPlayer2", "addPlayer3", "addPlayer4"];
  const standaloneFlow = parseStandaloneFlow();
  const initialSectionId = parseInitialSectionId();

  let activeStageIndex = 0;
  let activeSectionIndex = 0;
  let lockedFlowOptions = standaloneFlow ? { standaloneFlow } : null;
  let playerSubmitted = false;
  let scholarshipSubmitted = false;
  let volunteerSubmitted = false;
  let coachingSubmitted = false;
  let completedRegistrationData = null;
  let completedVolunteerData = null;
  let completedCoachingData = null;
  let playerAgreementSigned = false;
  let volunteerAgreementSigned = false;
  let coachingAgreementSigned = false;
  let finalConfirmationEmailFailed = false;
  let registrationSubmissionId = "";
  let volunteerSubmissionId = "";
  let coachingSubmissionId = "";
  let playerAgreementTransactionId = "";
  let volunteerAgreementTransactionId = "";
  let coachingAgreementTransactionId = "";
  let playerAgreementDownloadUrl = "";
  let volunteerAgreementDownloadUrl = "";
  let coachingAgreementDownloadUrl = "";
  let scholarshipDocumentUrl = "";
  let registrationSyncWarning = "";
  let googleMapsApiKeyPromise;
  let isSubmittingStage = false;
  let registrationResumeState = null;
  let withdrawalVerificationToken = "";

  buildPage();
  updatePaymentPageNote();
  wireEvents();
  updateFlowMeta();
  applyVisibility();
  updateScholarshipAgreementPreview();
  setActiveSectionById(initialSectionId);
  renderWizard();
  initAddressAutocomplete();
  normalizeAutofilledFieldsSoon();
  syncAgreementPrefills();
  updateExperienceSummaryRequirements();
  initializeRegistrationContinuation().catch((error) => {
    console.error("registration-resume-init-failed", error);
    formMessage.classList.remove("form-message--loading", "form-message--success");
    formMessage.classList.add("form-message--error");
    formMessage.textContent =
      "We couldn’t load your registration information. Please reopen the secure link from your email or contact Paducah GO Soccer for assistance.";
  });

  async function initializeRegistrationContinuation() {
    const params = new URLSearchParams(window.location.search);
    const resumeToken = String(params.get("resume") || "").trim();
    if (!resumeToken) return;

    const requestedTestMode = params.get("resumeTest") === "1";

    formMessage.classList.remove("form-message--error", "form-message--success");
    formMessage.classList.add("form-message--loading");
    formMessage.textContent =
      "Please wait, your registration is being loaded... We’re securely restoring your previous registration information. This may take a few seconds.";

    const response = await fetchWithTimeout(RESUME_CONTEXT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ resumeToken }),
    }, FORM_UPSERT_TIMEOUT_MS);

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload?.context) {
      throw new Error(String(payload?.error || `Saved registration could not be loaded (${response.status}).`));
    }

    const context = payload.context;
    registrationResumeState = {
      token: resumeToken,
      testMode: Boolean(requestedTestMode || context.resume?.testMode),
      context,
    };

    registrationSubmissionId = String(context.registrationSubmissionId || "").trim();
    if (!registrationSubmissionId) {
      throw new Error("The saved registration is missing its registration ID.");
    }

    applyRegistrationResumeContext(context);
    if (context.resume?.agreementOnly && initialSectionId === "agreements-section") {
      completedRegistrationData = collectRegistrationData();
      completedRegistrationData.registrationSubmissionId = registrationSubmissionId;
      playerSubmitted = true;
      lockFlowOptionsFromRegistration(completedRegistrationData);
      advanceToStage(STAGES.PLAYER_AGREEMENT);
      renderWizard();
    }
    ensureWithdrawalPanel(context);
    if (registrationResumeState.testMode) showRegistrationResumeTestBanner();

    formMessage.classList.remove("form-message--loading", "form-message--error");
    formMessage.classList.add("form-message--success");
    formMessage.textContent = registrationResumeState.testMode
      ? "Your registration information has been loaded. Please review the pre-filled information below. TEST MODE: This is a read-only continuation preview. No live registration data will be changed."
      : "Your registration information has been loaded. Please review the pre-filled information carefully and complete any remaining steps.";
  }

  function applyRegistrationResumeContext(context) {
    const parent = context.parent || {};
    setValue("parentFirstName", parent.firstName || "");
    setValue("parentLastName", parent.lastName || "");
    setValue("parentEmail", parent.email || "");
    setValue("parentPhone", parent.phone || "");
    setValue("parentGuardianDob", parent.dob || "");
    setValue("parentStreet", parent.street || "");
    setValue("parentApt", parent.apt || "");
    setValue("parentCity", parent.city || "");
    setValue("parentState", parent.state || "");
    setValue("parentZip", parent.zip || "");

    const emergency = context.emergency || {};
    const sameAsParent = /^(yes|true|1)$/i.test(String(emergency.sameAsParent || ""));
    const emergencyToggle = form.elements.namedItem("emergencySameAsParent");
    if (emergencyToggle instanceof HTMLInputElement) emergencyToggle.checked = sameAsParent;
    setValue("emergencyFirstName", emergency.firstName || "");
    setValue("emergencyLastName", emergency.lastName || "");
    setValue("emergencyRelationship", emergency.relationship || "");
    setValue("emergencyEmail", emergency.email || "");
    setValue("emergencyPhone", emergency.phone || "");
    setValue("emergencyStreet", emergency.street || "");
    setValue("emergencyApt", emergency.apt || "");
    setValue("emergencyCity", emergency.city || "");
    setValue("emergencyState", emergency.state || "");
    setValue("emergencyZip", emergency.zip || "");

    const players = Array.isArray(context.players) ? context.players.slice(0, 4) : [];
    if (!players.length) throw new Error("No claimed participants were available to continue.");

    for (let i = 1; i <= 4; i += 1) {
      const player = players[i - 1] || {};
      setValue(`p${i}FirstName`, player.firstName || "");
      setValue(`p${i}LastName`, player.lastName || "");
      setValue(`p${i}Dob`, player.dob || "");
      setValue(`p${i}Gender`, player.gender || "");
      setValue(`p${i}Grade`, player.grade || "");
      setValue(`p${i}Jersey`, player.jersey || "");
      setValue(`p${i}Shorts`, player.shorts || "");
      setValue(`p${i}Socks`, player.socks || "");
      setValue(`p${i}Race`, player.race || "");
      setValue(`p${i}RaceOther`, player.raceOther || "");
      setValue(`p${i}FavoriteClub`, player.favoriteClub || "");
      setValue(`p${i}HearAbout`, player.hearAbout || "");
      if (i < 4) setValue(`addPlayer${i + 1}`, players.length > i ? "Yes" : "No");
    }

    setValue("scholarshipRequested", context.scholarshipRequested || "No");
    setValue("helpChoice", context.helpChoice || "No, finish my registration");

    normalizeAutofilledFieldsSoon();
    updateFlowMeta();
    applyVisibility();
    updateScholarshipAgreementPreview();
    syncAgreementPrefills();
    updateExperienceSummaryRequirements();
    activeStageIndex = 0;
    activeSectionIndex = 0;
    renderWizard();
  }

  function ensureWithdrawalPanel(context) {
    if (!registrationResumeState?.token || standaloneFlow || context.resume?.agreementOnly) return;

    let panel = document.getElementById("withdraw-registration-panel");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "withdraw-registration-panel";
      panel.className = "withdraw-registration-panel";
      const footer = form.querySelector(".form-footer");
      if (footer) form.insertBefore(panel, footer);
      else form.appendChild(panel);
    }

    const players = Array.isArray(context?.players) ? context.players : [];
    const playerOptions = players.map((player, index) => {
      const name = [player?.firstName, player?.lastName].filter(Boolean).join(" ").trim() || `Player ${index + 1}`;
      return `<option value="player:${index}">Player: ${escapeHtmlForUi(name)}</option>`;
    }).join("");

    panel.innerHTML = `
      <div class="withdraw-registration-panel__intro">
        <strong>No longer want to register?</strong>
        <span>If you no longer want to continue this registration, you can withdraw it from active enrollment.</span>
      </div>
      <button type="button" class="btn btn-ghost withdraw-registration-toggle" id="withdraw-registration-toggle">Withdraw Registration</button>
      <div class="withdraw-registration-form" id="withdraw-registration-form" hidden>
        <p class="withdraw-registration-warning"><strong>This action removes this registration from the active Players sheet.</strong> A copy will be kept in the Cache tab for administrative history.</p>
        <label class="withdraw-field-label" for="withdraw-verification-subject">Confirm using</label>
        <select id="withdraw-verification-subject" class="withdraw-input">
          <option value="parent">Parent/Guardian date of birth</option>
          ${playerOptions}
        </select>
        <label class="withdraw-field-label" for="withdraw-verification-dob">Date of birth</label>
        <input id="withdraw-verification-dob" class="withdraw-input" type="text" inputmode="numeric" autocomplete="off" placeholder="MM/DD/YYYY" maxlength="10" />
        <p class="withdraw-inline-message" id="withdraw-inline-message" role="alert"></p>
        <div class="withdraw-actions">
          <button type="button" class="btn btn-primary" id="withdraw-verify-btn">Verify Date of Birth</button>
          <button type="button" class="btn btn-ghost" id="withdraw-cancel-btn">Cancel</button>
        </div>
        <div class="withdraw-final-confirmation" id="withdraw-final-confirmation" hidden>
          <p><strong>Date of birth confirmed.</strong> This will remove the registration from active enrollment. This cannot be undone from this page.</p>
          <button type="button" class="btn btn-danger" id="withdraw-confirm-btn">Yes, Withdraw Registration</button>
        </div>
      </div>`;

    const toggle = panel.querySelector("#withdraw-registration-toggle");
    const withdrawForm = panel.querySelector("#withdraw-registration-form");
    const cancel = panel.querySelector("#withdraw-cancel-btn");
    const dobInput = panel.querySelector("#withdraw-verification-dob");
    const verifyBtn = panel.querySelector("#withdraw-verify-btn");
    const confirmBtn = panel.querySelector("#withdraw-confirm-btn");

    toggle?.addEventListener("click", () => {
      withdrawForm.hidden = false;
      toggle.hidden = true;
      dobInput?.focus();
    });
    cancel?.addEventListener("click", () => resetWithdrawalPanel(panel));
    dobInput?.addEventListener("input", () => {
      dobInput.value = formatDobText(dobInput.value);
      clearWithdrawalMessage(panel);
    });
    verifyBtn?.addEventListener("click", () => verifyWithdrawalRequest(panel));
    confirmBtn?.addEventListener("click", () => confirmWithdrawalRequest(panel));
  }

  function escapeHtmlForUi(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resetWithdrawalPanel(panel) {
    withdrawalVerificationToken = "";
    const formWrap = panel?.querySelector("#withdraw-registration-form");
    const toggle = panel?.querySelector("#withdraw-registration-toggle");
    const dob = panel?.querySelector("#withdraw-verification-dob");
    const final = panel?.querySelector("#withdraw-final-confirmation");
    const verify = panel?.querySelector("#withdraw-verify-btn");
    if (formWrap) formWrap.hidden = true;
    if (toggle) toggle.hidden = false;
    if (dob) {
      dob.value = "";
      dob.classList.remove("withdraw-input--invalid");
    }
    if (final) final.hidden = true;
    if (verify) verify.hidden = false;
    clearWithdrawalMessage(panel);
  }

  function clearWithdrawalMessage(panel) {
    const message = panel?.querySelector("#withdraw-inline-message");
    const dob = panel?.querySelector("#withdraw-verification-dob");
    if (message) message.textContent = "";
    if (dob) dob.classList.remove("withdraw-input--invalid");
  }

  function setWithdrawalMessage(panel, message, invalid = false) {
    const target = panel?.querySelector("#withdraw-inline-message");
    const dob = panel?.querySelector("#withdraw-verification-dob");
    if (target) target.textContent = message || "";
    if (dob) dob.classList.toggle("withdraw-input--invalid", Boolean(invalid));
  }

  async function verifyWithdrawalRequest(panel) {
    if (!registrationResumeState?.token) return;
    const select = panel.querySelector("#withdraw-verification-subject");
    const dob = panel.querySelector("#withdraw-verification-dob");
    const verifyBtn = panel.querySelector("#withdraw-verify-btn");
    const final = panel.querySelector("#withdraw-final-confirmation");
    const value = String(select?.value || "parent");
    const dobValue = formatDobText(String(dob?.value || ""));
    if (!isValidDobValue(dobValue)) {
      setWithdrawalMessage(panel, "Enter a valid date of birth in MM/DD/YYYY format.", true);
      dob?.focus();
      return;
    }

    const playerMatch = value.match(/^player:(\d+)$/);
    const body = {
      resumeToken: registrationResumeState.token,
      subjectType: playerMatch ? "player" : "parent",
      playerIndex: playerMatch ? Number(playerMatch[1]) : null,
      dob: dobValue,
    };

    try {
      verifyBtn.disabled = true;
      setWithdrawalMessage(panel, "Verifying date of birth...");
      const response = await fetchWithTimeout(RESUME_WITHDRAW_VERIFY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      }, FORM_UPSERT_TIMEOUT_MS);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload?.verificationToken) {
        throw new Error(String(payload?.error || "We could not verify that date of birth."));
      }
      withdrawalVerificationToken = payload.verificationToken;
      setWithdrawalMessage(panel, "Date of birth confirmed.");
      verifyBtn.hidden = true;
      final.hidden = false;
    } catch (error) {
      withdrawalVerificationToken = "";
      setWithdrawalMessage(panel, String(error?.message || "We could not verify that date of birth."), true);
      dob?.focus();
    } finally {
      verifyBtn.disabled = false;
    }
  }

  async function confirmWithdrawalRequest(panel) {
    if (!registrationResumeState?.token || !withdrawalVerificationToken) {
      setWithdrawalMessage(panel, "Please verify the date of birth before confirming withdrawal.", true);
      return;
    }
    const confirmBtn = panel.querySelector("#withdraw-confirm-btn");
    try {
      confirmBtn.disabled = true;
      setWithdrawalMessage(panel, "Withdrawing registration... Please do not close this window.");
      const response = await fetchWithTimeout(RESUME_WITHDRAW_CONFIRM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          resumeToken: registrationResumeState.token,
          verificationToken: withdrawalVerificationToken,
        }),
      }, FORM_UPSERT_TIMEOUT_MS);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(String(payload?.error || "We could not withdraw this registration."));
      }

      if (payload.testMode) {
        setWithdrawalMessage(panel, payload.message || "TEST MODE: withdrawal verified; no live rows were moved.");
        confirmBtn.disabled = false;
        return;
      }

      form.hidden = true;
      if (progressText) progressText.textContent = "Withdrawn";
      if (progressFill) progressFill.style.width = "100%";
      formMessage.textContent = "";
      successPanel.hidden = false;
      const heading = successPanel.querySelector("h2");
      const copy = successPanel.querySelector("p");
      if (heading) heading.textContent = "Registration Withdrawn";
      if (copy) copy.textContent = "Your registration has been removed from active enrollment. No further action is required.";
    } catch (error) {
      setWithdrawalMessage(panel, String(error?.message || "We could not withdraw this registration."), false);
      confirmBtn.disabled = false;
    }
  }

  function showRegistrationResumeTestBanner() {
    if (document.getElementById("registration-resume-test-banner")) return;
    const banner = document.createElement("div");
    banner.id = "registration-resume-test-banner";
    banner.textContent = "TEST CONTINUATION — no live registration changes will be saved.";
    Object.assign(banner.style, {
      position: "sticky", top: "0", zIndex: "9999", padding: "10px 14px",
      background: "#fff3cd", color: "#664d03", fontWeight: "700", textAlign: "center",
    });
    document.body.prepend(banner);
  }

  function normalizeAutofilledFieldsSoon() {
    [250, 750, 1500].forEach((delay) => {
      window.setTimeout(() => {
        Array.from(form.elements).forEach((field) => {
          if (
            field instanceof HTMLInputElement ||
            field instanceof HTMLSelectElement ||
            field instanceof HTMLTextAreaElement
          ) {
            normalizeFieldValue(field);
          }
        });
      }, delay);
    });
  }

  function parseStandaloneFlow() {
    const value = new URLSearchParams(window.location.search).get("flow");
    if (value === "volunteer") return FLOW.VOLUNTEER;
    if (value === "coach") return FLOW.COACH;
    return null;
  }

  function parseInitialSectionId() {
    const value = new URLSearchParams(window.location.search).get("section");
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return "";

    if (normalized === "agreements" || normalized === "agreement" || normalized === "waiver") {
      return "agreements-section";
    }

    return "";
  }

  function resolvePaymentMode() {
    const rawValue = new URLSearchParams(window.location.search).get(PAYMENT_MODE_QUERY_PARAM);
    const normalized = String(rawValue || PAYMENT_MODE_DEFAULT).trim().toLowerCase();
    if (normalized === "redirect") return "redirect";
    return "paused";
  }

  function updatePaymentPageNote() {
    if (!paymentPageNote) return;
    const descriptor = getFlowDescriptor(getFlowOptions());
    if (!descriptor.paymentRequired) {
      paymentPageNote.hidden = true;
      paymentPageNote.textContent = "";
      return;
    }

    paymentPageNote.hidden = false;
    paymentPageNote.textContent = PAYMENT_MODE === "redirect"
      ? "After submission, you will be redirected to our secure payment page to complete registration."
      : "Payments are temporarily paused while we update our payment system. Your registration is still saved, and we’ll email you a secure payment link when it’s ready.";
  }

  function buildPage() {
    sectionsRoot.className = "sections-grid";
    sectionsRoot.append(
      buildParentSection(),
      buildEmergencySection(),
      buildPlayerSection(1),
      buildPlayerSection(2),
      buildPlayerSection(3),
      buildPlayerSection(4),
      buildScholarshipSection(),
      buildHelpSection(),
      buildAgreementsSection(),
      buildScholarshipApplicationSection(),
      buildVolunteerAgreementSection(),
      buildVolunteerContactSection(),
      buildVolunteerRoleSection(),
      buildVolunteerExperienceSection(),
      buildCoachingExperienceSection(),
      buildCoachingAvailabilitySection(),
      buildCoachingReferencesSection(),
      buildCoachingCertificationSection(),
    );
  }

  function buildParentSection() {
    const section = createSection(
      "Parent or Legal Guardian",
      "Primary contact information for the household.",
      false,
      "parent-section",
      FLOW.PLAYER,
    );
    section.append(
      createGrid([
        createTextField({ label: "Parent/Guardian First Name", name: "parentFirstName", required: true }),
        createTextField({ label: "Parent/Guardian Last Name", name: "parentLastName", required: true }),
        createTextField({ label: "Parent/Guardian Email", name: "parentEmail", required: true, type: "email", autocomplete: "email" }),
        createTextField({ label: "Parent/Guardian Cell Phone", name: "parentPhone", required: true, type: "tel", inputMode: "tel", autocomplete: "tel" }),
        createTextField({ label: "Parent/Guardian Date of Birth", name: "parentGuardianDob", required: true, type: "date" }),
        createTextField({ label: "Street Address", name: "parentStreet", required: true, autocomplete: "street-address", addressField: true, placeholder: "Start typing the address" }),
        createTextField({ label: "Apartment, Suite, or Unit", name: "parentApt", autocomplete: "address-line2" }),
        createTextField({ label: "City", name: "parentCity", required: true, autocomplete: "address-level2" }),
        createSelectField({ label: "State", name: "parentState", required: true, options: STATE_ABBREVIATIONS }),
        createTextField({ label: "ZIP Code", name: "parentZip", required: true, inputMode: "numeric", autocomplete: "postal-code" }),
      ]),
    );
    return section;
  }

  function buildEmergencySection() {
    const section = createSection(
      "Emergency Contact",
      "Complete this section if the emergency contact is different from the parent or guardian.",
      true,
      "emergency-section",
      FLOW.PLAYER,
    );

    const toggle = createToggle({
      label: "Emergency Contact Is the Same as the Parent/Guardian",
      name: "emergencySameAsParent",
      checked: true,
    });

    const fields = document.createElement("div");
    fields.className = "hidden";
    fields.dataset.emergencyFields = "true";
    fields.append(
      createGrid([
        createTextField({ label: "Emergency Contact First Name", name: "emergencyFirstName" }),
        createTextField({ label: "Emergency Contact Last Name", name: "emergencyLastName" }),
        createTextField({ label: "Relationship", name: "emergencyRelationship", placeholder: "Grandparent, aunt, coach, etc." }),
        createTextField({ label: "Emergency Contact Email", name: "emergencyEmail", type: "email", autocomplete: "email" }),
        createTextField({ label: "Emergency Contact Phone", name: "emergencyPhone", type: "tel", inputMode: "tel", autocomplete: "tel" }),
        createTextField({ label: "Street Address", name: "emergencyStreet", autocomplete: "street-address", addressField: true, placeholder: "Start typing the address" }),
        createTextField({ label: "Apartment, Suite, or Unit", name: "emergencyApt", autocomplete: "address-line2" }),
        createTextField({ label: "City", name: "emergencyCity", autocomplete: "address-level2" }),
        createSelectField({ label: "State", name: "emergencyState", options: STATE_ABBREVIATIONS }),
        createTextField({ label: "ZIP Code", name: "emergencyZip", inputMode: "numeric", autocomplete: "postal-code" }),
      ]),
    );

    toggle.querySelector("input")?.addEventListener("change", (event) => {
      fields.classList.toggle("hidden", Boolean(event.target.checked));
    });

    section.append(toggle, fields);
    return section;
  }

  function buildPlayerSection(playerIndex) {
    const section = createSection(
      `Player ${playerIndex}`,
      playerIndex === 1
        ? "Enter the first player details. Use the toggle below to add another player if needed."
        : "Enter details for the additional player.",
      playerIndex > 1,
      `player-section-${playerIndex}`,
      FLOW.PLAYER,
    );

    const grid = createGrid([
      createTextField({ label: `Player ${playerIndex} - First Name`, name: `p${playerIndex}FirstName`, required: true }),
      createTextField({ label: `Player ${playerIndex} - Last Name`, name: `p${playerIndex}LastName`, required: true }),
      createTextField({ label: `Player ${playerIndex} - Date of Birth`, name: `p${playerIndex}Dob`, required: true, type: "date" }),
      createSelectField({ label: `Player ${playerIndex} - Gender Identity`, name: `p${playerIndex}Gender`, required: true, options: ["Female", "Male", "Non-binary", "Prefer not to specify"] }),
      createSelectField({ label: `Player ${playerIndex} - Division`, name: `p${playerIndex}Grade`, required: true, options: ["2nd/3rd Grade Boys", "2nd/3rd Grade Girls", "4th/5th Grade Boys", "4th/5th Grade Girls"] }),
      createSelectField({ label: `Player ${playerIndex} - Jersey Size`, name: `p${playerIndex}Jersey`, required: true, options: ["YXXS", "YXS", "YS", "YM", "YL", "YXL/AS", "AM", "AL", "AXL"] }),
      createSelectField({ label: `Player ${playerIndex} - Shorts Size`, name: `p${playerIndex}Shorts`, required: true, options: ["YXXS", "YXS", "YS", "YM", "YL", "YXL/AS", "AM", "AL", "AXL"] }),
      createSelectField({ label: `Player ${playerIndex} - Sock Size`, name: `p${playerIndex}Socks`, required: true, options: ["YS/YM", "YL/YXL", "A"] }),
      createSelectField({
        label: `Player ${playerIndex} - Race/Ethnicity`,
        name: `p${playerIndex}Race`,
        required: true,
        options: [
          "Black or African American",
          "Arab/Middle Eastern",
          "American Indian/Alaska Native",
          "Canadian Indigenous or First Nations",
          "Hawaiian/Pacific Islander",
          "Hispanic/Latino(a)",
          "White/European",
          "Other (write in)",
          "I do not wish to disclose",
        ],
      }),
      createTextField({ label: `Player ${playerIndex} - Race/Ethnicity - If Other, Please Specify`, name: `p${playerIndex}RaceOther`, conditionalOn: `p${playerIndex}Race`, conditionalValue: "Other (write in)" }),
      createSelectField({ label: `Player ${playerIndex} - Favorite MLS Club`, name: `p${playerIndex}FavoriteClub`, required: true, options: CLUB_OPTIONS }),
      createSelectField({ label: `Player ${playerIndex} - How Did You Hear About MLS GO?`, name: `p${playerIndex}HearAbout`, required: true, options: HEAR_ABOUT_OPTIONS }),
    ]);

    section.append(grid);

    if (playerIndex < 4) {
      const toggleName = `addPlayer${playerIndex + 1}`;
      const toggle = createSelectField({
        label: "Would You Like to Register Another Player?",
        name: toggleName,
        required: true,
        options: ["Yes", "No"],
      });
      const divider = document.createElement("div");
      divider.className = "section-divider";
      section.append(divider, toggle);
    }

    return section;
  }

  function buildScholarshipSection() {
    const section = createSection(
      "Financial Hardship Scholarship",
      "Tell us whether your family needs scholarship assistance. If you select Yes, you will fill out the scholarship application in the final step.",
      false,
      "scholarship-section",
      FLOW.PLAYER,
    );

    const scholarshipFields = createGrid([
      createSelectField({
        label: "Do you need assistance with registration fees?",
        name: "scholarshipRequested",
        required: true,
        options: ["Yes", "No"],
      }),
    ]);

    section.append(scholarshipFields);
    return section;
  }

  function buildScholarshipApplicationSection() {
    const section = createSection(
      "Review and Accept",
      "This is the web version of the scholarship application. If you wish to receive a copy for your records, you may request it via email at youthprograms@lifeprepacademy.com.",
      false,
      "scholarship-application-section",
      FLOW.PLAYER,
    );

    const agreementPreview = buildScholarshipAgreementDocumentPreview();

    const agreementAcceptance = createCheckboxField({
      label: "Accept Scholarship Guidelines",
      name: "scholarshipGuidelinesAccepted",
      required: true,
      descriptionHtml: 'I am <strong id="scholarship-acceptance-parent">Parent/Guardian</strong>, the parent or guardian of <strong id="scholarship-acceptance-participants">the listed participant(s)</strong>. I have read, understand, and accept the Paducah GO Soccer Scholarship Guidelines.',
    });

    section.append(
      agreementPreview,
      agreementAcceptance,
    );
    return section;
  }

  function buildScholarshipAgreementDocumentPreview() {
    const wrap = document.createElement("div");
    wrap.className = "scholarship-agreement-doc";

    const header = document.createElement("div");
    header.className = "scholarship-agreement-doc__header";

    const kicker = document.createElement("p");
    kicker.className = "scholarship-agreement-doc__kicker";
    kicker.textContent = "Agreement Preview";

    const title = document.createElement("h3");
    title.className = "scholarship-agreement-doc__title";
    title.textContent = "Paducah GO Soccer Scholarship Guidelines";

    const intro = document.createElement("p");
    intro.className = "scholarship-agreement-doc__intro";
    intro.textContent = "Your scholarship application is ready below for your review.";

    header.append(kicker, title, intro);

    const body = document.createElement("div");
    body.className = "scholarship-agreement-doc__body";
    body.innerHTML = [
      '<p class="scholarship-agreement-doc__lead">We understand that families may face unexpected challenges, which is why Paducah GO Soccer offers this scholarship to ensure that financial hardship does not prevent a child from participating. To keep the scholarship program fair and available to all children, recipients and their families are expected to follow the participation, school attendance, conduct, and communication guidelines outlined below. These expectations are intended to support each child’s success both on and off the field.</p>',
      '<p class="scholarship-agreement-doc__coverage"><strong>The scholarship covers the full $75 registration fee.</strong> It is intended for children who would otherwise be unable to participate because of the cost.</p>',
      '<h4>Who can receive a scholarship</h4>',
      '<ul>',
      '<li><strong>Grade and school:</strong> The child is enrolled in grade K-12 at a public school in Paducah or the surrounding area.</li>',
      '<li><strong>Financial need:</strong> A parent or guardian confirms that paying the $75 fee would be a hardship. No detailed financial records are required.</li>',
      '<li><strong>Registration:</strong> The family completes the scholarship request and all regular player registration forms.</li>',
      '<li><strong>Availability:</strong> Scholarships are awarded while scholarship funds and team spaces are available. One scholarship may be awarded per child, per season.</li>',
      '</ul>',
      '<p>Scholarships are not based on soccer ability, school grades, or prior playing experience.</p>',
      '<h4>Guidelines for continuing through the season</h4>',
      '<ul>',
      '<li><strong>School attendance:</strong> The child should maintain at least 80% attendance in school. Excused absences for illness, disability, family emergencies, or other approved reasons will not count against the child.</li>',
      '<li><strong>School conduct:</strong> The child should make a reasonable effort to learn without becoming an ongoing disruption to themselves or others. An isolated incident will not automatically affect the scholarship, but a continuing pattern identified by the school may require a family meeting and improvement plan.</li>',
      '<li><strong>Respect:</strong> The child should behave respectfully toward parents and guardians, teachers, coaches, officials, teammates, and other families.</li>',
      '<li><strong>Soccer participation:</strong> The player should attend practices and games regularly, with a goal of attending at least 75% of scheduled activities.</li>',
      '<li><strong>Communication:</strong> A parent or guardian should notify the coach when the player will be absent. If the player has two consecutive unexcused absences, the program will contact the family to see whether help is needed.</li>',
      '<li><strong>Inactive players:</strong> If the player stops attending and the family does not respond after reasonable contact attempts, the program may release the roster spot to another child.</li>',
      '</ul>',
      '<p>A scholarship will not be taken away because of an illness, emergency, transportation problem, disability-related need, or another reasonable hardship when the family communicates with the program.</p>',
      '<h4>Family acknowledgment</h4>',
      '<p>By accepting the scholarship, the family agrees to make a good-faith effort to help the player participate for the full season and to stay in contact with the coach.</p>',
    ].join("");

    const identity = document.createElement("div");
    identity.className = "scholarship-agreement-identity";
    identity.innerHTML = [
      '<div class="scholarship-agreement-identity__field"><span>Player(s)</span><strong id="scholarship-identity-participants">Participant</strong></div>',
      '<div class="scholarship-agreement-identity__field"><span>Grade(s)</span><strong id="scholarship-identity-grades">Not provided</strong></div>',
      '<div class="scholarship-agreement-identity__field"><span>Parent/Guardian</span><strong id="scholarship-identity-parent">Parent/Guardian</strong></div>',
      `<div class="scholarship-agreement-identity__field"><span>Document version</span><strong>${SCHOLARSHIP_GUIDELINES_DOCUMENT_VERSION}</strong></div>`,
    ].join("");

    const pages = document.createElement("div");
    pages.className = "scholarship-agreement-pages";
    pages.id = "scholarship-agreement-pages";

    wrap.append(header, body, identity, pages);
    return wrap;
  }

  function buildHelpSection() {
    const section = createSection(
      "Help With the Program",
      "Would you like to help with the program?",
      false,
      "help-section",
      FLOW.PLAYER,
    );

    section.append(
      createSelectField({
        label: "Would You Like to Help With the Program?",
        name: "helpChoice",
        required: true,
        options: [
          "No, finish my registration",
          "Volunteer",
          "Apply to coach",
          "Volunteer and apply to coach",
        ],
      }),
    );

    return section;
  }

  function buildAgreementsSection() {
    const section = createSection(
      "MLS GO Agreements",
      "Review each required document before accepting the program terms.",
      false,
      "agreements-section",
      FLOW.PLAYER,
    );

    const grid = createGrid([
      createCheckboxField({
        label: "PPF Liability Form",
        name: "agreePpfLiability",
        required: true,
        requireLinksViewed: true,
        description:
          "I have reviewed the PPF Liability Form, understand the coverage and responsibilities described within, and agree to the terms for the program participation described in this form.",
        links: [
          {
            href: PPF_LIABILITY_FORM_URL,
            text: "View PPF Liability Form (PDF)",
          },
        ],
      }),
      createCheckboxField({
        label: "MLS GO Player Registration Agreement and Waiver",
        name: "agreeWaiver",
        required: true,
        requireLinksViewed: true,
        description:
          "I have read and understand the MLS GO Player Registration Agreement and Waiver, accept its terms for myself and every participant listed in this registration, and intend to be legally bound.",
        links: [
          {
            href: MLS_PLAYER_WAIVER_URL,
            text: "View MLS GO Player Registration Agreement and Waiver (PDF)",
          },
        ],
      }),
      createCheckboxField({
        label: "MLS GO Privacy Policy and Terms of Service",
        name: "agreePrivacy",
        required: true,
        requireLinksViewed: true,
        descriptionHtml:
          'I agree that MLS GO, Major League Soccer, the MLS Clubs, Soccer United Marketing, MLS NEXT Pro, MLS NEXT and each of their respective clubs, affiliates and partners, can use my information to send me newsletters, offers, additional information and other communications about their products and initiatives in accordance with the <a href="' +
          MLS_PRIVACY_POLICY_URL +
          '" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="' +
          MLS_TERMS_OF_SERVICE_URL +
          '" target="_blank" rel="noopener noreferrer">Terms of Use</a>.',
      }),
    ]);
    grid.classList.add("form-grid--one");
    section.append(grid);
    return section;
  }

  function buildVolunteerContactSection() {
    const isStandaloneCoach = standaloneFlow === FLOW.COACH;
    const section = createSection(
      isStandaloneCoach ? "Coaching Contact" : "Volunteer Contact",
      isStandaloneCoach
        ? "Tell us how to reach you about coaching opportunities."
        : "Tell us how to reach you about volunteer opportunities.",
      false,
      "volunteer-contact-section",
      FLOW.VOLUNTEER,
    );
    section.append(
      createGrid([
        createTextField({ label: "First Name", name: "volFirstName", required: true, autocomplete: "given-name" }),
        createTextField({ label: "Last Name", name: "volLastName", required: true, autocomplete: "family-name" }),
        createTextField({ label: "Email", name: "volEmail", required: true, type: "email", autocomplete: "email" }),
        createTextField({ label: "Phone", name: "volPhone", required: true, type: "tel", inputMode: "tel", autocomplete: "tel" }),
        createTextField({ label: "Date of Birth", name: "volDob", required: true, type: "date" }),
        createTextField({ label: "Street Address", name: "volStreet", required: true, autocomplete: "street-address", addressField: true }),
        createTextField({ label: "Apartment, Suite, or Unit", name: "volApt", autocomplete: "address-line2" }),
        createTextField({ label: "City", name: "volCity", required: true, autocomplete: "address-level2" }),
        createSelectField({ label: "State", name: "volState", required: true, options: STATE_ABBREVIATIONS }),
        createTextField({ label: "ZIP Code", name: "volZip", required: true, inputMode: "numeric", autocomplete: "postal-code" }),
      ]),
    );
    return section;
  }

  function buildVolunteerAgreementSection() {
    const section = createSection(
      "Volunteer Agreement",
      "Review the agreement before accepting the terms for your application.",
      false,
      "volunteer-agreement-section",
      FLOW.VOLUNTEER,
    );
    section.append(
      createCheckboxField({
        label: "MLS GO Volunteer Agreement",
        name: "agreeVolunteerAgreement",
        required: true,
        requireLinksViewed: true,
        description: "I have reviewed the MLS GO Volunteer Agreement and agree to the terms for my application.",
        links: [
          {
            href: VOLUNTEER_AGREEMENT_TEMPLATE_URL,
            text: "View MLS GO Volunteer Agreement (PDF)",
          },
        ],
      }),
    );
    return section;
  }

  function buildVolunteerRoleSection() {
    const section = createSection(
      "Volunteer Role",
      "Select all roles that interest you.",
      false,
      "volunteer-role-section",
      FLOW.VOLUNTEER,
    );
    section.append(
      createCheckboxGroupField({
        label: "Volunteer Interests",
        name: "volunteerRoles",
        required: true,
        options: [
          "Game-day operations",
          "Team check-in and support",
          "Field setup and breakdown",
          "Communications and outreach",
          "Fundraising",
          "Other",
        ],
      }),
    );
    return section;
  }

  function buildVolunteerExperienceSection() {
    const section = createSection(
      "Volunteer Experience",
      "Share your relevant experience and availability notes.",
      false,
      "volunteer-experience-section",
      FLOW.VOLUNTEER,
    );

    const grid = createGrid([
      createSelectField({
        label: "Have You Volunteered With Youth Sports Before?",
        name: "volHasExperience",
        required: true,
        options: ["Yes", "No"],
      }),
      createTextField({
        label: "Experience Summary",
        name: "volExperienceSummary",
        required: true,
        placeholder: "Share clubs, roles, and years of experience",
      }),
      createTextField({
        label: "Best Days/Times",
        name: "volAvailabilityNotes",
        required: true,
        placeholder: "Weeknights, Saturday mornings, etc.",
      }),
    ]);

    section.append(grid);
    return section;
  }

  function buildCoachingExperienceSection() {
    const section = createSection(
      "Coaching Experience",
      "Tell us about your coaching or leadership background.",
      false,
      "coaching-experience-section",
      FLOW.COACH,
    );

    section.append(
      createGrid([
        createSelectField({
          label: "Have You Coached Youth Sports Before?",
          name: "coachHasExperience",
          required: true,
          options: ["Yes", "No"],
        }),
        createTextField({
          label: "Coaching Summary",
          name: "coachExperienceSummary",
          required: true,
          placeholder: "Teams, ages, and seasons coached",
        }),
      ]),
    );
    return section;
  }

  function buildCoachingAvailabilitySection() {
    const section = createSection(
      "Coaching Availability",
      "Select all times you can consistently support.",
      false,
      "coaching-availability-section",
      FLOW.COACH,
    );

    section.append(
      createCheckboxGroupField({
        label: "Available Windows",
        name: "coachAvailability",
        required: true,
        options: [
          "Weekday evenings",
          "Saturday mornings",
          "Saturday afternoons",
          "Sunday afternoons",
          "Flexible schedule",
        ],
      }),
    );

    return section;
  }

  function buildCoachingReferencesSection() {
    const section = createSection(
      "Coaching References",
      "Provide at least one reference we can contact.",
      false,
      "coaching-references-section",
      FLOW.COACH,
    );

    section.append(
      createGrid([
        createTextField({ label: "Reference 1 Full Name", name: "coachRef1Name", required: true }),
        createTextField({ label: "Reference 1 Relationship", name: "coachRef1Relationship", required: true }),
        createTextField({ label: "Reference 1 Phone", name: "coachRef1Phone", required: true, type: "tel", inputMode: "tel" }),
        createTextField({ label: "Reference 1 Email", name: "coachRef1Email", required: true, type: "email" }),
      ]),
    );

    return section;
  }

  function buildCoachingCertificationSection() {
    const section = createSection(
      "Coaching Certifications",
      "Share current certifications and acknowledge background screening requirements.",
      false,
      "coaching-certification-section",
      FLOW.COACH,
    );

    const grid = createGrid([
      createCheckboxGroupField({
        label: "Current Certifications",
        name: "coachCertifications",
        options: [
          "First Aid / CPR",
          "Concussion training",
          "Safesport or equivalent",
          "None currently",
        ],
      }),
      createCheckboxField({
        label: "Background Screening Acknowledgement",
        name: "coachBackgroundConsent",
        required: true,
        description:
          "I understand coaching roles require background screening and compliance with program policies.",
      }),
    ]);
    grid.classList.add("form-grid--one");
    section.append(grid);

    return section;
  }

  function createSection(title, description, muted, id, flow) {
    const section = document.createElement("section");
    section.className = `form-section${muted ? " is-muted" : ""}`;
    section.id = id;
    section.dataset.flow = flow;

    const header = document.createElement("div");
    header.className = "section-header";

    const heading = document.createElement("h2");
    heading.textContent = title;

    const helper = document.createElement("p");
    helper.className = "section-helper";
    helper.textContent = description;

    header.append(heading, helper);
    section.append(header);
    return section;
  }

  function createGrid(children) {
    const grid = document.createElement("div");
    grid.className = "form-grid";
    children.forEach((child) => grid.appendChild(child));
    return grid;
  }

  function createFieldWrap(labelText, name, required) {
    const wrap = document.createElement("div");
    wrap.className = "field-group";
    wrap.dataset.fieldWrap = name;

    const label = document.createElement("label");
    label.htmlFor = name;
    label.innerHTML = `${labelText}${required ? ' <span class="required">*</span>' : ""}`;
    wrap.appendChild(label);
    return wrap;
  }

  function createTextField(options) {
    const {
      label,
      name,
      required = false,
      type = "text",
      inputMode,
      autocomplete,
      placeholder,
      addressField = false,
      conditionalOn,
      conditionalValue,
    } = options;

    const wrap = createFieldWrap(label, name, required);
    const input = document.createElement("input");
    input.id = name;
    input.name = name;
    input.type = /dob/i.test(name) && type === "date" ? "text" : type;
    input.placeholder = placeholder || (/dob/i.test(name) ? "MM/DD/YYYY" : "");
    if (inputMode) input.inputMode = inputMode;
    if (autocomplete) input.autocomplete = autocomplete;
    if (required) input.required = true;

    if (addressField) input.dataset.addressField = "true";

    if (name.toLowerCase().includes("phone")) {
      input.dataset.phoneField = "true";
      input.maxLength = 14;
      input.inputMode = "tel";
      input.autocomplete = input.autocomplete || "tel";
    }

    if (/zip/i.test(name)) {
      input.dataset.zipField = "true";
      input.maxLength = 10;
      input.inputMode = "numeric";
    }

    if (/dob/i.test(name)) {
      input.dataset.dobField = "true";
      input.maxLength = 10;
      input.inputMode = "numeric";
      input.autocomplete = "bday";
    }

    if (conditionalOn && conditionalValue) {
      input.dataset.conditionalOn = conditionalOn;
      input.dataset.conditionalValue = conditionalValue;
      wrap.classList.add("hidden");
    }

    wrap.appendChild(input);
    return wrap;
  }

  function createSelectField(options) {
    const { label, name, required = false, options: selectOptions, conditionalOn, conditionalValue } = options;
    const wrap = createFieldWrap(label, name, required);
    const select = document.createElement("select");
    select.id = name;
    select.name = name;
    if (required) select.required = true;
    if (conditionalOn && conditionalValue) {
      select.dataset.conditionalOn = conditionalOn;
      select.dataset.conditionalValue = conditionalValue;
      wrap.classList.add("hidden");
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select an option";
    select.appendChild(placeholder);

    selectOptions.forEach((optionValue) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue;
      select.appendChild(option);
    });

    wrap.appendChild(select);
    return wrap;
  }

  function createCheckboxField(options) {
    const {
      label,
      name,
      required = false,
      description,
      descriptionHtml,
      links = [],
      requireLinksViewed = false,
      conditionalOn,
      conditionalValue,
    } = options;
    const wrap = document.createElement("div");
    wrap.className = "field-group";
    if (conditionalOn && conditionalValue) {
      wrap.dataset.conditionalOn = conditionalOn;
      wrap.dataset.conditionalValue = conditionalValue;
      wrap.classList.add("hidden");
    }

    const labelEl = document.createElement("label");
    labelEl.className = "toggle-label";
    labelEl.htmlFor = name;
    labelEl.textContent = label;

    const choice = document.createElement("label");
    choice.className = "inline-toggle";

    const input = document.createElement("input");
    input.id = name;
    input.name = name;
    input.type = "checkbox";
    if (required) input.required = true;

    let allLinksViewed = !requireLinksViewed;
    if (requireLinksViewed) {
      input.disabled = true;
      input.checked = false;
    }

    const text = document.createElement("span");
    if (descriptionHtml) {
      text.innerHTML = descriptionHtml;
    } else {
      text.textContent = description || "I agree";
    }

    choice.append(input, text);

    wrap.append(labelEl, choice);

    const trackedLinks = [];

    if (Array.isArray(links) && links.length > 0) {
      const linkRow = document.createElement("p");
      linkRow.className = "agreement-doc-links";

      links.forEach((linkData, index) => {
        const anchor = document.createElement("a");
        anchor.href = linkData.href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = linkData.text;
        trackedLinks.push(anchor);

        linkRow.appendChild(anchor);

        if (index < links.length - 1) {
          const separator = document.createElement("span");
          separator.textContent = " | ";
          linkRow.appendChild(separator);
        }
      });

      wrap.appendChild(linkRow);
    }

    const inlineLinks = Array.from(text.querySelectorAll("a"));
    if (inlineLinks.length > 0) {
      trackedLinks.push(...inlineLinks);
    }

    if (requireLinksViewed && trackedLinks.length > 0) {
      const viewedState = new Array(trackedLinks.length).fill(false);
      const status = document.createElement("p");
      status.className = "agreement-doc-status";
      status.setAttribute("aria-live", "polite");
      status.textContent =
        trackedLinks.length === 1
          ? "Open the linked document to enable this checkbox."
          : "Open each linked document to enable this checkbox.";

      trackedLinks.forEach((anchor, index) => {
        anchor.addEventListener("click", () => {
          viewedState[index] = true;
          allLinksViewed = viewedState.every(Boolean);
          if (allLinksViewed) {
            input.disabled = false;
            status.textContent = "All required documents viewed. You can now check this box.";
          } else {
            const remaining = viewedState.filter((isViewed) => !isViewed).length;
            status.textContent =
              remaining === 1
                ? "Open the remaining document to enable this checkbox."
                : `Open ${remaining} more documents to enable this checkbox.`;
          }
        });
      });

      wrap.appendChild(status);
    }

    if (requireLinksViewed && trackedLinks.length === 0) {
      input.disabled = false;
    }

    return wrap;
  }

  function createCheckboxGroupField(options) {
    const { label, name, required = false, options: values, conditionalOn, conditionalValue } = options;
    const wrap = document.createElement("div");
    wrap.className = "field-group";
    if (required) wrap.dataset.requiredGroup = name;
    if (conditionalOn && conditionalValue) {
      wrap.dataset.conditionalOn = conditionalOn;
      wrap.dataset.conditionalValue = conditionalValue;
      wrap.classList.add("hidden");
    }

    const heading = document.createElement("label");
    heading.className = "toggle-label";
    heading.textContent = `${label}${required ? " *" : ""}`;
    wrap.appendChild(heading);

    const container = document.createElement("div");
    container.className = "checkbox-group";

    values.forEach((optionText, index) => {
      const option = document.createElement("label");
      option.className = "checkbox-group-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = `${name}[]`;
      input.value = optionText;
      input.id = `${name}-${index}`;
      const text = document.createElement("span");
      text.textContent = optionText;
      option.append(input, text);
      container.appendChild(option);
    });

    wrap.appendChild(container);
    return wrap;
  }

  function createAgreementSigningField(options) {
    const {
      title,
      agreementUrl,
      signerNameLabel,
      consentName,
      printedNameName,
    } = options;

    const wrap = document.createElement("div");
    wrap.className = "field-group agreement-signing-block";

    const heading = document.createElement("h3");
    heading.className = "agreement-signing-title";
    heading.textContent = title;

    const controls = document.createElement("div");
    controls.className = "agreement-view-controls";
    controls.innerHTML = `
      <a href="${agreementUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">View Complete Agreement</a>
      <a href="${agreementUrl}" download class="btn btn-ghost btn-sm">Download Original Agreement</a>
    `;

    const viewer = document.createElement("iframe");
    viewer.className = "agreement-viewer";
    viewer.src = agreementUrl;
    viewer.title = `${title} Viewer`;

    const printedNameWrap = createFieldWrap(signerNameLabel, printedNameName, true);
    const printedNameInput = document.createElement("input");
    printedNameInput.type = "text";
    printedNameInput.id = printedNameName;
    printedNameInput.name = printedNameName;
    printedNameInput.required = true;
    printedNameInput.autocomplete = "name";
    printedNameWrap.appendChild(printedNameInput);

    const consentWrap = document.createElement("div");
    consentWrap.className = "agreement-consent-wrap";
    const consentChoice = document.createElement("label");
    consentChoice.className = "inline-toggle";

    const consentInput = document.createElement("input");
    consentInput.type = "checkbox";
    consentInput.id = consentName;
    consentInput.name = consentName;
    consentInput.required = true;

    const consentText = document.createElement("span");
    consentText.textContent = ELECTRONIC_CONSENT_TEXT;

    consentChoice.append(consentInput, consentText);
    consentWrap.appendChild(consentChoice);

    wrap.append(
      heading,
      controls,
      viewer,
      printedNameWrap,
      consentWrap,
    );

    return wrap;
  }

  function createToggle(options) {
    const { label, name, checked = false } = options;
    const wrap = document.createElement("div");
    wrap.className = "field-group";

    const choice = document.createElement("label");
    choice.className = "inline-toggle";

    const input = document.createElement("input");
    input.id = name;
    input.name = name;
    input.type = "checkbox";
    input.checked = checked;

    const text = document.createElement("span");
    text.textContent = label;

    choice.append(input, text);
    wrap.append(choice);
    return wrap;
  }

  function wireEvents() {
    form.addEventListener("submit", handleFlowSubmit);
    backBtn?.addEventListener("click", goBack);
    nextBtn?.addEventListener("click", goNext);

    form.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;

      clearFieldValidationState(target);

      if (target.dataset.phoneField === "true") formatPhoneField(target);
      if (target.dataset.dobField === "true") formatDobField(target);
      if (target.dataset.zipField === "true") formatZipField(target);

      if (target.name === "emergencySameAsParent") {
        const emergencyFields = form.querySelector('[data-emergency-fields="true"]');
        if (emergencyFields) emergencyFields.classList.toggle("hidden", target.checked);
      }

      if (target.name === "p1Race" || target.name === "p2Race" || target.name === "p3Race" || target.name === "p4Race") {
        syncConditionalFields(target.name, target.value);
      }

      if (target.name === "scholarshipRequested") {
        applyVisibility();
        updateFlowMeta();
        renderWizard();
      }

      if (target.name === "helpChoice") {
        updateFlowMeta();
        renderWizard();
      }

      if (playerToggleNames.includes(target.name)) {
        applyVisibility();
        renderWizard();
      }

      if (
        ["parentFirstName", "parentLastName", "volFirstName", "volLastName"].includes(target.name)
      ) {
        syncAgreementPrefills();
      }

      updateScholarshipAgreementPreview();

      if (["volHasExperience", "coachHasExperience"].includes(target.name)) {
        updateExperienceSummaryRequirements();
      }
    });

    form.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
      if (playerToggleNames.includes(target.name) || target.name === "emergencySameAsParent") {
        applyVisibility();
        renderWizard();
      }
      if (["volHasExperience", "coachHasExperience"].includes(target.name)) {
        updateExperienceSummaryRequirements();
      }
      updateScholarshipAgreementPreview();
    });

    form.addEventListener("blur", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
      normalizeFieldValue(target);
      validateField(target, { showMessage: false });
    }, true);
  }

  function updateScholarshipAgreementPreview() {
    const pages = document.getElementById("scholarship-agreement-pages");
    const participantIdentity = document.getElementById("scholarship-identity-participants");
    const gradeIdentity = document.getElementById("scholarship-identity-grades");
    const parentIdentity = document.getElementById("scholarship-identity-parent");
    const acceptanceParent = document.getElementById("scholarship-acceptance-parent");
    const acceptanceParticipants = document.getElementById("scholarship-acceptance-participants");
    if (!pages) return;

    const parentName = [getTextValue("parentFirstName"), getTextValue("parentLastName")].filter(Boolean).join(" ").trim() || "Parent/Guardian";
    const participantCards = collectRegistrationPlayersPreview();
    const participantNames = participantCards.map((participant) => participant.name || "Participant");
    const participantGrades = participantCards
      .map((participant) => formatScholarshipDivisionLabel(participant.grade, participant.gender))
      .filter(Boolean);
    const acceptedDate = formatScholarshipAgreementPreviewDate(new Date());

    if (participantIdentity) participantIdentity.textContent = participantNames.join(", ") || "Participant";
    if (gradeIdentity) gradeIdentity.textContent = participantGrades.join(", ") || "Not provided";
    if (parentIdentity) parentIdentity.textContent = parentName;
    if (acceptanceParent) acceptanceParent.textContent = parentName;
    if (acceptanceParticipants) acceptanceParticipants.textContent = participantNames.join(", ") || "the listed participant(s)";

    if (!participantCards.length) {
      pages.innerHTML = '<div class="scholarship-agreement-page"><p class="scholarship-agreement-empty">Add at least one participant above to preview the completed scholarship document.</p></div>';
      return;
    }

    pages.innerHTML = participantCards.map((participant, index) => {
      const safeName = escapeInlineHtml(participant.name || "Participant");
      const safeGrade = escapeInlineHtml(formatScholarshipDivisionLabel(participant.grade, participant.gender) || "Not provided");
      const safeParent = escapeInlineHtml(parentName);
      const safeDate = escapeInlineHtml(acceptedDate);
      return [
        '<article class="scholarship-agreement-page">',
        `<div class="scholarship-agreement-page__label">Participant Copy ${index + 1}</div>`,
        '<div class="scholarship-agreement-page__ack">',
        '<p class="scholarship-agreement-page__line">Player: <span>' + safeName + '</span>     Grade: <span>' + safeGrade + '</span></p>',
        '<p class="scholarship-agreement-page__line">Parent/Guardian: <span>' + safeParent + '</span>     Date: <span>' + safeDate + '</span></p>',
        '</div>',
        '</article>',
      ].join("");
    }).join("");
  }

  function collectRegistrationPlayersPreview() {
    const players = [];
    for (let index = 1; index <= 4; index += 1) {
      const firstName = getTextValue(`p${index}FirstName`);
      const lastName = getTextValue(`p${index}LastName`);
      const grade = getTextValue(`p${index}Grade`);
      const gender = getTextValue(`p${index}Gender`);
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (!fullName && !grade) continue;
      players.push({ name: fullName || `Player ${index}`, grade, gender });
    }
    return players;
  }

  function formatScholarshipDivisionLabel(grade, gender) {
    const normalizedGrade = String(grade || "").trim();
    const normalizedGender = String(gender || "").trim();
    if (!normalizedGrade) return normalizedGender;
    if (/\b(Boys|Girls)\b/i.test(normalizedGrade)) return normalizedGrade;
    if (/^(Male|Boy|Boys)$/i.test(normalizedGender)) return `${normalizedGrade} Boys`;
    if (/^(Female|Girl|Girls)$/i.test(normalizedGender)) return `${normalizedGrade} Girls`;
    return normalizedGrade;
  }

  function formatScholarshipAgreementPreviewDate(date) {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  }

  function escapeInlineHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function updateExperienceSummaryRequirements() {
    setConditionalRequired("volHasExperience", "volExperienceSummary");
    setConditionalRequired("coachHasExperience", "coachExperienceSummary");
  }

  function setConditionalRequired(controllerName, targetName) {
    const controller = form.elements.namedItem(controllerName);
    const target = form.elements.namedItem(targetName);
    if (!(controller instanceof HTMLInputElement || controller instanceof HTMLSelectElement)) return;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;

    const requiresSummary = controller.value === "Yes";
    target.required = requiresSummary;
    if (!requiresSummary) {
      target.setCustomValidity("");
    }
  }

  function getFlowOptions() {
    if (lockedFlowOptions) return lockedFlowOptions;
    return {
      standaloneFlow,
      scholarshipRequested: getTextValue("scholarshipRequested"),
      helpChoice: normalizeHelpChoice(getTextValue("helpChoice")),
    };
  }

  function lockFlowOptionsFromRegistration(registrationData) {
    lockedFlowOptions = {
      standaloneFlow,
      scholarshipRequested: registrationData?.scholarship?.requested || "No",
      helpChoice: normalizeHelpChoice(registrationData?.helpChoice || HELP_OPTION.NO),
    };
  }

  function getRequiredStagesForCurrentFlow() {
    return buildRequiredStages(getFlowOptions());
  }

  function getCurrentStage() {
    const stages = getRequiredStagesForCurrentFlow();
    return stages[activeStageIndex] || STAGES.THANK_YOU;
  }

  function getStageMeta(stage) {
    return STAGE_META[stage] || STAGE_META[STAGES.PLAYER_REGISTRATION];
  }

  function includePlayerSectionByCondition(sectionId) {
    if (sectionId === "player-section-2") return getTextValue("addPlayer2") === "Yes";
    if (sectionId === "player-section-3") return getTextValue("addPlayer2") === "Yes" && getTextValue("addPlayer3") === "Yes";
    if (sectionId === "player-section-4") {
      return (
        getTextValue("addPlayer2") === "Yes" &&
        getTextValue("addPlayer3") === "Yes" &&
        getTextValue("addPlayer4") === "Yes"
      );
    }
    return true;
  }

  function getSectionsForStage(stage) {
    const ids = STAGE_SECTION_IDS[stage] || [];
    return ids
      .map((sectionId) => document.getElementById(sectionId))
      .filter(Boolean)
      .filter((section) => {
        if (stage === STAGES.PLAYER_REGISTRATION && !includePlayerSectionByCondition(section.id)) {
          return false;
        }
        return !section.classList.contains("hidden");
      });
  }

  function getVisibleSections() {
    return getSectionsForStage(getCurrentStage());
  }

  function getActiveSectionId() {
    const visible = getVisibleSections();
    return visible[activeSectionIndex]?.id || "";
  }

  function setActiveSectionById(sectionId) {
    if (!sectionId) return;
    const visible = getVisibleSections();
    const index = visible.findIndex((section) => section.id === sectionId);
    if (index >= 0) {
      activeSectionIndex = index;
    }
  }

  function alignActiveSection(previousId) {
    const visible = getVisibleSections();
    if (!visible.length) {
      activeSectionIndex = 0;
      return;
    }

    if (previousId) {
      const sameIndex = visible.findIndex((section) => section.id === previousId);
      if (sameIndex >= 0) {
        activeSectionIndex = sameIndex;
        return;
      }
    }

    if (activeSectionIndex >= visible.length) activeSectionIndex = visible.length - 1;
    if (activeSectionIndex < 0) activeSectionIndex = 0;
  }

  function applyVisibility() {
    const previousId = getActiveSectionId();
    const emergencySameAsParent = getCheckboxValue("emergencySameAsParent");
    const emergencyFields = form.querySelector('[data-emergency-fields="true"]');
    if (emergencyFields) emergencyFields.classList.toggle("hidden", emergencySameAsParent);

    syncConditionalFields("p1Race", getTextValue("p1Race"));
    syncConditionalFields("p2Race", getTextValue("p2Race"));
    syncConditionalFields("p3Race", getTextValue("p3Race"));
    syncConditionalFields("p4Race", getTextValue("p4Race"));

    alignActiveSection(previousId);
  }

  function renderWizard() {
    const stage = getCurrentStage();
    if (stage === STAGES.THANK_YOU || (stage === STAGES.PAYMENT && !form.hidden)) {
      renderSuccessStage();
      return;
    }

    form.hidden = false;
    successPanel.hidden = true;

    const previousId = getActiveSectionId();
    const visible = getVisibleSections();
    Array.from(sectionsRoot.querySelectorAll(".form-section")).forEach((section) => {
      section.classList.remove("is-current");
    });

    if (!visible.length) return;
    alignActiveSection(previousId);

    const currentSection = visible[activeSectionIndex];
    currentSection.classList.add("is-current");

    const current = activeSectionIndex + 1;
    const total = visible.length;
    const stages = getRequiredStagesForCurrentFlow();
    const pct = Math.max(1, Math.round(((activeStageIndex + 1) / stages.length) * 100));
    if (progressFill) progressFill.style.width = `${pct}%`;

    const meta = getStageMeta(stage);
    if (progressText) {
      progressText.textContent = `${meta.progressLabel} — Step ${activeStageIndex + 1} of ${stages.length} · Section ${current} of ${total}`;
    }

    if (backBtn) backBtn.disabled = isSubmittingStage || activeSectionIndex === 0;
    if (nextBtn) {
      const isLast = activeSectionIndex === total - 1;
      nextBtn.textContent = isLast ? meta.submitLabel : "Next Section";
      nextBtn.disabled = isSubmittingStage;
    }
    if (skipBtn) {
      skipBtn.hidden = true;
      skipBtn.disabled = true;
    }
  }

  function updateFlowMeta() {
    const meta = getStageMeta(getCurrentStage());
    if (formTitle) formTitle.textContent = meta.title;
    if (formSubtitle) formSubtitle.innerHTML = meta.subtitle;
    updatePaymentPageNote();
  }

  function goBack() {
    if (isSubmittingStage) return;
    if (activeSectionIndex > 0) {
      activeSectionIndex -= 1;
      formMessage.textContent = "";
      renderWizard();
    }
  }

  function goNext() {
    if (isSubmittingStage) return;
    formMessage.textContent = "";
    const visible = getVisibleSections();
    if (!visible.length) return;

    const current = visible[activeSectionIndex];
    const invalid = validateSection(current);
    if (invalid) {
      const label =
        invalid.closest(".field-group")?.querySelector("label")?.textContent ||
        "this field";
      const customMessage =
        typeof invalid.validationMessage === "string"
          ? invalid.validationMessage.trim()
          : "";
      formMessage.textContent =
        customMessage || `Please complete ${label.replace(" *", "")}.`;
      invalid.focus?.();
      return;
    }

    const onFinalSection = activeSectionIndex >= visible.length - 1;
    if (onFinalSection) {
      form.requestSubmit();
      return;
    }

    activeSectionIndex += 1;
    renderWizard();
  }

  function normalizeFieldValue(field) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;

    const name = String(field.name || "");
    if (!name || field.type === "checkbox" || field.type === "radio") return;

    if (field.dataset.phoneField === "true") {
      field.value = formatUsPhone(field.value);
      return;
    }

    if (field.dataset.dobField === "true") {
      field.value = formatDobText(field.value);
      return;
    }

    if (field.dataset.zipField === "true") {
      field.value = formatUsZip(field.value);
      return;
    }

    if (EMAIL_FIELD_NAMES.has(name) || field.type === "email") {
      field.value = normalizeEmailValue(field.value);
      return;
    }

    if (NAME_FIELD_PATTERN.test(name)) {
      field.value = normalizeNameValue(field.value);
      return;
    }

    if (name.toLowerCase().includes("street")) {
      splitAddressFieldIfNeeded(field);
      field.value = collapseSpaces(field.value);
      return;
    }

    field.value = collapseSpaces(field.value);
  }

  function validateField(field, { showMessage = true } = {}) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return "";

    clearFieldValidationState(field);

    if (field.closest(".hidden")) return "";

    const value = String(field.value || "").trim();

    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      if (field.required && !field.checked) {
        return setFieldValidationError(field, "This acknowledgement is required.", showMessage);
      }
      return "";
    }

    if (field.required && !value) {
      return setFieldValidationError(field, "This field is required.", showMessage);
    }

    if (!value) return "";

    if (field.dataset.dobField === "true") {
      const rawDob = parseUsDateParts(value);
      if (rawDob && rawDob > startOfLocalDay(new Date())) {
        return setFieldValidationError(field, "Date of birth cannot be in the future.", showMessage);
      }

      const parsed = parseUsDate(value);
      if (!parsed) {
        return setFieldValidationError(field, "Enter a valid date of birth in MM/DD/YYYY format.", showMessage);
      }

      if (field.name === "parentGuardianDob" || field.name === "volDob") {
        if (!isAtLeastAge(parsed, 18)) {
          return setFieldValidationError(field, "The parent/guardian must be at least 18 years old.", showMessage);
        }
      }

      if (/^p[1-4]Dob$/.test(field.name) && !isUnderAge(parsed, 18)) {
        return setFieldValidationError(field, "Participants must be under 18 years old. Please verify the date of birth.", showMessage);
      }
    }

    if (field.dataset.phoneField === "true" && !isValidNanpPhone(value)) {
      return setFieldValidationError(
        field,
        "Enter a valid 10-digit U.S./Canada phone number.",
        showMessage,
      );
    }

    if (field.dataset.zipField === "true" && !/^\d{5}(?:-\d{4})?$/.test(value)) {
      return setFieldValidationError(field, "Enter a valid ZIP code (12345 or 12345-6789).", showMessage);
    }

    if ((field.type === "email" || EMAIL_FIELD_NAMES.has(field.name)) && !isValidEmailValue(value)) {
      return setFieldValidationError(field, "Enter a valid email address.", showMessage);
    }

    if (NAME_FIELD_PATTERN.test(field.name) && !isValidPersonName(value)) {
      return setFieldValidationError(
        field,
        "Enter a valid name using letters, spaces, apostrophes, periods, or hyphens.",
        showMessage,
      );
    }

    if (
      ["parentState", "emergencyState", "volState"].includes(field.name) &&
      !STATE_ABBREVIATIONS.includes(value.toUpperCase())
    ) {
      return setFieldValidationError(field, "Select a valid U.S. state or territory.", showMessage);
    }

    return "";
  }

  function setFieldValidationError(field, message, showMessage) {
    field.setCustomValidity(message);
    markFieldInvalid(field, message);
    if (showMessage && formMessage) formMessage.textContent = "Please correct the highlighted information below.";
    return message;
  }

  function markFieldInvalid(field, message) {
    field.setAttribute("aria-invalid", "true");
    const wrap = field.closest(".field-group");
    if (!wrap) return;

    let error = wrap.querySelector(".field-error");
    if (!error) {
      error = document.createElement("p");
      error.className = "field-error";
      error.setAttribute("role", "alert");
      error.id = `${field.id || field.name || "field"}-error`;
      wrap.appendChild(error);
    }
    field.setAttribute("aria-describedby", error.id);
    error.textContent = message;
  }

  function clearFieldValidationState(field) {
    if (typeof field.setCustomValidity === "function") field.setCustomValidity("");
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
    const error = field.closest(".field-group")?.querySelector(".field-error");
    if (error) error.remove();
  }

  function parseUsDateParts(value) {
    const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;

    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;

    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  function parseUsDate(value) {
    const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;

    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);

    if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;

    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }

    const today = startOfLocalDay(new Date());
    if (date > today) return null;

    return date;
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function isAtLeastAge(dob, age) {
    const today = startOfLocalDay(new Date());
    const threshold = new Date(
      today.getFullYear() - age,
      today.getMonth(),
      today.getDate(),
    );
    return dob <= threshold;
  }

  function isUnderAge(dob, age) {
    return !isAtLeastAge(dob, age);
  }

  function formatDobText(value) {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }

  function formatUsPhone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    digits = digits.slice(0, 10);

    if (digits.length === 0) return "";
    if (digits.length <= 3) return `(${digits}`;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function isValidNanpPhone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    if (!/^\d{10}$/.test(digits)) return false;

    const area = digits.slice(0, 3);
    const exchange = digits.slice(3, 6);

    if (/^[01]/.test(area) || /^[01]/.test(exchange)) return false;

    return true;
  }

  function formatUsZip(value) {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 9);
    if (digits.length <= 5) return digits;
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }

  function normalizeEmailValue(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isValidEmailValue(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || "").trim());
  }

  function normalizeNameValue(value) {
    return collapseSpaces(value)
      .replace(/\s*([-'])\s*/g, "$1")
      .trim();
  }

  function isValidPersonName(value) {
    const normalized = normalizeNameValue(value);
    if (normalized.length < 2 || normalized.length > 80) return false;
    if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(normalized)) return false;
    return /^[A-Za-zÀ-ÖØ-öø-ÿ.'’\-\s]+$/.test(normalized);
  }

  function collapseSpaces(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function splitAddressFieldIfNeeded(streetField) {
    const raw = collapseSpaces(streetField.value);
    if (!raw || !raw.includes(",")) return;

    const prefix = streetField.name.replace(/Street$/, "");
    const cityField = form.elements.namedItem(`${prefix}City`);
    const stateField = form.elements.namedItem(`${prefix}State`);
    const zipField = form.elements.namedItem(`${prefix}Zip`);

    if (
      !(cityField instanceof HTMLInputElement || cityField instanceof HTMLSelectElement) ||
      !(stateField instanceof HTMLInputElement || stateField instanceof HTMLSelectElement) ||
      !(zipField instanceof HTMLInputElement || zipField instanceof HTMLSelectElement)
    ) {
      return;
    }

    if (cityField.value.trim() || stateField.value.trim() || zipField.value.trim()) return;

    const match = raw.match(
      /^(.*?),\s*([^,]+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/,
    );
    if (!match) return;

    const state = match[3].toUpperCase();
    if (!STATE_ABBREVIATIONS.includes(state)) return;

    streetField.value = collapseSpaces(match[1]);
    cityField.value = collapseSpaces(match[2]);
    stateField.value = state;
    zipField.value = formatUsZip(match[4]);
  }

  function findDuplicatePlayerField() {
    const playerCount = selectedPlayerCount();
    const seen = new Map();

    for (let index = 1; index <= playerCount; index += 1) {
      const first = normalizeNameValue(getTextValue(`p${index}FirstName`)).toLowerCase();
      const last = normalizeNameValue(getTextValue(`p${index}LastName`)).toLowerCase();
      const dob = formatDobText(getTextValue(`p${index}Dob`));

      if (!first || !last || !dob) continue;

      const key = `${first}|${last}|${dob}`;
      if (seen.has(key)) {
        const field = form.elements.namedItem(`p${index}FirstName`);
        if (field instanceof HTMLInputElement) {
          setFieldValidationError(
            field,
            `This participant appears to be the same as Player ${seen.get(key)}. Please check the name and date of birth before continuing.`,
            true,
          );
          return field;
        }
      }

      seen.set(key, index);
    }

    return null;
  }

  function validateSection(section) {
    if (!section) return null;

    const fields = Array.from(
      section.querySelectorAll("input, select, textarea"),
    ).filter((field) => !field.closest(".hidden"));

    for (const field of fields) {
      normalizeFieldValue(field);
      const error = validateField(field, { showMessage: false });
      if (error) return field;
    }

    const groups = Array.from(section.querySelectorAll("[data-required-group]"));
    for (const group of groups) {
      if (group.closest(".hidden")) continue;
      const key = group.dataset.requiredGroup;
      if (!key) continue;
      const checked = group.querySelectorAll(`input[name="${key}[]"]:checked`).length;
      if (!checked) {
        const first = group.querySelector(`input[name="${key}[]"]`);
        if (first instanceof HTMLInputElement) {
          first.setCustomValidity("Select at least one option.");
          markFieldInvalid(first, "Select at least one option.");
        }
        return first;
      }
    }

    if (/^player-section-\d+$/.test(section.id)) {
      const duplicateField = findDuplicatePlayerField();
      if (duplicateField) return duplicateField;
    }

    return null;
  }

  async function handleFlowSubmit(event) {
    event.preventDefault();
    formMessage.textContent = "";

    try {
      isSubmittingStage = true;
      renderWizard();

      const stage = getCurrentStage();

      const stageSections = getSectionsForStage(stage);
      for (let index = 0; index < stageSections.length; index += 1) {
        const invalid = validateSection(stageSections[index]);
        if (invalid) {
          activeSectionIndex = index;
          renderWizard();
          const message =
            typeof invalid.validationMessage === "string"
              ? invalid.validationMessage.trim()
              : "";
          formMessage.textContent = "Please correct the highlighted information below.";
          invalid.focus?.();
          return;
        }
      }

      if (registrationResumeState?.testMode) {
        await simulateRegistrationResumeTestStage(stage);
        return;
      }

      if (stage === STAGES.PLAYER_REGISTRATION) {
        await submitPlayerRegistrationStage();
      } else if (stage === STAGES.PLAYER_AGREEMENT) {
        await submitPlayerAgreementStage();
      } else if (stage === STAGES.SCHOLARSHIP_APPLICATION) {
        await submitScholarshipApplicationStage();
      } else if (stage === STAGES.VOLUNTEER_APPLICATION) {
        await submitVolunteerApplicationStage();
      } else if (stage === STAGES.COACHING_APPLICATION) {
        await submitCoachingApplicationStage();
      } else if (stage === STAGES.VOLUNTEER_AGREEMENT) {
        await submitVolunteerAgreementStage();
      }
    } catch (error) {
      const message = String(error?.message || "").trim();
      setSubmissionStatus(getCurrentStage(), "error", message || "Submission failed. Please retry in a moment.");
    } finally {
      isSubmittingStage = false;
      renderWizard();
    }
  }

  async function simulateRegistrationResumeTestStage(stage) {
    setSubmissionStatus(stage, "submitting");

    if (stage === STAGES.PLAYER_REGISTRATION) {
      const data = collectRegistrationData();
      data.registrationSubmissionId = registrationSubmissionId;
      completedRegistrationData = data;
      playerSubmitted = true;
      prefillVolunteerContact();
      lockFlowOptionsFromRegistration(data);
    } else if (stage === STAGES.PLAYER_AGREEMENT) {
      playerAgreementSigned = true;
    } else if (stage === STAGES.SCHOLARSHIP_APPLICATION) {
      if (completedRegistrationData) completedRegistrationData.scholarship = collectScholarshipApplicationData();
      scholarshipSubmitted = true;
    } else if (stage === STAGES.VOLUNTEER_APPLICATION) {
      completedVolunteerData = collectVolunteerData();
      volunteerSubmissionId = volunteerSubmissionId || "test-volunteer";
      volunteerSubmitted = true;
    } else if (stage === STAGES.COACHING_APPLICATION) {
      completedCoachingData = collectCoachingData();
      coachingSubmissionId = coachingSubmissionId || "test-coach";
      coachingSubmitted = true;
    } else if (stage === STAGES.VOLUNTEER_AGREEMENT) {
      volunteerAgreementSigned = Boolean(completedVolunteerData);
      coachingAgreementSigned = Boolean(completedCoachingData);
    }

    setSubmissionStatus(stage, "idle");
    await advanceAfterStageSuccess(stage);
  }

  function setSubmissionStatus(stage, state, optionalError, details) {
    if (!flowStatus) return;

    if (state === "idle") {
      flowStatus.hidden = true;
      flowStatus.textContent = "";
      if (optionalError !== false) {
        formMessage.textContent = "";
      }
      return;
    }

    const playerNames = Array.isArray(details?.playerNames) ? details.playerNames : [];
    const currentIndex = Number(details?.currentIndex || 0);
    const totalCount = Number(details?.totalCount || 0);

    const runningMessages = {
      [STAGES.PLAYER_REGISTRATION]: "Submitting your player registration. Please don’t close this window.",
      [STAGES.PLAYER_AGREEMENT]: "Generating and recording your Player Agreement. Please don’t close this window.",
      [STAGES.SCHOLARSHIP_APPLICATION]: playerNames.length && currentIndex > 0 && totalCount > 0
        ? `Recording the scholarship application for ${playerNames[currentIndex - 1]} (${currentIndex} of ${totalCount}). Please don’t close this window.`
        : "Submitting your scholarship application. Please don’t close this window.",
      [STAGES.VOLUNTEER_APPLICATION]: "Submitting your volunteer application. Please don’t close this window.",
      [STAGES.COACHING_APPLICATION]: "Submitting your coaching application. Please don’t close this window.",
      [STAGES.VOLUNTEER_AGREEMENT]: "Generating and recording your Volunteer Agreement. Please don’t close this window.",
      [STAGES.FINAL_CONFIRMATION_EMAIL]: "Finalizing your submission and preparing your confirmation email. Please don’t close this window.",
      [STAGES.PAYMENT]: "Your forms have been submitted successfully. Continue to secure payment to finish the player registration.",
    };

    const stageLabels = {
      [STAGES.PLAYER_REGISTRATION]: "player registration",
      [STAGES.PLAYER_AGREEMENT]: "Player Agreement",
      [STAGES.SCHOLARSHIP_APPLICATION]: "scholarship application",
      [STAGES.VOLUNTEER_APPLICATION]: "volunteer application",
      [STAGES.COACHING_APPLICATION]: "coaching application",
      [STAGES.VOLUNTEER_AGREEMENT]: "Volunteer Agreement",
      [STAGES.FINAL_CONFIRMATION_EMAIL]: "confirmation email",
    };

    flowStatus.hidden = false;
    if (state === "submitting") {
      flowStatus.textContent = runningMessages[stage] || "Submitting your form. Please don’t close this window.";
      formMessage.textContent = "";
      return;
    }

    const stageLabel = stageLabels[stage] || "submission";
    const friendlyError = optionalError || `We couldn’t record your ${stageLabel}. Your previous information is saved. Please select Retry to continue.`;
    flowStatus.textContent = friendlyError;
    formMessage.textContent = friendlyError;
  }

  function advanceToStage(stage) {
    const stages = getRequiredStagesForCurrentFlow();
    const index = stages.indexOf(stage);
    if (index >= 0) {
      activeStageIndex = index;
      activeSectionIndex = 0;
      updateFlowMeta();
      applyVisibility();
    }
  }

  async function advanceAfterStageSuccess(stage) {
    if (stage === STAGES.PLAYER_AGREEMENT && registrationResumeState?.context?.resume?.agreementOnly) {
      advanceToStage(STAGES.THANK_YOU);
      return;
    }

    if (stage === STAGES.PLAYER_REGISTRATION) {
      lockFlowOptionsFromRegistration(completedRegistrationData);
    }

    const stages = getRequiredStagesForCurrentFlow();
    const currentIndex = stages.indexOf(stage);
    const nextStage = stages[currentIndex + 1];

    if (!nextStage) {
      advanceToStage(STAGES.THANK_YOU);
      return;
    }

    if (nextStage === STAGES.FINAL_CONFIRMATION_EMAIL) {
      await finalizeFlowConfirmationStage();
      return;
    }

    advanceToStage(nextStage);
  }

  async function submitPlayerRegistrationStage() {
    if (playerSubmitted) return;

    setSubmissionStatus(STAGES.PLAYER_REGISTRATION, "submitting");
    registrationSyncWarning = "";

    const registrationData = collectRegistrationData();
    registrationSubmissionId = registrationSubmissionId || generateSubmissionId("reg");
    registrationData.registrationSubmissionId = registrationSubmissionId;
    const params = new URLSearchParams();

    appendIfPresent(params, PARENT_ENTRY_MAP.firstName, registrationData.parent.firstName);
    appendIfPresent(params, PARENT_ENTRY_MAP.lastName, registrationData.parent.lastName);
    appendIfPresent(params, PARENT_ENTRY_MAP.email, registrationData.parent.email);
    appendIfPresent(params, PARENT_ENTRY_MAP.phone, registrationData.parent.phone);
    appendIfPresent(params, PARENT_ENTRY_MAP.street, registrationData.parent.street);
    appendIfPresent(params, PARENT_ENTRY_MAP.apt, registrationData.parent.apt);
    appendIfPresent(params, PARENT_ENTRY_MAP.city, registrationData.parent.city);
    appendIfPresent(params, PARENT_ENTRY_MAP.state, registrationData.parent.state);
    appendIfPresent(params, PARENT_ENTRY_MAP.zip, registrationData.parent.zip);

    registrationData.players.forEach((player, idx) => {
      const entryMap = PLAYER_ENTRY_MAP[idx + 1];
      if (!entryMap) return;

      appendIfPresent(params, entryMap.firstName, player.firstName);
      appendIfPresent(params, entryMap.lastName, player.lastName);
      appendIfPresent(params, entryMap.dob, player.dob);
      appendIfPresent(params, entryMap.gender, player.gender);
      appendIfPresent(params, entryMap.grade, player.grade);
      appendIfPresent(params, entryMap.jersey, player.jersey);
      appendIfPresent(params, entryMap.shorts, player.shorts);
      appendIfPresent(params, entryMap.socks, player.socks);
      appendIfPresent(params, entryMap.race, player.race);
      appendIfPresent(params, entryMap.raceOther, player.raceOther);
      appendIfPresent(params, entryMap.favoriteClub, player.favoriteClub);
      appendIfPresent(params, entryMap.hearAbout, player.hearAbout);
      if (entryMap.addAnother) appendIfPresent(params, entryMap.addAnother, player.addAnother || "No");
    });

    appendIfPresent(
      params,
      AGREEMENT_ENTRY_MAP.waiver,
      registrationData.agreements.waiver
        ? "I have read and understand the MLS GO Player Registration Agreement and Waiver, accept its terms for myself and every participant listed in this registration, and intend to be legally bound."
        : "",
    );
    appendIfPresent(
      params,
      AGREEMENT_ENTRY_MAP.privacy,
      registrationData.agreements.privacy
        ? "I agree to the Terms of Service and consent to the use of my information in accordance with the Privacy Policy."
        : "",
    );
    appendIfPresent(
      params,
      AGREEMENT_ENTRY_MAP.marketing,
      registrationData.agreements.marketing
        ? "I agree that MLS GO, Major League Soccer, the MLS Clubs, Soccer United Marketing, MLS NEXT Pro, MLS NEXT and each of their respective clubs, affiliates and partners, can use my information to send me newsletters, offers, additional information and other communications about their products and initiatives in accordance with the Privacy Policy and Terms of Use."
        : "",
    );
    params.append("fvv", "1");
    params.append("draftResponse", "[]");
    params.append("pageHistory", "0");
    params.append("partialResponse", `[null,null,"${FBZX}"]`);
    params.append("fbzx", FBZX);

    await postRegistrationCopy(registrationData);
    registrationSyncWarning = "";

    if (ENABLE_GOOGLE_FORM_MIRROR) {
      // Mirror to Google Form as best-effort telemetry only.
      postFormResponse(params).catch((error) => {
        console.warn("Google Form mirror failed", error);
      });
    }

    completedRegistrationData = registrationData;
    playerSubmitted = true;
    prefillVolunteerContact();
    setSubmissionStatus(STAGES.PLAYER_REGISTRATION, "idle");
    await advanceAfterStageSuccess(STAGES.PLAYER_REGISTRATION);
  }

  async function submitPlayerAgreementStage() {
    if (playerAgreementSigned) {
      await advanceAfterStageSuccess(STAGES.PLAYER_AGREEMENT);
      return;
    }

    setSubmissionStatus(STAGES.PLAYER_AGREEMENT, "submitting");
    await generatePlayerAgreement(completedRegistrationData);
    playerAgreementSigned = true;
    setSubmissionStatus(STAGES.PLAYER_AGREEMENT, "idle");
    await advanceAfterStageSuccess(STAGES.PLAYER_AGREEMENT);
  }

  async function submitScholarshipApplicationStage() {
    if (scholarshipSubmitted) {
      await advanceAfterStageSuccess(STAGES.SCHOLARSHIP_APPLICATION);
      return;
    }

    setSubmissionStatus(STAGES.SCHOLARSHIP_APPLICATION, "submitting");

    completedRegistrationData.scholarship = collectScholarshipApplicationData();
    await postScholarshipCopy(completedRegistrationData);
    scholarshipSubmitted = true;
    setSubmissionStatus(STAGES.SCHOLARSHIP_APPLICATION, "idle");
    await advanceAfterStageSuccess(STAGES.SCHOLARSHIP_APPLICATION);
  }

  async function submitVolunteerApplicationStage() {
    if (volunteerSubmitted) {
      await advanceAfterStageSuccess(STAGES.VOLUNTEER_APPLICATION);
      return;
    }

    setSubmissionStatus(STAGES.VOLUNTEER_APPLICATION, "submitting");
    const data = collectVolunteerData();
    volunteerSubmissionId = volunteerSubmissionId || generateSubmissionId("vol");
    data.submission_id = volunteerSubmissionId;
    await postAuxFlow("volunteer_application", data);
    completedVolunteerData = data;
    volunteerSubmitted = true;
    setSubmissionStatus(STAGES.VOLUNTEER_APPLICATION, "idle");
    await advanceAfterStageSuccess(STAGES.VOLUNTEER_APPLICATION);
  }

  async function submitCoachingApplicationStage() {
    if (coachingSubmitted) {
      await advanceAfterStageSuccess(STAGES.COACHING_APPLICATION);
      return;
    }

    setSubmissionStatus(STAGES.COACHING_APPLICATION, "submitting");
    const data = collectCoachingData();
    coachingSubmissionId = coachingSubmissionId || generateSubmissionId("coach");
    data.submission_id = coachingSubmissionId;
    await postAuxFlow("coaching_application", data);
    completedCoachingData = data;
    coachingSubmitted = true;
    setSubmissionStatus(STAGES.COACHING_APPLICATION, "idle");
    await advanceAfterStageSuccess(STAGES.COACHING_APPLICATION);
  }

  async function submitVolunteerAgreementStage() {
    const needsVolunteerAgreement = Boolean(completedVolunteerData && volunteerSubmissionId);
    const needsCoachingAgreement = Boolean(completedCoachingData && coachingSubmissionId);

    const volunteerDone = !needsVolunteerAgreement || volunteerAgreementSigned;
    const coachingDone = !needsCoachingAgreement || coachingAgreementSigned;
    if (volunteerDone && coachingDone) {
      await advanceAfterStageSuccess(STAGES.VOLUNTEER_AGREEMENT);
      return;
    }

    setSubmissionStatus(STAGES.VOLUNTEER_AGREEMENT, "submitting");

    if (needsVolunteerAgreement && !volunteerAgreementSigned) {
      await generateVolunteerAgreement(
        completedVolunteerData,
        "volunteer_application",
        volunteerSubmissionId
      );
    }

    if (needsCoachingAgreement && !coachingAgreementSigned) {
      await generateVolunteerAgreement(
        completedCoachingData,
        "coaching_application",
        coachingSubmissionId
      );
    }

    setSubmissionStatus(STAGES.VOLUNTEER_AGREEMENT, "idle");
    await advanceAfterStageSuccess(STAGES.VOLUNTEER_AGREEMENT);
  }

  async function finalizeFlowConfirmationStage() {
    setSubmissionStatus(STAGES.FINAL_CONFIRMATION_EMAIL, "submitting");

    if (registrationResumeState?.testMode) {
      finalConfirmationEmailFailed = false;
      setSubmissionStatus(STAGES.FINAL_CONFIRMATION_EMAIL, "idle", false);
      advanceToStage(STAGES.THANK_YOU);
      return;
    }

    try {
      const emailResult = await sendFinalConfirmationEmail();
      scholarshipDocumentUrl = String(emailResult?.scholarshipDocumentUrl || scholarshipDocumentUrl || "").trim();
      finalConfirmationEmailFailed = !Boolean(emailResult?.sent || emailResult?.duplicate);
    } catch (error) {
      finalConfirmationEmailFailed = true;
      console.warn("final-confirmation-email-failed", error);
    }

    if (registrationResumeState?.token && registrationSubmissionId) {
      try {
        await finalizeRegistrationContinuation();
      } catch (error) {
        console.warn("registration-resume-reconciliation-failed", error);
        registrationSyncWarning = "Your registration was saved, but we could not automatically reconcile the earlier attempts. Our team will review them; you do not need to register again.";
      }
    }

    setSubmissionStatus(STAGES.FINAL_CONFIRMATION_EMAIL, "idle", false);
    advanceToStage(STAGES.THANK_YOU);
  }

  async function finalizeRegistrationContinuation() {
    if (!registrationResumeState?.token || registrationResumeState.testMode) return { ok: true, skipped: true };
    const response = await fetchWithTimeout(RESUME_COMPLETE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        resumeToken: registrationResumeState.token,
        registrationSubmissionId,
        playerCount: completedRegistrationData?.players?.length || selectedPlayerCount(),
      }),
    }, FORM_UPSERT_TIMEOUT_MS);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(String(payload?.error || `Continuation reconciliation failed (${response.status}).`));
    }
    return payload;
  }

  function renderSuccessStage() {
    Array.from(sectionsRoot.querySelectorAll(".form-section")).forEach((section) => {
      section.classList.remove("is-current");
    });

    if (progressFill) progressFill.style.width = "100%";
    if (progressText) progressText.textContent = "Complete";

    form.hidden = true;
    successPanel.hidden = false;
    flowStatus.hidden = true;
    formMessage.textContent = "";

    const heading = successPanel.querySelector("h2");
    const copy = successPanel.querySelector("p");
    const thankYouContent = buildThankYouContent({
      ...getFlowOptions(),
      emailSent: !finalConfirmationEmailFailed,
    });

    if (heading) heading.textContent = thankYouContent.heading;
    if (copy) copy.textContent = thankYouContent.message;

    Array.from(successPanel.querySelectorAll("[data-dynamic-success='true']")).forEach((node) => node.remove());

    if (registrationSyncWarning) {
      const syncWarning = document.createElement("p");
      syncWarning.dataset.dynamicSuccess = "true";
      syncWarning.textContent = registrationSyncWarning;
      successPanel.appendChild(syncWarning);
    }

    if (scholarshipDocumentUrl) {
      const scholarshipLinkWrap = document.createElement("p");
      scholarshipLinkWrap.dataset.dynamicSuccess = "true";
      const scholarshipLink = document.createElement("a");
      scholarshipLink.href = scholarshipDocumentUrl;
      scholarshipLink.target = "_blank";
      scholarshipLink.rel = "noopener noreferrer";
      scholarshipLink.textContent = "Open your completed scholarship document";
      scholarshipLinkWrap.appendChild(scholarshipLink);
      successPanel.appendChild(scholarshipLinkWrap);
    }

    const descriptor = getFlowDescriptor(getFlowOptions());
    const resumePaymentStatus = String(registrationResumeState?.context?.payment?.status || "").trim().toLowerCase();
    const resumePaymentAlreadyPaid = resumePaymentStatus === "paid";
    const paymentAllowed =
      descriptor.paymentRequired &&
      getRequiredStagesForCurrentFlow().includes(STAGES.PAYMENT) &&
      !registrationResumeState?.testMode &&
      !resumePaymentAlreadyPaid;

    if (registrationResumeState?.testMode) {
      const testMessage = document.createElement("p");
      testMessage.dataset.dynamicSuccess = "true";
      testMessage.textContent = "TEST MODE complete. No registration, agreement, scholarship, volunteer, coaching, payment, or duplicate-reconciliation records were changed.";
      successPanel.appendChild(testMessage);
    }

    if (!paymentAllowed) return;

    if (pendingPaymentRedirectTimeoutId) {
      window.clearTimeout(pendingPaymentRedirectTimeoutId);
      pendingPaymentRedirectTimeoutId = null;
    }

    const playerCount = selectedPlayerCount();
    const paymentAmount = calculateRegistrationFeeAmount();
    const registrationTotalMessage = formatRegistrationTotalMessage(playerCount, paymentAmount);
    const paymentMessage = document.createElement("p");
    paymentMessage.dataset.dynamicSuccess = "true";
    paymentMessage.textContent = PAYMENT_MODE === "redirect"
      ? `Your forms have been submitted successfully. Redirecting you to secure payment in a moment. Registration total: ${registrationTotalMessage}.`
      : `Your forms have been submitted successfully. Registration total: ${registrationTotalMessage}.`;
    successPanel.appendChild(paymentMessage);

    const paymentRedirectUrl = buildPaymentRedirectUrl(completedRegistrationData);
    const paymentButton = PAYMENT_MODE === "redirect"
      ? document.createElement("a")
      : document.createElement("p");
    paymentButton.dataset.dynamicSuccess = "true";
    paymentButton.className = "btn btn-primary";

    if (paymentButton instanceof HTMLAnchorElement) {
      paymentButton.href = paymentRedirectUrl || PAYMENT_REDIRECT_URL;
      paymentButton.rel = "noopener noreferrer";
      paymentButton.setAttribute("role", "button");
      paymentButton.style.display = "inline-block";
      paymentButton.style.textDecoration = "none";
      paymentButton.style.textAlign = "center";
      paymentButton.style.width = "100%";
      paymentButton.textContent = `Continue to Secure Payment - ${registrationTotalMessage}`;
    } else {
      paymentButton.textContent = `Payment temporarily paused - ${registrationTotalMessage}`;
    }

    successPanel.appendChild(paymentButton);

    const paymentHint = document.createElement("p");
    paymentHint.dataset.dynamicSuccess = "true";
    paymentHint.textContent = PAYMENT_MODE === "redirect"
      ? `If the payment page does not prefill the registration fee, select Other and enter ${registrationTotalMessage}. If you are not redirected automatically, use the button above.`
      : `${PAYMENT_PAUSED_MESSAGE} Your registration fee amount is ${registrationTotalMessage}.`;
    successPanel.appendChild(paymentHint);

    if (PAYMENT_MODE === "redirect" && paymentRedirectUrl) {
      const shouldRedirect = paymentRedirectUrl !== lastPaymentRedirectUrl;
      lastPaymentRedirectUrl = paymentRedirectUrl;

      if (shouldRedirect) {
        pendingPaymentRedirectTimeoutId = window.setTimeout(() => {
          pendingPaymentRedirectTimeoutId = null;
          window.location.assign(paymentRedirectUrl);
        }, PAYMENT_REDIRECT_DELAY_MS);
      }
    }
  }

  function prefillVolunteerContact() {
    const parent = completedRegistrationData?.parent;
    if (!parent) return;

    setIfEmpty("volFirstName", parent.firstName);
    setIfEmpty("volLastName", parent.lastName);
    setIfEmpty("volEmail", parent.email);
    setIfEmpty("volPhone", parent.phone);
    setIfEmpty("volDob", parent.dob);
    setIfEmpty("volStreet", parent.street);
    setIfEmpty("volApt", parent.apt);
    setIfEmpty("volCity", parent.city);
    setIfEmpty("volState", parent.state);
    setIfEmpty("volZip", parent.zip);
    syncAgreementPrefills();
  }

  function syncAgreementPrefills() {
    // Signature names are captured at final submit from live form values.
  }

  function setIfEmpty(name, value) {
    const field = form.elements.namedItem(name);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
    if (field.value && field.value.trim()) return;
    field.value = value || "";
  }

  function mapHelpChoice(value) {
    return normalizeHelpChoice(value);
  }

  function calculateRegistrationFeeAmount() {
    const playerCount = selectedPlayerCount();
    return Math.max(0, playerCount * REGISTRATION_FEE_AMOUNT_PER_PLAYER);
  }

  function formatRegistrationTotalMessage(playerCount, paymentAmount) {
    const playerLabel = playerCount === 1 ? "1 player" : `${playerCount} players`;
    return `$${REGISTRATION_FEE_AMOUNT_PER_PLAYER} x ${playerLabel} = $${paymentAmount}`;
  }

  function buildDonateUrl() {
    return "";
  }

  function buildPaymentRedirectUrl() {
    return PAYMENT_REDIRECT_URL;
  }

  function collectRegistrationData() {
    const emergencySameAsParent = getCheckboxValue("emergencySameAsParent");
    const playerCount = selectedPlayerCount();
    const players = [];

    for (let playerIndex = 1; playerIndex <= playerCount; playerIndex += 1) {
      players.push({
        firstName: normalizeNameValue(getTextValue(`p${playerIndex}FirstName`)),
        lastName: normalizeNameValue(getTextValue(`p${playerIndex}LastName`)),
        dob: formatDobText(getTextValue(`p${playerIndex}Dob`)),
        gender: getTextValue(`p${playerIndex}Gender`),
        grade: getTextValue(`p${playerIndex}Grade`),
        jersey: getTextValue(`p${playerIndex}Jersey`),
        shorts: getTextValue(`p${playerIndex}Shorts`),
        socks: getTextValue(`p${playerIndex}Socks`),
        race: getTextValue(`p${playerIndex}Race`),
        raceOther: getTextValue(`p${playerIndex}RaceOther`),
        favoriteClub: getTextValue(`p${playerIndex}FavoriteClub`),
        hearAbout: getTextValue(`p${playerIndex}HearAbout`),
        addAnother: getTextValue(`addPlayer${playerIndex + 1}`),
      });
    }

    return {
      submittedAt: new Date().toISOString(),
      pageUrl: window.location.href,
      parent: {
        firstName: normalizeNameValue(getTextValue("parentFirstName")),
        lastName: normalizeNameValue(getTextValue("parentLastName")),
        email: normalizeEmailValue(getTextValue("parentEmail")),
        phone: formatUsPhone(getTextValue("parentPhone")),
        dob: formatDobText(getTextValue("parentGuardianDob")),
        street: getTextValue("parentStreet"),
        apt: getTextValue("parentApt"),
        city: getTextValue("parentCity"),
        state: getTextValue("parentState"),
        zip: formatUsZip(getTextValue("parentZip")),
      },
      emergency: emergencySameAsParent
        ? {
            sameAsParent: true,
            firstName: "",
            lastName: "",
            relationship: "",
            email: "",
            phone: "",
            street: "",
            apt: "",
            city: "",
            state: "",
            zip: "",
          }
        : {
            sameAsParent: false,
            firstName: getTextValue("emergencyFirstName"),
            lastName: getTextValue("emergencyLastName"),
            relationship: getTextValue("emergencyRelationship"),
            email: normalizeEmailValue(getTextValue("emergencyEmail")),
            phone: formatUsPhone(getTextValue("emergencyPhone")),
            street: getTextValue("emergencyStreet"),
            apt: getTextValue("emergencyApt"),
            city: getTextValue("emergencyCity"),
            state: getTextValue("emergencyState"),
            zip: formatUsZip(getTextValue("emergencyZip")),
          },
      players,
      scholarship: {
        requested: getTextValue("scholarshipRequested"),
        level: getTextValue("scholarshipLevel"),
        householdSize: getTextValue("scholarshipHouseholdSize"),
        householdIncome: getTextValue("scholarshipHouseholdIncome"),
        eligibility: getCheckedValues("scholarshipEligibility"),
        circumstances: getTextValue("scholarshipCircumstances"),
        contributionAmount: getTextValue("scholarshipContributionAmount"),
        participationCommitment: getCheckboxValue("scholarshipParticipationCommitment"),
        parentAcknowledgement: getCheckboxValue("scholarshipParentAcknowledgement"),
        guidelinesAccepted: getCheckboxValue("scholarshipGuidelinesAccepted"),
      },
      helpChoice: getTextValue("helpChoice"),
      agreements: {
        waiver: getCheckboxValue("agreeWaiver"),
        liability: getCheckboxValue("agreePpfLiability"),
        privacy: getCheckboxValue("agreePrivacy"),
        marketing: getCheckboxValue("agreePrivacy"),
      },
      signature: "",
      agreementSigning: null,
    };
  }

  function toEmailResponseValue(value) {
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .join(", ");
    }
    return String(value || "").trim();
  }

  function pushEmailResponseRow(rows, label, value) {
    const normalized = toEmailResponseValue(value);
    if (!normalized) return;
    rows.push({ label, value: normalized });
  }

  function buildRegistrationEmailResponseRows(registrationData) {
    const rows = [];
    if (!registrationData) return rows;

    pushEmailResponseRow(rows, "Registration ID", registrationData.registrationSubmissionId || "");
    pushEmailResponseRow(rows, "Submitted At", registrationData.submittedAt);
    pushEmailResponseRow(rows, "Parent/Guardian First Name", registrationData.parent?.firstName);
    pushEmailResponseRow(rows, "Parent/Guardian Last Name", registrationData.parent?.lastName);
    pushEmailResponseRow(rows, "Parent/Guardian Email", registrationData.parent?.email);
    pushEmailResponseRow(rows, "Parent/Guardian Phone", registrationData.parent?.phone);
    pushEmailResponseRow(rows, "Parent/Guardian Date of Birth", registrationData.parent?.dob);
    pushEmailResponseRow(rows, "Parent/Guardian Street", registrationData.parent?.street);
    pushEmailResponseRow(rows, "Parent/Guardian Apt", registrationData.parent?.apt);
    pushEmailResponseRow(rows, "Parent/Guardian City", registrationData.parent?.city);
    pushEmailResponseRow(rows, "Parent/Guardian State", registrationData.parent?.state);
    pushEmailResponseRow(rows, "Parent/Guardian Zip", registrationData.parent?.zip);

    pushEmailResponseRow(rows, "Emergency Contact Same As Parent", registrationData.emergency?.sameAsParent);
    if (!registrationData.emergency?.sameAsParent) {
      pushEmailResponseRow(rows, "Emergency Contact First Name", registrationData.emergency?.firstName);
      pushEmailResponseRow(rows, "Emergency Contact Last Name", registrationData.emergency?.lastName);
      pushEmailResponseRow(rows, "Emergency Contact Relationship", registrationData.emergency?.relationship);
      pushEmailResponseRow(rows, "Emergency Contact Email", registrationData.emergency?.email);
      pushEmailResponseRow(rows, "Emergency Contact Phone", registrationData.emergency?.phone);
      pushEmailResponseRow(rows, "Emergency Contact Street", registrationData.emergency?.street);
      pushEmailResponseRow(rows, "Emergency Contact Apt", registrationData.emergency?.apt);
      pushEmailResponseRow(rows, "Emergency Contact City", registrationData.emergency?.city);
      pushEmailResponseRow(rows, "Emergency Contact State", registrationData.emergency?.state);
      pushEmailResponseRow(rows, "Emergency Contact Zip", registrationData.emergency?.zip);
    }

    const players = Array.isArray(registrationData.players) ? registrationData.players : [];
    pushEmailResponseRow(rows, "Player Count", players.length);
    players.forEach((player, index) => {
      const n = index + 1;
      pushEmailResponseRow(rows, `Player ${n} First Name`, player?.firstName);
      pushEmailResponseRow(rows, `Player ${n} Last Name`, player?.lastName);
      pushEmailResponseRow(rows, `Player ${n} Date of Birth`, player?.dob);
      pushEmailResponseRow(rows, `Player ${n} Gender`, player?.gender);
      pushEmailResponseRow(rows, `Player ${n} Grade`, player?.grade);
      pushEmailResponseRow(rows, `Player ${n} Jersey Size`, player?.jersey);
      pushEmailResponseRow(rows, `Player ${n} Shorts Size`, player?.shorts);
      pushEmailResponseRow(rows, `Player ${n} Socks Size`, player?.socks);
      pushEmailResponseRow(rows, `Player ${n} Race`, player?.race);
      pushEmailResponseRow(rows, `Player ${n} Race Other`, player?.raceOther);
      pushEmailResponseRow(rows, `Player ${n} Favorite Club`, player?.favoriteClub);
      pushEmailResponseRow(rows, `Player ${n} Heard About Program`, player?.hearAbout);
      pushEmailResponseRow(rows, `Player ${n} Add Another`, player?.addAnother);
    });

    pushEmailResponseRow(rows, "Help Choice", registrationData.helpChoice);
    pushEmailResponseRow(rows, "Scholarship Requested", registrationData.scholarship?.requested);
    pushEmailResponseRow(rows, "Scholarship Level", registrationData.scholarship?.level);
    pushEmailResponseRow(rows, "Scholarship Household Size", registrationData.scholarship?.householdSize);
    pushEmailResponseRow(rows, "Scholarship Household Income", registrationData.scholarship?.householdIncome);
    pushEmailResponseRow(rows, "Scholarship Eligibility", registrationData.scholarship?.eligibility);
    pushEmailResponseRow(rows, "Scholarship Circumstances", registrationData.scholarship?.circumstances);
    pushEmailResponseRow(rows, "Scholarship Contribution Amount", registrationData.scholarship?.contributionAmount);
    pushEmailResponseRow(rows, "Scholarship Participation Commitment", registrationData.scholarship?.participationCommitment);
    pushEmailResponseRow(rows, "Scholarship Parent Acknowledgement", registrationData.scholarship?.parentAcknowledgement);
    pushEmailResponseRow(rows, "Agree Waiver", registrationData.agreements?.waiver);
    pushEmailResponseRow(rows, "Agree PPF Liability", registrationData.agreements?.liability);
    pushEmailResponseRow(rows, "Agree Privacy", registrationData.agreements?.privacy);
    pushEmailResponseRow(rows, "Agree Marketing", registrationData.agreements?.marketing);

    return rows;
  }

  function collectVolunteerData() {
    return {
      submittedAt: new Date().toISOString(),
      pageUrl: window.location.href,
      firstName: normalizeNameValue(getTextValue("volFirstName")),
      lastName: normalizeNameValue(getTextValue("volLastName")),
      email: normalizeEmailValue(getTextValue("volEmail")),
      phone: formatUsPhone(getTextValue("volPhone")),
      dob: formatDobText(getTextValue("volDob")),
      street: getTextValue("volStreet"),
      apt: getTextValue("volApt"),
      city: getTextValue("volCity"),
      state: getTextValue("volState"),
      zip: formatUsZip(getTextValue("volZip")),
      roles: getCheckedValues("volunteerRoles"),
      hasExperience: getTextValue("volHasExperience"),
      experienceSummary: getTextValue("volExperienceSummary"),
      availabilityNotes: getTextValue("volAvailabilityNotes"),
      agreement: false,
      signature: "",
      agreementSigning: null,
      linkedParentEmail: completedRegistrationData?.parent?.email || "",
    };
  }

  function collectScholarshipApplicationData() {
    return {
      requested: completedRegistrationData?.scholarship?.requested || getTextValue("scholarshipRequested") || "Yes",
      level: getTextValue("scholarshipLevel"),
      householdSize: getTextValue("scholarshipHouseholdSize"),
      householdIncome: getTextValue("scholarshipHouseholdIncome"),
      eligibility: getCheckedValues("scholarshipEligibility"),
      circumstances: getTextValue("scholarshipCircumstances"),
      contributionAmount: getTextValue("scholarshipContributionAmount"),
      participationCommitment: getCheckboxValue("scholarshipParticipationCommitment"),
      parentAcknowledgement: getCheckboxValue("scholarshipParentAcknowledgement"),
      guidelinesAccepted: getCheckboxValue("scholarshipGuidelinesAccepted"),
    };
  }

  function getParticipantNames(registrationData) {
    return Array.isArray(registrationData?.players)
      ? registrationData.players
        .map((player) => `${player?.firstName || ""} ${player?.lastName || ""}`.trim())
        .filter(Boolean)
      : [];
  }

  function collectCoachingData() {
    return {
      ...collectVolunteerData(),
      coachHasExperience: getTextValue("coachHasExperience"),
      coachExperienceSummary: getTextValue("coachExperienceSummary"),
      coachAvailability: getCheckedValues("coachAvailability"),
      ref1Name: getTextValue("coachRef1Name"),
      ref1Relationship: getTextValue("coachRef1Relationship"),
      ref1Phone: formatUsPhone(getTextValue("coachRef1Phone")),
      ref1Email: normalizeEmailValue(getTextValue("coachRef1Email")),
      coachCertifications: getCheckedValues("coachCertifications"),
      coachBackgroundConsent: getCheckboxValue("coachBackgroundConsent"),
      coachSignature: getTextValue("coachSignature"),
    };
  }

  async function generatePlayerAgreement(registrationData) {
    if (playerAgreementSigned) return;

    const viewedAtUtc = new Date().toISOString();
    const printedName = `${registrationData.parent.firstName} ${registrationData.parent.lastName}`.trim();

    const payload = {
      agreementType: "player",
      formType: "mls_registration",
      submissionId: registrationData.registrationSubmissionId,
      transactionId: playerAgreementTransactionId || undefined,
      signer: {
        printedName,
      },
      signature: {
        method: "checkbox-consent",
      },
      audit: {
        viewedAtUtc,
        signedAtUtc: viewedAtUtc,
        consentAccepted: true,
        consentVersion: E_CONSENT_TEXT_VERSION,
      },
      fields: {
        registrationSubmissionId: registrationData.registrationSubmissionId,
        allResponseRows: buildRegistrationEmailResponseRows(registrationData),
        printedFullName: printedName,
        relationshipToChild: "Parent/Legal Guardian",
        participantNames: registrationData.players
          .map((p) => `${p.firstName} ${p.lastName}`.trim())
          .filter(Boolean)
          .join(", "),
        primaryPhone: registrationData.parent.phone,
        alternatePhone: registrationData.emergency?.sameAsParent ? "" : registrationData.emergency?.phone || "",
        parentStreet: registrationData.parent.street,
        parentCity: registrationData.parent.city,
        parentState: registrationData.parent.state,
        parentZip: registrationData.parent.zip,
        parentEmail: registrationData.parent.email,
        parentPhone: registrationData.parent.phone,
        guardianName: `${registrationData.parent.firstName} ${registrationData.parent.lastName}`.trim(),
        guardianDob: registrationData.parent.dob,
        guardianStreet: registrationData.parent.street,
        guardianCity: registrationData.parent.city,
        guardianState: registrationData.parent.state,
        guardianZip: registrationData.parent.zip,
        guardianPhone: registrationData.parent.phone,
        guardianEmail: registrationData.parent.email,
        emergencyContactName: registrationData.emergency?.sameAsParent
          ? `${registrationData.parent.firstName} ${registrationData.parent.lastName}`.trim()
          : `${registrationData.emergency?.firstName || ""} ${registrationData.emergency?.lastName || ""}`.trim(),
        emergencyRelationship: registrationData.emergency?.sameAsParent
          ? "Same as parent/guardian"
          : registrationData.emergency?.relationship || "",
        emergencyEmail: registrationData.emergency?.sameAsParent
          ? registrationData.parent.email
          : registrationData.emergency?.email || "",
        emergencyPhone: registrationData.emergency?.sameAsParent
          ? registrationData.parent.phone
          : registrationData.emergency?.phone || "",
        emergencyStreet: registrationData.emergency?.sameAsParent
          ? registrationData.parent.street
          : registrationData.emergency?.street || "",
        emergencyCity: registrationData.emergency?.sameAsParent
          ? registrationData.parent.city
          : registrationData.emergency?.city || "",
        emergencyState: registrationData.emergency?.sameAsParent
          ? registrationData.parent.state
          : registrationData.emergency?.state || "",
        emergencyZip: registrationData.emergency?.sameAsParent
          ? registrationData.parent.zip
          : registrationData.emergency?.zip || "",
        signingDate: viewedAtUtc.slice(0, 10),
      },
    };

    const res = await fetch(SIGNING_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(resolveAgreementRequestError(result, "Player agreement document generation failed."));
    }
    playerAgreementTransactionId = result.transactionId || playerAgreementTransactionId;
    playerAgreementDownloadUrl = result.emailDownloadUrl || result.signerDownloadUrl || playerAgreementDownloadUrl;
    if (result?.sheetUpdate && result.sheetUpdate.ok === false) {
      throw new Error("We couldn’t record your Player Agreement. Your previous information is saved. Please select Retry to continue.");
    }
    playerAgreementSigned = true;
  }

  async function generateVolunteerAgreement(data, formType, submissionId) {
    const isCoachingAgreement = formType === "coaching_application";
    if (isCoachingAgreement ? coachingAgreementSigned : volunteerAgreementSigned) return;

    const viewedAtUtc = new Date().toISOString();
    const printedName = `${data.firstName} ${data.lastName}`.trim();
    const transactionId = isCoachingAgreement
      ? coachingAgreementTransactionId
      : volunteerAgreementTransactionId;

    const payload = {
      agreementType: "volunteer",
      formType,
      submissionId,
      transactionId: transactionId || undefined,
      signer: {
        printedName,
        ageYears: calculateAgeYears(data.dob),
      },
      signature: {
        method: "checkbox-consent",
      },
      audit: {
        viewedAtUtc,
        signedAtUtc: viewedAtUtc,
        consentAccepted: true,
        consentVersion: E_CONSENT_TEXT_VERSION,
      },
      fields: {
        legalName: printedName,
        signingDate: viewedAtUtc.slice(0, 10),
      },
    };

    const res = await fetch(SIGNING_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(resolveAgreementRequestError(result, "Volunteer agreement document generation failed."));
    }
    if (result?.sheetUpdate && result.sheetUpdate.ok === false) {
      throw new Error("We couldn’t record your Volunteer Agreement. Your previous information is saved. Please select Retry to continue.");
    }

    if (isCoachingAgreement) {
      coachingAgreementTransactionId = result.transactionId || coachingAgreementTransactionId;
      coachingAgreementDownloadUrl = result.emailDownloadUrl || result.signerDownloadUrl || coachingAgreementDownloadUrl;
      coachingAgreementSigned = true;
    } else {
      volunteerAgreementTransactionId = result.transactionId || volunteerAgreementTransactionId;
      volunteerAgreementDownloadUrl = result.emailDownloadUrl || result.signerDownloadUrl || volunteerAgreementDownloadUrl;
      volunteerAgreementSigned = true;
    }
  }

  function calculateAgeYears(value) {
    const dob = parseUsDate(value);
    if (!dob) return 0;

    const now = startOfLocalDay(new Date());
    let age = now.getFullYear() - dob.getFullYear();
    const monthDelta = now.getMonth() - dob.getMonth();

    if (
      monthDelta < 0 ||
      (monthDelta === 0 && now.getDate() < dob.getDate())
    ) {
      age -= 1;
    }

    return age;
  }

  function resolveAgreementRequestError(payload, fallbackMessage) {
    const sheetUpdateError = String(payload?.sheetUpdate?.error || "").trim();
    const primaryError = String(payload?.error || "").trim();
    return sheetUpdateError || primaryError || fallbackMessage;
  }

  function generateSubmissionId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  function splitLegalName(fullName) {
    const normalized = String(fullName || "").trim().replace(/\s+/g, " ");
    if (!normalized) return { firstName: "", lastName: "" };
    const parts = normalized.split(" ");
    if (parts.length === 1) return { firstName: parts[0], lastName: "" };
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(" "),
    };
  }

  function syncParentIdentityFromAgreement(registrationData) {
    const printed = registrationData?.agreementSigning?.printedName || "";
    if (!printed.trim()) return;
    const parsed = splitLegalName(printed);
    if (parsed.firstName) {
      registrationData.parent.firstName = parsed.firstName;
      setValue("parentFirstName", parsed.firstName);
    }
    if (parsed.lastName) {
      registrationData.parent.lastName = parsed.lastName;
      setValue("parentLastName", parsed.lastName);
    }
  }

  function syncVolunteerIdentityFromAgreement(data) {
    const printed = data?.agreementSigning?.printedName || "";
    if (!printed.trim()) return;
    const parsed = splitLegalName(printed);
    if (parsed.firstName) {
      data.firstName = parsed.firstName;
      setValue("volFirstName", parsed.firstName);
    }
    if (parsed.lastName) {
      data.lastName = parsed.lastName;
      setValue("volLastName", parsed.lastName);
    }
  }

  async function postFormResponse(params) {
    await fetchWithTimeout(FORM_ACTION, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: params.toString(),
    }, 6000);
  }

  async function sendFinalConfirmationEmail() {
    const descriptor = getFlowDescriptor(getFlowOptions());
    const participantNames = getParticipantNames(completedRegistrationData);
    const applicantFirstName = completedRegistrationData?.parent?.firstName || completedVolunteerData?.firstName || completedCoachingData?.firstName || "";
    const applicantLastName = completedRegistrationData?.parent?.lastName || completedVolunteerData?.lastName || completedCoachingData?.lastName || "";
    const recipientEmail = completedRegistrationData?.parent?.email || completedVolunteerData?.email || completedCoachingData?.email || "";
    const submissionId = registrationSubmissionId || volunteerSubmissionId || coachingSubmissionId;
    const paymentUrl = descriptor.paymentRequired ? buildPaymentRedirectUrl(completedRegistrationData) : "";
    const signedDocumentUrls = [];

    if (playerAgreementDownloadUrl) {
      signedDocumentUrls.push({ label: "Player Agreement", url: playerAgreementDownloadUrl });
    }
    if (volunteerAgreementDownloadUrl) {
      signedDocumentUrls.push({ label: "Volunteer Agreement", url: volunteerAgreementDownloadUrl });
    }
    if (coachingAgreementDownloadUrl) {
      signedDocumentUrls.push({ label: "Coaching Volunteer Agreement", url: coachingAgreementDownloadUrl });
    }

    const res = await fetchWithTimeout(FINAL_CONFIRMATION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        submissionId,
        registrationSubmissionId,
        volunteerSubmissionId,
        coachingSubmissionId,
        emailType: descriptor.emailType,
        applicantFirstName,
        applicantLastName,
        recipientEmail,
        participantNames,
        formsRecorded: descriptor.formsRecorded,
        agreementsRecorded: descriptor.agreementsRecorded,
        scholarshipRequested: completedRegistrationData?.scholarship?.requested || "No",
        paymentRequired: descriptor.paymentRequired,
        paymentUrl,
        paymentAmount: descriptor.paymentRequired ? String(calculateRegistrationFeeAmount()) : "",
        signedDocumentUrls,
        sourceUrl: window.location.href,
      }),
    }, FINAL_CONFIRMATION_TIMEOUT_MS);

    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.ok) {
      throw new Error(String(payload?.error || `Final confirmation email failed (${res.status})`).trim());
    }

    return payload.result || { sent: true };
  }

  async function postRegistrationCopy(data) {
    const values = {
      defer_confirmation_email: "yes",
      registration_submission_id: data.registrationSubmissionId || "",
      submitted_at: data.submittedAt,
      page_url: data.pageUrl,
      parent_first_name: data.parent.firstName,
      parent_last_name: data.parent.lastName,
      parent_email: data.parent.email,
      parent_phone: data.parent.phone,
      parent_guardian_dob: data.parent.dob,
      parent_street: data.parent.street,
      parent_apt: data.parent.apt,
      parent_city: data.parent.city,
      parent_state: data.parent.state,
      parent_zip: data.parent.zip,
      emergency_same_as_parent: data.emergency.sameAsParent ? "yes" : "no",
      emergency_first_name: data.emergency.firstName,
      emergency_last_name: data.emergency.lastName,
      emergency_relationship: data.emergency.relationship,
      emergency_email: data.emergency.email,
      emergency_phone: data.emergency.phone,
      emergency_street: data.emergency.street,
      emergency_apt: data.emergency.apt,
      emergency_city: data.emergency.city,
      emergency_state: data.emergency.state,
      emergency_zip: data.emergency.zip,
      player_count: String(data.players.length),
      scholarship_requested: String(data.scholarship?.requested || "No"),
      help_choice: data.helpChoice,
      agree_waiver: data.agreements.waiver ? "yes" : "no",
      agree_privacy: data.agreements.privacy ? "yes" : "no",
      agree_marketing: data.agreements.marketing ? "yes" : "no",
      signature: data.signature,
    };

    data.players.forEach((player, index) => {
      const prefix = `player_${index + 1}`;
      values[`${prefix}_first_name`] = player.firstName;
      values[`${prefix}_last_name`] = player.lastName;
      values[`${prefix}_dob`] = player.dob;
      values[`${prefix}_gender`] = player.gender;
      values[`${prefix}_grade`] = player.grade;
      values[`${prefix}_jersey`] = player.jersey;
      values[`${prefix}_shorts`] = player.shorts;
      values[`${prefix}_socks`] = player.socks;
      values[`${prefix}_race`] = player.race;
      values[`${prefix}_race_other`] = player.raceOther;
      values[`${prefix}_favorite_club`] = player.favoriteClub;
      values[`${prefix}_hear_about`] = player.hearAbout;
      values[`${prefix}_add_another`] = player.addAnother;
    });

    await postUpsertViaWorker("mls_registration", values);
  }

  async function postScholarshipCopy(registrationData) {
    const scholarship = registrationData?.scholarship || {};
    const requested = String(scholarship.requested || "No").trim();
    if (!isScholarshipRequested(requested)) {
      return;
    }

    const participantNames = getParticipantNames(registrationData);

    const values = {
      defer_confirmation_email: "yes",
      submitted_at: registrationData.submittedAt,
      registration_submission_id: registrationData.registrationSubmissionId || "",
      page_url: registrationData.pageUrl,
      parent_first_name: registrationData.parent?.firstName || "",
      parent_last_name: registrationData.parent?.lastName || "",
      parent_email: registrationData.parent?.email || "",
      parent_phone: registrationData.parent?.phone || "",
      scholarship_requested: requested,
      scholarship_level: scholarship.level || "",
      scholarship_household_size: scholarship.householdSize || "",
      scholarship_household_income: scholarship.householdIncome || "",
      scholarship_eligibility: Array.isArray(scholarship.eligibility) ? scholarship.eligibility.join(", ") : "",
      scholarship_circumstances: scholarship.circumstances || "",
      scholarship_contribution_amount: scholarship.contributionAmount || "",
      scholarship_participation_commitment: scholarship.participationCommitment ? "yes" : "no",
      scholarship_parent_acknowledgement: scholarship.parentAcknowledgement ? "yes" : "no",
      scholarship_guidelines_accepted: scholarship.guidelinesAccepted ? "yes" : "no",
      participant_names: participantNames.join(", "),
    };

    await postAuxFlow("scholarship_application", values);
  }

  async function postAuxFlow(formType, data) {
    await postUpsertViaWorker(formType, data);
  }

  async function postUpsertViaWorker(formType, values) {
    let res;
    let payload = null;
    let error = "";

    try {
      res = await fetchWithTimeout(FORM_UPSERT_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          formType,
          values: {
            ...values,
            defer_confirmation_email: values?.defer_confirmation_email || "yes",
          },
        }),
      }, FORM_UPSERT_TIMEOUT_MS);
      payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        error = String(payload?.error || `Form upsert failed (${res.status})`).trim();
      }
    } catch (err) {
      error = String(err?.message || err || "Form upsert request failed").trim();
    }

    if (!error) return;

    if (payload?.details) {
      console.warn("worker-upsert-failed", {
        formType,
        error,
        details: payload.details,
      });
    }

    throw new Error(error || "Form upsert failed");
  }

  async function postUpsertDirect(formType, values) {
    const params = new URLSearchParams();
    params.append("form_type", formType);

    Object.entries(values || {}).forEach(([key, value]) => {
      if (!key) return;
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        if (value.length) params.append(key, value.join(", "));
      return;
    }
      if (typeof value === "object") return;
      const text = String(value).trim();
      if (text) params.append(key, text);
    });

    await fetchWithTimeout(GOOGLE_APPS_SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: params.toString(),
    }, 5000);
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort("Request timeout"), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function getCheckedValues(groupName) {
    return Array.from(form.querySelectorAll(`input[name="${groupName}[]"]:checked`)).map(
      (input) => input.value,
    );
  }

  function appendValue(params, key, value) {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && !value.trim()) return;
    params.append(key, String(value));
  }

  function getTextValue(name) {
    const element = form.elements.namedItem(name);
    if (!element) return "";
    if (element instanceof RadioNodeList) return element[0]?.value || "";
    return element.value || "";
  }

  function getCheckboxValue(name) {
    const element = form.elements.namedItem(name);
    if (!element) return false;
    if (element instanceof RadioNodeList) return Boolean(element[0]?.checked);
    if (element instanceof HTMLInputElement) return Boolean(element.checked);
    return false;
  }

  function selectedPlayerCount() {
    if (getTextValue("addPlayer2") !== "Yes") return 1;
    if (getTextValue("addPlayer3") !== "Yes") return 2;
    if (getTextValue("addPlayer4") !== "Yes") return 3;
    return 4;
  }

  function appendIfPresent(params, entryId, value) {
    if (!entryId) return;
    if (value === undefined || value === null) return;
    if (typeof value === "string" && !value.trim()) return;
    params.append(`entry.${entryId}`, String(value));
  }

  function syncConditionalFields(controllerName, controllerValue) {
    form.querySelectorAll(`[data-conditional-on="${controllerName}"]`).forEach((field) => {
      const expectedValue = field.dataset.conditionalValue;
      const match = controllerValue === expectedValue;
      const fieldWrap = field.closest(".field-group");
      if (fieldWrap) fieldWrap.classList.toggle("hidden", !match);
    });
  }

  function formatPhoneField(input) {
    input.value = formatUsPhone(input.value);
    validateField(input, { showMessage: false });
  }

  function isValidDobValue(value) {
    return Boolean(parseUsDate(value));
  }

  function validateDobField(input) {
    if (!(input instanceof HTMLInputElement)) return;
    validateField(input, { showMessage: false });
  }

  function formatDobField(input) {
    const digits = input.value.replace(/\D/g, "").slice(0, 8);
    input.value = formatDobText(input.value);
    validateDobField(input);

    if (digits.length >= 8 && !input.validationMessage) {
      window.setTimeout(() => {
        const wrap = input.closest(".field-group");
        const nextField = wrap?.nextElementSibling?.querySelector("input, select, textarea");
        if (nextField && typeof nextField.focus === "function") nextField.focus();
      }, 0);
    }
  }

  function formatZipField(input) {
    input.value = formatUsZip(input.value);
    validateField(input, { showMessage: false });
  }

  function fetchGoogleMapsApiKey() {
    if (googleMapsApiKeyPromise) return googleMapsApiKeyPromise;

    googleMapsApiKeyPromise = (async () => {
      if (GOOGLE_MAPS_API_KEY_META) {
        return GOOGLE_MAPS_API_KEY_META;
      }

      try {
        const res = await fetch(PUBLIC_CONFIG_ENDPOINT, {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "omit",
          cache: "no-store",
        });
        if (res.ok) {
          const payload = await res.json().catch(() => null);
          const key = typeof payload?.googleMapsApiKey === "string"
            ? payload.googleMapsApiKey.trim()
            : "";
          if (key) return key;
        }
      } catch (_error) {
        // Address autocomplete remains disabled when config lookup fails.
      }

      return "";
    })();

    return googleMapsApiKeyPromise;
  }

  async function loadGooglePlacesScript() {
    if (window.google?.maps?.places) {
      return true;
    }

    const key = await fetchGoogleMapsApiKey();
    if (!key) return false;

    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-google-places="true"]');
      if (existing) {
        if (window.google?.maps?.places || existing.dataset.loaded === "true") {
          resolve(true);
          return;
        }
        existing.addEventListener("load", () => resolve(true), { once: true });
        existing.addEventListener("error", () => reject(new Error("Google Places failed to load")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.dataset.googlePlaces = "true";
      script.async = true;
      script.defer = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&loading=async`;
      script.onload = () => {
        script.dataset.loaded = "true";
        resolve(true);
      };
      script.onerror = () => reject(new Error("Google Places failed to load"));
      document.head.appendChild(script);
    });
  }

  async function initAddressAutocomplete() {
    try {
      const loaded = await loadGooglePlacesScript();
      if (!loaded || !window.google?.maps?.places) return;

      const access = await checkPlacesAccess();
      if (!access.ok) {
        if (formMessage && !formMessage.textContent) {
          formMessage.textContent = access.message;
        }
        return;
      }

      const addressFields = Array.from(form.querySelectorAll('[data-address-field="true"]'));
      addressFields.forEach((input) => {
        const autocomplete = new google.maps.places.Autocomplete(input, {
          types: ["address"],
          fields: ["address_components"],
          componentRestrictions: { country: "us" },
        });

        autocomplete.addListener("place_changed", () => {
          const place = autocomplete.getPlace();
          if (!place.address_components) return;

          const parsed = parsePlaceAddress(place.address_components);
          const prefix = input.name.startsWith("emergency")
            ? "emergency"
            : input.name.startsWith("vol")
              ? "vol"
              : "parent";

          if (parsed.street) setValue(`${prefix}Street`, collapseSpaces(parsed.street));
          if (parsed.city) setValue(`${prefix}City`, collapseSpaces(parsed.city));
          if (parsed.state) setValue(`${prefix}State`, parsed.state.toUpperCase());
          if (parsed.zip) setValue(`${prefix}Zip`, formatUsZip(parsed.zip));
        });
      });
    } catch (error) {
      console.warn("Address autocomplete unavailable", error);
      if (formMessage && !formMessage.textContent) {
        formMessage.textContent =
          "Address suggestions are temporarily unavailable. You can still enter the address manually.";
      }
    }
  }

  async function checkPlacesAccess() {
    const deniedMessage =
      "Address autocomplete is unavailable because Google Maps billing is not enabled for the configured API key. Enable billing for that Google Cloud project, then refresh this page.";

    return new Promise((resolve) => {
      try {
        const svc = new google.maps.places.AutocompleteService();
        svc.getPlacePredictions(
          {
            input: "1600 Pennsylvania Ave NW",
            componentRestrictions: { country: "us" },
          },
          (_predictions, status) => {
            if (status === "OK" || status === "ZERO_RESULTS") {
              resolve({ ok: true, message: "" });
              return;
            }

            if (status === "REQUEST_DENIED") {
              resolve({ ok: false, message: deniedMessage });
              return;
            }

            resolve({
              ok: false,
              message:
                "Address suggestions are temporarily unavailable. You can still enter the address manually.",
            });
          },
        );
      } catch (_error) {
        resolve({
          ok: false,
          message:
            "Address suggestions are temporarily unavailable. You can still enter the address manually.",
        });
      }
    });
  }

  function setValue(name, value) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
      field.value = value;
    }
  }

  function parsePlaceAddress(components) {
    const result = { street: "", city: "", state: "", zip: "" };
    const lookup = (type) => components.find((component) => component.types.includes(type));
    const streetNumber = lookup("street_number")?.long_name || "";
    const route = lookup("route")?.long_name || "";
    result.street = [streetNumber, route].filter(Boolean).join(" ");
    result.city =
      lookup("locality")?.long_name ||
      lookup("postal_town")?.long_name ||
      lookup("administrative_area_level_2")?.long_name ||
      "";
    result.state =
      lookup("administrative_area_level_1")?.short_name ||
      lookup("administrative_area_level_1")?.long_name ||
      "";
    result.zip = lookup("postal_code")?.long_name || "";
    return result;
  }
})();
