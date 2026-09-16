# Major Update Plan — Paducah GO Soccer League Platform

Status: **Phase 1 (audit) complete. Phases 2-7 not yet implemented — pending decisions below.**
Branch: `major-update` (fast-forwarded to `main` @ `9f355d1` before this plan was added; no unique commits were lost).

This document is the living plan requested before large changes are made. It captures the current
system as-built (Phase 1 audit) and the proposed approach for Phases 2-7. Nothing in Phases 2-7 has
been implemented yet — see "Open decisions" before continuing.

---

## 0. Naming

- Internal name for the existing MLS GO registration app: **Paducah GO Soccer League**. This is an
  internal/code-level rename only in this plan; no user-facing legal/brand text should change without
  a separate explicit request, since "MLS GO" is a licensed program name used in agreements sent to
  MLS/RCX Sports systems (favorite club list, agreement text, Sheet columns, Apps Script contract).
- Future program slugs reserved (not yet built, not publicly exposed):
  - `paducah-nfl-flag-football`
  - `paducah-nfl-flag-football-clinic`

## 1. Current State (Phase 1 audit findings)

### 1.1 Deployments / infra
| Config | Worker | Route | Bindings |
|---|---|---|---|
| [wrangler.jsonc](wrangler.jsonc) | `mlsregistration-lifeprepacademyfoundation-com` | `mlsregistration.lifeprepacademyfoundation.com/*` | DO `SigningTransactionsDO` (SQLite), R2 `SIGNED_AGREEMENTS` (`lpaf-mls-signed-agreements`), R2 `lpaf_mls_signed_agreements_preview`, ASSETS |
| [wrangler.preview.jsonc](wrangler.preview.jsonc) | `mlsregistration-preview` | workers.dev | same shape, preview bucket |

No D1 binding exists today. No `site-static` / `site-admin` R2 buckets exist today. Root marketing
site (`lifeprepacademyfoundation.com`) is a static GitHub Pages site (see `CNAME`) — **not** deployed
via Wrangler, so it cannot read Worker `vars`/secrets at request time.

Secrets already in use: `ADMIN_DOWNLOAD_TOKEN`, `APPS_SCRIPT_UPDATE_TOKEN`, `SIGNER_LINK_SECRET`,
`PAYMENT_WEBHOOK_TOKEN`, `GOOGLE_MAPS_API_KEY`, `CONTINUATION_WORKER_SHARED_SECRET`.

### 1.2 Public routes (must not change)
- Root site: `index.html`, `about.html`, `contact.html`, `privacy.html`, `terms.html`, `mls-go.html`,
  `mls-go-rulebook.html`, `nfl-flag.html` (info-only, not linked from nav), `events.html`,
  `programs.html`, `youth-programs.html`.
- `mlsregistration.lifeprepacademyfoundation.com/` — registration wizard (`mlsregistration/index.html`
  + `flow-gate.js` + `flow-logic.js` + `app.js`), gated by `REGISTRATION_OPEN` switch in
  [mlsregistration/flow-gate.js](mlsregistration/flow-gate.js).
- `checkin.lifeprepacademyfoundation.com` (if deployed) — separate Flag Football Fast Pass check-in
  app (`checkin/`), own Apps Script backend. Independent system; out of scope unless explicitly asked.

### 1.3 Existing registration stages/fields (`mlsregistration/app.js`, `flow-logic.js`)
Stages: `PLAYER_REGISTRATION` → `PLAYER_AGREEMENT` → (`SCHOLARSHIP_APPLICATION`) →
(`VOLUNTEER_APPLICATION` / `COACHING_APPLICATION` → `VOLUNTEER_AGREEMENT`) →
`FINAL_CONFIRMATION_EMAIL` → `THANK_YOU` → (`PAYMENT` unless scholarship).

Registration type is currently expressed via `helpChoice` (no, volunteer, coach, both) plus the
`?flow=volunteer` / `?flow=coach` standalone entry points — this already covers all 6 combinations
requested in Phase 2 §1, just not as an explicit up-front "registration type" selector. Parent,
emergency contact, per-player (up to 4), uniform sizing, race/ethnicity, favorite club, "how did you
hear about us", scholarship, agreements (player waiver, PPF liability, marketing opt-in, e-consent)
all already exist with the exact option sets described in the request (verified field-by-field against
`app.js`). **Phase 2 is therefore mostly a UX/organization pass (clearer up-front registration-type
step + review/edit summary page), not a rebuild of data collection.**

