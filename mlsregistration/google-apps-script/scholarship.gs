/**
 * Paducah GO Soccer Scholarship Acceptance Web App — Production (Refresh/Cleanup Compatible)
 * Keep this in its own standalone Apps Script project.
 */

const SCHOLARSHIP_CONFIG = Object.freeze({
  SPREADSHEET_ID: '1EIG6F00-mVhT9ws0nS3pJBrp9Y2mPH87p6UyLkWtKT4',
  SCHOLARSHIPS_SHEET: 'Scholarships',
  PLAYERS_SHEET: 'Players',
  TIME_ZONE: 'America/Indianapolis',
  DOCUMENT_VERSION: '1.0',
  TOKEN_VALID_DAYS: 60,
  WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbx1B_NuTAUDW86CFr0WQE8tYIZE1aVEGUcPzkvng0CBUSBxpmUJ_JKlKyRaLW_sK439dA/exec',
  WEBHOOK_ACTION: 'send_new_scholarship_terms',
  LINK_ACTION: 'create_scholarship_acceptance_link',
  LIVE_ARCHIVE_ACTION: 'archive_live_scholarship_application',
  WEBHOOK_TOKEN_PROPERTY: 'SCHOLARSHIP_LIVE_WEBHOOK_TOKEN',
  SIGNING_SECRET_PROPERTY: 'SCHOLARSHIP_ACCEPTANCE_SECRET',
  TEMPLATE_DOCUMENT_ID: '1JW5mgQ9TPu5BSmYZnl8SHy4yT4_mWzu7jPN34csvJZo',
  AGREEMENT_FOLDER_NAME: 'Paducah GO Scholarship Agreements',
  APPLICATIONS_FOLDER_ID: '1Qg8e_tlphUmT17HBiaw3Onz3h3i7LKSX',
  APOLOGY_TARGET_ROW: 2,
  EMAIL_SUBJECT: 'Paducah GO Soccer Scholarship Guidelines – Acceptance Required',
  APOLOGY_SUBJECT: 'Corrected Link – Paducah GO Soccer Scholarship Guidelines',
  SENDER_NAME: 'Paducah GO Soccer',
  BANNER_URL: 'https://mlsregistration.lifeprepacademyfoundation.com/LPAFxPGS.PNG',
  REQUIRED_HEADERS: [
    'registration_submission_id',
    'parent_first_name',
    'parent_last_name',
    'parent_email',
    'participant_names'
  ],
  TRACKING_HEADERS: [
    'scholarship_terms_exclude',
    'scholarship_terms_status',
    'scholarship_terms_sent_at',
    'scholarship_terms_accepted_at',
    'scholarship_terms_parent_name',
    'scholarship_terms_participant_names',
    'scholarship_terms_grades',
    'scholarship_terms_version',
    'scholarship_terms_acceptance_id',
    'scholarship_terms_document_url',
    'scholarship_terms_document_file_id',
    'scholarship_terms_document_created_at',
    'scholarship_terms_document_participant_count',
    'scholarship_terms_pdf_url',
    'scholarship_terms_pdf_file_id',
    'scholarship_terms_pdf_created_at',
    'scholarship_terms_error'
  ]
});

/** Run once after installing the script. */
function SCHOLARSHIP_setup() {
  const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
  scholarshipEnsureTrackingHeaders_(sheet);
  scholarshipEnsureExcludeCheckboxes_(sheet);
  scholarshipGetSigningSecret_();
  scholarshipGetWebhookToken_();
  return {ok: true, message: 'Scholarship acceptance and live automation are ready.'};
}

