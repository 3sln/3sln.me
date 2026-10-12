# Independent security, custody and abuse review

Review date: 2026-10-11. Scope: current `docs/spec/*`, `docs/artefacts/*`, identity/messaging/storage/runtime packages, Worker wiring/configuration, and the browser paths needed to check secret handling. This is an independent second review; no implementation changes were made. Human reviewer: ___ / date: ___ / outcome: ___. Findings and design alternatives remain provisional until reconciled in DEVLOG.md.

Repository publication is not domain deployment. The contract files are drafts in the repository, `RELEASE_READY` is false, and this review did not deploy anything or test a public service. “Release blocker” below means a condition before enabling the affected feature. No working email, push, OAuth connector, federation or physical-authenticator verification is inferred from library code.

## Prioritized findings

### S-01 — High: interrupted recovery can permanently strand an account

Evidence: `packages/identity/service.mjs`, `pending`, `newPending`, `recover`, `loginPassword`, `finishPasskeyLogin`, `emailLoginConfirm`; `docs/spec/account-lifecycle.md` recovery paragraph. Recovery atomically clears the only recovery hash, every authenticator and session, then supplies a 30-minute setup token. All ordinary login and recovery paths require an active account. There is no transition from an expired recovering setup back to usable proof.

Walkthrough: a legitimate owner submits the saved recovery file; the server commits recovery but the response is lost, or the owner takes more than 30 minutes to complete setup. The saved file is consumed, prior credentials are gone, and the setup token fails. Even a linked mailbox cannot log into the recovering account. No attacker is necessary; possession of a stolen file can also induce this denial of access.

Reproduced using the actual IdentityService, real test fixture/KDF and injected clock: after advancing 1,800,001 ms, setup, old recovery-file reuse and old-password login all returned `unauthorized`, with the stored account still `recovering`.

Required change: specify a recoverable transaction, distinct from granting an owner session. One option retains a domain-separated resume hash for the original recovery proof while the same recovery transaction is unfinished, permits rate-limited reissue of a limited setup token, invalidates the superseded setup token, and atomically removes resume authority when replacement authenticator plus new-file confirmation activate the account. Disclose that the original proof remains recovery authority during this transaction; do not call it completely consumed at the first request. Resolve concurrent resume/activation and stolen-copy tradeoffs explicitly. Never fall back to operator bypass.

Tests: lost first response; expiry before and after replacement credential enrollment; parallel resumes; resume racing activation; old file after activation; successful no-email recovery. Block account recovery release until a supported continuation exists.

### S-02 — High: failed proof consumes global signup capacity

Evidence: `IdentityService.guard` consumes rate limits before Turnstile; `abuseWindows` puts a 200/day global signup budget after IP/subnet attempt windows. Terms and input validation happen still later.

Walkthrough: distribute invalid-token requests across permitted IP/subnet windows. No successful CAPTCHA or account is required to exhaust the daily global capacity. A legitimate fresh client then receives `rate_limited`. Shared /24 or /48 users can similarly lose signup capacity because other users or attackers share that network. Handle login limits also allow targeted temporary lockout and should be described as a deliberate tradeoff, not enumeration/abuse immunity.

Reproduced with actual `guard` and `enforceAbusePolicy`: 200 requests with invalid CAPTCHA from simulated distinct networks all failed `challenge_failed`, but consumed `signup:global=200`; the next fresh client's valid proof failed `rate_limited`.

Required change: distinguish cheap pre-proof attempt windows from verified account-creation capacity. Charge global creation capacity only after valid proof and validated terms/method/inputs, and define whether failed uniqueness/persistence attempts refund reservations. Keep a separate bounded global request/verification-cost budget with intentional overload behavior. Do not advertise free-account availability as resistant to distributed attacks merely because creation is rate limited.

Tests: invalid proof never spends successful-signup capacity; terms/malformed input do not spend it; concurrent final creation cannot exceed it; shared-network behavior and recovery from window expiry. Block public signup until corrected.

