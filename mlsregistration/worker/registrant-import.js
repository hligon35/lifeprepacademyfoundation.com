import { upsertRegistrationToD1 } from "./d1-registration.js";

const VALID_STATUSES = new Set([
  "incomplete",
  "submitted",
  "scholarship_pending",
  "agreement_pending",
  "payment_pending",
  "complete",
  "withdrawn",
]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function first(row, ...keys) {
  for (const key of keys) {
    const value = text(row?.[key]);
    if (value) return value;
  }
  return "";
}

function normalizedKey(key) {
  return text(key)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// The Players sheet has stable name columns even though its exported header
// labels have changed over time. Column indexes are zero-based here.
const PLAYERS_SHEET_NAME_COLUMNS = Object.freeze({
  parentFirst: { letter: "AA", index: 26 },
  parentLast: { letter: "AB", index: 27 },
  player1First: { letter: "AN", index: 39 },
  player1Last: { letter: "AO", index: 40 },
  player2First: { letter: "BA", index: 52 },
  player2Last: { letter: "BB", index: 53 },
  player3First: { letter: "BN", index: 65 },
  player3Last: { letter: "BO", index: 66 },
});

function sourceColumnValue(values, cells, column) {
  const fromCells = Array.isArray(cells) ? text(cells[column.index]) : "";
  return fromCells || first(values, column.letter, column.letter.toLowerCase());
}

export function applyPlayersSheetNameMapping(values, cells = null) {
  const mappings = [
    ["parent_first_name", PLAYERS_SHEET_NAME_COLUMNS.parentFirst],
    ["parent_last_name", PLAYERS_SHEET_NAME_COLUMNS.parentLast],
    ["player_1_first_name", PLAYERS_SHEET_NAME_COLUMNS.player1First],
    ["player_1_last_name", PLAYERS_SHEET_NAME_COLUMNS.player1Last],
    ["player_2_first_name", PLAYERS_SHEET_NAME_COLUMNS.player2First],
    ["player_2_last_name", PLAYERS_SHEET_NAME_COLUMNS.player2Last],
    ["player_3_first_name", PLAYERS_SHEET_NAME_COLUMNS.player3First],
    ["player_3_last_name", PLAYERS_SHEET_NAME_COLUMNS.player3Last],
  ];

  for (const [target, column] of mappings) {
    if (!first(values, target)) {
      const value = sourceColumnValue(values, cells, column);
      if (value) values[target] = value;
    }
  }

  if (!first(values, "player_count", "number_of_players")) {
    const count = [1, 2, 3].filter((index) =>
      first(values, `player_${index}_first_name`, `player_${index}_last_name`),
    ).length;
    if (count) values.player_count = String(count);
  }
  return values;
}

function originalPayloadCells(payload) {
  const entries = Object.entries(payload || {});
  const originalEntries = entries.filter(([key]) => {
    const normalized = normalizedKey(key);
    return normalized !== key || !entries.some(([candidate]) =>
      candidate !== key && normalizedKey(candidate) === normalized,
    );
  });
  return originalEntries.map(([, value]) => text(value));
}

export function playersSheetNameFields(payload) {
  const values = payload || {};
  const cells = originalPayloadCells(values);
  const read = (column) => sourceColumnValue(values, cells, column);
  const players = [
    [read(PLAYERS_SHEET_NAME_COLUMNS.player1First), read(PLAYERS_SHEET_NAME_COLUMNS.player1Last)],
    [read(PLAYERS_SHEET_NAME_COLUMNS.player2First), read(PLAYERS_SHEET_NAME_COLUMNS.player2Last)],
    [read(PLAYERS_SHEET_NAME_COLUMNS.player3First), read(PLAYERS_SHEET_NAME_COLUMNS.player3Last)],
  ]
    .map(([firstName, lastName]) => `${firstName} ${lastName}`.trim())
    .filter(Boolean);
  return {
    parentFirst: read(PLAYERS_SHEET_NAME_COLUMNS.parentFirst),
    parentLast: read(PLAYERS_SHEET_NAME_COLUMNS.parentLast),
    playerNames: players,
    participantNames: players.join("||"),
  };
}

function normalizeImportedValues(row) {
  const values = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    values[key] = value;
    const normalized = normalizedKey(key);
    if (normalized && values[normalized] === undefined) values[normalized] = value;
  });
  return values;
}

