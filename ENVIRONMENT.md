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

Current Worker secrets should be configured separately for each environment:

```bash
wrangler secret put APPS_SCRIPT_UPDATE_TOKEN
wrangler secret put AGREEMENT_UPDATE_TOKEN
wrangler secret put CONTINUATION_WORKER_SHARED_SECRET
wrangler secret put SIGNER_LINK_SECRET
wrangler secret put ADMIN_DOWNLOAD_TOKEN
wrangler secret put PAYMENT_WEBHOOK_TOKEN
```

Newsletter delivery secrets are only required when a provider is configured:

```bash
wrangler secret put NEWSLETTER_PROVIDER_API_KEY
wrangler secret put NEWSLETTER_WEBHOOK_SECRET
```

Use separate preview and production secrets. Never print or commit secret
values. Preserve the existing signed-agreement bucket and Durable Object
workflow separately unless a reviewed migration is completed.
