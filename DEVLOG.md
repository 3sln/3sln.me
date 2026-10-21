# Development log

## Working agreement

This log is the project ledger for decisions, implementation, evidence, and pending work. Major choices remain provisional until a human signs below; unsigned entries do not automatically block reversible work. Production authentication, migrations, deployment, and externally consequential changes require their implementation gates to be satisfied. Every agent must report changes here through the coordinator.

## 2026-10-11 — Bootstrap and first vertical slice

Initial workspace was empty and had no Git repository. Coordinator delegated independent protocol/contracts, authentication/security, and frontend/SDK work; coordinator owns the reference resource engine, HTTP adapter, integration verification, and this ledger. Agents use the inherited model and reasoning configuration; no model override was available under the current delegation instructions.

### Decision register

| ID | Decision and rationale | Status / human sign-off |
| --- | --- | --- |
| D001 | Use **Bindle** as provisional protocol name and `/.well-known/bindle/manifest.json`, matching the supplied path. The brief also says Bridle; settle spelling before public release. | Provisional. Reviewer: ___ Date: ___ Outcome: ___ |
| D002 | Discover a manifest at `https://host/.well-known/bindle/manifest.json`; send the handle separately as a login hint. `https://user@host` denotes URL userinfo, not a user-specific host resource. Stable subject URLs are distinct from mutable email/login handles. | Recommended. Reviewer: ___ Date: ___ Outcome: ___ |
| D003 | Build on OAuth authorization code + S256 PKCE, with exact registered redirects and issuer binding, rather than inventing an authentication protocol. Redirect login is the v0 baseline; embedded login remains deferred pending a secure browser flow. | Recommended; production gate. Reviewer: ___ Date: ___ Outcome: ___ |
| D004 | Email fallback occurs only after definitive absent discovery (404/410) and explicit user choice. Network/TLS/server failures must not silently change identity provider. Verified email association never silently merges accounts. | Recommended. Reviewer: ___ Date: ___ Outcome: ___ |
| D005 | Fragment/contract definitions are immutable, versioned HTTPS URLs. Public metadata describes fields; personal preference values remain private. Apps explicitly request contract methods and users see the exact resource selection. | Recommended. Reviewer: ___ Date: ___ Outcome: ___ |
| D006 | Effective resource authorization intersects the approved resource set with current preference assignments, supported contracts, method allowlist, live grant, and expiry. New assignments need renewed consent; removals revoke effective access immediately. | Implemented in local engine. Reviewer: ___ Date: ___ Outcome: ___ |
| D007 | Sync writes require optimistic concurrency; transaction IDs deduplicate identical requests and reject different payloads under the same ID. Replays still require live authorization. | Implemented in local engine; durable deduplication pending. Reviewer: ___ Date: ___ Outcome: ___ |
| D008 | Use **entity** for the authority owning data, with individuals first and organizations later; subject denotes its token identity. Organizational delegation must have explicit membership/roles and no implicit graph inheritance. | Provisional. Reviewer: ___ Date: ___ Outcome: ___ |
| D009 | Start with profile, preferences, resource discovery, and object storage; design separate contracts for files/collections and events. Implement one hosted storage backend before Google Drive/WebDAV/S3 adapters. Avoid claiming all providers have identical guarantees. | Recommended. Reviewer: ___ Date: ___ Outcome: ___ |
| D010 | Provide an offline runnable, loopback-only, in-memory prototype first. It is not an identity provider and has no real email delivery, passkey verification, or provider credentials. Production services will reuse the authorization semantics behind authenticated owner sessions. | Current implementation boundary. Reviewer: ___ Date: ___ Outcome: ___ |
| D011 | Integrate actual local 3sln dodo/ngin source with license/provenance, because external DNS/source retrieval failed. Do not guess stack APIs or install unverified replacements. | Implemented. Reviewer: ___ Date: ___ Outcome: ___ |
| D012 | Hosted v0 trusts the operator with plaintext data and encrypted-at-rest connector secrets. Self-hostability is not end-to-end encryption or portable domain identity; user-only encryption and provider migration need separate designs. | Explicit custody boundary. Reviewer: ___ Date: ___ Outcome: ___ |
| D013 | Use issuer-side resource gateway only, static registered clients, five-minute tokens, and mandatory live grant checks in v0. Remote resource delegation and iframe authentication require separate trust profiles. | Recommended. Reviewer: ___ Date: ___ Outcome: ___ |

### Completed work

- Reference authorization engine: resource ownership, explicit consent, resource/method-scoped grants, live revocation, expiry, current preference intersection, transaction replay, and optimistic storage writes.
- HTTP demo adapter: loopback binding, Host/Origin checks, JSON/body limits, same-origin static content policy, fixture consent/preferences/revocation and RPC routes. It intentionally publishes no authentication/discovery manifest.
- Five initial engine tests passed, covering authorization and sync boundaries rather than implementation snapshots.
- Protocol/contracts/auth/security drafts now exist in `docs/spec/`, with primary standards references and detailed email-link/recovery edge cases.
- Real dodo/ngin source snapshots are vendored with original MIT licenses and commit provenance. SDK discovery and custom login element plus stack-based consent/account UI are implemented.
- `docs/implementation.md` records prototype/spec differences explicitly; `AGENTS.md` preserves coordination and review expectations for future work.

### Integration verification

The initial HTTP test could not bind `127.0.0.1` because the sandbox returned `EPERM`. It was adapted to invoke the actual HTTP request callback with readable request streams and response doubles, exercising routing, Host/Origin controls, JSON validation, consent and RPC without a listening socket. This is useful adapter verification but does not establish real network/browser behavior. The runnable server remains available for use outside that sandbox.

Current automated suite passes core authorization/sync, HTTP adapter, and SDK discovery tests. Frontend DOM integration and malformed-manifest hardening are being completed; final results will be appended below. No claim of production conformance or completed identity service is made.

Final coordinator review found and fixed an authorization edge case: removing then restoring a preference resource could revive an old approval. Removing an assignment now permanently narrows existing grants; restoration requires renewed consent. The regression test covers this alongside new-resource expansion. Demo token lifetimes now match the draft five-minute ceiling. SDK metadata checks now reject version/issuer mismatches and delegated endpoints and bound response size/time.

Frontend DOM smoke passed real dodo/ngin rendering, empty-selection/unacknowledged-consent rejection, grant/revoke updates, and default/custom-host login behavior. This used an already installed local happy-dom, without dependency installation. The local dodo checkout's 0.0.9 API did not support current stack composition; the frontend agent corrected the vendor snapshot to the published 0.1.0 package already present in a sibling project. Provenance records that source accurately.

The current consent screen demonstrates one resource fragment, with a separate storage configuration action and optional decline even with no assigned storage. Configuration does not grant app access. The final DOM smoke additionally checks removal makes the request resource unavailable and that decline works without setup. It does **not** yet implement a general schema renderer, required-fragment setup wizard, atomic fields, or multi-fragment requests. These are mandatory next UX work; real-browser/accessibility and human usability validation remain pending.

Final checks: `npm test` passed **10 tests**; portable `npm run test:dom` passed using the already installed happy-dom via `BINDLE_DOM_MODULE_URL`. The repo declares the exact happy-dom development version for normal installation; no dependency installation was performed in this restricted session. DOM smoke files are preserved in `tests/browser/`. Prototype remains runnable via `npm run dev` on a host allowing loopback sockets. Production work is outstanding as detailed below and in `docs/implementation.md`.

### Pending milestones and completion gates

1. **Spec review and local demonstration:** finish protocol/auth/contracts/security drafts; demonstrate optional decline before configuration, explicit resource/method consent, existing app visibility, revocation, and login-handle behavior. Add realistic usability sessions with first-time users and accessibility/browser checks. Automated unit tests do not establish intuitive UX.
2. **Production identity service:** durable transactional account/email/session store; mail delivery and rate limits; opaque single-use token hashing; scanner-safe magic-link GET; explicit cross-account outcomes; WebAuthn registration/assertion verification, recovery and credential management; audit events. Test concurrency and takeover attempts.
3. **Federated relying-party flow:** registered clients/redirects, authorization transactions, code exchange, PKCE/state/issuer validation, token audience binding, expiration/revocation, safe discovery, and conformance tests with an independently hosted provider. Do not advertise interoperability before this passes.
4. **Persistent storage:** durable grants/preferences/deduplication; isolated app namespaces, quotas, data export/deletion, conditional writes; hosted storage adapter and two-device sync conflict tests. Current demo has account-wide selected-bucket access and no app namespace.
5. **Provider integrations:** Google Drive OAuth scopes/refresh handling, S3 signing/credential isolation, WebDAV capability checks; SSRF defenses and backend-specific consistency tests. Credentials stay provider-side. Provider contract declarations require tested behavior.
6. **Organization subjects:** memberships, scoped delegation, administrator consent, resource ownership transfer/recovery; explicit authorization design before implementation.
7. **Release:** choose protocol name and canonical domain, licensing for first-party code, dependency/version policy, security review, operational backups/restore, and deployment destination. Human approval records remain blank until actually signed.

### Evidence and limits

Node v24.6.0 is available. Initial external shell requests to stack.3sln.com and raw.githubusercontent.com failed DNS; browser access to the requested stack URLs failed. Local sibling projects provide stack source evidence. No secrets were fetched and no remote service was modified. Memory-only fixtures reset on restart. Public identifiers under `*.example` are examples and are not published contracts.

## 2026-10-11/12 — Release expansion: identity, contact capabilities, messaging, Workers

User expanded the actual-release scope to contact tokens, blob messaging, notifications, PWA, recovery, abuse defenses, cold storage, real provider integrations and Cloudflare deployment. User requested a dedicated UI red-team agent and a final screenshot walkthrough.

Coordinator delegated deep identity implementation/security review, contact/messaging/notification design and implementation, stack-based release UI, and dedicated adversarial browser work. Heavy messaging/security decisions use GPT-6 Astra with high reasoning; identity/UI engineering uses GPT-6.1 Sol with high reasoning, under the user's request for appropriate intelligence. Coordinator implements Worker bindings, storage integration, infrastructure and release workflow.

### Additional decision register

| ID | Decision / consequence | Human review |
| --- | --- | --- |
| D014 | Contact URLs use `/users/{handle}/message#token=...`, never HTTP URI userinfo. Fragment keeps the bearer out of server URL logs and referrers; API uses Authorization. GET never delivers a message or consumes a token. | Reviewer: ___ Date: ___ Outcome: ___ |
| D015 | Contact tokens are ES256/Ed25519 JWS signed by an entity-specific key and bound to exact live registered grants, collection/MIME/expiry/count/byte limits. Signatures alone do not bypass revocation or quotas. Hosted v0 signing keys are server-custodied and encrypted; user-controlled signing-key portability remains additional work. | Reviewer: ___ Date: ___ Outcome: ___ |
| D016 | Use collections for message grouping, with read status, owner moves/tags/classification, sticky quarantine and bounded declarative rules. Human content and automation blobs share transport but not automatic rendering. | Reviewer: ___ Date: ___ Outcome: ___ |
| D017 | Start with bounded JSON web archives containing HTML/assets; no filesystem extraction, recursive archives or remote fetches. Current renderer reconstructs inert structural HTML and strips all media/style; rich safe asset/data-URL rendering remains release work. | Reviewer: ___ Date: ___ Outcome: ___ |
| D018 | Notifications use transactional outbox and leased delivery; check current unread/quarantine/preferences again immediately before transport. Generic push text by default. Email requires verified destination and consent; unsubscribing invalidates already leased deliveries. | Reviewer: ___ Date: ___ Outcome: ___ |
| D019 | Free account activation requires terms, server-verified Turnstile, passkey or strong optional password, and downloaded recovery-file proof/ack. Recovery secrets/sessions are hashed, single use, and never persisted in browser storage. Pending setup token may live in sessionStorage for same-tab resume. | Reviewer: ___ Date: ___ Outcome: ___ |
| D020 | Cloudflare adapters use sqlite Durable Objects for identity/CAS, abuse windows and account metadata; R2 for message blobs and cold metadata snapshots. Services use ngin actions/queries plus injected runtime resources. No public demo mutation routes on Worker. | Reviewer: ___ Date: ___ Outcome: ___ |
| D021 | Initial identity directory is a serialized global registry for atomic handle/email claims, with bounded account envelopes; scaling/sharding and benchmarking are required before claiming low-cost high-scale readiness. | Reviewer: ___ Date: ___ Outcome: ___ |
| D022 | Seven-day cold-cache eviction is non-destructive and separate from user-requested inactivity/deletion schedules. Automatic permanent deletion remains disabled until notification, grace, activity and backup removal invariants are implemented; requested 2-day/7-day new-account and 1-year age-scaled policies are still release work. | Reviewer: ___ Date: ___ Outcome: ___ |
| D023 | Object storage descriptor publication authority is `https://3sln.me/artefacts/contracts/object-storage/v1`; negotiate read/write/list/range/presign capabilities rather than falsely claiming every backend's conditional writes. Presigned read URLs can remain usable until expiry after revocation; explicit separate permission needed. | Reviewer: ___ Date: ___ Outcome: ___ |
| D024 | Manual publish workflow with tests, dependency audit, real Wrangler/browser tests and machine-recorded release gates. Main pushes run CI; do not publish. | Reviewer: ___ Date: ___ Outcome: ___ |

### Implementation and environment evidence

- Real maintained SimpleWebAuthn verification, Argon2id policy, session/CSRF, mandatory recovery, email proof/link/login services are implemented with injected resources. Mail transport remains unconfigured.
- Contact signing/verification, live quotas/revocation, collection/message/read/move/tag/rules/quarantine, inert HTML/archive validation, notification preferences/leases/unsubscribe are implemented and tested.
- Worker adapter and `wrangler.jsonc` target 3sln.me with Durable Objects/R2 bindings; separate `wrangler.local.jsonc` explicitly enables test CAPTCHA behavior only locally. Production `RELEASE_READY=false` prevents public signup.
- `.mcp.json` configures pinned Chrome DevTools MCP with isolated headless Chrome and telemetry disabled. Installed browser tooling and real local Chrome work. Wrangler local execution is running on localhost:8787.
- Storia's manual publish/browser-gating workflow reviewed; corresponding gated workflow prepared.
- Dependency audit caught vulnerable original happy-dom test dependency. Updated to21.0.1; installation audit then reported zero vulnerabilities.
- Actual Worker passkey signup+verification reaches recovery. Real browser found auth DOM input-reuse failure; frontend agent correcting keyed/remounted fields. Password signup exposed Workers' prohibition on dynamic WASM compilation; platform adapter being corrected to statically imported Argon2 module. These findings prevent release claims.
- Security cross-review found archive race, non-atomic deletion/marker, missing method allowlists, JSON primitive handling, abuse alarm race and blob compensation gaps. Fixes and adapter tests in progress; see `docs/release/ui-redteam.md` and release gate file.

### Release state

`release-status.json` is intentionally false. Public provider keys, CAPTCHA production configuration, Cloudflare bot/WAF policy, mail/push transport verification, provider conformance, rich archive rendering, complete federated OAuth/preferences and account-lifecycle delivery/deletion gates remain unresolved. A polished screen is not evidence these features work. Screenshot walkthrough will present actual verified local behavior and these boundaries.

## 2026-10-12 — Cloudflare hosted email resource

User requested Cloudflare-native hosted email and dedicated verify/login/notify/accounts/security sender addresses. Replaced the unused Resend implementation with the structured Cloudflare Email Sending beta binding in `apps/worker/email.mjs`; `transports.mjs` re-exports it without changing the portable injectable identity/notification delivery interfaces. Isolating mail from the Node web-push imports preserves Worker test bundling.

| Decision | Consequence | Human review |
| --- | --- | --- |
| Hosted email policy (provisional) | Bind `EMAIL` with exactly five `allowed_sender_addresses`; `MAIL_ENABLED="false"` by default. Require explicit enablement, binding and canonical HTTPS origin. Provider acknowledgement is not idempotency or exactly-once delivery. | Reviewer: ___ Date: ___ Outcome: ___ |

Coordinator wired the resource into Worker identity mailer and exposes email availability only when configuration admits a transport. Association uses the actual identity `purpose='link'` and `/email/confirm` route; login uses `purpose='login'` and `/email/login`. Links retain fragment tokens, ten-minute expiry and explicit confirmation. Association additionally reminds users to confirm in their requesting browser session. Invalid recipients, control characters, substituted origins and unsupported purposes fail before binding calls; provider errors are replaced with a generic message and an allowlisted code, with no adapter logs or raw secret-bearing errors.

Unread reminders contain only generic text and manual fragment unsubscribe, with allowed `List-Unsubscribe` and no RFC8058 one-click claim. Finite account and security notice templates reserve their requested sender roles, but the hosted reminder dispatcher, lifecycle jobs and security event callers remain unconnected. Templates are currently English; locale selection/catalogue integration remain outstanding. Lifecycle deletion gates are unchanged. Stable retry payloads cannot prevent duplicate external sends after an ambiguous acknowledgement because the documented binding has no idempotency argument.

Verification: all eight new Cloudflare binding tests passed; `npm test` passed **109 tests**. Production Wrangler dry run succeeded and listed `EMAIL` with all five permitted senders and `MAIL_ENABLED="false"`; its first invocation reported an unwritable external log path, so a second dry run redirected logs into `.output/wrangler-email.log` and completed cleanly. Mock and bundle results do not establish deliverability.

[Email deployment instructions](docs/deployment/email.md) link official Workers API, binding restrictions, header policy and onboarding documentation. Email Sending domain onboarding supports the intended transactional-user mail; verified-destination-only Email Routing capability cannot establish public signup readiness. End-to-end delivery, suppression/bounce operations, template localization and release sign-off remain provisional.

## 2026-10-11 — Encrypted recovery-file design

User requested a recovery file encrypted under a key derived from all selected typed personal-information answers, with readable questions and optional hints. [Recovery-file v1 proposal](docs/spec/recovery-file.md) records the exact envelope, authenticated header, combined-answer encoding, normalization rules, browser/service boundary, and required evidence. This is a provisional design, not completed implementation or security approval.

| ID | Decision / consequence | Human review |
| --- | --- | --- |
| D025 | Encrypt the existing independently random recovery credential locally with one key derived from every selected answer; no signing keys or account credentials are derived from PII. Offer an additional private passphrase. Public questions/hints and offline guessing are explained explicitly. | Reviewer: ___ Date: ___ Outcome: ___ |
| D026 | Versioned bounded envelope: fixed Argon2id v19, 64 MiB, three iterations, one lane, random 16-byte salt; AES-256-GCM with independent random 12-byte IV and authenticated question/type/hint/profile metadata. Reject unknown/downgraded algorithms and oversized work before derivation; no weaker fallback. | Reviewer: ___ Date: ___ Outcome: ___ |
| D027 | Typed normalization preserves numeric leading zeros, explicit international phone country code, Gregorian year-first dates, and all selected answers. Text uses explicit whitespace rules and locale-independent lowercasing; exact NFC passphrases are separate. This does not claim full Unicode casefold or universal Unicode-version independence; conformance vectors and supported Unicode repertoire remain release evidence. | Reviewer: ___ Date: ___ Outcome: ___ |
| D028 | Keep answer processing in private browser state and preferably fresh recovery documents that never loaded third-party scripts; use a terminating first-party Argon2 worker and narrowly scoped WASM CSP permission. Same-document CAPTCHA scripts otherwise remain trusted with answers. Preserve existing random-token proof, pending-account confirmation and resumable recovery semantics. | Reviewer: ___ Date: ___ Outcome: ___ |

Design review examined the existing identity `downloadRecovery`, `confirmRecovery`, and `recover` methods, their replay/resume tests, browser asset build, and installed hash-wasm argument types. Primary references are linked in the proposal. Design-only work ran no implementation tests. Coordinator and implementation agents must reconcile any final module/schema/normalization differences here and in the proposal before reporting completion. Human sign-offs remain blank.

## 2026-10-11 — Portable runtime, device management, portal contributions and verified encrypted recovery

Current implementation supersedes the earlier prototype evidence above. The production release remains disabled; the following is verified local work, not a production sign-off.

| ID | Decision / consequence | Human review |
| --- | --- | --- |
| D029 | Hosted outbound mail uses Cloudflare `EMAIL.send`, explicitly gated by `MAIL_ENABLED`, with fixed sender roles (`verify`, `login`, `notify`, `accounts`, `security`) and a Wrangler sender allowlist. Self-hosted adapters use their operator's domain/brand. Provider acceptance is not inbox delivery or exactly-once delivery. | Reviewer: ___ Date: ___ Outcome: ___ |
| D030 | One portable Request/Response application, identity repository, account controller and abuse policy run behind Cloudflare Durable Object/R2 adapters and a single-process Node SQLite/private-files adapter. Runtime capabilities are injected; Node proxy trust and distributed operation require separate implementations. | Reviewer: ___ Date: ___ Outcome: ___ |
| D031 | Contact invitations are signed endpoint URLs, replacing the earlier token/URL duality. HTML GET provides a host composer; explicit token MIME GET mints a separate short-lived bearer; multipart POST sends a bounded blob. Live parent revocation/quarantine/scopes/quotas apply to both delivery paths. Sender annotations remain separate from owner classification. | Reviewer: ___ Date: ___ Outcome: ___ |
| D032 | Multiple passkeys and revocable device sessions share the account authority. Phone-to-TV/device sign-in uses a short-lived request, human confirmation and one-time poll-secret handoff; a QR carries an approval reference, never an owner session. | Reviewer: ___ Date: ___ Outcome: ___ |
| D033 | Portal contributions are statically installed code with deterministic manifests and capability-gated commands; UI receives pure view data. Contextual keybindings and user overrides have a bounded declarative parser. Localization uses actual MIT-licensed `@3sln/bab` source; user content is not translated. | Reviewer: ___ Date: ___ Outcome: ___ |
| D034 | All portal form values are captured into a private browser submission vault; ngin Actions receive opaque operation IDs. Recovery answers/credentials never enter Query projections, preferences, URL parameters or application logs. Fresh recovery documents load no third-party scripts; this is not a sandbox against an already compromised origin. | Reviewer: ___ Date: ___ Outcome: ___ |

### Verified behavior

- Worker and Node use maintained WebAuthn verification and Argon2id implementations. Static WASM imports address Workers' dynamic-compilation prohibition. Signup remains pending until a recovery credential is acknowledged; recent authorization and exact-origin CSRF guard credential/device changes. Interrupted recovery can resume with the original file until replacement setup is confirmed. Verified email is a contact channel until the owner explicitly opts into email login.
- Account operations and cold shelving are serialized through the same account gate. Snapshot readback/hash/owner/version validation precedes atomic metadata eviction. Message payloads are immutable private objects; metadata changes no longer read or rewrite those payloads. The retention/deletion scheduler is still incomplete and disabled.
- Static portal modules, Publications sample CRUD, bab English/Spanish catalogs, context-sensitive commands, chords and shortcut overrides are implemented. The Publications sample is opt-in code, not a publicly deployed feature.
- Encrypted recovery now has one to twelve editable/reorderable questions, typed normalization, public optional hints, a recommended private passphrase, local encryption and a mandatory answer round-trip before account activation. A hint matching its full raw or normalized answer is rejected at setup. Every answer participates; no alternate weaker key slot exists. The downloaded file has only public question metadata and ciphertext, containing the independently random server recovery credential inside.
- A dedicated terminating browser worker derives the fixed 64 MiB/three-pass Argon2id key. Recovery documents and this worker use narrowly scoped `wasm-unsafe-eval`; third-party scripts/frames are excluded. CAPTCHA runs before the fresh restore document; only its short-lived challenge is handed through tab storage, never answers or recovery credentials. The round-trip checks the in-memory encrypted envelope and does not prove a durable filesystem write.
- Cloudflare mail is wired to identity association/opt-in login but disabled by default. Reminder, lifecycle and security template resources exist; their hosted event scheduling/delivery is not yet wired. Node embedders can inject a mail resource. Email templates still need locale integration and live delivery verification.

### Evidence and remaining work

`npm test` passed 124 tests after the encrypted-core/hint changes; Worker integration passed 16 tests; portal Action/Query state checks passed 3 tests; DOM smoke passed. A fresh isolated Wrangler instance passed all 5 real Chrome suites/cases: Node/browser cryptography plus archived seven-type vector, hostile-metadata/wrong-answer/wrong-issuer privacy audit, repeated-submit/navigation cancellation, full passkey setup/assertion, and full password resume/recovery/rotation/contact delivery. CI now includes state and encrypted-browser checks. Browser runner uses a fresh temporary data store and unused port, and redacts signed invitation query material from its saved log.

Independent [recovery security audit](docs/release/recovery-security-audit.md) found no unresolved critical/high defect demonstrated in its scope. This is not a broad release certification. [Recovery-file specification](docs/spec/recovery-file.md) and archived vectors document the exact format, Unicode limitations, offline-guessing risk and implementation boundary. No answer-derived encryption can make public/guessable PII a strong secret. Low-memory mobile performance, live production CAPTCHA, real email delivery and human approval remain unverified.

Production deployment is still blocked by actual release work recorded in `release-status.json`: complete federation/preferences integration and interoperability, provider OAuth keys/flows/conformance, rich HTML/archive asset rendering, hosted push/email dispatch and localization, requested lifecycle notices/grace/deletion, production bot controls, data/record garbage collection and cost/load verification, resolved independent audit findings, and terms/privacy review. Do not enable `RELEASE_READY` based only on the local UI tests. R2 buckets are `3sln-me-blobs` and `3sln-me-account-archives`.

| D035 | First-party implementation and documentation use the repository MIT license to permit reuse/self-hosting. Upstream 3sln stack, bab and maintained cryptography sources retain their own MIT notices/provenance. Human confirmation of the release's licensing/publication policy remains unsigned. | Reviewer: ___ Date: ___ Outcome: ___ |

Final screenshot walkthrough: [standalone HTML](docs/walkthrough.html) and [Markdown](docs/walkthrough.md), with reviewed local test screenshots under `docs/walkthrough-assets/`. Recovery images contain readable public metadata and masked/empty inputs, never live answer material or credentials. Current landing, resource, notification and security screens make unavailable capabilities visible. English/Spanish recovery UI entries were added through bab catalogs; user prompts/hints stay unchanged. Narrow-phone/reorder/Spanish-restore verification passed with zero browser runtime errors. The production-config bundle dry run still succeeds with mail and release flags disabled.

Final combined browser rerun after recovery spacing/cancellation/localization changes: **6/6 passed** in a clean temporary Wrangler runtime, including question reorder/mobile/Spanish metadata preservation. The walkthrough's eleven account/recovery screenshots were refreshed from this exact run. The runner no longer streams full Worker request logs to the console and redacts signed query capabilities in the saved diagnostic log.

Final CI browser group includes the repaired signed-endpoint composer fixture and eleven UI fault cases. **17/17 passed** in a fresh isolated runtime after dialog focus/keybinding hardening and the separate notification-email capability flag. Enabling identity verification mail cannot advertise reminder delivery while its dispatcher is unwired. Walkthrough screenshots were refreshed from this final run. Human sign-offs and all production release gates remain unchanged.

## 2026-10-11 — Dedicated system-email sender subdomain

User changed the hosted sender domain to `sys.3sln.com`, reserving bare-domain addresses for potential user mail. This supersedes the earlier `@3sln.me` sender examples without rewriting their historical evidence. Hosted Wrangler now explicitly sets `MAIL_SENDER_DOMAIN="sys.3sln.com"` and permits only `verify`, `login`, `notify`, `accounts` and `security` at that domain. Self-hosted defaults remain operator-controlled; account/verification/unsubscribe links remain on the identity app origin. Setup docs now name the sending subdomain and parent DNS zone.

| D036 | Use `sys.3sln.com` for hosted system senders, keeping bare domains available for user email. Direction explicitly requested by user; configuration verification remains separate from deliverability. | Reviewer: ___ Date: ___ Outcome: ___ |

Verification: all nine focused email adapter/configuration tests passed, including host-origin links with a separate sender domain. Production Wrangler dry run passed with the five `@sys.3sln.com` senders and `MAIL_ENABLED="false"`.


## 2026-10-11 — Corrected system sender domain

User corrected the intended/onboarded sender subdomain to `sys.3sln.me`. This supersedes D036's `sys.3sln.com` address choice; historical test results above remain unchanged. Hosted sender configuration, allowlist, tests and deployment instructions now use `verify`, `login`, `notify`, `accounts` and `security` at `sys.3sln.me`. Account URLs still use `3sln.me`.



## 2026-10-11 — Shared storage plans, billing and search groundwork

User revised the free plan to **500 MB** and requested visible metering. Implemented decimal-byte plan definitions: free 500,000,000 bytes, Plus 5 GB at $5/year, Pro 100 GB at $30/year. The portal shows used, reserved and remaining space, messages/files breakdown, localized annual prices and clear over-limit behavior. Reading, exporting and deleting remain available after a downgrade; positive storage growth is refused. External provider storage does not count as hosted bytes.

| Decision | Direction and current limits | Human sign-off |
| --- | --- | --- |
| D037 | Use the requested annual plans and decimal byte limits. Pricing remains provisional: full Pro payload storage alone is approximately $18/year before billing fees, indexing, operations and support. See [scaling analysis](docs/architecture/scaling.md). | Reviewer: ___ Date: ___ Outcome: ___ |
| D038 | Enforce one account-owned quota across message payloads and hosted files. Durable reservations precede blob uploads; final metadata commits recheck entitlement and expiry. Bounded cleanup retries abandoned uploads. | Reviewer: ___ Date: ___ Outcome: ___ |
| D039 | Keep payloads in R2 and use account-local SQLite indexes for bounded inbox/file pages. Large accounts retain indexed SQLite metadata until a paged cold-archive format is implemented; the old bounded whole-account archive is not a large-account scaling solution. | Reviewer: ___ Date: ___ Outcome: ___ |
| D040 | Polar checkout never grants capacity. Authenticated, replay-protected webhook processing reconciles authoritative provider state, validates configured annual products and applies deadline-bound entitlements. Billing remains disabled with credential/product placeholders. | Reviewer: ___ Date: ___ Outcome: ___ |
| D041 | Search is a derived, owner-isolated FTS index with revisioned durable events, source authorization on every result, tag filters, bounded candidates and semantic provider ports. Query execution reads no payload blobs. Semantic provider deployment, relevance validation and broader source adapters remain pending. | Reviewer: ___ Date: ___ Outcome: ___ |
| D042 | Identity-directory sharding, paged cold metadata, production load/cost benchmarks and complete source-index erasure must precede a large-scale release claim. The current global identity directory and account deletion remain release gates. | Reviewer: ___ Date: ___ Outcome: ___ |

Independent agents reviewed architecture/economics, billing and quota behavior, search source authorization and UI failure states. Fixed post-commit HTTP errors caused by the execution-context variable, stale derived catalogs being treated as source authority, and cold-account queue processing incorrectly producing tombstones. Bounded migration now queues existing valid messages. Metadata edits enqueue work without fetching message bodies; alarms process extraction separately. Runtime mutation queues enforce free/paid queue budgets; legacy backfill obeys the plan queue bound while reserving capacity for new items, and advances independently of catalog migration on alarms. A full queue rejects the source mutation rather than silently omitting search work; this backpressure policy remains provisional. Search currently integrates message sources; hosted-file and arbitrary module source indexing need adapters. Content extraction and indexing have explicit bounds and are not a claim that every byte or unsupported message format is searchable.

Credentials, product IDs and provider catalog verification remain operator setup work. See [billing setup](docs/deployment/billing.md), [search specification](docs/spec/omni-search.md), [scaling review](docs/release/scaling-review.md) and [independent storage audit](docs/release/storage-billing-audit.md).

Verification after reconciliation: `npm test`176/176, actual Worker integration16/16, UI state7/7, DOM smoke, Chrome21/21 and production Worker dry run passed. New screenshots were visually reviewed and added to [walkthrough](docs/walkthrough.md), explicitly labeled as API-fault-injection fixtures for billing/search. The PWA shell caches the new public modules and offline tests confirm private account responses remain uncached. No production readiness is claimed.

## 2026-10-12 — Provisioned semantic search, sharded identity and spend controls

User requested a cheap Workers AI embedder, real Vectorize resources, a financial model, severe account admission limits, and removal of shared hot-path resources. Semantic search uses Cloudflare Vectorize indexes `bindle-search-bge-small-v1` and `-s1`, `-s2`, `-s3`: 384-dimensional cosine indexes for the fixed English `@cf/baai/bge-small-en-v1.5` model. Hosted Wrangler binds all four plus `AI`; local defaults do not call paid providers.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D043 | Explicit owner opt-in for remote English semantic processing. Embed only the first 480 UTF-8 bytes; bounded document/query attempts and conservative spend reservations; lexical indexing survives semantic failure. The current 1,000 upsert ceiling is lifetime attempts, not a recyclable active-vector allowance. | Reviewer: ___ Date: ___ Outcome: ___ |
| D044 | Four fixed account-routed Vectorize shards, no query fan-out; sixteen budget partitions with exact aggregate ceilings and durable prepaid leases. Preserve routing and all outstanding/spent obligations during any later migration; reject silent remaps. | Reviewer: ___ Date: ___ Outcome: ___ |
| D045 | Five independent 64-bucket identity lookup families remove the global directory from ordinary authentication/session updates. Recoverable, token-checked cross-shard uniqueness claims. Explicit fresh-layout gate; no automatic legacy migration. See [identity review](docs/architecture/identity-sharding.md). | Reviewer: ___ Date: ___ Outcome: ___ |
| D046 | Valid CAPTCHA/terms/complete signup must pass IP, subnet, country-region and global windows. Defaults: one per IP/three hours, two/IP/day, fifteen/subnet/day, five/country/hour, twenty-five/country/day, ten/global/hour and two hundred/global/day. A durable 1,000-new-admission rollout ceiling prevents admission growth forever under daily limits; this is not a count of existing accounts. Country comes from trusted Cloudflare metadata, never a client-supplied country header. Unknown regions share a restrictive fallback. Local test configuration explicitly relaxes IP cooldown. | Reviewer: ___ Date: ___ Outcome: ___ |
| D047 | The $5/month/$0.50/day semantic operation ledger is not a provider invoice cap. Recurring stock charges, R2, SQL, ingress, cleanup, support and payment risk remain liabilities. [Cost model](docs/architecture/unit-economics.md) and [calculator](scripts/cost-model.mjs) separate global allowances from per-user marginal cost and model full/heavy use. Requested operator cash-budget preference; provisional guards do not authorize deployment. | Reviewer: ___ Date: ___ Outcome: ___ |

