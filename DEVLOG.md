# Development log

## Working agreement

This log is the project ledger for decisions, implementation, evidence, and pending work. Major choices remain provisional until a human signs below; unsigned entries do not automatically block reversible work. Production authentication, migrations, deployment, and externally consequential changes require their implementation gates to be satisfied. Every agent must report changes here through the coordinator. The user subsequently authorized infrastructure, repository creation, and publication **when release ready**; no production deployment has been performed.

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

User expanded the actual-release scope to contact tokens, blob messaging, notifications, PWA, recovery, abuse defenses, cold storage, real provider integrations and Cloudflare deployment. User explicitly authorized headless Chrome, Wrangler local testing, Chrome DevTools MCP configuration, creation of `3sln/3sln.me` and direct work on main, plus a publishing workflow modeled on Storia. User requested a dedicated UI red-team agent and a final screenshot walkthrough.

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
| D024 | Manual publish workflow with tests, dependency audit, real Wrangler/browser tests and machine-recorded release gates. Main pushes run CI; do not publish. User will supply Cloudflare GitHub secrets when ready. | Reviewer: ___ Date: ___ Outcome: ___ |

### Implementation and environment evidence

- Real maintained SimpleWebAuthn verification, Argon2id policy, session/CSRF, mandatory recovery, email proof/link/login services are implemented with injected resources. Mail transport remains unconfigured.
- Contact signing/verification, live quotas/revocation, collection/message/read/move/tag/rules/quarantine, inert HTML/archive validation, notification preferences/leases/unsubscribe are implemented and tested.
- Worker adapter and `wrangler.jsonc` target 3sln.me with Durable Objects/R2 bindings; separate `wrangler.local.jsonc` explicitly enables test CAPTCHA behavior only locally. Production `RELEASE_READY=false` prevents public signup.
- `.mcp.json` configures pinned Chrome DevTools MCP with isolated headless Chrome and telemetry disabled. Installed browser tooling and real local Chrome work. Wrangler local execution is running on localhost:8787.
- GitHub repo created at https://github.com/3sln/3sln.me; Git initialized on main. Storia's manual publish/browser-gating workflow reviewed; corresponding gated workflow prepared.
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

Verification: all eight new Cloudflare binding tests passed; `npm test` passed **109 tests**. Production Wrangler dry run succeeded and listed `EMAIL` with all five permitted senders and `MAIL_ENABLED="false"`; its first invocation reported an unwritable external log path, so a second dry run redirected logs into `.output/wrangler-email.log` and completed cleanly. No deployment, remote mail, domain onboarding or DNS changes were performed. Mock and bundle results do not establish deliverability.

[Email deployment instructions](docs/deployment/email.md) link official Workers API, binding restrictions, header policy and onboarding documentation. Account owner must confirm Workers Paid/Email Sending beta availability and onboard `3sln.me`, reviewing bounce/SPF/DKIM/DMARC DNS changes, before authorizing live delivery verification and enabling the resource. Email Sending domain onboarding supports the intended transactional-user mail; verified-destination-only Email Routing capability cannot establish public signup readiness. End-to-end delivery, suppression/bounce operations, template localization and release sign-off remain provisional.

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

Production deployment is still blocked by actual release work recorded in `release-status.json`: complete federation/preferences integration and interoperability, provider OAuth keys/flows/conformance, rich HTML/archive asset rendering, hosted push/email dispatch and localization, requested lifecycle notices/grace/deletion, production bot controls, data/record garbage collection and cost/load verification, resolved independent audit findings, and terms/privacy review. Do not enable `RELEASE_READY` based only on the local UI tests. Created Cloudflare R2 buckets are `3sln-me-blobs` and `3sln-me-account-archives`; no Worker/domain deployment has been performed.

| D035 | First-party implementation and documentation use the repository MIT license to permit reuse/self-hosting. Upstream 3sln stack, bab and maintained cryptography sources retain their own MIT notices/provenance. Human confirmation of the release's licensing/publication policy remains unsigned. | Reviewer: ___ Date: ___ Outcome: ___ |

