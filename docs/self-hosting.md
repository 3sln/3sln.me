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

Boot exists to create administrators. It mints claim tokens for reserved handles, possibly granting the built-in `admin` role, and decides which roles, capabilities and badges are internal-only or available to ordinary users. Administrators can then reserve handles, mint claim tokens for non-administrator roles, look up users, and assign roles and badges within those classes. Only boot creates or revokes administrators. Every action needs a fresh step-up and is recorded in an append-only, hash-chained audit log. Administration is mounted on Node only once boot is configured, or when `ADMIN_ENABLED=true` keeps it on. See [boot and administration](architecture/boot-and-admin.md).

## Provider configuration

S3-compatible services need endpoint, region, bucket/prefix and scoped access keys. WebDAV needs a vetted HTTPS host/root and app credentials. ALLOWED_CONNECTOR_HOSTS is an operator allowlist, not a user-supplied permission bypass. Google Drive, Dropbox and OneDrive require your own OAuth applications, exact redirect configuration, consent scopes and live provider conformance before enabling UI capability flags.

Hosted 3sln.me mail uses the Cloudflare `EMAIL` send binding; see [email deployment](deployment/email.md) for sender restrictions and domain onboarding. Self-hosted Workers use their own sender domain and binding allowlist. Node embedders can inject a reviewed delivery resource with `createNodeServer({mailer})`; it provides `sendVerification` for email association and `sendSetupCode({email,code,issuer,locale})` for new-account email verification; no mail transport is enabled by default. Mail needs a configured, verified sending provider and explicit account/channel preferences. Push setup needs PUSH_ENABLED=true and matching VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY. The public key is safe in deployment vars; the private key is a secret. The browser must acknowledge the encrypted setup notification before push can satisfy activation. Configure at least one working setup delivery channel before opening contact-required signup; public capability flags report which setup transports are available. Private credentials are operator resources and are never included in browser assets; the VAPID public key is deliberately exposed through public configuration. A populated secret is not proof a feature is operational. Configured and release-verified states must remain distinct.

## Operations and limits

Run `npm test`, `npm run test:worker` and browser checks. The Node adapter currently supports a single process with in-process serialization; multi-process instances require a shared linearizable repository and distributed gates. Worker auth uses a fixed, versioned 64-bucket identity layout for each account/handle/email/device lookup family. The template declares a fresh namespace; existing deployments need an audited offline identity migration before selecting this layout. Ordinary authentication avoids the global directory. Load/cost verification remains a release gate. See [identity sharding](architecture/identity-sharding.md). Account deletion and rich archive rendering are not complete. Both runtimes share these limitations.

The origin hosts user data and signing authority. Provider custody sees plaintext data; no end-to-end encryption is claimed. Treat contact links as secrets, redact signed query fields from proxy/request logs, and never index them. Follow docs/spec/security.md and independent reviews before public deployment.

## Configuration reference

Every setting the code reads. "Hosted" is the value in this repository's `wrangler.jsonc`, which is the 3sln.me production template, not a recommendation. "Node" is the default of `apps/node/server.mjs`, which reads only the variables it forwards (marked N); settings without N are Worker-only or are injected ports. Booleans are the strings `"true"`/`"false"`. Features marked **off** are disabled until you opt in; none is production-verified by being enabled.