Independent source audits found and resolved corrupt-accounting admission, a lease refill race that resurrected spent credit, and a healthy concurrent identity operation that falsely reported conflict after committing. Global allocations commit before external operations, expired/ambiguous leases receive no refunds, and exact-version routing is persisted. Uneven partitions and unused daily leases can pause service early; no automatic borrowing or budget reset exists. Admission counters are application work controls, not a guarantee that incoming denial-of-wallet traffic cannot generate provider charges. Identity maintenance, metadata retention/purge, physical-byte overhead and production load verification remain explicit release work.

Verification before the subsequent beaming work: full core/Node suite213/213; actual Worker security/contact suite16/16; rebuilt Chrome suite22/22, including semantic consent, mode selection and revocation states using labeled API fixtures. These are local results.

## 2026-10-12 — Device names and paid WebRTC beaming in progress

User requested customizable device names, self-device and contact file transfers, multi-file selective acceptance, sender- or receiver-created QR/NFC invitations, and streaming downloads. Nearby QR/NFC pairing requires no prior contact; remote contact delivery needs an explicit beam grant, not generic messaging access. Remote offers notify all eligible recipient devices, with an atomic first-accept claim choosing exactly one device. Self transfers can target a named signed-in device. Contact metadata disclosure is owner-controlled.

Design, backend and browser agents have distinct ownership and are coordinating request/transport contracts. Direct WebRTC data channels avoid hosted payload copies; browser streaming and bounded fallback are under implementation. Cloudflare TURN documentation exposes short-lived credential issuance and per-allocation approximate limits, but no documented enforceable per-tenant byte cap. A declared file size or an application reservation cannot constrain a malicious holder's TURN traffic; relay must remain disabled unless actual enforcement is available. Paid status alone is not sufficient protection against relay costs. Push notification delivery remains a separate unverified gate; an in-portal offer notification is not proof of push delivery.

| D048 | Explicit, single-recipient acceptance of authenticated file manifests; grant-scoped remote contact offers and one-use nearby invitations. Streaming bounded chunks, cancellation and integrity checks; real TURN port prepared with an enforceable-cost gate. Design/implementation/review ongoing, not release-ready. | Reviewer: ___ Date: ___ Outcome: ___ |

Root hot-path follow-up: repeated authenticated reads no longer rewrite account owner metadata or activity within fifteen minutes, and warm reads cannot postpone an earlier pending alarm. A native SQLite regression verifies zero repeated activity writes and preserved schedule. The beaming poll scenario and its higher request count are now called out in the economics document; the earlier typical activity inputs are not measured portal usage.


## 2026-10-12 — Work admission, MCP OAuth and conversations

The reconciled runtime suite passed 247/247 before the new MCP/conversation additions. This includes independent concurrency, spend, cleanup and beaming security regressions. Cleanup now backs off after failures and pauses after eight attempts while retaining outstanding ownership; it does not discard data or release uncertain reservations. Native Node alarms claim their scheduled record before executing so a handler can reliably schedule future work.

| Decision | Direction and current limits | Human sign-off |
| --- | --- | --- |
| D049 | Provisional monthly covered-change limits: free 1,000, Plus 5,000, Pro 10,000; service 250,000, allocated through sixteen fixed partitions and durable prepaid leases. Expose usage/reset in the portal. Preserve reads, export, deletion, revocation, privacy disablement and billing upgrades. These counters do not cap every billable request or the provider invoice. | Reviewer: ___ Date: ___ Outcome: ___ |
| D050 | Separate HTTP MCP service and OAuth authority outside Bindle. Explicit collection/action consent, PKCE, audience-bound tokens, live source checks and revocation. Sixty-four fixed authorization shards avoid centralized token introspection. Registered clients only initially; no uncontrolled dynamic registration or remote metadata fetching. Implementation and independent audit pending. | Reviewer: ___ Date: ___ Outcome: ___ |
| D051 | Sender-generated shared conversation secret permits default bearer replies; unequal per-member rights require independent identity proof and signed membership records. A creator coordinator serializes changes; removal rotates the secret for retained members. Initial secret disclosure grants pending invitees bearer authority. Contact revocation does not retrospectively revoke an independent conversation. | Reviewer: ___ Date: ___ Outcome: ___ |
| D052 | Persist all-recipient delivery obligations and show partial/failure states. Local text conversations are the first implementation subset; cross-host interoperability, membership convergence, abuse budgets and full conformance remain release gates. | Reviewer: ___ Date: ___ Outcome: ___ |

Federated mutation journals need a separate admission review before enabling that currently unconfigured surface; read RPCs already avoid outcome journals and payload copies. Ingress, exempt reads, beaming signaling and provider storage liabilities remain outside the covered-change counter. No production deployment or release readiness is claimed.


## 2026-10-12 — App resources and agent adapters: comparative design

User asked for a backed comparison of contributed resources, apps as resources, and importing existing MCP endpoints. Independent high-intelligence review recommends a provisional **apps-as-resources plus optional MCP adapter** direction. See [three-option analysis](docs/architecture/app-resource-options.md) and [independent audit](docs/release/resource-contributions-audit.md). This supersedes a universal one-resource-per-callable assumption in the first draft. Apps may still contribute genuine domain resources; native host modules and direct existing resource methods remain valid without MCP.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D053 | App state uses whichever resources/contracts the app already has permission to access, app-owned state, or both. Files are one example, not a constraint. Add no separate app-state subsystem. | Reviewer: ___ Date: ___ Outcome: ___ |
| D054 | One owner-specific app connection resource may expose individually granted methods in a pinned generated contract. An MCP importer maps exact upstream tools to safe method IDs and immutable schemas. Reuse existing preference/resource/contract/method grants; a generic tools-call tunnel would bypass that granularity. | Reviewer: ___ Date: ___ Outcome: ___ |
| D055 | Automatic MCP compatibility establishes adapter interoperability only. Unknown tools, changed schemas/revisions, producer disconnect and dependencies require live checks and appropriate owner review. It establishes neither calendar/storage semantic compliance nor permission. Remote code semantics cannot be attested merely by pinning metadata. | Reviewer: ___ Date: ___ Outcome: ___ |
| D056 | Optional stateless/stateful callbacks require a separately authenticated endpoint and a short-lived provider-audience token intersecting approved dependencies and operation budgets. Parent completion closes redemption and reconciles required dependent effects; expiry never manufactures successful writes. This callback adapter remains design work, not implemented capability. | Reviewer: ___ Date: ___ Outcome: ___ |

The separately implemented 3sln HTTP MCP service remains outside Bindle. The portable app/resource adapter and generated contract projection are the Bindle-facing design. No upstream adapter, contribution registry or webhook delegation implementation is claimed yet.


## 2026-10-12 — Reconciled local implementation checkpoint

MCP now has separate 64-shard OAuth authorization, exact collection/function consent, hashed durable credentials, S256 PKCE, audience checks, rotating refresh tokens with reuse-family revocation, and official SDK HTTP tools/resources/prompts. OAuth request admission and bounded cleanup fail closed. Empty operator-reviewed client configuration permits no production authorization flow. Independent review fixed malformed expiry acceptance and avoided holding shard transactions across account/provider work. Revocation stops newly admitted operations; already admitted work may finish. See [MCP audit](docs/release/mcp-audit.md).

Conversations now have encrypted private shared capabilities, independently signed source/membership records, explicit initial invitation MIME and admission, bearer-default replies, per-member restrictions, epoch rotation, threads, bounded durable all-member fanout and honest per-recipient status. Invalid authority/schema/replay requests do not burn normal acceptance work. Source acceptance and recipient inbox copies are separate covered effects; protective restrictions/removal remain available at exhaustion. Independent review fixed source-key and capability-hash binding, cross-conversation message-ID collisions, historical snapshot delivery, and atomic inbox semantic fingerprint receipts across a crash. See [conversation audit](docs/release/conversations-audit.md). General cross-provider discovery/transport/conformance remains gated.

The real Worker conversation check exposed a runtime-specific public-JWK export difference that Node fixtures did not show; explicit public-field construction fixed it. The actual Worker test now verifies signed service creation, bearer delivery, secret-free human inbox rendering and rejection of forged administrator rights. A separate real two-Node-server loopback test verified HTTP peer posting and delivery; neither establishes unrestricted production federation or DNS-rebinding safety.

Independent UI review fixed callback query substitution, stale same-owner thread selection, source-qualified permission/draft identities, non-JSON 401 handling, private state clearing, offline mutation busy state and out-of-order reconnect owner replacement. Real Chrome caught an invalid compound class token that Happy DOM accepted. Consent now renders with no checked defaults, separate destructive warnings and clear deny controls. Reviewed fresh screenshots and updated [walkthrough](docs/walkthrough.md); mocked API records are labeled explicitly. Screenshots normalize document scroll so sticky navigation is captured consistently.

Final evidence: **274/274 runtime tests**, **18/18 actual Worker tests**, **33/33 UI state/audit tests**, **27/27 Chrome browser checks**, plus a focused 5/5 screenshot/layout refresh. Production Worker dry run passed; no application deployment occurred. Synthetic provider vectors were removed from all four shards. TURN relay, billing, full notifications, provider OAuth credentials, general federation, large-account lifecycle and the new upstream app/MCP contribution adapter remain release work. No human approval or release readiness is fabricated.


## 2026-10-12 — User approval: app connection resources and management

User explicitly approved the app-connection-as-resource direction: “app connections as their own resources makes the most sense for me as well,” and requested a place to track and remove/dissociate connected apps. This records approval of D054's resource model only; it does not imply approval of every importer, generated-contract or callback detail in D054–D056. Those implementation/security details retain their separate review places.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D057 | Track owner-specific app connection resources in Connected apps. Disconnect stops new authorized calls and token refresh for the connection; revoking one agent grant remains a narrower operation. Preserve user-owned data and disconnected history. Fresh explicit consent can reconnect, with a new generation so old credentials cannot regain access. | Resource model approved by user in conversation, 2026-10-12. Lifecycle details: Reviewer ___ / Date ___ / Outcome ___ |

Backend, frontend and independent security agents are implementing/reviewing durable connection ownership, live generation checks and localized management UI. The existing MCP consent is the first implemented connection source; general Bindle login/import adapters remain separate release work.


## 2026-10-12 — App manifest presentation and discovery

User requested app names/icons and other presentation from Bindle manifests, linked PWA manifests, or discovered manifest links in provided app index/auth pages. Added optional Bindle `application` metadata using web app presentation fields plus `web_manifest`, operator-reviewed source URLs, inert bounded parsing and once-per-reviewed-request snapshots. Registered app identity stays visible; presentation does not confer trust or authority.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D058 | Prefer explicit registered overrides, then Bindle app presentation, then linked/discovered web app manifests. Discovery is bounded and credential-free; missing/unsupported metadata falls back without blocking consent or owner disconnection. | Reviewer ___ / Date ___ / Outcome ___ |
| D059 | Node may opt into a DNS-pinned HTTPS/443 discovery adapter with public IPv4 enforcement and process-local budgets. Cloudflare discovery remains disabled without equivalent verified actual-destination enforcement. Store raster icon references but use safe initials until a bounded raster cache is implemented; never auto-fetch external icons in account/consent views. | Reviewer ___ / Date ___ / Outcome ___ |

Independent architecture/runtime/UI reviews cover revocation generations, pending consent, private-data boundaries, metadata SSRF, inert HTML, credential isolation and graceful partial failures. User approval of the resource model is recorded under D057; these new networking/presentation choices retain separate review points.


Implementation reconciliation: durable app connections now use the existing owner `resource/*` catalog, canonical resource URLs, authenticated client provenance and generation-bound MCP grants. GET `/api/apps` and CSRF-protected DELETE `/api/apps/:id` provide owner management. Disconnect is local and immediate, with no 64-shard revocation fanout; new access/refresh/code admission and final account dispatch recheck the connection. Fresh inspected consent reconnects at a newer generation. Records are bounded and retained as revocation tombstones; owner data and unrelated storage resources are preserved. Upstream tool import and the Bindle grant bridge remain separate work; empty contracts do not claim conformance.

Presentation is pinned during consent inspection. Bounded single-flight collection runs outside authority transactions, with declared metadata available on both platforms. Optional Node discovery is wired behind `APP_METADATA_DISCOVERY_ENABLED=true`, uses only public IPv4 HTTPS/443 and actual-dial DNS pinning, and passed a real MDN index-to-manifest read-only check. No credentials or icon bytes were fetched. Cloudflare external discovery remains disabled; remote icons remain references until a safe raster cache exists. Node quotas are process-local, not an invoice cap.

Final checks for this change: **308/308 runtime tests**, **18/18 actual Worker tests** (including connected-app listing/disconnect/data preservation), **40/40 UI state/audit checks**, **28/28 full Chrome checks**. A subsequent **12/12 focused Chrome check** verified card readability, the v9 public-shell cache and private-cache/session regressions after final polish. Worker deployment dry run passed. Updated screenshot walkthrough uses labeled fixtures. User resource-model approval is recorded; no production readiness or application deployment is claimed.


## 2026-10-12 — Shared callable foundation, browser automation and user commands

User asked for browser automation integration and whether connected apps should contribute portable user commands. Independent architecture and security agents recommend existing resource/contract/method operations as the common foundation, with human UI, HTTP MCP and browser WebMCP as adapters. The recommendation and command profile are recorded in [callables and user commands](docs/architecture/callables-and-user-commands.md), [browser architecture](docs/architecture/browser-automation.md) and [contribution specification](docs/spec/resource-contributions.md).

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D060 | Keep callable business operations independent of MCP and host presentation. Optional declarative user-command metadata requests presentation in a palette, menu, button or supported typed form; do not automatically expose every low-level tool as a human command. | Reviewer ___ / Date ___ / Outcome ___ |
| D061 | Share schemas, validation and business dispatch while retaining separate authenticated owner, OAuth assistant and explicitly enabled browser-session authority. A human confirmation cannot elevate an assistant request or confer persistent automation access. | Reviewer ___ / Date ___ / Outcome ___ |
| D062 | Start native browser automation with the portal's own five collection/item operations, exact session-scoped collection/function grants, trusted mutation review, generation-bound connection checks and abort cleanup. Browser callback metadata establishes no authenticated assistant identity. Cooperative third-party frames, upstream imports and closed-browser execution remain separate work. | Reviewer ___ / Date ___ / Outcome ___ |

Implemented a shared five-operation catalog and explicit Automation hub with English/Spanish strings. Browser grants require deliberate selection, expire with the owner session and retain one-use, argument-bound mutation receipts. Independent audits cover immutable arguments, stale registration, cancellation, malformed grant/receipt records, revocation and caller separation. Unsupported browsers keep HTTP MCP and connected-app management reachable. No arbitrary app command renderer or generic contribution registry is claimed as implemented; that proposed layer will reuse existing grants rather than invent app state or a second permission plane. Production remains gated.

Verification checkpoint: **333/333 runtime tests**, **43/43 UI state/audit checks**, **20/20 actual Worker tests**, and **31/31 full Chrome checks** passed, including one real native WebMCP test against local Wrangler (experimental Chrome flags; no modelContext/owner API mocks). Worker deployment dry run passed. Native discovery, filtered listing, trusted confirmed hosted-file write, byte readback and disable/revocation were verified. An earlier overlapping browser-run attempt overwrote the shared generated test configuration; sequential rerunning removed that test interference and passed. Screenshot review identified raw arguments dominating confirmation; readable operation summaries are receiving targeted polish before the final screenshot checkpoint.

Final polish checkpoint: readable mutation review now shows the operation, collection, file/message identifier, conditional-write semantics, decoded byte size and a bounded inert plain-text preview; exact immutable arguments stay available in collapsed details. EN/ES review labels and metadata summaries are localized. **43/43 UI checks** passed again, followed by **14/14 focused Chrome checks** covering native WebMCP, fixture/unsupported flows and session/cache adversarial behavior. Updated the [screenshot walkthrough](docs/walkthrough.md) with actual native desktop/review images and a labeled mobile fixture. Browser runner now uses a per-run generated configuration/secrets directory to prevent the observed overlap interference. These are local checks; no production application deployment occurred.


## 2026-10-12 — User approval: callable commands and storage without enumeration

User approved the shared callable direction ("Sounds like the right path, let's do it") and explicitly requested that the common Drive/S3/WebDAV object-storage interface omit listing. This records approval of D060–D061's direction, not every future importer, schema or grant-bridge detail. Existing sign-off spaces retain their implementation-review purpose.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D063 | No public object-storage listing method, permission or capability. Apps retain a known bootstrap key/reference and maintain bounded directory/index objects. Inbox collection listing is separate. Conditional index updates are mandatory where writes are advertised; index/object updates are distinct effects with crash/orphan reconciliation and directory backup requirements. | No-list direction approved by user, 2026-10-12. Detailed semantics: Reviewer ___ / Date ___ / Outcome ___ |
| D064 | Implement the first optional host-neutral user-command projection over pinned callable methods. Trusted host adapters preserve the original immutable caller and use the existing dispatch/grants/journal; bounded inert metadata supplies presentation only. General upstream import and the production authority bridge remain distinct work. | Callable direction approved by user, 2026-10-12. Adapter review: Reviewer ___ / Date ___ / Outcome ___ |

Removed listing from the unpublished object-storage v1 draft artefact, capability descriptions, runtime gateway and demo. Stale stored listing capabilities cannot expose storage `items_list` through MCP/browser access; inbox tools retain their own listing support. MCP tool discovery now intersects exact grants with live source capabilities. External connector verification requires a known small file key and performs an exact read, with no enumeration fallback; UI closes on success, retains failures for retry and excludes hosted resources from external credential verification.

Independent storage review documents provider-ID/bootstrap and atomicity limitations. Google Drive currently has a defensive direct-child read adapter using existing file IDs and internal native enumeration helpers, with mocked provider checks. It has **no completed OAuth onboarding/refresh, write/delete support, logical-key mapping, persisted directory-root workflow or real-account verification**. The portal therefore keeps it unavailable; it is not yet an end-to-end Drive sync integration. See [storage contract and directory model](docs/spec/storage.md).

The first callable adapter and actual federation fixtures are implemented. Independent audit reproduced and fixed mutable nested caller credentials during asynchronous confirmation. Host-neutral invocation and existing portal contributions share dispatch without granting assistant requests owner authority; 17/17 implementation/independent command checks pass. Arbitrary external app installation, generalized renderer and upstream importer are not claimed complete. See [implementation reconciliation](docs/architecture/callables-and-user-commands.md).

Final checks: **356/356 runtime tests**, **43/43 UI state/audit checks**, **20/20 actual Worker checks**, and Worker dry run passed. The existing **31 Chrome checks** passed with the new contract; the added known-file verification check initially needed waits/scoped selectors for asynchronous rendering and duplicate background/dialog alerts, then passed independently. A subsequent focused run passed all **12 native/session/cache checks**, and the corrected verification fixture passed **1/1**, exercising exact key submission, failed-read retry, success close and hosted-button exclusion. No application deployment or production provider conformance is claimed.


## 2026-10-12 — Canonical branding and managed Google Drive

User requested the organization logo from `../.github`; the local checkout is `../dotgithub` (repository `3sln/.github`, revision `458ad44a83a9f4b54136c96ca74122cabd99be8b`). Copied canonical mark, outlined light/dark wordmarks and 512px avatar unchanged. Used the wordmark in the portal, mark/PNG for favicon/PWA/apple touch, and exact PNG as a Cloudflare email CID attachment with escaped HTML and unchanged plaintext. Inbox-provider sender avatar/BIMI certification remains separate; see [branding setup](docs/deployment/branding.md). Generic self-hosted branding is retained.

Portable OAuth/PKCE, encrypted owner/session-bound one-use state, refresh, dedicated folders, stable logical keys, immutable uploads, durable generated-ID journals, digest/membership checks, logical deletion and mapping-preserving same-account reconnect are implemented and wired through Account, Worker/Node APIs and localized portal flows. [Deployment setup](docs/deployment/google-drive.md), [independent architecture/security review](docs/architecture/google-drive-integration.md).

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D065 | Managed Drive writes use immutable provider files and atomic host-owned key-map publication; this is conditionalAuthority=bindle-host, not upstream Drive CAS. Retain old/deleted physical files and ambiguous-operation IDs with explicit bounds/disclosure. Preserve root/map on same-principal reconnect. Disconnect removes local credentials; project-wide Google revocation remains an explicit Google Account action because it affects other clients. | Reviewer ___ / Date ___ / Outcome ___ |
| D067 | Optional resource-scoping metadata describes enforceable controls. Store selected resource + scope privately in the shared preference field; all consumers share this field scope. Project only a resolved scoped resource reference and consumer-specific token with appropriate grants. An owner save reviews exact currently effective consumers/effects; no per-app scope UI or raw parent credentials are introduced. | Field-value/reference/token model explicitly clarified by user, 2026-10-12. Contract/lifecycle details: Reviewer ___ / Date ___ / Outcome ___ |

Independent Drive review fixed late refresh/disconnect resurrection, stale refresh responses, ciphertext transplantation, moved/changed downloads, malformed responses and reconnect publication races. Durable gateway verification caught ranged metadata reporting partial rather than full object size and corrected it. OAuth callback moves bounded data into a private fragment then clears history before rendering; code never enters the Query model. Known-file verification preserves newly refreshed credentials. Tests distinguish fixtures from real Worker boundaries and provider conformance.

The scoped-field model is specified in [resource-scoping.md](docs/architecture/resource-scoping.md) and linked from the preference projection contract. It is proposed protocol/editor work, not a completed general scoping implementation. Independent review clarified effective exact-field authorization and child-relative output sanitization.

Predeployment review found an actual public-cost path: invalid unsubscribe requests could allocate arbitrary Account Durable Objects. Added active-identity checking before dispatch and an independent no-allocation regression. Secret-free production bootstrap tests verify signup503, demo404, unavailable federation manifest/MCP and disabled Google.

Verification: **396/396 runtime tests**, **52/52 UI checks**, **25/25 actual Worker checks**, **36/36 full Chrome checks**, followed by **16/16 focused branding/Google/session/cache checks**, and Worker dry run passed. The screenshot walkthrough now includes canonical branding, inline email preview and labeled Google setup fixtures. No live Google conformance or public release readiness is claimed.


## 2026-10-12 — Credential-encryption key scope

The master key supplies AES-256-GCM for provider-held credentials/private capabilities: per-user Google tokens/OAuth state, S3/WebDAV credentials, server-held account signing keys, contact URLs, conversation capabilities and file-sharing invitations. It does not provide end-to-end file encryption, replace password hashing, hold authenticator passkey private keys or replace the separate recovery-file key derivation. Loss or unplanned replacement would make existing encrypted records unreadable.


## 2026-10-12 — Portable recovery identity design

Historical proposal: the combined name/recovery format below is superseded by the later **UUID identity, separate name certificates and automatic free names** entry.

User requested a provider-signed recovery file containing the assigned name and signing/encryption keychain, so leaving and returning preserves identity and existing signatures/contact links. [Portable recovery identity proposal](docs/spec/recovery-identity.md) specifies a version 2 decrypted payload inside the existing version 1 answer-encrypted envelope, provider signing authority separate from `KEY_ENCRYPTION_KEY`, original AccountObject signer adoption, and a distinct encryption key. Private keys remain inside the encrypted download; a populated encryption keychain does not imply existing content uses it.

Implementation boundary agreed for this work: recover retained identity/account state; preserve subject, handle assignment and current keys; validate the provider-signed backup and live random recovery credential; never import over a current keychain or reconstruct grants from private keys. After upgrade, persisted account policy must require the signed v2 input so removing its signature cannot reach the legacy v1 path. Legacy files retain their explicitly recognized token-only behavior until upgraded. Replacement-file activation keeps existing transaction resume and token-invalidation semantics.

Code inspection found that identity-shard lookup cleanup can release a handle claim when its account record is missing. These existing lookups are not durable name reservations. Reconstitution after deletion therefore remains disabled until retained authoritative reservation and revocation state, collision handling and crash-safe restoration exist. Current grants, revocations, expiry, quota use, quarantine and collection state remain authoritative; key possession does not recreate deleted permissions or data. Existing recovery resets login authenticators/sessions but is not full compromise remediation for copied identity keys, linked email or application/resource permissions.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D068 | Recovery carries a provider-signed name/subject assignment and the original signing plus separate encryption keychain. Independent stable provider signer; bind the random recovery credential and keychain into the signed package. | User requested portable signed identity direction in conversation, 2026-10-12. Protocol/security reviewer ___ / Date ___ / Outcome ___ |
| D069 | Return preserves identity for retained accounts and their live authorization state. Missing-account restoration, handle reassignment, cross-provider routing and key rotation require separate protocols; old backup state cannot revive revoked grants. | Reviewer ___ / Date ___ / Outcome ___ |

Design work reviewed the actual recovery, identity-sharding, AccountObject key storage and contact verification implementations. Automated agent cross-review is requested separately and does not constitute human sign-off. Implementation and test outcomes must be appended after execution; this entry claims architecture work only. Public production release remains disabled under the existing security gates.


## 2026-10-12 — Permanent namespace policy and signup clarity

Historical intermediate design: `basename.number` and current-paid eligibility below are superseded by the later **UUID identity, separate name certificates and automatic free names** entry. Permanent nonreassignment remains required.

User explicitly directed that handles never be recycled: free accounts receive a provider-assigned numeric suffix, while paid accounts may claim a short name without the suffix. [Permanent account names](docs/spec/identity-names.md) specifies immutable canonical `basename.number` names, shared or disjoint sharded monotonic suffix allocation, a permanent claim ledger separate from live lookup cleanup, and one nontransferable paid short alias per subject. Subscription lapse, inactivity and account deletion never release either kind of claim. Ledger history and counter high-water marks cannot roll back; existing namespace backfill and disaster-recovery continuity remain explicit production evidence requirements.

This direction supersedes any earlier suggestion that a released handle might be reassigned. Adding a paid alias preserves the canonical name, original subject, keychain, contact URLs and previously issued identity recovery assignment. Provider signatures attest historical issuance and do not recreate deleted authority or grants. Independent agent review checked the permanent-ledger and one-alias boundaries, including that a definite unsuccessful alias claim must not consume the owner's sole successful claim.

Signup now accepts a 3–18 character base name and explains the assigned numeric suffix. Login accepts the full handle, including the dot separator. Recovery setup displays the exact server-issued handle, preserving it as untranslated owner data while localizing interface text in English and Spanish. Only the public handle is added to the browser projection; recovery keys/tokens remain in private operation state. No paid-claim form is introduced before its API is integrated.

Validation: existing browser Action/state checks **3/3 passed**. Direct happy-dom checks passed for signup/login bounds, numeric-handle login, English/Spanish explanatory text, literal complete-handle rendering, and browser Unicode-sets input-pattern validity. This is DOM evidence, not a real-browser or deployed namespace conformance claim. Separate durable recovery integration tests **5/5 passed** before namespace wiring, including retained signer/contact policy, rejection without mutation, missing account/key denial, signing-authority absence and legacy-to-v2 resume. Full integration results after namespace wiring remain to be recorded by the coordinator.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D070 | Handles are permanently nonreassignable. New free canonical names use `basename.number` from a durable provider-wide/sharded allocator; permanent claims survive live lookup cleanup and deletion. | Explicit user direction in conversation, 2026-10-12. Allocation/migration reviewer ___ / Date ___ / Outcome ___ |
| D071 | One paid short alias supplements the immutable canonical identity; retain its claim after billing lapse/deletion, with no release or transfer. Failed unavailable-name claims must not burn the owner's sole successful alias entitlement. | User requested paid short names, 2026-10-12. Alias lifecycle/security reviewer ___ / Date ___ / Outcome ___ |


## 2026-10-12 — UUID identity, separate name certificates and automatic free names

Latest explicit user decisions supersede the earlier combined recovery/name and chosen-base suffix proposals. Identity is a stable UUIDv4. Signup assigns `n.<lowercase Crockford Base32 numeric identifier>` without asking for a base name. A customer who has ever been a verified paid subscriber may claim one permanent 3–32 character custom alias, including after cancellation; aliases begin with a letter or digit and otherwise contain lowercase letters, digits, underscores or hyphens. No alias contains a dot, reserving `n.` for free numeric allocation. Every name remains permanently nonreassignable.

Recovery payload v2 now contains only issuer, stable UUID, independently generated signing/encryption private keychain, reset credential and bounded version/warning/provider-proof metadata. It contains no handle, alias, name assignment or name certificate, even inside the reversible signed proof. Public name certificates are separately signed and downloaded and contain only issuer/UUID/canonical-name/assignment-lineage/issuance metadata and public proof. Both proofs use distinct signature domains and the configured provider authority. [Recovery and certificate specification](docs/spec/recovery-identity.md); [namespace policy](docs/spec/identity-names.md). The outer answer-encrypted envelope remains v1; explicit legacy payload-v1 compatibility is retained under account policy.

Independent cryptographic agent review found asynchronous caller-mutation races in creation/verification. Inputs are now bounded and snapshotted before asynchronous cryptography; delayed-import/verification adversarial regressions cover both cases. Crypto tests **6/6 passed**, covering exclusion of names from recovery, no private material in certificates, purpose separation, scalar/public-point matching, UUIDv4, trusted-authority binding and mutation rejection.

Signup no longer requests a name; the actual allocated handle is displayed during recovery setup using separate public response metadata. Account security now displays the stable UUID, canonical name and custom alias. The one-alias form explains permanent commitment and ever-paid eligibility, requires explicit acknowledgement, and relies on server-verified paid history. It publishes a name only after server success and refresh. Both name-certificate download actions verify the provider signature and selected issuer/UUID/name before downloading the public artifact. OwnerFlow guards prevent late responses from crossing account changes. New DOM/Action checks **4/4 passed**, alongside existing browser-state checks **3/3 passed**; no real-browser, deployed or operational backup conformance is implied by those checks. Independent agent review found no blockers in the new alias/certificate UI or owner-change guards. `npm test` also passed **423/423** at this integration checkpoint; the coordinator records any later whole-tree/browser results.

| Decision | Direction and qualifications | Human sign-off |
| --- | --- | --- |
| D072 | Stable UUIDv4 is the identity. Recovery excludes every name/assignment; name certificates are separate public signed artifacts. Supersedes the combined payload portion of D068. | Explicit user direction, 2026-10-12. Crypto/protocol reviewer ___ / Date ___ / Outcome ___ |
| D073 | Free signup automatically allocates `n.<Crockford Base32>` using the durable shared/sharded numeric allocator. Permanent claims and nonrollback requirements remain; supersedes `basename.number` in D070. | Explicit user direction, 2026-10-12. Namespace/migration reviewer ___ / Date ___ / Outcome ___ |
| D074 | Verified paid subscription history permanently grants eligibility for one nontransferable custom alias, even after cancellation. Server billing history is authoritative. | Explicit user direction, 2026-10-12. Billing/security reviewer ___ / Date ___ / Outcome ___ |

Full runtime/Worker/browser results after all integration changes must be appended by the coordinator. Missing-account reconstruction, provider signing-key rotation, legacy namespace backfill, disaster-recovery nonrollback and production release retain their existing gates; no human approval is fabricated here.

## 2026-10-12 — Final identity/name integration and verification

Latest user direction implemented: cryptographically random UUIDv4 subjects; automatic `n.<Crockford Base32>` free aliases with canonical case/ambiguous-character normalization; permanent paid aliases available from verified historical payment, including after cancellation; original numbered alias retained. The signed PII-encrypted identity backup has no handles or name certificates. Authenticated public certificate downloads bind each retained handle to its UUID separately. Claiming an alias preserves identity keys and existing recovery authority. Owner projections discover committed paid aliases even if the publication CAS lost its response.

Independent review fixed interrupted legacy-to-v2 recovery resumption, mutation during verification, signing/certificate mutable-input races, counter-corruption/reset reuse, paid-claim collision/crash recovery, and raw-spelling login rate-limit bypass. Browser recovery cancellation now aborts authority verification and prevents late credential submission or KDF startup. Oversized streaming Worker coverage uses a paced client upload so early413 responses do not race Undici's eager upload with EPIPE; byte limits and fail-closed assertions remain intact.