Not present today: a dedicated **review-and-submit summary page** with per-section edit links and
missing/invalid-field highlighting. This is the one genuinely new piece of Phase 2.

### 1.4 Continuation / resume system
Tokens are minted and verified entirely in **Google Apps Script** (`ContinueRegistration/04_Tokens.gs`),
not in the Worker or D1. The Worker only proxies `/api/resume/context`, `/api/resume/complete`,
`/api/resume/withdraw/verify`, `/api/resume/withdraw/confirm` to Apps Script. There is **no
localStorage/IndexedDB draft persistence today** — refreshing without a resume token loses in-progress
work. Idempotency today relies on `registration_submission_id` upsert in Sheets + Apps Script
"completion owner token" checks; there is no D1-backed idempotency yet.

### 1.5 Google Sheets / Apps Script contract (must be preserved)
Sheet `1EIG6F00-mVhT9ws0nS3pJBrp9Y2mPH87p6UyLkWtKT4`, tabs: Players, Volunteers, Coaches,
Scholarships, Errors, Email Tracking, Registration Continuation Cases/Audit. Full column contract and
Apps Script action list captured during audit (see chat history / can be re-derived from
`mlsregistration/google-apps-script/**`). Two web apps: main registration (`APPS_SCRIPT_URL`) and
continuation (`CONTINUATION_WEB_APP_URL`).

### 1.6 Signed agreements
PDF generation via `pdf-lib` + `fontkit`, stored in R2 `SIGNED_AGREEMENTS` at
`{agreementType}/{submissionId}/{txId}`, transaction state tracked in `SigningTransactionsDO`
(SQLite-backed DO, 30-day retention). Signer downloads use HMAC-signed, expiring URLs
(`SIGNER_LINK_SECRET`); admin downloads use a single global bearer token (`ADMIN_DOWNLOAD_TOKEN`) —
**no per-admin identity or RBAC today**. This bucket/workflow stays as-is per the request; it is not
part of the new `site-static`/`site-admin` buckets.

### 1.7 Payments
Quest checkout redirect (`buildPlayerRegistrationPaymentUrl`), webhook at
`/api/payment-webhook/cornerstone`, normalizes Quest/Cornerstone payloads, idempotent by
`submissionId`, writes back to Sheets, sends paid-confirmation email with agreement link.

### 1.8 NFL Flag Football (current state — not to be exposed publicly until finished)
- `nfl-flag.html`: static info page, **not linked from nav**.
- Real participant intake today is an **external Jotform** (`https://form.jotform.com/261490871776065`),
  driven by a Make.com email template (`templates/nfl_clinic_make_template.txt`), separate from the
  Worker/D1/Sheets stack entirely.
- `checkin/` is a separate Fast Pass check-in app for flag football events, own Apps Script backend.
- `FlagFootball/` contains Word-doc waivers/forms (not wired into any system).
- Four Make.com blueprints exist under `mlsregistration/make/` for missing-document and
  scholarship-signing reminders — unrelated to Flag Football, listed for completeness.

### 1.9 Admin UI
**No admin dashboard exists.** The only admin surface is `GET /api/admin/agreement/{transactionId}`
gated by a single shared bearer token. Phases referencing `admin_users`, `roles`, `permissions`, an
admin UI, newsletters, and analytics are **greenfield** — there is nothing to preserve/migrate here
beyond the one download endpoint.

---

## 2. Proposed D1 schema (binding name `lpaf-db`, additive, program/season-scoped)

High-level table groups (full column-level DDL to be delivered as numbered migrations under
`mlsregistration/worker/migrations/` using `wrangler d1 migrations`):

- **Catalog:** `programs`, `seasons` — seeds: `paducah-go-soccer-league` (active), `paducah-nfl-flag-football`
  and `paducah-nfl-flag-football-clinic` (inactive/disabled by config flag).
- **Registration operational data:** `registrations`, `registration_participants`,
  `registration_documents`, `registration_drafts` (server-side draft mirror for resume + offline
  retry queue reconciliation).