/** Returns the URL and private token needed by the registration/form project. */
function SCHOLARSHIP_getLiveWebhookConfiguration() {
  const result = {
    webAppUrl: scholarshipGetWebAppUrl_(),
    action: SCHOLARSHIP_CONFIG.WEBHOOK_ACTION,
    linkAction: SCHOLARSHIP_CONFIG.LINK_ACTION,
    archiveAction: SCHOLARSHIP_CONFIG.LIVE_ARCHIVE_ACTION,
    scriptProperty: SCHOLARSHIP_CONFIG.WEBHOOK_TOKEN_PROPERTY,
    token: scholarshipGetWebhookToken_()
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Sends terms only to unsent, eligible rows already in Scholarships. */
function SCHOLARSHIP_sendInitialTermsEmails() {
  const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
  scholarshipEnsureTrackingHeaders_(sheet);
  const table = scholarshipReadTable_(sheet);
  const map = scholarshipHeaderMap_(table.headers);
  scholarshipRequireHeaders_(map, SCHOLARSHIP_CONFIG.REQUIRED_HEADERS);
  const result = {sent: 0, excluded: 0, skipped: 0, failed: []};

  table.rows.forEach(function(row, index) {
    const rowNumber = index + 2;
    const status = scholarshipValue_(row, map, 'scholarship_terms_status').toLowerCase();
    if (scholarshipChecked_(scholarshipValue_(row, map, 'scholarship_terms_exclude'))) {
      result.excluded++;
      return;
    }
    if (status === 'sent' || status === 'accepted') {
      result.skipped++;
      return;
    }
    try {
      const sent = scholarshipSendTermsForRow_(sheet, table, map, rowNumber, false, false);
      if (sent.sent) result.sent++;
      else result.skipped++;
    } catch (error) {
      result.failed.push({row: rowNumber, error: scholarshipError_(error)});
    }
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Sends an apology and corrected link only to APOLOGY_TARGET_ROW. */
function SCHOLARSHIP_sendApologyToOneRow() {
  const rowNumber = Number(SCHOLARSHIP_CONFIG.APOLOGY_TARGET_ROW);
  const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
  scholarshipEnsureTrackingHeaders_(sheet);
  const table = scholarshipReadTable_(sheet);
  const map = scholarshipHeaderMap_(table.headers);
  scholarshipRequireHeaders_(map, SCHOLARSHIP_CONFIG.REQUIRED_HEADERS);
  if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > sheet.getLastRow()) {
    throw new Error('APOLOGY_TARGET_ROW is not a valid Scholarships row.');
  }
  const result = scholarshipSendTermsForRow_(sheet, table, map, rowNumber, true, true);
  return {ok: true, row: rowNumber, sentTo: result.parentEmail, apologyIncluded: true};
}

/** Serves the personalized scholarship guidelines page. */
function doGet(e) {
  try {
    const token = scholarshipNormalize_(e && e.parameter && e.parameter.t);
    const payload = scholarshipVerifyToken_(token);
    const record = scholarshipGetAcceptanceRecord_(payload);
    return HtmlService.createHtmlOutput(scholarshipBuildTermsPage_(token, record))
      .setTitle('Paducah GO Soccer Scholarship Guidelines')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  } catch (error) {
    return HtmlService.createHtmlOutput(scholarshipBuildErrorPage_(error))
      .setTitle('Scholarship Link Error');
  }
}

/** Receives the live notification after a new scholarship row is saved. */
function doPost(e) {
  try {
    const values = scholarshipParsePostValues_(e);
    const action = scholarshipNormalize_(values.action);
    if (action !== SCHOLARSHIP_CONFIG.WEBHOOK_ACTION &&
      action !== SCHOLARSHIP_CONFIG.LINK_ACTION &&
      action !== SCHOLARSHIP_CONFIG.LIVE_ARCHIVE_ACTION) {
      return scholarshipJson_({ok: false, error: 'Unknown action.'});
    }
    const expected = scholarshipGetWebhookToken_();
    const provided = scholarshipNormalize_(values.webhook_token);
    if (!provided || !scholarshipConstantTimeEquals_(expected, provided)) {
      return scholarshipJson_({ok: false, error: 'Unauthorized request.'});
    }
    const registrationId = scholarshipNormalize_(
      values.registration_submission_id || values.submission_id
    );
    const email = scholarshipNormalize_(values.parent_email || values.email).toLowerCase();
    if (!registrationId || !scholarshipValidEmail_(email)) {
      return scholarshipJson_({ok: false, error: 'Registration ID and parent email are required.'});
    }

    if (action === SCHOLARSHIP_CONFIG.LIVE_ARCHIVE_ACTION) {
      const forceRegenerate = scholarshipBoolean_(values.force_regenerate);
      return scholarshipJson_(scholarshipArchiveLiveSubmission_(
        registrationId,
        email,
        values.accepted_at || values.submitted_at,
        forceRegenerate
      ));
    }

    if (action === SCHOLARSHIP_CONFIG.LINK_ACTION) {
      return scholarshipJson_(scholarshipCreateAcceptanceLinkForRegistration_(
        registrationId,
        email
      ));
    }

    return scholarshipJson_(scholarshipSendTermsForRegistration_(registrationId, email));
  } catch (error) {
    return scholarshipJson_({ok: false, error: scholarshipError_(error)});
  }
}

function scholarshipParsePostValues_(e) {
  const params = Object.assign({}, (e && e.parameter) || {});
  const contents = e && e.postData && e.postData.contents
    ? String(e.postData.contents)
    : '';

  if (contents) {
    const contentType = String(
      (e.postData && e.postData.type) || ''
    ).toLowerCase();

    if (contentType.indexOf('application/json') >= 0 || contents.trim().charAt(0) === '{') {
      try {
        const parsed = JSON.parse(contents);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.keys(parsed).forEach(function(key) {
            if (typeof params[key] === 'undefined' || params[key] === '') {
              params[key] = parsed[key];
            }
          });
        }
      } catch (_error) {
        // Keep normal form/query parameters if the body is not valid JSON.
      }
    }
  }

  return params;
}

function scholarshipBoolean_(value) {
  if (value === true) return true;
  const normalized = scholarshipNormalize_(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function scholarshipArchiveLiveSubmission_(registrationId, email, submittedAtValue, forceRegenerate) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
    scholarshipEnsureTrackingHeaders_(sheet);
    const table = scholarshipReadTable_(sheet);
    const map = scholarshipHeaderMap_(table.headers);
    scholarshipRequireHeaders_(map, SCHOLARSHIP_CONFIG.REQUIRED_HEADERS);
    const rowNumber = scholarshipFindRow_(table.rows, map, registrationId, email);
    if (rowNumber < 2) throw new Error('The scholarship row could not be found for live archiving.');

    const row = table.rows[rowNumber - 2];
    const record = scholarshipRowRecord_(row, map);
    const participants = scholarshipGetParticipants_(record.registrationId, record.participantNames);
    if (!participants.length) throw new Error('No participants were found for this scholarship application.');

    const acceptedAt = scholarshipResolveAcceptedAt_(submittedAtValue, row, map);
    const acceptanceId = scholarshipValue_(row, map, 'scholarship_terms_acceptance_id') || Utilities.getUuid();
    const existingPdfUrl = scholarshipValue_(row, map, 'scholarship_terms_pdf_url');
    const existingPdfFileId = scholarshipValue_(row, map, 'scholarship_terms_pdf_file_id');
    const existingDocumentUrl = scholarshipValue_(row, map, 'scholarship_terms_document_url');

    if (!forceRegenerate && existingPdfUrl && existingPdfFileId && existingDocumentUrl) {
      scholarshipSetRowFields_(sheet, rowNumber, map, {
        scholarship_terms_status: 'Accepted',
        scholarship_terms_accepted_at: acceptedAt,
        scholarship_terms_parent_name: record.parentName,
        scholarship_terms_participant_names: record.participantNames,
        scholarship_terms_grades: participants.map(function(p) { return p.grade; }).filter(Boolean).join(', '),
        scholarship_terms_version: SCHOLARSHIP_CONFIG.DOCUMENT_VERSION,
        scholarship_terms_acceptance_id: acceptanceId,
        scholarship_terms_error: ''
      });
      return {
        ok: true,
        archived: true,
        alreadyArchived: true,
        row: rowNumber,
        pdfUrl: existingPdfUrl,
        pdfFileId: existingPdfFileId,
        documentUrl: existingDocumentUrl,
      };
    }

    let documentRecord;
    try {
      documentRecord = scholarshipCreateDocument_({
        registrationId: record.registrationId,
        parentName: record.parentName,
        parentEmail: record.parentEmail,
        participantRecords: participants,
        acceptedAt: acceptedAt,
        acceptanceId: acceptanceId,
        clientInfo: { source: forceRegenerate ? 'document_refresh' : 'live_registration_form' },
        forceRegenerate: forceRegenerate === true
      });
    } catch (error) {
      scholarshipSetRowFields_(sheet, rowNumber, map, {
        scholarship_terms_status: 'Archive Error',
        scholarship_terms_error: 'Document generation failed: ' + scholarshipError_(error)
      });
      throw error;
    }

    scholarshipSetRowFields_(sheet, rowNumber, map, {
      scholarship_terms_status: 'Accepted',
      scholarship_terms_accepted_at: acceptedAt,
      scholarship_terms_parent_name: record.parentName,
      scholarship_terms_participant_names: record.participantNames,
      scholarship_terms_grades: participants.map(function(p) { return p.grade; }).filter(Boolean).join(', '),
      scholarship_terms_version: SCHOLARSHIP_CONFIG.DOCUMENT_VERSION,
      scholarship_terms_acceptance_id: acceptanceId,
      scholarship_terms_document_url: documentRecord.url,
      scholarship_terms_document_file_id: documentRecord.fileId,
      scholarship_terms_document_created_at: documentRecord.createdAt,
      scholarship_terms_document_participant_count: documentRecord.participantCount,
      scholarship_terms_pdf_url: documentRecord.pdfUrl,
      scholarship_terms_pdf_file_id: documentRecord.pdfFileId,
      scholarship_terms_pdf_created_at: documentRecord.pdfCreatedAt,
      scholarship_terms_error: ''
    });

    return {
      ok: true,
      archived: true,
      row: rowNumber,
      pdfUrl: documentRecord.pdfUrl,
      pdfFileId: documentRecord.pdfFileId,
      documentUrl: documentRecord.url,
      documentFileId: documentRecord.fileId,
    };
  } finally {
    lock.releaseLock();
  }
}

/** Records acceptance and creates the completed Google Doc and PDF. */
function SCHOLARSHIP_submitAcceptance(token, accepted, clientInfo) {
  if (accepted !== true) throw new Error('You must check the acceptance box before submitting.');
  const payload = scholarshipVerifyToken_(scholarshipNormalize_(token));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
    scholarshipEnsureTrackingHeaders_(sheet);
    const table = scholarshipReadTable_(sheet);
    const map = scholarshipHeaderMap_(table.headers);
    const rowNumber = scholarshipFindRow_(table.rows, map, payload.registrationId, payload.email);
    if (rowNumber < 2) throw new Error('The matching scholarship record was not found.');

    const row = table.rows[rowNumber - 2];
    const record = scholarshipRowRecord_(row, map);
    const status = scholarshipValue_(row, map, 'scholarship_terms_status').toLowerCase();
    const acceptedAt = scholarshipDate_(row[map.scholarship_terms_accepted_at], new Date());
    let acceptanceId = scholarshipValue_(row, map, 'scholarship_terms_acceptance_id');
    if (!acceptanceId) acceptanceId = Utilities.getUuid();

    if (status === 'accepted') {
      return {ok: true, alreadyAccepted: true, acceptedAt: scholarshipDisplayDate_(acceptedAt)};
    }

    const participants = scholarshipGetParticipants_(
      record.registrationId,
      record.participantNames
    );
    if (!participants.length) throw new Error('No participants were found for this application.');

    let documentRecord;
    try {
      documentRecord = scholarshipCreateDocument_({
        registrationId: record.registrationId,
        parentName: record.parentName,
        parentEmail: record.parentEmail,
        participantRecords: participants,
        acceptedAt: acceptedAt,
        acceptanceId: acceptanceId,
        clientInfo: clientInfo || {}
      });
    } catch (error) {
      scholarshipSetRowFields_(sheet, rowNumber, map, {
        scholarship_terms_error: 'Document generation failed: ' + scholarshipError_(error)
      });
      throw error;
    }

    scholarshipSetRowFields_(sheet, rowNumber, map, {
      scholarship_terms_status: 'Accepted',
      scholarship_terms_accepted_at: acceptedAt,
      scholarship_terms_parent_name: record.parentName,
      scholarship_terms_participant_names: record.participantNames,
      scholarship_terms_grades: participants.map(function(p) { return p.grade; })
        .filter(Boolean).join(', '),
      scholarship_terms_version: SCHOLARSHIP_CONFIG.DOCUMENT_VERSION,
      scholarship_terms_acceptance_id: acceptanceId,
      scholarship_terms_document_url: documentRecord.url,
      scholarship_terms_document_file_id: documentRecord.fileId,
      scholarship_terms_document_created_at: documentRecord.createdAt,
      scholarship_terms_document_participant_count: documentRecord.participantCount,
      scholarship_terms_pdf_url: documentRecord.pdfUrl,
      scholarship_terms_pdf_file_id: documentRecord.pdfFileId,
      scholarship_terms_pdf_created_at: documentRecord.pdfCreatedAt,
      scholarship_terms_error: ''
    });
    return {
      ok: true,
      acceptedAt: scholarshipDisplayDate_(acceptedAt),
      acceptanceId: acceptanceId,
      participantDocumentCount: participants.length
    };
  } finally {
    lock.releaseLock();
  }
}

function scholarshipSendTermsForRegistration_(registrationId, email) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
    scholarshipEnsureTrackingHeaders_(sheet);
    const table = scholarshipReadTable_(sheet);
    const map = scholarshipHeaderMap_(table.headers);
    scholarshipRequireHeaders_(map, SCHOLARSHIP_CONFIG.REQUIRED_HEADERS);
    const rowNumber = scholarshipFindRow_(table.rows, map, registrationId, email);
    if (rowNumber < 2) throw new Error('The new scholarship row could not be found.');
    return scholarshipSendTermsForRow_(sheet, table, map, rowNumber, false, false);
  } finally {
    lock.releaseLock();
  }
}

