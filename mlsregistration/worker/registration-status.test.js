const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  PADUCAH_GO_PROGRAM_ID,
  getRegistrationSettings,
  isPrivateAccessTokenValid,
  verifyResumeTokenActive,
  evaluateRegistrationAccess,
  registrationClosedPayload,
  getRegistrationOverview,
  updateRegistrationSettings,
  isAuthorizedForSettingsChange,
} = require('./registration-status.js');

// --- Minimal D1-API-compatible adapter over node:sqlite, loaded with the REAL migration SQL ---
// so tests run against the actual schema instead of hand-rolled mocks.

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }
  return db;
}

function wrapAsD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let boundArgs = [];
      return {
        bind(...args) {
          boundArgs = args;
          return this;
        },
        first() {
          return stmt.get(...boundArgs) || null;
        },
        all() {
          return { results: stmt.all(...boundArgs) };
        },
        run() {
          stmt.run(...boundArgs);
          return { success: true };
        },
      };
    },
  };
}

function makeEnv(db, overrides = {}) {
  return {
    DB: wrapAsD1(db),
    ADMIN_SETTINGS_TOKEN: 'test-admin-token',
    CONTINUATION_WEB_APP_URL:
      'https://script.google.com/macros/s/fake-deployment-id/exec',
    CONTINUATION_WORKER_SHARED_SECRET: 'test-shared-secret',
    ...overrides,
  };
}

test('getRegistrationSettings returns the seeded closed default', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);

  assert.equal(settings.registrationStatus, 'closed');
  assert.equal(settings.allowDraftResume, false);
  assert.match(settings.closedMessage, /closed until next season/i);
});

test('open registration allows access with no token needed', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  await updateRegistrationSettings(
    env,
    PADUCAH_GO_PROGRAM_ID,
    { registrationStatus: 'open' },
    'test-admin',
  );
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);
  const access = await evaluateRegistrationAccess(env, { settings });

  assert.equal(access.allowed, true);
  assert.equal(access.via, 'open');
});

test('closed registration blocks a new draft with no bypass', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);
  const access = await evaluateRegistrationAccess(env, { settings });

  assert.equal(access.allowed, false);
  assert.equal(access.via, 'blocked');
});

test('closed registration blocks a direct API submission attempt with a fabricated resume token', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  await updateRegistrationSettings(
    env,
    PADUCAH_GO_PROGRAM_ID,
    { registrationStatus: 'closed', allowDraftResume: true },
    'test-admin',
  );
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);

  // fetchImpl simulates the continuation service rejecting a token it doesn't recognize.
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: false, error: 'Unknown resume token' }));
  const access = await evaluateRegistrationAccess(env, {
    settings,
    resumeToken: 'fabricated-token-not-issued-by-apps-script',
    requireResumeReverification: true,
    fetchImpl,
  });

  assert.equal(access.allowed, false);
});

test('closed registration allows an existing draft to resume with a valid, re-verified resume token', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  await updateRegistrationSettings(
    env,
    PADUCAH_GO_PROGRAM_ID,
    { registrationStatus: 'closed', allowDraftResume: true },
    'test-admin',
  );
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);

  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: true, context: { submissionId: 'abc123' } }));
  const access = await evaluateRegistrationAccess(env, {
    settings,
    resumeToken: 'a-real-resume-token',
    requireResumeReverification: true,
    fetchImpl,
  });

  assert.equal(access.allowed, true);
  assert.equal(access.via, 'resume');
});

test('reopening registration updates settings and writes an audit_log entry', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  const updated = await updateRegistrationSettings(
    env,
    PADUCAH_GO_PROGRAM_ID,
    { registrationStatus: 'open' },
    'Jordan Smith',
  );

  assert.equal(updated.registrationStatus, 'open');
  assert.equal(updated.updatedBy, 'Jordan Smith');

  const auditRow = db
    .prepare(
      "SELECT * FROM audit_log WHERE entity_type = 'registration_settings' ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  assert.ok(auditRow, 'expected an audit_log row to be written');
  assert.equal(auditRow.action, 'registration_settings.open');
  assert.equal(auditRow.entity_id, PADUCAH_GO_PROGRAM_ID);

  const metadata = JSON.parse(auditRow.metadata_json);
  assert.equal(metadata.previousStatus, 'closed');
  assert.equal(metadata.newStatus, 'open');
  assert.equal(metadata.actorLabel, 'Jordan Smith');
});

