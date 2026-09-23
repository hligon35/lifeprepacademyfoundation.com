# MLS Registration + Agreement Signing

This directory contains the MLS GO registration experience and agreement-signing workflow.

## Architecture

1. Frontend wizard: `mlsregistration/app.js` + `mlsregistration/styles.css`
2. Immutable templates (do not edit):
   - `mlsregistration/documents/MLS GO Player Registration Agreement.pdf`
   - `mlsregistration/documents/MLS GO Volunteer Agreement.pdf`
3. Worker API for server-side PDF generation/signing:
   - `mlsregistration/worker/index.js`
4. PDF coordinate maps:
   - `mlsregistration/worker/pdf-field-maps.js`
5. Template integrity hashes:
   - `mlsregistration/worker/template-hashes.js`
6. D1 persistence and operational data:
   - `mlsregistration/worker/d1-registration.js`
   - `mlsregistration/worker/migrations/*.sql`
7. Google Sheets backup mirror and metadata updates:
   - `mlsregistration/google-apps-script/Code.gs`

## Agreement Workflow

### Player registration

1. Complete registration sections.
2. Complete Player Agreement signing section.
3. Submit registration (single submission ID).
4. Worker generates signed PDF from immutable template.
5. Worker stores signed PDF in private R2.
6. Worker updates matching `Players` row agreement metadata.
7. Signer receives short-lived signer copy URL.

### Volunteer / Coach

1. Submit volunteer or coaching application payload once.
2. Complete Volunteer Agreement signing.
3. Worker generates/stores signed PDF.
4. Worker updates matching `Volunteers` or `Coaches` row.
5. Coach path signs Volunteer Agreement once only.

## Agreement Versioning

Template hashes are enforced before coordinate fill:

- Player: `f64fa9261ddf925208e918d100353335ab241ec6e30d2d2669e997d2fcaa5d29`
- Volunteer: `0d7922d11776f943ec696bbfd8728d11bf86011e0bebaacd488f43b3d75552a8`

If a template changes, update:

1. `mlsregistration/documents/*.pdf` (template file)
2. `mlsregistration/worker/template-hashes.js`
3. `mlsregistration/worker/pdf-field-maps.js` (coordinate review)

## Signature Placement Mode (Player)

`PLAYER_SIGNATURE_PLACEMENT_MODE` must be explicitly set to one of:

1. `parent_guardian_only`
2. `both_signature_lines`

This setting must be legally confirmed with RCX / MLS GO before production launch.

## Cloudflare Worker Bindings

Required in `wrangler.jsonc`:

1. Durable Object binding: `SIGNING_TRANSACTIONS`
2. R2 private bucket binding: `SIGNED_AGREEMENTS`
3. Vars:
   - `PLAYER_SIGNATURE_PLACEMENT_MODE`
   - `ALLOWED_ORIGINS`
   - `E_CONSENT_TEXT_VERSION`
   - `APPS_SCRIPT_URL`
4. Secrets (set via `wrangler secret put`):
   - `APPS_SCRIPT_UPDATE_TOKEN`
   - `SIGNER_LINK_SECRET`
   - `ADMIN_DOWNLOAD_TOKEN`

### Example secret setup

```bash
wrangler secret put APPS_SCRIPT_UPDATE_TOKEN
wrangler secret put SIGNER_LINK_SECRET
wrangler secret put ADMIN_DOWNLOAD_TOKEN
```

## Private Storage

Signed agreements are stored in private R2 object keys:

1. Player: `player-agreements/{registrationSubmissionId}/{transactionId}.pdf`
2. Volunteer/Coach: `volunteer-agreements/{submissionId}/{transactionId}.pdf`

No public bucket URLs are used as authorization.

## Payment Flow

The registration experience now uses a provider-neutral payment boundary:

1. The worker exposes `/api/public-config` with a non-sensitive `payment` object.
2. The worker exposes `/api/payment-session?playerCount=...` for future payment-provider integration.
3. The default mode is `paused` with `provider: "none"` and a safe status message.
4. Player registrations are saved immediately, and the success state tells the user that payment is temporarily paused and that a secure payment link will be emailed later.

### Payment configuration contract

The public payment config shape is:

```json
{
  "mode": "paused",
  "provider": "none",
  "status": "temporarily-paused",
  "amount": 75,
  "currency": "USD",
  "feePerPlayer": 75,
  "playerCount": 1,
  "paymentUrl": null,
  "instructions": "Payment is temporarily paused while we transition to a new payment provider. Your registration is saved, and we will email a secure payment link when the service is available."
}
```

## Payment Flow

The registration experience now uses a provider-neutral payment boundary:

1. The worker exposes `/api/public-config` with a non-sensitive `payment` object.
2. The worker exposes `/api/payment-session?playerCount=...` for future payment-provider integration.
3. The default mode is `paused` with `provider: "none"` and a safe status message.
4. Player registrations are saved immediately, and the success state tells the user that payment is temporarily paused and that a secure payment link will be emailed later.

### Payment configuration contract

The public payment config shape is:

```json
{
  "mode": "paused",
  "provider": "none",
  "status": "temporarily-paused",
  "amount": 75,
  "currency": "USD",
  "feePerPlayer": 75,
  "playerCount": 1,
  "paymentUrl": null,
  "instructions": "Payment is temporarily paused while we transition to a new payment provider. Your registration is saved, and we will email a secure payment link when the service is available."
}
```

## Google Sheets Backup Mirror

Cloudflare D1 is the primary operational store for MLS GO registrations. The
Worker writes the registration to D1 first, using the submission ID as the
idempotency key. After the D1 write succeeds, the Worker sends the same form
payload to Apps Script as a best-effort Google Sheets backup mirror.

An Apps Script or Sheets outage must not cause a successful D1 registration to
be rejected. Mirror status is tracked in D1 in `sync_events`, where an admin
retry process can be added or used to reconcile failures.

Apps Script remains responsible only for the Sheet-compatible backup/update
contract while the Worker owns operational registration data. New Worker code
must not use Apps Script for registration lookups, payment receipt lookups,
resume state, or primary business logic.

The legacy Apps Script project currently contains additional historical email
and continuation handlers. Those handlers are not part of the D1 primary write
path and should be retired after the corresponding Worker/D1 services are
fully enabled and verified in production.

`Code.gs` supports:

1. Idempotent upsert by submission ID for:
   - `mls_registration` (`registration_submission_id`)
   - `volunteer_application` (`submission_id`)
   - `coaching_application` (`submission_id`)
2. `LockService` row updates
3. Formula-injection protection
4. Preservation of system-managed agreement/payment columns during re-upsert
5. Agreement metadata update action:
   - `action=update_agreement_metadata`
   - `update_token=<AGREEMENT_UPDATE_TOKEN>`

### New agreement columns

Added to end of applicable tabs:

#### Players tab

- Player Agreement Status
- Player Agreement Version
- Player Agreement Signed At
- Player Agreement Signer Name
- Player Agreement File ID
- Player Agreement PDF URL
- Player Agreement SHA-256
- Player Agreement Transaction ID

#### Volunteers and Coaches tabs

- Volunteer Agreement Status
- Volunteer Agreement Version
- Volunteer Agreement Signed At
- Volunteer Agreement Signer Name
- Volunteer Agreement File ID
- Volunteer Agreement PDF URL
- Volunteer Agreement SHA-256
- Volunteer Agreement Transaction ID

### Apps Script deployment

1. Paste `mlsregistration/google-apps-script/Code.gs` into Apps Script project.
2. Set Script Property:
   - key: `AGREEMENT_UPDATE_TOKEN`
   - value: same token used in Worker secret `APPS_SCRIPT_UPDATE_TOKEN`
