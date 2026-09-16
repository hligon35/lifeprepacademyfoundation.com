# Environment and Cloudflare configuration

The deployed Worker uses Wrangler variables, bindings, and secrets; it does not
automatically load `.env` files.

For local development, copy `.env.example` to `.env` and `.dev.vars.example` to
`.dev.vars`. Replace placeholder secret values locally. Never commit either
file. The repository ignores `.env` and `.dev.vars` while allowing these example
templates.

Required resource names:

- D1 binding: `lpaf-db`
- Public static R2 bucket: `site-static`
- Protected admin R2 bucket: `site-admin`

Admin authentication is provided by Cloudflare Access using Google as the identity
provider. Configure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` as Worker vars and
set `ADMIN_BOOTSTRAP_EMAIL` to the first approved Google account. The Worker
validates the Access JWT and then checks the D1 `admin_users`/RBAC records.

For local Wrangler-only testing, use `ADMIN_DEV_EMAIL` and `ADMIN_DEV_TOKEN` in
`.dev.vars`. Do not configure those two values in production.

The admin route is served by the registration Worker at `/admin`, while the root
website continues to serve its public pages. The route patterns for `/admin*`,
`/api/admin*`, and `pgs.lifeprepacademyfoundation.com/*` require active, proxied
DNS records in the Cloudflare zone.

Current Worker secrets should be configured separately for each environment:

```bash
wrangler secret put APPS_SCRIPT_UPDATE_TOKEN
wrangler secret put AGREEMENT_UPDATE_TOKEN
wrangler secret put CONTINUATION_WORKER_SHARED_SECRET
wrangler secret put SIGNER_LINK_SECRET
wrangler secret put ADMIN_DOWNLOAD_TOKEN
wrangler secret put PAYMENT_WEBHOOK_TOKEN
```

After creating the Cloudflare Access application, populate these production vars
in the Worker configuration before deployment:

```text
ADMIN_BOOTSTRAP_EMAIL=the-approved-google-email@example.com
CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
CF_ACCESS_AUD=the-access-application-audience-tag
```

Use the Access application's audience tag exactly as Cloudflare provides it. Do
not substitute the Google OAuth client ID; Google is the identity provider and
Cloudflare Access is the application protecting the Worker.

Newsletter delivery secrets are only required when a provider is configured:

```bash
wrangler secret put NEWSLETTER_PROVIDER_API_KEY
wrangler secret put NEWSLETTER_WEBHOOK_SECRET
```

If Worker-owned email delivery is enabled, configure SendGrid separately:

```bash
wrangler secret put SENDGRID_API_KEY
```

If the public contact form uses Turnstile, configure its server secret separately:

```bash
wrangler secret put TURNSTILE_SECRET
```

Set the verified sender address with the non-secret `SENDGRID_FROM_EMAIL` and
`SENDGRID_FROM_NAME` variables.

Use separate preview and production secrets. Never print or commit secret
values. Preserve the existing signed-agreement bucket and Durable Object
workflow separately unless a reviewed migration is completed.