### Core and signup

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` (N) | none; Node: derived from its listen origin | Exact HTTPS origin. Required in production. |
| `RP_ID` (N) | hostname of `APP_ORIGIN` | WebAuthn relying party ID. |
| `BRAND_NAME` | Node: Personal Space; hosted: 3sln.me | Display and email-subject brand. |
| `LOCAL_DEVELOPMENT` | `false` | Allows test CAPTCHA and loopback origins. Never set in production. |
| `RELEASE_READY` | `false` | Production release gate. Leave `false`. |
| `TERMS_VERSION` (N) | `2026-10-11` | Terms version a user must accept. |
| `KEY_ENCRYPTION_KEY` (N) | Node: generated in `.data/encryption-key`; Worker: required secret | Encrypts connector and signing records; also the fallback for `ABUSE_HASH_KEY`, `DPOP_NONCE_KEY`. |
| `ABUSE_HASH_KEY` | `KEY_ENCRYPTION_KEY` | Secret for hashing network identifiers in rate limits. |
| `SESSION_COOKIE_KEY` (N) | unset | 43-character base64url secret; enables account session cookies. |
| `RECOVERY_SIGNING_KEY` | unset | JSON signing key for identity backups and system bootstrap. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (N) | empty | Cloudflare Turnstile. The secret is a secret. |
| `SIGNUP_ENABLED` (N) | Node: `false` when not local; hosted: `true` | Public account creation. |
| `SIGNUP_CONTACT_REQUIRED` (N) | Node: `false`; hosted: `true` | Verified email or acknowledged push before activation. |
| `PAID_SIGNUP_ENABLED`, `WAITLIST_ENABLED`, `WAITLIST_ALLOW_OPEN` (N) | hosted `true`, `true`, unset | Paid signup lane, waitlist, and whether it may stay open. |
| `SIGNUP_MAX_ADMISSIONS`, `SIGNUP_FREE_MAX_ADMISSIONS` (N) | hosted `100000`, `10000` | Overall and free admission caps. |
| `SIGNUP_IP_WINDOW_MS`, `SIGNUP_IP_DAILY_LIMIT`, `SIGNUP_SUBNET_DAILY_LIMIT`, `SIGNUP_REGION_HOURLY_LIMIT`, `SIGNUP_REGION_DAILY_LIMIT`, `SIGNUP_GLOBAL_HOURLY_LIMIT`, `SIGNUP_GLOBAL_DAILY_LIMIT` | hosted 3 h, 2, 15, 5, 25, 10, 200 | Free-signup abuse limits. |
| `SIGNUP_PAID_HOURLY_LIMIT`, `SIGNUP_PAID_DAILY_LIMIT` (N) | `5`, `25` | Paid-signup abuse limits. |
| `SIGNUP_STATUS_CACHE_KEY` | injected | Signup capacity cache port; not a setting. |
| `IDENTITY_LAYOUT` | hosted `v1-64-fresh` | Identity shard layout; see Operations. Never change on an existing deployment. |
| `ALLOWED_CONNECTOR_HOSTS` (N) | empty | Operator allowlist for external storage hosts. |
| `FORM_POSTBACK_ORIGINS` (N) | `[]` | JSON allowlist of message-form postback origins. |
| `MESSAGE_RECEIPT_LIMITS` | built-in per-plan defaults | JSON per-plan receipt budgets; invalid values refuse to start. |
| `MESSAGE_FORMS_OUTPUT`, `PUBLIC_DOCS_OUTPUT` | build-time | Output directory overrides for build scripts. |

### Roadmap feature flags

These reserved switches default to `"false"` in both Worker configurations and Node. Node forwards environment values and permits explicit `createNodeServer({config})` overrides. Wave 0 only wires configuration; setting a switch does not implement a feature, mount routes or establish production readiness. Later slices must gate their declarations and behavior on these flags.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXTENSIONS_ENABLED` (N) | `false` (off) | Slots and extension declarations. |
| `INTEGRATIONS_ENABLED` (N) | `false` (off) | Integration manifests and connection lifecycle. |
| `BROKERING_ENABLED` (N) | `false` (off) | Brokered resource discovery, credentials and severance. |
| `DEVICE_AUTHORIZATION_ENABLED` (N) | `false` (off) | App device authorization grant; separate from existing owner device sign-in. |
| `ACTIVITY_V2_ENABLED` (N) | `false` (off) | Activity center v2. |
| `BINDLEBOX_ENABLED` (N) | `false` (off) | BindleBox extraction and app cutover. |

### Onboarding, administration and identities