function scholarshipCreateAcceptanceLinkForRegistration_(registrationId, email) {
  const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
  scholarshipEnsureTrackingHeaders_(sheet);
  const table = scholarshipReadTable_(sheet);
  const map = scholarshipHeaderMap_(table.headers);
  scholarshipRequireHeaders_(map, SCHOLARSHIP_CONFIG.REQUIRED_HEADERS);
  const rowNumber = scholarshipFindRow_(table.rows, map, registrationId, email);
  if (rowNumber < 2) throw new Error('The scholarship row could not be found.');

  const row = table.rows[rowNumber - 2];
  if (scholarshipChecked_(scholarshipValue_(row, map, 'scholarship_terms_exclude'))) {
    throw new Error('The selected scholarship row is excluded from email sends.');
  }

  const record = scholarshipRowRecord_(row, map);
  if (!record.registrationId || !scholarshipValidEmail_(record.parentEmail) ||
      !record.participantNames) {
    throw new Error('The row is missing its registration ID, email, or participant names.');
  }

  return {
    ok: true,
    row: rowNumber,
    acceptanceUrl: scholarshipBuildAcceptanceUrl_(record),
    parentName: record.parentName,
    participantNames: record.participantNames
  };
}

function scholarshipSendTermsForRow_(sheet, table, map, rowNumber, corrected, allowResend) {
  const row = table.rows[rowNumber - 2];
  if (!row) throw new Error('The selected scholarship row does not exist.');
  if (scholarshipChecked_(scholarshipValue_(row, map, 'scholarship_terms_exclude'))) {
    throw new Error('The selected scholarship row is excluded from email sends.');
  }
  const status = scholarshipValue_(row, map, 'scholarship_terms_status').toLowerCase();
  if (status === 'accepted') throw new Error('This parent has already accepted the guidelines.');
  if (!allowResend && status === 'sent') {
    return {ok: true, sent: false, duplicate: true, row: rowNumber};
  }
  const record = scholarshipRowRecord_(row, map);
  if (!record.registrationId || !scholarshipValidEmail_(record.parentEmail) ||
      !record.participantNames) {
    throw new Error('The row is missing its registration ID, email, or participant names.');
  }
  record.grades = scholarshipGetParticipants_(record.registrationId, record.participantNames)
    .map(function(p) { return p.grade; }).filter(Boolean).join(', ');
  record.acceptanceUrl = scholarshipBuildAcceptanceUrl_(record);
  record.correctedLinkNotice = corrected === true;

  try {
    scholarshipSendEmail_(
      record,
      corrected ? SCHOLARSHIP_CONFIG.APOLOGY_SUBJECT : SCHOLARSHIP_CONFIG.EMAIL_SUBJECT
    );
    scholarshipSetRowFields_(sheet, rowNumber, map, {
      scholarship_terms_status: 'Sent',
      scholarship_terms_sent_at: new Date(),
      scholarship_terms_parent_name: record.parentName,
      scholarship_terms_participant_names: record.participantNames,
      scholarship_terms_grades: record.grades,
      scholarship_terms_version: SCHOLARSHIP_CONFIG.DOCUMENT_VERSION,
      scholarship_terms_error: ''
    });
    return {ok: true, sent: true, row: rowNumber, parentEmail: record.parentEmail};
  } catch (error) {
    scholarshipSetRowFields_(sheet, rowNumber, map, {
      scholarship_terms_status: 'Email Error',
      scholarship_terms_error: scholarshipError_(error)
    });
    throw error;
  }
}

