# Contact delivery — proposed wire profile

This is a complete **design candidate**, not a description of an enabled endpoint or published contract. The existing signed-contact and inbox-bearer behavior remains as documented in [contact endpoints](contact-tokens.md). The candidate contract identifier is `https://3sln.me/artefacts/contracts/contact-delivery/v1`; it MUST NOT be advertised as available until its actual JSON definition, matching adapters, and conformance evidence are published. Conversation v2 remains a separate unpublished proposal.

This profile specifies bytes, authority, and delivery semantics, not a particular SDK or renderer. Both transports below submit the **same semantic operation** to one recipient's live contact resource. They share authorization, replay accounting, and results.

## Two delivery kinds

| Kind | Required `noReply` | Meaning |
| --- | --- | --- |
| `one-off` | `true` | Deliver one document. No conversation admission, reply capability, shared secret, subscription, or future-delivery authority is created. |
| `conversation-init` | `false` | Deliver one initial document and a protected, creator-signed conversation proposal. The recipient can review it; receiving it does not accept a participant or authorize subsequent contributions. |

The discriminator and constant `noReply` value MUST agree. A one-off envelope MUST NOT contain conversation bootstrap fields. The distinction is not inferred from a subject, MIME type, HTML “Reply” button, participant name, or quoted secret. `noReply` does not suppress transport acknowledgments, revoke a recipient's already received copy, or prevent a person from independently obtaining contact authority later.

A recipient MAY display either kind in the same incoming stream. Views and tags organize that stream; neither creates delivery or reading authority. Existing collection claims remain immutable legacy authorization partitions and MUST NOT be replaced with View identifiers.

## One semantic envelope

The exact envelope is `{payload, proof?}`. Payload fields are:

| Field | Definition |
| --- | --- |
| `version` | Integer1. |
| `kind`, `noReply` | The exact pair above. |
| `operationId` | Lowercase UUID; stable across retries and both transports. |
| `createdAt` | Immutable nonnegative safe-integer Unix milliseconds. |
| `recipient` | `{issuer,owner,contactId,resource}`: exact issuer origin, stable recipient UUID, parent contact UUID, and the resource issued for that parent. |
| `content` | `{mimeType,byteLength,sha256}`: canonical lowercase media type without parameters, decoded byte length, and unpadded base64url SHA-256 of the exact document bytes. |
| `subject` | Plain text, at most200 Unicode code points, with no controls. Empty is permitted. |
| `optionalTags` | A sorted, unique selection from the parent's allowed optional tags; at most32 strings of at most64 Unicode code points, with no controls or whitespace-only tags. |
| `author` | Verified identity descriptor as defined below, or explicit `null` only for an allowed unverified one-off. |
| `conversation` | Required only for `conversation-init`; protected bootstrap fields below. |

All fields other than `conversation` are required. Unknown fields, duplicate JSON property names at any depth, nonfinite or unsafe numbers, and invalid Unicode strings MUST be rejected before canonicalization. No Unicode normalization is applied. Arrays whose order is meaningful retain their order. `optionalTags` MUST be in ascending Unicode scalar-value order; no receiver may silently sort or normalize a signed request. The author and receiver must agree on the same byte-level profile.

The decoded body is at most1MiB, the encoded envelope at most65,536 bytes, and either complete transport request at most1,500,000 bytes. Live parent, account, kind, MIME, and transport limits may be smaller. These are limits of this candidate profile, not increased limits for existing APIs. Plain text and HTML require strict UTF-8; other authorized MIME types remain opaque unless an explicitly supported content profile applies. See [message content](message-content.md).

No payload field contains a contact bearer, signed contact URL, owner session, or unrelated resource token. Recipient fields MUST exactly match the **verified live capability**; they cannot select another account, parent, or resource. The resource is an opaque provider-issued address bound to one contact parent, not the owner's general message resource. Its identifier grants no read, list, profile, preference, storage, or account access.

## Authorship and signatures

An identity descriptor is `{principal:{issuer,subject,identityURI},identityDocument,keyId}`. A stable identity is the accepted authority/key-bound principal, not any foreign issuer repeating the same UUID. `identityURI` and public key references MUST be resolved through authenticated discovery and pinned continuity, not accepted because a message supplies them. A key embedded in content cannot authenticate itself.