| Variable | Default | Purpose |
| --- | --- | --- |
| `ONBOARDING_ENABLED`, `ONBOARDING_KEY`, `ONBOARDING_NAMES` (N) | off | Private onboarding lane (above). |
| `HOST_NAME_POLICY`, `BADGE_DEFINITIONS` (N) | built-in | Reserved/onboardable names and local badge sprite. |
| `BOOTSTRAP_TOKEN_SHA256`, `BOOT_ACCESS_HOURS` (N) | unset, `24` | Boot digest and access window. |
| `ADMIN_ENABLED` (N) | Node: on only when boot is configured | Keeps the administration console mounted. |
| `ADMIN_CLAIMS_ENABLED` | off | Shows claim-token onboarding when admin-minted claims exist, even without `ONBOARDING_ENABLED`. |
| `SYSTEM_BOOTSTRAP_KEY` (N) | unset | Verifies system-identity invitations; also needs `RECOVERY_SIGNING_KEY` and a working setup channel. |
| `DEVELOPER_CONTACT_HANDLE` | `ray` | Local handle the developer-contact link delivers to. Reference-service feature. |
| `DEVELOPER_CONTACT_ACTIVE_THRESHOLD` | `1500` | Active-owner count at or above which free owners lose developer contact. |
| `DEVELOPER_CONTACT_POLICY` | built-in `.example` URI | Policy URI embedded in the developer-contact link. |
| `CONVERSATION_PEER_ORIGINS` (N) | empty | Comma-separated origins allowed for conversation peers. |

### Federation, embedding and app metadata

| Variable | Default | Purpose |
| --- | --- | --- |
| `FEDERATION_ENABLED` (N) | `false` (off) | Runtime Bindle OAuth/RPC provider. |
| `FEDERATION_CLIENTS`, `FEDERATION_SCHEMAS` (N) | `[]`, `{}` | Registered clients and immutable fragment schemas. |
| `FEDERATION_REFRESH_ENABLED` (N) | `true` | `false` removes the refresh grant. |
| `FEDERATION_ENTRY_ENABLED` (N) | off | Authorization-entry (`?entry=`) flow; also requires `EMBED_ORIGIN`. Off pending sign-off. |
| `CLIENT_METADATA_ENABLED` (N) | `false` (off) | Declares `client-id-metadata.v1`; needs an egress port. |
| `EMBED_ORIGIN` (N) | unset | Separate origin serving sign-in islands. |
| `EMBED_AVATAR_ORIGINS` | empty | Worker allowlist of extra HTTPS origins for island avatars. |
| `DPOP_NONCE_KEY` (N) | `KEY_ENCRYPTION_KEY` | Secret for DPoP nonces. |
| `APP_METADATA_DISCOVERY_ENABLED` (N) | `false` (off) | Fetch app metadata documents from registered client origins. |
| `APP_NOTIFICATION_SIGNING_JWK`, `APP_NOTIFICATION_PUBLIC_JWKS` (N) | unset | Signing key (secret) and published verification keys for app notifications. |
| `MCP_ENABLED`, `MCP_LAYOUT`, `MCP_CLIENTS` (N) | `false` (off), `mcp-auth-v1-64`, `[]` | Agent endpoint. |