Validation:425/425 core/SDK/runtime checks;56/56 UI state checks; actual Chrome+local Wrangler signup/passkey/password/PII recovery checks5/5; separate public-certificate/canonical-login/authority-cancellation checks2/2. Final actual Worker and deployment dry-run results are recorded below after completion. [Independent review](docs/release/recovery-identity-audit.md) and [walkthrough screenshots](docs/walkthrough.md#26-stable-identity-and-permanent-handle-aliases) distinguish local verification from live provider conformance.

Recovery signing uses an independent RECOVERY_SIGNING_KEY Worker secret, separate from the other keys. Local Wrangler uses a distinct private authority; Node persists its own authority. [Operator requirements](docs/deployment/identity-backups.md) document no blind signing-key rotation, namespace backfill/high-water continuity, and deferred missing-account reconstitution. Public release gates remain false.

Coordinator reconciliation reviewer: ___ Date: ___ Outcome: ___. These nonblocking signoff places do not fabricate human approval or replace production gates.

Final checks completed: actual workerd/SQLite/R2 Worker suite25/25 passes, including byte-bounded chunked contact delivery; production Wrangler deployment dry-run succeeds. Chrome certificate/login and cancellation checks2/2 pass with actual signature verification, verified download and no horizontal overflow on390px viewport. Remaining release gates include live billing/provider conformance, namespace migration/backup continuity, signing-key rotation policy and missing-account reconstitution.

## 2026-10-12 — @3sln/js-tools content-addressed client build

User explicitly requested the 3sln/js-tools packaging model. Replaced copied stable module URLs/manual PWA version list with pinned js-tools0.2.0 build artifacts: individually content-addressed authored modules, hashed CSS and bootstraps, a complete import map, self-contained recovery worker and external SDK modules, and public/private build manifests. A reviewed adapter completes pinned0.2.0's missing `.mjs` map entries and origin-absolute aliases, verifies the full declared public graph, and regenerates bootstraps with js-tools' own wireupSource. Source imports and source-module bytes remain unchanged; server policy and credentials stay outside the public boundary.

Generated import-map CSP hashes preserve isolated recovery policy without broad inline script. Immutable assets preserve exact bytes and year-long public caching; live HTML remains no-store. PWA installation authenticates every public cache asset before publishing the generation. The cache manifest comes from build outputs, not a manually updated list. The branded dynamic webmanifest is not precached. Existing tabs keep their worker generation; older public cache retention and built offline branding are documented operational limits.

Actual Chrome found Workers Assets canonicalizing the generated offline `.html` asset with307, correctly rejected by strict precache fetching. The narrow Worker asset adapter now follows only one exact same-origin canonicalization through ASSETS, preserving successful HTML bytes; external/query/alternate/repeated redirects fail closed. Worker regression tests cover this. First-registration tests navigate after activation instead of relying on forced clients.claim. Documented SDK URLs are retained as no-cache loaders to hashed standalone bundles, with exact anonymous CORS rather than imposing our import map on other apps.

Independent verification: deterministic rebuild and authored-byte preservation; full alias/target graph and singleton checks; public/private boundary review; full SHA-256 checks over declared precache artifacts under Node/custom branding. Actual Chrome/local Wrangler checks16/16 cover hashed portal/recovery/certificates/offline; a second13/13 run covers SDK cross-origin loading, immutable headers, CSP and offline UI. Core430/430, UI-state56/56 and Worker27/27 pass. Final full browser and dry-run outcomes follow after completion. No updated application deployment or release activation occurred.

D075 — Adopt js-tools content addressing and generated cache generations. Independent architecture/security agent: source/artifact/HTTP review passed, see [audit](docs/release/build-cache-audit.md). Human reviewer: ___ Date: ___ Outcome: ___. D076 — Preserve external SDK compatibility through standalone hashed ESM and revalidating public loaders. Human reviewer: ___ Date: ___ Outcome: ___. [Operator build guide](docs/deployment/client-build.md).

Final js-tools checkpoint: full Chrome/local Wrangler suite41/41 passes; core430/430, UI-state56/56 and Worker27/27 pass; production deployment dry-run succeeds. Initial dependency audit found five high advisories through an unused HMR type-only core0.4 subtree. Independent source/API and real watcher/websocket testing approved the exact HMR0.1.12→core0.7.5 override. Regenerating only the js-tools subtree applied it while preserving app dependencies; complete npm audit now reports zero vulnerabilities. This compatibility override is documented for future tooling upgrades. No updated app deployment or public-release activation occurred.

## 2026-10-12 — Viable release assessment and completion order

User requested the remaining work before a viable release. Current source has passing local suites (430 core/SDK/runtime, 27 Worker, 56 UI-state, 41 real Chrome/local Wrangler) and a clean dependency audit;. These checks do not establish external-provider conformance or operational readiness. The all-false release ledger needs evidence reconciliation rather than indiscriminate activation.

Completion order: (1) finish and independently validate the real Bindle OAuth/PKCE → fragment consent → scoped resource RPC flow and external SDK, with a second host/client interoperability fixture; (2) complete human messaging/archive rendering, durable push/email dispatch, preferences/unsubscribe, scanner-safe login and lifecycle notices, including localization and retries; (3) prove real Google/S3/WebDAV storage behavior, address the current Drive 1 MiB object ceiling and retained-version cleanup, then verify live Polar billing and permanent alias eligibility; (4) prove backup/restore, permanent namespace nonrollback and key custody/rotation policy, reconcile the promised deleted-account identity restoration, and keep destructive lifecycle jobs gated until notices and grace periods work; (5) production Turnstile/bot rules, capped-load/cost and abuse exercises, independent security/UX review, accessibility and actual-device tests; (6) self-host setup rehearsal, docs/screenshots, terms/privacy approval, staging deployment and evidence-backed release gate reconciliation. TURN requires enforceable spend controls; credentials alone do not establish safe relay availability.

Operator dependencies: production Turnstile configuration; Polar API/webhook/product identifiers; push sender configuration and any relay credentials once relay enforcement exists; product/legal approval of terms, privacy, retention and recovery policies.  No public opening or feature-scope reduction is authorized by this assessment.

Release acceptance reviewer: ___ Date: ___ Outcome: ___. Independent agent review and resolved findings are recorded separately; this checkpoint does not fabricate approval.

## 2026-10-12 — Native Bindle completion and default object storage

The real Node and Worker identity stores now compose account-local Bindle authorization, shared preferences and resource authority. Login uses exact provider/client/callback binding, S256 PKCE and one-use authorization codes; owner consent renders typed, localized fields and exposes existing consumers. Applications receive opaque field-derived resource references and separate child tokens, never connector configuration or parent storage credentials. The owner preferences editor uses revision and live-consumer review checks for a single shared save; resource generation, field incarnation, connection generation and recovery epoch remain live checks, including before journal replay.

Independent protocol and security review found and drove fixes for scalar-only edits accidentally expanding resource subsets, resource reordering changing authority, scope canonicalization, prototype-named fields, refresh replay rollback, expired credential accumulation and unknown UUID shard allocation. Browser work also fixed cross-origin SDK loading, bound browser fetch, provider-login continuation, typed multi-value editing and explicit optional-fragment decline preservation. Rotating refresh credentials stay in memory, preserve original grant ceilings and have an absolute eight-hour family lifetime; spent-refresh replay invalidates the family and its child credentials. Requests, codes, access tokens, families, journals and issued object capabilities are bounded per account and pruned by account-local maintenance.

| Decision | Direction and rationale | Sign-off |
| --- | --- | --- |
| D077 | Use the existing durable identity/account implementations for Bindle; one UUID-routed federation shard per active identity, no global grant index on the request path. Reject missing/inactive identities before allocating account shards. | Architecture reviewer ___ / Date ___ / Outcome ___ |
| D078 | Make object presigning a uniform contract capability, choosing native only where every delegated bound can be enforced, otherwise opaque host proxy URLs. Require presign plus get/put on the same field; each URL narrows to one object, operation and bounded lifetime. This supersedes the earlier implementation's refusal to presign scoped resources. Native URLs disclose the backing address and revoke at expiry; proxy URLs check live authority. | User direction recorded 2026-10-12. Protocol/security reviewer ___ / Date ___ / Outcome ___ |
| D079 | Every account owns a stable, non-disconnectable, metadata-only default hosted storage resource. Stored bytes share the visible message/object plan quota; consent remains mandatory for app access. Cold restoration preserves the same resource ID. Legacy accounts with 100 manual resources receive the default without evicting user resources; additions remain blocked while over the existing cap. | User direction recorded 2026-10-12. Storage/migration reviewer ___ / Date ___ / Outcome ___ |
| D080 | Derive provider object-URL HMAC authority using a distinct HKDF domain from the credential-encryption master key. Public proofs contain only an account locator, random ID, fixed operation and expiry; private grant state remains in the account shard. Recovery signing authority is separate. | Cryptography/operations reviewer ___ / Date ___ / Outcome ___ |
| D081 | Initial hosted Bindle registration uses operator-reviewed client origins/callbacks and immutable fragment schemas. The protocol remains open and portable; dynamic origin proof, discovery fetch and safe egress are separate release work, rather than accepting arbitrary URLs as trusted clients. Federation remains production gated. | Federation release-profile reviewer ___ / Date ___ / Outcome ___ |
| D082 | Keep human message rendering in an iframe with an empty sandbox and restrictive CSP. A sanitizer or native setHTML can remove unsafe markup but does not replace origin/network isolation. Object proxy downloads use inert attachment responses. | Messaging/security reviewer ___ / Date ___ / Outcome ___ |

Default-storage validation: seven native Node tests pass, including fresh authenticated API access, metadata-only initialization, stable restart/cold restoration, corrupt/foreign pointer rejection, shared message/object quota and the 2,000-message archive boundary. The actual Worker test verifies signup/API visibility, disconnect rejection and R2 restoration of exactly one default. An independent reviewer separately reproduced the legacy 100-resource migration and 2,001-row archive restoration. [Independent audit](docs/release/federation-completion-audit.md).

Before the signed-URL service integration, the combined core/SDK suite passed 489/489 and UI-state tests 56/56. The actual native Worker federation tests passed 2/2 (full consent/resource RPC/refresh replay and credential-maintenance alarm), and the previous actual-Chrome run passed 44/44. Those browser results predate the default-resource and signed-URL UI changes; final combined verification is recorded below after integration. These are local implementation results, not external-provider production conformance or approval to open signup.

### Distributed-name discovery steering

The user requested Cloudflare's distributed-web resolver and confirmed the [2021 ENS/IPFS announcement](https://blog.cloudflare.com/cloudflare-distributed-web-resolver/). Current primary-source research found the specific DoH experiment was [deprecated July 1, 2025](https://developers.cloudflare.com/fundamentals/api/reference/deprecations/). The user was informed during implementation. The replacement follows the same public-name → DNSLink → public manifest → live HTTPS provider model through maintained resolver operators, instead of depending on that retired endpoint or substituting ordinary DNS for ENS. [Research and live observations](docs/release/distributed-discovery-interop.md).

D083 — **Deferred by explicit user decision, 2026-10-12.** Distributed/Web3 name discovery is removed from the current SDK and release scope. The experimental Cloudflare resolver is retired; live review also found the selected public IPFS gateway retired, an alternative gateway redirecting to it, and no verified current `.crypto` availability. The proposed pluggable DNSLink/DoH implementation and its added CID dependency were withdrawn. Keep ordinary HTTPS `.well-known/bindle/manifest.json` discovery and exact issuer/origin checks. Retain the research as historical evidence; reconsider naming-provider support only with maintained, dependable resolver/content retrieval options. User decision recorded; future reconsideration reviewer ___ / Date ___ / Outcome ___.

Signed-URL integration checkpoint: full core/SDK regression 492/492, actual Worker focused tests 3/3 (including real binary proxy URLs), and updated actual Chrome federation flows 3/3 pass. Independent review reproduced a URL-expiry gap between initial admission and dispatch, drove a final-boundary guard, then verified the operation does not execute after expiry. Native mode pins the preflighted object version and required range headers; proxy mode preserves the original child authority and enforces exact-size/type/conditional writes. The legacy 100-resource migration also now remains usable through MCP rather than failing its previous collection cap. Final combined checks after distributed-name implementation remain pending below.

## 2026-10-12 — Physical storage-write cost guard

The user identified write/update churn as a fee risk. Existing monthly work admission already protects covered logical changes, but is explicitly not a count of actual bucket puts. Added a separate meter at the I/O boundary for uploads, replacements, message/conversation bodies, large stored mutation outcomes and cold archives. BLOBS and ARCHIVES share one account meter; private caller attribution is immutable per call and removed from provider options. The guarded port exposes only get/put/delete, so a future list/copy/multipart API cannot silently bypass Class A admission. Each attempted put is nonrefundable; completed replay does not call the bucket again. Reads, deletion and safety operations remain available.

D084 — Initial write limits are 5 attempts/app/rolling minute, 10/account/rolling minute, and 1,000/5,000/10,000 foreground attempts per UTC month for free/Plus/Pro. A total 250,000 service allowance is split into 225,000 foreground and 25,000 archive maintenance attempts; each account has 16 reserved archive attempts/month so foreground exhaustion need not prevent shelving. Sixteen immutable service shards allocate small prepaid leases off the normal path. These are operator-configurable conservative defaults, separate from logical work and byte quota. Cost/product reviewer ___ / Date ___ / Outcome ___.

D085 — Foreground and archive allocation share an atomic combined monthly counter per service shard. Total partition capacity depends only on the service ceiling; maintenance is carved out, and the allocation policy is pinned on first use for that month. Changing a percentage cannot create a second spending pool. Missing authority, corrupt counters, clock rollback and uncertain allocations fail closed; resetting/rolling back state is not a supported replenishment operation. Architecture/operations reviewer ___ / Date ___ / Outcome ___.

Independent accounting review drove fixes for falsey corrupt state, shared lifetime-null resets, duplicate-instance lease overcredit, clock transitions, missing authorities, retry timing and mid-month pool changes. Root composition tests verify changing keys/versions or writer IDs cannot bypass app/account bursts, both bucket ports share limits, failures remain charged, completed writes are not repeated, maintenance survives foreground exhaustion, and unmetered bucket methods are absent. Actual Worker signed-upload tests verify 429 + Retry-After, one persisted physical attempt for repeated completed upload and only one stored object after a denied second write. Retry timing survives account faults, native journals, federation faults and Durable Object RPC.

Validation before the final UI cost-meter follow-up: core/SDK 515/515, UI state 56/56, actual Worker 31/31. Final targeted accounting/composition checks 16/16 also pass after the last malformed-counter/config guard. Earlier direct-HTTPS browser integration passed 44/44, with a subsequent 3/3 Spanish default-storage follow-up; cost-meter browser evidence follows below. [Design and price interpretation](docs/architecture/storage-write-costs.md), [independent review](docs/release/storage-write-budget-review.md).

Cost scope is deliberately precise: the cap bounds covered application bucket-put attempts, not the entire Cloudflare invoice. R2 Standard Class A pricing/free allowance and billing rounding were checked against primary documentation; other workloads may share free allowances, provider-internal retries are not measured here, and storage bytes, reads, compute/search and external services retain separate controls. Native signed write URLs remain unavailable without enforceable one-use/cost admission; proxy uploads use this guard. External S3/WebDAV dispatcher writes remain unavailable rather than making unverified billing/control claims.

Foreground writes also pause if retained-upload or garbage cleanup is paused, preventing replacement churn from accumulating abandoned physical objects outside logical quota. Reads, deletion and reserved archives remain available. Final core/SDK 517/517, actual Worker 31/31, DOM smoke and full actual-browser 45/45 pass; targeted accounting/composition 17/17. Dependency audit reports zero vulnerabilities. The console exposes monthly physical-write usage separately from bytes and logical work, with localized exhaustion/retry messages and no automatic write retry. Final meter layout follow-up and deployment dry-run evidence follow below. Production release gates remain disabled.

Final UI state 57/57 and SDK/localization 22/22 pass. After polishing mobile meter spacing and adding the cleanup-pause translation, focused Chrome 9/9 passes, including rectangle checks for nonoverlapping meter text and Spanish rendering. Updated walkthrough screenshots show the real Worker-backed storage meter. Wrangler deployment dry run passes; this checkpoint is not a production deployment.

## 2026-10-13 — Practical write bursts

The user identified the initial 5/app and 10/account rolling-minute policy as restrictive for legitimate sync and batches. Supersedes D084's minute limits with 120 attempts per app per account and 240 per account across all writers in a rolling 60 seconds. The full allowance can be used immediately; this is not a paced two-writes-per-second throttle. Monthly plan and shared service ceilings remain unchanged, so the burst increase does not raise the admitted monthly bucket-write ceiling. Defaults and both Wrangler configs agree; low-limit boundary tests now declare their intended fixture policy explicitly. Cost/product reviewer ___ / Date ___ / Outcome ___.

Validation: core/SDK 517/517 passes after the burst-policy change; whitespace check passes.

## 2026-10-13 — Shared storage-write ceiling raised

User-approved policy supersedes D084's service ceiling: 10,000,000 physical bucket-write attempts per UTC month, split into 9,000,000 foreground and 1,000,000 reserved archive attempts. Runtime defaults and both Wrangler configs agree. Per-account monthly allowances, rolling burst limits, shard layout and atomic accounting are unchanged. Existing authority records pin their monthly policy, so an already-used shard retains its existing policy until the next UTC month; this change does not reset or bypass counters. User direction recorded; operations reviewer ___ / Date ___ / Outcome ___.

Validation: core/SDK 517/517 passes, including exact shard-capacity conservation at the new 10M ceiling; whitespace check passes.

## 2026-10-13 — Rolling account write allowances

User requested identical paid-plan write limits and minute/hour/day account protection instead of a monthly physical-write lockout. D086 supersedes D084's foreground account monthly quotas: Free 500/hour and 1,000/day; Plus and Pro both 2,000/hour and 10,000/day, rolling windows. App minute cap remains 120 per app per account, combined account minute cap 240. Shared service 10M/month and archive reserve remain separate. Hour/day history uses bounded conservative minute buckets; retry timing must reflect actual recovery and all blocking windows. Migration must preserve service ledger/credits, recent burst history and fail-closed corruption handling. Product/architecture reviewer ___ / Date ___ / Outcome ___. Independent implementation audit and real browser evidence pending.

The user subsequently explicitly approved moving logical work admission to minute/hour/day and combining it with physical writes. D087: one shared activity ledger admits each covered logical mutation attempt and each bucket-put attempt as one unit; operations may cost multiple units. Account allowances and paid parity above apply to the combined units. The active controller removes old owner/service logical monthly caps and uses the shared 10M/month activity authority; old work/month records and standalone implementation remain historical and their credits are never imported. Independently configurable physical/logical admission flags share the meter when enabled. Product/security reviewer ___ / Date ___ / Outcome ___.

User additionally required all message-delivery APIs to use the same account limits and normal HTTP rate-limit path. Verified contact endpoint and bearer delivery already enter the shared HTTP message abuse policy and recipient receive/guarded blob admission; conversation public ingress and recipient inbox do likewise. Narrow review identified missing cross-origin retry-header exposure and conversation retry timing propagation. Fixes retain the existing HTTP policy, report the denied window's conservative retry bound, and preserve recipient timing through delivery transports/backoff. Actual Worker regression evidence pending.

Final combined-policy verification: core/SDK 531/531; actual Worker 33/33, including message recipient quota and shared HTTP ingress cases; full Chrome 45/45 and focused rolling UI Chrome 9/9; UI state 58/58; SDK/localization 22/22; DOM smoke and Wrangler deployment dry run pass. Independent unified-meter audit 36/36 passes; final message transport audit recorded separately. Updated walkthrough screenshots show one activity allowance.

Final message follow-up: real Worker focused 2/2 verifies reminted bearer tokens cannot replenish recipient allowance, multipart/bearer replay creates no duplicate object, and normal shared HTTP ingress denial exposes Retry-After: 60. Same-origin and remote conversation transports preserve bounded recipient retry timing; queued retry scheduling waits at least that delay. Additional remote contact-token mint throttling regression passes.

Independent final message review passes 19/19 (conversation/Node HTTP and actual Worker message cases), with no focused blocker. Final deployment dry run passes after transport fixes.

## 2026-10-13 — Revised paid storage catalog

User-approved D088 catalog: Free 500MB; Paid $5/year5GB; Plus $35/year100GB; Ultra $250/year1TB, decimalbytes. All paid tiers share existingactivitylimits and paidfeatures. Polar requires three distinct annualUSD products, IDs PAID/PLUS/ULTRA. Existing unversioned oldplus5GB mapsPaid and oldpro100GB mapsPlus; newstate must be versioned so renaming cannot silently upgrade old5GB accounts to100GB. Paidhandle eligibility remains permanent. Implementation, migration, Ultraquota, browser and independent review evidence pending. Product/operations reviewer ___ / Date ___ / Outcome ___.

Catalog implementation: runtime uses free/paid/plus/ultra and catalogVersion2; verified legacy terms map without capacity escalation and retain an original bounded deadline through reconciliation/restarts. Existing ever-paid markers/handleclaims remain valid. Unknown historical product/price orders require operator reconciliation before retiring a prior live catalog. Ultra's aggregate quota and message-domain ceiling are 1,000,000,000,000 bytes; individual object/message/count/cold-archive bounds remain separate. New Polar catalog validates all three products, prices and shared organization.

Backend verification: core537/537, actual Worker33/33, focused billing/migration/Ultra/activity61/61. Independent catalog/quota review69/69 passes, including exact quota boundaries, >100GB logical message admission, expiry, markers and webhook checks. These use seeded accounting and small actual bodies, not a physical 1TB upload/restore. Economics calculator derives plan capacities/prices from the canonical billing catalog, four-tier finite scenarios verified; provider R2/payment rates rechecked. Frontend full-browser and final dry-run evidence pending below.

Final UI verification: actual Chrome46/46 full regression and10/10 focused catalog/integration checks pass; UIstate59/59, SDK/localization22/22 and DOM smoke pass. Newcheckout IDs, exactannualprices, Spanishlabels, 1TBformatting and320px layout verified. Updated walkthrough includes cleanfourcardpricing desktop/mobile screenshots. Backend537/537 andactualWorker33/33 remain passing. Billing staysdisabled; no liveproductpreflight/checkout/deployment claimed.

## 2026-10-13 — Provider-backed regional pricing

User clarified actual prices vary by currency and should come from Polar for the buyer's region. D089: retain the approved USD amounts only as base catalog/economics anchors; active paid UI quotes verified configured Polar fixed prices. Pinned SDK1.0.2/2026-10 exposes no read-only geo-price resolver. Use country as a display hint to select an available common currency, expose a user override, and send that explicit currency to checkout for consistency. No GET/status creates checkout sessions, no locally invented FX conversion, no client amount/product URL authority. Workercountry comes from request.cf; Node discards spoofedforwardingheaders and uses socketIP. Providerzero-decimal behavior must govern formatting rather than IntlISO assumptions. Product/security reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — One Polar webhook and metadata catalog

Product-management events share the webhook with subscriptions, paid orders and refunds, with live API verification on login and billing-sensitive actions. D090: metadata mode pins POLAR_ORGANIZATION_ID, discovers only exact provider-origin-tagged annual fixed-price plans, validates a bounded whole catalog, and publishes an atomic monotonic snapshot. Known paid IDs remain paid/plus/ultra; Free remains local. No product event directly grants an account. Product parameters cover name, storage, rolling-hour/day activity; minute/service/archive budgets remain operator controls. One portable shared registry (Worker Durable Object, Node SQLite) caches public matrices for <=5minutes; ordinary account admission reads validated persisted entitlement parameters, avoiding a hot shared catalog on every write. Invalid/duplicate metadata fails closed without static fallback. Archived products are not subscription revocation proof. Active reconciliation is bounded, API failures never extend paid deadlines or block login/read/delete. Architecture/security reviewer ___ / Date ___ / Outcome ___.

User asked about Polar tier upgrades. Primary provider docs confirm subscription product changes with immediate invoicing, next-invoice proration or next-period scheduling. D091 proposed policy: immediately invoiced prorated upgrades; renewal-time downgrades. Current app uses the authenticated Polar portal and its organization default, not a custom direction-specific policy adapter. No live provider setting changed. API reconciliation must ignore pending future plans for current quota and not grant failed/unpaid upgrades. Billing/product reviewer ___ / Date ___ / Outcome ___.

The user explicitly approved D091's direction-specific policy and requested implementation plus exact product metadata. Owner-confirmed app plan changes must modify the existing subscription with immediate invoice proration for higher tiers and next-period scheduling for lower tiers; durable operation identity prevents duplicate external mutations after uncertain responses. Confirmed catalog price/currency/revision and subscription binding must remain live. Portal plan editing must be disabled operationally to avoid bypassing the app policy; payment/cancellation portal remains available. No live billing mutation or organization setting change is performed without the operator's configured account.

## 2026-10-13 — Finite over-quota retention and generic offload

User rejected indefinite retention after downgrade and requested a grace/cutoff plus practical large-data offload; then generalized destination from S3credentials to any connected storage resource. D092 provisional design: 30-day over-quota retention after effective reduction, growthpaused immediately, read/export/deleteavailable, cleardeadline andmultichannelnotices; no purge enabled beforefunctionalexport+terms+race/safety verification. Ownerkeepselection/wholedata sets preferred overarbitraryfilepruning. Identity/keychain/permanenthandle records remainseparatefromlargepayloadretention. D093: resource-generic copy→strongverify→durablecheckpoint→exactversion source deletion; destination mustwritable/verifiable andlivegeneration/scopevalid. No duplicate credential entryforalreadyconnectedresources. Read-onlyproviders remainunavailableuntilwriterconformance. Download/rclone viaowner-only inventory/export outsideBindleappstoragecontract, resumabletransferindependentofordinaryFreeactivitycaps butboundedbyseparateescape budget. No largeZIP primary andnoSSHrsyncserver. Offload/export differsfromliveexternalbackingmigration; oldappreferences mustnotbesilentlyrewired. Independent architecture/design agent drafting details. Retention/product/operations reviewer ___ / Date ___ / Outcome ___.

Independent designer found a preexisting message deletion crash gap (metadata committed before garbage ownership persisted). Billing/backend owner notified to persist garbage within the same deletion transaction before any physical I/O. Hosted-object deletion already owns its garbage durably.

## 2026-10-13 — Explicit generated-identity signup entry

User requested a distinct create-account action on sign-in now free identities are generated rather than chosen from unregistered emails/handles. The existing dedicated signup endpoint already assigns the identity without an email or handle input. Frontend owner will promote the login-card action to a clear provider-branded create-account button, preserving self-host branding, localization, terms/security checks, credential and recovery setup, and return to existing sign-in. Production signup remains gated by the existing release configuration. Browser flow evidence pending.

## 2026-10-13 — Service-owned billing metadata namespace

User rejected `bindle_plan` because Bindle names the open ecosystem/spec, not the service. Supersedes D090's pending metadata spelling with `3sln_me_catalog`, `3sln_me_service`, `3sln_me_plan`, `3sln_me_storage_bytes`, `3sln_me_activity_hour`, and `3sln_me_activity_day`. Hosted billing policy is outside the Bindle protocol. A bounded configurable `POLAR_METADATA_PREFIX` lets self-hosts select their own service namespace; origin and organization binding remain required. No prior metadata catalog was deployed, so accepting the rejected keys for compatibility is unnecessary. Implementation and independent verification pending. Architecture reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — Billing and explicit-signup implementation checkpoint

Final source implements provider-backed currency prices, atomic metadata registry and signed single webhook, service-owned configurable `3sln_me_` metadata, live bounded reconciliation, owner-confirmed existing-subscription upgrades/downgrades and scheduled-change cancellation. Unknown financial outcomes remain durably locked for recheck rather than issuing duplicate mutations. Accepted upgrades expose at most15minutes provisional capacity with a spent-period marker; pending refund/failure evidence wins over payment proof. Settled refund handling follows live subscription state, not automatic revocation from an event alone. Returning login remains available during exhausted activity budgets/provider outages. Message deletion persists cleanup ownership in the same transaction as logical deletion.

Explicit signup is a prominent localized provider-branded button in sign-in, tested through real passkey creation/recovery and closed-registration/back navigation. Fixed-path MCP/device signup continuation preserves pending context without widening arbitrary redirects. Final frozen source verification: core561/561, actualWorker34/34, independentbilling/activityaudit74/74, fullChrome52/52, focusedfinancialChrome11/11, UIstate67/67 and Bab4/4. Screenshots and walkthrough refreshed; financial screenshots use injected provider fixtures. No live Polar purchase, webhook delivery or production entitlement conformance claimed. Billing and public production signup remain gated. Generic provider offload and finite retention are documented designs; destructive cutoff is not enabled. Final bundle dry run pending. Product/security/operations reviewer ___ / Date ___ / Outcome ___.

Final packaging verification: DOM smoke passes; Wrangler deployment dry run passes against the frozen source. Provider credentials/catalog and real sandbox lifecycle verification remain required before billing enablement.

## 2026-10-13 — Production Polar verification with discount

Direction: use normal production Polar with a discount code instead of sandbox for verification. Local fixtures continue isolated sandbox configuration. Verification must include discounted/zero-total behavior without confusing active subscription quota with the permanent ever-paid anti-abuse handle marker. Provider verification reviewer ___ / Date ___ / Outcome ___.

Production discount preparation identified two real-provider mismatches before live testing: checkout disabled code entry, and permanent handle eligibility required a full-price receipt. Follow-up enables provider code entry and validates positive settled discounted payments separately from zero-total subscription quota. Independent review also found order arithmetic must not depend on `tax_behavior`, which is absent from the current Order schema; inclusive/exclusive arithmetic must be checked from the actual documented amount fields. Implementation/tests in progress.

Discount follow-up final verification: core566/566 and independent billing/payment audit41/41 pass. Provider code entry is enabled; checkout response arithmetic remains bound to the quoted product/currency and authenticated owner. Positive discounted settlement qualifies for permanent paid-handle eligibility; zero-total/credit-only orders do not mint that marker. Negative credit invoices cannot hide an earlier qualifying payment, inclusive order amounts work without an invented tax_behavior field, and tax-only refunds end pending upgrade grace. No UI source changes.

Discount follow-up Wrangler deployment dry run passes.

## 2026-10-13 — Organization-global Polar webhook filtering

User requires ignored acknowledgements for unexpected event types and unrelated products because Polar subscriptions are organization-wide. Review identified signed unknown SDK types and unrelated customer external IDs currently return errors, and unrelated product events can refresh the catalog unnecessarily. Backend follow-up must authenticate raw bodies first, use an explicit supported event set, classify service ownership without unrelated-account effects, handle refund order routing, and preserve actual revocation/archive/tag-removal reconciliation. Invalid authentication remains rejected. Exact recommended11event selection documented; subscription.updated covers all changes/renewals. Independent review and signed-event/no-sideeffect regression evidence pending. Security reviewer ___ / Date ___ / Outcome ___.

Global webhook hardening final verification: core574/574, actualWorker35/35, independentfocused42/42 including the actual multi-request Worker case; registry14/14. Both Polar signature-secret encodings are tested. Authenticated unknown/unwanted events and unrelated owners/products return200ignored; invalid/expired signatures return403, malformed relevant payloads return400. Archived/replaced products and prior customer subscriptions remain reconcilable for revocation. A real Worker test exposed globally retained request-bound catalog stubs/pending I/O; the fix retains only public snapshots across requests and binds remote calls to each request, with concurrent independence regression. No frontend source changed. Final deployment dry run passes.

## 2026-10-13 — Live webhook catalog 503 diagnosis

A reported billing_catalog_mismatch response prompted a regression: a Paid product with annual/count1 metadata and USD/GBP/EUR/MXN fixed prices matches the contract and is accepted. Because catalog validation is atomic across all three plans, generic mismatch could hide missing Plus/Ultra service tags or another price/product condition. Narrow diagnostic patch now reports the plan and failed nonsecret catalog requirement without relaxing validation or returning secret/customer payloads.  Focused40/40 passes; fullcore and packaging evidence pending.

Catalog diagnostic patch final verification: core576/576, focused40/40, Wrangler dry run passes. Actual reported Paid multi-currency shape accepted; missing qualifying Plus metadata has an exact diagnostic regression. No schema/timeout/security relaxation. Includes previously untracked signed webhook routing regressions in this commit.

## 2026-10-13 — Independent public-signup gate

Add independent SIGNUP_ENABLED gate while retaining RELEASE_READY=false and unsigned full release checks. Accountcreation still requires Turnstile, severe IP/subnet/region/global admissions, accepted terms, credential setup and mandatory recovery. The public Turnstile site key is persisted in hosted config; the matching secret stays a runtime secret. Backend gate must agree between config andPOST and failclosed for missingpublic/secret/recovery/encryption keys. Implementation/tests pending; release certification not implied.

Signup gate final verification: core577/577, focusedunit2/2 and actualWorker2/2 pass; Wrangler dryrun passes. Both public config andPOST share prerequisites. Explicitfalse overrides RELEASE_READYtrue; omittedflag retains legacyfallback. Missingcaptcha proof403 and missingpublickey503 create no account. No frontendsource changed, existing explicitsignup/recovery browser regressions remain relevant.

## 2026-10-13 — Free-only automatic account retention

Operator requires newaccountsetup notice recommending notifications for a fewdays usagefollowup (push orassociatedverifiedemail), onlyfree/unpaid. Automatic accountremoval mustexclude paidaccounts and retain identity ofeverpaid subscribers evenafterdowngrade; do not confuse this with explicitownerrequesteddeletion. Guards needed atwarning/scheduling andfinalpurge with fresh durable evidence, includingmigration, outage andupgrade races. Onboarding mustreflect actuallyavailable deliverychannels rather thanclaim inactivepush/email delivery. Backend, frontend andindependent audit assigned nonoverlappingownership; verificationpending. Product/lifecycle reviewer ___ / Date ___ / Outcome ___.

Mandatory activation supersedes optional contact onboarding: hosted signup must verify email or acknowledge an encrypted push challenge before active session issuance. New limited pending setup cookie, email8digitcode, proofgeneration, credential/recovery resumption and separate setup capability flags are being integrated. Existingactive identities are grandfathered; no global active-account lockout added. Operator copy: “For unpaid accounts, we might check in periodically to ask if you’re still using the account.” Repeated attempts/grace then suspension and deletion must be explained; externalprovider data stays untouched while hosted data is purged only by a future verified executor. Sender templates now support bounded suspension/deletion day countdowns; they are not a live scheduler.

Hosted pending config sets PUSH_ENABLED/MAIL_ENABLED/SIGNUP_CONTACT_REQUIRED true. Real maintained WebPush encryption uses nativefetch and fixed known provider origins; local transport3/3, mail14/14+transport total17/17, actualWorker encryption1/1 and actualWrangler-emittedmodule config test pass. Signup remains paused while the mandatoryactivation UI is integrated; existinglogin/billing remain available.

Independent focused activation/retention audit41/41 passes. Retention helper requires trustworthy newidentity provenance and sticky paid-tier protection; it does not infer never-paid from an empty account store or lazy handlemarker absence. Fullfrontend/Worker verification pending. New lifecycle architecture [account-retention](docs/architecture/account-retention.md) records provider-accepted attempt evidence, phased access freezing/reactivation and externalstorage exclusions. User-authorized lifecycle executor remains outstanding; neither delivery nor automatic suspension/purge is claimed. R2primarydocs checked: IA30day minimum,.01GB-month/.01retrieval/noIAfree allowance; account suspension and economic tiering are separate, not a blanket claim of savings.

## 2026-10-13 — Bab in browser, server and static generation

Operator asked whether createLocalization replaces @3sln/bab and whether static pages should use Bab during generation. Confirmed helper wraps actual createTranslator/ObjectCatalogue/ChainCatalogue from exactvendored @3sln/bab0.2.0 with provenance; it is not anothertranslationengine. Browser andserver sharecatalogues; serviceworker build now compiles EN/ES setupnotifications withBab. Landing has an authored English bot/noJS HTMLshell plus localized interactiveapp; documentation is generated with hardcodedEnglish shell/prose. Designdirection: useBab in generators too, explicitlocalizedpublicURLs/lang/hreflang andmatching initialclientlocale. Documentprose requiresactualtranslations; codeexamples/contractidentifiers staycanonical. Staticlanding/doclocale generation remains pending rather than falselyclaiming current docs translated. Reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — Curated public documentation and landing polish

Operator clarified documentation remains English-only and must contain only Bindle specification, application integration and reusable hosting/provider instructions. Public generation now uses an explicit allowlist instead of recursively publishing development documents, removes stale generated tracking pages, and excludes walkthrough assets. Independent review identified mixed normative/tracking paragraphs and exact federation wire-profile omissions; preserving technical requirements while removing signoff tables/operator history is under correction. Internal source documents and reviewer blanks remain in the repository. Publication boundary reviewer ___ / Date ___ / Outcome ___.

Landing navigation drops the redundant “The Idea” anchor while retaining the explanatory section. Selector spacing, 44px targets and a two-row narrow header are under real Chrome verification at1440/390/320px, including Spanish selection and translated hero copy. A visual review caught the320px logo suffix wrapping; correction and final screenshots pending. Current core613/613 and actualWorker37/37 pass; final browser/build evidence remains pending. The separate lifecycle draft has targeted12/12 evidence but no scheduler/suspension/purge integration and is excluded from this activation checkpoint.

Publication review corrections complete:31 explicit public English pages now include the exact federation OAuth/RPC wire profile. Mixed normative paragraphs preserve technical requirements while only tracking sentences/tables and operator history are omitted. Public generation tests4/4 include actual webhook authentication/revocation, portal policy, discounted eligibility, duplicate-email delivery, namespace/recovery invariants and all-page tracking exclusion. Shared browser assets were not mutated during review. Final fullcore617/617 includes12 isolated lifecycle draft tests outside the checkpoint; actualWorker37/37 and Wrangler packaging dry run pass. Fresh320px Spanish landing screenshot independently inspected: logo suffix stays on one line, mobile header clean, no redundant idea link. Full browser/build/walkthrough evidence pending.

Activation/UI/publication checkpoint final evidence: frozen asset build537f64a58fc28f933954; full realChrome57/57 (54 baseline +3 isolated federation) and focused landing/adversarial16/16 pass. Password and virtual-passkey mandatory-contact flows use actual durable Node state and an injected local mail transport, not live mailbox delivery. English desktop/320px and Spanish account-setup screenshots added to [walkthrough](docs/walkthrough.md), appendix29, which stays private to the repository. Routine notification dispatch and automatic lifecycle suspension/purge remain disabled/unimplemented. Reviewer ___ / Date ___ / Outcome ___.

A 320px check exposed normalTurnstile300px overflow absent from local fixtures. Follow-up uses fully visible compact challenge consistently to preserve proof across resize, with a dimension-realistic fixture. Production email/push delivery still unverified; fullrelease certification remainsfalse.

Responsive CAPTCHA follow-up: BrowserProvider explicitly requests compact150x140 Turnstile at all widths so viewport changes preserve the challenge and proof. No clipping, scaling or bypass added. Official [widget configuration](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/) confirms flexible still has a300pxminimum. Fresh assets and targetedChrome17/17 pass, including production-sized iframe bounds across320/390/1440/320 and unchanged proof/render count. Previous full57/57/core617/617/Worker37/37 remain checkpoint evidence; this frontend-only fix received the targeted rerun.

## 2026-10-13 — Balanced language selector inset

Operator clarified the selector issue concerns inner spacing: selected text is inset but the native arrow sits against the right edge. Replace only its visual arrow with a CSS chevron while preserving the native select, keyboard behavior and accessible label. Text and arrow both have12px edge insets, with separate reserved arrow space. Forced-colors mode retains the system control. Browser screenshot/keyboard verification and deployment pending.

Operator supersedes compact CAPTCHA choice: request a rectangular widget spanning its container, visible only when automatic checks require user interaction. Use documented Turnstile size=flexible and appearance=interaction-only; keep real server Siteverify enforcement and proof lifecycle. Flexible has300pxminimum, so narrow form layout must accommodate it without clipping, scaling or challenge replacement. UI agent owns form layout/provider and realistic hidden→interactive browser verification; selector text/chevron equal12px edge insets remain in scope. Reviewer ___ / Date ___ / Outcome ___.

Selector/Turnstile correction final local evidence: build320c527147bff6a97e79;16 baseline browser cases pass, final targeted2/2 pass after restoring the hero's20pxpagegutter. Realistic fixtures cover automatic-hidden and65pxrectangular interactive states in signin/signup/email/device forms at320/390/1440, exact widget/slot width and resize preserving proof. Official before/after-interactive callbacks change spacing only; Cloudflare controls challenge visibility. Selector retains native accessible/keyboard behavior with matching12pxtext/chevron edge insets and system control in forced-colors. Local screenshots independently inspected.

## 2026-10-13 — Conversation storage and contact handoff redesign

Operator requests a design review while testing the app: first-contact email-type messages become conversations, participant-specific conversation grants, independent copies per user and cold-object storage with active Durable Object promotion. Smart design and independent review agents assigned nonoverlapping proposal/review files. Existing implementation uses shared epoch conversation secrets and account-local conversation metadata; current shelving does not include conversation rows. Proposal must reconcile protocol versions, canonical ordering vs recipient custody, admission/fanout/quota, generation-fenced warm/shelf recovery and browser/PWA protocol-handler feasibility. Canonical signed HTTPS contact endpoints remain the baseline; same-provider signed-in/signed-out/new-account and external-provider/app handoff flows require explicit, capability-safe continuations. This checkpoint records design work; no runtime migration, spec version publication or deployment has been performed. Existing implementation authorization remains in effect; a concrete reviewed design should guide later changes. Architecture/security reviewer ___ / Date ___ / Outcome ___.

Additional operator requirements: edits retain transparent immutable history; sender deletion leaves a marker and recipient can inspect content already received. Recipient-owned local erasure and account retention remain separate. Typing/activity heartbeats, presence/status and read receipts are optional sharing signals, distinct from private read state and durable delivery acknowledgements; privacy/TTL/abuse policy must be explicit. Reactions are included as bounded authenticated conversation mutations. Designer and independent reviewer informed; proposal/review and decision reconciliation pending.

Federation correction during review: operator challenged an assumed per-conversation coordinator because participants should routinely use different providers. A provider-local actor can serve federated calls, but an online canonical sequencer remains an availability/control dependency. Reopened design and independent review to compare coordinator-based ordering against independently writable owner replicas, signed immutable events and durable sender-side fanout without a central sequencer. Local DO partitioning must not be part of the public contract. Partition-time ordering, membership/revocation and delivery guarantees must be stated honestly; prior proposal/review do not certify this revised architecture. Protocol/federation reviewer ___ / Date ___ / Outcome ___.

Credential/peer-policy steering supersedes the proposed admin-roster chain: operator leans shared conversation secret plus identity-signed interactions and locally accepted participant whitelist, with all peers able to propose changes and asynchronous participant acceptance. Compare this against initiator-issued per-party credentials and alternatives before fixing the interface. Genesis signature seeds a conversation; it must not silently install a permanent administrator. Local acceptance is directed and cannot consent for other peers. Sender fanout snapshots only its accepted destinations; each recipient independently authorizes display/history/storage. Secret possession alone never establishes identity or approval. Pending/quarantined traffic, secret rotation, partitions, history sharing and no-force-store budgets need exact contracts. Both agents instructed to supersede prior centralized/admin assumptions and re-review this latest model. No implementation or production changes performed.

Identity/discovery decisions from operator: provider manifest advertises directory_url; GET uses one full public handle encoded via handle query, returning stable identity/identity-document information. Host-level manifest remains user-independent; numeric and paid aliases resolve the same UUID. URL userinfo is not a user path. Associated external email addresses are private associations, not public directory aliases. Identity document should contain only necessary public identity/key/protocol metadata, not avatar, real name or bio. Optional contact-scoped profile disclosure reuses existing global discloseToContacts (defaultfalse) intersected with per-link profileFields (defaultempty); revocation/quarantine/expiry and owner field limits remain authoritative. OAuth app-profile permission is distinct. Existing public key endpoint is conversation-specific and can lazily establish keys for active legacy records; generic identity discovery must be read-only over established assigned keys. Proposal/review being finalized; no generic identity endpoint or v2conversation runtime is yet published. Discovery/privacy reviewer ___ / Date ___ / Outcome ___.

Conversation redesign recommendation finalized provisionally in [proposal](docs/architecture/conversation-contact-design.md), independently cross-reviewed in [review](docs/release/conversation-contact-design-review.md). Latest user steering supersedes the earlier single sequencer/admin chain: independent owner replicas with a shared conversation secret plus independent actor signatures and directed local approvals. Signed proposals are individually accepted; no required creator-online/admin authority or instantaneous global whitelist/rotation is claimed. Owner-local actor granularity is an implementation choice; cold storage uses bounded segments, verified checkpoints and durable writer fencing. Message mutations preserve transparent histories and sender tombstones; local erasure is independent. Optional presence/typing/read receipts default off, reactions durable and bounded. All features belong to a versioned public conversation resource contract over existing Bindle RPC and grants.

Canonical HTTP contact links retain machine negotiation and explicit composer flows across same-provider sessions/signup/external accounts. Browser/PWA enhancement uses web+bindle with HTTPS fallback, native bindle only where native apps register it; secret capabilities are not nested into handler URLs. General identity.json discovery follows required directory_url/full-handle lookup, minimal established public keys/identity metadata, and optional contact-scoped presentation. Existing contact-profile disclosure already has global and per-link field controls. No v2runtime, generic directory endpoint, identity document, PWA handler or new contract publication is implemented by this documentation commit. Independent reviewers found no remaining design contradiction after the latest revisions; human reviewer/date/outcome remain blank.

Pending implementation order: finalize canonical wire schemas/proofs/frontiers/errors and exact public contract; implement directory/identity read-only discovery and key continuity; portable replica/approval/fanout vertical slice; durable cold warm/shelf crash recovery; edits/tombstones/reactions and optional signals; contact continuation/handoff; multi-provider interoperability/privacy/abuse/cost validation. Main proof gates include recipient-signed owner-bound ACKs, replay and removal races, bounded unapproved traffic, no retroactive history disclosure, and Node/workerd failure injection. Documentation-only verification: relative links/whitespace checks; no runtime tests or deployment performed.

## 2026-10-13 — Contact-page recipient presentation and owner-bucket archives

Operator requests permitted contact profile details on the link's HTML composer. Frontend now fetches the existing contact-profile representation after live claims, using bounded8KiB/5s/no-credentials/no-referrer/no-redirect transport. Name/bio are literal presentation; recipienthandle remains visible and never retargets from profile identity fields. Profiles remain exact owner/global/link-permission controlled; missing/unavailable profiles do not block composer, revoked links reveal no profile, and stale context cannot overwrite a new target. Existing avatarURL uses an explicit noreferrer/noopener link rather than automatic external requests. Claims/send transport also rejects redirects. New interface copy uses Bab EN/ES;100char names wrap on320px.

Final evidence: fullcore617/617(includes12 isolated lifecycle draft tests outsidemain), focusedstate10/10, actualWorker/fault/retry Chrome3/3, Bab4/4, final localized/maxname Chrome1/1 withsixscenarios. Assetbuild4aedf58b926dd24a28f1 frozen. Independent read-only implementation audit found no new authorization/capability-leak/active-content blocker and attributed evidence accurately. Deployment checkpoint pending; no new profile grants introduced.

Operator's archive requirements incorporated separately into design: coldconversation data and restore metadata live in the owner's bucket with files/messages, protected system namespace and quota, encrypted to the existing recovery encryption public key. Ciphertext download/transfer plus offline restored keys; explicit complete snapshot cut includes accepted hot journals and required restore mappings. Provider retains private keys today, so this is not E2EE. Identity/data migration preserves UUID and key/history continuity, while provider-bound contactURLs/authentication/app/connector access requires explicit reconnect/cutover. Proposal/review remain design-only; no encryption/backup/migration implementation or newdirectory publication claimed. Architecture/crypto reviewer ___ / Date ___ / Outcome ___.

Positive per-link field/global-toggle enforcement remains actual localWorker3/3 evidence. Private walkthrough appendix32 includes the local name-only disclosure screenshot. Updated archive/migration/owner-bucket proposal independently re-reviewed: explicit signed complete snapshot, encrypted segments and system metadata/quota overhead, offline historical erase-frontier limits, no E2EE claim; runtime implementation still pending. Human signoffs remain blank.

## 2026-10-13 — Optional public-handle email bridge

Operator proposes paid-account public-handle SMTP outreach, off by default; header/AI classification distinguishes one-off automated receipts from human conversation requests. Owner rules choose collection, priority and notification behavior; age-based archive/delete plus spam retention requested. Sender invitation must bind an independently verified mailbox/account and wait for recipient acceptance; no email header or model label grants peer identity/admission. Smart design and independent review agents own new proposal/review documents. No inbound Email Worker, DNS/catchall change, classifier execution or actual outgoing email is implemented by this checkpoint.

Primary Cloudflare documentation confirms Clef-flash typed-probability decisions (not a validated spam detector), currently$.038/Minputtokens/nooutputcharge. Inference needs per-account and service spend guards plus evaluation, fixed output labels and no tools/rules from email text. Current rules only match grant/mime/collection with collection/tag/classification/quarantine actions; age, priority and deletion scheduling remain new work. Existing Worker has fetch/scheduled only, and system send binding uses sys.3sln.me roles. Immediate EmailMessage.reply has receiving-domain/DMARC/sender/loop restrictions distinct from delayed structured send. Unknown/disabled recipient generic SMTP rejection is preferred over unsolicited marketing/backscatter; any positive reply requires loop suppression, bounded dedup and provider/authentication eligibility. Paid expiry/disable must fence delayed work without recycling aliases or erasing existing content. Product/security/economics reviewer ___ / Date ___ / Outcome ___.

Public-email bridge proposal and independent review finalized in [design](docs/architecture/public-email-bridge.md) and [review](docs/release/public-email-bridge-review.md). Provisional recommendation: current paid opt-in, finite dedicated intake/mail/AI budgets, deterministic automation receipts, suspectedspam quarantine30days+recoverabletrash7days visibly owner-configured, and pending personal invitations. Sender mailbox control and chosen identity proof are distinct from email authentication; owner approval does not silently approve an unknown key. One bounded compliant immediate live-event reply; one accepted notice only after proposal-scoped mailbox confirmation/consent. Unknown/disabled/ineligible use generic SMTP refusal rather than unsolicited marketing/backscatter. Raw spoofable headers, Reply-To and AI never authorize. AI labels are advisory, cost-capped; archive/age deletion executes only current owner rules with trustedreceive times. Exact MIME/SMTP provenance, proof/state formats, dedup/crash recovery, classifier evaluation and billing/storage/encrypted backup conformance remain implementation gates. No receivinghandler/DNSroute/newsender/modelinference/actualmail has been added. Human signoffs blank.

## 2026-10-13 — Public page system color scheme

Operator reports light landing vs dark automatic Turnstile mismatch. Frontend assigned native prefers-color-scheme support for landing/public authentication pages, preserving existing light palette and matching dark surfaces/text/form controls/heroillustration/logo/focus states. Keep Turnstile's automatic theme and preserve challenge through preference changes. Scope avoids accidentally placing bright console panels against globally changed light text. Paired desktop/mobile light/dark browser snapshots and contrast/overflow/proof-continuity verification pending; no email design or auth safety gates changed.

Public system-theme implementation finalized: public landing/auth/contact/recovery/MCP pages follow prefers-color-scheme with scoped dark surfaces, native controls, matching on-dark logo and visible focus. Signed-in console retains its existing light palette. Preference switches preserve Turnstile instance/proof; button colors switch atomically to avoid transient low contrast. Independent mobile screenshot review caught and confirmed correction of oversized dark selector arrow; regression now requires12px/no-repeat. Finalbuild dbef6fe47d9aeec3614b; relevant branding/landing/profile3cases and CAPTCHA/theme2cases passed, finaltheme1/1 covers320/1440 EN/ES controls contrast>=4.5, focus, overflow, dynamic preference and console palette/logo. Deployment verification pending. UI reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — Guided signup and dedicated receipt/classification budgets

Operator requests one-question-at-a-time signup wizard rather than an overloaded entry form. Preserve mandatory verified contact, terms, credential and downloaded/tested recovery gates; improve progressive disclosure, back/retry/resume, localization and keyboard/mobile/theme behavior. Frontend implementation assigned after frozen theme checkpoint.

Operator also requests per-owner plan-scaled and per-contact-link receipt limits, independently bounded classification, paid opt-in per-link/bridge, and model categories including suspectedspam/conversation/outreach/promotion/verification/codes. Existing receive paths already enforce HTTP ingress, lifetime grant, account quota and combined activity/storage write guards; dedicated receipt limits supplement those. Smart design and independent abuse/economic review assigned; rejection notices must be coalesced and bounded rather than notification amplification. Architecture reviewer ___ / Date ___ / Outcome ___.

Receipt runtime slice provisionally approved: supplemental owner limits in UTC fixed minute/hour/day windows; admitted-new-message attempts rather than accepted-delivery counts. Owner message ceilings free30/300/1000, Paid120/1000/5000, Plus240/2000/10000, Ultra240/2000/10000. Corresponding MiB byte ceilings free16/128/512, Paid64/512/2048, Plus128/1024/4096, Ultra256/2048/8192; contact-parent defaults half. Existing ingress/lifetime/quota/combined activity and physical-write limits may bind earlier; this is not a throughput guarantee. Established authorized matching replay avoids a new debit; downstream failures may conservatively consume admission, with no unsafe refund. Fixed-window boundary bursts remain bounded by other guards. Owner-local durable transaction, bounded parent/state cardinality, no global per-message counter or rejected-attempt writes. Contact invitations and admitted conversation content share the owner allowance; classifier and rejection-alert delivery stay separate pending implementation. Human product reviewer ___ / Date ___ / Outcome ___.

Receipt limiter implemented and independently audited: new portable MessageReceiptBudget supplements contact receipt/conversation invitations and stored conversation events. Atomic owner/local-parent counters, approved plan matrix, confirmed entitlement only,256parent/120KBstatebounds, fail-closed corrupted/clockrollback records, typed429/Retry-After and413unfitpayload. Signed-contact error CORS now uses shared exact route matcher and Vary:Accept. Authorized established replay bypasses new debit and blobwrite; failed downstream remains nonrefundable. Owner snapshot reports messageReceiptAdmission explicitly as admitted-new-message-attempts. Public messaging developer documentation includes defaults/config/retrysemantics; architecture documents retain separate accepted-reservation design. Finalcore628/628 includes12 isolated uncommitted lifecycle draft tests; independentfocused11/11; actualworkerd37/37. Independent audit found no unresolved blocker in this limited scope. Classification/paid per-link opt-in/multilabel results/rejectionsummary delivery remain design-only; no externalmail, model inference, inboundSMTP, DNS or newsender performed. Human signoffs remain blank.

## 2026-10-13 — Neutral dark palette, automatic device QR and public status cleanup

Operator rejects the green dark-page wash. Supersede prior public dark surfaces with neutral charcoal/graphite, neutral text/borders; retain small brand accents and system preference/Turnstile continuity. Frontend owns palette/contrast/screenshots before final wizard publication.

Operator requests phone/TV QR immediately after automatic Turnstile completion, spinner while proof/request/QR are being prepared, widget UI only when provider requires interaction. Implement per-entry one-shot flow, private proof readiness, timeout, cancel/stale-response fences and explicit error retry; retain explicit approving-phone consent and matching-code check. Independent reviewer assigned device delta.

Operator reports Service status footer is misleading. Current modal only displays placeholder service-capability information, with no health/availability probe. Remove its landing-page entry; no real uptime/status endpoint or external status page is introduced. Future status reporting must use actual health/incident data, separately from development readiness. UI/product reviewer ___ / Date ___ / Outcome ___.

Operator requests intentional consumer marketing focused on quickly understood value. Landing now leads with apps/files/choice and three concrete benefits: sign in to compatible apps with per-app access decisions, use included or connected storage, control contact links. Recovery/key-management details stay in setup/security flows; no E2EE, zero-spam, active email-bridge or universal-app compatibility promise is added. Authored crawlable HTML and Bab EN/ES copy must mirror the same benefits; responsive screenshots and layout checks pending with frontend final build.

Device cancellation audit found a real cross-record race: consumed handoff could create a valid session after Cancel. Provisional fix links consumed request to only its issued session hash, cancellation marks/fences owner revision even if target not yet saved, issuance never retries prepared account CAS, and post-save cancellation rechecks perform exact compensation. Successful cancellation requires proven removal/fencing; already issued cookies may arrive but confer no authority after revocation. No new authentication hot-path lookup or blanket session revocation. Legacy consumed requests without linkage cannot claim revoked sessions; bounded cleanup uncertainty must be shown honestly. Independent backend review/race tests pending. Security reviewer ___ / Date ___ / Outcome ___.

Final integrated portal checkpoint: assetbuild1fcee438b80c6a9d365a frozen. Guided method/contact/email/terms/credential signup, pending emailaddress/code orpush delivery screens, existing downloaded/tested recovery gates retained. Native emaildrafts remain browser memory only; password submitted once then cleared; denied browserstorage cannot retain stale private setup. Back/locale/modal/theme preserve relevant inputs, entering wizard focuses heading. Blank/reused CAPTCHA proof cannot submit signup; submitted attempts reset existing widget for a fresh proof, stale callbacks fenced. Pause synchronously cancels KDF/clears local authority/navigates; late credential, encryption, recovery and activation projections are fenced without claiming reversal of already submitted server operations.

Phone/TV now starts one request automatically when private Turnstile proof is ready; spinner while preparing, interaction-only widget, bounded startup timeout and explicit retry. Readiness routes through real #app intent listener (also fixes inherited push-proof event routing). Entry generation/accountcontext/offline/late-response fences, retained private request code, poll-error hotloop prevention, and honest uncertain-cancel messaging. Backend cancellation race fix has independent9/9 deterministic checks; actual localWorker Chrome demonstrates automaticQR then explicit matching-code phone approval to the same account.

Independent frontend/security audit found no unresolved blocker in this scope: own28/28 action/provider checks, inspectedUIstate82/82 and finalfocusedChrome18/18. Coordinator finalcore637/637 (12 unused uncommitted lifecycle model tests excluded from the commit), actualworkerd37/37. Independent desktop/mobile visual checks confirm neutralcharcoal, balancedselector, beneficiarymarketing and no public status-placeholder entry. Browser screenshots includeEN/ES,320/1440,light/dark, all signupsteps and localWorker TVhandshake. No production account, message, email or modelinference was created by these localchecks. Deployment/CI finalverification pending.

CI investigation: latest mainChecks run38472580651 had55/57 browsercases pass and two notification fixtures timing out on disabled controls under Linuxnativepermissionstate. Core/Worker/DOM/build checks passed. Make fixturepermission explicitlydefault beforebootstrap; retain actual denied/unsupported checks and old-service-worker no-false-proof/no-permission-call assertions. No forced clicks, skipped tests or weaker production guards. Final LinuxCI proof remains pending on the upcoming commit.

Actual local Worker automatic QR + explicit phone approval and deterministic cancellation races remain separate evidence. Classification/alert sender/SMTP bridge/v2 encrypted archives remain separate pending work; production releaseReady gate remains false.

## 2026-10-13 — Static landing and separate console routing

Operator requests immediate authored landing HTML at `/`, with the account application at `/console`. Frontend owns `index.html`/`index.es.html` static documents, `console.html` application shell, build assets, optional narrow landing enhancement, browser navigation and service-worker migration. Shared Worker/Node HTTP routing now selects the console shell for `/console` and existing contact/device/email/recovery/MCP/Google continuation pages while preserving their public URLs and recovery CSP. Root GET/HEAD with `signin`, `signup` or `return_to` uses a private same-origin307 to `/console` with unchanged query; the redirect never interprets or follows a return target. `/console/` canonicalizes similarly. Plain root performs no account/session lookup or server-side personalization. Exactly one `lang=es` query selects Spanish static HTML; other inputs default English, with no language cookie or Accept-Language variation. Worker assets follow only exact same-origin internal console/Spanish HTML canonicalization; Node's existing file adapter serves those same explicit filenames. Routing tests and independent review pending. Architecture/security reviewer ___ / Date ___ / Outcome ___.

Backend routing verification: shared handler/real Node temporary-file host tests pass7/7, actual localWorker canonicalization tests pass5/5 including console and both generated offline landing snapshots. Successful static root responses are deliberately public,max-age=0,must-revalidate, identical across sessions; console/contact/continuation pages remain no-store. Escaped host branding replaces only the marked static logo contents. Independent routing review initially passed6/6 before the final branding case. A concurrent fullcore run completed642 with637pass/5fail solely from frontend's in-progress offline-generator fixture migration; final integrated rerun remains required after source freeze. No build/deploy performed by backend owner; human signoffs remain blank.

Backend routing final core rerun after the frontend offline fixtures settled: npm test644/644 pass, log `/tmp/bindle-landing-routing-final-core.log`; focused routing7/7 includes literal replacement-character host branding. Prior5fixture failures are resolved in this later run. ActualWorker routing5/5 remains separate evidence. No backend-owned build/deployment; integrated browser/UI verification and human signoff remain pending.

## 2026-10-13 — Conservative100000 account admission ceiling

Operator requests a global cap of100000 free users. Provisional safe checkpoint raises existing SIGNUP_MAX_ADMISSIONS ceiling and portable fallback from1000 to100000, preserving the same durable signup:lifetime-admission key/count. Node now forwards the same environment configuration. This is deliberately lifetime admitted attempts, not concurrent/current-free census: pending/failed/paid/deleted admissions remain charged and upgrades never free slots, so later paid expiry cannot oversell reusable capacity. Existing hourly/daily/network/CAPTCHA gates remain. Invalid configuration and corrupt counts fail closed. True reusable free slots require a separate reviewed billing-expiry/downgrade/import/reservation lifecycle and full-capacity product policy; finite sharded leases are documented as a later optimization, not introduced now. See [capacity semantics and migration gate](docs/architecture/free-account-admission-cap.md). Before asserting total service population coverage, inventory/debit any older account cohort not covered by the original counter; no production inventory or reset is performed. Focused admission tests6/6 passed before final strict-type extension; fullcore pending. Product/security reviewer ___ / Date ___ / Outcome ___.

Admission-cap implementation verification: strict final focused7/7 passes, including actual Node signup with environment cap1, explicit config override2 and preserved durable stock across restart. Concurrent final-slot, corrupt/configtype and lower-limit checks pass. Fullcore647/647 passed before the added Node integration case; final test-inclusive rerun in progress. The implementation does not free slots on billing or deletion and does not reset the existing counter. No production counters, account data, build or deployment changed.

Final cap-inclusive core run648/648 passes (`/tmp/bindle-admission-cap-final-tests.log`), including Node restart/config precedence. Independent cap/economics cross-review assigned separately; human signoffs remain blank. No production capacity/baseline reconciliation was performed.

## 2026-10-13 — Free-account funding sensitivity

Operator requests a 100,000 free-user ceiling and monthly/yearly exposure. Existing durable admission stock is conservatively capped at 100,000; pending/failed setups and accounts later paid/deleted retain admission charges. No automatic slot reuse or counter reset is introduced. This upper bound requires any older/imported retained accounts to be included in the baseline; it is not a live free-account census. Full active free-slot reuse remains a separate lifecycle design.

Coordinator added [funding sensitivity](docs/architecture/free-account-cap-costs.md) and reproducible offline [calculator](scripts/free-account-cost-model.mjs), using primary Cloudflare rates verified today. At 100,000 full 500 MB quotas, single-copy logical payload is 50 TB: approximately $750/month or $9,000/year in Standard R2 storage alone before shared allowance. Explicit low/moderate/full-and-high-activity hypotheses total about $56/$455/$3,406 per month; none is a measured forecast or invoice ceiling. Existing 10M combined activity/write units, semantic membership/spend estimates, signup throttles and actor shelving are distinct controls. Read/anonymous traffic, fanout, SQL/index bytes, actor awake duration, replicas and notifications still prevent a proven all-in spend maximum. Recommend a funded 10,000-account review milestone before approaching the authorized ceiling; no lower cap imposed without operator direction. Product/funding reviewer ___ / Date ___ / Outcome ___. Independent review pending.

## 2026-10-13 — Public machine-readable contract registry

Operator reports unresolvable artefact links and contract identifiers serving prose. Add an explicit catalog of five existing RPC contract JSON Schemas and a separately labelled conversation-v1 submission schema. Generated `/artefacts/contracts/` registry and `index.json` point directly to unchanged machine JSON; canonical extensionless identifiers return JSON even with browser HTML Accept. Exact `.json` and older source/raw aliases resolve identical bytes, with public CORS, bounded methods and no account lookup. Existing documentation links/nav and agent index point to the registry/direct definitions. Proposed v2 and superseded automation fixtures remain unpublished; build removes stale artefacts outside the allowlist. Machine definition `$id` is checked against the catalog at build time. Shared/temp-publication tests7/7 passed; actualWorker canonicalization tests running. No frontend build/deployment performed by this owner. Protocol reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — Revised signup cohorts and system contact direction

Latest operator direction supersedes the first 100,000-only free admission proposal: free-origin signup admission stock is 10,000; overall signup admission stock (including paid) is 100,000. One existing durable authority must atomically migrate and maintain both counters without reset, with old stock conservatively seeded into free-origin stock. Paid pending setup bypasses only free-origin capacity and cannot activate until live verified subscription proof plus existing credential/contact/terms/recovery gates. When free capacity closes, offer paid signup and email-confirmed waitlist; when global capacity closes, both signup paths stop. Authoritative stale-form errors are separate from bounded cached public availability. This caps cohorts, not current free users after paid-origin subscription lapse. Implementation/review underway; human product signoff ___ / Date ___ / Outcome ___.

Operator replaced the unshipped developer feedback form with a contact token for the protected developer identity. The form/service/mail implementation was removed before commit/deployment; its review is historical. Reserve internal handles and render a trusted platform/system badge; provide a generic operator-issued bootstrap for system accounts, not a Ray-only path. Latest access threshold is below 1,500 active users for everyone, otherwise paid users only. Active-population definition and exact Ray provider identity remain explicit user clarification gates.

Operator then simplified contact issuance: users explicitly request a contact token, granted for the current day with a clear refusal reason otherwise. Eligibility is checked at issuance. They explicitly withdrew eligibility-loss revocation; do not introduce ongoing billing checks, per-message policy lookups or reconciliation of permanent developer links. Daily expiry plus ordinary recipient revocation/rate controls suffice. These latest instructions supersede the prior automatic/permanent contact and non-resurrection design. Architecture/implementation review pending; human signoff ___ / Date ___ / Outcome ___.

## 2026-10-13 — Separate free/overall signup stock, paid setup and confirmed waitlist

Supersedes the earlier single100000/free-user interpretation: preserve the existing global admission authority and count, atomically add a free-origin cohort count initialized conservatively from legacy global admissions. Overall limit100000; free-origin limit10000. Free attempts debit both; paid-pending attempts debit only overall, with additional5/hour25/day paid admission guards. Failed/pending/deleted/expired-paid admissions are never refunded. This is lifetime admission stock, not current-free occupancy; paid-origin accounts retain the existing eventual free fallback. Pre-counter production inventory reconciliation remains a release gate.

Public `/api/signup/status` is a bounded advisory read, with one original60second expiry shared across memo/edge/public cache layers, no visitor-dependent cache keys and no identity bootstrap. Stale forms receive authoritative `signup_capacity_reached`503 with free/global distinction and no invented reopening deadline. Paid setup keeps immutable plan/incarnation and a24hour checkout-start deadline; the reviewed catalog price digest, exact UUID/customer/product/organization and setup metadata bind one durable checkout lock per owner regardless of caller request ID. Unknown provider outcomes cannot auto-create another checkout. Current exact-plan active or canceled paid-period proof, verified contact, primary credential and tested recovery are required before first owner session; permanent paid history, provisional upgrades and past-due grace do not activate pending accounts. Existing active-account recovery remains independent of signup capacity.

The shared Worker/Node waitlist uses1000pending/10000joined limits,10minute explicit mailbox-confirmation POST,180day membership, encrypted email/HMAC indexes, separate deletion-only withdrawal proofs and bounded32-row cleanup alarms. IP/subnet/target/global work/mail controls precede durable admission; the mail attempt is claimed before external delivery and ambiguous sends are not retried/refunded. Joined-address management can recover deletion access without extending retention. Mail GETs never subscribe, waitlist membership creates no account or reserved slot, and no automatic invitation campaign is included. Existing verified system mail adapter is reused; tests send no real email.

Implementation/design: [signup capacity and setup boundary](docs/architecture/signup-capacity-paid-waitlist.md). Local initial full core669/669 passed before final additional boundary tests; focused paid/capacity/waitlist24/24 passed. Final full-core and independent review pending. Human product/security reviewer ___ / Date ___ / Outcome ___.

Independent review found and fixed a preactivation paid-recovery bypass: a downloaded recovery file could change pending to recovering before payment. The durable initialPaymentRequired marker now survives that transition and is cleared only with successful paid activation. Added exact exploit and already-activated/lapsed recovery regressions; focused paid6/6 passes. Independent recheck and final core rerun pending. Reviewer ___ / Date ___ / Outcome ___.

Independent paid/capacity/waitlist review reran26/26 focused tests and the original recovery exploit; it now returns payment_required without a session. The first-activation marker also preserves recovery after later subscription lapse. No further structural blocker reported. Expired ready-checkout URLs and provider-unknown attempts deliberately require explicit operator reconciliation; a free status does not safely authorize replacement or reset. Final npm result pending. Human reviewer ___ / Date ___ / Outcome ___.

Final paid/capacity/waitlist backend checkpoint: `npm test` passed674/674 in `/tmp/bindle-paid-waitlist-reviewed-core.log`, including the paid-recovery correction and Node alarm restoration. Independent focused26/26 and exploit recheck passed; review records no remaining backend blocker in [signup/waitlist review](docs/release/signup-waitlist-review.md). Registry separate shared7/7 and real Worker2/2 evidence remains in its review. Frontend/build/provider integration is a separate coordinator checkpoint; no production purchase, email, deployment or counter reset occurred. Human reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — Owner Views and unified incoming projection

Under the latest unified-store instruction, the reviewer/architect implemented the first reversible backend slice described in [message Views](docs/architecture/message-views.md): saved owner Views with revision-checked edits/deletes; typed indexed `/api/incoming` queries; normalized tag indexes; authenticated owner/filter/View-bound cursors that report `cursor_stale` after index changes; bounded legacy backfill. Existing collection partitions and app/MCP authority remain untouched and independent of saved filters. No message body/archive scan or AI work is used by metadata filters. View deletion never deletes retained content.

Retained conversation event messages project to one source/room card with stable ID, first/latest retained times, any-event unread state, latest-event tags/classification and retained event count. Empty/no-delivery rooms remain in the existing conversations API; invitations remain incoming messages. Room-level tag/read mutations, destination-free frontend and new public contract publication are not claimed by this slice. Added metadata indexes consume SQL/storage overhead; bounded grammar/page size does not imply constant SQL rows read.

Focused Views+scaling30/30 and full core698/698 passed (`/tmp/bindle-views-focused.log`, `/tmp/bindle-views-core.log`). Actual Node route checks cover session, Origin, CSRF, allowed methods, strict parameters and stale revisions. Other concurrently owned changes/known lifecycle drafts in the full suite remain independently scoped. Root source cross-review and integrated Worker/browser checks pending; no build/deployment/provider mail was performed. Human product/security reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — Generic protected system identity bootstrap

Implemented the provisional [system identity invitation design](docs/architecture/system-identities-contact.md) and [operator runbook](docs/architecture/system-bootstrap-operations.md). A separate HMAC key authenticates exact origin, purpose, protected handle, role, stable owner/assignment, nonce and at most seven days of validity. An optional pinned email applies through initial activation, including preactivation recovery. The ordinary credential, verified contact and downloaded/tested recovery gates remain mandatory. The projected system/developer badge grants no administrative authority.

Node and Worker reserve the permanent alias and setup browser before creation, deduplicate the overall-only admission debit with a durable nonce/full-claims receipt, and verify the immutable provenance marker on account creation and updates. Concurrent requests create one owner. Lost acknowledgements never reset namespace ownership or issue fresh setup credentials from a consumed invitation; unfinished passkey setup can require explicit operator reconciliation. Existing assigned/tombstoned names are not overwritten. Expiry is checked again before account creation after credential work. The internal system admission lane is unavailable through public signupPlan.

The private CLI writes exclusive 0600 key/invitation files, rejects symlinked or publicly readable key inputs and emits no secret stdout. No actual provider secret, invitation or production identity was provisioned. Frontend import and provider deployment remain separate coordinated work.

Final focused bootstrap14/14, actual Worker bootstrap1/1, and full `npm test`701/701 passed (`/tmp/bindle-system-bootstrap-final-focused.log`, `/tmp/bindle-system-bootstrap-final-worker.log`, `/tmp/bindle-system-bootstrap-full-core.log`). Tests cover both durable adapters, crash acknowledgement ordering, concurrent/replayed/copy-browser use, unsafe file handling, protected-name conflicts, preactivation email/recovery and no session before setup. Coordinator/independent source audit remains a separate gate; local injected transports do not prove real mail or provider delivery. Human security/product reviewer ___ / Date ___ / Outcome ___.

## 2026-10-13 — Actual recent-activity source for daily developer contact policy

Implemented the provisional [active population source](docs/architecture/active-population.md), using authenticated owner use within 30 days as the working definition of active and 1500 as the issuance threshold. This is distinct from overall/free-origin signup stock. Thirty-two existing AbuseGuard actor names store unique-owner expiry-day rows and small aggregate buckets; confirmed daily owner metadata suppresses repeated source calls before the existing 15-minute activity coalescing return. No message ingress, typing heartbeat, public counter or receipt-time developer entitlement check was added.

A bounded 100-account census with durable minute alarms initializes existing identities and merges concurrent newer activity. The source returns unavailable until completion; it does not invent a zero baseline. Legacy 15-minute activity uncertainty adds a conservative temporary allowance, and unknown historical activity is counted conservatively. Completed baselines pin shard generations. The policy cache expires absolutely after 60 seconds. Node restores the census alarm; Worker reuses the existing class/bindings and scheduled hook.

Coordinator review rejected coupling optional metrics failures to authentication. The final implementation preserves pending daily activity, attempts rare-source invalidation, backs off retries, and keeps normal login/read/recovery available. Known failures suspend permissive population snapshots until reconciliation; partitions that prevent both recording and invalidation can temporarily lag the observed count. This is a growth-policy metric, not an instantaneous security ceiling. Recent lifecycle changes can conservatively age out rather than immediately subtract. These limitations and the still-provisional product definition are explicit in the architecture document.

Final population/work-audit focused19/19, actual Worker population1/1, and `npm test`710/710 passed (`/tmp/bindle-active-population-focused-final.log`, `/tmp/bindle-active-population-worker.log`, `/tmp/bindle-active-population-core-final.log`). Node restart, interrupted census, concurrent merges, bounded state, expiry, clock rollback, corruption, shard replacement and nonblocking failure paths are covered. No production census/account mutation, build or deployment occurred. Coordinator source audit and integrated issuance/UI remain separate gates. Human product/security reviewer ___ / Date ___ / Outcome ___.


## 2026-10-13 — Messages, conversations and Views: product model confirmation

User explicitly confirmed that there should be no user-facing inbox containers: retained messages/conversations belong to one logical incoming store, and configurable Views are filtered projections. Views may overlap, and deleting a View does not delete its items. Contact required/optional tags and owner rules supply organization. Existing collection authorization partitions remain a compatibility detail until a separately reviewed migration; editing a View never broadens app or agent authority. Public messaging/contact drafts now distinguish this model from their retained legacy APIs. Frontend migration and conversation-card read/tag persistence are being independently reviewed; completion is not claimed by this log entry.

User direction confirmed in conversation. Implementation sign-off: reviewer ___ / date ___ / outcome ___.

Views follow-up: root review identified latest-event tags as an organization-loss risk. A persistent owner conversation overlay now carries tags/classification and revision independently of event arrivals/deletions; it survives an empty retained history and later replies. `PATCH /api/incoming` requires organization revision, and mark-read additionally requires the displayed activity revision. A local arrival-order watermark prevents later/equal-timestamp replies being marked read by a stale action; it emits no shared receipt or legacy event rewrite. Unshipped builtin `inbox` is replaced by `all` / All messages. Frontend received exact fields. Focused Views10/10 pass in `/tmp/bindle-views-persistent-final.log`; integrated core rerun underway. Persisted overlays and event sequence mapping are owner configuration/read state and must be included by future complete export/restore, not discarded as reconstructible indexes.

Independent active-population audit found an optional RPC could hang owner use despite caught errors. Designer bounded touch/invalidation waits while preserving durable pending retries and uncertain-commit idempotency; independent focused11/11 pass in `/tmp/bindle-population-independent.log`. Absolute cache leases, initial/generation baseline gates and double-partition lag are documented honestly in the [review](docs/release/system-identity-contact-review.md). No remaining narrow blocker; product active-definition and production baseline approval remain blank. Reviewer ___ / Date ___ / Outcome ___.

Population independent review follow-up: stalled optional RPCs are now bounded to 250ms for recording and at most a further 100ms for invalidation. Timed-out idempotent work may still commit; pending retries remain durable. An unrelated earlier account alarm now re-arms a future pending retry instead of losing it. Independent focused11/11 passed after both corrections, with no remaining narrow source blocker reported. Product definition and first production baseline remain unsigned.

## 2026-10-13 — Daily developer-contact grant audit and crash-safe deduplication

Independent implementation audit found two blockers in the new issuance-only helper: the internal day/tier pointer could be overwritten by concurrent grant creation, and a committed parent with interrupted endpoint/URL finalization could become permanently unusable. Fixed the existing contact hooks so pointer reuse atomically checks its exact binding and unchanged scope, mandatory/optional tags and limits; concurrent requests reuse one parent. Endpoint completion preserves existing audience/claims/quarantine, and URL persistence keeps the first committed encrypted signature. A crash before completion resumes that same parent. Revoked daily grants are not replaced.

Expired internal-grant cleanup checks owner/id and removes a pointer only when it still references that parent. Ordinary contact grants, already received messages and receipt records remain intact. The route derives recipient, beneficiary and tier from trusted server context; caller-supplied recipient/tier fields are rejected. Fresh confirmed base entitlement excludes provisional upgrades, past-due state and expired/stale proofs. Eligibility is checked only for issuance: the daily bearer remains usable under normal contact limits until expiry/manual revocation, without a new beneficiary payment/population check on receipt.

New developer-contact focused9/9 passed; combined contact/endpoints/tags/population focused36/36 and full `npm test`723/723 passed (`/tmp/bindle-developer-contact-audit-focused.log`, `/tmp/bindle-developer-contact-audit-core.log`). Tests use local durable metadata and injected storage, with no production account or external message. Coordinator final source review and integrated Worker/browser validation remain separate. Human security/product reviewer ___ / Date ___ / Outcome ___.

Final Views correction core checkpoint: npm test723/723 passed, exit0, `/tmp/bindle-views-population-final-core.log`; focused Views10/10 and independent population11/11 pass. Source remains frozen for coordinator cross-review and frontend integration. No publication or provider verification claimed. Human reviewer ___ / Date ___ / Outcome ___.


## 2026-10-14 — Interactive message forms/actions: design and security spike

User proposed restricted forms in messages, button-only notification actions, credentialless submissions with optional account signatures, and postback updates retaining visible message history. This is design/spike work, not an authorization to loosen the existing renderer policy before review. Three independent tracks are examining action semantics, renderer/credential threats, and a controlled browser spike. The current frozen app/build remains unchanged by this experiment.

Provisional direction: declarative actions executed by trusted host code; no sender scripts or native uncontrolled form submission. An action result is separate from a conversation reply unless explicitly declared. Postback appends a local presentation revision and preserves the original and prior states; it cannot mutate shared conversation history or expand grants. Shadow DOM may scope message styling inside an isolated renderer, but is not the security boundary. Remote resources are blocked by default, with a separate deliberate user decision; author CSS must not style trusted recipient/identity consent controls. Target, action, message revision, fields and any optional identity signature are bound together and revalidated before dispatch. Unknown delivery outcomes require reconciliation rather than blind repeat execution.

Open decisions include exact endpoint trust/delegation rules, inline control rendering, signature encoding/reuse of existing protocols, and which notification actions may execute directly. See forthcoming [action design](docs/architecture/message-actions.md), [security review](docs/release/message-actions-security-review.md), and [controlled browser spike](docs/release/message-forms-browser-spike.md). Human architecture/security sign-off: reviewer ___ / date ___ / outcome ___. No form support, postback deployment or cross-browser security guarantee is claimed here.


User refined the pipeline: sanitize into an inert fragment, traverse it to enforce policy/install controlled form handlers, then mount; native `setHTML()` requires an Element/ShadowRoot context, with template content under browser investigation. Detached parsing alone is not accepted as a network-suppression guarantee. User also requires an unavailable-native fallback: provisionally a lazy, pinned, self-hosted DOMPurify module behind a local adapter, followed by the same form/URL/resource/CSS validation. It must not silently substitute raw `innerHTML`; failed sanitizer loading yields a readable safe text view with actions disabled. Browser spike and independent review are incorporating both refinements; the existing application renderer is unchanged.


User clarified notification/result behavior: derive concise notification text/actions from each message; selecting an action opens the message and displays a submitting state. Successful local postback appends an edit/history revision; a redirect or a declared `_blank` postback opens a new tab; ordinary success/error produces a bounded status toast. Design agents are aligning the proposal and review with this flow. Redirects are captured as validated navigation intents, never automatically followed with submitted fields/capabilities/signatures, including 307/308. External navigation is a distinct browser visit and may use that site's ordinary cookies; cookie-free form transport remains mandatory. New-tab HTML results require the isolated sanitized viewer, never unchecked HTML in a privileged top-level app document.

Notification extraction will favor validated explicit summary/action metadata, then conservative plain-text title/heading/body fallbacks. Actions must map to validated supported form/action bindings rather than inferred arbitrary links; field values, hidden markup and credential material are excluded. Direct notification clicks open foreground review/status; browser action support is feature-detected. This is a provisional deterministic heuristic, not permission inferred by AI or a claim of comprehensive CSS visibility analysis. Sign-off remains with the linked message-action proposal/review.


Coordinator reconciled the proposal and independent review. The controlled Chrome 155.0.8059.80 spike passed 11 checks: custom native sanitizer retained forms/styles while removing scripts/handlers; `template.content` staging made no observed requests before insertion; a detached live-document element did request an image before traversal; Shadow DOM alone allowed overlay/network behavior; the isolated CSS-enabled frame clipped overlays and denied remote/native submissions; credentialless fetch omitted seeded cookies, ignored Set-Cookie and refused redirect following. Evidence is scoped to the fixture and installed Chrome, not the complete interactive renderer, DOMPurify fallback, OS notifications, broker SSRF isolation, signatures or cross-browser conformance. Independent design review found no remaining structural blocker; product/security sign-offs remain blank. No application runtime, frozen build or production release was changed by this design/spike.


## 2026-10-14 — Ordinary identities for application senders

User requires messages, including application messages, to be signed and notifications to identify the verified sender handle/application with an icon where available. Preferred direction: an app uses an ordinary Bindle identity (stable identifier, handle/aliases, provider discovery/directory, signing keys and optional shared profile), rather than a separate app-only sender/key registry. App connections remain user-owned resource/grant records, distinct from the application's sender identity; one app identity can have many users' independent connections. Apps may use an existing provider; each app need not operate its own directory service.

Provisional permissions model separates authenticated sender identity from recipient-issued delivery authority. Login never automatically permits messages. A recipient can issue a sender-bound, limited/revocable contact grant, visible as a messaging permission in Connected apps, without placing a raw capability into a shared preferences fragment. Generic identity block controls apply to apps and people. Every authenticated notification derives sender labels from verified message provenance and approved profile data, not sender HTML or arbitrary senderMetadata. Names/icons are descriptive; the verified handle/domain remains visible.

Frontend-only apps cannot safely keep a global app private key. A generic explicitly enrolled/delegated signer or verifiable connection provenance must preserve the real actor/delegator; a public client ID, registration or recipient consent cannot authorize signing as the application's global identity. Signed-message migration needs a versioned envelope and must not relabel legacy unsigned records, bridged email or receiver attestations as original-sender signatures. These points are being independently reviewed in the sender-identity proposal/review; no runtime signing enforcement or sender directory deployment is claimed.

Notification resource policy also needs local cached bounded raster avatars or a neutral fallback: the Notifications standard specifies credential-including resource fetches, so direct sender-controlled icon URLs can undermine privacy even when form dispatch uses omit. Human architecture/security sign-off: reviewer ___ / date ___ / outcome ___.


The [ordinary sender identities proposal](docs/architecture/message-sender-identities.md) and [independent review](docs/release/message-sender-identities-review.md) are now complete as provisional designs. The [message actions proposal](docs/architecture/message-actions.md) has been reconciled with the identity/signature model. Independent cross-review found no structural blocker, including the distinction between app-owner signer delegation and recipient consent, authority/key-qualified stable principals (foreign providers cannot impersonate by claiming the same UUID), and private per-connection delivery bindings. No public profile/envelope artifact, runtime sender enforcement or notification-branding implementation was introduced by these documentation changes. Human signoffs remain blank; cryptographic schemas, migration and durable/cross-provider conformance are explicit implementation gates.


## 2026-10-14 — Browser app notifications use app connections, not contact identities

User refined the app-messaging direction after considering public frontend clients: app notifications are domain/application-bound, invoked through the Bindle SDK, with no contact link/token. This supersedes the previous ordinary-app-identity/delegated-signer requirement for this browser-originated owner-notification path. Ordinary federated identity messages retain their separate author-signature and recipient-admission model; backend apps may still act as identities when appropriate.

Provisional architecture reuses the owner's approved app-connection/resource/RPC grant with an explicit create-own-notification method. Recipient, app identity/client, canonical exact origin and trusted presentation derive from the provider's immutable approved binding and live token/grant; caller fields cannot select another sender or recipient. Messaging is a separate consent, not a login side effect. No raw contact capability or app-held global signing key is needed. Host-signed stored provenance records prove what the provider admitted under the connection, not a publisher's independent cryptographic authorship.

Browser protection requires server-side matching of the browser-controlled Origin to the exact app origin bound to that token before any effect, strict CORS, and rejection of absent/null/wrong origins for this profile. The existing general federation endpoint's missing-Origin/provider-origin exceptions are not sufficient and must not carry into this method. SDK code loaded into another website runs under that website's origin; a legitimate cross-origin app iframe retains its own origin, and the parent cannot override it through ordinary browser JS. Cross-frame message handling must not become an unauthenticated notification relay.

This is browser-origin isolation, not remote code attestation: public client identifiers, headers from nonbrowser HTTP clients, copied bearer credentials, and DPoP do not prove the application's publisher authored a message. Capability remains owner/connection limited; verified service assertions need a separate authenticated workload/identity path. The designer/security reviewer are reconciling these guarantees and supersession notes; no notification SDK method/runtime gate is implemented by this log entry. Human architecture/security sign-off: reviewer ___ / date ___ / outcome ___.


Final provisional [app notifications design](docs/architecture/app-notifications.md) and [independent review](docs/release/app-notifications-review.md) are recorded. Earlier sender/action proposals explicitly distinguish this superseding browser path from signed federated sender identities. SDK `notify` is a convenience over one exact owner-local resource method/grant, not an alternate transport/authority system. Toggle changes cannot widen previously issued token scopes; fresh explicit grant acquisition is required. Finite receipt/outbox state preserves unknown outcomes without inventing a second operation. Source review confirmed browser-origin gates are missing from the existing general RPC exceptions, so this profile is not currently implemented. Cross-review found no remaining structural design blocker; browser/Node/Worker validation and human signoffs remain open. Documentation-only work; no runtime, build or production changes.

## 2026-10-14 — App messages and credentialless form results implementation checkpoint

The implementation supersedes the preceding documentation-only checkpoint: SDK `userMessage` uses the owner-local `app-messages/v1` contract, with explicit consent, exact browser-origin checks, provider-signed admission provenance and the automatic `app-message` delivery tag. SDK input has no action descriptors; ordinary HTML forms and marked links supply renderer-derived actions. Public contract and preference JSON are included in the curated registry.

The prepared form broker separates authenticated owner review/preparation from cookie-free dispatch. Purpose-bound short-lived MAC verification precedes actor routing; dispatch rechecks live account/app authority, consumes its capability and persists pending intent atomically. Unknown network outcomes are not silently retried. Optional transport defaults to disabled until destinations are operator-approved. Only original verified app HTML has submission authority; owner-local result revisions cannot inherit the original signature. Node transport pins public DNS resolution; Worker transport uses strictly public routing plus DNS screening, which is not connection pinning. Full backend suite passed 793 tests before the added toast-link test; final independent HTTP and browser integration gates remain pending.

User approved links in custom submission-status toasts. `application/vnd.bindle.submission-status+json` permits a bounded plain-text status and at most two labeled HTTPS navigation links, with no callback or follow-up form semantics. HTTP failures remain failures regardless of the declared status. The console must show destinations and open links in isolated new tabs. Non-HTML/empty responses do not overwrite message bodies. Frontend typed-toast rendering, result viewer and integrated browser verification are still in progress; no deployment is claimed here.

Architecture/security sign-off: reviewer ___ / date ___ / outcome ___. Product/browser sign-off: reviewer ___ / date ___ / outcome ___.

Independent actual HTTP-to-SQLite review added five regressions and found no remaining broker blocker: private identity epoch at preparation, cookie/Origin/MAC/body guards before actor access, recovery/inactivity/local-presentation refusal, retained replay and bounded toast links. Full working-tree core suite now passes **800/800** (`/tmp/bindle-postbacks-http-audit-core.log`, including 12 pre-existing isolated lifecycle draft tests outside the intended commit); focused broker plus HTTP checks pass **24/24**. The historical cookie-authenticated dispatch gap is closed in source and tests, as recorded in [the independent review](docs/release/message-actions-security-review.md). Browser CSP, cancellation and actual console interaction remain distinct gates. Node hosts now accept a code-injected transport port without weakening their default DNS-pinned network adapter or accepting a transport through JSON configuration. Private key-generation checks passed permissions, signature verification, public-only export, quiet output and refusal to overwrite existing files; no production key was provisioned by those temporary-fixture checks.

Browser integration found two boundaries requiring concrete changes: inherited page CSP requires an external hashed renderer controller, and a global vendor sanitizer imported shared chunks incompatible with an exact script allowlist. The sanitizer is therefore a separate standalone js-tools bundle with no imports. Only the two exact hashed script URLs are permitted by the opaque frame's CSP; narrow static CORS serves those public assets. Parent console CSP permits self frames, while the actual message frame retains no `allow-same-origin`, native forms, author scripts or remote-resource permission.

The isolated result tab exposed a cross-window messaging distinction: a callback created by the console still sends from the console realm when manipulating a popup-owned iframe. Replacing the child `source === parent` initialization condition requires an equally explicit binding, rather than accepting arbitrary messages. Provisional approved direction: a cryptographically random 256-bit per-mount nonce in trusted bootstrap metadata, one-time nonce and exact provider-Origin validation before accepting the single transferred port, with provider Origin derived from the trusted controller/metadata rather than caller payload. The mounting side still checks exact child Window, opaque Origin and nonce; owner/source/generation checks stay outside the frame. No credentials or owner capability enter message DOM. Independent source review and real-browser wrong/stale initialization tests remain gates. Security sign-off: reviewer ___ / date ___ / outcome ___.

Actual Worker suite passes **46/46** after updating stale contact fixtures to explicitly grant optional tags; unauthorized tags remain rejected and required delivery tags are verified. DOM smoke and **99/99** UI-state tests passed before the final added message-action state suite. A separate production provider app-message signing key has now been provisioned through Wrangler without printing it; only its verify-only public key is in production configuration. This is secret provisioning, not a deployment or claim that app connections/forms are production-enabled.


## 2026-10-14 — Defer fetched-HTML result tabs

User chose to defer the `target="_blank"` result-viewer path and other nonessential surfaces that need deeper specification. This supersedes the earlier isolated-popup and cross-realm initialization plan. Keep the narrow implemented paths: successful HTML postbacks with transparent local history, bounded status toasts with HTTPS navigation links, and reviewed HTTPS redirects to real pages. Authored `_blank` forms cannot submit in this profile. A submitted HTML response requesting a separate tab yields an informational status and leaves the current message unchanged; new `new-tab` presentation writes are refused, while historical entries remain readable. Frontend popup code and its widened initialization surface are being removed; exact parent-window checks remain for ordinary opaque frames. Backend focused checks pass27/27 and full working-tree core passes801/801 (`/tmp/bindle-blank-deferred-core.log`, including the12pre-existing lifecycle draft tests outside the intended commit). Final browser checks remain pending.

Rare form-control names that trigger the pinned sanitizer's DOM-clobber protections will remain unsupported in fallback rendering. Do not weaken or hook the sanitizer to force parity in this release; show explanatory unavailable/omitted-content UI instead of a blank result. Ordinary field names still require actual native/fallback browser verification. Further normalization/interoperability design is pending. Scope/security sign-off: reviewer ___ / date ___ / outcome ___.


## 2026-10-14 — Message content rules and recipient motion policy

User clarified that Bindle specifies observable rules, not which renderer, APIs, or SDK implementations to use. The curated [message content normative draft](docs/spec/message-content.md) defines plain/HTML UTF-8 interpretation, permitted opaque data, safe presentation, privacy, provenance, intentional navigation/submission, retained results and recipient motion controls. Reference-service constraints and the private experimental archive format are explicitly distinguished from universal requirements; no extra RPC contract/schema stub was invented. Independent review: [message content review](docs/release/message-content-review.md).

Motion is enabled by default but recipient/platform reduced-motion choices prevail. Bindle requires a finite recipient-controlled display budget and prevention of delayed/interaction/re-render restarts, without choosing a universal duration or prescribing APIs. Finite effects may settle to a safe terminal state; infinite/unfinishable effects require static fallback. This applies to every supported motion mechanism; disabling styling animation alone is not a claim to control GIF/video.

3sln's implementation uses a browser-local message-animation preference and a five-second styling-motion budget. Those are service policy, separate from the spec. The renderer handles supported effects within its isolated content boundary; after cutoff it removes motion declarations recursively from author styles and inline declarations, with static fallback on unsupported inspection. Source/owner authority remains independent. Independent testing found and corrected reduced-motion/persistence and background/reconnect budget gaps, and verified that animation enumeration must include the closed content tree. Actual controlled Chrome native/fallback plus motion checks pass2/2; independent preference/episode regressions pass4/4; complete UI-state checks pass109/109. Cross-engine and deployment claims remain pending. Protocol/product/security sign-off: reviewer ___ / date ___ / outcome ___.

Full browser run of the preceding build completed78/79; the sole failure was a stale expectation that the message sandbox had no trusted controller script, and its old DOM heading query did not account for the closed content tree. The fixture now checks the opaque `allow-scripts` sandbox (no same-origin/forms permission), directly observes only controlled test content, and retains the author-script nonexecution check. Actual Worker suite46/46, core802/802 (including12pre-existing lifecycle draft tests excluded from intended commit), dependency audit0vulnerabilities, and Cloudflare bundle dry-run passed before the final geometry/motion asset rebuild. Final frozen-build integration remains the next gate.

## 2026-10-14 — Frozen rich-message verification and private-host onboarding direction

Final frozen build `d089927129d93a7c490a` passed main browser76/76 and separate federation4/4, alongside core802/802 (12 unrelated lifecycle draft tests remain outside intended release), Worker46/46 and UIstate109/109. Independent checks established native/fallback motion handling, reviewed credentialless submissions, retained HTML history, redirect/status navigation and honest unknown outcomes. [Walkthrough section36](docs/walkthrough.md) records local screenshots and controlled external-transport limitations. These are not deployment evidence. APP_NOTIFICATION_SIGNING_JWK was securely provisioned without printing its private value; no current source deployment is claimed.

User requested a fixed-account self-host mode: ordinary login remains available with public signup closed; an operator-issued capability lists only its authorized onboardable names and starts the existing credential/terms/recovery flow. Fixed-name admission must remain distinct from platform/system badges and privileges. Existing permanent assignment/tombstone invariants apply. Tokens authorize per-name onboarding, not arbitrary signup, account takeover or recovery. A token-bearing path is a capability whose infrastructure logging risk must be explicit; browser scrubbing and response headers cannot erase a reverse proxy's prior request log. Exact route, credential handoff, expiry, resumability and independently reviewed storage changes are in design. Architecture/security/product sign-off: reviewer ___ / date ___ / outcome ___.

## 2026-10-14 — Contact POST and bearer-RPC delivery candidate

[Wire draft](docs/spec/contact-delivery.md), [architecture decision](docs/architecture/contact-delivery-wire.md), [independent security review](docs/release/contact-delivery-review.md) and [DX review](docs/release/contact-delivery-dx-review.md) separate document delivery from authorship and conversation consent. Both transports use one canonical envelope, body digest, stable operation ID and parent-scoped receipt. Multipart is exactly envelope JSON plus message bytes; RPC carries the same envelope plus canonical base64url bytes. Required tags come from verified grants, optional tags are an allowed selection, and Views remain projections rather than authority partitions.

One-offs carry no reply grant. Conversation initiations carry a creator-signed proposal, protected shared secret, proposed participant identities and a bounded recipient-specific acceptance return capability; receipt does not imply membership. Identity-authored records require author proofs. Anonymous one-offs are an explicit permitted mode with visibly unverified authorship and a provider-signed admission receipt; a provider signature must never be presented as the anonymous author's identity proof. RPC contact credentials are explicitly typed and bound to a single contact resource/method/audience, distinct from legacy inbox JWTs and OAuth grants. Negotiation reuses the contact-token MIME with an explicit profile and rejects legacy token substitution.

The complete candidate schema and signature/digest vectors remain private architecture artefacts; the curated prose explicitly describes proposed rather than implemented behavior. The three fixed-vector checks pass, including re-signature invariance, exact-byte tampering and domain separation. No current runtime or SDK conformance, published contact RPC contract, directory/key-continuity completeness, or conversation-v2 implementation is claimed. Existing public JSON remains unchanged. Earlier legacy prose naming multipart `blob` was corrected to actual `message`. Protocol/security/interop sign-off: reviewer ___ / date ___ / outcome ___; unsigned decisions do not automatically block development.

## 2026-10-14 — Final private-host names, identity badges and injected resolution

User refinements supersede the earlier name-to-badge mapping and issuer-bound badge proposal. Badges are local UI presentation: the host supplies `{id,name,description,svg}` definitions; the app compiles bounded static SVG into a single content-addressed sprite. The embedder does not need to provide a sprite map. `HOST_NAME_POLICY` now contains only version/reserved/onboarding sets, explicitly replacing defaults when configured. Those sets protect canonical names even when invitation issuance is disabled. Permanent issued assignments survive later policy removal.

The default badge resolver reads mutable identity `badgeIds`, initially selected per name in the signed onboarding token. A code-injected `resolveIdentityBadges` can instead resolve roles or another host-owned policy. Its frozen descriptor excludes credentials, sessions, verified emails and key material. Known IDs alone are projected; a500ms asynchronous deadline or hook failure yields no badges without changing credential authority. Injected code remains trusted host code, without CPU isolation. There is no badge-derived subscription or administrative authority and no new management UI/API in this slice; future tools can manage trusted identity records.

[Host-name/badge decision](docs/architecture/host-name-badge-policy.md), [independent review](docs/release/self-host-onboarding-review.md), and [self-host instructions](docs/self-hosting.md) record the final interface. The compiler rejects active/external SVG rather than silently widening content support, caches one bounded immutable configuration compilation, and changes its content key when mutable input changes. Public configuration contains only badge metadata and the hashed sprite URL; private onboardable names and raw SVG are excluded. GET/HEAD/conditional sprite routes perform no identity access; invalid badge definitions degrade optional presentation while namespace policy remains fail closed.

Actual local Worker evidence now passes the complete two-name flow: closed public signup, purpose-separated issuance, atomic per-name admission (two overall slots, zero free-origin slots), signed initial badge IDs, no implicit system identity, invitation replay refusal, credential-based pending resumption with rotated setup cookie, recovery activation and normal alias sign-in. The fixture initially retained its old setup cookie after credential resumption; honoring the deliberate cookie rotation fixed the test without weakening runtime binding. Independent backend audit8/8 and final UI-state122/122 pass. Full integrated core/Worker/build/browser gates remain in progress. Human architecture/product/security sign-off: reviewer ___ / date ___ / outcome ___; this is not production provisioning evidence.

## 2026-10-14 — Verified onboarding/message checkpoint; multi-account work queued

Frozen public build `d0894d61d7781b92e3cf` passed the complete browser gate78/78 plus fresh federation4/4 (82/82), actual Worker47/47, UI-state122/122, DOM smoke and Cloudflare bundle dry-run. Latest core838/838 includes12 pre-existing lifecycle draft tests outside this checkpoint's commit; the corresponding committed suite excludes those drafts. The unrelated account-lifecycle implementation/test and icon file remain untouched. Generated docs contain34 curated pages; contact-delivery prose is a reviewed candidate, with its unimplemented JSON contract excluded from the public registry. [Walkthrough](docs/walkthrough.md) sections36–37 distinguish actual Worker/Node behavior from intercepted source screenshots.

The first Worker run hit an undici connection reset in its oversize streamed-body fixture; the isolated file passed9/9. Bounding test-file concurrency at four gave the complete47/47 run without changing receipt validation. Browser investigation captured Playwright's duplicate opaque-child-frame attachment assertion; installing its matched browser alone did not remove it. The final fixture uses default pinned headless shell156.0.8078.4, explicit Close/real frame detachment between independent deliveries, and a test-only clone observer of real fetch responses instead of a CDP response-body handle invalidated by child navigation. It never synthesizes/resends a request or modifies the delivered Response. Three independent repetitions passed7/7 each, followed by the complete82/82 gate. Native pointer/history, cookie, status/body and server send-count checks remain. Rapid direct switching/reload with an open unknown frame is outside this stabilized independent-case fixture; no product fix is claimed for the driver invariant. [Independent investigation](docs/release/node-browser-background-review.md).

A separate source-confirmed Node alarm shutdown race was fixed narrowly: closed metadata does not retry/read/rearm after an in-flight callback fails. Deterministic tests2/2 and full core838/838 passed. Synchronous close does not promise to drain or durably complete in-flight maintenance.

User added simultaneous provider-local accounts, account selection for connected apps, destination-account notifications, and app-triggered login/select/reauthentication/end-session flows. Design-only drafts: [session authority](docs/architecture/multi-account-sessions.md), [UI/privacy](docs/architecture/multi-account-ui.md), [independent review](docs/release/multi-account-review.md). Implementation is pending. Account inventories and sign-in state must not be disclosed to third-party apps before consent. Cross-origin popup/redirect already isolate provider DOM; Strict cookies do not become available in cross-site iframes merely through Storage Access permission. A neutral iframe launcher may coexist with trusted top-level approval, preserving cookie and clickjacking boundaries. Existing handle-bound consent requests must remain immutable; changing account requires a fresh bound request. App-token logout and provider-session logout remain distinct, with explicit provider UI for session changes. Vault concurrency, request-local member binding, stale-owner fences, notification navigation and partial logout retry authority require the next implementation checkpoint. Architecture/security/privacy sign-off: reviewer ___ / date ___ / outcome ___.

## 2026-10-14 — Coordinator handover; recognizable Bindle links and conditional contact links

Coordination moved from the Codex session to Claude Code (Opus 5.5) as coordinator. Uncommitted multi-account work and the unanswered embeddable custom-elements request carry over unchanged; working-tree `npm test` passed 839/839 at handover.

User proposed a generic, tooling-recognizable link envelope (`bindle_meta` / `bindle_data` query parameters, each with a magic intent member) and conditional contact links that become valid only once the opener attaches a signed audience response. User-confirmed direction:

| Decision | Consequence | Human review |
| --- | --- | --- |
| Link envelope | `bindle_meta` is a compact JWS whose readable payload carries a magic member, a `type` URI and version; the signature covers the canonical link audience (origin+path). Unrelated query params are ignored and never signed; duplicate `bindle_*` params are rejected. `bindle_data` is unsigned by the link owner and uses a distinct magic value. Conditional is a requirement on a contact link, not a separate kind. | Direction confirmed by user 2026-10-14. Spec sign-off: Reviewer ___ Date ___ Outcome ___ |
| Conditional responses | Signed by the audience identity's key, binding the exact meta digest, audience handle + stable identity, link URL, mint timestamp, explicit validity period and a fresh random nonce. The response is an eligibility pre-check only; delivery still requires an author proof from the same identity. Conditions are host policy, evaluated at render and at delivery; no condition language is specified. Cross-host verification depends on the not-yet-implemented directory/identity-document profile. | Direction confirmed by user 2026-10-14. Reviewer ___ Date ___ Outcome ___ |
| No anonymous link messages | Every message delivered through any contact link must carry a resolvable identity author proof. The sole exception is app messages via the front-end SDK app-connection path, which is not link delivery. Supersedes the anonymous one-off provision in [contact delivery](docs/spec/contact-delivery.md); reconciliation pending. | User decision 2026-10-14. Reviewer ___ Date ___ Outcome ___ |
| Developer contact | 3sln.me's `ray` contact becomes one conditional link evaluated against current eligibility (confirmed paid entitlement, or all accounts while active population < 1500), likely replacing daily per-user grant issuance. Eligibility is then rechecked at receipt, superseding the earlier accepted "1-day expiry, no receipt recheck" trade-off. | Provisional pending spec. Reviewer ___ Date ___ Outcome ___ |

Normative draft (`docs/spec/links.md`), architecture note and independent security/interop review are being produced by a delegated design agent; design only, no runtime change yet. Implementation follows after multi-account sessions land, to avoid overlapping contact/auth edits.

## 2026-10-14 — Link decisions resolved; label-agnostic tags with suspected automated classification

Links design landed: [normative draft](docs/spec/links.md), [decision note](docs/architecture/bindle-links.md), [independent review](docs/release/bindle-links-review.md) (3 high, 9 medium, 7 low findings, all addressed in the draft). Notable refinements: `bindle_data` is itself a compact JWS signed by the audience key; `md` binds the signed meta segments; responses carry a 16-byte nonce, `iat`/`exp` with at most 300 s validity and 60 s skew, single-use evaluation with bounded refuse-not-evict replay state; conditional-link message/byte limits apply per author principal per UTC day; meta carries no free-text display fields and `policy` must come from an operator registry. Coordinator resolved two design questions from prior user direction: developer contact moves to one conditional link (user stated this when proposing conditional links), and anonymous delivery on legacy `?sig=` links ends in the same change that ships identity-authored delivery. Still open for the user: whether foreign-provider identities may ever qualify for developer contact (default: no, 3sln.me identities only; foreign verification is impossible until the directory profile exists anyway). Implementation slices L0 (authored delivery), L1–L3 and L4b (parser, issuance, response signing, replay store) are delegated; L4 HTTP routing, L5 developer contact and L6 contact UI wait for the multi-account slice to release `packages/runtime/http.mjs` and `apps/web`. Contact-delivery/contact-tokens drafts are being reconciled to the no-anonymous decision. Reviewer ___ Date ___ Outcome ___.

User direction: automated tagging (AI classifier and other heuristics) applies only "Suspected <X>" tags (Suspected Spam, Social, Promotional, Recruitment, …); owner rules finalize them, with editable default rules promoting e.g. Suspected Spam → Spam. Tags are label-agnostic identifiers with localized labels. Contact-link required/optional tags are not subject to the suspected convention; they apply as granted. Design and backend implementation delegated (`docs/architecture/tags.md`); the AI classifier call itself remains gated by the public-email bridge design. Reviewer ___ Date ___ Outcome ___.

User decision (2026-10-14): contact-link auto-associated tags are not part of the signed link. They move to per-link server-side intake configuration (revisioned, owner-editable without reissuing the link); deliveries record the intake revision applied. Coordinator extended the same treatment to the sender-selectable optional-tag allowlist, discoverable via the contact-profile representation. Legacy signed `requiredTags`/`optionalTags` seed intake on first read. Signed limits, `kinds` and `resource` remain in the meta. Intake edits never change `md`, stored claims, quotas or outstanding responses. Links spec, delivery, tag-model and contact-docs agents notified. Reviewer ___ Date ___ Outcome ___.

User confirmed (2026-10-14) the optional-tag extension: optional tags are not embedded in links; consumers send a side-effect-free metadata request to the link to learn accepted optional tags (IDs with localized labels), intake revision, kinds/limits and conditional status. Coordinator decision: auto tags are owner-internal and are not disclosed in that metadata. Deliveries naming a tag outside the current allowlist get a specific rejection so clients can refresh metadata. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Embeddable elements design

[Design](docs/architecture/embeddable-elements.md) and [independent review](docs/release/embeddable-elements-review.md) (22 findings incl. 2 blockers, 4 high, addressed in §16). Elements: `<bindle-session>`, `<bindle-sign-in>` (with `<bindle-login>` alias), `<bindle-account>`, `<bindle-monogram>`, optional `<bindle-access-summary>`; framework-branded. Phase 1 uses no iframe: login, select-account, reauthenticate and end-session all run through provider popup/redirect via the provider-owned authorization entry; the embedder learns only typed input and, after consent, the approved identity. Phase 2 (provider iframe account panel, label-only, every action escalates to a popup, partitioned cookie created by explicit opt-in) is gated on browser evidence and a user decision.

Coordinator reconciliation: D7 accepted — popup completion relays the authorization code from the app's own same-origin callback page over a same-origin BroadcastChannel to the waiting tab, validated by the existing single-use transaction; auth.md to be updated (it currently describes a provider postMessage carrying a completion reference). D8 accepted — app sign-out (revokes the app's tokens) is distinct from provider end-session (explicit provider UI), matching earlier user direction; auth.md to be updated. D6 (spec carve-out for a framed label-only panel) deferred to the user's phase-2 decision. Phase-1 SDK flows, elements and SDK string catalogue delegated, built mock-first against the not-yet-implemented authorization entry. Reviewer ___ Date ___ Outcome ___.