test('program-scoped settings do not leak across programs', async () => {
  const db = createTestDb();
  const env = makeEnv(db);

  // 'paducah-nfl-flag-football' already exists from the seed data (migration 0006).
  await updateRegistrationSettings(
    env,
    'paducah-nfl-flag-football',
    { registrationStatus: 'open' },
    'test-admin',
  );

  const paducahGo = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);
  const flagFootball = await getRegistrationSettings(
    env,
    'paducah-nfl-flag-football',
  );

  assert.equal(paducahGo.registrationStatus, 'closed');
  assert.equal(flagFootball.registrationStatus, 'open');
});

test('isAuthorizedForSettingsChange requires a matching bearer token', () => {
  const db = createTestDb();
  const env = makeEnv(db);

  const authorized = new Request('https://example.com/api/admin/registration-status', {
    headers: { Authorization: 'Bearer test-admin-token' },
  });
  const wrongToken = new Request('https://example.com/api/admin/registration-status', {
    headers: { Authorization: 'Bearer wrong-token' },
  });
  const missing = new Request('https://example.com/api/admin/registration-status');

  assert.equal(isAuthorizedForSettingsChange(authorized, env), true);
  assert.equal(isAuthorizedForSettingsChange(wrongToken, env), false);
  assert.equal(isAuthorizedForSettingsChange(missing, env), false);
});

test('isAuthorizedForSettingsChange fails closed when no token is configured', () => {
  const db = createTestDb();
  const env = makeEnv(db, { ADMIN_SETTINGS_TOKEN: undefined });
  const request = new Request('https://example.com/api/admin/registration-status', {
    headers: { Authorization: 'Bearer anything' },
  });

  assert.equal(isAuthorizedForSettingsChange(request, env), false);
});

test('private registration access allows a correct token and blocks an incorrect one', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  await updateRegistrationSettings(
    env,
    PADUCAH_GO_PROGRAM_ID,
    {
      registrationStatus: 'closed',
      allowPrivateAccess: true,
      newPrivateAccessToken: 'super-secret-private-link',
    },
    'test-admin',
  );
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);

  assert.equal(
    await isPrivateAccessTokenValid(settings, 'super-secret-private-link'),
    true,
  );
  assert.equal(await isPrivateAccessTokenValid(settings, 'guessed-wrong'), false);

  const allowedAccess = await evaluateRegistrationAccess(env, {
    settings,
    privateAccessToken: 'super-secret-private-link',
  });
  const blockedAccess = await evaluateRegistrationAccess(env, {
    settings,
    privateAccessToken: 'guessed-wrong',
  });

  assert.equal(allowedAccess.allowed, true);
  assert.equal(allowedAccess.via, 'private_access');
  assert.equal(blockedAccess.allowed, false);
});

test('registrationClosedPayload returns a stable, client-safe error shape', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  const settings = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);
  const payload = registrationClosedPayload(settings);

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'registration_closed');
  assert.match(payload.error, /closed until next season/i);
  assert.equal(payload.reopensAt, null);
});

test('getRegistrationSettings has no stale-caching layer (reflects updates immediately)', async () => {
  const db = createTestDb();
  const env = makeEnv(db);

  const before = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);
  assert.equal(before.registrationStatus, 'closed');

  await updateRegistrationSettings(
    env,
    PADUCAH_GO_PROGRAM_ID,
    { registrationStatus: 'open' },
    'test-admin',
  );

  const after = await getRegistrationSettings(env, PADUCAH_GO_PROGRAM_ID);
  assert.equal(after.registrationStatus, 'open');
});

test('getRegistrationOverview reports settings alongside draft/submission counts', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  const overview = await getRegistrationOverview(env, PADUCAH_GO_PROGRAM_ID);

  assert.equal(overview.settings.registrationStatus, 'closed');
  assert.equal(overview.activeDrafts, 0);
  assert.equal(overview.submittedCount, 0);
});

test('verifyResumeTokenActive returns false when the continuation service rejects the token', async () => {
  const db = createTestDb();
  const env = makeEnv(db);
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: false, error: 'Unknown resume token' }));

  const valid = await verifyResumeTokenActive(env, 'some-token', fetchImpl);
  assert.equal(valid, false);
});

test('verifyResumeTokenActive returns false when misconfigured (no shared secret)', async () => {
  const db = createTestDb();
  const env = makeEnv(db, { CONTINUATION_WORKER_SHARED_SECRET: '' });
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: true, context: {} }));

  const valid = await verifyResumeTokenActive(env, 'some-token', fetchImpl);
  assert.equal(valid, false);
});