function scholarshipRowRecord_(row, map) {
  return {
    registrationId: scholarshipValue_(row, map, 'registration_submission_id'),
    parentName: [
      scholarshipValue_(row, map, 'parent_first_name'),
      scholarshipValue_(row, map, 'parent_last_name')
    ].filter(Boolean).join(' ') || 'Parent/Guardian',
    parentEmail: scholarshipValue_(row, map, 'parent_email').toLowerCase(),
    participantNames: scholarshipValue_(row, map, 'participant_names')
  };
}

function scholarshipBuildAcceptanceUrl_(record) {
  const now = Date.now();
  const token = scholarshipCreateToken_({
    registrationId: record.registrationId,
    email: record.parentEmail,
    iat: now,
    exp: now + SCHOLARSHIP_CONFIG.TOKEN_VALID_DAYS * 86400000,
    nonce: Utilities.getUuid()
  });
  return scholarshipGetWebAppUrl_() + '?t=' + encodeURIComponent(token);
}

function scholarshipGetAcceptanceRecord_(payload) {
  const sheet = scholarshipGetSheet_(SCHOLARSHIP_CONFIG.SCHOLARSHIPS_SHEET);
  scholarshipEnsureTrackingHeaders_(sheet);
  const table = scholarshipReadTable_(sheet);
  const map = scholarshipHeaderMap_(table.headers);
  scholarshipRequireHeaders_(map, SCHOLARSHIP_CONFIG.REQUIRED_HEADERS);
  const rowNumber = scholarshipFindRow_(table.rows, map, payload.registrationId, payload.email);
  if (rowNumber < 2) throw new Error('The scholarship record associated with this link was not found.');
  const row = table.rows[rowNumber - 2];
  const record = scholarshipRowRecord_(row, map);
  record.grades = scholarshipGetParticipants_(record.registrationId, record.participantNames)
    .map(function(p) { return p.grade; }).filter(Boolean).join(', ');
  record.status = scholarshipValue_(row, map, 'scholarship_terms_status');
  record.acceptedAt = scholarshipDisplayDate_(row[map.scholarship_terms_accepted_at]);
  return record;
}

