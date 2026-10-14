# Contact delivery: DX and interoperability review

Review date: 2026-10-14. Scope: independent source and protocol-design review; no runtime, SDK, browser, asset or production changes. Human protocol sign-off: reviewer ___ / date ___ / outcome ___. The proposed contact-delivery profile remains provisional. This review does not establish provider interoperability or deployed support.

The user's requested distinction is sound: one-off delivery does not establish reply authority; conversation initiation carries explicit participants and fresh shared-secret admission state. Both transports should decode to **one typed semantic envelope**, not separate multipart and RPC message models.

## Current implementation boundary

| Surface | Inspected behavior | Reconciliation needed |
| --- | --- | --- |
| Signed contact URL | HTML GET is a composer; machine GET uses `Accept: application/vnd.bindle.contact-token+jwt`; POST is intentional delivery. | Preserve scanner-safe GET/HEAD and the exact existing token media type. Negotiating a future delivery profile must be explicit. |
| Current multipart POST | [HTTP parser](../../packages/runtime/http.mjs) accepts a `message` part and separate `collection`, `mimeType`, `idempotencyKey`, `subject`, `tags`, and legacy `title`. Decoded message ceiling is 1 MiB; complete request ceiling is 1,500,000 bytes. | [Current contact draft](../spec/contact-tokens.md) says `blob`, which does not match that parser. A new profile must declare its exact parts and distinguish compatibility behavior. |
| Current contact bearer | `bindle-inbox+jwt` has audience `ISSUER/api/messages`; its live parent scopes MIME, legacy authorization partitions, quotas and delivery tags. | It is not an OAuth resource token and must not acquire generic RPC rights implicitly. |
| Current bearer JSON ingress | Accepts `text` or `dataBase64` using the existing standard-base64 path. | Do not relabel it canonical base64url or accept both encodings silently in the future RPC profile. |
| Current SDK RPC | [BindleClient](../../packages/sdk/src/identity.mjs) requires a login session, sends a version-0 RPC envelope, and binds response `tx`. Its `userMessage` method creates messages for its own consenting user through an OAuth resource grant. | Neither function is an implemented contact-delivery helper. A contact capability should not require unrelated OAuth consent. |
| Conversations | [v1](../spec/conversations.md) and its [artifact](../artefacts/conversation-v1.json) describe the existing authority/epoch profile. The [owner-copy architecture](../architecture/conversation-contact-design.md) proposes independent participant resources and signed events. | A new invitation is not proof that that architecture is already implemented. Do not reinterpret existing v1 rooms or silently expand one-off grants into subscriptions. |

No runtime tests were run for this design review. Existing tests establish their respective implemented profiles, not the new one.

## Recommended common envelope

The designer's proposed shape is a useful basis: `{envelope, bodyBase64url}` in RPC; `envelope` plus one binary `message` part in multipart. `envelope` contains `{payload, proof?}`; the typed payload binds `version`, `kind`, `operationId`, `createdAt`, the exact recipient, content MIME/decoded length/SHA-256, subject, selected optional tags, author provenance and any conversation-init state.

Names are proposed here, not final wire authority. Publish one exact schema with disjoint `one-off` and `conversation-init` branches, unknown-property rejection and paired positive/negative examples. If the user's `noReply` is an explicit field, constrain it in those branches rather than allowing it to contradict `kind`. Define whether the other branch requires `false` or forbids the field. A one-off has no conversation/return capability; a delivery ACK is still permitted. An HTML label or sender annotation cannot create reply authority.

A conversation-init branch must bind the precise conversation incarnation, participant identities/resources, initial signed state and secret or secret commitment, and any return/admission authority. It must not imply automatic acceptance or expose another participant's contact capability. A requested signed/two-owner profile that cannot be satisfied fails explicitly; it does not become an unsigned one-off under the same transaction.

## Transport mapping and bounds

| Requirement | Multipart contact POST | Contact-bearer RPC |
| --- | --- | --- |
| Semantic metadata | Exactly one UTF-8 `application/json` `envelope` part. | The same envelope as an object inside `args`. |
| Original content | Exactly one binary `message` part; no string/file guessing or filename-derived authority. | One strict canonical unpadded base64url `bodyBase64url` string. |
| Content identity | Hash the exact decoded bytes; require declared byte length and digest to match. | Decode first; verify the same length/digest. Reject padding, standard-base64 alternatives and noncanonical encodings. |
| Retry identity | `payload.operationId`; if `Idempotency-Key` is supplied it must agree exactly. | RPC `tx` must equal `payload.operationId`. |
| Authorization | Signed endpoint capability or the explicitly specified endpoint credential. | A distinct, narrow contact-delivery bearer, bound to one parent/recipient/resource/contract/method. |

