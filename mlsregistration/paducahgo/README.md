# Paducah GO Soccer Web App

Paducah GO is the first program workspace in the LifePrep Youth Programs platform.

## Canonical hosts

- Platform hub: https://app.lifeprepacademyfoundation.com/programs
- Paducah GO: https://paducahgo.lifeprepacademyfoundation.com
- Staff administration: https://lifeprepacademyfoundation.com/admin
- Paducah GO operations console: https://paducahgo.lifeprepacademyfoundation.com/admin
- Future program hosts: pnffl.lifeprepacademyfoundation.com and pnffc.lifeprepacademyfoundation.com

## Route groups

Public routes:

- /
- /season
- /register
- /schedule
- /shop
- /contact
- /about
- /faq

Authenticated shared routes:

- /dashboard
- /profile
- /notifications
- /messages
- /programs

Role-scoped routes:

- /family/*
- /player/*
- /coach/*
- /volunteer/*
- /program-admin/*

The Paducah GO shell is responsive and uses a desktop sidebar plus mobile bottom navigation. Route access is enforced in the Worker and reflected in the client navigation.

Phase One administration adds a D1-backed Paducah GO operations console with program-scoped registration controls, season configuration, registrant metrics and pipeline views, announcements with hero display, scoped staff assignments, and an activity log. The existing program-level registration gate remains the source of truth for public registration pages while season settings provide inputs for later team and schedule generation.

## Importing existing registrants

Historical registrations can be backfilled from the existing Google Sheet without
creating duplicate records. An authorized program administrator or registration
manager should export the `Players` tab as a CSV, open the Paducah GO operations
console at `/admin`, choose `Registrants`, and select `Import Players CSV`.

The importer uses `registration_submission_id` as the idempotency key, assigns
rows to the selected season, preserves the raw row payload, maps payment and
agreement status, and records the import as a Google Sheets source. Repeating the
same import updates existing rows rather than creating duplicates. Blank rows,
non-player tabs, and rows without a submission ID are skipped and summarized.

## Authentication

Staff sign in through Cloudflare Access at /admin. The program hub exchanges the verified staff identity for a short-lived, one-use handoff code. The Paducah GO host redeems that code and creates a host-scoped application session.

Family, player, coach, and volunteer access uses the shared application session and passwordless email flow. Authentication tokens are not stored in localStorage.

## Data boundaries

Paducah GO data must be scoped to the Paducah GO program ID and, where applicable, the active season. Parents can only access connected children, coaches can only access assigned teams, volunteers can only access assigned duties, and program administrators are limited to Paducah GO unless they also have a global platform role.

## Adding a future program

Add the program record and hostname configuration, add the Cloudflare route, create a program-specific shell/configuration, and reuse the shared auth, D1, messaging, registration, schedule, and commerce services. Do not copy the Paducah GO authentication or database logic into a second application.