function scholarshipSendEmail_(record, subject) {
  const parent = scholarshipEscapeHtml_(record.parentName);
  const participants = scholarshipEscapeHtml_(record.participantNames);
  const url = scholarshipEscapeHtml_(record.acceptanceUrl);
  const apology = record.correctedLinkNotice
    ? '<div style="margin:0 0 18px;padding:16px;border-radius:8px;background:#eef4fb;border:1px solid #b8cce4;color:#173f7a;line-height:1.6"><strong>We apologize for the previous email.</strong> Its button contained an incorrect link and may not have opened properly. That issue has been corrected. Please disregard the earlier message and use the updated button below. You will not need to request access.</div>'
    : '';
  const html = '<!doctype html><html><body style="margin:0;background:#f3f6f4;font-family:Arial,sans-serif;color:#18251f">' +
    '<table width="100%" cellspacing="0" cellpadding="0" style="padding:24px 10px"><tr><td align="center"><table width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden">' +
    '<tr><td><img src="' + scholarshipEscapeHtml_(SCHOLARSHIP_CONFIG.BANNER_URL) + '" alt="Paducah GO Soccer" width="600" style="display:block;width:100%;height:auto"></td></tr><tr><td style="padding:30px 34px 34px">' +
    '<h1 style="margin:0 0 14px;color:#173f7a;font-size:25px">Review your scholarship guidelines</h1><p>Hello ' + parent + ',</p>' + apology +
    '<p>Thank you for applying for a Paducah GO Soccer scholarship for <strong>' + participants + '</strong>.</p><p>To continue the scholarship process, please review and accept the Paducah GO Soccer Scholarship Guidelines. Your personalized agreement already includes the information provided in your application.</p><p>Please use the button below to review and accept the agreement:</p>' +
    '<p><a href="' + url + '" style="display:inline-block;padding:14px 23px;border-radius:7px;background:#0b5d3b;color:#fff;text-decoration:none;font-weight:bold">Review and Accept Scholarship Guidelines</a></p><p>If you have any questions or need assistance, please contact us.</p><p>Thank you,<br><strong>Paducah GO Soccer</strong><br>LifePrep Academy Foundation</p>' +
    '</td></tr></table></td></tr></table></body></html>';
  const apologyPlain = record.correctedLinkNotice
    ? 'We apologize for the previous email. Its link may not have opened properly. Please disregard it and use the corrected link below.\n\n'
    : '';
  const plain = 'Hello ' + record.parentName + ',\n\n' + apologyPlain +
    'Thank you for applying for a Paducah GO Soccer scholarship for ' + record.participantNames + '.\n\n' +
    'Review and accept the Scholarship Guidelines:\n' + record.acceptanceUrl + '\n\n' +
    'Thank you,\nPaducah GO Soccer\nLifePrep Academy Foundation';
  GmailApp.sendEmail(record.parentEmail, subject, plain, {
    htmlBody: html,
    name: SCHOLARSHIP_CONFIG.SENDER_NAME
  });
}

