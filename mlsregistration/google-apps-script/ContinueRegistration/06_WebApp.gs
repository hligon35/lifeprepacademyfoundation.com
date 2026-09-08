function doGet(e) {
  try {
    assertSetup_();
    const params = e && e.parameter ? e.parameter : {};
    const action = normalize_(params.action).toLowerCase();

    if (action === 'claim_submit') return handleClaimSelectionGet_(params);
    if (action === 'contact_submit') return handleContactSelectionGet_(params);
    if (action === 'completed_response') return handleCompletedResponseGet_(params);

    const token = normalize_(params.t);
    const payload = verifyToken_(token, 'claim');
    const caseRecord = findCaseById_(payload.caseId);
    if (!caseRecord) throw new Error('The continuation case could not be found.');

    if (caseIsCompleted_(caseRecord)) {
      return htmlOutput_(buildAlreadyCompletedPage_(caseRecord, token, Boolean(payload.test)), 'Paducah GO Soccer Registration Status');
    }

    if (!payload.test) {
      updateCase_(caseRecord._row, { status: 'Link Opened', link_opened_at: timestamp_() });
      markClusterRows_(caseRecord, {
        'Continuation Status': 'Link Opened',
        'Continuation Opened At': timestamp_(),
      });
    }

    audit_(caseRecord.case_id, 'claim_page_opened', null, {
      recipientEmail: normalizeEmail_(payload.recipientEmail),
      tokenNonce: payload.nonce,
    }, Boolean(payload.test));

    return htmlOutput_(buildClaimPage_(caseRecord, token, Boolean(payload.test)), 'Paducah GO Soccer Registration Confirmation');
  } catch (error) {
    return htmlOutput_(buildErrorPage_(errorMessage_(error)), 'Registration Continuation');
  }
}

function doPost(e) {
  try {
    if (!isJsonPost_(e)) {
      return htmlOutput_(
        buildMessagePage_('Please reopen your secure link', 'This page no longer accepts browser form POST requests. Please reopen the secure link from your email.'),
        'Registration Continuation'
      );
    }
    return handleApiPost_(e);
  } catch (error) {
    return jsonOutput_({ ok: false, error: errorMessage_(error) });
  }
}

function handleClaimSelectionGet_(params) {
  const claimToken = normalize_(params.token);
  const tokenPayload = verifyToken_(claimToken, 'claim');
  const caseRecord = findCaseById_(tokenPayload.caseId);
  if (!caseRecord) throw new Error('The continuation case could not be found.');
  if (caseIsCompleted_(caseRecord)) {
    return htmlOutput_(buildAlreadyCompletedPage_(caseRecord, claimToken, Boolean(tokenPayload.test)), 'Registration Status');
  }

  const childKeys = splitPipe_(caseRecord.candidate_child_keys);
  const result = { claimed: [], released: [], duplicate: [], uncertain: [] };

  childKeys.forEach(function(key, index) {
    const answer = normalize_(params['child_' + index]).toLowerCase();
    if (answer === 'mine') result.claimed.push(key);
    else if (answer === 'not_mine') result.released.push(key);
    else if (answer === 'duplicate') {
      result.claimed.push(key);
      result.duplicate.push(key);
    } else if (answer === 'unsure') result.uncertain.push(key);
    else throw new Error('Please choose an answer for each participant.');
  });

  if (!result.claimed.length) {
    if (!tokenPayload.test) {
      updateCase_(caseRecord._row, {
        status: 'Manual Review Required',
        claim_completed_at: timestamp_(),
        claimed_child_keys: '',
        released_child_keys: result.released.join(' | '),
        duplicate_child_keys: result.duplicate.join(' | '),
        uncertain_child_keys: result.uncertain.join(' | '),
        notes: appendNote_(caseRecord.notes, 'No participant was claimed by the email recipient.'),
      });
      markClusterRows_(caseRecord, {
        'Continuation Status': 'Manual Review Required',
        'Continuation Claimed At': timestamp_(),
        'Duplicate Resolution Status': 'Unresolved',
        'Continuation Review Note': 'Recipient did not claim any participant names.',
      });
    }

    audit_(caseRecord.case_id, 'no_children_claimed', null, result, Boolean(tokenPayload.test));
    return htmlOutput_(buildMessagePage_(
      'Thank you',
      'We did not change the registration. Our team will review the unmatched registration attempts.'
    ), 'Registration Continuation');
  }

  const contacts = buildContactCandidatesForCase_(caseRecord);
  if (contacts.length > 1) {
    const contactToken = createContactToken_(caseRecord, result, claimToken);
    return htmlOutput_(buildContactPage_(caseRecord, contactToken, contacts, Boolean(tokenPayload.test)), 'Confirm Registration Contact');
  }

  const primaryContact = contacts[0] || {
    email: normalizeEmail_(tokenPayload.recipientEmail),
    name: '',
  };
  return finalizeClaimAndBuildResumePage_(caseRecord, result, primaryContact, Boolean(tokenPayload.test));
}