### Mail, push and providers

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIL_ENABLED`, `MAIL_SENDER_DOMAIN` | hosted `true`, `sys.3sln.me` | Cloudflare `EMAIL` binding sender; see [email](deployment/email.md). |
| `EMAIL_AVAILABLE`, `EMAIL_SETUP_AVAILABLE`, `PUSH_AVAILABLE`, `WAITLIST_MAIL_AVAILABLE` | computed | Capability flags derived from injected resources; not settings. |
| `PUSH_ENABLED`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (N) | `false` (Node); subject defaults to `APP_ORIGIN` | Web push. The private key is a secret. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (N) | empty | Your own Google OAuth app; see [Google Drive](deployment/google-drive.md). |
| `BILLING_ENABLED` (N) | Node: `false`; hosted: `true` | Polar billing; see [billing](deployment/billing.md). |
| `POLAR_SERVER`, `POLAR_CATALOG_MODE`, `POLAR_METADATA_PREFIX`, `POLAR_ORGANIZATION_ID`, `POLAR_PRODUCT_ID_PAID`, `POLAR_PRODUCT_ID_PLUS`, `POLAR_PRODUCT_ID_ULTRA` (N) | Node: `sandbox`, `static`, `3sln_me_`, empty | Polar configuration. |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` (N) | empty | Polar secrets. |
| `BEAM_ENABLED`, `BEAM_STUN_ENABLED`, `BEAM_TURN_ENABLED`, `BEAM_MONTHLY_DELIVERY_BYTES`, `BEAM_MONTHLY_OFFERS` (N) | Node: off, on, off, 1 GB, 20 | File transfers; see [beaming](deployment/beaming.md). |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` (N) | empty | TURN relay credentials (the token is a secret). |

### Budgets, search and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORK_LIMITS_ENABLED` (N) | `true` | Monthly work budgets. |
| `SERVICE_`, `FREE_`, `PLUS_`, `PRO_MONTHLY_WORK_LIMIT` | 250000, 1000, 5000, 10000 | Work limits per scope or plan. |
| `STORAGE_WRITE_ENABLED` (N) | `true` | Storage write budgets. |
| `STORAGE_WRITE_SERVICE_MONTHLY_LIMIT`, `_FREE_PER_HOUR`, `_FREE_PER_DAY`, `_PAID_PER_HOUR`, `_PAID_PER_DAY`, `_OWNER_PER_MINUTE`, `_APP_PER_MINUTE`, `_MAINTENANCE_MONTHLY_LIMIT`, `_MAINTENANCE_PERCENT` (N) | hosted 10000000, 500, 1000, 2000, 10000, 240, 120, 16, 10 | Write limits (each prefixed `STORAGE_WRITE`). |
| `SEMANTIC_SEARCH_ENABLED`, `SEMANTIC_EMBEDDING_MODEL`, `SEMANTIC_GLOBAL_MONTHLY_MICRO_USD`, `SEMANTIC_GLOBAL_DAILY_MICRO_USD`, `SEMANTIC_GLOBAL_MAX_OWNERS`, `SEMANTIC_GLOBAL_MAX_UPSERTS` | Worker only; hosted on | Workers AI and Vectorize search and its spend caps. |
| `LIFECYCLE_ENABLED` (N) | `false` (off) | Account lifecycle runner. |
| `LIFECYCLE_DRY_RUN` (N) | `true` | Dry run arms clocks but sends and changes nothing. Set `false` only to go live. |
| `LIFECYCLE_PURGE_ENABLED` (N) | `false` (off) | Irreversible purge; also needs live mode and a fresh Polar ever-paid check. |
| `LIFECYCLE_COLD_STORAGE`, `LIFECYCLE_COLD_MIN_BYTES` | hosted `true`, 4194304 | Move large objects to Infrequent Access (live mode only). |
| `LIFECYCLE_FINANCE_REVIEW` (N) | hosted `polar` | `local-only` skips the Polar check and blocks purge. |
| `LIFECYCLE_SWEEP_BATCH`, `LIFECYCLE_SWEEP_TIME_MS`, `LIFECYCLE_SWEEP_CONTINUE_MS`, `LIFECYCLE_COLD_BATCH`, `LIFECYCLE_PURGE_BATCH` (N for sweep and purge) | 200, 25000, 900000, 16, 64 | Sweep and batch bounds. |

### Bindings and injected ports (not variables)

Worker bindings: `ACCOUNTS`, `IDENTITIES`, `ABUSE`, `FEDERATION`, `MCP_AUTH`, `LIFECYCLE_SCHEDULER`, `BLOBS`, `ARCHIVES`, `ASSETS`, `AI`, `SEARCH_VECTORS_0..3`, `EMAIL`, `PLAN_CATALOG`, `SEMANTIC_BUDGET`. Internal ports supplied by adapters and tests, never configured by operators: `ADMIN_AUTHORITY`, `ADMIN_SERVICE`, `FEDERATION_AUTHORITY`, `MCP_AUTHORITY`, `STORAGE_WRITE_AUTHORITY`, `WORK_AUTHORITY`, `IDENTITY_REPOSITORY`, `IDENTITY_ENGINE`, `IDENTITY_ACCOUNT`, `BILLING_CATALOG`, `DEVELOPER_CONTACT_POPULATION`, `ACTIVE_POPULATION_CENSUS`, `E2E_AUTHORIZATION_ENTRIES`, `CONVERSATION_*`, `FORM_POSTBACK_TRANSPORT`, `*_FETCH` and `LIFECYCLE_*` collaborators. `PORT` sets the Node listen port (default from `APP_ORIGIN`, else 8788) and also the demo's; and `PROBE_KEY` only by `scripts/verify-semantic-provider.mjs`.
