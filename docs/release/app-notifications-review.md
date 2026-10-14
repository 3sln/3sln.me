# App connection notifications — independent review

Date: 2026-10-14. Status: provisional design and independent implementation review. The implementation checkpoint below supersedes the earlier design-stage source observations. This reviewer added isolated tests; implementation changes belong to the backend/frontend owners. No build, production account, real email or external notification was performed by this review.

Human protocol/security reviewer: __________  Date: __________  Outcome: __________

Human product/privacy reviewer: __________  Date: __________  Outcome: __________

## Scope and recommendation

Use a narrow SDK operation authorized by the current recipient's app connection, without contact links or contact tokens. The final user-directed interface is `client.userMessage` over `app-messages/v1`'s `createOwn` RPC, replacing the earlier illustrative `notify` name. It submits normal subject/MIME/body/tags; action descriptors are rejected. Derive the recipient, app and connection from validated authorization context. Require separate, explicit permission for this operation; ordinary login, profile access, a registered client ID and OS notification permission do not confer it.

The intended guarantee is that the provider accepted a bounded notification for the connected owner under a particular app registration and connection generation. This does not prove that unmodified publisher code authored its content. A provider signature can authenticate that local acceptance record; it must not be presented as an app identity signature, independent publisher endorsement or verified business event.

This path supersedes the provider-held app-identity signing recommendation in the earlier [sender identity review](message-sender-identities-review.md) **for browser app self-notifications only**. Independently signed person/app messages and federated conversation delivery remain separate profiles. Do not silently translate provider receipts into those sender signatures.

## Existing source and required changes

The following source observations record the design-stage baseline. The later implementation checkpoint identifies changes actually audited.

The current [SDK](../../packages/sdk/src/identity.mjs) implements discovery, PKCE, state, exact callback checks, issuer/audience/client validation, short-lived bearer RPC, cancellation generations, and optional refresh rotation. Its RPC fetch uses `credentials: 'omit'` and `redirect: 'error'`. Its constructor accepts `clientId` and `redirectUri`; it does not currently establish that the executing document has the registered app origin. There is no proposed notification convenience method in the inspected source.

[Federation authorization](../../packages/federation/service.mjs) retains subject/client/grants/epoch and connection bindings; token validation checks active account and connection state. [App connections](../../packages/apps/connections.mjs) bind an owner and client ID, increment generation on disconnect/reconnect, and expose a current-state check. These are useful existing primitives, not an implemented notification permission.

The current [HTTP adapter](../../packages/federation/http.mjs) is deliberately more permissive than the proposed browser-only operation: absent `Origin` is allowed; provider-origin RPC skips token-client origin comparison; preflight allows registered origins generally. Consequently, merely routing the new method through existing RPC does not enforce its promised app-origin boundary. Add an operation-specific check, or a stricter explicitly versioned browser endpoint, without silently breaking generic non-browser RPC clients. Preserve validated transport context through Worker/Node forwarding; never accept an `origin` JSON argument as that context.

## What the browser boundary can establish