function handleContactSelectionGet_(params) {
  const tokenPayload = verifyToken_(params.token, 'contact');
  const caseRecord = findCaseById_(tokenPayload.caseId);
  if (!caseRecord) throw new Error('The continuation case could not be found.');
  if (caseIsCompleted_(caseRecord)) {
    return htmlOutput_(buildAlreadyCompletedPage_(caseRecord, '', Boolean(tokenPayload.test)), 'Registration Status');
  }

  const contactKey = normalize_(params.contact);
  const contacts = buildContactCandidatesForCase_(caseRecord);
  const selected = contacts.find(function(contact) {
    return contactSelectionKey_(contact.email) === contactKey;
  });
  if (!selected) throw new Error('Please choose the contact information to use going forward.');

  const claim = {
    claimed: tokenPayload.claimedChildKeys || [],
    released: tokenPayload.releasedChildKeys || [],
    duplicate: tokenPayload.duplicateChildKeys || [],
    uncertain: tokenPayload.uncertainChildKeys || [],
  };
  return finalizeClaimAndBuildResumePage_(caseRecord, claim, selected, Boolean(tokenPayload.test));
}

function finalizeClaimAndBuildResumePage_(caseRecord, claim, primaryContact, testMode) {
  const resumeToken = createResumeToken_(caseRecord, claim, primaryContact, testMode);
  const resumePayload = verifyToken_(resumeToken, 'resume');

  if (!testMode) {
    const partial = claim.released.length || claim.uncertain.length;
    const duplicate = claim.duplicate.length > 0;
    let status = 'Family Confirmed';
    if (partial) status = 'Family Partially Confirmed';
    else if (duplicate) status = 'Family Confirmed - Duplicate Identified';

    updateCase_(caseRecord._row, {
      status: status,
      claim_completed_at: timestamp_(),
      claimed_child_keys: claim.claimed.join(' | '),
      released_child_keys: claim.released.join(' | '),
      duplicate_child_keys: claim.duplicate.join(' | '),
      uncertain_child_keys: claim.uncertain.join(' | '),
      selected_primary_email: normalizeEmail_(primaryContact.email),
      selected_primary_name: normalize_(primaryContact.name),
      resume_token_id: resumePayload.tokenId,
    });

    markClusterRows_(caseRecord, {
      'Continuation Status': status,
      'Continuation Claimed At': timestamp_(),
      'Duplicate Resolution Status': duplicate ? 'Parent Identified Duplicate' : 'Pending Completion',
    });
  }

  audit_(caseRecord.case_id, 'children_and_contact_confirmed', null, {
    claim: claim,
    primaryEmail: normalizeEmail_(primaryContact.email),
    primaryName: normalize_(primaryContact.name),
  }, testMode);

  const resumeUrl = CONTINUE_CONFIG.REGISTRATION_URL +
    '?resume=' + encodeURIComponent(resumeToken) +
    (testMode ? '&resumeTest=1' : '');

  return htmlOutput_(buildRedirectPage_(resumeUrl, testMode), 'Continue Registration');
}

function handleCompletedResponseGet_(params) {
  const tokenPayload = verifyToken_(params.token, 'claim');
  const caseRecord = findCaseById_(tokenPayload.caseId);
  if (!caseRecord) throw new Error('The continuation case could not be found.');
  const action = normalize_(params.completed_action).toLowerCase();

  if (action === 'acknowledge') {
    audit_(caseRecord.case_id, 'post_completion_acknowledged', null, {}, Boolean(tokenPayload.test));
    return htmlOutput_(buildMessagePage_('You are all set', 'No further action is needed for this registration.'), 'Registration Status');
  }

  if (action === 'review') {
    if (!tokenPayload.test) {
      updateCase_(caseRecord._row, {
        status: 'Completed - Review Requested',
        notes: appendNote_(caseRecord.notes, 'A household recipient requested review after the registration was completed.'),
      });
    }
    audit_(caseRecord.case_id, 'post_completion_review_requested', null, {}, Boolean(tokenPayload.test));
    return htmlOutput_(buildMessagePage_('Review requested', 'We will review the registration. No changes were made to the completed registration.'), 'Registration Status');
  }

  throw new Error('Please choose an option.');
}