3. Run `initializeSheets()` once.
4. Deploy Web App (Execute as Me, access as appropriate).
5. Update `google-apps-script-url` meta in `mlsregistration/index.html` if URL changes.

## Secure Administrative PDF Access

1. Admin route: `/api/admin/agreement/{transactionId}`
2. Requires header: `Authorization: Bearer <ADMIN_DOWNLOAD_TOKEN>`

## Admin Dashboard and Cloudflare Access

The administrative UI is served at `/admin` and uses the following flow:

1. Cloudflare Access authenticates the approved Google account.
2. The Worker validates `CF-Access-Jwt-Assertion` against the Access team's JWKS.
3. D1 checks the authenticated email against `admin_users` and program-scoped RBAC.
4. The dashboard loads the D1-backed website submissions inbox and analytics.
5. `/admin/programs` displays the program selector; Paducah GO Soccer League is
   currently the first program dashboard shell.

The first approved account can be provisioned by setting the production Worker
var `ADMIN_BOOTSTRAP_EMAIL`. After its first successful Access login, remove or
clear the bootstrap value and manage subsequent users through the D1 admin/RBAC
workflow.

Website contact submissions are stored in the `site_submissions` D1 table through
`POST /api/site-submissions`. The public contact form's JavaScript posts to this
Worker endpoint; the MLS registration path continues to write D1 first and mirror
the same data to Google Sheets as a backup.
3. Signer route: `/api/signer/agreement/{transactionId}?exp=...&sig=...`
4. Signer URL is short-lived and HMAC-protected.

## Retry/Recovery Procedure

1. Submission IDs prevent duplicate row creation.
2. Durable Object tracks transaction state.
3. Repeated signing with same `transactionId` returns existing signed result.
4. Failed generation sets `Generation Failed` status.
5. Retry signing by re-submitting agreement signing payload with same submission ID.

## Parent/Volunteer Copy Retrieval

Signer receives a short-lived download URL in completion UI.
Do not expose the admin URL in public-facing pages.

## Local Development

```bash
npm install
npx http-server -p 3000 -c-1
```

## Live Player PDF Placement Preview

Use this local loop to tune `PLAYER_AGREEMENT_FIELD_MAP` coordinates and see immediate visual output:

1. Start static file server (root workspace):

```bash
npm run serve
```

2. In another terminal, start the PDF preview watcher:

```bash
npm run preview:player-pdf:watch
```

3. Open preview page:

- `http://localhost:3000/mlsregistration/preview/player-preview.html`

4. Edit either file and save:

- `mlsregistration/worker/pdf-field-maps.js`
- `mlsregistration/preview/player-preview-sample.json`

5. The watcher regenerates `mlsregistration/preview/live/player-agreement-preview.pdf`, and the preview page auto-reloads when updated.

Notes:

1. This preview uses typed signature rendering and the same wrapping logic as the Worker.
2. Keep template PDFs in `mlsregistration/documents/` unchanged.

## Worker Deploy

```bash
npx wrangler deploy --name lpaf-mls --assets ./mlsregistration
```

If using config-driven deploy:

```bash
npx wrangler deploy --config wrangler.jsonc
```

## Manual End-to-End Checklist

1. Player registration (1 player) signs and stores agreement.
2. Player registration (4 players, long names) wraps safely.
3. Volunteer path signs Volunteer Agreement.
4. Coach path signs Volunteer Agreement once.
5. Typed signature mode works.
6. Drawn signature mode works with touch and mouse.
7. Under-18 volunteer submission blocked.
8. Consent unchecked blocks signing submission.
9. Missing template hash mismatch blocks generation.
10. Signed PDF row updates include URL + SHA-256 + transaction ID.
11. Player registration rows default to `Payment Pending` until a payment status is later recorded.
12. Signer URL expires as expected.
13. Admin route requires bearer token.