- **Program ops:** `roster_teams`, `roster_assignments`, `uniform_inventory`,
  `uniform_inventory_imports` (Phase 7 CSV import).
- **Observability:** `sync_events` (Sheets sync status per registration), `analytics_events`,
  `analytics_daily_metrics`.
- **Admin/auth:** `admin_users`, `admin_invitations`, `roles`, `permissions`,
  `admin_user_programs`, `admin_user_permissions`, `audit_log`.
- **Newsletters:** `newsletters`, `newsletter_assets`, `newsletter_recipients`.

Every row that represents program data carries `program_id`. `registrations.submission_id` (existing
`registration_submission_id`) remains the idempotency key; D1 writes use `INSERT ... ON CONFLICT
(submission_id) DO UPDATE` semantics. The original submitted payload is kept in a `raw_payload_json`
column on `registrations` in addition to normalized columns, per the request.

D1 is additive: Sheets remains the system of record for Apps Script email/automation triggers; D1
becomes the fast operational/admin read path and sync-status tracker, not a replacement.

---

## 3. Phase-by-phase delivery plan

1. **Phase 1 — Audit.** ✅ Done (this document).
2. **Phase 2 — Registration UX pass.** Add explicit registration-type step + review/edit summary page
   on top of existing fields/stages. No field/agreement wording changes.
3. **Phase 3 — Draft recovery.** Add localStorage/IndexedDB autosave + `registration_drafts` D1 table +
   online/offline/sync status UI + retry queue, layered onto the *existing* Apps Script resume-token
   system (does not replace it).
4. **Phase 4 — D1.** ✅ Schema delivered: 6 migrations under `mlsregistration/worker/migrations/`
   (`0001_catalog_and_registrations.sql` … `0006_seed_data.sql`), `d1_databases` binding `lpaf-db`
   added to `wrangler.jsonc` (placeholder `database_id` pending real provisioning — see §4.2), applied
   and verified against the **local-only** D1 emulation (`wrangler d1 migrations apply lpaf-db --local`,
   `wrangler d1 execute lpaf-db --local`). Remaining: wire idempotent Worker writes
   (`INSERT ... ON CONFLICT (submission_id) DO UPDATE`) into `mlsregistration/worker/index.js`.
5. **Phase 5 — Sheets mirroring status.** Add `sync_events`/sync-status columns and an admin retry
   action; Apps Script contract unchanged. (`sync_events` table already created in Phase 4 schema.)
6. **Phase 6 — R2 `site-static` / `site-admin`.** Provision buckets, authorized admin asset endpoints;
   signed-agreement bucket untouched.
7. **Phase 7 — Uniform inventory CSV import.** Wide-CSV parser, club-name canonicalization, preview →
   commit → rollback, kit math (`min(jersey, shorts, socks)`). (`uniform_inventory` /
   `uniform_inventory_imports` tables already created in Phase 4 schema.)
8. **Phase 8 — Roster Generator.** 5v5–11v11 formats, favorite-club preference balancing, manual
   override, draft/published/locked workflow. (`roster_teams` / `roster_assignments` tables already
   created in Phase 4 schema, including `favorite_club`/`preferred_uniform_club`/
   `assigned_uniform_club`/`assigned_kit_id`/`league_team_id`/`manual_override`/`assignment_reason`
   on `registration_participants`.)
9. **Phase 9 — Admin Application.** Full nav shell (Paducah GO Soccer League / Paducah NFL Flag
   Football [reserved] / Paducah NFL Flag Football Clinic [reserved] / Site Analytics / Newsletter /
   Settings).
10. **Phase 10 — Admin Permissions & Invitations.** Program-scoped RBAC enforcement in the Worker using
    the `roles`/`permissions`/`admin_user_programs`/`admin_user_permissions` tables and seed data
    already created in Phase 4 schema (7 suggested roles, 23 permissions incl. sensitive-field flags).
11. **Phase 11 — Site Analytics.** Privacy-conscious event tracking/dashboards on top of the
    `analytics_events` / `analytics_daily_metrics` tables already created in Phase 4 schema.
