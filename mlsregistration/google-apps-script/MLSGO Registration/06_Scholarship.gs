/**
 * ============================================================
 * MLS GO REGISTRATION
 * 06_Scholarship.gs
 * ============================================================
 *
 * Handles:
 * - scholarship form upsert
 * - live scholarship document automation
 * - scholarship acceptance action routing
 * - scholarship archive metadata
 *
 * Network work occurs outside the global Script lock.
 */



/*
 * The Scholarships tab has an established A:Z contract:
 *   A:I  = registration scholarship source data
 *   J:Z  = scholarship terms / acceptance / archive tracking
 *
 * The registration project MUST NOT add registration-only helper fields
 * after column Z. The standalone scholarship app owns J:Z.
 */
const SCHOLARSHIP_SOURCE_HEADERS_A_I = Object.freeze([
  'submitted_at',
  'registration_submission_id',
  'page_url',
  'parent_first_name',
  'parent_last_name',
  'parent_email',
  'parent_phone',
  'scholarship_requested',
  'participant_names'
]);

function getScholarshipSheetHeadersAZ_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 26);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];

  const headerMap = buildHeaderIndexByName_(headers);
  SCHOLARSHIP_SOURCE_HEADERS_A_I.forEach(function(header) {
    if (!getHeaderColumnByName_(headerMap, header)) {
      throw new Error(
        'Scholarships sheet is missing required A:I header: ' + header
      );
    }
  });

  return headers;
}


/* ============================================================
 * SCHOLARSHIP SUBMISSION UPSERT
 * ============================================================
 */

function handleScholarshipSubmissionUpsert_(values) {
  const config = FORM_CONFIG.scholarship_application;

  let result;

  try {
    result = withScriptLock_(function() {
      const sheet = getSheet_(config.sheetName);
      const headers = getScholarshipSheetHeadersAZ_(sheet);

      const submissionId = normalizeValue_(
        lookupPayloadValue_(values, config.idColumn)
      );

      if (!submissionId) {
        throw new Error('Missing ' + config.idColumn);
      }

      const existingRow = findRowByHeaderValue_(
        sheet,
        headers,
        config.idColumn,
        submissionId
      );

      const existingRecord = existingRow > 0
        ? readSheetRowRecordByHeader_(sheet, headers, existingRow)
        : null;

      const writableHeaders = SCHOLARSHIP_SOURCE_HEADERS_A_I.slice();

      const record = buildRecordFromPayload_(
        headers,
        values,
        existingRecord,
        writableHeaders
      );
      setRecordValueByHeader_(record, config.idColumn, submissionId);

      let rowNumber;
      let created = false;

      if (existingRow > 0) {
        rowNumber = existingRow;
        writeRecordToRow_(sheet, headers, rowNumber, record);
      } else {
        created = true;
        rowNumber = findFirstAvailableScholarshipRow_(
          sheet,
          headers,
          config.idColumn
        );
        writeRecordToRow_(
          sheet,
          headers,
          rowNumber,
          record
        );
      }

      SpreadsheetApp.flush();

      /*
       * Read the row back before returning success. This guarantees that a
       * successful scholarship upsert means the Scholarships tab actually
       * contains the matching registration_submission_id.
       */
      const verifiedRecord = readSheetRowRecordByHeader_(
        sheet,
        headers,
        rowNumber
      );

      const verifiedSubmissionId = normalizeValue_(
        getRecordValueByHeader_(verifiedRecord, config.idColumn)
      );

      if (verifiedSubmissionId !== submissionId) {
        throw new Error(
          'Scholarship row verification failed after write. Expected ' +
          submissionId + ' but found ' + (verifiedSubmissionId || 'blank') + '.'
        );
      }

      /*
       * Once the scholarship application is safely written, reflect that state
       * on the matching Players row. Paid is authoritative and is never
       * downgraded by a scholarship submission.
       */
      setRegistrationPendingScholarshipLocked_(submissionId);

      return {
        ok: true,
        created: created,
        row: rowNumber,
        submissionId: submissionId,
        record: verifiedRecord,
        sheetVerified: true,
        sheetName: config.sheetName,
        spreadsheetId: sheet.getParent().getId(),
        handlerVersion: 'route-fix-v4',
        verifiedA1: config.sheetName + '!A' + rowNumber + ':Z' + rowNumber,
      };
    });
  } catch (error) {
    safeWriteError_(
      'scholarship_application',
      'Scholarship submission upsert failed',
      {
        registration_submission_id: normalizeValue_(
          lookupPayloadValue_(values, 'registration_submission_id')
        ),
        error: errorMessage_(error),
      }
    );

    return json_({
      ok: false,
      error: errorMessage_(error),
    });
  }

  /*
   * IMPORTANT: Do not generate/archive the scholarship document during the
   * initial form upsert. The row must exist first, and document generation is
   * handled once at final confirmation through accept_scholarship_application.
   * This keeps combined routes deterministic and prevents duplicate automation.
   */

  if (result.created) {
    try {
      sendInternalSubmissionNotification_(
        'scholarship_application',
        result.record
      );
    } catch (emailError) {
      safeWriteError_(
        'scholarship_application',
        'Internal scholarship notification failed',
        {
          registration_submission_id: result.submissionId,
          error: errorMessage_(emailError),
        }
      );
    }
  }

  return json_({
    ok: true,
    upserted: true,
    updatedExistingRow: !result.created,
    row: result.row,
    submissionId: result.submissionId,
    sheetVerified: result.sheetVerified,
    sheetName: result.sheetName,
    spreadsheetId: result.spreadsheetId,
    handlerVersion: result.handlerVersion,
    verifiedA1: result.verifiedA1,
    scholarshipAutomation: {
      ok: true,
      deferred: true,
      message: 'Scholarship document generation deferred to final confirmation.',
    },
  });
}