Reject duplicate part names, unknown parts, unsupported charset/metadata MIME and contradictory header/envelope IDs. Define one authoritative logical MIME field: either require binary-part Content-Type to agree with `payload.content.mimeType`, or specify a uniform transport MIME and state that the envelope is authoritative. Do not leave precedence to FormData implementations. Filenames and multipart boundaries are transport details and are never signed message identity.

Publish decoded-body, envelope-UTF-8, total-request and RPC-encoded-request ceilings separately. Base64url grows the decoded body by approximately one third; RPC limits must accommodate that expansion and wrapper overhead. Existing 1 MiB decoded/1,500,000-byte transport behavior is an implementation fact, not a promise that arbitrary 10 MiB parent-granted content fits this profile. Bound participant arrays, tag strings/counts, proof material and invitation size before allocation. Express text limits in Unicode code points and wire limits in bytes. MIME normalization, empty-body handling and invalid text UTF-8 need exact rules.

Attachments or multiple blobs need an explicitly versioned content profile; neither extra multipart parts nor a JSON byte-array extension should be guessed. A file is a byte string, not a filesystem path to fetch.

## Retry, signatures and authority

Use a single live-parent plus operation-ID receipt namespace across HTTP and RPC. Identical cross-transport retries return the same bounded acceptance result without a second delivery/debit. A changed original body, metadata, recipient or invitation under that ID conflicts. Network uncertainty retains the ID, timestamp, envelope and bytes; it does not generate another operation or switch delivery mode. Specify freshness and deduplication/reconciliation horizons so a forgotten receipt cannot resurrect an old request. Every replay still checks live scope, expiry and revocation.

A proof signs a precisely canonicalized, domain-separated original payload. That includes body digest/length/MIME, immutable sender metadata, recipient/audience, operation identity and all invitation/participant/return-authority state. A detached secret must match a signed commitment. Contact URL signatures prove the recipient's permission, **not** the sender's identity. A shared secret is not independent author proof. Derived required tags, recipient-private classification, admission results and owner-local presentation edits remain outside sender-original claims.

Do not sign multipart boundaries/order, filenames, JSON property order, HTTP headers, cookies, CSRF, OAuth/contact bearer bytes, transient endpoint query credentials or current retry transport. The receiving capability is checked separately against the signed recipient binding. Excluding transport credentials does not permit retargeting the signed recipient or substituting the conversation secret.

The [current canonical helper](../../packages/messaging/store.mjs) sorts object keys using JavaScript JSON serialization. That alone is not a complete public interoperability specification. The final profile must identify its canonicalization, reject duplicate JSON keys and unsupported numeric/string forms, state Unicode normalization policy, and provide exact payload bytes, digest and signature vectors. Preserve original content bytes rather than decode/re-encode text during signing. Do not mutate an already signed subject/tag/participant value through trimming, case folding or local presentation normalization.

The future RPC dispatcher must reject unrelated resource/method/token-type combinations before account mutation or resource synchronization. Generic OAuth RPC admission and registered-app origin constraints must not silently become requirements for capability-based first contact. Credentialless CORS can expose only public capability results; owner cookies and CSRF are not part of this authority. Follow no redirects and keep tokens, signed contact URLs, invitation secrets and return credentials out of logs, URLs, search and notification previews.

## SDK and publication gates

An implementation may offer a contact helper that prepares the operation once, hashes bytes, constructs multipart or base64url RPC, preserves retry state, and checks issuer/recipient/response binding. The Bindle specification should require wire behavior and safety rules, not a JavaScript class name, sanitizer, rendering API or a mandatory SDK. The existing OAuth `userMessage` helper remains a different operation.

Before publication, resolve and cross-review:

1. Exact noReply/kind branch rules and invitation/return-authority fields.
2. Contract/resource URI, method, new bearer type/audience and explicit negotiation without expanding old inbox tokens.
3. Binary-part MIME rule, canonical encoding, duplicate JSON handling and executable cross-language signature vectors.
4. Declared per-profile limits, freshness, receipt retention, conflict/error/result schemas and cross-transport retry examples.
5. A compatibility table: current narrow legacy delivery, current conversation v1, and proposed contact delivery/owner-copy conversation profiles.

Only after those are fixed should runtime and SDK conformance tests claim the new profile. Publishing the contract alone does not establish independently implemented providers, enabled federation or production delivery.
