const PROGRAM_ID = "paducah-go-soccer-league";

const REGISTRATION_TYPE_BY_FORM = Object.freeze({
  mls_registration: "player",
  volunteer_application: "volunteer",
  coaching_application: "coach",
});

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function first(values, ...keys) {
  for (const key of keys) {
    const value = text(values?.[key]);
    if (value) return value;
  }
  return "";
}

function bool(value) {
  return /^(1|true|yes|on)$/i.test(text(value));
}

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function safeId(value, fallback) {
  const normalized = text(value);
  return normalized || fallback;
}

function now() {
  return new Date().toISOString();
}

function participantValues(values, index) {
  const n = index + 1;
  return {
    firstName: first(values, `player_${n}_first_name`, `p${n}FirstName`, `player${n}_first_name`),
    lastName: first(values, `player_${n}_last_name`, `p${n}LastName`, `player${n}_last_name`),
    dob: first(values, `player_${n}_dob`, `p${n}Dob`, `player${n}_dob`),
    gender: first(values, `player_${n}_gender`, `p${n}Gender`, `player${n}_gender_identity`),
    gradeOrAge: first(values, `player_${n}_grade`, `p${n}Grade`, `player_${n}_age`, `p${n}Age`),
    race: first(values, `player_${n}_race`, `p${n}Race`, `player_${n}_race_ethnicity`),
    raceOther: first(values, `player_${n}_race_other`, `p${n}RaceOther`),
    favoriteClub: first(values, `player_${n}_favorite_club`, `p${n}FavoriteClub`, `player_${n}_favorite_mls_club`),
    jersey: first(values, `player_${n}_jersey_size`, `p${n}Jersey`, `player_${n}_jersey`),
    shorts: first(values, `player_${n}_shorts_size`, `p${n}Shorts`, `player_${n}_shorts`),
    socks: first(values, `player_${n}_sock_size`, `p${n}Socks`, `player_${n}_socks`),
    howHeard: first(values, `player_${n}_how_heard`, `p${n}HearAbout`, `player_${n}_hear_about`),
  };
}

function buildParticipants(formType, values, registrationId) {
  const participants = [];
  if (formType === "mls_registration") {
    const count = Math.min(4, Math.max(1, integer(first(values, "player_count", "number_of_players"), 1)));
    for (let index = 0; index < count; index += 1) {
      const player = participantValues(values, index);
      if (!player.firstName && !player.lastName) continue;
      participants.push({
        id: `${registrationId}-player-${index + 1}`,
        type: "player",
        slot: index + 1,
        ...player,
      });
    }
  } else {
    participants.push({
      id: `${registrationId}-${REGISTRATION_TYPE_BY_FORM[formType] || "participant"}`,
      type: REGISTRATION_TYPE_BY_FORM[formType] || "player",
      slot: 1,
      firstName: first(values, "first_name", "vol_first_name", "coach_first_name", "volunteer_first_name"),
      lastName: first(values, "last_name", "vol_last_name", "coach_last_name", "volunteer_last_name"),
      dob: first(values, "dob", "date_of_birth"),
      gender: first(values, "gender", "gender_identity"),
      gradeOrAge: "",
      race: "",
      raceOther: "",
      favoriteClub: "",
      jersey: "",
      shorts: "",
      socks: "",
      howHeard: "",
    });
  }
  return participants;
}

function normalizeRegistrationType(formType, values) {
  const explicit = text(values?.registration_type).toLowerCase();
  if (REGISTRATION_TYPE_BY_FORM[formType] === "player") {
    if (explicit.includes("volunteer") && explicit.includes("coach")) return "player_volunteer_coach";
    if (explicit.includes("volunteer")) return "player_volunteer";
    if (explicit.includes("coach")) return "player_coach";
  }
  return REGISTRATION_TYPE_BY_FORM[formType] || "player";
}