L0 identity-authored contact delivery landed locally, not yet wired into HTTP: `packages/messaging/contact-delivery{,-wire,-service}.mjs`. It has strict envelope/multipart/RPC parsers, author proofs with same-host verification only (foreign authors return `author_unverifiable` with no lookup), parent-scoped receipts keyed by operation ID, intake-revision tag provenance and provider-signed receipts. There is no anonymous branch. Conversation initiation is validated but refused (415) until the conversation-v2 runtime exists. Conditional parents are refused (503) until per-author daily quotas exist. [Independent review](docs/release/contact-delivery-impl-review.md): 4 medium, 2 low-medium, rest low/info; all fixed or mitigated. `npm test` passed 898/898. The review found spec defects S1–S16, being reconciled; coordinator decisions: the replay namespace includes the author principal; conditional links use per-author daily quotas; no sender-visible collection choice (the single incoming store plus Views model). Reviewer ___ Date ___ Outcome ___.

Package name for the published SDK and elements: `@3sln/bindle` (user decision 2026-10-14).

User direction (2026-10-14): the Bindle spec should say nothing about UI. The framing and presentation rules now in `docs/spec/auth.md:31` and `docs/spec/protocol.md:38` were written by the earlier coordinator. Proposal pending user confirmation: move them into 3sln.me's own security docs, and keep only the interop content in the spec (manifest presentation hint, universal redirect support, the shape of the result-return exchange). Coordinator also raised a token-lifetime gap: 5-minute in-memory access tokens with no refresh token mean front-end-only apps lose access on reload and after 5 minutes. Recommendation pending user decision: rotating, grant-bound browser refresh tokens with live revocation checks, and defer the phase-2 iframe panel.

