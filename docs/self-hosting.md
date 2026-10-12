# Self-host Personal Space

The same portable HTTP application and account controllers run behind Node and Cloudflare adapters. Identity, messaging, contact capabilities, notification policy and storage drivers are shared. Self-hosting does not grant capabilities that are incomplete in the reference deployment; see release-status.json and the implementation matrix.

## Node 24

```sh
npm ci
npm run dev:node
```

Open http://localhost:8788. This explicit localhost development mode uses a test CAPTCHA token and must never be exposed to the internet. SQLite stores account metadata; private files store blobs and cold archives under `.data/`. A 32-byte encryption key is created with restrictive permissions in `.data/encryption-key`. Back up the key and data together, separately from the running host; losing the key loses access to encrypted connector/signing records.

For a public installation, set APP_ORIGIN to the exact HTTPS origin, RP_ID follows its hostname, and run behind a trusted TLS reverse proxy. Use a stable origin: passkeys are bound to its RP ID. Set KEY_ENCRYPTION_KEY, TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY securely. Public account creation remains gated by RELEASE_READY and incomplete project release gates. Unbranded deployments use Personal Space by default; configure BRAND_NAME for your operator.

Node discards untrusted forwarded IP headers and uses the connected socket's address. A reverse-proxy deployment needs an explicitly trusted network-identity adapter to preserve per-user subnet limits; otherwise all proxied users share the proxy limit. Do not trust arbitrary X-Forwarded-For or CF-Connecting-IP sent by clients. The reference listener binds loopback, and reverse-proxy/production operations require separate configuration and tests.

## Cloudflare Workers

Copy wrangler.jsonc, change account_id, name, routes/custom domain, APP_ORIGIN and RP_ID to your own installation. Create your R2 buckets and update the bindings. Durable Objects provide sqlite metadata, atomic identity claims and rate-limit windows. The portable application does not import Cloudflare APIs; apps/worker supplies resources and statically compiled Argon2 WASM.

```sh
npm run build:assets
npm run check:worker
npm run dev:worker
```

wrangler.local.jsonc contains development-only CAPTCHA behavior. Never deploy that configuration. Production uses real Turnstile secret verification and exact host/action checks. Configure WAF/bot protection separately for authentication endpoints; public documentation and contract routes remain bot-readable.

## Provider configuration

S3-compatible services need endpoint, region, bucket/prefix and scoped access keys. WebDAV needs a vetted HTTPS host/root and app credentials. ALLOWED_CONNECTOR_HOSTS is an operator allowlist, not a user-supplied permission bypass. Google Drive, Dropbox and OneDrive require your own OAuth applications, exact redirect configuration, consent scopes and live provider conformance before enabling UI capability flags.

Hosted 3sln.me mail uses the Cloudflare `EMAIL` send binding; see [email deployment](deployment/email.md) for sender restrictions and domain onboarding. Self-hosted Workers use their own sender domain and binding allowlist. Node embedders can inject a reviewed delivery resource with `createNodeServer({mailer})`; it must provide `sendVerification`, and no mail transport is enabled by default. Mail needs a configured, verified sending provider and explicit account/channel preferences. Push needs VAPID keys and tested delivery. These credentials are operator resources; they are never included in browser assets. A populated secret is not proof a feature is operational. Configured and release-verified states must remain distinct.

## Operations and limits

Run `npm test`, `npm run test:worker` and browser checks. The Node adapter currently supports a single process with in-process serialization; multi-process instances require a shared linearizable repository and distributed gates. Worker auth currently uses a serialized identity directory; sharding/load/cost verification remains a release gate. Account deletion and rich archive rendering are not complete. Both runtimes share these limitations.

The origin hosts user data and signing authority. Provider custody sees plaintext data; no end-to-end encryption is claimed. Treat contact links as secrets, redact signed query fields from proxy/request logs, and never index them. Follow docs/spec/security.md and independent reviews before public deployment.