export async function upsertRegistrationToD1(
  env,
  {
    formType,
    values,
    programId = PROGRAM_ID,
    seasonId = null,
    source = "worker",
  },
) {
  if (!env?.DB) throw new Error("D1 binding env.DB is not configured");
  const submissionId = first(values, "registration_submission_id", "submission_id");
  if (!submissionId) throw new Error("Missing registration submission ID");

  const registrationId = safeId(submissionId, crypto.randomUUID());
  const registrationType = normalizeRegistrationType(formType, values);
  const participants = buildParticipants(formType, values, registrationId);
  const submitted = formType === "mls_registration" || bool(values?.submitted);
  const timestamp = now();
  const submittedAt = first(values, "submitted_at", "submittedAt") || (submitted ? timestamp : null);
  const parentFirst = first(values, "parent_first_name", "first_name");
  const parentLast = first(values, "parent_last_name", "last_name");
  const parentEmail = first(values, "parent_email", "email").toLowerCase();

  await env.DB.prepare(`
    INSERT INTO registrations (
      id, submission_id, program_id, season_id, registration_type, status,
      parent_first_name, parent_last_name, parent_email, parent_phone,
      parent_street, parent_apt, parent_city, parent_state, parent_zip,
      emergency_first_name, emergency_last_name, emergency_relationship,
      emergency_email, emergency_phone, scholarship_requested, help_choice,
      raw_payload_json, source, created_at, updated_at, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO UPDATE SET
      season_id = COALESCE(excluded.season_id, registrations.season_id),
      registration_type = excluded.registration_type,
      status = CASE WHEN registrations.status = 'complete' THEN registrations.status ELSE excluded.status END,
      parent_first_name = excluded.parent_first_name,
      parent_last_name = excluded.parent_last_name,
      parent_email = excluded.parent_email,
      parent_phone = excluded.parent_phone,
      parent_street = excluded.parent_street,
      parent_apt = excluded.parent_apt,
      parent_city = excluded.parent_city,
      parent_state = excluded.parent_state,
      parent_zip = excluded.parent_zip,
      emergency_first_name = excluded.emergency_first_name,
      emergency_last_name = excluded.emergency_last_name,
      emergency_relationship = excluded.emergency_relationship,
      emergency_email = excluded.emergency_email,
      emergency_phone = excluded.emergency_phone,
      scholarship_requested = excluded.scholarship_requested,
      help_choice = excluded.help_choice,
      raw_payload_json = excluded.raw_payload_json,
      source = excluded.source,
      updated_at = excluded.updated_at,
      submitted_at = COALESCE(registrations.submitted_at, excluded.submitted_at)
  `).bind(
    registrationId,
    submissionId,
    programId,
    seasonId,
    registrationType,
    submitted ? "submitted" : "incomplete",
    parentFirst,
    parentLast,
    parentEmail,
    first(values, "parent_phone", "phone"),
    first(values, "parent_street", "street"),
    first(values, "parent_apt", "apt", "apartment"),
    first(values, "parent_city", "city"),
    first(values, "parent_state", "state"),
    first(values, "parent_zip", "zip", "postal_code"),
    first(values, "emergency_first_name"),
    first(values, "emergency_last_name"),
    first(values, "emergency_relationship"),
    first(values, "emergency_email"),
    first(values, "emergency_phone"),
    bool(values?.scholarship_requested) ? 1 : 0,
    first(values, "help_choice"),
    json(values),
    source,
    timestamp,
    timestamp,
    submittedAt,
  ).run();

  for (const participant of participants) {
    await env.DB.prepare(`
      INSERT INTO registration_participants (
        id, registration_id, participant_type, slot_index, first_name, last_name,
        date_of_birth, gender_identity, grade_or_age, race_ethnicity,
        race_ethnicity_other, favorite_club, jersey_size, shorts_size, sock_size,
        how_heard, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        date_of_birth = excluded.date_of_birth,
        gender_identity = excluded.gender_identity,
        grade_or_age = excluded.grade_or_age,
        race_ethnicity = excluded.race_ethnicity,
        race_ethnicity_other = excluded.race_ethnicity_other,
        favorite_club = excluded.favorite_club,
        jersey_size = excluded.jersey_size,
        shorts_size = excluded.shorts_size,
        sock_size = excluded.sock_size,
        how_heard = excluded.how_heard,
        updated_at = excluded.updated_at
    `).bind(
      participant.id,
      registrationId,
      participant.type,
      participant.slot,
      participant.firstName,
      participant.lastName,
      participant.dob,
      participant.gender,
      participant.gradeOrAge,
      participant.race,
      participant.raceOther,
      participant.favoriteClub,
      participant.jersey,
      participant.shorts,
      participant.socks,
      participant.howHeard,
      timestamp,
      timestamp,
    ).run();
  }

  await env.DB.prepare(`
    INSERT INTO sync_events (id, registration_id, target, status, attempt_count, created_at, updated_at)
    VALUES (?, ?, 'google_sheets', 'pending', 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).bind(`${registrationId}-google-sheets`, registrationId, timestamp, timestamp).run();

  return { registrationId, submissionId, participantCount: participants.length };
}

export async function recordSheetsSync(env, { registrationId, ok, error = "" }) {
  if (!env?.DB || !registrationId) return;
  const timestamp = now();
  await env.DB.prepare(`
    UPDATE sync_events
    SET status = ?, attempt_count = attempt_count + 1, last_error = ?,
        last_attempted_at = ?, synced_at = ?, updated_at = ?
    WHERE registration_id = ? AND target = 'google_sheets'
  `).bind(ok ? "synced" : "failed", ok ? null : text(error).slice(0, 1000), timestamp, ok ? timestamp : null, timestamp, registrationId).run();
}

export async function updateAgreementInD1(env, input) {
  if (!env?.DB) throw new Error("D1 binding env.DB is not configured");
  const submissionId = text(input?.submissionId);
  if (!submissionId) throw new Error("Missing agreement submission ID");
  const registration = await env.DB.prepare(
    "SELECT id FROM registrations WHERE submission_id = ? LIMIT 1",
  ).bind(submissionId).first();
  if (!registration?.id) return { ok: false, missing: true };

  const agreementType = text(input?.agreementType).toLowerCase();
  const documentType = agreementType === "player"
    ? "player_agreement"
    : agreementType === "ppf" || agreementType === "ppf_liability"
      ? "ppf_liability"
      : "volunteer_agreement";
  const documentId = `${registration.id}-${documentType}`;
  await env.DB.prepare(`
    INSERT INTO registration_documents (
      id, registration_id, document_type, status, r2_object_key, sha256,
      transaction_id, signed_at, signer_name, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      r2_object_key = excluded.r2_object_key,
      sha256 = excluded.sha256,
      transaction_id = excluded.transaction_id,
      signed_at = excluded.signed_at,
      signer_name = excluded.signer_name,
      updated_at = excluded.updated_at
  `).bind(
    documentId,
    registration.id,
    documentType,
    text(input?.status).toLowerCase().includes("fail") ? "failed" : "generated",
    text(input?.objectKey || input?.fileId),
    text(input?.sha256),
    text(input?.transactionId),
    text(input?.signedAt),
    text(input?.signerName),
    now(),
  ).run();
  return { ok: true, registrationId: registration.id };
}

export async function updatePaymentInD1(env, input) {
  if (!env?.DB) throw new Error("D1 binding env.DB is not configured");
  const submissionId = text(input?.submissionId);
  if (!submissionId) throw new Error("Missing payment submission ID");
  const paymentStatus = text(input?.paymentStatus).toLowerCase() === "paid" ? "paid" : "pending";
  const result = await env.DB.prepare(`
    UPDATE registrations
    SET payment_status = ?, payment_amount_cents = ?, payment_transaction_id = ?,
        status = CASE WHEN ? = 'paid' AND status IN ('submitted', 'payment_pending') THEN 'complete' ELSE status END,
        updated_at = ?
    WHERE submission_id = ?
  `).bind(
    paymentStatus,
    Math.round(Number(input?.paymentAmount || 0) * 100) || null,
    text(input?.paymentTransactionId),
    paymentStatus,
    now(),
    submissionId,
  ).run();
  return { ok: Number(result?.meta?.changes || 0) > 0 };
}

export async function getRegistrationFromD1(env, submissionId) {
  if (!env?.DB) return { ok: false, error: "D1 binding env.DB is not configured" };
  const row = await env.DB.prepare(`
    SELECT r.*, GROUP_CONCAT(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), ', ') AS participant_names
    FROM registrations r
    LEFT JOIN registration_participants p ON p.registration_id = r.id
    WHERE r.submission_id = ?
    GROUP BY r.id
    LIMIT 1
  `).bind(text(submissionId)).first();
  if (!row) return { ok: false, error: "Registration not found" };
  return {
    ok: true,
    parentEmail: text(row.parent_email),
    parentName: `${text(row.parent_first_name)} ${text(row.parent_last_name)}`.trim(),
    participantNames: text(row.participant_names),
    paymentStatus: text(row.payment_status),
    paymentTransactionId: text(row.payment_transaction_id),
  };
}

export async function findPaymentRegistrationInD1(env, input) {
  if (!env?.DB) return { ok: false, error: "D1 binding env.DB is not configured" };
  const email = text(input?.parentEmail).toLowerCase();
  const name = text(input?.parentName).toLowerCase();
  const row = await env.DB.prepare(`
    SELECT r.submission_id, r.parent_email, r.parent_first_name, r.parent_last_name,
           r.payment_status, r.payment_transaction_id,
           GROUP_CONCAT(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), ', ') AS participant_names
    FROM registrations r
    LEFT JOIN registration_participants p ON p.registration_id = r.id
    WHERE r.program_id = ?
      AND (? = '' OR LOWER(r.parent_email) = ?)
      AND (? = '' OR LOWER(TRIM(r.parent_first_name || ' ' || r.parent_last_name)) = ?)
    GROUP BY r.id
    ORDER BY r.created_at DESC
    LIMIT 1
  `).bind(PROGRAM_ID, email, email, name, name).first();
  if (!row) return { ok: false, error: "Registration not found" };
  return {
    ok: true,
    submissionId: text(row.submission_id),
    parentEmail: text(row.parent_email),
    parentName: `${text(row.parent_first_name)} ${text(row.parent_last_name)}`.trim(),
    participantNames: text(row.participant_names),
    paymentStatus: text(row.payment_status),
    paymentTransactionId: text(row.payment_transaction_id),
  };
}