function normalizedStatus(value) {
  return text(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizePaymentStatus(value) {
  const status = normalizedStatus(value);
  if (/paid|complete|completed|received|yes|true/.test(status)) return "paid";
  if (/pending|awaiting|partial|owed|unpaid/.test(status)) return "pending";
  return "unpaid";
}

function normalizeAgreementStatus(value) {
  const status = normalizedStatus(value);
  if (/signed|complete|completed|accepted|generated/.test(status)) return "complete";
  if (/failed|error/.test(status)) return "failed";
  return "pending";
}

function parseAmountCents(value) {
  const normalized = text(value).replace(/[$,]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function deriveRegistrationStatus(row, paymentStatus, agreementStatus) {
  const explicit = normalizedStatus(first(row, "status", "registration_status"));
  if (VALID_STATUSES.has(explicit)) return explicit;
  if (normalizedStatus(first(row, "scholarship_eligibility", "scholarship_status")) === "pending") {
    return "scholarship_pending";
  }
  if (paymentStatus === "paid" && agreementStatus === "complete") return "complete";
  if (agreementStatus !== "complete") return "agreement_pending";
  if (paymentStatus !== "paid") return "payment_pending";
  return "submitted";
}

function normalizeRow(row) {
  const values = normalizeImportedValues(row);
  applyPlayersSheetNameMapping(values);
  const submissionId = first(
    values,
    "registration_submission_id",
    "submission_id",
    "registrationSubmissionId",
    "submissionId",
  );
  if (submissionId && !values.registration_submission_id) {
    values.registration_submission_id = submissionId;
  }
  const parentFirst = first(
    values,
    "parent_first_name",
    "parent_guardian_first_name",
    "guardian_first_name",
  );
  const parentLast = first(
    values,
    "parent_last_name",
    "parent_guardian_last_name",
    "guardian_last_name",
  );
  if (parentFirst && !values.parent_first_name) values.parent_first_name = parentFirst;
  if (parentLast && !values.parent_last_name) values.parent_last_name = parentLast;
  const scholarshipRequested = first(
    values,
    "scholarship_requested",
    "Scholarship Requested",
    "scholarshipRequested",
    "Scholarship",
  );
  if (scholarshipRequested && !values.scholarship_requested) {
    values.scholarship_requested = scholarshipRequested;
  }
  const lpafStatus = first(
    values,
    "agree_ppf_liability",
    "PPF Liability Status",
    "ppf_liability_status",
  ).toLowerCase();
  const lpafFile = first(
    values,
    "PPF Liability File ID",
    "PPF Liability PDF URL",
    "ppf_liability_file_id",
    "ppf_liability_pdf_url",
  );
  if (!values.agree_ppf_liability && (lpafFile || /yes|true|signed|complete|generated|viewed/.test(lpafStatus))) {
    values.agree_ppf_liability = "yes";
  }
  if (!values.form_type) values.form_type = "mls_registration";
  return { values, submissionId };
}

export async function importSheetRegistrants(env, {
  programId,
  seasonId = null,
  rows = [],
}) {
  if (!env?.DB) throw new Error("D1 binding env.DB is not configured");
  if (!Array.isArray(rows)) throw new Error("Import rows must be an array");
  if (rows.length > 5000) throw new Error("Import is limited to 5,000 rows per upload");

  const result = { imported: 0, updated: 0, skipped: 0, errors: [] };
  for (const sourceRow of rows) {
    const { values, submissionId } = normalizeRow(sourceRow);
    const formType = normalizedStatus(values.form_type);
    if (!submissionId || (formType && formType !== "mls_registration")) {
      result.skipped += 1;
      continue;
    }

    try {
      const existing = await env.DB.prepare(
        "SELECT id, status FROM registrations WHERE submission_id = ? LIMIT 1",
      ).bind(submissionId).first();
      const paymentStatus = normalizePaymentStatus(
        first(values, "Player Payment Status", "payment_status"),
      );
      const agreementStatus = normalizeAgreementStatus(
        first(values, "Player Agreement Status", "agreement_status"),
      );
      const registrationStatus = deriveRegistrationStatus(
        values,
        paymentStatus,
        agreementStatus,
      );

      const upserted = await upsertRegistrationToD1(env, {
        formType: "mls_registration",
        values,
        programId,
        seasonId,
        source: "google_sheets_import",
      });
      const timestamp = new Date().toISOString();
      await env.DB.prepare(`
        UPDATE registrations
        SET status = CASE WHEN status = 'complete' THEN status ELSE ? END,
            payment_status = ?,
            payment_amount_cents = COALESCE(?, payment_amount_cents),
            payment_transaction_id = COALESCE(NULLIF(?, ''), payment_transaction_id),
            agreement_status = ?,
            source = 'google_sheets_import',
            updated_at = ?
        WHERE id = ?
      `).bind(
        registrationStatus,
        paymentStatus,
        parseAmountCents(first(values, "Player Payment Amount", "payment_amount")),
        first(values, "Player Payment Transaction ID", "payment_transaction_id"),
        agreementStatus,
        timestamp,
        upserted.registrationId,
      ).run();
      await env.DB.prepare(`
        UPDATE sync_events
        SET status = 'synced', synced_at = ?, last_attempted_at = ?, updated_at = ?
        WHERE registration_id = ? AND target = 'google_sheets'
      `).bind(timestamp, timestamp, timestamp, upserted.registrationId).run();

      if (existing) result.updated += 1;
      else result.imported += 1;
    } catch (error) {
      if (result.errors.length < 50) {
        result.errors.push({
          submissionId,
          error: text(error?.message || error).slice(0, 500),
        });
      }
    }
  }
  return result;
}

export function parseCsv(textValue) {
  const input = String(textValue || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows.shift().map((header) => text(header));
  return rows
    .filter((cells) => cells.some((cell) => text(cell)))
    .map((cells) => {
      const record = headers.reduce((result, header, index) => {
        if (header) result[header] = text(cells[index]);
        return result;
      }, {});
      applyPlayersSheetNameMapping(record, cells);
      return record;
    });
}