## 2026-10-14 — Label-agnostic tags landed (backend)

[Design](docs/architecture/tags.md), independently reviewed (3 blockers fixed: app-sent `sys:` tags, unbounded classifier entry, sender headers reaching final tags). Tags are identifiers: reserved `sys:` system IDs (look-alike prefixes rejected) with localized labels via bab, user tags with owner-registry labels so renames never retag. Eleven categories have `sys:suspected.X` and `sys:X` forms; `personal`/`work` are final-only. Automated output (`MessagingService.applyAutomatedTags`, internal; no model call yet) only adds suspected tags with evidence. Versioned default rules promote suspected→final on classifier evidence only; header heuristics stay suspected; only Spam also quarantines; owner edits/deletions survive upgrades. Rules fire once per message (no chains); automation never undoes owner removals or quarantine release. Contact-link intake tags apply as granted, may use final `sys:` IDs but never suspected ones. The `classification` enum folds into `sys:` tags with lazy migration and batched index re-projection. Combined working tree `npm test` 913/913 after all concurrent agents' changes.

Coordinator decisions on the agent's open questions (provisional): (1) all default promotions ship enabled, per user's "promote Suspected Spam → Spam and so on"; (2) MCP/agent grants may add/remove user tags and final system tags within their granted scope, never add `sys:suspected.*` (classifier provenance is reserved); (3) notifications wait for pending classification only when classification is enabled for that source, bounded by a short timeout, then notify as unclassified (matches the bridge design). Remaining wiring after the multi-account slice: tag label routes, `data.tagLabels`, add/remove tag forms, `migrateTags` in search document building, system-tag styles. Reviewer ___ Date ___ Outcome ___.