function handleApiPost_(e) {
  let request;
  try {
    request = JSON.parse(e.postData.contents || '{}');
  } catch (_error) {
    return jsonOutput_({ ok: false, error: 'Invalid JSON.' });
  }

  const expected = PropertiesService.getScriptProperties().getProperty(CONTINUE_PROPERTY_KEYS.WORKER_SHARED_SECRET);
  if (!expected || !constantTimeEqual_(normalize_(request.sharedSecret), expected)) {
    return jsonOutput_({ ok: false, error: 'Unauthorized.' });
  }

  const action = normalize_(request.action);
  if (action === 'create_agreement_resume_link') return apiCreateAgreementResumeLink_(request);
  if (action === 'resume_context') return apiResumeContext_(request);
  if (action === 'resume_complete') return apiResumeComplete_(request);
  if (action === 'resume_withdraw_verify') return apiResumeWithdrawVerify_(request);
  if (action === 'resume_withdraw_confirm') return apiResumeWithdrawConfirm_(request);
  return jsonOutput_({ ok: false, error: 'Unknown action.' });
}

function apiCreateAgreementResumeLink_(request) {
  const registrationId = normalize_(request.registrationId);
  const player = findPlayerByRegistrationId_(registrationId);
  if (!player) return jsonOutput_({ ok: false, error: 'The Players row could not be found.' });

  const requestedEmail = normalizeEmail_(request.email);
  const playerEmail = normalizeEmail_(player.parent_email);
  if (!requestedEmail || requestedEmail !== playerEmail) {
    return jsonOutput_({ ok: false, error: 'The email does not match the Players row.' });
  }

  const children = getPlayerChildren_(player);
  if (!children.length) return jsonOutput_({ ok: false, error: 'No participants were found on the Players row.' });

  try {
    const caseRecord = findOrCreateCaseForPlayerRow_(player._row);
    const token = createAgreementToken_(caseRecord, player);
    return jsonOutput_({
      ok: true,
      row: player._row,
      agreementUrl: CONTINUE_CONFIG.REGISTRATION_URL + '?resume=' + encodeURIComponent(token) + '&section=agreements',
      parentName: normalize_(player.parent_first_name + ' ' + player.parent_last_name),
      participantNames: children.map(function(child) { return child.displayName; }).join(', '),
    });
  } catch (error) {
    return jsonOutput_({ ok: false, error: errorMessage_(error) });
  }
}

function apiResumeContext_(request) {
  const token = verifyToken_(request.resumeToken);
  if (token.typ !== 'resume' && token.typ !== 'agreement') {
    return jsonOutput_({ ok: false, error: 'This secure link is not valid for registration restoration.' });
  }
  const caseRecord = findCaseById_(token.caseId);
  if (!caseRecord) return jsonOutput_({ ok: false, error: 'Continuation case not found.' });

  if (Number(token.caseVersion) !== (Number(caseRecord.case_version) || 1)) {
    return jsonOutput_({ ok: false, code: 'CASE_CHANGED', error: 'This continuation link is no longer current. Please reopen the email link.' });
  }

  if (normalize_(caseRecord.status).toLowerCase() === 'withdrawn') {
    return jsonOutput_({ ok: false, code: 'ALREADY_WITHDRAWN', error: 'This registration has been withdrawn. No further action is required.' });
  }

  if (token.typ === 'resume' && caseIsCompleted_(caseRecord) && normalize_(caseRecord.completion_owner_token_id) !== normalize_(token.tokenId)) {
    return jsonOutput_(alreadyCompletedResponse_());
  }

  try {
    const context = buildMergedRegistrationSnapshot_(caseRecord, token);
    context.resume.agreementOnly = token.typ === 'agreement';
    return jsonOutput_({ ok: true, context: context });
  } catch (error) {
    return jsonOutput_({ ok: false, error: errorMessage_(error) });
  }
}