12. **Phase 12 — Newsletter Builder.** Rich text + image-to-newsletter-body import using `site-admin`
    as the private source, provider-neutral email delivery, on top of the `newsletters` /
    `newsletter_assets` / `newsletter_recipients` tables already created in Phase 4 schema.
13. **Phase 13 — Security/Privacy hardening pass** across all new surfaces built in Phases 2–12.
14. **Phase 14 — Testing/QA.** Automated test suite + full production-style preview/inspection pass.
15. **Phase 15 — Cloudflare configuration/documentation.** Final binding names, setup commands, secrets
    guidance (no real secrets committed).

---

## 4. Open decisions before writing code (need your input)

1. ~~**Spec truncation**~~ — **Resolved.** Full spec (Phases 1–15 + Final Implementation Rules) received;
   this document and the Phase 4 schema now cover all 15 phases.
2. **Infra provisioning:** creating the `lpaf-db` D1 database and the `site-static` / `site-admin` R2
   buckets are real, billable Cloudflare account changes. I will run the `wrangler d1 create` /
   `wrangler r2 bucket create` commands (listed below) once you confirm — I won't create cloud
   resources silently.
3. **Root site cannot read Worker vars.** The marketing site is static GitHub Pages, not a Worker. Any
   config-driven toggle that must affect `mls-go.html` (like `REGISTRATION_OPEN`) has to either stay a
   duplicated constant (current approach) or move to a client-side fetch against a public
   `mlsregistration` status endpoint. Confirm which you prefer if this needs to extend further.
4. **Admin auth model:** today's single shared bearer token is insufficient for the requested
   roles/permissions system. Building `admin_users`/`roles`/`permissions` implies real authentication
   (login, sessions or JWT, password/invite flow) — a meaningfully sized sub-project on its own. Please
   confirm the desired auth approach (Cloudflare Access, Workers-native sessions, email+password, etc.)
   before Phase 4's admin tables are wired to an actual UI.
5. **Sequencing:** given the size, I recommend landing Phases 2 → 4 → 5 → 3 → 6 → 7 as separate
   reviewable commits/PRs on `major-update` rather than one giant commit, so registration/payment
   behavior can be verified at each step. Confirm this is acceptable.

---

## 5. Required Cloudflare setup (not yet run — pending confirmation in §4.2)

```powershell
wrangler d1 create lpaf-db
# then add the returned database_id to wrangler.jsonc as a d1_databases binding named "lpaf-db"

wrangler r2 bucket create site-static
wrangler r2 bucket create site-admin

# secrets to add once admin auth model is decided (§4.4), e.g.:
wrangler secret put ADMIN_SESSION_SECRET --config wrangler.jsonc
```

---

## 6. Registration-status control (Paducah GO Soccer League) — implemented

A program-scoped, D1-backed open/closed control for player registration, built as a discrete
increment ahead of the full Phase 10 admin/RBAC system. Scoped to `paducah-go-soccer-league` only;
`paducah-nfl-flag-football` / `-clinic` are unaffected (each program has its own `registration_settings`
row when/if created).

### 6.1 What was added
- `mlsregistration/worker/migrations/0007_registration_settings.sql` — new `registration_settings`
  table (`program_id` PK/FK, `registration_status`, `allow_draft_resume`, `allow_private_access`,
  `private_access_token_hash`, `public_message`, `closed_message`, `reopens_at`, `updated_at`,
  `updated_by`). Seeded row for Paducah GO is `closed`, matching the prior production default
  (`REGISTRATION_OPEN = false` in the retired `flow-gate.js`) — this migration alone changes nothing
  for end users.
- `mlsregistration/worker/registration-status.js` — CommonJS module (bundler-importable + directly
  `require()`-testable under plain `node:test`, matching the existing `payment-config.js` pattern).
  Exports the D1 reads/writes, the access-decision function (`evaluateRegistrationAccess`), audit
  logging, and admin-token auth check.