Contact-delivery reconciliation complete: spec items S1–S16 are written into [contact delivery](docs/spec/contact-delivery.md), marked proposed where not implemented. Delivery receipts are now keyed by owner, parent, author principal and operation ID, with a test showing a different author's reused operation ID is a separate delivery. Provisional local identity naming is `<issuer>/identity/<subject>`, `…/identity.json`, `…#<kid>`, pending the directory profile. `grant.delivery.collection` is documented only as a reference-host implementation detail. `npm test` 913/913. Still open: a conversation-init vector for the nested-signature rule. Reviewer ___ Date ___ Outcome ___.

Bindle links L1, L2, L3 and L4b are implemented as unrouted library code:
- `packages/messaging/bindle-links.mjs`: the shared raw-query parser, strict I-JSON/JWS profile and md/H digests.
- Fixed vectors in `docs/architecture/artefacts/bindle-links.vectors.json`.
- New-form contact meta issuance, inspection and challenge rotation (`contact-endpoints.mjs`).
- Revisioned intake replacing signed tags (`tag-policy.mjs`), with the side-effect-free metadata representation `application/vnd.bindle.contact-intake+json` ([links §6.2–6.3](docs/spec/links.md)).
- Same-host response signing and verification (`packages/identity/link-response.mjs`).
- The bounded replay record (`link-replay.mjs`).