Browser Fetch controls `Origin`; ordinary page JavaScript cannot set it to an arbitrary different app origin. CORS controls access to responses and may preflight requests, but response denial alone is not a mutation authorization check. A server must reject disallowed actual requests before effects. Cross-origin JSON plus Authorization is an appropriate transport shape; do not add a form, query-token or simple-request fallback. [Fetch Standard](https://fetch.spec.whatwg.org/#forbidden-request-header).

An app iframe loaded from `https://app.example` has its own execution origin despite a different top-level embedder. SDK code imported into `https://embedder.example` executes in that page's environment; the script download URL does not confer the app's origin. Origins include scheme, host and port, not a path. Opaque sandbox documents cannot claim an ordinary app origin merely because their URL resembles it. [HTML origin model](https://html.spec.whatwg.org/multipage/browsers.html#origins).

Design requirements following from those facts:

- Compare the actual request's single, canonical serialized HTTPS Origin with the exact origin pinned to the token's current app registration/connection. Reject missing, `null`, malformed, multiple, suffix-lookalike and mismatched values for this browser-only operation. No provider-origin exemption, wildcard, eTLD-only check or fallback to Referer. Local HTTP exceptions must stay explicit development configuration.
- The SDK can fail early when its own document origin disagrees with registration. This is a developer guard, not server authority: patched SDKs and injected fetchers can bypass it. An opaque sandbox must fail closed even when `location.origin` appears to describe a normal URL; the server's actual Origin check remains decisive.
- Neither `window.top`, `parent`, `document.referrer`, iframe `src`, a caller-supplied app ID nor a message payload selects the author app. A genuine app iframe can call with its own authorization; embedding it does not grant the parent that authorization.
- Avoid a general parent-to-app notification relay. If an app intentionally supports embedding messages, validate `event.origin`, exact source window/channel, schema and current connection, with no wildcard secret replies. A permissive relay can make a real app origin a confused deputy. The HTML Standard specifically calls for origin and data validation in message handlers. [HTML cross-document messaging security](https://html.spec.whatwg.org/multipage/web-messaging.html#security-2).
- Apps sharing one origin are one browser trust boundary even if their URL paths/client IDs differ. Distinct tokens still have separate grants, but domain checks cannot isolate mutually hostile same-origin scripts. Use separate origins for independently trusted tenants. Origin/domain changes require an explicit registration/consent transition; stale tokens must not acquire a new origin silently.

`Sec-Fetch-Site`, Mode and Dest can reject unexpected navigation/no-cors shapes as defense in depth. They cannot replace app-token binding. A legitimate external app's fetch to an identity provider is commonly cross-site; a blanket cross-site denial would break the intended federation. Missing-header compatibility needs an explicit tested policy, while non-browser clients can forge these HTTP fields. [Fetch Metadata specification](https://www.w3.org/TR/fetch-metadata/).

Do not promise that an unrelated website cannot issue any request. Promise that its mismatched browser-origin request cannot produce an accepted notification. Preflight tests must be complemented by actual-request tests asserting no message, blob, receipt or OS-notification write.

## Bearer and publisher-authentication limits

Browser apps are public OAuth clients. A copied client ID is not a secret or publisher credential; a client secret shipped in JavaScript would not fix that. PKCE and exact registered callbacks protect the authorization flow, while same-origin malicious JavaScript can still exercise the app's privileges. This remains true when the app is an iframe. [RFC 10017, browser client authentication and threat model](https://www.rfc-editor.org/rfc/rfc10017.html#section-6.3.3.1).

A client ID alone must never authorize a send. A valid, scoped bearer is required. However, a stolen bearer used by a non-browser HTTP client with a matching forged Origin remains usable within its authority unless separately sender-constrained. Neither the provider nor this design can infer unmodified app code from that header. Optional DPoP can constrain token use to a possession key; DPoP itself is explicitly not client authentication and must not be described as proof of a publisher's global identity. It also does not neutralize malicious code able to invoke the authorized key. [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html#section-2).

These limits are acceptable only with the narrow owner-only scope and accurate provenance labels. An app notification saying Payment received remains app-supplied content, not provider-verified payment evidence. Strong service-origin statements would need a separately authenticated backend/workload profile; do not import that requirement into this frontend-only feature or pretend it already exists.

## Authorization, commit and revocation requirements

The proposed operation should accept only bounded notification content, supported presentation/action descriptors and an idempotency identifier. Reject recipient, owner, app name/origin/icon, connection generation, arbitrary signing identity, resource destination or contact-token fields. Resolve those from the live token, stored app metadata and the exact owner's connection.

Intersect the access token's original scope with the current connection generation and explicit notification permission. Checking only today's toggle could retroactively authorize an older token that was never consented for this method. Existing clients need fresh explicit approval; toggling a broader account preference cannot manufacture a missing grant. Tokens for storage, profile, another app, another account, another provider or an old reconnect generation fail.

At the account mutation boundary, recheck live connection/permission state before acceptance. Document the linearization point and treatment of a send already committed when a disconnect occurs; do not promise rollback of already displayed notifications. Where grant validation and message storage use separate durable actors, close or document the in-flight race explicitly instead of claiming an atomic cross-actor transaction. Queued notification jobs recheck the current delivery/OS-display preference and revocation policy before display. Owner removal/disable must not erase retained history unless separately requested.

No raw contact capability belongs in shared preference fragments, localStorage, notification data or caller-visible connection metadata. A scoped resource reference may expose only the owner's notification method. Do not allow a caller to select another connection resource by changing its ID. The operation grants neither inbox reads, conversation membership, profile disclosure, replies nor unrestricted message history access.

Keep durable deduplication keyed to owner, app, connection generation and stable operation ID with a canonical payload fingerprint. Equal authorized retry returns the retained outcome without duplicate message/notification/charge; differing payload conflicts. Authorization precedes dedup result disclosure, including after disconnect. Define dedup retention and unknown-outcome reconciliation; a new transaction ID must not be advertised as a safe retry after a lost response. Existing federation mutation journaling already distinguishes indeterminate outcomes, and the new adapter must preserve that behavior.

Apply aggregate owner and service receipt/work/storage limits, plus bounded per-connection count/byte rates, before message/blob/signature work. Reconnects, refreshes, origin variants and new IDs must not reset the owner ceiling. Bound records, outstanding retries, notification queue and retained provider signatures; notification rejection must not itself create attacker-amplified emails/push alerts. Reuse unified message storage, tags/rules and Views; no new destination inbox or independently billable contact authority.

## Presentation and signed local records

Stored registration metadata supplies the app's name and origin, visibly outside its content. A public registration is not a verified legal identity. Require a documented trusted registration/update process before promising that a known brand owns a domain; the inspected runtime currently uses configured client registrations. Preserve the metadata revision observed at acceptance so later renaming does not rewrite old provenance.

If a provider signs the local record, use a distinct versioned purpose and bind provider, recipient owner, client ID, connection generation, accepted operation, payload digest and acceptance time. Record Origin as a checked request property, not a cryptographic code-execution assertion. Verification and export must retain this provenance type and key history; do not relabel it as the app's signature, the owner's authored message or a portable federated sender proof. A signature does not make HTML, form actions or claims safe.

App content cannot choose OS identity chrome or remote icon URLs. Reuse bounded, validated, locally cached registration imagery with a neutral fallback; honor lockscreen privacy and independently disabled OS notifications. The prior [sender icon review](message-sender-identities-review.md) records why arbitrary notification resource URLs can carry ambient credentials. Rendering/actions remain subject to the [message action security review](message-actions-security-review.md), irrespective of app authorization.

## Required tests before implementation signoff

| Case | Required outcome |
| --- | --- |
| Approved app, exact origin, fresh explicit scope | One durable owner-local message; optional OS display respects owner settings. |
| Same SDK imported into another origin with copied client ID | No accepted mutation or trusted app label. |
| Real app iframe inside a foreign page | Uses the app frame's origin; parent cannot replace identity or receive its token. |
| Opaque sandbox, missing/null Origin, deceptive suffix/port, provider-origin mismatch | Rejected before persistence; no broad exemption. |
| Wrong app's otherwise registered Origin plus bearer | Actual POST denied even if OPTIONS succeeds. |
| HTML form/no-cors/navigation request | No alternate unauthenticated/simple ingress route. |
| curl with forged Origin and no token / copied client ID | Unauthorized; no app authority from headers. |
| curl with forged Origin and valid stolen bearer | Documented bearer limitation, never reported as publisher authentication; scoped to that owner/connection. |
| Wrong owner/resource/provider, old token before permission, reconnect generation | Rejected; no history or dedup result disclosure. |
| Toggle/disconnect races with append and notification dispatch | Tested commit cutoff; no stale permission revival. |
| Lost response/retry, same operation changed bytes, expired dedup | Honest replay/conflict/unknown semantics, no claimed exactly-once forever. |
| Quota exhaustion, oversized body/actions, token churn | Bounded rejection before expensive work, aggregate budget preserved. |
| Malicious HTML, app-name markup, remote icon and false payment claim | Isolated content; literal metadata; no remote OS icon fetch or elevated claim label. |
| Registration origin/metadata update or provider migration | Explicit reconsent/key/provenance continuity; no silent old-token expansion. |

Use actual Chromium and at least one other supported engine for origin/iframe/preflight behavior; source mocks cannot prove browser enforcement. Add actual Worker and Node tests asserting rejected requests cause no durable writes. Keep every fixture under reserved `.example` domains or loopback and intercept external requests. Implementation test evidence follows; no new browser test was run by this reviewer.

## Implementation checkpoint: ordinary app messages

Reviewed the backend's preliminary frozen implementation in [federation input policy](../../packages/federation/app-notifications.mjs), [account acceptance/signing](../../packages/runtime/app-notifications.mjs), federation service/HTTP/controller/runtime forwarding, app connections, receipt budgets and notification delivery hooks. The internal filenames still use notification terminology; the public contract and resource are `app-messages/v1` and the owner's `/app-messages` resource. The user rejected action descriptors. The accepted input is a stable transaction UUID matching RPC `tx`, `createdAt`, `subject`, `body`, optional `mimeType` (`text/plain` default or `text/html`), and optional tags. Forms belong to shared content rendering, not an app-specific actions field.

The strict Origin gate now survives HTTP, authority facade, controller and service. It checks both current registration and the token's pinned connection origin before resource synchronization and mutation; absent context fails even for raw controller RPC. The provider-origin shortcut does not apply. Registration relocation cannot transfer an old token to the new origin. Denial is enforced by the server, independently of whether the response has CORS headers.

Explicit method consent captures a separate notification generation. Disable/re-enable does not revive an earlier token, and refresh preserves the earlier ceiling. Unrelated approved scalar access remains usable. A pending consent screen captures that generation and cannot undo a later Messages decision. The target account checks live owner, identity epoch, connection, origin and notification generation; message/outbox acceptance is transactional with quota commit and local indexing. Notification eligibility, claim, final authorization and next-due scheduling respect live app suppression.

The operation timestamp resolves a design issue found during review: a random UUID alone cannot identify an expired retry after dedup records are deleted. Operations older than 24 hours, or more than 60 seconds in the future, fail before journal replay; account receipts last 48 hours. Callers must preserve `createdAt` and the same payload when retrying. The outer RPC journal can remain indeterminate after an ambiguous effect; retry never authorizes automatic resubmission with a fresh ID. Account receipt/message/outbox commit is atomic; failed or revoked uploads use the existing durable reservation cleanup. A crash after admission but before success reaches the client does not promise automatic outcome reconciliation.

Current limits are 120 Unicode code points for subject, 12,000 for body, at most 31 distinct caller tags (plus required `app-message`), and 16 KiB of encoded JSON arguments. The source accepts only plain text or HTML; arbitrary extra routing/action fields fail. The server adds the marker before applying normal rules to original delivery tags. Owner rules can later organize the message without altering its app provenance. The 10/minute and 100/day connection lane intersects owner receipt/work/storage limits; 256 retained account receipts can impose a stricter limit. Reconnect/token churn does not reset the stable connection budget. Attempt debits are conservative and nonrefundable after downstream failures. Existing storage/receipt byte counters charge body bytes, not all metadata/signature overhead; the encoded input, cardinality and operation limits bound that overhead. This is not a total infrastructure invoice cap.

Signing uses separately injected provider-global ES256 configuration, with cached WebCrypto imports, not an account recovery key or app browser secret. The public JWKS parser rejects private/unknown members, duplicate IDs, unsupported algorithms and excessive key counts; signer initialization validates public/private agreement. The canonical signed record binds issuer/owner/app/connection generations, operation timestamp/ID, subject, MIME, tags and the exact UTF-8 body digest. Signature tests verify the original record and reject changed owner data. No arbitrary signing endpoint is added. Historical verification still depends on retention of the appropriate provider public keys and trusted issuer binding; key publication, rotation procedures and export verification are not inferred merely from a valid signature in a local fixture.

The dedicated stored `appNotification` field supplies literal app name/origin in the inspected frontend. Ordinary contact `senderMetadata` cannot set that top-level field through its input path. This is provider-recorded connection provenance, not a publisher or business-event endorsement. The preliminary implementation uses the existing conservative HTML renderer; passing a stored HTML message is **not** evidence that interactive forms, lazy sanitizer fallback or safe submission/postback history have shipped. Those shared-renderer changes require their own source and real-browser review. No return to explicit app action descriptors is authorized by this checkpoint.

One concurrency limit remains explicit: granular federation grant revocation occurs in a different durable actor. An account admission already handed off after federation reauthorization may finish before that revocation can be observed. Local Messages disable/disconnect is checked at the account's serialized acceptance boundary, and current app settings suppress later notification dispatch. Do not claim an atomic global grant-revoke/append transaction or rollback of already delivered notifications.

Independent execution: `node --test tests/app-notifications-audit.test.mjs tests/app-notifications.test.mjs` passed **20/20**, including seven independently authored tests. The thirteen backend tests cover real SQLite close/reopen, full resource consent and scoped bearer dispatch, message/outbox dedup, signature verification, quota stops, in-flight disable after blob write, orphan cleanup, unknown write outcome, and normal HTML/tag rules. The independent tests cover HTTP/raw-RPC origin denial before effects, later-toggle scope ceiling, refresh/nonrevival, registration-origin change, stale consent, operation age/encoded bytes/forbidden fields and signer configuration/tampering. Two initially failing backend fixture expectations were corrected before this passing rerun; neither is counted as passing evidence before correction.

The backend author ran the full core suite: **744/744 passed**, with no failures/skips, in `/tmp/bindle-app-messages-core.log`; this reviewer inspected its completion summary. The reviewer subsequently ran `npm test`: **756/756 passed**, with no failures/skips, in `/tmp/bindle-app-messages-independent-core.log`. That run includes the developing presentation slice at that checkpoint; later presentation refinements have separate evidence in the [rendering review](message-actions-security-review.md).

The public contract and preference fragment now agree on `app-messages/v1`, `createOwn` and the `messages` resource field. Both canonical IDs and explicit JSON paths return the exact machine definitions regardless of HTML Accept, with public CORS and empty successful HEAD responses. The strict public JWKS endpoint publishes only configured verify-only keys; malformed/private-key configuration returns a generic failure without touching account authority. The owner Messages toggle is behind exact Origin and session CSRF, bounds its body and derives owner from the authenticated session. Two additional independent tests cover these public routes and the owner-mutation boundary; all **9 independent audit tests passed**. A documentation example incorrectly treated the preference response as the values object; the correction was sent to its author. Empty-body behavior for an unconfigured JWKS HEAD response was separately reported as a route correctness nit.

Actual Worker/browser integration and the shared interactive renderer remain separate final handoffs. This reviewer has not run a frontend build or sent an actual notification outside local fixtures.

## Final disposition

Cross-read the [app notification design](../architecture/app-notifications.md), including its supersession of frontend-only app signing in the prior sender/action proposals. No structural design blocker remains: the proposal separates browser-origin admission from publisher proof, requires an explicit owner-only method grant, removes contact capability distribution, records provider provenance accurately, and retains strict live admission/display checks. Fresh-token permission and finite/indeterminate replay semantics must remain explicit through implementation.

This is a provisional design disposition, not implementation approval or a claim of existing support. Exact contract/version, fresh-consent migration, trusted transport context, revocation cutoff, bounded persistence, registration/attestation-key policy and cross-engine tests remain implementation gates. Human decisions above remain blank.
