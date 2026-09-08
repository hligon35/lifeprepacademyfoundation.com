function createClaimToken_(caseRecord, recipientEmail, testMode) {
  return signToken_({
    typ: 'claim',
    caseId: normalize_(caseRecord.case_id),
    caseVersion: Number(caseRecord.case_version) || 1,
    clusterKey: normalize_(caseRecord.cluster_key),
    recipientEmail: normalizeEmail_(recipientEmail),
    test: Boolean(testMode),
  }, CONTINUE_CONFIG.TOKEN_DAYS * 86400000);
}

function createContactToken_(caseRecord, claim, originalClaimToken) {
  const claimPayload = verifyToken_(originalClaimToken, 'claim');
  return signToken_({
    typ: 'contact',
    caseId: normalize_(caseRecord.case_id),
    caseVersion: Number(caseRecord.case_version) || 1,
    recipientEmail: normalizeEmail_(claimPayload.recipientEmail),
    claimedChildKeys: claim.claimed || [],
    releasedChildKeys: claim.released || [],
    duplicateChildKeys: claim.duplicate || [],
    uncertainChildKeys: claim.uncertain || [],
    test: Boolean(claimPayload.test),
  }, CONTINUE_CONFIG.CONTACT_TOKEN_MINUTES * 60000);
}

function createResumeToken_(caseRecord, claim, primaryContact, testMode) {
  return signToken_({
    typ: 'resume',
    caseId: normalize_(caseRecord.case_id),
    caseVersion: Number(caseRecord.case_version) || 1,
    canonicalRegistrationId: normalize_(caseRecord.recommended_canonical_registration_id),
    claimedChildKeys: claim.claimed || [],
    releasedChildKeys: claim.released || [],
    duplicateChildKeys: claim.duplicate || [],
    uncertainChildKeys: claim.uncertain || [],
    primaryEmail: normalizeEmail_(primaryContact && primaryContact.email),
    primaryName: normalize_(primaryContact && primaryContact.name),
    tokenId: Utilities.getUuid(),
    test: Boolean(testMode),
  }, CONTINUE_CONFIG.RESUME_TOKEN_MINUTES * 60000);
}

function createAgreementToken_(caseRecord, playerRecord) {
  return signToken_({
    typ: 'agreement',
    caseId: normalize_(caseRecord.case_id),
    caseVersion: Number(caseRecord.case_version) || 1,
    canonicalRegistrationId: normalize_(playerRecord.registration_submission_id),
    claimedChildKeys: getPlayerChildren_(playerRecord).map(function(child) { return child.nameKey; }),
    releasedChildKeys: [],
    duplicateChildKeys: [],
    uncertainChildKeys: [],
    primaryEmail: normalizeEmail_(playerRecord.parent_email),
    primaryName: normalize_(playerRecord.parent_first_name + ' ' + playerRecord.parent_last_name),
    tokenId: Utilities.getUuid(),
    agreementOnly: true,
    test: false,
  }, CONTINUE_CONFIG.TOKEN_DAYS * 86400000);
}

function signToken_(claims, ttlMs) {
  const now = Date.now();
  const payload = Object.assign({}, claims, {
    iat: now,
    exp: now + ttlMs,
    nonce: Utilities.getUuid(),
  });

  const encoded = Utilities.base64EncodeWebSafe(JSON.stringify(payload))
    .replace(/=+$/g, '');
  return encoded + '.' + tokenSignature_(encoded);
}

function verifyToken_(token, expectedType) {
  const parts = normalize_(token).split('.');
  if (parts.length !== 2) throw new Error('The secure link is invalid.');
  if (!constantTimeEqual_(parts[1], tokenSignature_(parts[0]))) {
    throw new Error('The secure link could not be verified.');
  }

  let payload;
  try {
    payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()
    );
  } catch (_error) {
    throw new Error('The secure link is unreadable.');
  }

  if (Number(payload.exp) < Date.now()) throw new Error('This secure link has expired.');
  if (expectedType && payload.typ !== expectedType) {
    throw new Error('This secure link is not valid for this step.');
  }
  return payload;
}

function tokenSignature_(encoded) {
  const secret = PropertiesService.getScriptProperties()
    .getProperty(CONTINUE_PROPERTY_KEYS.TOKEN_SECRET);
  if (!secret) throw new Error('Run CONTINUE_setup() first.');

  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(encoded, secret)
  ).replace(/=+$/g, '');
}

function constantTimeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