function apiResumeComplete_(request) {
  const token = verifyToken_(request.resumeToken, 'resume');
  if (token.test) return jsonOutput_({ ok: true, testMode: true, message: 'Test mode does not modify live records.' });

  const caseRecord = findCaseById_(token.caseId);
  if (!caseRecord) return jsonOutput_({ ok: false, error: 'Continuation case not found.' });

  if (normalize_(request.registrationSubmissionId) !== normalize_(token.canonicalRegistrationId)) {
    return jsonOutput_({
      ok: false,
      code: 'CONTINUATION_REGISTRATION_MISMATCH',
      error: 'Completion registration ID does not match the continuation case.',
    });
  }

  return jsonOutput_(finalizeContinuationCase_(caseRecord, token));
}

function apiResumeWithdrawVerify_(request) {
  const token = verifyToken_(request.resumeToken, 'resume');
  const caseRecord = findCaseById_(token.caseId);
  if (!caseRecord) return jsonOutput_({ ok: false, error: 'Continuation case not found.' });

  if (Number(token.caseVersion) !== (Number(caseRecord.case_version) || 1)) {
    return jsonOutput_({ ok: false, code: 'CASE_CHANGED', error: 'This continuation case changed. Please reopen the secure email link.' });
  }

  if (normalize_(caseRecord.status).toLowerCase() === 'withdrawn') {
    return jsonOutput_({ ok: false, code: 'ALREADY_WITHDRAWN', error: 'This registration has already been withdrawn.' });
  }

  if (caseHasVerifiedPayment_(caseRecord)) {
    return jsonOutput_({
      ok: false,
      code: 'PAYMENT_RECORDED',
      error: 'Payment has already been recorded for this registration. Please contact Paducah GO Soccer for assistance.',
    });
  }

  return jsonOutput_(verifyWithdrawalDob_(caseRecord, token, request));
}

function apiResumeWithdrawConfirm_(request) {
  const token = verifyToken_(request.resumeToken, 'resume');
  const caseRecord = findCaseById_(token.caseId);
  if (!caseRecord) return jsonOutput_({ ok: false, error: 'Continuation case not found.' });

  if (!normalize_(request.verificationToken)) {
    return jsonOutput_({ ok: false, error: 'Withdrawal verification is required.' });
  }

  return jsonOutput_(withdrawContinuationCase_(caseRecord, token, request.verificationToken));
}

function alreadyCompletedResponse_() {
  return {
    ok: false,
    code: 'ALREADY_COMPLETED_BY_FAMILY',
    error: 'This participant may already have been registered by someone else in your family. No further registration changes were made.',
  };
}

function buildClaimPage_(caseRecord, token, testMode) {
  const names = splitPipe_(caseRecord.candidate_child_names);
  const rows = names.map(function(name, index) {
    return '<div class="child-card"><h3>' + escapeHtml_(name) + '</h3>' +
      '<label><input type="radio" name="child_' + index + '" value="mine" required> This is my child</label>' +
      '<label><input type="radio" name="child_' + index + '" value="not_mine" required> This is not my child</label>' +
      '<label><input type="radio" name="child_' + index + '" value="duplicate" required> This child was registered more than once</label>' +
      '<label><input type="radio" name="child_' + index + '" value="unsure" required> I am not sure</label></div>';
  }).join('');

  return pageShell_(
    (testMode ? testBanner_() : '') +
    bannerHtml_() +
    '<section><h1>Confirm your family</h1>' +
    '<p>Before we load any registration details, tell us which participant names belong to your household.</p>' +
    '<form method="get" action="' + escapeHtml_(getWebAppUrl_()) + '" target="_top">' +
    '<input type="hidden" name="action" value="claim_submit">' +
    '<input type="hidden" name="token" value="' + escapeHtml_(token) + '">' +
    rows +
    '<button type="submit">Continue</button></form></section>'
  );
}

function buildContactPage_(caseRecord, token, contacts, testMode) {
  const choices = contacts.map(function(contact) {
    const label = (contact.name ? escapeHtml_(contact.name) + ' — ' : '') + escapeHtml_(maskEmail_(contact.email));
    return '<label class="action-choice"><input type="radio" name="contact" value="' +
      escapeHtml_(contactSelectionKey_(contact.email)) + '" required> ' + label + '</label>';
  }).join('');

  return pageShell_(
    (testMode ? testBanner_() : '') +
    bannerHtml_() +
    '<section><h1>Choose the registration contact</h1>' +
    '<p>More than one parent or guardian contact was used in the registration attempts. Choose the contact information we should load into the registration form going forward.</p>' +
    '<form method="get" action="' + escapeHtml_(getWebAppUrl_()) + '" target="_top">' +
    '<input type="hidden" name="action" value="contact_submit">' +
    '<input type="hidden" name="token" value="' + escapeHtml_(token) + '">' +
    choices +
    '<button type="submit">Continue</button></form></section>'
  );
}