For a public handle, discover the provider's manifest, use its advertised same-origin HTTPS `directory_url`, and query exactly one `handle` parameter containing the full URI-encoded handle. The result binds the stable identity and minimal public identity document. It does not disclose private associated email, profile attributes, contact grants, or conversation membership. This directory/identity profile is proposed work; the current conversation-only identity route is not an equivalent general directory implementation.

Identity-authored deliveries MUST contain an ES256 proof `{alg:"ES256",kid,signature}`. `kid` MUST equal the author's `keyId`. The signature is canonical unpadded base64url of64 bytes, over:

`UTF8("bindle-contact-delivery-v1\n") || UTF8(JCS({alg,kid,payload}))`

`JCS` means [RFC8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785). The signature binds recipient, parent resource, delivery kind, no-reply semantics, body digest/type/length, selected tags, time/operation ID, and the complete protected bootstrap. The bearer capability separately admits delivery; it cannot forge author identity. New incoming deliveries require a currently authorized signing key. Retained historical verification keys do not automatically regain new-delivery rights after revocation or migration.

Every accepted candidate-profile delivery MUST also receive a provider-signed admission receipt. That is evidence that this recipient provider admitted these bytes under this contact scope; it is **not** proof that the provider authored the document or that its content is true. Provider keys MUST be authenticated by the issuer's published key binding and the admission-signing purpose, never by a key embedded in the receipt alone.

Anonymous legacy contact remains a valid existing feature. Under this candidate, a new one-off with `author:null` and no author proof is permitted only when the parent explicitly allows unverified one-offs. Its admission receipt MUST say `authorship:"unverified"`; the UI MUST NOT present it as identity-signed. Thus all accepted candidate records have signed admission integrity, while only identity-authored records have an author signature. A product requiring **every sender** to sign must disable this explicit mode rather than relabel anonymity as verified authorship. `conversation-init` always requires a verified creator signature; it has no anonymous branch.

## Signed contact URL POST

A new-profile signed endpoint accepts exactly two `multipart/form-data` parts:

1. `envelope`, a UTF-8 JSON part with Content-Type `application/json`, containing the exact envelope above.
2. `message`, a binary part containing the exact document bytes. Its media type MUST agree with `payload.content.mimeType`; filenames are inert transport metadata and MUST NOT alter interpretation or storage paths.

There are no separate `collection`, `mimeType`, `subject`, `title`, `tags`, or `idempotencyKey` form fields in this profile. Duplicate parts, extra parts, nested multipart, duplicate disposition parameters, malformed framing, inconsistent MIME, mismatched length/digest, and ambiguous JSON MUST be rejected. A part's filename and multipart boundary are not signature input. MIME transfer encodings are not supported; body limits apply while reading, before unbounded buffering or decompression.

An optional `Idempotency-Key` header MUST equal `payload.operationId` exactly. Header/envelope disagreement is an error, never a precedence rule. The signed URL is the sole delivery credential on this path. A simultaneous Authorization bearer or owner-session credential MUST NOT be used to expand or choose authority; this profile rejects ambiguous dual credential sources. Senders omit cookies and refuse redirects. GET, HEAD, OPTIONS, previews, and capability discovery never deliver.

The existing endpoint's HTML composer remains an interaction surface, not a different semantic authority. A new-profile UI sends only after deliberate review/account selection. Signing in, completing signup, or returning from another provider MUST NOT automatically POST a saved draft.

## Contact bearer RPC

A client obtains a **new, distinct** contact-delivery bearer using the signed URL and:

`Accept: application/vnd.bindle.contact-token+jwt;profile="contact-delivery-v1"`

The profile parameter and protected token class are candidates, not currently served. This reuses one token media type rather than adding another. Without the profile parameter, the existing representation continues to mean an inbox token for `/api/messages`. A new-profile response MUST echo the profile parameter and contain the expected protected `typ`, audience, and scope. A client MUST reject a legacy response from a server that ignores the parameter; it MUST NOT reinterpret that token as RPC authority or silently downgrade.