- `index.js` wiring:
  - `handlePublicConfig` is now `async` and returns a `registration: {status, message,
    allowDraftResume, reopensAt}` block.
  - `handleFormUpsert` gates only `formType === "mls_registration"` (volunteer/coaching untouched).
  - `handleFinalConfirmationEmail` gates only when `payload.registrationSubmissionId` is present.
  - `handleResumeContext` / `handleResumeComplete` gate on allow-resume/private-access flags without
    double-verifying the resume token (they already validate it via the continuation service).
  - New `handleRegistrationLandingPage` uses `HTMLRewriter` to server-render the closed state (and
    the closed message) into `/` and `/index.html` directly — the closed state is enforced and
    rendered server-side, not solely by client JS. Respects `?flow=volunteer`/`?flow=coach` (never
    gated) and `?pk=`/`?resume=` (private-access / valid-resume bypass), matching prior client-only
    behavior in intent.
  - New admin routes: `GET /api/admin/registration-status`, `PUT /api/admin/registration-status`
    (requires `{confirm: true}` and a bearer token matching `env.ADMIN_SETTINGS_TOKEN`).
- `wrangler.jsonc` — `assets.run_worker_first` now includes `"/"` and `"/index.html"` so the Worker
  (not the static asset binding) serves the landing page and can rewrite it.
- `mlsregistration/flow-gate.js` retired (`git rm`) — its class-toggle logic is now applied
  server-side. `mlsregistration/index.html` had the script tag removed and gained
  `id="registration-closed-message"` / `id="registration-reopens-at"` for the rewriter to target.
- `mlsregistration/app.js` — captures `?pk=` as `privateAccessToken`; both it and
  `registrationResumeState.token` are now sent as top-level fields on `resume/context`,
  `resume/complete`, `forms/upsert`, and `final-confirmation-email` requests.
- `mlsregistration/admin-registration-status.html` / `.js` / `.css` — minimal standalone admin page
  (interim, ahead of Phase 10 real RBAC). Bearer token entered by the admin and kept only in
  `sessionStorage`; shows current status + audit metadata + active-draft/submitted counts; requires
  an explicit "I understand" confirmation checkbox before applying a change, with a warning box shown
  when switching to closed. Uses `fetch()`, not a native `<form>` submit, so the site's
  `form-action` CSP directive (scoped to `https://docs.google.com`) is not implicated.
- `mlsregistration/worker/registration-status.test.js` — 15 `node:test` cases using a thin D1-API
  adapter over `node:sqlite`'s `DatabaseSync`, loaded with the **real** migration SQL files
  (0001–0007). Covers: open access, closed+no-bypass block, closed+draft-resume with a re-verified
  token, closed+fabricated-token block, reopening + audit_log row, program isolation, admin-token
  auth (present/wrong/missing/unconfigured), private-access token valid/invalid, payload shape, and
  "no stale caching" (every read re-queries D1). All passing (`node --test
  mlsregistration/worker/registration-status.test.js`).

### 6.2 Honest caveats / follow-ups
- **Admin auth is interim.** `ADMIN_SETTINGS_TOKEN` is a single shared bearer secret, mirroring the
  existing `ADMIN_DOWNLOAD_TOKEN` pattern — not per-user, not role-scoped. Replace with real
  Phase 10 RBAC sessions when that lands.
- **`activeDrafts` / `submittedCount` will read 0 today.** Nothing yet writes to `registration_drafts`
  / `registrations` (that's the rest of Phase 4's write-through wiring), so the admin overview's
  counts are accurate-but-empty until that lands.
- **New required secret:** `ADMIN_SETTINGS_TOKEN` (not yet set — run
  `wrangler secret put ADMIN_SETTINGS_TOKEN --config wrangler.jsonc` before relying on the admin page
  against a real deployment; until it's set, `isAuthorizedForSettingsChange` fails closed and the
  admin routes always return 401).
- **Legacy dead code confirmed, left untouched:** `mlsregistration/worker/resume-status.js` (client
  UI text toggler) and `mlsregistration/worker/resume-endpoints.js` (an older, unused
  `handleResumeContext`/`handleResumeComplete` pair with the same names as the live handlers in
  `index.js`) are not imported anywhere (`grep` confirmed zero references). They were not touched —
  removing dead code is outside this feature's scope — but they should not be confused with the live,
  gated handlers in `index.js`.
- **Migration 0007 applied and spot-checked** against the local D1 emulation
  (`wrangler d1 migrations apply lpaf-db --local`); not yet applied to any remote database (no remote
  `lpaf-db` exists yet — see §5).

