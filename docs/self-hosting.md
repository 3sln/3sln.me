# Self-host Personal Space

The same portable HTTP application and account controllers run behind Node and Cloudflare adapters. Identity, messaging, contact capabilities, notification policy and storage drivers are shared. Check the capabilities advertised by your installation before enabling integrations; configured credentials alone do not establish working delivery or provider compatibility.

## Node 24

```sh
npm ci
npm run dev:node
```

Open http://localhost:8788. This explicit localhost development mode uses a test CAPTCHA token and must never be exposed to the internet. SQLite stores account metadata; private files store blobs and cold archives under `.data/`. A 32-byte encryption key is created with restrictive permissions in `.data/encryption-key`. Back up the key and data together, separately from the running host; losing the key loses access to encrypted connector/signing records.

For a public installation, set APP_ORIGIN to the exact HTTPS origin, RP_ID follows its hostname, and run behind a trusted TLS reverse proxy. Use a stable origin: passkeys are bound to its RP ID. Set KEY_ENCRYPTION_KEY, TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY securely. Set SIGNUP_ENABLED explicitly to control public account creation independently of RELEASE_READY. Keep SIGNUP_CONTACT_REQUIRED=true for verified-email or acknowledged-push activation; pending setup does not grant an active session. Unbranded deployments use Personal Space by default; configure BRAND_NAME for your operator.

Node discards untrusted forwarded IP headers and uses the connected socket's address. A reverse-proxy deployment needs an explicitly trusted network-identity adapter to preserve per-user subnet limits; otherwise all proxied users share the proxy limit. Do not trust arbitrary X-Forwarded-For or CF-Connecting-IP sent by clients. The reference listener binds loopback, and reverse-proxy/production operations require separate configuration and tests.

## Cloudflare Workers

Copy wrangler.jsonc, change account_id, name, routes/custom domain, APP_ORIGIN and RP_ID to your own installation. Create your R2 buckets and update the bindings. Durable Objects provide sqlite metadata, atomic identity claims and rate-limit windows. The portable application does not import Cloudflare APIs; apps/worker supplies resources and statically compiled Argon2 WASM.

```sh
npm run build:assets
npm run check:worker
npm run dev:worker
```

wrangler.local.jsonc contains development-only CAPTCHA behavior. Never deploy that configuration. Production uses real Turnstile secret verification and exact host/action checks. Configure WAF/bot protection separately for authentication endpoints; public documentation and contract routes remain bot-readable.

## Private hosts with a fixed set of accounts

A private installation can keep `SIGNUP_ENABLED=false` while retaining normal sign-in and recovery. The separate ordinary onboarding lane is enabled with `ONBOARDING_ENABLED=true`, a private `ONBOARDING_KEY`, and `ONBOARDING_NAMES`, a JSON array of canonical ordinary handles. It does not infer a system identity, grant administrative privileges or confer a paid plan. Badge IDs are explicitly selected by the operator or its resolver. The default policy reserves the reference service’s system names, which also have a separate system-account invitation flow. An explicit host-name policy can choose different reserved and onboardable sets for your installation. Every account still needs a primary credential, terms acceptance and completed recovery setup; configured verified-contact requirements still apply.

`HOST_NAME_POLICY` is a versioned JSON configuration with `reserved` and `onboarding` names. Reserved names and token-onboardable names are unavailable to ordinary public handle claims; those sets may overlap. An explicit policy replaces the default name sets. Without it, the default reserved names and `ONBOARDING_NAMES` remain in effect.

```json
{"version":1,"reserved":["admin"],"onboarding":["alice","bob"]}
```

Badges are local UI presentation. The host supplies `BADGE_DEFINITIONS` as an array of `{id,name,description,svg}` entries; the app generates one SVG sprite with named symbols, a content hash and accessible labels. The embedder does not need to author a sprite map. For example:

```json
[
  {
    "id":"team",
    "name":"Host team",
    "description":"A member of this host’s team.",
    "svg":"<svg viewBox=\"0 0 24 24\"><path d=\"M2 2h20v20H2z\" fill=\"currentColor\"/></svg>"
  }
]
```

Node integrators inject `resolveIdentityBadges` into `createNodeServer`. Worker integrators use `createWorker({resolveIdentityBadges})`. The hook receives a frozen descriptor containing identity ID, handle, aliases, status and stored badge IDs; credentials, sessions, connector keys and recovery material are excluded. It may look up role information using the identity ID. It returns at most four known badge IDs. Failures, invalid results or a500ms timeout produce no badges without changing login authority. The deadline bounds asynchronous waiting; injected code runs in the host runtime and is not CPU-isolated. JSON configuration does not execute resolver code.

Badge definitions accept bounded static SVG shapes. Scripts, event handlers, external references and unsupported active content are refused. Identity records contain badge IDs, not SVG or badge URLs. The default resolver reads the identity’s `badgeIds`; an integrator can inject a code-owned resolver to choose known badge IDs from roles or another local policy. Badge results do not change authentication, paid status or administrative privileges. Editing a definition changes its local display; changing assignments belongs to the identity record or trusted management policy, rather than a name-to-badge configuration map. A management UI is not required by this adapter interface.

An operator issues a scoped invitation for one or several configured names. The host durably reserves every name before the invitation becomes usable. Reservations and assignments are permanent: expiry or configuration removal does not make a name available for another identity. Each claimed name consumes one overall account admission, without using public free-signup capacity. The same account keeps its numeric alias as well as its configured name.