The new compact JWS protected header has `typ:"bindle-contact-delivery+jwt"`, an approved asymmetric `alg`, and local `kid`. Its claims are exactly `{iss,sub,aud,jti,iat,exp,parent,endpoint,resource,contract,methods,kinds,authorship,mimeTypes,maxMessageBytes,requiredTags,optionalTags}`. `aud` is the issuer's advertised RPC endpoint; `resource` is the exact parent-bound contact resource; `contract` is the candidate contact-delivery identifier; `methods` is exactly `["deliver"]`. `kinds` is a nonempty unique subset of `["one-off","conversation-init"]`; `authorship` is a nonempty unique subset of `["identity","unverified"]`, both restricted by the live parent. The unverified value applies only to one-off, even when the same parent permits signed conversation-init. Other scope fields inherit the parent's current immutable values. Expiry is at most300 seconds and never exceeds parent expiry. Child IDs need no persistent row; all descendants share parent quotas and receipts.

The signed URL protected claims and its immutable parent record MUST explicitly bind the profile/version, resource, kinds and authorship permissions before this representation can be minted. A legacy text grant cannot silently gain conversation admission by asking for another Accept value. A receiver MUST reject expanded, missing, unknown, retired-key, mismatched, or otherwise unauthorized claims even if their signature is valid.

RPC uses the ordinary envelope shape, with a dedicated contact-capability verifier and dispatcher:

```json
{
  "version": "0",
  "tx": "11111111-1111-4111-8111-111111111111",
  "resource": "https://recipient.example/entities/22222222-2222-4222-8222-222222222222/contacts/33333333-3333-4333-8333-333333333333",
  "contract": "https://3sln.me/artefacts/contracts/contact-delivery/v1",
  "method": "deliver",
  "args": {
    "envelope": {
      "payload": {
        "version": 1,
        "kind": "one-off",
        "noReply": true,
        "operationId": "11111111-1111-4111-8111-111111111111",
        "createdAt": 1791979200000,
        "recipient": {
          "issuer": "https://recipient.example",
          "owner": "22222222-2222-4222-8222-222222222222",
          "contactId": "33333333-3333-4333-8333-333333333333",
          "resource": "https://recipient.example/entities/22222222-2222-4222-8222-222222222222/contacts/33333333-3333-4333-8333-333333333333"
        },
        "content": {
          "mimeType": "text/plain",
          "byteLength": 5,
          "sha256": "GF-NsyJx_iX1Yab8k4suJkMG7DBO2lGAB9F2SCY4GWk"
        },
        "subject": "Hello",
        "optionalTags": [],
        "author": null
      }
    },
    "bodyBase64url": "SGVsbG8"
  }
}
```

This complete structural example delivers the five UTF-8 bytes `Hello` under a parent explicitly permitting unverified one-offs. Its fixed timestamp is a test vector, not a currently admissible request. The actual `args` schema is exactly `{envelope,bodyBase64url}`. Body encoding is canonical unpadded base64url, with decoded size/digest checked against the envelope; invalid padding, impossible lengths, noncanonical unused bits, or another representation MUST be rejected. `tx` equals `operationId`; RPC resource equals the verified token resource and signed recipient resource. The Authorization header contains the single contact-delivery bearer. No owner session, OAuth login, or shared preference resource is required or implied by that bearer.

Recognizing a contact token at an RPC endpoint MUST NOT feed it into the ordinary account/app grant path. Only this one resource/contract/method is callable. In particular, it grants no resource descriptor traversal, `@profile`, `@preferences`, arbitrary recipient selection, or caller-provided forwarding endpoint. Contact-authorized CORS may be credentialless and public; it is not a substitute for capability verification. An implementation may share the RPC envelope and machinery while keeping these credential classes strictly disjoint.

## Conversation bootstrap

`conversation` contains exactly `{genesis,sharedSecret,returnControl}`. The secret is fresh random256-bit material encoded as canonical43-character base64url. It is a conversation gate, not an author signing key, archive-encryption key, or proof that anyone accepted an invitation.

`genesis` is `{payload,proof}`. Its signed payload contains `version:2`, the explicitly proposed conversation-v2 contract identifier, `conversationId`, `createdAt`, creator identity and creator-owned resource, two to32 proposed participant descriptors, a random `secretEpoch`, `secretDigest`, and the initial content descriptor/subject. Each proposed participant binds an identity/public-key reference and that participant's proposed owner-local conversation resource. The creator and approached recipient MUST both appear exactly once, with descriptors agreeing with the outer author and verified recipient binding; each authority-bound principal is unique even if two entries differ in key or resource. The outer author MUST be the creator, and the initial content and subject MUST match the delivered document. The genesis uses the same proof encoding, with domain prefix `bindle-conversation-genesis-v2\n`. Its `secretDigest` is SHA-256 of the decoded shared secret; the outer recipient-specific proof binds the actual protected secret as well.