Signed limits, `kinds` and `resource` stay in the meta. The [implementation review](docs/release/bindle-links-review.md) found 2 Medium issues: anonymous bearer minting for new-form links (now 406) and new-form creation through the legacy request spread (`create()` is now legacy-only). Both are fixed, along with 5 Low. Open: edge routing (#7, L4). `npm test` 925/925.

L4 wiring left for after multi-account:
- `http.mjs` routes via `parseLinkQuery`/`parseLinkMeta`.
- `accounts.mjs` passes `linkPolicies` and replaces the signed-tag pre-check with intake.
- Expose `createLink`/`rotateChallenge`/`updateIntake`/`linkMetadata` and the link-response resolver/signer.
- A per-account `LinkReplayRecord` behind rate limits.
- `requiredTags` dropped from `inspectContact`.

Not routed or production-verified. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Adaptive app sign-in direction (FedCM, popup fallback, key-bound embed restore)

User direction: use FedCM where the browser supports it, otherwise a popup/redirect OAuth-style flow. The app keeps a returned token whose only use is restoring a signed-in provider iframe. The iframe verifies it against a device key generated in its own partitioned storage, so login restores across reloads without giving the app direct access. Bindle spec must contain no UI rules; framing/presentation guidance moves to reference-host docs, leaving only interop (manifest capability advertisement including optional FedCM config URL, universal redirect, exchange shapes).

Coordinator provisional refinements, being designed and reviewed (`docs/architecture/adaptive-app-sign-in.md`):
- The iframe mounts first and generates a non-extractable WebCrypto key in IndexedDB. Only its thumbprint is bound into the sign-in, DPoP-style.
- The embed token is passed by postMessage or URL fragment, never the query.
- Restore requires a fresh proof of possession of the key.
- The embed token never authorizes resource RPC. The app's API access is a separate rotating, grant-bound refresh credential with live revocation, fixing the 5-minute/no-refresh gap for front-end-only apps.
- This supersedes the partitioned-cookie phase-2 panel.

FedCM details to be verified against current official documentation before relying on them. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Multi-account console slice implemented locally

Per-account AEAD, HttpOnly, SameSite=Strict cookies were chosen over the per-device coordinator, which would have let an old cookie gain authority over later-added accounts. Requests bind the tab's account and session context, which are checked before any owner actor routing. Routes cover inventory, switch, sign out one/all and cleanup retry. The 5-account limit revokes the refused new session, and same-account re-sign-in revokes the old session. Legacy single cookies migrate once, and the Node adapter now emits multiple Set-Cookie headers correctly. The localized chooser has per-tab selection, cross-tab refresh and stale-response fences. Push payloads carry the destination account (handle only when previews are on), and clicks switch only after confirmation. Enabled only when `SESSION_COOKIE_KEY` (32 random bytes, base64url) is configured; production will need it as a Wrangler secret before enablement. Tests: core 926/926, Worker 48/48, UI-state 141/141, real Chromium against a local Worker 2/2 (initially from an isolated copy). [Independent review](docs/release/multi-account-review.md): one medium-low issue (stale cleanup cookie blocking sign-out) and several low ones, fixed. Accepted limitations: duplicate-cookie lockout edge, push subscription kept after sign-out, non-atomic cross-tab limit, copied cookies valid until revoked, no key rotation, Chromium only, real push delivery unwired.

Coordinator fixed the shared asset build broken by the tag UI: `packages/messaging/tags.mjs` and its dependency-free `store.mjs` added to `publicSources`. Build passes and UI-state 141/141 on the combined tree. Security sign-off: Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Embeddable elements phase 1 implemented mock-first

Built in `packages/sdk`:
- flows, a callback relay with acknowledgement (D7), and a split between app sign-out and provider end-session (D8);
- elements `<bindle-session>`, `<bindle-sign-in>` (with `<bindle-login>` alias), `<bindle-account>` and `<bindle-monogram>`;
- an SDK string catalogue (`packages/i18n/sdk-catalogue.mjs`, en/es).

Provisional defaults: popup with automatic redirect fallback, and an overridable default host. The `@3sln/bindle` name is isolated in `packages/sdk/package.json`. Entry-based flows (identity-optional sign-in, switch, reauthenticate, end-session, revocation, popup completion) are verified only against the `testing.mjs` double. The server-side authorization entry (S4) does not exist yet; its assumed contract is recorded in the agent's report and forwarded to the adaptive sign-in design.

Tests: `npm test` 929/929 (47 SDK), `test:dom` passes, Chromium embed checks 3/3; Firefox and WebKit not run. Independent implementation review: 12 findings, all fixed.

Open items:
- `define.mjs` is about 24 KiB min+brotli against an 18 KiB budget.
- Hosted loaders for `define.mjs`/`callback.mjs` still need build and route entries.
- Pluggable `transports`/`entryExtensions` are reserved for adaptive sign-in. Single-token-pair assumptions in sign-out/revoke options will need revision for the separate refresh and embed credentials.

Coordinator updated `tests/e2e/federation.test.mjs` to check all keyed `bindle.pending-login:*` records; the new keyed storage made the old assertion vacuous. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Embed islands direction (queued behind adaptive sign-in design)

User direction for post-sign-in iframe UI. Islands are small provider iframes sharing one cached shell (`/embed?client=<id>#<part>`): the fragment selects an allowlisted part, a nonce-bound MessageChannel carries theme/locale/props and outbound events, and the embedder never commands actions. Within the embed partition, one leader island (Web Locks) holds the key-bound embed session and fans state out over BroadcastChannel. Avoid SharedWorker (unsupported on Chrome Android). Dropdown overflow and size-based leakage need explicit design. Islands use fixed or embedder-chosen sizes, never content-derived ones.

Snapshot privacy (coordinator analysis, user agreed): DOM-reconstruction snapshotting cannot read cross-origin iframes, and canvas tainting prevents pixel reads. Screen capture (`getDisplayMedia`/element capture) is user-permissioned and has no content opt-out; it counts as user consent, not a silent leak. `#avatar` guarantees: bytes served only to the embed-session bearer with `Cross-Origin-Resource-Policy: same-origin`, no CORS, `no-store`, rendered from an in-memory blob, no observable load/error/timing signals.

User direction: `#avatar` scales to its iframe, centered and as large as fits, so the embedder sets the avatar size by sizing the iframe. Custom elements supply good defaults, e.g. login/profile button size. Elements also provide a composed profile button: avatar, a dropdown with account switching, and slots for embedder content. Design consequence: embedder slot content cannot live inside a provider iframe. The dropdown container belongs to the custom element in the embedder's DOM, with the switcher island embedded within it and slotted content around it. Islands design (`docs/architecture/embed-islands.md`) starts once the adaptive sign-in embed session lands. Reviewer ___ Date ___ Outcome ___.

User direction (2026-10-14), composed profile button popover requirements for the islands/elements design:
- **Placement.** The popover stays within the viewport and anchors correctly. Use the Popover API top layer with CSS anchor positioning and `position-try` fallbacks, plus a measured flip/shift/size JS fallback where unsupported. Respect RTL and safe-area insets, and reposition rather than close on scroll/resize.
- **Closing.** It closes when expected: outside pointer, Escape, focus leaving, account switch/sign-out, and navigation. Clicks into other cross-origin iframes never reach the document, so pair light-dismiss with window blur/activeElement checks while not treating focus moving into our own switcher island as "outside".
- **Small screens.** It becomes a modal surface. Bottom sheet by default; side sheet when the anchor sits in a side rail, or via an explicit placement attribute. Modal dialog semantics with focus trap, scroll lock, swipe/drag dismiss, a visible close control, visualViewport/virtual-keyboard awareness and reduced-motion support.
- **Island sizes.** Islands inside adapt via embedder-set sizes, never content-derived ones.

## 2026-10-14 — Adaptive app sign-in design drafted

[Design](docs/architecture/adaptive-app-sign-in.md), [independent review](docs/release/adaptive-app-sign-in-review.md) (1 blocker, 3 high, all addressed or surfaced). FedCM, popup and redirect all converge on the PKCE code exchange; the token response carries app credentials plus an `embed_token` bound to the frame key. Refresh tokens persist across reloads only when DPoP-bound, with a revocation cascade. A dedicated cookieless embed origin is used. The FedCM cookie is restricted to `Path=/fedcm/api/` and treated as a session cookie. Verified FedCM facts: Chromium-only (108+); the accounts endpoint gets SameSite=None cookies and `Sec-Fetch-Dest: webidentity`; `params` from Chrome 132; inside an iframe the RP is the iframe's origin. BroadcastChannel is partitioned in all three engines.

Spec cleanup done:
- UI and framing rules moved from `auth.md`/`protocol.md` into a reference-host section of `security.md`.
- The manifest gains `fedcm_config_url`, `embed_binding_profiles_supported` and `dpop_signing_alg_values_supported`.

Blocker AS-R1, pending user decision: when the app relays the frame's key thumbprint, nothing attests the key lives in a provider frame. An app backend can bind the embed token to its own key and read whatever the frame would show. As designed, the frame guarantees rendering integrity only, not confidentiality from the app. That conflicts with the user's goals (account switcher and `#avatar` hidden from the app). The coordinator is proposing to the user confidentiality paths where the frame obtains its token without the app relaying it: FedCM invoked inside the frame on Chromium, and a frame-opened first-party popup bridge on other engines. Embed-token opener posting was dropped because the popup's COOP severs the opener and rendezvous polling enables device-code-style phishing. Reviewer ___ Date ___ Outcome ___.

User decision (2026-10-14) resolving AS-R1: the app must never forward the sign-in request. The provider frame itself opens the sign-in popup or tab on user activation; the app never sees it or holds a handle. The frame passes its key thumbprint into the sign-in context (message or query param; public value) and the flow binds that key to the final embed credential. The embed credential returns only to the frame (`opener.postMessage` with exact embed-origin targetOrigin). The app receives only its own authorization code for its granted access. Confidentiality of frame content (account switcher, `#avatar`) from the app is restored as a requirement. Design revision and fresh review of the binding/delivery path and the opener-preserving COOP change are in progress. Reviewer ___ Date ___ Outcome ___.

User direction (2026-10-14) for the islands/elements design: custom elements listen to island messages on their ports and on the session bus, and translate them into DOM events on the relevant custom elements: sign-in, account chosen, account changed, sign-out, and so on. Coordinator constraints:
- Elements validate origin/nonce/schema before translating, and never forward raw island payloads.
- Event detail carries only what the app is entitled to: the approved identity and app-credential status after consent, never the account inventory or other islands' data.
- One transition yields one event per element, even with several islands. The leader island is the source of truth, and `<bindle-session>` fans events out to the other elements.
- Account change fires after the app credential for the new account is ready, with a distinct failure event if the exchange fails.
- Event names, bubbling/composed behavior, ordering and replay-on-late-listener rules are to be specified in the islands design.

User correction (2026-10-14), superseding the coordinator's "one transition yields one event" constraint and the `<bindle-session>` fan-out: each island emits only the messages that fit its own part. Each wrapper element decides how to compose, debounce or dedupe the events it exposes, so it makes sense as a self-contained unit. No global single-event guarantee across elements. Validation, translation and entitlement limits on event detail still apply per element.

Adaptive sign-in revision 2 ([design](docs/architecture/adaptive-app-sign-in.md), review round 2 appended): the frame creates the authorization entry on user activation with the clicked intent and its own key thumbprint, and opens the popup itself. The popup renders nothing until the opener proves possession of that key. On approval it posts `{code,state,iss,claim}` to the opener with exact embed-origin targetOrigin. The frame redeems the single-use claim with its key and forwards only the code to the app, and only when the parent origin matches the registered redirect origin; the registered callback remains the fallback. App-opened popups, redirect, and FedCM invoked by the app yield app credentials only. One static popup page is served without COOP so the opener survives; without the handshake it replaces itself with the normal COOP `same-origin` page. Sandboxing is detected as a usability guard, not a security boundary. FedCM inside the frame (`mediation:'required'`, key proof over a server nonce) is the Chromium variant. `auth.md` now has a "Provider-operated components" interop rule: component credentials never reach the client and are issued only on key-proven delivery. The fresh reviewer found no path for app script or app server to obtain an embed credential bound to its own key; 10 round-2 findings fixed. Open: in Chrome the FedCM dialog may name the embed host rather than the app; apps sending `COOP: same-origin` lose the confidential frame (integrator guidance: `same-origin-allow-popups`, to verify). Real-browser evidence still missing: per-engine COOP/opener behavior, iOS opener retention, Android process isolation. Reviewer ___ Date ___ Outcome ___.

User direction (2026-10-14), contact link default HTML representation:
- **Intent link.** Includes `bindle+intent://add-contact?contact-url=…` so any Bindle intent handler can add the contact.
- **Previews.** Carries Open Graph/Twitter and oEmbed discovery tags so the link previews well in chat and notes apps.
- **Profile in previews.** When the link's grant permits recipient profile disclosure, name and avatar render in the page and previews; "a platform that has the link already has access."

Coordinator constraints:
- oEmbed returns `link`/`photo` only.
- `noindex, nofollow` (meta plus `X-Robots-Tag`).
- Generic card for revoked or undisclosed links.
- Crawler fetches never deliver, consume quota/nonces or evaluate `bindle_data`.
- Interop text (intent URI and parameters) goes in `links.md`; rendering stays in host docs.

Open user question: `registerProtocolHandler` and PWA `protocol_handlers` require a `web+` prefix, so web apps, 3sln.me included, cannot register `bindle+intent`. Proposed: `web+bindle:` (registrable by both web and native handlers). The scheme is isolated in one constant pending the answer. Assigned to the links-integration agent. Reviewer ___ Date ___ Outcome ___.

User decisions (2026-10-14):
- **Scheme.** The intent scheme is `web+bindle`. Contact pages offer `web+bindle://add-contact?contact-url=…` and `web+bindle://send-message?contact-url=…`.
- **No composer on the page.** The public HTML contact page includes no messaging API. Signed-out or non-associated viewers see link and permitted profile information plus the intent buttons.
- **Provider app handling.** Viewers signed into the provider, or opening the link as a deep link into the provider app, get app handling: start a message, or prompt to send a message or add to contacts.

For 3sln.me:
- Session detection is client-side after a static first render, because Strict cookies are not sent on the cross-site navigation from chat apps.
- The handoff goes into a console route that keeps the capability out of server logs, with account choice when several are signed in.
- The PWA captures contact-link paths (`handle_links`/`launch_handler`) and registers the `web+bindle` handler.
- Composition, authored delivery and conditional audience responses happen only in the provider app.

This supersedes the earlier L6 plan for an opener composer on the public page. Reviewer ___ Date ___ Outcome ___.

User addition (2026-10-14): the 3sln.me contact page offers a sign-up option for viewers without a Bindle-capable app. Handler presence is undetectable by design, so it appears as a secondary option under the intent buttons and is hidden once a signed-in session is detected. The link carries through guided signup outside the server-visible query and returns into the send-message/add-contact prompt, respecting signup capacity, paid and waitlist states.
Refinement (2026-10-14): that secondary option is "sign in or sign up with 3sln.me" (existing sign-in UI with a create-account path), since viewers may have an account that is not signed in on that browser.

## 2026-10-14 — Embed islands design

[Design](docs/architecture/embed-islands.md) and [independent review](docs/release/embed-islands-review.md): 18 findings (3 High, 8 Medium, 7 Low), all incorporated into revision 2.

Decisions:
- **Shell and messages.** The fragment is exactly the part name, so a CSS skeleton paints before script runs. The nonce, locale and color scheme travel in the iframe `name`. Inbound messages are presentation-only; outbound messages are per part, entitlement-checked, and `#avatar` emits only `ready`.
- **Leader and timing.** Web Locks leader with BroadcastChannel fan-out. Account-dependent work runs in per-island workers, so page-observable timing is uniform.
- **Avatar.** Bearer-only, re-encoded raster, never cached. Shows a monogram fallback when unbound.
- **`<bindle-account>`.** One `<dialog>`: an anchored popover on wide screens, a modal sheet on narrow ones. The switcher iframe is never reparented.
- **Events.** Per-element events with a frozen `state` for late listeners.

Breaking changes in island mode: `role=menu` becomes a dialog, top-layer positioning, switch/manage move into the island.

Found a real bug in the adaptive sign-in design: the embed API rejected same-origin GETs, which carry no `Origin`. The fix was routed to the design and implementation agents. The manifest standardizes on `embed_profiles_supported`, and a field for the islands embed origin is being added.

Coordinator decisions on the agent's questions (provisional; user may override):
1. The profile button defaults to avatar-only, with an optional label attribute.
2. The `forget` command (app sign-out tells islands to drop local data) is accepted as the sole embedder-initiated command, since it only reduces data.
3. Islands are on by default. Nothing is publicly released, so there is no compatibility reason for opt-in.
4. The sheet breakpoint is 600 px, measured on the viewport.

Implementation slices I1–I8 follow the authorization-entry/app-session server slice now in progress. Reviewer ___ Date ___ Outcome ___.

User addition (2026-10-14): the contact page sign-in UI also lets viewers sign in with their own provider. If that provider's Bindle manifest declares intent support (`intents_supported`, provisional name), the flow appends `bindle_intent=<web+bindle intent>` to its login URL. The 3sln.me and self-hosted implementation declare and handle it.

Coordinator constraints:
- Append only after definitive discovery that declares support; otherwise fall back to the intent buttons.
- The receiving provider validates the intent as untrusted input and only prompts after login, never acting automatically.
- The contact capability reaching the chosen provider is acknowledged, with log-redaction and no-referrer guidance.
- Spec text goes in `links.md` and `protocol.md` §2.

Assigned to the links-integration agent. Reviewer ___ Date ___ Outcome ___.
Sign-in design aligned with islands §20 (leader-only restore, cap of 4 sessions and 2 streams per partition with oldest evicted, `Origin` required for non-GET and on GET when present, avatar re-encoded fetch-only). Superseded sections of embeddable-elements.md are marked. Manifest names settled: `embed_profiles_supported` and `embed_origin`, the latter an explicit exception to the issuer-origin endpoint rule.

## 2026-10-14 — Elements and sign-in must be provider-agnostic; 3sln.me components profile

User direction: the custom elements and sign-in flow must work with any Bindle provider: third-party, self-hosted or 3sln.me. Elements and UI are not part of the Bindle spec. A 3sln.me-defined sub-spec (components profile, published under a 3sln.me artefact URI) governs provider-operated components. A provider must declare support in its Bindle manifest before elements try to use it; otherwise elements render a simplified UI.

This supersedes placing `embed_origin`/`embed_profiles_supported` and component specifics in core `protocol.md`/`auth.md`. Core keeps only a generic, narrow profile-declaration container plus genuine interop: authorization entry, intents, revocation, DPoP, FedCM config URL.

A design agent is defining:
- the profile spec;
- the core container;
- a full / standard / minimal mode matrix with one element API;
- client identity across providers;
- an audit of SDK and design hard-coding.

The authorization-entry implementer was told to keep component fields out of core and to read them through a single profile accessor. Reviewer ___ Date ___ Outcome ___.
User clarification (2026-10-14): manifests declare granular support (which spec features and intents, embed host, available island parts and versions, theming and credential profiles). Elements adapt per feature to that declaration rather than to coarse modes. Sent to the components-profile design agent.
User confirmed (2026-10-14): core Bindle states an explicit provider conformance floor (manifest, authorization code + PKCE redirect, issuer binding, registered callbacks). Below it, elements report "unsupported provider"; core-only providers get the standard UI; the components profile is optional. The standard-UI profile button renders an initials avatar from display name, falling back to handle. Sent to the components-profile agent.

## 2026-10-14 — Authorization entry, DPoP app sessions and embed credentials implemented locally (unmounted)

New `packages/federation/{authorization-entries,dpop,app-sessions,embed-bindings,components-profile}.mjs` and route module `packages/runtime/federation-entry-http.mjs`.

- **Entries.** Pre-owner entries pin client/callback/PKCE/state/scopes/intent/nonce/expiry. Owner selection durably records owner and request ID first.
- **Sessions.** Refresh is DPoP-bound (30 d absolute / 7 d idle, provisional), with rotation, a 30 s same-key grace and reuse revocation. RFC 7009 revocation cascades to embed credentials.
- **Claims.** Key-bound and single-use.
- **Components profile.** Values are advertised only via `componentsDeclaration()` at provisional URI `https://3sln.me/artefacts/profiles/components/v1`, pending the components-profile design.

`npm test` 975/975, Worker 49/49. One SDK mock test ("exposes nothing before approval") failed once and passed in isolation and 6 reruns; tracked as possibly flaky.

[Review](docs/release/authorization-entry-impl-review.md): F1 (sessions died after 127 rotations), F2, F3, F4, F5, F7 and F9 fixed. Release gates:
- F6: an app server attesting its own key never receives the claim, but only because of popup `targetOrigin` delivery, which needs browser evidence.
- F7-mount: the CSP must survive `securePage`.
- F8: the manifest must not advertise unmounted routes.

Coordinator decision (provisional): access tokens stay short-lived (≤5 min) Bearer, while refresh tokens are DPoP-bound. Same-page script can use a non-extractable key anyway, so DPoP-binding 5-minute access tokens adds little against XSS. `auth.md` to be reconciled.

SDK follow-ups:
- accept DPoP sessions (`refresh_expires_in` beyond 28800, refresh proof);
- check `login_presentation` before choosing popup.

Mount hunks for `http.mjs` and composition wait until the links-integration agent releases `http.mjs`. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Boot token and administrator model direction

User direction:
- **Boot handle.** The `boot` handle is permanently reserved. A bootstrap token, carrying mint timestamp and nonce, only claims `boot` and is usable exactly once, within about 30 minutes of minting.
- **Restore.** The same single use may instead restore lost boot access. Reuse requires redeploying with a new token.
- **Expiry.** Boot access expires; boot exists only to create administrators.
- **Boot powers.** Boot mints claim tokens for reserved handles and sets reservations, roles and badges. Only boot creates or revokes administrators and defines which roles are internal-only versus assignable to ordinary users.
- **Admin powers.** Admins can do everything else boot can: reserve handles, configure badges/roles, mint claim tokens, search users, change roles within class rules.

Coordinator provisional refinements:
- Deployment config holds only the token's SHA-256 digest, never the token.
- Consumption is recorded durably and forever, keyed by digest.
- Every privileged action requires step-up reauthentication, rate limits and an append-only audit log.
- Roles (privilege) stay distinct from badges (presentation).
- Reconcile with the existing HMAC system invitations and HOST_NAME_POLICY.

Delegated design, backend and independent review (`docs/architecture/boot-and-admin.md`). Admin console UI is a later slice. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Components profile and provider-agnostic elements

[Profile spec](docs/profiles/components-v1.md) (URI `https://3sln.me/artefacts/profiles/components/v1`, in the public docs build) with descriptor `docs/architecture/artefacts/components-profile-v1.json` (registry publication pending). Also the [decision note](docs/architecture/components-profile.md) and [independent review](docs/release/components-profile-review.md): 21 findings (4 High, 12 Medium, 5 Low), all addressed.

Core `protocol.md` §2 now has:
- an explicit conformance floor;
- a versioned `features` object (`authorization-entry.v1`, `fedcm.v1`, `intents.v1`, `client-id-metadata.v1`);
- a generic `profiles` container.

Revocation, DPoP and refresh keep standard OAuth names. Embed origin, shell, channel, parts, theme tokens, island events and key binding live only in the profile. Elements compute behavior per feature, with one event API. The audit found 34 hard-coding findings (16 SDK, 6 monogram, 2 server, 10 design/spec).

Coordinator decisions on open questions (provisional):
1. Islands mount for any provider declaring the profile, with an embedder attribute to restrict to an issuer allowlist or disable.
2. 3sln.me will declare `client-id-metadata.v1`, so apps need no per-provider registration; consent shows the verified client origin. Implementation pending.
3. Dialog container in every mode.
4. Initials: one letter for single-word names, two for multi-word.
5. Island sandboxing deferred until browser evidence supports it.

Now running:
- SDK provider-agnostic implementation, including alias removal, the bundle budget and the flaky SDK test.
- Islands protocol, runtime and parts (`apps/embed`, `islands-protocol.mjs`).

The links agent was told to move intents and link responses onto `features`. Pending after the links agent releases runtime files:
- server profile constant and manifest shape (S1/S2);
- registry publication;
- mount hunks for authorization entry, embed and admin routes.

Reviewer ___ Date ___ Outcome ___.

COOP/opener spike ([results](docs/release/coop-opener-spike.md), harness `node tests/spikes/coop-opener/run.mjs`): Chromium 156 and Firefox 157 gave identical results. WebKit could not run on this machine (`newPage()` hangs); mobile behavior is unproven.

Confirmed:
- A frame-opened popup keeps its opener only when the popup sends no COOP at all, under an app with no COOP or `same-origin-allow-popups`.
- An app with `same-origin` makes `window.open` return null.
- Exact-origin messages to an app-opened popup's opener are dropped. This is browser evidence for the attestation property behind release gate F6, in two engines.
- `location.replace` to a COOP page severs the opener.
- An unnamed popup is unreachable by the app; a named one is reachable.
- With `allow-popups` the popup inherits the sandbox with a non-null origin, so detection needs the `document.domain` probe.
- BroadcastChannel/localStorage are partitioned. Playwright defaults disable partitioning, so tests must enable it.

Design corrections, forwarded to the islands implementer:
- never name the popup;
- try/catch `window.open`;
- the embed popup page sends no COOP whatsoever;
- integrator guidance: app COOP must be absent or `same-origin-allow-popups`.

WebKit/iOS evidence remains a release gate.

## 2026-10-14 — Links integration (L4/L5/L6) landed locally

- **Routing.** Edge routing uses the shared raw-query parser (review #7 fixed). Contact links serve:
  - the HTML page with OG/Twitter/oEmbed previews and noindex;
  - JSON inspection, which alone evaluates `bindle_data`;
  - side-effect-free intake metadata (`application/vnd.bindle.contact-intake+json`);
  - the contact-delivery bearer.
- **Delivery.** Authored-only through URL POST and `/bindle/rpc` (`ContactDeliveryService` split into prepare/commit). Legacy anonymous `?sig=` and inbox-bearer submission are retired with `403 author_required`.
- **Conditional links.** Host policy with bounded decision reuse (positive until UTC midnight, otherwise 15 min) and per-author UTC-day quotas; the L0 503 refusal is removed.
- **Developer contact.** One conditional link owned by the protected developer identity (paid, or active population < 1500, same-host only). Daily-grant issuance is removed and expired daily grants are reclaimed in bounded passes.
- **Public contact page.**
  - No composer: link info, permitted profile, `web+bindle` send-message/add-contact intents.
  - "Sign in or sign up with 3sln.me", including handoff to the viewer's own provider via `features["intents.v1"]` and `bindle_intent`.
  - Composition, disclosure/Continue-as and sending happen in the console (`/console#contact=…`) with an account chooser.
  - PWA protocol handler and `handle_links`.
- **Owner side.** Intake editor and challenge rotation; tag labels, pills and add/remove forms; sign-out removes that account's push subscription on the device.
- **Tests.** Core 976/976, Worker 49/49, UI-state 155/155, build and Worker dry run pass, Chromium link checks with 13 screenshots in `artifacts/browser/links-*.png`. Conditional/developer-contact browser runs use the Node adapter.
- **Reviews.** [Three independent reviews](docs/release/links-integration-review.md): security (no Critical/High, S1–S10 fixed or accepted), UX (2 High, 9 Medium fixed), previews/intents (R1, R3, R5–R9 fixed; R2, R4 accepted; R10 open).
- **Provisional decisions needing sign-off:** contact page `connect-src https:` for client-side handle discovery (R4); `intent`/`bindle_intent` added to log redaction (R2); revocation fence before the gate; receipt signed with the recipient's key pending admission-key discovery.
- **Remaining gaps:** cross-host audience verification; conversation-init via links; admission-key discovery; HTML-with-data vs §9.3 reconciliation; legacy inbox bearers survive only for conversation-v1 invitations.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Boot and admin backend implemented locally (unmounted)

[Design](docs/architecture/boot-and-admin.md), [independent review](docs/release/boot-and-admin-review.md).

- **Boot token.** Digest-only configuration (`BOOTSTRAP_TOKEN_SHA256`), a 30-minute window with 2-minute skew, consumption recorded forever. A single use covers claim or restore.
- **Boot principal.** Boot is a deploy-token principal, not an account, with its own `__Host-bindle_boot` cookie. It has no recovery; lost access means a new token. Access expires after `BOOT_ACCESS_HOURS` (default 24) with an acknowledged setup.
- **Actor separation.** Console requests declare `X-Bindle-Admin-Actor: boot|admin`, with no fallback between credentials.
- **Admins.** Internal accounts holding the boot-only `admin` role. Internal status is proven by provenance on every read (`bs1` marker or matching admin-minted claim); admins cannot flag accounts internal.
- **Role and badge classes.** Boot sets internal, delegable or user. Admins may assign only delegable internal roles/badges to internal accounts and user-class roles to anyone. Claims for static reserved names are boot-only.
- **Reservations and claims.** Static `HOST_NAME_POLICY` reservations are a floor, with runtime additions. Reserved-name claims reuse the onboarding lane, bound to their exact digest. The `bs1` CLI path is retained.
- **Controls.** Step-up, per-actor rate limits, a hash-chained append-only audit log.

Review: F1 high (any admin could create internal accounts with arbitrary roles/badges, including static names) fixed by the delegable and boot-only static-name rules. F2–F7 fixed with regressions. Boot-admin tests 20/20 on both adapters.

Coordinator provisional decisions on open questions:
- admins must use passkeys for step-up;
- boot may end its own access early;
- admin suspension freezes the automatic account lifecycle;
- unused or expired claims release their name (identity-shards change pending);
- runtime badge editing and external audit anchoring deferred.

Mounting (http.mjs, Node store, Worker `AdminAuthority` DO) and the admin console UI are in progress. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Federation, embed origin and admin routes mounted; browser regressions fixed

- **Federation and embed origin.** The authorization entry slice and dedicated embed origin are mounted behind `FEDERATION_ENABLED`, `FEDERATION_ENTRY_ENABLED` and `EMBED_ORIGIN`. Worker uses one global entry store in a dedicated `FederationObject` with alarm cleanup; Node uses SQLite. `securePage({keepPolicy})` preserves handler CSP/COOP (F7 resolved). The manifest emits `features`/`profiles` only for mounted routes (F8 resolved). The components profile is published in the registry as provisional.
- **Admin.** Mounted only when `BOOTSTRAP_TOKEN_SHA256` is set or `ADMIN_ENABLED=true`. Worker uses an `AdminAuthority` DO (migration `v6`), Node uses `admin.sqlite`.
- **Regressions fixed.**
  - A shadowed `restored` variable in multi-account boot skipped recovery and billing resume.
  - Federation routes ignored member cookies (new `ownerContext`).
  - The top-bar switch button overflowed at 320 px.
  - SDK `define`/`callback` were missing from CORS.
  - The entry view refused same-origin GETs.
- **Tests updated for intended changes:** the expired session opens the chooser; header-less private writes return 409; contact copy.
- **Browser runner.** Raises only aggregate signup windows for its throwaway Worker; per-IP and production limits are unchanged.
- **Results.** Full browser gate green: portal 84/84, federation 4/4, authorization entry 2/2.
- **Review.** [Mount review](docs/release/federation-mount-review.md): M1, M3, M4, M6 fixed. M2 (no provider UI for `?entry=` yet, so the entry flag stays off) and M5 (single entry store availability) open. `boot/begin` lacks a rate limit.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Islands runtime implemented (unrouted)

Built:
- I1: protocol module `packages/sdk/src/islands-protocol.mjs`; validators return frozen copies or null.
- I2/I3: `apps/embed` shell, service worker, runtime, Web Locks leader worker, and parts `avatar`, `account-switcher`, `sign-in`.
- A5 client pieces: non-extractable IndexedDB key, leader-only restore, frame-initiated popup bridge following the COOP spike rules.
- I6: `packages/i18n/islands-catalogue.mjs`.

Tests: `npm test` 1078 passing. Chromium and Firefox island checks 18/18, using the real federation stack with two marked test shims. Frozen-leader failover is tested in Node with real `navigator.locks`. WebKit untested.

[Implementation review](docs/release/embed-islands-review.md): 10 findings plus 1 uncertain, all fixed. Among them:
- `forget` lost across bfcache;
- a signed-out switcher listing bindings;
- memory-only storage breaking leader fencing;
- the service worker pinning unhashed assets;
- binding-count-dependent redraw timing;
- an armed frame sliding under the cursor.

Platform findings: Firefox sends `Origin: null` under no-referrer; the island worker script requires COEP.

Open:
- server `view.subject`;
- avatar, events and session-end routes;
- shell serving and build entries;
- A7 authorize acknowledgement;
- FedCM in frame.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Boot and admin console UI

Boot setup/sign-in and the admin console are implemented. `admin-entry.mjs` loads only on `/console?boot|?admin`. `admin-console.mjs` is dynamically imported only after boot or confirmed admin authority, and is excluded from the service-worker precache. Strings: about 390 en/es entries.

Backend additions:
- `boot/end` (early end of boot access) and `boot/session` (CSRF restore);
- an admin-only `access` probe;
- passkey-only admin step-up, and `step-up/end` on leaving the console;
- `boot/logout` always clears;
- `boot/begin` rate limits: 5/min and 20/h per IP pseudonym, 200/h global.

Tests: UI-state 170/170, boot-admin 30/30. Real-browser e2e passes the boot → admin → passkey step-up → reserve → mint → onboarding claim → user lookup → audit verification path, plus dark/mobile, no admin code for ordinary accounts, and early boot end. Screenshots in `artifacts/browser/admin-*.png`.

[Reviews](docs/release/admin-ui-review.md): security found no Critical/High (3 low/medium and 3 info fixed). UX: 13 of 14 fixed, including all 3 High; U13 partial.

Coordinator fixed the onboarding config gap: `/api/config` `tokenOnboardingEnabled` now also honors `ADMIN_CLAIMS_ENABLED`.

Pending:
- identity-shards release of expired, unbound preissued reservations;
- backend wiring of the admin-suspension lifecycle freeze (the UI makes no claim).

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — SDK and elements provider-agnostic

`packages/sdk` now works against any conforming provider:
- conformance-floor check;
- versioned `features`/`profiles` via a capabilities module;
- per-provider client IDs and client-ID-metadata support;
- popup and FedCM only when declared;
- DPoP-bound refresh with nonce retry;
- per-session revocation;
- the dialog-based profile button in every mode;
- scheme-aware OKLCH initials avatars;
- an islands hook.

New modules: `capabilities`, `tokens`, `dpop`, `fedcm`, `handle`, `relay`, plus avatar/initials/tile/account-view elements.

The `<bindle-login>` alias and TypeScript shim are removed. The coordinator switched the remaining console, demo and smoke-test usages to `<bindle-sign-in>`, dropped `login-element` from the SDK CORS allowlist, and deleted the file.

The flaky elements test was a fixed 40 ms wait; it now waits for the session event (24/24 under parallel load). The contact-page discovery regression was fixed in the SDK by restoring the frozen floor-checked `manifest` in discovery results.

Bundle: the first render needs 17.68 KiB min+brotli (budget 18), with the controller and account view lazy-loaded. The public standalone bundle is 38.0 KiB unsplit, since js-tools has no code splitting.

Tests: core 1083/1083, UI-state 170/170, DOM smoke, and Chromium/Firefox element and provider-matrix checks 15/15; WebKit not runnable here. [Implementation review](docs/release/components-profile-review.md): no blockers; 4 Medium and 3 of 7 Low fixed, the rest recorded.

`auth.md` is reconciled: `token_type` describes only the access token, so short-lived Bearer access may accompany a DPoP-bound refresh token, and clients accept either. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Claim-name release and admin-hold lifecycle freeze

**Claim-name release.** Expired, never-redeemed admin claims release their name through the identity storage alarm on both adapters: Node `identities.sqlite` and the Worker `IdentityDirectory`. Release applies only to still-`preissued`, unbound, digest-matching reservations at least 10 minutes past expiry, and never to static, `boot`, assigned or redeemed names. Release and redemption are transactions on the same row, so exactly one wins; covered by a randomized race test in both orders.

**Lifecycle freeze.** Admin suspension freezes `AccountLifecycle` through a required `adminHold` port. Reactivation resumes once and restarts the clock, never deleting immediately, and paid protection is still checked first.

The automatic account-lifecycle executor (warnings, suspension, deletion for unpaid inactive accounts) is not wired to any scheduler. The freeze, and the user's retention policy itself, therefore have no runtime effect yet. This is a known roadmap gap, not new behavior.

Reservations created before the expiry index are not released. Tests: core 1098/1099 (the one failure is in in-progress islands serving), Worker 50/50. [Review](docs/release/boot-and-admin-review.md) follow-ups found no Critical/High, and its fixes are applied. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Islands served on the embed origin

- **Build.** Islands have their own checked import-map graph under `/embed/assets/`. The shell carries an inline import map whose hash is in its CSP; per-client `{{CONFIG}}` is filled at request time with verified escaping.
- **Routes.** On the embed origin only: shell with per-client `frame-ancestors`, assets with CORP/COEP, service worker, avatar, events and session end. The session view carries the subject.
- **Avatar.** Reads only provider-owned assets or `EMBED_AVATAR_ORIGINS` (Worker), re-encoded to PNG.
- **`Origin: null`.** Accepted only with `Sec-Fetch-Site: same-origin`, a Firefox no-referrer case. The coordinator recorded this in adaptive sign-in §13.4 and updated §14 discovery to the `features`/`profiles` model.

Tests: core 1100/1100, Worker 50/50, UI-state 182/182, build and dry run pass. Chromium and Firefox islands pass end to end against a local Worker; WebKit untested. [Serving review](docs/release/embed-islands-review.md): S2–S5 fixed.

Open:
- avatar CPU cost (S1);
- client consumption of `/events` and `session/end`;
- Node avatar fetcher;
- the A7 popup is still a stand-in;
- service worker untested in a browser;
- FedCM in frame;
- the islands browser test is not yet in the `test:e2e` runner.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Provider authorization-entry page (A7)

The provider page handles `?entry=` for login, select-account, reauthenticate and end-session, in popup and redirect presentation, and for frame-initiated popups:
- no account state before the opener key handshake;
- exact embed-origin delivery;
- frame-busting and delay-to-arm on approval.

Legacy consent now shares a consent kit with the entry page. Strings live in `packages/i18n/authorize-catalogue.mjs` (en/es).

Tests: core 1099/1099, UI-state 182/182 (12 new), entry e2e on a real local Worker 7/7 (Chromium), legacy federation 4/4. End-session ran against a simulated route, since there is no adapter end-session hook. [Reviews](docs/release/authorize-entry-ui-review.md): 6 security and 15 UX findings fixed.

The entry flag stays off in production until these are fixed:
- **S1 (high):** an app backend can probe, before consent, whether and as whom the user selected an account. The deny path trusts an unverified cookie prefix and responses differ by selection state.
- No end-session hook.

Other open items:
- weak anonymous cancel/end-session CSRF;
- no console `?entry=` return or add-account deep link;
- no "already approved" signal, so only identity-only entries are one click;
- `maxAge:0` never succeeds;
- entry view lacks `embed.origin`;
- `uiLocales` ignored;
- hard-coded brand text.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Authorization entry hardening

All seven server gaps from the A7 review are fixed:
- **S1 pre-consent leak.** Selection is per account. Owner steps verify session and CSRF before reading entry state. Cancel never consults an owner. The plain page declares plain mode on load. A test runs 20 probes × 4 selection states × plain/embed-plain and compares bytes and work counts.
- **End-session hook (Worker/Node).** Ends only this browser's session for that account after that member's CSRF, revoking first. `end-session` is advertised only when the hook exists.
- **CSRF.** Every entry POST requires exact Origin, same-origin Fetch Metadata and a per-entry token from the view.
- **`maxAge:0`.** Satisfied by a sign-in or step-up after entry creation. Device-approval sessions count only after step-up.
- **`embed.origin`.** Now included in the view.
- **Already approved.** A provider-page-only resubmittable access signal.
- **M5.** The entry store is sharded 64 ways by entry ID, with budgets on the caller's shard.

[Review](docs/release/authorization-entry-hardening-review.md): 6 findings fixed (plain-mode leak, double code, priorApproval scope, legacy end-session, device-approval freshness). Gates green: core 1133/1133, Worker 51/51, UI-state 185/185, browser gate 85+4+2+5.

`FEDERATION_ENTRY_ENABLED` remains off pending:
- human sign-off;
- registered production clients or `client-id-metadata.v1`;
- Firefox/WebKit/mobile evidence;
- checks against a deployed Worker.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Account lifecycle runner wired (flags off, dry run)

The lifecycle executor is wired behind `LIFECYCLE_ENABLED=false` and `LIFECYCLE_DRY_RUN=true`.

- **Scheduling.** Worker: cron `17 */6 * * *` drives a bounded, leased, resumable sweep in a new `LifecycleScheduler` DO (migration v7), which arms accounts that have no traffic. Account DO alarms run lifecycle ticks. Node: the same sweep every 6 h and at startup.
- **Notices.** Push to all devices plus email from `accounts@sys.3sln.me` when a verified email exists, with spaced attempts.
- **Suspension.** 423 on every account method outside an allowlist (status, reactivation, billing/webhooks, unsubscribe).
- **Reactivation.** `/api/account/lifecycle(/reactivate)` requires a sign-in within 15 minutes; the console shows an "I'm still using it" prompt.
- **Cold tiering.** R2 bindings offer no copy or in-place class change, so objects are moved with an etag-guarded same-key `put` to `InfrequentAccess`.
- **Purge.** Requires `LIFECYCLE_PURGE_ENABLED` and the final grace period. It commits a `purging` fence, tombstones the identity (handle kept, email released) and deletes only owned blobs. Accounts with external connectors are held.
- **Unused-account threshold.** 2 days, per spec.

Tests: core 1135/1135, Worker 51/51, UI-state 185/185, Worker dry run passes. [Review](docs/release/lifecycle-runner-review.md): 9 of 10 fixed, including purge after an unenforced period, tombstones enforced only in live mode, and webhooks refused while suspended.

In progress before purge can ever be enabled:
- refunded, charged-back and archived-product payers must count as ever-paid (item 5);
- a cost-based size threshold for cold tiering;
- documentation status updates.

Reviewer ___ Date ___ Outcome ___.

Lifecycle follow-ups:
- **Ever-paid marker.** Any order, refund, chargeback or subscription, observed by webhook or live Polar check, sets a permanent marker. Purge additionally requires a fresh successful Polar check; failure or ambiguity holds the account. All six cases are tested: refund, chargeback, archived product, deleted product, missed webhook recovered by API, API down.
- **Cold tiering threshold.** Only objects of 4 MiB or more move to InfrequentAccess (break-even about 1.9 MB). Hosted objects are currently capped at 1 MiB, so in practice nothing tiers. Suspended reads are still blocked.
- **Docs.** Retention and email docs now state the flags default off with dry run.

Unverified offline: Polar list behavior; a sandbox check is required before purge is ever enabled. Core 1141/1141, Worker 51/51, UI-state 185/185. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Client ID metadata documents (`client-id-metadata.v1`)

Implemented locally behind `CLIENT_METADATA_ENABLED` (default false), following the provisional decision to declare it.

**Resolution (`ClientDirectory`, `packages/federation/client-metadata.mjs`).**
- Exact URL syntax, GET with no redirects, 16 KiB limit, 3 s abort, exact validation.
- Cached 5 min–24 h; failures cached for 60 s and never as documents.
- Global, per-site and per-site entry budgets are charged before any fetch.
- Blocked hosts (including subdomains) and the provider's own hosts are refused. Static registrations take precedence and are never fetched.

**Egress.** Node uses the DNS-pinned adapter. Workers use strictly-public global fetch plus a DoH screen, which does not pin the connection.

**Trust and consent.**
- A validated snapshot passes as a separate argument and is persisted on owner approval (at most 128 per owner), so codes, refresh and RPC never refetch.
- CORS origin is derived from the client ID.
- Consent and entry pages name the app by verified host. `client_name` is shown only as isolated text labelled unverified, with a "not reviewed" notice; logos are never shown.

**Admin.** `blockClient`/`clientBlocks` with audit, plus a "Client hosts" console screen. The manifest declares the feature only when enabled with an egress port.

Tests: core 1157/1157, Worker 51/51, UI-state 189/189, Worker dry run passes. [Review](docs/release/client-metadata-review.md): no High findings; subdomain block bypass, budget churn, self-host clients and others fixed.

Residual risks:
- a distinct-ID flood can exhaust the global budget and evict cached clients;
- Node ignores `Cache-Control`;
- an existing token used without Origin survives up to 5 minutes after a block.

Production declaration still needs Workers egress verification against private and rebinding targets, plus sign-off. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Elements mount provider islands

`packages/sdk/src/elements/islands.mjs` now mounts provider islands per the declared parts:
- handshake to the exact embed origin;
- every message validated and translated into element events;
- island sign-in completes only after the app's own code exchange;
- failures fall back to the standard UI.

Islands stay mounted across sign-out so `forget` precedes `session{null}`. The leader consumes `/embed/api/events`. The island page sends `session/end` on pagehide, since worker requests did not reach the server. FedCM in the frame (`mediation:'required'`, key proof over a server nonce, feature-detected) is verified only against a test double; the provider FedCM endpoints do not exist yet. Fixed: app sign-out wiped the islands' pending sign-in. `islands-embed` and a new `islands-sw` suite (service worker over real HTTPS) joined the browser gate.

Tests: core 1159/1159, DOM smoke; islands, SW, provider-matrix and embed-elements pass in Chromium and Firefox. First render 16.94 KiB min+brotli; the mounter is 3.10 KiB, lazy.

[Review](docs/release/embed-islands-review.md) "Element integration": 8 of 11 fixed. Open:
- EL-2: the pagehide session end departs from EIR-4;
- EL-3: FedCM can lose user activation on slow networks;
- EL-11.

Server work remaining:
- FedCM endpoints and `fedcm:{configUrl,assertUrl}` in the shell config;
- entries accepting `embed-fedcm`;
- possibly one event stream per instance.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Identity/access test audit and engine-level chaos

[Audit](docs/release/test-audit-identity.md) classified about 60 identity-domain test files by level. Changes:
- Removed 7 real-time waits (sleeps, timeouts, a flaky DPoP edge) in favor of events, mock timers or fixed clocks.
- Removed 2 redundant tests.
- Sped up real-Argon2 recovery tests from 3.5 s to 1.1 s.
- Added about 80 engine-level edge, contention, fault and scaling tests, deterministic per seed and passing at five seed bases.

Shared helper `tests/helpers/chaos.mjs`:
- `createRandom`;
- `forEachSeed`, which names the failing seed and replays via `CHAOS_SEED`;
- `createScheduler`;
- `injectFaults` (throw, partial commit, duplicate, timeout);
- `fakeClock`.

Eight defects found and fixed:
- a redelivered shard prepare misreported as a conflict;
- a repository without a handle allocator stored raw-case handles, so case-variant duplicates were possible;
- the revoked-session count included expired sessions;
- cancel racing a decision produced a double entry outcome;
- 1 ms skew reset the admin rate window;
- concurrent claim mints both succeeded;
- unreserve racing a mint left an orphan live claim;
- a forward clock jump locked abuse/signup windows.

Core 1275/1275 in 11.3 s, Worker 51/51. Still open: revokeClaim racing a redemption past admission (fix in progress); duplicate capacity claims spend twice (fails closed). Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Messaging/data test audit and engine-level chaos

[Audit](docs/release/test-audit-messaging.md): most messaging-domain tests already call services directly (engine level). HTTP-level coverage is limited to the links, billing signature, conversation HTTP, beaming and MCP routes; `contact-preview` alone checks rendered HTML. Changes:
- Removed wall-clock dependence from 15 tests (frozen or injected clocks, mock timers, explicit drains), saving about 2.5 s of real waiting.
- Removed one duplicate test. Documented the remaining overlaps and internal-key assertions.

Added seeded engine suites, reproducible via `CHAOS_SEED`: `engine-links`, `engine-delivery`, `engine-tags`, `engine-billing`, `engine-storage-chaos`, `engine-search`, `engine-lifecycle`, `engine-item-index`. Helpers: `tests/helpers/engine.mjs` runs operations as ngin Actions over injected providers, plus `tests/helpers/messaging-fixture.mjs`.

Defect fixed: after a failed attempt whose blob cleanup also failed, retries of the same conversation event received 409 for up to 20 minutes. `packages/conversations/runtime.mjs` now releases the stale reservation first. The chaos test fails without the fix on seeds 2, 7 and 13.

Core 1275, Worker 51. In progress:
- a clock port for message-postbacks (UTC-midnight flake);
- form-fetch timers;
- a vacuous assertion in the portal callable-commands audit test.

Reviewer ___ Date ___ Outcome ___.
Messaging test leftovers closed: message-postbacks takes an injected clock (`FORM_POSTBACK_CLOCK`, default `Date.now`) with explicit UTC-midnight rollover tests; form-fetch deadlines use mock timers ticked after the request is in flight; the callable-commands audit test now asserts refusal-without-dispatch and single dispatch with the original token (no portal defect). Core 1276/1276.
Admin claim revocation and redemption now serialize on the claim record via a `redeemName` hook. Exactly one wins; a redeemed claim refuses revocation (`claim_in_use`) and keeps internal provenance. A marked but unfinished redemption cannot be revoked but still expires and is swept. Free and paid signup capacity claims carry the pre-generated account ID as a receipt, so a redelivered claim spends one unit, and a mismatched receipt fails closed. Seeded tests: `claim-redemption-chaos` (30 seeds, real services) and `signup-capacity-receipts`. Core 1279/1279, Worker 51/51.

## 2026-10-14 — UI polish pass

- **Tokens and accessibility.** About 46 ad-hoc grey text colors (many 2.3–3.9:1) consolidated into a `--muted` token at 4.7–5.4:1 (WCAG AA). The focus-ring token raised from 2.3:1 to 3.9:1 and extended to textareas, `summary` and `[tabindex]`. Minimum text size is 10 px.
- **Overflow fixes.** Rules cards (all widths), desktop sidebar, mobile security details, and an admin table at 320 px.
- **Admin overview.** Stat numbers were rendered at label size because of a selector bug; fixed.
- **Controls.** Device-page buttons grouped, "Sign out of all accounts" demoted from primary, five navigation entries given distinct icons, handles and island labels bidi-isolated.
- **Redeemed claims.** Shown as "Redeemed {time}" with no revoke or link actions. The coordinator exposed `redeemedAt` in the admin overview (boot-admin 36/36).
- **Evidence.** Before/after screenshot matrix (4 widths × light/dark × en/es, 452 captures) in `artifacts/browser/polish-*`. [UX/a11y review](docs/release/ui-polish-review.md): 8 findings fixed. Gates: UI-state 190/190, DOM smoke, core 1279/1279, browser gate pass.

Product decisions deferred to the user:
- dark theme for the signed-in console and docs;
- crowded mobile top bar;
- plural-aware Spanish keys;
- rule status pill placement;
- two primary buttons on the contact page;
- signed-out device-review affordance;
- raw shortcut `when` expressions in Preferences;
- the `n....` sign-in placeholder;
- "Set up" shown on unavailable resources.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — UI chaos suites

New suites:
- `tests/browser/ui-chaos.mjs` (UI-state, happy-dom): 100 seeds × 30 actions mixing account switches, offline/online, expiry, and faulted or out-of-order replies, plus hung requests, duplicate events, recovery, admin step-up and authorization entry.
- e2e: a fault harness `tests/e2e/chaos.mjs` with `ui-chaos`, `ui-chaos-scale` and `ui-chaos-contention`, plus `tests/browser/islands-chaos.mjs`. All are in the browser gate runner.

Defects fixed:
- raw "Failed to fetch" replaced with honest localized errors;
- an unreadable 2xx reply was treated as a refusal, clearing billing-change state;
- a 60 s request deadline added, so spinners no longer hang indefinitely;
- a failed refresh after a successful save reported failure;
- beam mutations lacked a busy guard (double submit);
- the account list could stay "Loading…" indefinitely;
- a wizard double-click skipped a signup question;
- transient faults on the entry page showed "expired";
- the contact page had no retry after a failed load;
- a bfcache restore blanked the console (it now reloads).

Gates: core 1279, UI-state 199, DOM smoke, full browser gate pass. [Flake review](docs/release/ui-chaos-review.md): 5/5 reruns per suite; four potentially vacuous assertions tightened, not yet re-reviewed. Headless Chromium only; bfcache was replayed with synthetic events.

Reported: View creation lacks an idempotency key, so a retry after a lost reply duplicates the View. Reviewer ___ Date ___ Outcome ___.

## 2026-10-14 — Final cleanup sweep

- **Dead code.** Removed unreferenced `packages/runtime/offload-metadata.mjs`, `apps/worker/transports.mjs` and `apps/web/src/release-model.mjs`, plus unused `NotificationDispatcher`, `lifecycleGated`, `MCPState`, `OBJECT_STORAGE`, `DPOP_ALGS`, `STORAGE_WRITE_LAYOUT` and five redundant generated-manifest exports.
- **Kept.** Documented public `PART_PATTERN` and `colorTokens`; documented cost-model scripts. `app-message-key` and `prepare-argon2` are now referenced from the app-messages and recovery-file specs.
- **Shared helpers.** UUID and canonical-JSON helpers consolidated into `packages/core/primitives.mjs` across 29 server files. Variants with different semantics were left alone, including the admin-store `canonical` that the audit hash chain depends on (commented).
- **Event rename.** `<bindle-sign-in>` now emits `bindle-sign-in-request`.
- **Idempotent View creation.** `POST /api/views` accepts a client `operationId` (UUID v4). A repeat returns the original View; reuse with a different definition returns `view_operation_conflict`; the 64 most recent receipts per owner are kept. The console keeps one ID per unchanged create attempt. Covered by `tests/engine-views.test.mjs` and a UI chaos case.
- **Gate.** `embed-elements` and `provider-matrix` added to the browser gate.

Tests: core 1283/1283, Worker 51/51, UI-state 200/200, DOM smoke, build and dry run pass. Browser gate: 175 of 179 passed, 4 WebKit cases skipped (WebKit unavailable here). Reviewer ___ Date ___ Outcome ___.

## 2026-10-15 — Engine-first application architecture (user direction)

Coordinator review found that the server app is mostly not an ngin Engine. Only identity, with a few Actions/Queries, and portal use ngin. Messaging, contact links/delivery, tags, conversations, storage, billing, search, lifecycle, federation and admin are plain service classes called directly from `packages/runtime/http.mjs`. The earlier description of services as ngin actions/queries (D020) was only partly true. The recent `tests/helpers/engine.mjs` wrapped plain service calls in a generic Action, so those tests were service-level tests; the helper is being removed and the suites relabeled.

User direction: the entire app logic, front end and back end, must be drivable through an ngin Engine regardless of environment, so agents and tests can explore and verify behavior against the engine before building or changing UI.
- Server domain operations become Actions/Queries composed into one application Engine.
- Storage, clocks, network, mail, push, billing and platform adapters (R2, Durable Objects, SQLite) become providers.
- Worker/Node HTTP layers become thin dispatch adapters.
- Client `bl/*` Actions get engine-level tests against fake providers, without rendering.

Plan: architecture design and pilot domain first, then a domain-by-domain migration behind existing tests. Reviewer ___ Date ___ Outcome ___.

## 2026-10-15 — Engine-first pilot

Added the application engine:
- `createAppEngine` in `packages/app`, which refuses providers outside the catalogue, requires clock, random and audit, and installs a read-only audit interceptor;
- the provider catalogue (platform stores, effects, domain stores);
- operation conventions: `{actor,id,input}`, one change event per mutation, at most one transaction per single writer, no nested dispatch, declared operation policy;
- owner-scoped providers that refuse a mismatched actor or bound store at lease time.

The engine runs inside each account's single writer (Durable Object or Node controller) through the shared `AccountController`. Views, incoming and tags now run end to end as 12 engine operations through one account `dispatch` RPC; the controller methods remain as facades. `DELETE /api/rules/:id` is now a single transaction, and a seeded test shows the old two-transaction shape lost updates.

Tooling:
- harness `createTestEngine` in `tests/helpers/app-engine.mjs` (faults, scheduler, fake clock, seeded IDs);
- engine CLI `npm run engine -- script.json` with `--db`, `--seed`, `--list`, `--repl`;
- client engine harness, with `tests/browser/engine-accounts.mjs` dispatching the real multi-account Actions against fake providers.

`tests/helpers/engine.mjs` was removed; delivery, billing and links suites are relabeled service-level until migrated. [Design](docs/architecture/app-engine.md), [review](docs/release/app-engine-review.md): 3 major findings fixed (method-name policy, test composition diverging from production, missing owner binding); `faultOf` adoption and a workerd rollback test deferred. Gates: core 1299, Worker 52, UI-state 205, DOM smoke, build, dry run and browser gate pass.

Coordinator decisions (provisional):
1. Owner-scoped providers are the authorization house style.
2. One generic `dispatch` RPC per single writer.
3. The request-tier engine is per isolate, with per-request actor/context passed explicitly as input.
4. Accepted behavior changes: `PUT /api/rules` without `rules` returns 400; rules/labels operations warm the account first; deleting a rule no longer revalidates the others; incoming updates warm before validation.
5. Audit: security-relevant operations are audited durably in the account's own store; other audit events go to logs.
6. MCP and automation tools become dispatches with an app actor.
7. The memory provider set moves into `packages/app`, so the CLI does not import test code.

Known flakes under heavy load: `ui-chaos` "recovery unlock" and `islands-runtime`. Being investigated. Reviewer ___ Date ___ Outcome ___.

## 2026-10-20 — Scope reduction: messaging leaves core; manifest extensions; activity stays

User direction:
- **Messaging leaves core.** Peer-to-peer messaging is removed from the core Bindle spec and from 3sln.me. It becomes its own app with its own interop spec (name TBD, e.g. "Bindle Inbox"), built adjacently in this repo as monorepo packages for now and split out later.
- **Manifest extensions.** The Bindle manifest gains an extension mechanism, probably an `extensions` array of objects pairing a role/slot manifest URL with metadata, so several apps can participate in one slot. The slot definition may decide selection policy, or the consumer may. This needs a robust, wargamed design covering edge cases.
- **Email bridge.** The public-handle email auto-reply (valuable as marketing) reconciles with this. When the user has a messaging app whose extension accepts public messages, that app handles bridged email, via the messaging extension or an intent mechanism.
- **Activity stays in core.** Notifications and app-originated alerts, as distinct from peer-to-peer communication, are presented in an activity UI with fine-grained push control. Each item is tagged with its app (an implicit filter facet), and apps can add their own tags.
- **Classification as a slot.** The messaging app consumes the host's classification/decision model through a preferences slot when available, and omits AI auto-classification otherwise.

NOTES.md adds near-term design work:
- **Apps and integrations under one umbrella.** Built-in integrations (e.g. Google Drive) and third-party apps share setup/config UI driven by config fragments. Manifests declare a webhook for preference updates.
- **Resource discovery and brokering.** Providers expose resources through a search/filter/browse endpoint by protocol or query. The Bindle provider brokers the introduction and owns the coupling credential, so it can sever access on demand. Consumers talk to resource providers directly via the returned RPC endpoint.
- **Messaging robustness** (now the messaging app's concern): participant limits, per-recipient delivery status with resend, a DO-queued send path with SSE progress, an optional host-level multicast receiving endpoint, and a scaling/edge-case research spike.

Later:
- a zero-KYC subscription/invoice registry;
- AI model resources and intelligence profiles via contracts.

Engine-first migration of messaging domains pauses until extraction boundaries are designed. Phase 0 (per-domain route/controller split) was interrupted mid-way by a usage limit and is being completed.

User direction (2026-10-20): generalize the QR device sign-in into a link plus correlation-code approval flow for other uses, e.g. console/CLI apps signing in. The approver opens the link in a signed-in browser (or signs in first) and confirms. The resulting session or token has the same or a shorter time limit than the approving session. Coordinator framing: align with the OAuth 2.0 Device Authorization Grant (RFC 8628) for app clients, while keeping provider session extension as the existing device sign-in. Phishing-resistant code display and consent copy are required, since device-code phishing is a known attack class. Design delegated (`docs/architecture/linked-approval.md`). Reviewer ___ Date ___ Outcome ___.
Phase 0 completed (Codex; coordinator-verified): `packages/runtime/http.mjs` is now a 75-line router delegating to per-domain `packages/runtime/routes/*`; account controller methods are split into `packages/runtime/account/*`; the in-memory provider set moved to `packages/app/memory-providers.mjs`; the per-slice file ownership map is in app-engine §12. Behavior unchanged: core 1299/1299, Worker 52/52 with real sockets (the Codex sandbox could not bind localhost).

## 2026-10-20 — Load-sensitive flakes fixed; messaging scaling spike; activity design

**Flakes (Codex).** Root causes, none fixed by raising timeouts:
- Islands tests used fixed sleeps that could precede message delivery, and failed assertions leaked ports and popup polling. Now observed-delivery waits, guaranteed cleanup and labeled fail-fast deadlines.
- The UI chaos "recovery unlock" case could start its duplicate dispatch after the first completed, leaving an unanswered request. The test now holds the first request open.
- Beaming tests registered late dynamic imports, so teardown restored `Event` before the final test. Imports now load before registration, with pending work drained.

Each suite passed 10 consecutive runs under 12 busy-loop children plus 4 concurrent processes, and lost-message injection now fails in about 2 s. Scratch probe files deleted. Coordinator-verified: core 1299/1299, UI-state 205/205.

**Messaging scaling spike (Codex).** [Spike](docs/release/messaging-scaling-spike.md): lessons from SMTP, XMPP, Matrix, ActivityPub, Signal/MLS and AT Protocol with primary sources, plus a P0/P1 checklist for the messaging app. P0 covers:
- app/core boundary;
- immutable event and audience identity;
- atomic acceptance with durable fan-out and honest per-recipient states;
- retry budgets and host breakers;
- key continuity;
- published bounds;
- retention without resurrection;
- metadata custody;
- SMTP provenance without backscatter.

**Activity (Codex).** [Core interop draft](docs/spec/activity.md), [host activity center](docs/architecture/activity-center.md) and [adversarial review](docs/release/activity-design-review.md). Signed app activity with required app attribution and namespaced app tags; lifecycle and limits; per-app opt-in push routing; multi-account safety; an exact migration list.

Open questions: push/digest limits; whether updates mark read items unread; expiry/history caps. Reviewer ___ Date ___ Outcome ___.

## 2026-10-20 — Link-and-code approval design (device authorization)

[Core draft](docs/spec/device-authorization.md), [host design](docs/architecture/linked-approval.md), [security review](docs/release/linked-approval-review.md).

- **One request type, two kinds.** "session" extends a provider login to another device; "app" serves CLI/TV clients via RFC 8628. Both share one user-code namespace and one `/approve` page.
- **Feature and binding.** Declared via RFC 8628 manifest fields plus `features["device-authorization.v1"]`. DPoP is mandatory, including for access tokens.
- **Lifetime.** Ends at the earliest of the approving session's expiry, the policy cap, or a user-chosen shorter duration (1 h preselected). Ending the approving session revokes everything it approved, transitively.
- **Freshness.** Approval requires a passkey or password step-up within 5 minutes. Sessions created by device approval, email link or recovery never count as fresh until their own step-up.

Mitigations after review:
- the user always types or pastes the code; QR carries only a request locator, with no confirm-only path in v1;
- codes are looked up only for a signed-in account, with failed-guess limits per account and network prefix plus a global budget sized to live codes;
- codes are stored as server-keyed hashes; device codes are single use;
- polls cause no storage writes;
- the requesting screen asks "Continue as @handle?";
- apps are named by verified host only; a country-mismatch warning instead of location; no pushed approval prompts, and a notice after every approval.

The review found two high-severity defects in the current device sign-in, being fixed now (slice LA1a, via Codex):
- **LA-R1:** device-approved sessions passed freshness for 15 minutes and got full 24 h lifetimes, enabling chained approvals, passkey addition or email linking.
- **LA-R2:** the QR review page displayed the code beside the entry field, and approval submitted the URL's code rather than the typed one.

Open questions:
- app credential cap (24 h or 30 days after step-up);
- whether ordinary sign-out also ends sessions it approved;
- the device grant for unreviewed metadata-document clients;
- default duration;
- pasted codes for CLIs;
- proof-of-work.

Reviewer ___ Date ___ Outcome ___.

## 2026-10-20 — Extensions, slots and unified integrations (design rev 2)

[Extensions draft](docs/spec/extensions.md), [integrations draft](docs/spec/integrations.md), [design note](docs/architecture/extensibility-design.md), [two-lens review](docs/release/extensibility-review.md): 24 security findings (3 High) and 22 interop findings (6 High), all answered in revision 2.

- **Slots.** A slot is a preference fragment with a `slot` member and exactly one resource field. Occupancy is the owner's value for that field, and consuming a slot is an ordinary fragment grant, so there is no new authorization primitive. A provider unaware of slots sees an ordinary fragment.
- **Selection policy** is fixed by the slot: `exclusive`, `ordered`, `broadcast` or `consumer-choice`. Owners pick occupants and order; consumers apply the policy. Failover never switches occupants after an ambiguous outcome, and `any-error` failover is allowed only for contracts whose methods are all read/pure.
- **Extensions.** Manifest `extensions` entries are claims, never assignments: `{slot, digest?, role: occupant|consumer, ref, purpose?, required?, options?}`. They appear in provider and integration manifests.
- **Profiles stay distinct.** A profile describes the host (one per provider, a map); only profiles may use the component-origin envelope. All three containers share processing rules.
- **Integrations.** Apps and integrations are one concept (external or built-in). The integration manifest lives within OAuth client metadata, and approval creates the existing app connection, extended with state and generation. Preference updates are RFC 8417 events carrying a full snapshot and a sequence number.
- **Discovery** is a provider-only search/filter/browse/probe call.
- **Brokering.** Consumers call integrations directly with 300 s provider-minted RFC 9068 tokens returned through `preferences/v2`. Severance commits first, then sends invalidations; a conforming integration cuts access within 360 s even if the invalidation is lost.

Core amendments C1–C11 are proposed, not yet applied. Notable ones:
- C1: fragment schemas accept the `slot` member (current `schema.mjs` rejects unknown members);
- C3: one unapproved occupant no longer hides the field from consumers;
- C8: bounded-delay revocation for brokered resources.

Implementation slices X1–X12 (critical path X1 → X3 → X4) are in the design note. Open questions:
- public per-entity slot resolution;
- the 360 s revocation bound versus introspection for write contracts;
- a separate integration-manifest fetch;
- built-in occupants never preselected;
- slot registry location.

Reviewer ___ Date ___ Outcome ___.

User accepted the coordinator recommendations (2026-10-20):

Device authorization:
- app credentials up to 30 days only with fresh sign-in at approval;
- ordinary sign-out also ends sessions it approved, after a clear warning;
- no device grant for unreviewed metadata-document clients initially;
- 1 h default for app approvals and normal session length for session approvals;
- pasted codes acceptable for CLIs;
- no proof-of-work yet.

Extensions:
- 360 s bounded revocation acceptable for read-only brokered contracts, while write-capable contracts require live introspection;
- built-in occupants are never preselected;
- core amendments C1–C11 approved provisionally.

## 2026-10-20 — BindleBox messaging app design

[Design](docs/architecture/messaging-app.md), [interop draft](docs/spec/bindlebox.md), [extraction plan](docs/architecture/messaging-extraction.md), [two-lens review](docs/release/messaging-app-review.md): 3 blockers and 14 highs, all fixed in docs. The blockers were one-way conversations, groups never forming, and app switching that made users look like forgers. Name recommendation: BindleBox, chosen from eight candidates; no trademark search done.

- **Signing.** The app holds its own per-user key, bound by a provider-signed certificate (≤24 h, limited to message/receipt/archive signing, naming the app's certified delivery URL). Rotation revokes the predecessor, and revocation checks are mandatory for edits, deletes, membership changes and receipts. The identity key stays with the provider and still signs links.
- **Core keeps** the generic link envelope, response signing, replay records and landing pages; link issuance/policy services for apps; the new key-delegation feature; activity; the SMTP entry point.
- **BindleBox takes** the contact-link type, conversations, Views, tags and rules.
- **Send queue.** One per-user queue on the app's Durable Object with per-recipient tasks, network calls outside transactions, spike-derived retry budgets, and a monotonic recipient count. Per-recipient delivered/pending/failed/cancelled states, "Retry missing", automatic per-person catch-up, and SSE progress that survives reconnects.
- **Host multicast** is optional, at most 32 recipients per request, with credentials verified before any mailbox wakes.
- **Email bridge** via the public-message-intake slot, with one invariant auto-reply.
- **No public per-entity slot lookup is needed**; contact links and signed conversation updates suffice.

Extraction plan: new `packages/links`, `packages/content`, `packages/bindlebox-protocol`, `packages/bindlebox-engine` and `apps/bindlebox`, with an import-boundary test. Existing messages are reset rather than migrated (pending user confirmation). BindleBox is engine-first with a multi-party network simulator. Slices: C0–C3 core, B0–B9 BindleBox, then cutover X1 and email bridge X12.

User addition: for public/anonymous requests, BindleBox supports auto-rejection rules through classification, with tiers:
- "very likely spam" auto-rejected by a default rule (recoverable for a short period);
- "could be spam" tagged and deprioritized by a default priority rule, but reachable.

Being folded into the design. Reviewer ___ Date ___ Outcome ___.
BindleBox public-request spam tiers (design §12.1, spec §6.7):
- "very likely spam" (classifier probability ≥0.97, provisional) is promoted to `sys:spam` and auto-rejected, with no notification and only the fixed bridge reply.
- "could be spam" (0.70–0.97) stays `sys:suspected.spam`, quiet and sorted low but acceptable.
- Thresholds are bound to the classifier model version, and a model change suspends auto-reject until re-tuned.
- With no classifier, deterministic heuristics only and never auto-reject.
- A recoverable "Rejected" view (500 items or 7 days); allowlisted senders never auto-rejected; per-sender, per-domain and per-owner rate limits.
- Rejection happens after storage, so senders learn nothing about classification.
Abuse cases A-1–A-8 added to the review (not independently re-reviewed). The activity-center migration table is corrected so `email.mjs` and `dispatcher.mjs` stay in core.

## 2026-10-20 — Device sign-in security fixes (LA1a) and step-up follow-ups

LA1a (Codex) fixes LA-R1 and LA-R2:
- device-approved, email-link and recovery sessions require their own credential step-up before counting as fresh;
- device sessions inherit the approving session's expiry and revoke transitively when it ends;
- QR/links carry only a request locator, and approval submits the typed code, compared by hash in constant time, never displayed.

Regression tests and en/es copy added. `protocol.md` lists `device-authorization.v1` (proposed), `device-login.md` carries a supersession note, and the new spec is in the public docs.

Browser-gate follow-ups:
- `identity-names` relied on activation sessions counting as fresh.
- The `authorization-entry-ui` end-session flake was pre-existing: random test IPs collided on the per-IP signup cooldown. Fixed with sequential test addresses; no limits changed.
- The occasional 10-minute core run traced to fixed 10 ms sleeps in `packages/sdk/test/flows.test.mjs`, which fail under parallel load and then hang the run.

Coordinator decision:
- Signup activation that itself completed a passkey or password ceremony counts as fresh, while device approval, email link and recovery do not.
- An owner step-up route plus an inline "Confirm it's you" prompt replaces forced sign-out/sign-in.

Being implemented together with the flows-test and ui-chaos-scale timing fixes. Reviewer ___ Date ___ Outcome ___.

## 2026-10-20 — Integrated roadmap; Wave 0 committed; Wave 1 started

The [integrated implementation roadmap](docs/architecture/implementation-roadmap.md) merges the extensibility, BindleBox, linked-approval, activity and app-engine slice plans into seven dependency-ordered waves. It uses prefixed slice IDs, append-only registries, single owners per file per wave, and default-off flags. BB-CUT is the only irreversible step (message data reset; tag before it). Engine migrations ENG-2/3/4/5 are cancelled: messaging domains are built engine-first inside BindleBox.

Wave 0 (commit c86e0ae):
- six default-off flags;
- the BindleBox test glob;
- an append-only storage resource-method dispatch registry;
- core spec amendments AMD-C1–C11 applied to the specs (code work tracked under EXT slices);
- linked-approval decisions recorded.

Gates: core 1324, Worker 53, UI-state 216, Worker dry run pass.

Wave 1 streams in flight:
- Codex: EXT-X1 slot validation, EXT-X9a conformance fixture, LA6 SDK device helper, LA4 approval page (mock-first), BB-C2 records/content move, BB-B0 BindleBox skeleton.
- Claude: LA1 identity core, IDKEYS-1 key registry, EXT-X5 brokering keys/JWKS.

BB-B1 protocol follows B0.
User decision (2026-10-20): the peer messaging interop spec is named "Bindle Messaging" (descriptive), separate from the messaging app product name. App name pending: coordinator recommends "Parley", with "3sln Messages" as the plain fallback; no trademark search done. A mechanical rename of `bindlebox` docs and packages follows the app-name decision, after the current wave lands.

EXT-X5 landed (provisional): `packages/federation/signing.mjs` provides purpose-separated ES256 brokering keys (invoke, describe, discover, event), sealed at rest with an HKDF/AES-GCM key derived from `KEY_ENCRYPTION_KEY`. Each purpose has a published standby key, and retired keys stay at least 630 s. RFC 9068 `at+jwt` minting runs at most 300 s (60 s for discover/describe), with low-s-only verification. A flag-gated `/oauth/brokering/jwks` route and a provisional `brokering_jwks_uri` appear only with `BROKERING_ENABLED`. [Review](docs/release/brokering-keys-review.md): 2 medium and 4 low findings fixed. Pending: integrator wiring of the `brokering` option into `handleFederation`, the X8 move of `brokering_jwks_uri` into `brokered-resources.v1`, a key-compromise runbook with CDN purge. Reviewer ___ Date ___ Outcome ___.

IDKEYS-1 (BB-C0) landed: `packages/identity/keys.mjs`, an engine-first `IdentityKeyRegistry` with Ensure, Rotate (CAS on `expectedKid`), Revoke and legacy Register; queries by kid, current key and history; `verifyKeyContinuity`; and a `resolveIdentityKey` directory hook. Signing keys keep `contact-key/` records for compatibility; encryption keys get their own. Key states only move forward (active → retired → revoked). `contact-tokens.mjs` delegates to and re-exports the registry, and `account/identity.mjs` runs on the engine. 13 tests including 25 seeded chaos runs and a rejected pre-rotation recovery file. [Review](docs/release/identity-keys-review.md): 6 findings fixed. Rotation stays internal (no route) until C1a moves link minting to the current key. An open race in `packages/conversations/runtime.mjs` is outside scope; that module is deleted at BB-CUT, and its replacement must not repeat the race. Core 1403/1403, Worker 53/53. Reviewer ___ Date ___ Outcome ___.

Wave 1 Codex streams landed. Each passes its own suite; cross-stream integration is pending:
- **EXT-X1 slot validation:** `packages/federation/extensions.mjs`, fragment validator tolerance per AMD-C1, digest pinning, policy semantics, engine wrappers flag-gated and unmounted; 19 tests.
- **EXT-X9a:** reusable engine-backed integration server fixture `tests/fixtures/integration-server.mjs` (webhooks, discovery, token stubs, invalidation); 6 tests plus 6 conformance todos.
- **LA6 SDK device helper:** `packages/sdk/src/device.mjs` with RFC 8628 polling, DPoP and cancellation. Transport injection is required because Node fetch adds a forbidden header; identity hints require a trusted `expectedSubject`. 25 harness tests; `.example` CLI examples.
- **LA4 approval page:** `apps/web/src/{bl,ui}/approve.mjs` plus catalogue, built mock-first; 13 browser checks across widths, languages and themes, including same-tab sign-in and step-up. Legacy QR review page removed; unmounted pending LA3.
- **BB-C2 pure move:** `packages/core/records.mjs`, `packages/content/*`, `runtime/lifecycle-notices.mjs`, with re-exports.
- **BB-B0 skeleton:** `packages/bindlebox-engine/*`, harness and seeded network simulator, import-boundary test, `scripts/bindlebox.mjs`; 9 tests.

Known cross-stream breakages to reconcile:
- UI-state/device-login tests asserting the removed review page;
- e2e fixtures serving form-policy without its moved dependency;
- link HTTP 404 assertions;
- a key-registry ordering assertion;
- a DOM storage check;
- an intermittent Worker EPIPE.

BB-B1 protocol started.

## 2026-10-20 — Event buses, rich consent and incremental authorization (user direction)

- **Event buses in core.** An integration can request read, write or readwrite access to an event bus identified by URI. A bus manifest describes the bus, its purpose and its schema. As with preference fragments, the user can see who has access to each bus, what kind of access, the bus's purpose, and in human terms what that access lets an app do.
- **Consent screens.** Integration consent is a guided walkthrough of exactly what the user is signing up for: what each requested access or grant lets the app do. Not too verbose, but not lacking the detail needed to understand it.
- **Incremental authorization.** Apps can request new permissions, privileges and preference fragments lazily, on demand, through a redirect or through the isolated 3sln.me custom elements and islands. Unconfigured fragments must be filled in before consent, so the request lets the user fill them in.
- **Configuration requests.** Apps can ask to open a preference fragment, or a single field, for the user to edit, for example to request a particular configuration. The user must actually configure it or accept the app's suggested configuration.
- **Request suppression.** The user can choose never to let an app make a given request again, to prevent spammy behavior.

Design delegated (`docs/spec/events.md`, `docs/spec/incremental-authorization.md`, `docs/architecture/consent-experience.md`). Reviewer ___ Date ___ Outcome ___.

LA1 landed: `packages/identity/linked-approval.mjs` holds one record type for session and app requests.
- Codes are base-20 with an HMAC index (`LINKED_CODE_KEY` or `KEY_ENCRYPTION_KEY`) and are looked up only when signed in.
- Guess budgets per account, per network and globally (sized to live codes); polls never write; consumption is single-use; "Continue as" on the requesting screen.
- App credentials 30 d / 7 d idle; atomic lineage revocation with an outbox.
- Contract in linked-approval §10.1: browser `LinkedApprovalAction`/`LinkedResolveQuery`, and an unrouted system `LinkedSystemAction` for LA2 with `LinkedLineageQuery` checked on every refresh, failing closed.
- New operations return `not_found` unless `DEVICE_AUTHORIZATION_ENABLED` is on. Legacy `/api/auth/device/*` aliases run on the new core with the flag off.

25 tests including chaos interleavings; core 1428/1428, Worker 53/53. Review S3, S4, S6, S7, S8 fixed and S5 partly fixed. Open:
- **S1:** admin suspension and lifecycle tombstones clear sessions without revoking lineage, so an app could return after reactivation. Must land before LA2 issues app credentials.
- **S2:** no physical deletion of linked-approval records yet.

Integration pass started. Reviewer ___ Date ___ Outcome ___.

User direction (2026-10-20): integration/app credential lifetimes should not be aggressive, since users can revoke manually; apps refresh automatically, involving the user only after very long disuse. Coordinator decision (provisional), superseding the 30 d absolute / 7 d idle app lifetime:
- access tokens of at most 5 minutes;
- DPoP-bound refresh tokens rotated on every use with reuse detection;
- live grant/account checks on every refresh, so revocation and suspension stay immediate;
- no absolute lifetime for an app connection;
- idle expiry of 180 days by default (host-configurable);
- one fresh step-up at approval only.
Device session approvals keep session semantics, capped by the approving session. To be applied across `auth.md`, `device-authorization.md`, `linked-approval.md`, `packages/federation/app-sessions.mjs` and the linked-approval core after the Wave 1 integration pass. Reviewer ___ Date ___ Outcome ___.

## 2026-10-20 — Event buses, consent walkthrough and incremental authorization (design rev 2)

[Events](docs/spec/events.md), [incremental authorization](docs/spec/incremental-authorization.md), [consent experience](docs/architecture/consent-experience.md), [two-lens review](docs/release/events-consent-review.md). All findings were addressed in revision 2; the fixes have not been independently re-reviewed.

- **Buses reuse slots.** A bus manifest is a one-occupant slot with a required `bus` member. The occupant is a resource implementing a new `event-bus/v1` contract, and read/write/readwrite access is an ordinary fragment grant, so revocation and access listings come for free.
- **Hosting** is the owner's choice: 3sln.me (immediate revocation, push available) or an integration (pull only, every publish checked live).
- **Delivery.** Push is a data-free doorbell on the integration event channel, with one pending doorbell per subscriber. Reads are cursor-based with long-polling; SSE deferred.
- **Ordering.** One total order per bus; retention gaps are always reported; new readers start at approval unless the owner opts into history.
- **Cost.** Publishing draws a separate event allowance, so feeds never block owner writes. Per-feed byte caps, a daily long-poll budget, and empty reads are charged.
- **New intents** `grant-more` and `configure` go through the authorization entry. Results are granted / partial (with the full current grant) / declined, or configured / unchanged.
- **`configure` never changes permissions.** Suggestions cover plain fields only, each accepted individually; URL, email/host and cross-app-received fields need their own confirmation.
- **Tokens** are issued only when access was actually added.
- **Suppression is invisible to apps,** which see only a decline. Blocking requires one armed click, and decline cooldowns (24 h / 7 d / 30 d) count only real owner decisions.
- **Consent copy** comes from the 3sln.me reviewed catalogue, then the named contract publisher, never the app. The app's reason is shown as its own claim. Four risk tiers, never conveyed by color alone.

Slices EV/IA/CX are added to the roadmap; AMD-C12–C20 are proposed and unsigned. Reviewer ___ Date ___ Outcome ___.

BB-B1 landed: `packages/bindlebox-protocol`, a pure, deterministic Bindle Messaging v1 library (Web Crypto only, no I/O, clock or randomness). It covers envelope, genesis, invitation-response, receipt and descriptor shapes for all kinds and 11 record types; digests, event IDs and domain-separated signers; delegation certificate parsing/verification with injected directory/status ports; receipts returning `unknown` on any doubt; pair-gate credentials, audience freezing and author-keyed replay; strict delivery/multicast/RPC parsers; failure classification. 21 fixed signed vectors plus multipart, multicast and pair-token vectors; seeded fuzzing caught one bug. Core 1470 (6 todo), BindleBox suite 44 including the import boundary. [Review](docs/release/bindlebox-protocol-review.md): BR-1 high (a signed `identityURI` could redirect the status check and bypass revocation; now pinned to the directory value), BR-2/3 medium and BR-4–10 low, all fixed. Spec items for the design owner: `secret-share` should require a status check; envelopes are signed per recipient; multicast results lack per-context status; gap/introduction liveness. Reviewer ___ Date ___ Outcome ___.

Wave 1 integration (Codex, coordinator-verified):
- legacy QR approval works through the LA1 aliases, with a Worker CAS fix for consumed requests extending expiry; the code-revealing review page stays removed;
- the moved form-policy dependency is bundled for fixtures;
- link HTTP tests no longer depend on prebuilt assets;
- fixed DOM sleeps replaced with event waits;
- a Worker test transport upload race (EPIPE) fixed, 12 stress runs passing;
- S1: suspension and tombstoning atomically revoke approval lineage, with the durable outbox kept and tests proving reactivation cannot revive app authority;
- S2: bounded cleanup of expired approval records with Node alarm restoration;
- EXT-X5 brokering JWKS wired into federation behind its flag.

Gates: core 1470 (46 s), Worker 55, UI-state 215, DOM, build, dry run, browser gate 179 with 4 WebKit skips. Wave 1 committed as ec34575.

Wave 2a started:
- Codex: EXT-X2 declaration registry, BB-B3 send queue/events, EV-1 bus manifest validation.
- Claude: LA2 device grant (also applying the new app lifetime model), EXT-X3 integration manifest, BB-C1a core links (link minting moves to the current registry key), ACT-1 activity backend, BB-B2 receive/contacts/intake with spam tiers.

IDKEYS-2 proceeds next with 24 h delegation certificates as a provisional default pending the user's answer.
User decision (2026-10-20): app/integration access tokens last 15 minutes when bearer and up to 60 minutes when DPoP-bound, both host-configurable. Rationale: every RPC checks the live grant, so revocation stays immediate regardless of token lifetime, and longer lifetimes cut refresh writes (288 per active day at 5 minutes vs 96 at 15) and rotation races. Rotation, reuse detection, no absolute lifetime and the 180-day idle expiry are unchanged. Sent to LA2.

EXT-X3 landed (unmounted): `packages/federation/integrations.mjs` parses `bindle_integration` from client metadata only. Every URL must sit on the `client_id` origin and path prefix, with an 8 KiB bound; confidential members in a public document invalidate the manifest. AMD-C7 accepts `private_key_jwt` clients only with integrations.v1. Key sets use the client-metadata egress and cache, with RFC 7638 thumbprints pinned, and the §2.3 classifier adopts only narrowing changes. [X3 review](docs/release/extensibility-review.md): S1 high (a copied public key bypassed pinning) fixed by keeping added keys pending until a pinned key vouches for them, a provisional deviation from integrations §2.3 needing sign-off; S3–S5 fixed. S2 open: the Node egress adapter hides 404/410 and drops `Cache-Control` (queued for the Wave 2 integration pass). The spec example names setup fragments `id` while code uses `fragment`; both accepted pending a spec fix. Reviewer ___ Date ___ Outcome ___.

Wave 2a Codex streams landed:
- **EXT-X2:** append-only manifest declaration registry with flag-and-mount gates and bounds; existing manifests byte-identical.
- **EV-1:** bus manifest validation and pinning with engine Query/Action behind a new default-off `EVENT_BUSES_ENABLED`; provisional unpublished `docs/artefacts/event-bus-v1.json`; 11 tests.
- **BB-B3:** durable per-recipient send tasks, retry budgets, host breakers, cancellation fencing, Retry missing/catch-up, and resumable progress (finite SSE replay batches). 23 tests including SQLite recovery and the 1000-recipient bound. Submission accepts prepared signed envelopes; manual retry grants one additional ten-attempt allowance.

Pending for later integration: alarm wiring, receive catch-up wiring, archive capacity reclamation, Worker queue recovery verification. Cross-stream test failures await the Wave 2a integration pass after the Claude streams land.

BB-C1a landed (provisional): generic link machinery in `packages/links/{envelope,replay,audience,preview,profile,policies}.mjs`, with identical re-exports from the old paths (test-asserted). Contact links are minted with the current registry key, re-checked at commit; retired keys still verify, revoked keys never do. A flag-gated links contract (`issuance`, `types`, `engine`: issue, revoke, rotate, evaluate, list, changes) authorizes app actors by current slot occupancy through a `LINK_SLOT_OCCUPANT` port, refusing everything without it. Owner account slice and routes; no RPC exposure yet. 13 new tests. [Review](docs/release/core-links-review.md): revoked links holding the cap for about 13 months, orphan grants after a rotation race and a missing owner check, all fixed. `evaluate` trusts the app-supplied principal (rate-limited); C1b must send a verifiable author proof before mounting. Provisional rule: a new slot occupant inherits the previous app's links. Identity key rotation may now get a route. Reviewer ___ Date ___ Outcome ___.

ACT-1 landed (provisional, behind `ACTIVITY_V2_ENABLED`): `packages/activity` plus engine domain `activity`.
- App-bound create/replace/retract with per-revision ES256 admission evidence.
- Namespaced app tags, refusing all `sys:` and colon look-alikes.
- Incarnation-scoped deduplication; hashed collapse groups that coalesce only pending work.
- Exact-revision replace/retract with a reserved tombstone slot; terminal expiry; private read/archive.
- Per-app limits across reconnections plus account totals, with a separate retract reserve and receipt lane. App operations are not owner-dispatchable.
- v1 messages are surfaced through a read adapter, marked unverified unless the caller checks them. `/api/activity` route added.

16 new tests. [Review](docs/release/activity-design-review.md#act-1-implementation): S1/S2 medium (receipt starvation, per-app storage exhaustion) and S3–S5/S9 fixed, plus an issuer omission in budget, tag and receipt keys found during fixes; S6, S7 and S10 open. Pending: an activity resource descriptor in `packages/runtime/federation.mjs` (integration pass), v2 forms, lifecycle export, ACT-2 dispatch. Reviewer ___ Date ___ Outcome ___.

BB-B2 landed (provisional, unmounted): the BindleBox receive path for link-kind deliveries.
- **Cheapest refusal first:** the edge-index credential check runs without waking a mailbox, followed by exact meta segments, framing, owner key and author verification. Live status is checked per spec §3.4, and known revocations are refused otherwise.
- **One admission transaction** covers replay, the live authorization recheck, budgets, storage and the receipt, so a receipt is never issued before commit.
- **Contacts:** parents via the links contract, local-first revocation, adding contacts from a link, blocks.
- **Budgets** per sender, per domain and per owner, plus §12.1 public-request limits.
- **Spam tiers** apply after custody: model-pinned thresholds, calibration mode, heuristics that never reject, an allowlist, and a 500-item / 7-day recoverable Rejected view. Bridged intake checks provenance.
- **Delegation:** status caches and a recheck sweep quarantine items when a revocation is learned.

23 simulator tests; BindleBox suite 93/93. [Review](docs/release/bindlebox-receive-review.md): BB2-R1–R8 fixed (orphaned staged bodies, body overwrite on conflict, refusal amplification, intake dedup binding, occupant self-calibration, spoofed allowlist, incomplete erasure, allowance overspend). BB2-I1 open: owner policy changes do not yet clear cached audience decisions. Operation registration is left for integration. Reviewer ___ Date ___ Outcome ___.

LA2 landed (unmounted, flag off): the RFC 8628 provider for reviewed clients only, as engine `AppAction`s over a `deviceGrant` provider (`DeviceAuthorize`, `DeviceToken`, `DeviceReview`, `DeviceApprove`, `DeviceRpc`, `DeviceCancel`, `DeviceLineageDrain`). DPoP-bound access and refresh, single redemption, lineage checks on every refresh and RPC. The wiring contract for LA3 is in linked-approval §10.2. App lifetimes per user decisions now apply to every app grant: no absolute limit, `APP_REFRESH_IDLE_DAYS`=180, `APP_ACCESS_TOKEN_MINUTES`=15, `APP_DPOP_ACCESS_TOKEN_MINUTES`=60, a 30 s grace, live checks on refresh and RPC (RPC already rechecked grants). App approval duration choices are now `ongoing` (default), `1h` and `8h`, consistent with the later no-absolute-lifetime direction, superseding the earlier 1 h default. 13 tests with seeded single-redemption chaos. [Review](docs/release/linked-approval-review.md): LA2-S1, S4–S7, S9, S11 fixed. Open: SDK token ceilings and `refresh_expires_in` semantics (a release blocker), `service.mjs` initial `issueAccess` still 5 min, LA4 duration list, LA7 `expiresAt:null`. Reviewer ___ Date ___ Outcome ___.

Wave 2a integration (Codex, coordinator-verified):
- SDK and federation lifetimes aligned (15 min bearer / 60 min DPoP access, rotating refresh, sliding 180-day idle, bounded history, child tokens, cleanup);
- approval choices `ongoing`/`1h`/`8h` with en/es copy and null expiry;
- the flag-gated activity resource descriptor, with consent → token → RPC coverage;
- Node egress preserves 404/410 and Cache-Control;
- the integrations spec example uses `fragment`;
- BindleBox operations and providers registered, and the CLI simulator wired with an end-to-end send → receive → verified receipt → status proof;
- CLI operation expectations derived from registries.

Gates: core 1595, Worker 55, UI-state 215, BindleBox 96, DOM, build, dry run, audit; browser gate 179 with 4 WebKit skips.

Wave 2a committed and deployed as 0b92f9a (flags off). Wave 2b started:
- Codex: LA5 requesting screen; CX-1 consent risk/wording model (`packages/consent`).
- Claude: IDKEYS-2 app key delegation certificates (24 h host-configurable maximum, provisional) with a public status endpoint; ACT-2 activity push policy.

IDKEYS-2 landed (provisional, flag off). `packages/identity/delegation.mjs` issues `key-delegation.v1` certificates as engine Actions/Queries:
- only to the messaging-ingress occupant reported by a fail-closed `DELEGATION_SLOT_OCCUPANT` port;
- only for consented author, receipt and archive purposes, with proof of possession, refusing identity-key aliases;
- signed with the current registry key; host-configurable lifetime `DELEGATION_CERTIFICATE_SECONDS` (24 h maximum, provisional);
- a new key revokes its predecessor, and renewal keeps `since`;
- revocation by key, by client or all; bounded history and audit.
Core encodes certificates itself, since it cannot import the protocol library; a cross-test pins compatibility. Public status `GET /identity/<sub>/delegations/<jkt>` gives uniform answers with `max-age=300`, immutable once a revocation is persisted. 14 tests. [Review](docs/release/key-delegation-review.md): KD-1/2/3/5/6/7 fixed, KD-8 partly fixed. KD-4 open as a production gate: uninstall and suspension hooks must revoke delegations, which needs lifecycle/suspension, EXT-X4 and C1b wiring. Reviewer ___ Date ___ Outcome ___.

CX-1 landed: `packages/consent/{effects,localization,reviewed-contracts,index}.mjs`.
- Four risk tiers.
- Wording precedence: 3sln.me catalogue, then contract publisher, then fallback, never the app, with factual attribution. App claims shown separately.
- en/es localization; feed-reader escalation.
- Unreviewed apps refused tier-4 requests.
- Engine queries unmounted and default-off.
25 tests. Integration must supply verified metadata snapshots and a registrable-domain resolver.

LA5 (Codex) implemented the flag-gated requesting flow (start, poll, accept, cancel, locator validation, expiry, backoff, cancellation fencing; 14 harness tests). It stopped short of the visible screen because `ui/release-auth.mjs` and `release.mjs` were outside its ownership. The coordinator granted an exception for those device hunks, and the screen is being finished.

ACT-2 landed (provisional, behind `ACTIVITY_V2_ENABLED`): activity push policy as engine operations.
- Per-app, per-incarnation opt-in (default off).
- Ordered app-scoped rules overriding the app's priority claim (capped at normal).
- Mutes, quiet hours (fixed offset or IANA zone), digests, per-app and account budgets, collapse cooldowns, Web Push `Topic`.
- Generic lock-screen text unless both account and device consent.
- The leased outbox re-checks state before transport.
Owner operations are reachable only via the flag-checked `activityPush` RPC, avoiding ACT1-S10. [Review](docs/release/activity-design-review.md): R1–R7, R10 fixed. Open:
- R8: named zones deviate from the design; accepted as an improvement, pending design update;
- R9: preview enablement without device proof;
- R11.
Also pending: an outbox scheduler and `sw.js` rendering of activity notices. Core 1646/1646. Reviewer ___ Date ___ Outcome ___.

LA5 finished behind the default-off flag: device choice, link and code, locator-only QR, account confirmation, polling, expiry and cancellation. The legacy QR flow keeps working. 15 engine and 28 browser tests (en/es, 320/390/1440 px, light/dark). LA3 must mount the linked routes and add QR locator support.

Wave 2b verified: core 1646, Worker 55, UI-state 215, DOM, build, dry run. Codex full browser gate 178 with one provider-matrix assertion failure that passed 3/3 in isolation (watch for flakiness) and 4 WebKit skips.