/* ============================================================
 * PLAYER PAYMENT STATUS FOR SCHOLARSHIP
 * ============================================================
 */

function setRegistrationPendingScholarshipLocked_(submissionId) {
  const normalizedId = normalizeValue_(submissionId);
  if (!normalizedId) {
    throw new Error('Missing registration_submission_id for scholarship payment status.');
  }

  const playersSheet = getSheet_(SHEET_NAMES.PLAYERS);
  const playerHeaders = ensureHeadersByName_(playersSheet, PLAYER_HEADERS);
  const playerRow = findRowByHeaderValue_(
    playersSheet,
    playerHeaders,
    'registration_submission_id',
    normalizedId
  );

  if (playerRow <= 0) {
    /*
     * The registration row may not exist yet in unusual submission ordering.
     * 03_Registration.gs independently initializes scholarship requests as
     * Pending Scholarship when that row is later created.
     */
    return {
      ok: true,
      updated: false,
      reason: 'Matching Players row does not exist yet.'
    };
  }

  const playerRecord = readSheetRowRecordByHeader_(
    playersSheet,
    playerHeaders,
    playerRow
  );

  const currentStatus = normalizeValue_(
    getRecordValueByHeader_(playerRecord, 'Player Payment Status')
  );

  if (normalizeComparisonValue_(currentStatus) === 'paid') {
    return {
      ok: true,
      updated: false,
      preservedStatus: 'Paid',
      row: playerRow
    };
  }

  setRecordValueByHeader_(
    playerRecord,
    'Player Payment Status',
    'Pending Scholarship'
  );

  writeRecordToRow_(
    playersSheet,
    playerHeaders,
    playerRow,
    playerRecord
  );

  return {
    ok: true,
    updated: true,
    paymentStatus: 'Pending Scholarship',
    row: playerRow
  };
}


function findFirstAvailableScholarshipRow_(sheet, headers, idHeader) {
  const headerIndex = buildHeaderIndexByName_(headers);
  const idColumn = getHeaderColumnByName_(headerIndex, idHeader);

  if (!idColumn) {
    throw new Error('Scholarship ID column was not found: ' + idHeader);
  }

  const maxRows = sheet.getMaxRows();
  if (maxRows < 2) {
    sheet.insertRowsAfter(Math.max(1, maxRows), 1);
    return 2;
  }

  const ids = sheet.getRange(2, idColumn, maxRows - 1, 1).getDisplayValues();
  for (let index = 0; index < ids.length; index += 1) {
    if (!normalizeValue_(ids[index][0])) {
      return index + 2;
    }
  }

  sheet.insertRowsAfter(maxRows, 1);
  return maxRows + 1;
}


/* ============================================================
 * LIVE SCHOLARSHIP DOCUMENT
 * ============================================================
 */