The list is a **proposal**, not a universal membership roster. A participant entry does not prove that its owner created a resource, approved another identity, or agreed to receive future content. Each party owns its own independently stored copy and local accepted-peer policy. Ordinary future delivery requires an independently signed author event, the locally accepted shared-secret context, the receiver's approval of that author, its live ingress admission, and the event's exact audience/visibility rights. There is no central sequencer or mandatory permanent creator administrator in the proposed v2 model.

Initial contact authority pays for only this bounded first document and pending invitation. The receiver MUST NOT silently subscribe, import another owner's whitelist, fetch history, notify all proposed participants, or issue general reply authority. A receiver's signed acceptance is separate and may be declined or deferred. A sender's ordinary outgoing audience contains only peers it has accepted and for whom the necessary reciprocal admission evidence exists. Per-owner disagreement is permitted; no global membership or instantaneous partition-wide revocation is promised.

The protected `returnControl` binds the sender's return resource, the approached recipient principal, the semantic genesis digest, a nonce, expiry, method `respondInvitation`, at most8192 response bytes, and a purpose-limited capability. It authorizes only a signed Accept/Decline response to this invitation. It MUST NOT admit document bodies, read history/profile, enumerate participants, or create a general inbox. The sender resource verifies the intended recipient's identity proof using the keyId in that recipient's signed genesis participant descriptor, resolved under pinned authority and current key authorization, and verifies the exact proposal/nonce before deduplication. A different key requires separately authenticated continuity and a renewed allowance, not a supplied replacement key. returnControl.expiresAt is also this bootstrap proposal's acceptance deadline: it is no later than seven days after the outer createdAt. Expiry does not erase the received document or revive another permission. This resolves mutual-admission bootstrapping without allowing arbitrary unknown senders into the conversation.

Shared secrets and return capabilities MUST be excluded from rendered content, previews, search, notifications, ordinary list projections, unprotected exports, and logs. Retained bootstrap material is encrypted and quota-accounted per owner. Only explicitly authorized owner operations may reveal it. Each recipient receives a separately addressed envelope; no recipient receives another recipient's contact URL or delivery bearer. Accepting a peer grants no old history by default; later sharing requires separate bounded authorization, including for edited or deleted content already held by other owners.

These fields define the proposed **bootstrap boundary**, not the complete conversation-v2 RPC surface. The published conversation-v1 artifact is an older local submission schema with an ordering authority and optional bearer-only authorship. It MUST NOT be treated as this decentralized, independently signed protocol merely because both use a shared secret.

## Replay, accounting, and receipts

Both transports use one replay namespace: `(recipient owner, live parent contact ID, operationId)`. A new child bearer, a different multipart boundary, RPC instead of URL POST, or a renewed token MUST NOT create another delivery allowance or receipt namespace.

Define `semanticEnvelope` as the envelope with every defined proof's `signature` member removed, retaining its `alg`/`kid` and all payload claims. `payloadDigest = SHA256(UTF8(JCS(semanticEnvelope)))`. This includes kind, author identity, recipient, parent, body descriptor, subject/tags, protected secret, genesis and return-control bindings. Randomized ECDSA signature bytes are not idempotency identity. Each supplied proof must still independently verify. The semantic genesis digest similarly retains genesis payload and proof metadata but omits only signature bytes. Transport authentication strings and framing are excluded.

New operations are accepted only within24 hours of `createdAt`, allowing at most60 seconds future skew. Retain accepted receipts and indeterminate attempt fences for at least48 hours after first admission; never garbage-collect a fence while the corresponding unchanged request remains admissible. Deleting a document or declining an invitation MUST retain the replay fence through this horizon. Changing `createdAt` or signed content under an existing operation ID conflicts. Once an operation is too old, a fresh token does not make it a new operation. A sender MUST NOT generate a new ID or timestamp merely to retry an unknown effect.