Prepare a private operator directory and a `names.json` file containing the intended initial assignments, for example `["bob", {"name":"alice","badgeIds":["team"]}]`. Keep operator files owner-readable only. The CLI never prints keys or invitation tokens:

```sh
node scripts/onboarding.mjs key --out /private/operator/onboarding.key
node scripts/onboarding.mjs invite --key-file /private/operator/onboarding.key \
  --origin https://accounts.example --names-file /private/operator/names.json \
  --out /private/operator/preparation.json
node scripts/onboarding.mjs issue --key-file /private/operator/onboarding.key \
  --origin https://accounts.example --input /private/operator/preparation.json \
  --out /private/operator/invitation.json
```

Configure the generated key as `ONBOARDING_KEY` through your host’s secret mechanism before `issue`. `invite` prepares immutable claims offline; `issue` explicitly contacts the host with a separate short-lived issuance proof and writes the usable link only after matching durable confirmation. Keep the exact preparation after an uncertain response and explicitly retry it; generating replacement identities does not repair a partial issuance. Files are written exclusively with mode0600, and private input/symlink checks prevent accidental reuse or disclosure. Invitation validity defaults to24hours and is bounded at seven days. Badge IDs selected for each name must exist in this host’s definitions; later management can change the identity property independently of the original invitation.

Generated links use `/token-onboarding#token=…`. The fragment never enters the HTTP request URL; the browser captures it privately and immediately scrubs the address before starting the portal. No GET, preview or scanner claims an account. The user deliberately opens the invitation, chooses an available authorized name, then follows the credential and recovery wizard. A holder of a multi-name invitation can claim any of its names; issue separate invitations when different people should have different authority. Do not publish an invitation or put it in telemetry, screenshots or ordinary browser storage.

A lost response after account creation is not permission to claim again. Resume using the credential already configured; an interrupted passkey setup before credential registration or a lost setup-browser binding may require operator reconciliation. The invitation does not become an account-recovery credential. Reopening a scrubbed page requires the original private link or a deliberate token paste.

## Boot and administrators

A fresh installation has no administrator. To bootstrap one, mint a single-use boot token on your own machine: `node scripts/boot-token.mjs mint --origin https://accounts.example --out /private/operator/boot-token.json`. This writes a private 0600 file and prints only `BOOTSTRAP_TOKEN_SHA256=<hex>`. Deploy that digest, never the token. `BOOT_ACCESS_HOURS` (1–72, default 24) sets how long boot access lasts. Within 30 minutes of minting, open the console's boot setup, paste or import the token, and set a passkey or password. The token works once: if you lose boot access, mint and deploy a new digest to restore it.

Boot exists to create administrators. It mints claim tokens for reserved handles, possibly granting the built-in `admin` role, and decides which roles, capabilities and badges are internal-only or available to ordinary users. Administrators can then reserve handles, mint claim tokens for non-administrator roles, look up users, and assign roles and badges within those classes. Only boot creates or revokes administrators. Every action needs a fresh step-up and is recorded in an append-only, hash-chained audit log. The console wiring and UI are a later slice. See [boot and administration](architecture/boot-and-admin.md).

## Provider configuration

S3-compatible services need endpoint, region, bucket/prefix and scoped access keys. WebDAV needs a vetted HTTPS host/root and app credentials. ALLOWED_CONNECTOR_HOSTS is an operator allowlist, not a user-supplied permission bypass. Google Drive, Dropbox and OneDrive require your own OAuth applications, exact redirect configuration, consent scopes and live provider conformance before enabling UI capability flags.

Hosted 3sln.me mail uses the Cloudflare `EMAIL` send binding; see [email deployment](deployment/email.md) for sender restrictions and domain onboarding. Self-hosted Workers use their own sender domain and binding allowlist. Node embedders can inject a reviewed delivery resource with `createNodeServer({mailer})`; it provides `sendVerification` for email association and `sendSetupCode({email,code,issuer,locale})` for new-account email verification; no mail transport is enabled by default. Mail needs a configured, verified sending provider and explicit account/channel preferences. Push setup needs PUSH_ENABLED=true and matching VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY. The public key is safe in deployment vars; the private key is a secret. The browser must acknowledge the encrypted setup notification before push can satisfy activation. Configure at least one working setup delivery channel before opening contact-required signup; public capability flags report which setup transports are available. Private credentials are operator resources and are never included in browser assets; the VAPID public key is deliberately exposed through public configuration. A populated secret is not proof a feature is operational. Configured and release-verified states must remain distinct.

## Operations and limits

Run `npm test`, `npm run test:worker` and browser checks. The Node adapter currently supports a single process with in-process serialization; multi-process instances require a shared linearizable repository and distributed gates. Worker auth uses a fixed, versioned 64-bucket identity layout for each account/handle/email/device lookup family. The template declares a fresh namespace; existing deployments need an audited offline identity migration before selecting this layout. Ordinary authentication avoids the global directory. Load/cost verification remains a release gate. See [identity sharding](architecture/identity-sharding.md). Account deletion and rich archive rendering are not complete. Both runtimes share these limitations.

The origin hosts user data and signing authority. Provider custody sees plaintext data; no end-to-end encryption is claimed. Treat contact links as secrets, redact signed query fields from proxy/request logs, and never index them. Follow docs/spec/security.md and independent reviews before public deployment.