function finalizeScholarshipLiveApplication_(
  values,
  submissionId,
  actionOverride
) {
  const token = normalizeValue_(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        SCHOLARSHIP_LIVE_AUTOMATION.TOKEN_PROPERTY
      )
  );

  if (!token) {
    throw new Error(
      'Missing Script Property: ' +
      SCHOLARSHIP_LIVE_AUTOMATION.TOKEN_PROPERTY
    );
  }

  const action = normalizeValue_(
    actionOverride
  ) || SCHOLARSHIP_LIVE_AUTOMATION.ACTION;

  const parentEmail = normalizeValue_(
    lookupPayloadValue_(
      values,
      'parent_email'
    ) ||
    lookupPayloadValue_(
      values,
      'email'
    )
  ).toLowerCase();

  if (
    !parentEmail ||
    !isValidEmail_(parentEmail)
  ) {
    throw new Error(
      'A valid parent_email is required for scholarship automation.'
    );
  }

  const response = UrlFetchApp.fetch(
    SCHOLARSHIP_LIVE_AUTOMATION.WEB_APP_URL,
    {
      method: 'post',
      followRedirects: true,
      muteHttpExceptions: true,
      payload: {
        action:
          action,

        webhook_token:
          token,

        registration_submission_id:
          submissionId,

        parent_email:
          parentEmail,

        submitted_at:
          normalizeValue_(
            lookupPayloadValue_(
              values,
              'submitted_at'
            )
          ),
      },
    }
  );

  const responseCode =
    response.getResponseCode();

  const responseText =
    response.getContentText();

  let parsed;

  try {
    parsed = JSON.parse(
      responseText || '{}'
    );
  } catch (_error) {
    throw new Error(
      'Scholarship automation returned HTTP ' +
      responseCode +
      ' with a non-JSON response.'
    );
  }

  if (
    responseCode < 200 ||
    responseCode >= 300 ||
    !parsed ||
    parsed.ok !== true
  ) {
    throw new Error(
      parsed && parsed.error
        ? parsed.error
        : 'Scholarship automation returned HTTP ' +
          responseCode +
          '.'
    );
  }

  return parsed;
}


/* ============================================================
 * SCHOLARSHIP ACCEPTANCE ACTION
 * ============================================================
 *
 * This closes the action mismatch from the previous deployment.
 * The Worker may post action=accept_scholarship_application.
 */

function handleScholarshipAcceptance_(values) {
  const submissionId = normalizeValue_(
    values.registration_submission_id ||
    values.submission_id ||
    values.registrationSubmissionId ||
    values.submissionId
  );

  if (!submissionId) {
    return json_({
      ok: false,
      error:
        'Missing registration_submission_id',
    });
  }

  const sheet = getSheet_(
    SHEET_NAMES.SCHOLARSHIPS
  );

  const headers = getScholarshipSheetHeadersAZ_(sheet);

  const row = findRowByHeaderValue_(
    sheet,
    headers,
    'registration_submission_id',
    submissionId
  );

  if (row <= 0) {
    return json_({
      ok: false,
      error:
        'Matching scholarship row not found',
    });
  }

  const record =
    readSheetRowRecordByHeader_(
      sheet,
      headers,
      row
    );

  /*
   * If the live scholarship document is already archived, reuse it.
   * This keeps the action idempotent and avoids duplicate Drive files.
   */
  let documentUrl = normalizeValue_(
    getRecordValueByHeader_(
      record,
      'scholarship_terms_pdf_url'
    )
  );

  if (documentUrl) {
    return json_({
      ok: true,
      accepted: true,
      submissionId: submissionId,
      row: row,
      documentUrl: documentUrl,
      participantDocumentCount:
        countScholarshipParticipants_(record),
      reused: true,
    });
  }

  /*
   * No archived URL exists yet. Ask the standalone scholarship app
   * to generate/archive it, then save the returned permanent metadata.
   * This network request intentionally occurs without holding the
   * global Script lock.
   */
  let automationResult;

  try {
    automationResult =
      finalizeScholarshipLiveApplication_(
        record,
        submissionId,
        'archive_live_scholarship_application'
      );
  } catch (error) {
    safeWriteError_(
      'scholarship_application',
      'Scholarship acceptance archive failed',
      {
        registration_submission_id:
          submissionId,
        error:
          errorMessage_(error),
      }
    );

    return json_({
      ok: false,
      error:
        errorMessage_(error),
    });
  }

  /*
   * Prefer the permanent Drive URL returned directly by the automation
   * response. Fall back to rereading the sheet (with a short retry, since
   * the standalone scholarship app's write to J:Z may lag slightly behind
   * this response) in case the URL is only supported via the sheet column.
   */
  documentUrl = normalizeValue_(
    automationResult.documentUrl ||
    automationResult.pdfUrl ||
    automationResult.url ||
    automationResult.driveUrl ||
    automationResult.scholarship_terms_pdf_url
  );

  let refreshedRecord = record;

  if (!documentUrl) {
    for (let attempt = 0; attempt < 3 && !documentUrl; attempt += 1) {
      if (attempt > 0) Utilities.sleep(1000);

      const refreshedHeaders = getScholarshipSheetHeadersAZ_(sheet);
      refreshedRecord = readSheetRowRecordByHeader_(sheet, refreshedHeaders, row);
      documentUrl = normalizeValue_(
        getRecordValueByHeader_(refreshedRecord, 'scholarship_terms_pdf_url')
      );
    }
  }

  if (!documentUrl) {
    return json_({
      ok: false,
      error:
        'Scholarship document was generated but no permanent Drive URL was recorded.',
    });
  }

  return json_({
    ok: true,
    accepted: true,
    submissionId: submissionId,
    row: row,
    documentUrl: documentUrl,
    participantDocumentCount:
      countScholarshipParticipants_(
        refreshedRecord
      ),
    reused: false,
  });
}