function scholarshipBuildTermsPage_(token, record) {
  const accepted = scholarshipNormalize_(record.status).toLowerCase() === 'accepted';
  const parent = scholarshipEscapeHtml_(record.parentName);
  const participants = scholarshipEscapeHtml_(record.participantNames);
  const grades = scholarshipEscapeHtml_(record.grades || 'Not provided');
  const tokenJson = JSON.stringify(token).replace(/</g, '\\u003c');
  const action = accepted
    ? '<div class="success"><strong>Accepted.</strong> This agreement was accepted on ' + scholarshipEscapeHtml_(record.acceptedAt) + '.</div>'
    : '<div class="accept"><label><input id="acceptBox" type="checkbox"><span>I am <strong>' + parent + '</strong>, the parent or guardian of <strong>' + participants + '</strong>. I have read, understand, and accept these guidelines.</span></label><button id="submitButton" type="button" disabled>Accept Scholarship Guidelines</button><div id="message" aria-live="polite"></div></div>';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:#eef3f0;color:#1d2f28;font-family:Arial,sans-serif;line-height:1.62}.page{max-width:820px;margin:28px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(20,45,34,.12)}.banner{display:block;width:100%;height:auto}.content{padding:34px 44px 42px}h1{margin:0 0 16px;color:#173f7a;font-size:30px}h2{margin:28px 0 10px;color:#173f7a;font-size:21px}.coverage{padding:14px 16px;background:#f3f8f5;border-left:4px solid #0b5d3b;border-radius:6px}li{margin-bottom:11px}.identity{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:22px 0;padding:18px;background:#f7f8fa;border:1px solid #d9e0dc;border-radius:8px}.field span{display:block;font-size:12px;text-transform:uppercase;color:#66736d;font-weight:bold}.field strong{display:block;margin-top:4px}.accept{margin-top:28px;padding:20px;border:2px solid #0b5d3b;border-radius:10px;background:#f7fbf8}.accept label{display:flex;gap:12px}.accept input{width:22px;height:22px;flex:none}button{margin-top:18px;padding:14px 22px;border:0;border-radius:7px;background:#0b5d3b;color:#fff;font-size:16px;font-weight:bold}button:disabled{background:#97aaa1}.success{margin:20px 0;padding:16px;background:#e6f4ea;color:#175c2e;border-radius:8px}.error{color:#9b1c1c}@media(max-width:650px){.page{margin:0;border-radius:0}.content{padding:26px 20px}.identity{grid-template-columns:1fr}}
</style></head><body><main class="page"><img class="banner" src="${scholarshipEscapeHtml_(SCHOLARSHIP_CONFIG.BANNER_URL)}" alt="LifePrep Academy Foundation and Paducah GO Soccer"><div class="content">
<h1>Paducah GO Soccer Scholarship Guidelines</h1><p>We understand that families may face unexpected challenges, which is why Paducah GO Soccer offers this scholarship—to ensure that financial hardship does not prevent a child from participating. To keep the scholarship program fair and available to all children, recipients and their families are expected to follow the participation, school attendance, conduct, and communication guidelines outlined below. These expectations are intended to support each child’s success both on and off the field.</p>
<p class="coverage"><strong>The scholarship covers the full $75 registration fee.</strong> It is intended for children who would otherwise be unable to participate because of the cost.</p>
<h2>Who can receive a scholarship</h2><ul><li><strong>Grade and school:</strong> The child is enrolled in grade K-12 at a public school in Paducah or the surrounding area.</li><li><strong>Financial need:</strong> A parent or guardian confirms that paying the $75 fee would be a hardship. No detailed financial records are required.</li><li><strong>Registration:</strong> The family completes the scholarship request and all regular player registration forms.</li><li><strong>Availability:</strong> Scholarships are awarded while scholarship funds and team spaces are available. One scholarship may be awarded per child, per season.</li></ul><p>Scholarships are not based on soccer ability, school grades, or prior playing experience.</p>
<h2>Guidelines for continuing through the season</h2><ul><li><strong>School attendance:</strong> The child should maintain at least 80% attendance in school. Excused absences for illness, disability, family emergencies, or other approved reasons will not count against the child.</li><li><strong>School conduct:</strong> The child should make a reasonable effort to learn without becoming an ongoing disruption to themselves or others. An isolated incident will not automatically affect the scholarship, but a continuing pattern identified by the school may require a family meeting and improvement plan.</li><li><strong>Respect:</strong> The child should behave respectfully toward parents and guardians, teachers, coaches, officials, teammates, and other families.</li><li><strong>Soccer participation:</strong> The player should attend practices and games regularly, with a goal of attending at least 75% of scheduled activities.</li><li><strong>Communication:</strong> A parent or guardian should notify the coach when the player will be absent. If the player has two consecutive unexcused absences, the program will contact the family to see whether help is needed.</li><li><strong>Inactive players:</strong> If the player stops attending and the family does not respond after reasonable contact attempts, the program may release the roster spot to another child.</li></ul><p>A scholarship will not be taken away because of an illness, emergency, transportation problem, disability-related need, or another reasonable hardship when the family communicates with the program.</p>
<h2>Family acknowledgment</h2><p>By accepting the scholarship, the family agrees to make a good-faith effort to help the player participate for the full season and to stay in contact with the coach.</p><div class="identity"><div class="field"><span>Player(s)</span><strong>${participants}</strong></div><div class="field"><span>Grade(s)</span><strong>${grades}</strong></div><div class="field"><span>Parent/Guardian</span><strong>${parent}</strong></div><div class="field"><span>Document version</span><strong>${scholarshipEscapeHtml_(SCHOLARSHIP_CONFIG.DOCUMENT_VERSION)}</strong></div></div>${action}</div></main>
<script>(function(){var token=${tokenJson},box=document.getElementById('acceptBox'),button=document.getElementById('submitButton'),message=document.getElementById('message');if(!box||!button)return;box.addEventListener('change',function(){button.disabled=!box.checked});button.addEventListener('click',function(){if(!box.checked)return;button.disabled=true;button.textContent='Submitting…';google.script.run.withSuccessHandler(function(r){message.textContent='Accepted successfully on '+r.acceptedAt+'.';message.className='success';box.disabled=true;button.style.display='none'}).withFailureHandler(function(e){message.textContent=e&&e.message?e.message:'The agreement could not be submitted.';message.className='error';button.disabled=false;button.textContent='Accept Scholarship Guidelines'}).SCHOLARSHIP_submitAcceptance(token,true,{userAgent:navigator.userAgent,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||''})})})();</script></body></html>`;
}

function scholarshipBuildErrorPage_(error) {
  return '<!doctype html><html><body style="margin:0;background:#eef3f0;font-family:Arial,sans-serif"><div style="max-width:650px;margin:50px auto;padding:30px;background:#fff;border-radius:12px"><h1 style="color:#9b1c1c">This scholarship link cannot be opened</h1><p>' + scholarshipEscapeHtml_(scholarshipError_(error)) + '</p><p>Please contact Paducah GO Soccer for a new personalized link.</p></div></body></html>';
}

function scholarshipCreateToken_(payload) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload), Utilities.Charset.UTF_8)
    .replace(/=+$/g, '');
  return body + '.' + scholarshipSign_(body);
}

function scholarshipVerifyToken_(token) {
  const parts = scholarshipNormalize_(token).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('The link is incomplete.');
  if (!scholarshipConstantTimeEquals_(scholarshipSign_(parts[0]), parts[1])) {
    throw new Error('The link signature is invalid.');
  }
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (error) {
    throw new Error('The link data is invalid.');
  }
  if (!payload.exp || Date.now() > Number(payload.exp)) throw new Error('This link has expired.');
  if (!payload.registrationId || !payload.email) throw new Error('The link is missing required information.');
  return payload;
}

function scholarshipSign_(value) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(
      String(value), scholarshipGetSigningSecret_(), Utilities.Charset.UTF_8
    )
  ).replace(/=+$/g, '');
}

function scholarshipConstantTimeEquals_(a, b) {
  a = String(a || '');
  b = String(b || '');
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    difference |= (a.charCodeAt(i % Math.max(a.length, 1)) || 0) ^
      (b.charCodeAt(i % Math.max(b.length, 1)) || 0);
  }
  return difference === 0;
}

function scholarshipGetSigningSecret_() {
  return scholarshipGetOrCreateSecret_(SCHOLARSHIP_CONFIG.SIGNING_SECRET_PROPERTY);
}

function scholarshipGetWebhookToken_() {
  return scholarshipGetOrCreateSecret_(SCHOLARSHIP_CONFIG.WEBHOOK_TOKEN_PROPERTY);
}

function scholarshipGetOrCreateSecret_(propertyName) {
  const properties = PropertiesService.getScriptProperties();
  let value = properties.getProperty(propertyName);
  if (!value) {
    value = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
    properties.setProperty(propertyName, value);
  }
  return value;
}

function scholarshipCreateDocument_(record) {
  if (!record.participantRecords || !record.participantRecords.length) {
    throw new Error('No participants were found for the scholarship document.');
  }
  const template = DriveApp.getFileById(SCHOLARSHIP_CONFIG.TEMPLATE_DOCUMENT_ID);
  const folder = scholarshipGetAgreementFolder_();
  const dateStamp = Utilities.formatDate(record.acceptedAt, SCHOLARSHIP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  const output = template.makeCopy(
    'Paducah GO Scholarship - ' + scholarshipSafeFilePart_(record.parentName) +
    ' - ' + scholarshipSafeFilePart_(record.registrationId) + ' - ' + dateStamp,
    folder
  );
  const document = DocumentApp.openById(output.getId());
  try {
    const body = document.getBody();
    scholarshipFillAcknowledgment_(body, record.participantRecords[0], record.parentName, record.acceptedAt);
    for (let i = 1; i < record.participantRecords.length; i++) {
      const temporary = template.makeCopy('TEMP Scholarship - ' + Utilities.getUuid(), folder);
      try {
        const temporaryDocument = DocumentApp.openById(temporary.getId());
        const temporaryBody = temporaryDocument.getBody();
        scholarshipFillAcknowledgment_(temporaryBody, record.participantRecords[i], record.parentName, record.acceptedAt);
        body.appendPageBreak();
        scholarshipAppendBody_(body, temporaryBody);
        temporaryDocument.saveAndClose();
      } finally {
        temporary.setTrashed(true);
      }
    }
    document.saveAndClose();
    const pdf = scholarshipCreatePdf_(
      output,
      record.parentName,
      record.registrationId,
      record.forceRegenerate === true
    );
    return {
      url: output.getUrl(),
      fileId: output.getId(),
      createdAt: new Date(),
      participantCount: record.participantRecords.length,
      pdfUrl: pdf.url,
      pdfFileId: pdf.fileId,
      pdfCreatedAt: pdf.createdAt
    };
  } catch (error) {
    try { output.setTrashed(true); } catch (ignored) {}
    throw error;
  }
}

function scholarshipCreatePdf_(documentFile, parentName, registrationId, forceRegenerate) {
  const folder = DriveApp.getFolderById(SCHOLARSHIP_CONFIG.APPLICATIONS_FOLDER_ID);
  const fileName = scholarshipPdfFileName_(parentName, registrationId);
  const existingFiles = folder.getFilesByName(fileName);
  if (!forceRegenerate && existingFiles.hasNext()) {
    const existing = existingFiles.next();
    return {url: existing.getUrl(), fileId: existing.getId(), createdAt: new Date(existing.getDateCreated())};
  }
  let file;
  try {
    file = folder.createFile(
      documentFile.getAs(MimeType.PDF).setName(fileName)
    );
    file.setDescription(
      'Paducah GO Soccer scholarship application for ' + parentName +
      '. Registration ID: ' + registrationId
    );
    return {url: file.getUrl(), fileId: file.getId(), createdAt: new Date()};
  } catch (error) {
    if (file) try { file.setTrashed(true); } catch (ignored) {}
    throw new Error('PDF generation failed: ' + scholarshipError_(error));
  }
}

function scholarshipFillAcknowledgment_(body, participant, parentName, acceptedAt) {
  const date = Utilities.formatDate(acceptedAt, SCHOLARSHIP_CONFIG.TIME_ZONE, 'MMMM d, yyyy');
  scholarshipWriteLine_(body, 'Player', participant.name || 'Not provided', 'Grade', participant.grade || 'Not provided', 32, 14);
  scholarshipWriteLine_(body, 'Parent/Guardian', parentName || 'Not provided', 'Date', date, 30, 18);
}

function scholarshipWriteLine_(body, firstLabel, firstValue, secondLabel, secondValue, firstWidth, secondWidth) {
  const match = body.findText(firstLabel.replace('/', '\\/') + ':\\s*_{2,}');
  if (!match) throw new Error('The ' + firstLabel + ' acknowledgment line was not found.');
  const text = match.getElement().asText();
  const first = scholarshipUnderlinedField_(firstValue, firstWidth);
  const second = scholarshipUnderlinedField_(secondValue, secondWidth);
  const firstPrefix = firstLabel + ': ';
  const secondPrefix = '     ' + secondLabel + ': ';
  const line = firstPrefix + first + secondPrefix + second;
  const attributes = text.getText().length ? text.getAttributes(0) : {};
  text.setText(line);
  text.setAttributes(0, line.length - 1, attributes);
  text.setUnderline(0, line.length - 1, false);
  text.setUnderline(firstPrefix.length, firstPrefix.length + first.length - 1, true);
  const secondStart = firstPrefix.length + first.length + secondPrefix.length;
  text.setUnderline(secondStart, secondStart + second.length - 1, true);

  if (firstLabel === 'Parent/Guardian') {
    const signatureName = scholarshipNormalize_(firstValue).replace(/[\r\n]+/g, ' ');
    if (signatureName) {
      const signatureStart = firstPrefix.length;
      const signatureEnd = signatureStart + signatureName.length - 1;
      if (signatureEnd >= signatureStart && signatureEnd < line.length) {
        text.setFontFamily(signatureStart, signatureEnd, 'Great Vibes');
        text.setFontSize(signatureStart, signatureEnd, 18);
        text.setBold(signatureStart, signatureEnd, false);
        text.setItalic(signatureStart, signatureEnd, false);
      }
    }
  }
}

function scholarshipUnderlinedField_(value, minimumWidth) {
  const text = scholarshipNormalize_(value).replace(/[\r\n]+/g, ' ');
  return text + '\u00a0'.repeat(Math.max(Number(minimumWidth) - text.length, 2));
}

function scholarshipAppendBody_(destination, source) {
  for (let i = 0; i < source.getNumChildren(); i++) {
    const child = source.getChild(i).copy();
    const type = child.getType();
    if (type === DocumentApp.ElementType.PARAGRAPH) destination.appendParagraph(child.asParagraph());
    else if (type === DocumentApp.ElementType.LIST_ITEM) destination.appendListItem(child.asListItem());
    else if (type === DocumentApp.ElementType.TABLE) destination.appendTable(child.asTable());
    else if (type === DocumentApp.ElementType.PAGE_BREAK) destination.appendPageBreak();
    else if (type === DocumentApp.ElementType.HORIZONTAL_RULE) destination.appendHorizontalRule();
  }
}

function scholarshipGetParticipants_(registrationId, participantNames) {
  const table = scholarshipReadTable_(scholarshipGetSheet_(SCHOLARSHIP_CONFIG.PLAYERS_SHEET));
  const map = scholarshipHeaderMap_(table.headers);
  const playerRow = table.rows.find(function(row) {
    return scholarshipValue_(row, map, 'registration_submission_id') === registrationId;
  });
  const registered = [];
  if (playerRow) {
    for (let i = 1; i <= 4; i++) {
      const first = scholarshipValue_(playerRow, map, 'player_' + i + '_first_name');
      const last = scholarshipValue_(playerRow, map, 'player_' + i + '_last_name');
      const name = [first, last].filter(Boolean).join(' ');
      if (name) registered.push({
        name: name,
        grade: scholarshipValue_(playerRow, map, 'player_' + i + '_grade')
      });
    }
  }
  const requested = scholarshipSplitNames_(participantNames);
  if (!requested.length) return registered;
  return requested.map(function(name) {
    const match = registered.find(function(player) {
      return scholarshipNameKey_(player.name) === scholarshipNameKey_(name);
    });
    return {name: name, grade: match ? match.grade : ''};
  });
}

function scholarshipSplitNames_(value) {
  return scholarshipNormalize_(value).replace(/\s+(?:and|&)\s+/gi, '\n')
    .split(/[\n;,]+/).map(scholarshipNormalize_).filter(Boolean);
}

function scholarshipNameKey_(value) {
  return scholarshipNormalize_(value).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function scholarshipGetAgreementFolder_() {
  const properties = PropertiesService.getScriptProperties();
  const key = 'SCHOLARSHIP_AGREEMENT_FOLDER_ID';
  const saved = properties.getProperty(key);
  if (saved) {
    try { return DriveApp.getFolderById(saved); }
    catch (error) { properties.deleteProperty(key); }
  }
  const folders = DriveApp.getFoldersByName(SCHOLARSHIP_CONFIG.AGREEMENT_FOLDER_NAME);
  const folder = folders.hasNext()
    ? folders.next()
    : DriveApp.createFolder(SCHOLARSHIP_CONFIG.AGREEMENT_FOLDER_NAME);
  properties.setProperty(key, folder.getId());
  return folder;
}

function scholarshipPdfFileName_(parentName, registrationId) {
  const safe = scholarshipNormalize_(parentName || 'Parent')
    .replace(/[\\/:*?"<>|#%{}~&]+/g, ' ')
    .replace(/[^A-Za-z0-9'-]+/g, '_').replace(/^_+|_+$/g, '');
  const safeRegistrationId = scholarshipSafeFilePart_(registrationId || 'No-Registration-Id');
  return (safe || 'Parent') + '_Scholarship_Application_' + safeRegistrationId + '.pdf';
}

function scholarshipResolveAcceptedAt_(submittedAtValue, row, map) {
  const acceptedAt = submittedAtValue
    || scholarshipValue_(row, map, 'scholarship_terms_accepted_at')
    || scholarshipValue_(row, map, 'submitted_at');
  return scholarshipDate_(acceptedAt, new Date());
}

function scholarshipSafeFilePart_(value) {
  return scholarshipNormalize_(value).replace(/[\\/:*?"<>|#%{}~&]/g, '-').substring(0, 80) || 'Record';
}

function scholarshipEnsureTrackingHeaders_(sheet) {
  const map = scholarshipHeaderMap_(scholarshipReadTable_(sheet).headers);
  const missing = SCHOLARSHIP_CONFIG.TRACKING_HEADERS.filter(function(header) {
    return typeof map[header] === 'undefined';
  });
  if (!missing.length) return;
  const start = Math.max(sheet.getLastColumn(), 0) + 1;
  sheet.getRange(1, start, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#d9ead3');
}

function scholarshipEnsureExcludeCheckboxes_(sheet) {
  const map = scholarshipHeaderMap_(scholarshipReadTable_(sheet).headers);
  if (typeof map.scholarship_terms_exclude === 'undefined') return;
  const rule = SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(true).build();
  sheet.getRange(2, map.scholarship_terms_exclude + 1, Math.max(sheet.getMaxRows() - 1, 1), 1)
    .setDataValidation(rule);
}

function scholarshipReadTable_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return {headers: [], rows: []};
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  return {headers: values[0].map(String), rows: values.slice(1)};
}

function scholarshipHeaderMap_(headers) {
  return headers.reduce(function(map, header, index) {
    const key = scholarshipNormalize_(header);
    if (key) map[key] = index;
    return map;
  }, {});
}

function scholarshipRequireHeaders_(map, required) {
  const missing = required.filter(function(header) {
    return typeof map[header] === 'undefined';
  });
  if (missing.length) throw new Error('Missing Scholarships header(s): ' + missing.join(', '));
}

function scholarshipFindRow_(rows, map, registrationId, email) {
  for (let i = 0; i < rows.length; i++) {
    if (scholarshipValue_(rows[i], map, 'registration_submission_id') === registrationId &&
        scholarshipValue_(rows[i], map, 'parent_email').toLowerCase() === email.toLowerCase()) {
      return i + 2;
    }
  }
  return -1;
}

function scholarshipSetRowFields_(sheet, rowNumber, map, values) {
  Object.keys(values).forEach(function(header) {
    if (typeof map[header] === 'undefined') throw new Error('Missing tracking header: ' + header);
    sheet.getRange(rowNumber, map[header] + 1).setValue(values[header]);
  });
}

function scholarshipValue_(row, map, header) {
  return typeof map[header] === 'undefined' ? '' : scholarshipNormalize_(row[map[header]]);
}

function scholarshipGetSheet_(name) {
  const sheet = SpreadsheetApp.openById(SCHOLARSHIP_CONFIG.SPREADSHEET_ID).getSheetByName(name);
  if (!sheet) throw new Error('Required sheet not found: ' + name);
  return sheet;
}

function scholarshipGetWebAppUrl_() {
  const url = scholarshipNormalize_(SCHOLARSHIP_CONFIG.WEB_APP_URL);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
    throw new Error('WEB_APP_URL must be the public deployment URL ending in /exec.');
  }
  return url;
}

function scholarshipDate_(value, fallback) {
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? fallback : date;
}

function scholarshipDisplayDate_(value) {
  if (!value) return '';
  return Utilities.formatDate(
    scholarshipDate_(value, new Date()),
    SCHOLARSHIP_CONFIG.TIME_ZONE,
    'M/d/yyyy h:mm a'
  );
}

function scholarshipChecked_(value) {
  if (value === true) return true;
  return ['true', 'yes', 'y', 'x', 'exclude', 'excluded', 'skip']
    .indexOf(scholarshipNormalize_(value).toLowerCase()) !== -1;
}

function scholarshipValidEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(scholarshipNormalize_(value));
}

function scholarshipNormalize_(value) {
  return String(value === null || typeof value === 'undefined' ? '' : value).trim();
}

function scholarshipEscapeHtml_(value) {
  return scholarshipNormalize_(value).replace(/[&<>"']/g, function(character) {
    return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character];
  });
}

function scholarshipJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function scholarshipError_(error) {
  return String(error && error.message ? error.message : error);
}