Authorization, parent/key revocation, allowed kind/MIME/authorship/tags, decoded content validity, and disclosure policy are rechecked before admission or private receipt replay. Required tags are applied by the receiver from the parent; the sender chooses only `optionalTags`. The result initializes delivery tags and owner organization through the existing owner rules. Rules do not widen the capability or change the signed sender document. New grants cannot reset owner-wide receipt ceilings; child minting cannot reset parent ceilings.

The existing ordinary RPC journal keyed by app/client identity is not this receipt authority. Implementations MUST NOT fabricate an app client to reuse it: the parent/operation receipt remains authoritative across both transports.

Acceptance durably commits the document, protected pending-init state when present, receipt fingerprint, accounting, and required index/notification obligations as one owner-local admission. Pending conversation creation may use a durable admission intent and reconciliation, but may not lose or duplicate that state after acknowledging the first body. This is not a transaction spanning different providers. External blob storage uses a recoverable staged commit; a blob upload alone is not acceptance. Resource exhaustion or unknown persistence outcomes MUST NOT return a false successful receipt. The reference runtime's existing conservative admitted-attempt counters remain additional nonrefundable safeguards; this proposed transaction must not imply they already count only successful receipts.

Signed URL success is HTTP202 with `{receipt:{payload,proof}}`. RPC success uses its existing HTTP200 envelope `{version:"0",tx,result}`, with that same receipt object as `result`; method errors follow the existing RPC error framing, while authentication/framing/transport errors use HTTP errors. The following HTTP code mapping applies directly to signed POST and to pre-dispatch RPC failures, not to a second success status inside RPC. Receipt payload is exactly `{version:1,purpose:"bindle-contact-admission-v1",issuer,recipient,operationId,messageId,kind,noReply,payloadDigest,bodyDigest,authorship,receivedAt,state:"accepted"}`. The provider signs the same proof structure with domain `bindle-contact-admission-v1\n`. Its identity and verification keys come from authenticated issuer discovery. A receipt proves local admission only—not human reading, reciprocal consent, conversation-wide delivery, or notification-provider delivery. It contains no secret, private rule, quota counter, profile, or history.

Malformed framing/schema is400; absent/invalid/expired authority is401; authenticated scope refusal is403; conflicting operation content is409; size refusal is413; unsupported media/profile is415; bounded admission refusal is429; temporary provider inability is503. Safe capability errors MUST avoid account/resource enumeration. A `Retry-After` is supplied only when a bounded delay is known; it does not revive expired authority. CORS/error responses remain private/no-store with no credentials. Redirects MUST NOT be followed on capability retrieval or delivery. A disconnected client or timeout has an unknown outcome and preserves the exact operation for authorized reconciliation rather than inventing a replacement.

## Current implementation versus this candidate

| Surface | Implemented today | Proposed change |
| --- | --- | --- |
| Signed URL multipart | `message` part plus legacy `collection`, `mimeType`, `idempotencyKey`, optional `subject`/`title`/`tags`; body at most1MiB, request1,500,000 bytes | Exact envelope+message parts with kind, author proof and protected init. Earlier prose calling the part `blob` does not match the actual adapter. |
| Inbox bearer | `application/vnd.bindle.contact-token+jwt`, audience `/api/messages`; JSON uses `text` or standard-base64 `dataBase64` and metadata | Distinct new token/profile and contact-only RPC dispatcher. No automatic token upgrade. |
| Scope | Live parent key, collection/MIME/quota, required/optional delivery tags; parent-scoped receipts | Add explicit kind/authorship/resource profile and cross-transport semantic receipt identity. |
| Signatures | Contact capabilities are signed; ordinary legacy document authorship is not required. Local app messages have provider-signed connection admission. | Identity proof for signed one-offs and every conversation init, plus provider admission receipts with explicit unverified branch. |
| Conversations | Published v1 submission schema and current authority-based runtime | Separately reviewed v2 bootstrap and independent owner consent; no claim of existing v2 conformance. |
| Directory | Conversation-specific public-key route exists | General advertised directory/minimal identity-document and continuity profile still required. |

Senders MUST explicitly negotiate an implemented profile. A failed new-profile request MUST NOT be silently downgraded into unsigned legacy delivery or a one-off message with discarded conversation state. Existing published JSON must remain immutable. The new definition is published only after review, under its own identifier, with a direct machine-readable registry entry and clear implementation status.
