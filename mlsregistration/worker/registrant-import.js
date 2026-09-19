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
  const values = { ...(row || {}) };
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
    .map((cells) => headers.reduce((record, header, index) => {
      if (header) record[header] = text(cells[index]);
      return record;
    }, {}));
}