### S-03 — High availability: production Turnstile actions do not match browser requests

Evidence: `apps/web/src/release.mjs` `mountCaptcha` calls `turnstile.render` without an `action`, while `IdentityService.guard` supplies the operation and `packages/runtime/http.mjs` requires `result.action === input.action`. Local mode bypasses that comparison. Independently corroborated by the interoperability reviewer; source-level evidence only.

Result: real signup/login/recovery proof is expected to be rejected despite succeeding in local tests. The browser also retains a successful token in state; form retries and operation changes need fresh operation-bound proof rather than reusing it.

Required change: render an explicit operation action, reset proof after submission and on operation change, and test actual nonlocal verification responses. Do not weaken the server check to hide the mismatch. Block authentication release until browser/configuration behavior is verified.

### S-04 — High, mail feature gated: verified contact email silently becomes an authentication factor

Evidence: `docs/spec/auth.md` explicitly permits contact-only verified email and forbids email recovery when disabled. `emailLoginStart`/`emailLoginConfirm` check verified ownership and active status but no authentication opt-in flag. `emailConfirm` stores only verifiedEmail/time. `account-lifecycle.md` describes optional login links without defining a distinct choice. Worker currently injects no mailer and advertises email disabled.

Walkthrough after enabling mail: an owner links an address for contact/reminders while relying on passkeys. The mailbox is later recycled or compromised. A new mailbox controller requests a link and obtains a full owner session, because “verified contact” and “login factor” are the same state.

Required wording/state: “Verifying a contact address does not enable authentication. Email login requires a separate recent-owner-authenticated opt-in.” Store an explicit factor policy/revision and check it at both issuance and redemption. Disabling the factor or replacing the address must invalidate outstanding login links. Present account switching context before replacing an existing session. Reconcile the old email-materialization table with hosted signup policy rather than leaving two apparent normative outcomes.

Tests: verified contact-only account cannot request/redeem login; opt-out invalidates pending token; address change and parallel redemption; logged-in A explicitly switching to B. Keep mail disabled until these semantics are implemented.

### S-05 — Medium/high, notification feature gated: retries change payload and batch leases expire

Evidence: `packages/messaging/dispatcher.mjs` fixes idempotency to job ID + ordinal but issues a new unsubscribe token on every attempt. `apps/worker/transports.mjs` embeds that token in reminder text/header. Providers requiring an identical request body for a repeated idempotency key cannot deduplicate these retries correctly. A crash after acceptance is precisely when this matters. This is a request-consistency defect even without claiming a particular provider response.

Separately, dispatch claims ten jobs together with the default 60-second lease and sends them sequentially; individual transports permit ten seconds. Later jobs can expire before sending. `finish` throws on a stale lease inside `finally`, terminating the batch and potentially replacing the original failure. An eligibility check occurs before recipient lookup and unsubscribe creation, widening the interval between opt-out and send.

Required change: persist one immutable payload/unsubscribe capability for each reminder ordinal, reuse it across retries, and model accepted/unknown/completed transitions. Claim near execution or renew leases safely; isolate stale completion per job; obtain current target/suppression information before the last eligibility check. Specify that a send already in flight can still arrive after opt-out. Global/account outbound budgets and aggregate/digest reminders are necessary before enabling one message × up to ten reminders × many subscriptions: message-byte quotas alone do not limit delivery cost.

Tests: accepted mail followed by timeout, identical retry body/key, token issuance failure, ten slow transports, stale worker versus new lease, unsubscribe/read/address change immediately before send, bounce suppression. Mail/push remain unwired, so this is a pre-enable blocker, not current delivery exposure.

### S-06 — Medium: several attacker-influenced records have no bounded cleanup path