function countScholarshipParticipants_(record) {
  const participantNames =
    normalizeValue_(
      getRecordValueByHeader_(
        record,
        'participant_names'
      )
    );

  if (!participantNames) {
    return 0;
  }

  return participantNames
    .split(',')
    .map(function(name) {
      return normalizeValue_(name);
    })
    .filter(Boolean)
    .length;
}


/* ============================================================
 * SCHOLARSHIP DOCUMENT METADATA
 * ============================================================
 */

function updateScholarshipDocumentMetadata_(
  submissionId,
  automationResult
) {
  /*
   * Compatibility shim only.
   * The standalone scholarship web app owns and writes J:Z directly.
   * Keeping this function avoids breaking older callers, but it MUST NOT
   * create duplicate archive columns after Z.
   */
  if (!automationResult || automationResult.ok !== true) {
    throw new Error(
      automationResult && automationResult.error
        ? normalizeValue_(automationResult.error)
        : 'Scholarship archive automation did not complete.'
    );
  }

  const sheet = getSheet_(SHEET_NAMES.SCHOLARSHIPS);
  const headers = getScholarshipSheetHeadersAZ_(sheet);
  const row = findRowByHeaderValue_(
    sheet,
    headers,
    'registration_submission_id',
    submissionId
  );

  if (row <= 0) {
    throw new Error(
      'Matching scholarship row not found after standalone archive.'
    );
  }

  const record = readSheetRowRecordByHeader_(sheet, headers, row);
  const pdfUrl = normalizeValue_(
    getRecordValueByHeader_(record, 'scholarship_terms_pdf_url')
  );

  if (!pdfUrl) {
    throw new Error(
      'Standalone scholarship archive completed but scholarship_terms_pdf_url was not written.'
    );
  }

  return {
    ok: true,
    row: row,
    pdfUrl: pdfUrl,
    pdfFileId: normalizeValue_(
      getRecordValueByHeader_(record, 'scholarship_terms_pdf_file_id')
    )
  };
}


/* ============================================================
 * TEST / RETRY ONE SCHOLARSHIP ROW
 * ============================================================
 */

function retryScholarshipRow_(rowNumber) {
  const sheet = getSheet_(
    SHEET_NAMES.SCHOLARSHIPS
  );

  const headers = getScholarshipSheetHeadersAZ_(sheet);

  if (
    !rowNumber ||
    rowNumber < 2 ||
    rowNumber > sheet.getLastRow()
  ) {
    throw new Error(
      'Invalid Scholarships sheet row number.'
    );
  }

  const record =
    readSheetRowRecordByHeader_(
      sheet,
      headers,
      rowNumber
    );

  const submissionId =
    normalizeValue_(
      getRecordValueByHeader_(
        record,
        'registration_submission_id'
      )
    );

  if (!submissionId) {
    throw new Error(
      'Selected scholarship row has no registration_submission_id.'
    );
  }

  const result =
    finalizeScholarshipLiveApplication_(
      record,
      submissionId,
      'archive_live_scholarship_application'
    );

  updateScholarshipDocumentMetadata_(
    submissionId,
    result
  );

  return result;
}