function buildAlreadyCompletedPage_(caseRecord, token, testMode) {
  const names = splitPipe_(caseRecord.candidate_child_names).join(', ');
  const form = token
    ? '<form method="get" action="' + escapeHtml_(getWebAppUrl_()) + '" target="_top">' +
      '<input type="hidden" name="action" value="completed_response">' +
      '<input type="hidden" name="token" value="' + escapeHtml_(token) + '">' +
      '<label class="action-choice"><input type="radio" name="completed_action" value="acknowledge" required> Everything looks correct</label>' +
      '<label class="action-choice"><input type="radio" name="completed_action" value="review" required> Request a review</label>' +
      '<button type="submit">Continue</button></form>'
    : '<p>No additional registration changes are available from this link.</p>';

  return pageShell_(
    (testMode ? testBanner_() : '') + bannerHtml_() +
    '<section><h1>This registration may already be complete</h1>' +
    '<p><strong>' + escapeHtml_(names) + '</strong> may have already been completed by someone else in your household.</p>' +
    '<p>For privacy, we do not show who completed it or their contact information.</p>' + form + '</section>'
  );
}

function buildRedirectPage_(url, testMode) {
  return pageShell_(
    (testMode ? testBanner_() : '') + bannerHtml_() +
    '<section><h1>' + (testMode ? 'Your test continuation is ready' : 'Your registration is ready to continue') + '</h1>' +
    '<p>We prepared the saved registration using the information you just confirmed.</p>' +
    '<p>Click the button below to open the normal Paducah GO Soccer registration form and review everything before finishing.</p>' +
    '<a class="continue-button" target="_top" rel="noopener" href="' + escapeHtml_(url) + '">Continue Registration</a>' +
    '</section>'
  );
}

function buildErrorPage_(message) { return buildMessagePage_('We could not continue', message); }
function buildMessagePage_(title, message) {
  return pageShell_(bannerHtml_() + '<section><h1>' + escapeHtml_(title) + '</h1><p>' + escapeHtml_(message) + '</p></section>');
}

function pageShell_(body) {
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<base target="_top"><style>' + claimPageCss_() + '</style></head><body><main>' + body + '</main></body></html>';
}

function bannerHtml_() { return '<img class="banner" src="' + escapeHtml_(CONTINUE_CONFIG.BANNER_URL) + '" alt="Paducah GO Soccer">'; }
function testBanner_() { return '<div class="test-banner">TEST MODE — no live registration records will be changed.</div>'; }
function htmlOutput_(html, title) {
  return HtmlService.createHtmlOutput(html)
    .setTitle(title || 'Paducah GO Soccer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function contactSelectionKey_(email) { return sha256Hex_(normalizeEmail_(email)).slice(0, 20); }
function maskEmail_(email) {
  const parts = splitEmail_(email);
  if (!parts) return email;
  const shown = parts.local.slice(0, Math.min(3, parts.local.length));
  return shown + '***@' + parts.domain;
}
function claimPageCss_() {
  return 'body{margin:0;background:#eef3f1;font-family:Arial,sans-serif;color:#17233a}' +
    'main{max-width:720px;margin:30px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px #0002}' +
    '.banner{width:100%;display:block}section{padding:28px}h1,h3{color:#214b86}' +
    '.child-card{border:1px solid #d7e1e7;border-radius:10px;padding:16px;margin:14px 0}' +
    '.child-card label,.action-choice{display:block;margin:12px 0;line-height:1.35}' +
    '.child-card input,.action-choice input{margin-right:8px}' +
    'button,.continue-button{display:inline-block;background:#0b6844;color:#fff;border:0;text-decoration:none;border-radius:7px;padding:14px 22px;font-size:16px;font-weight:700;cursor:pointer;margin-top:16px}' +
    '.test-banner{background:#fff3cd;color:#664d03;padding:12px 16px;font-weight:700;text-align:center}' +
    '@media(max-width:650px){main{margin:0;border-radius:0}section{padding:22px}}';
}