Evidence: `IdentityRepository.createDevice` removes a prior request only on a colliding human code; no device-expiry sweep is present. Expired pending signups retain unique handles indefinitely. Contact grants/receipts, notification jobs/unsubscribe tokens and blob-garbage records likewise have no integrated sweep; `issueUnsubscribe` is reachable repeatedly from an owner route without an issuance limit. `AccountController` stores blob bytes inside a metadata transaction, but no reconciliation removes successful blob puts after a later metadata rollback. Blob-garbage deletion failures are recorded without a drain worker.

Walkthrough: cheap device requests accumulate expired rows; abandoned signups permanently reserve desired handles; an account repeatedly creates unsubscribe links or cycles authorized message delivery/deletion. Zero-byte messages still create metadata. Stored-byte quotas do not account for these records, scans or outbound costs. A blob write followed by metadata failure leaves an unreferenced blob; repeated failures retain uncharged storage.

Required change: specify retention by record class, legal replay lifetime and quota unit (rows/bytes/operations). Persist staging ownership and sweep or reconcile orphan objects; drain deletion garbage. Preserve message receipts through the advertised retry period, then expire them safely. Define an explicit pending-signup expiry/reclaim policy independently of destructive established-account retention. Add per-account/grant limits, not IP limits alone, and rate-limit anonymous unsubscribe attempts without preventing legitimate opt-out.

Tests: clock-driven actual-store cleanup; rollback after blob upload; delete failure then retry; bounded scans/rows under repeated zero-byte delivery; pending handle expiry; device expiry. This blocks claims of production abuse/cost control, while core live grant quota checks themselves are sound.

### S-07 — Medium: collection routing authority needs an explicit recipient-policy exception

Evidence: `MessagingService.receive` checks the sender's claimed collection, then applies owner rules that can move a message into any active owner collection. `messaging.md` says rules cannot expand sender grant scope; `contact-tokens.md` describes delivery to explicitly selected collections. No reading or cross-account access is granted by this behavior.

Walkthrough: an invitation permits collection A only; an owner rule routes all A deliveries to B. The bearer can now cause content to appear in B, even if B was absent from the invitation. This is ordinary recipient-side filtering if that is the intended model, but becomes a transitive capability problem if future automations/apps execute or trust messages merely because they land in B.

Required wording: define the grant collection as the authorized ingress collection, preserve it separately from final owner routing, and state that owner routing supplies no sender identity or automation authority. Alternatively restrict final destinations to grant collections if the promise is final placement. Future collection automation must require independent execution grants and cannot inherit trust from placement/classification. Test A→B routing, disabled B, and any future consumer's trust decisions.

### S-08 — Medium: provider safety claims require narrower evidence and scope semantics

Evidence: endpoint validation/redirect blocking exist, while connection-time DNS/private-address enforcement does not. Custom hostname approval therefore delegates trust to operator configuration and DNS. Drive checks parent/version before and after bytes, and documentation correctly admits it cannot provide an atomic folder boundary. OneDrive retrieves preauthenticated URLs after a metadata check with no post-download membership/version recheck. Dropbox describes direct-child access but `get` accepts nested logical keys. `readResult` validates only the start prefix of Content-Range and a maximum body size, not the complete range/end/total versus returned length.

Walkthroughs: an approved custom host's DNS later points into a private network; a moved/replaced upstream file is served under stale metadata; a caller uses nested Dropbox keys beyond the advertised direct-child surface; a faulty provider returns an inconsistent partial range that an app treats as coherent sync data. These are custom-host/disabled-provider/conformance gates; they do not prove a public credential leak today.

Required change: enforce vetted public egress at connection time before credentials are sent; freeze allowed provider scopes; explicitly distinguish recursive root containment from direct-child-only authority; reject inconsistent partial responses; document acceptable race residuals. Keep Drive/Dropbox/OneDrive disabled until live conformance and OAuth refresh/revocation exist. S3 read presign correctly declares expiry-only revocation and rejects writes; future presign grants must independently limit method/namespace/lifetime and explain that revocation cannot recall the URL. The adapter itself is not a gateway authorization boundary.