Final screenshot walkthrough: [standalone HTML](docs/walkthrough.html) and [Markdown](docs/walkthrough.md), with reviewed local test screenshots under `docs/walkthrough-assets/`. Recovery images contain readable public metadata and masked/empty inputs, never live answer material or credentials. Current landing, resource, notification and security screens make unavailable capabilities visible. English/Spanish recovery UI entries were added through bab catalogs; user prompts/hints stay unchanged. Narrow-phone/reorder/Spanish-restore verification passed with zero browser runtime errors. The production-config bundle dry run still succeeds with mail and release flags disabled.

Final combined browser rerun after recovery spacing/cancellation/localization changes: **6/6 passed** in a clean temporary Wrangler runtime, including question reorder/mobile/Spanish metadata preservation. The walkthrough's eleven account/recovery screenshots were refreshed from this exact run. The runner no longer streams full Worker request logs to the console and redacts signed query capabilities in the saved diagnostic log.

Final CI browser group includes the repaired signed-endpoint composer fixture and eleven UI fault cases. **17/17 passed** in a fresh isolated runtime after dialog focus/keybinding hardening and the separate notification-email capability flag. Enabling identity verification mail cannot advertise reminder delivery while its dispatcher is unwired. Walkthrough screenshots were refreshed from this final run. Human sign-offs and all production release gates remain unchanged.

## 2026-10-11 — Source publication and remote verification

Committed the reviewed source snapshot to `3sln/3sln.me` main as `75b699e9da25f2eebbfa6d39224d23176009ffec` and pushed under the user's repository/main authorization. [GitHub checks run](https://github.com/3sln/3sln.me/actions/runs/38197748448) completed successfully: dependency audit, unit tests, actual Worker integration, DOM/state checks, production-config dry run and the full isolated Linux/Chromium browser group. This publishes source and documentation only. No hosted Worker deployment, domain activation, live email or DNS onboarding occurred. A follow-up documentation commit records this evidence without changing verified application code.


## 2026-10-11 — Dedicated system-email sender subdomain

User changed the hosted sender domain to `sys.3sln.com`, reserving bare-domain addresses for potential user mail. This supersedes the earlier `@3sln.me` sender examples without rewriting their historical evidence. Hosted Wrangler now explicitly sets `MAIL_SENDER_DOMAIN="sys.3sln.com"` and permits only `verify`, `login`, `notify`, `accounts` and `security` at that domain. Self-hosted defaults remain operator-controlled; account/verification/unsubscribe links remain on the identity app origin. Setup docs now name the sending subdomain and parent DNS zone. No DNS changes, onboarding, mail or deployment were performed.

| D036 | Use `sys.3sln.com` for hosted system senders, keeping bare domains available for user email. Direction explicitly requested by user; configuration verification remains separate from deliverability. | Reviewer: ___ Date: ___ Outcome: ___ |

Verification: all nine focused email adapter/configuration tests passed, including host-origin links with a separate sender domain. Production Wrangler dry run passed with the five `@sys.3sln.com` senders and `MAIL_ENABLED="false"`.


## 2026-10-11 — Reported sender onboarding and live email test

User reported `sys.3sln.com` onboarded and explicitly authorized a test message to their supplied recipient. Created an isolated ignored local Worker with a remote Cloudflare `EMAIL` binding, restricted to the exact test sender/destination and protected against unauthenticated or duplicate invocation. One test attempt from `notify@sys.3sln.com` returned `email sending not authorized for subdomain 'sys.3sln.com'`; no acceptance/message ID was returned. No successful delivery is claimed, and the app was not deployed. Public DNS queries for `cf-bounce.sys.3sln.com` and `_dmarc.sys.3sln.com` returned ENOTFOUND at test time; these alone do not prove dashboard configuration state. Cloudflare documentation confirms Email Sending onboards subdomains separately from routing/apex domains. Updated setup status; mail and release gates remain disabled pending actual authorization and delivery verification. Recipient address and temporary authorization secret are not recorded in public project files.