Tests: DNS rebinding/private IPv6/redirect targets; moved files during download; nested keys; malicious Content-Range/short responses; revoked app versus outstanding URL; credentials absent from every returned descriptor/error.

### S-09 — Medium: archive copies and operational custody need an explicit lifecycle

Evidence: `AccountController.warm` restores an archive and clears the shelved marker, but leaves `accounts/<owner>.json` in R2. Deleting a restored resource removes only its current metadata. A previously archived encrypted provider secret can therefore remain in the old snapshot. Archives have an unkeyed digest, which detects accidental corruption, not a malicious archive writer replacing both content and digest. `runtime/secrets.mjs` has a fixed AAD string and one configured key with no key identifier/rotation procedure.

Required wording: distinguish removal of live authorization/credentials from delayed backup erasure, publish retention and encryption-key destruction behavior, and never claim immediate deletion of all copies. Define authenticated archive provenance if storage-write compromise is within the integrity threat model. Bind encrypted records to owner/resource/purpose where substitution resistance is required; define key-version rotation and restore compatibility. This follows the existing administrator-trust model and does not justify E2EE claims.

Tests: archive→restore→disconnect verifies both live denial and documented snapshot retention; key rotation plus backup restore; tampered owner/rows/digest; encrypted record substitution under the chosen threat model.

## Boundaries that held in this review

- Contact tokens use fragment URLs, memory capture/history cleanup, exact registered claims, live key/grant checks and signature validation; the Worker checks recipient status and verifies the token before warming a cold account. EdDSA/ES256 are explicit; passkeys are not reused as contact signing keys. Signed claims are visible to recipients and are not encryption. Public contact pages skip Turnstile script loading. Operational log redaction still needs deployment evidence.
- Message HTML is reconstructed from inert tags with no sender attributes, escaped text and an empty-sandbox iframe/CSP; archives reject traversal/nesting and never extract to disk. No script execution bypass was demonstrated. The application still downloads attachments from the account origin, whereas the spec requires an isolated download origin for production; complete that boundary and real-browser hostile-content tests before claiming it. Unknown/WebRTC/automation MIME types remain inert downloads. Do not turn future MIME recognition into connection/permission/execution consent.
- Device QR flow separates public request/code from private polling secret, binds polling to a requester cookie, requires explicit recent-owner approval, CAS-consumes the handoff and rechecks the approving session. Remote social engineering remains inherent: an attacker can display a real request and induce full-account approval. The spec admits this accurately; human usability evidence and a working approval UI remain necessary. The handoff fails closed on cross-store conflict rather than replaying a session.
- Permanent account deletion remains disabled. The two-day prompt/seven-day grace/one-year inactivity policy is not implemented by the old 180/730/90-day helper. A no-email recovery file cannot receive advance notices. Do not enable execution based on a dashboard prompt being merely available, or describe seven-day R2 cache eviction as account removal.
- Self-hosting means administrative custody. RP-scoped passkeys, stable issuer identity, encrypted server-held credentials and R2/DO persistence do not constitute portable account migration or user-only encryption. The current Worker entrypoint needs concrete platform adapters; core dependency injection alone is not a tested second deployment platform. Generic adapters must not trust a caller-supplied `CF-Connecting-IP` outside the trusted Cloudflare edge.

## Evidence and release disposition

Read-only source/spec audit plus two executable, nonpersistent probes reproduced S-01 and S-02 using actual service/policy code. No full test suite or live mail/provider/browser/physical-authenticator test was run for this review; prior test claims were not silently promoted to new independent evidence. Changes to core/runtime made in response require `npm test`; browser changes additionally require DOM and actual relevant browser checks.

Block public account activation/recovery on S-01–S-03. Keep mail delivery disabled pending S-04–S-05, retain connector and federation gates, and resolve S-06–S-09 before claiming production cost, retention and provider-scope guarantees. Reconcile these findings with the separate interoperability audit and DEVLOG.md; record any accepted residual risk with actual reviewer/date/outcome. No human sign-off is supplied here.
