# Shared-secret conversations v1 — protocol draft

Status: provisional protocol, 2026-10-12; local implementation status is recorded separately below. This is an open implementation draft, not an interoperability or production-readiness claim. Human protocol/security sign-off: reviewer ___ / date ___ / outcome ___. Decisions and final implementation reconciliation belong in [DEVLOG](../../DEVLOG.md). See [architecture and rationale](../architecture/conversations.md), [contact capabilities](contact-tokens.md), [message content](messaging.md) and [security](security.md).

## Identity, capability and scope

A conversation is an independently identified resource with a canonical HTTPS URI, one ordering authority, an ordered message history and explicit membership. Example: `https://alice.example/api/conversations/account-a/CONVERSATION_ID`. The opaque identifier MUST NOT encode the shared secret. The provisional contract identifier is `https://3sln.me/artefacts/conversation-v1.json`, under the user-authorized publication authority. Publishing this artifact does not enable runtime discovery or assert production conformance. Other illustrative identities use reserved `.example` domains. Conversation IDs are not contact IDs, user aliases or credentials.

The initial sender MUST generate a fresh, uniformly random secret of at least 256 bits for the conversation. Use canonical unpadded base64url for interchange. An authenticated creator client MAY delegate generation to its trusted provider using a cryptographically secure generator. The initial private invitation carries the secret along with the signed conversation descriptor. All admitted participants use the same current epoch secret for subsequent contributions. Initial individual contact capabilities are needed to approach new recipients, not to reply within an already admitted conversation.

Possession of the current secret grants only the operations permitted by the conversation's bearer policy. It does not establish a member identity, allow access to unrelated inboxes, authorize new contact, or bypass recipient storage and delivery policy. Shared-secret authorization is not end-to-end encryption. Providers handling contributions can read unencrypted content. Strong per-member permissions require separate authenticated identity, as specified below.

HTTP submissions MUST transmit the secret in `Authorization: Bearer SECRET`, never in a path, query, userinfo, cookie or referer-bearing link. A protected initial admission envelope is the only document profile allowed to contain the delivered secret; it MUST be excluded from ordinary content search and notification summaries. Secrets MUST be encrypted at rest when retained for recipient distribution, omitted from public descriptors and ordinary message/list results, and redacted from logs, errors, telemetry and backups lacking appropriate protection. Return capability-bearing responses with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Raw capability disclosure is an explicit authenticated operation.

## Authority and membership

The creator chooses the authority at creation. The authority serializes membership/policy revisions and contribution acceptance. The creator MUST prove administrative authority independently of the shared conversation secret: a verified account session or an independently verified creator signature suffices. The shared secret alone never authorizes impersonating the creator.

An authority-signed membership snapshot binds at least:

- Contract version, canonical conversation URI and authority identity/key identifier.
- Monotonically increasing revision, epoch and previous snapshot digest (absent only for the first snapshot).
- Creator identity, active participant identities, their public proof keys when applicable, and effective permissions.
- Bearer contribution policy, admission policy, membership-management policy and enforced bounds.

Snapshots MUST exclude recipient contact tokens, inbox grants, private collection selections and the shared secret. The outer transport can supply an authorized secret separately. Implementations MUST verify signatures with an already trusted authority key; an attacker-provided key in an envelope is not a trust anchor. An initial authority/key binding is established through the authenticated invitation/admission exchange and thereafter pinned. Key change, provider migration and authority transfer require a separate continuity profile; a changed advertised key does not silently replace the trusted key.

Policy updates MUST carry the expected current revision. A conflict requires refetch and reconsideration, not an automatic overwrite. Every accepted contribution binds the current revision and epoch, and its recipients are the complete active membership at acceptance. Replies reference that conversation's message IDs only. Sender fields cannot supply a narrower recipient list. A member's provider MUST NOT infer membership merely from a participant URI found in arbitrary message bytes.

Policy can reserve invitations/removals to the creator or delegate them to independently authenticated members. A creator cannot grant a participant rights beyond the conversation policy or override a recipient's refusal to participate. The creator is not removable by an ordinary member unless an explicit reviewed transfer/termination policy permits it; this draft does not define such a transfer.

## Bearer and identity authorization

The bearer profile permits every current-secret holder to contribute under the same contribution limits. Holders need no personal contact token for an existing participant. Such messages MUST be attributed as unverified unless a separate valid proof establishes the author. The application may display an untrusted display name but MUST NOT style that claim as authenticated identity.

The identity profile additionally proves the actor through a current authenticated account session at the authority or a signature under the actor's independently bound member key. A signature MUST bind the conversation URI, operation, epoch, expected revision, message or mutation content digest, unique request/idempotency identifier and bounded validity interval. Algorithms, canonical encoding and proof wire fields MUST match an implemented versioned profile; arbitrary JSON serialization is not interoperable signature input. Unknown algorithms, substituted/retired keys, mismatched URI/audience and replay outside the validity window MUST fail closed.

The authority evaluates independently authenticated identity against the latest policy. Different per-member `send`, `invite`, `remove` or policy-management permissions MUST NOT be enforced using claims protected only by the shared secret: any holder can forge those claims. A claimed actor name, email, URI or MAC under the shared secret is insufficient. When policy requires identity, a bearer-only contribution is denied; it is not implicitly treated as the creator. Changing from bearer to identity-restricted contribution must be explicit to participants.

## Initial delivery and admission

Creating or extending a conversation proceeds as follows:

1. The sender obtains valid contact authority for each new recipient. The creator's own authenticated inbox can be admitted directly. Contact authority's exact MIME/operation scope MUST allow a conversation invitation; a generic text-message capability does not authorize group subscription. The proposed invitation MIME is `application/vnd.3sln.conversation-invite+json` (project-private and unregistered).
2. The sender/authority sends a bounded invitation through that contact authority. The envelope binds conversation URI, authority, pinned snapshot, intended recipient, expiry, replay identifier and current secret. The sender MUST NOT expose another recipient's contact capability. The initial human document may accompany the invitation, but MUST NOT be rendered as executable control data.
3. The recipient validates the invitation and explicitly accepts with an owner-chosen collection and limits, or relies on a previously configured narrow owner admission policy. A GET, link preview, message render or secret possession is never consent. Pending and declined invitations do not add active members or expose history.
4. The authority verifies recipient acceptance, establishes a private delivery admission independent of the original contact grant, and commits a new signed membership revision. The new member becomes active only after that commit. Existing members receive the membership update. A client missing a revision must resynchronize before treating later snapshots as current.

A recipient can accept a conversation from Alice and then receive Tom's group replies without giving Tom its contact token. Revoking Alice's original contact invitation stops further introductions through that invitation; it MUST NOT silently revoke this separately admitted conversation. The recipient can independently leave or block the conversation, disable its selected collection, or revoke its conversation-specific delivery admission. These controls stop future local deliveries according to their published semantics.

Inviting a new member requires fresh contact authority and that member's admission. A creator policy allowing member invitations does not itself contact-enable every possible person. Forwarding the shared secret alone does not enlarge the delivery membership or expose private history, although in the bearer profile the new holder can contribute to the existing membership.

An invitation containing the current secret necessarily gives its recipient bearer contribution authority before that recipient accepts inbox membership. Admission controls being included in future deliveries, not knowledge of a secret already disclosed. Senders must understand this consequence; implementations must not promise that declining admission revokes the disclosed secret. Revoking that bearer authority requires an epoch rotation.

## Removal, rotation and consistency

An authorized removal commits a new membership revision and epoch, generates a fresh independent secret, and distributes it only to retained members over their established independent authenticated delivery channels. The old secret MUST NOT authorize obtaining the replacement. Rotation must precede accepting messages under the new policy; requests using the old epoch or secret are rejected, including otherwise identical idempotent retries after revocation.

The authority MUST serialize the membership cutover with contribution acceptance. A contribution accepted before the cutover retains its original recipient snapshot and sequence. Later contributions use the new membership. Removal cannot retract earlier accepted messages, erase received content or prevent a retained member from intentionally disclosing the new secret. Delivery-state responses must make pending, rejected or cancelled copies visible rather than rewriting historical membership.

Restricting a previously bearer-authorized member requires secret rotation and/or changing to identity-based authorization. A role change alone cannot revoke knowledge of an unchanged shared secret. A participant who rejects or cannot receive the new epoch cannot continue using old credentials; the UI must show the need to resynchronize instead of silently reusing old authority.

All parties derive current membership from authority-signed revisions, not local editable recipient lists. Recipient providers may be offline and learn updates later. The protocol therefore promises one canonical committed history and detectable stale requests, not instantaneous synchronization or Byzantine consensus. Conflicting valid snapshots at the same revision are a security conflict; clients MUST stop applying that branch and surface it. Authority unavailability does not authorize a local unsigned fork.

## Contribution, idempotency and mandatory fanout

A contribution contains one immutable document, exact MIME type, bounded sender metadata, a unique idempotency key, current epoch/revision and optional in-conversation reply reference. Identity proof accompanies it when policy requires or the sender requests verified attribution. Payload bytes MUST be copied or fixed before asynchronous validation and hashing. The fingerprint covers conversation, epoch, revision, author proof identity (or explicit unverified status), MIME, immutable content digest, reply reference and sender metadata. Unknown fields and unsupported types are rejected rather than treated as extensions.

Acceptance MUST atomically commit the message sequence, stable message ID, immutable payload reference/digest, idempotency receipt and a durable delivery obligation for **every active participant in the accepted snapshot**, including an author who has a participant inbox. Missing recipients make acceptance invalid. Neither a caller-selected `to` set nor a successful first delivery is sufficient. A repeated identical request returns the same accepted identity; reuse with different content fails with an idempotency conflict. Current authorization and epoch are checked before disclosing cached outcomes.

Fanout is asynchronous and independently idempotent per `(conversation, message, recipient)`. Recipient acceptance MUST atomically commit its owner copy, byte/message accounting, deduplication receipt and appropriate notification/search outboxes. A recipient never relies on an asserted display name or unsigned member list as delivery authority. Local quotas, quarantines and collection ownership continue to apply. Coordinator acceptance cannot guarantee availability or willingness of every recipient.

Expose at least these distinct outcomes:

| State | Meaning |
| --- | --- |
| `queued` | All recipient obligations are durable; none has yet been acknowledged. |
| `partial` | Some recipients acknowledged, and others remain pending or failed. |
| `delivered` | Every original snapshot recipient durably acknowledged an inbox copy. This is not a read receipt. |
| `failed` | No recipient acknowledged and no automatic attempt remains. |

Per-recipient records distinguish pending/retry, acknowledged, permanent rejection, cancelled and retry-exhausted states. The exact enum and safe recipient identifiers belong to the implemented adapter schema. Never report `delivered` after removing failed recipients from the denominator. Accepted work uses bounded attempts, exponential backoff, maximum age and durable dead-letter handling. Retry uses the same identifiers after timeouts or process restart. Indeterminate acknowledgment means retry/reconcile, not a new contribution. Queue saturation rejects new acceptance before charging or promising fanout.

No sender can compel a recipient to store content when its quota is exhausted or admission revoked. “Deliver to all” means complete durable fanout, honest per-recipient outcomes and no silent omission; the UI MUST show partial/failure states when universal delivery is impossible.

## Document and metadata profiles

Human messages reuse the [existing MIME transport](messaging.md): strict UTF-8 `text/plain`, inert reconstructed `text/html`, and bounded `application/vnd.3sln.web-archive+json`. An initial implementation MAY support a narrower exact set and must advertise only that set. Other types remain attachments unless an independently specified handler is authorized. MIME labels do not grant execution rights.

Sender subject, display name and annotations remain untrusted plain text separate from owner tags, classification and collection controls. A conversation title is not identity. The inbox can group by conversation URI and sequence and show original sender, proof status, membership revision and delivery state. Thread grouping MUST NOT combine unrelated messages merely because their subjects or display names match.

Search can index owner-authorized document text, safe titles, participant identifiers and thread references. It MUST NOT index invitation/control envelope bodies, shared secrets, private grants, proof-bearing capability fields or transport credentials. Notification payloads likewise omit secrets and reusable invitations. Rendering continues to use the isolated inert viewer; HTML and archives never fetch arbitrary remote assets or execute scripts. Replies with attachments follow the same payload and storage bounds.

## Discovery, transport and self-hosting

Discovery uses the provider's public HTTPS `/.well-known/bindle/manifest.json`. A future enabled manifest extension may advertise the exact conversation contract, contribution endpoint, schema URL, supported proof profile, MIME types and bounded capabilities. It MUST NOT advertise a contract merely because its schema exists or a feature flag is set. An unavailable/unconfigured federation service continues returning its established 503 response; conversation work MUST NOT turn that into false successful discovery.

The authority contribution endpoint and participant delivery endpoints require an implemented, tested wire profile. Existing OAuth resource RPC semantics MAY expose an equivalent conversation contract only when the adapter can satisfy its complete authorization and journal guarantees. Owner session routes are not automatically public federated RPC endpoints. Unsupported discovery properties or methods must fail explicitly; clients must not infer interoperability from route names.

Participant and authority URIs MUST be canonical HTTPS URLs on approved origins, with no userinfo, fragment or credential-bearing query. Discovery/key/participant network fetches omit ambient cookies and secrets, reject redirects and private/loopback/link-local/reserved addresses, validate DNS resolutions against the connection target, and enforce response, decompression and time limits. Revalidate at connection time to prevent DNS rebinding. A signature does not authorize arbitrary network access: delivery targets must come from a verified, admitted, pinned provider endpoint. Development loopback is an explicit local-only exception and cannot be advertised by the production manifest.

Independent implementations can use different databases, languages and hosting providers while preserving these same authorization, membership, admission, epoch, idempotency and fanout semantics. At least two independent provider implementations plus failure/replay/security tests are required before claiming cross-provider conformance. No implementation may silently fall back to one-off contact delivery and call it a shared-secret conversation.

## Implementation and publication status

This draft defines target behavior and security invariants. The implementation ledger must explicitly identify the subset wired into local Node/Worker adapters, exact wire fields and limits, test evidence, unsupported network/proof paths and remaining release gates. Until those are reconciled, the prose above MUST NOT be treated as an assertion that all described operations are available. Publishing static documentation/schema is distinct from enabling runtime discovery or production service.

The [provisional local submission schema](../artefacts/conversation-v1.json) describes `payload` and optional `signature`. The payload identifies `version:1`, conversation `id`, `{origin,owner}` source, `epoch`, `eventId`, `actor`, operation and operation-specific input. Broad-policy contributions use `actor:"bearer"` without a signature. Identity-authenticated operations use the exact member URI plus a P-256 ECDSA/SHA-256 signature over UTF-8 bytes of the project's canonical JSON (object keys sorted recursively, JSON array order preserved). Signature bytes are the 64-byte `r || s` representation, encoded with unpadded base64url. This envelope is not a JWS or a standard canonical-JSON profile. Interoperability requires byte-exact vectors before external advertisement.

The initial local implementation is a text-only profile: bounded human text, thread/reply IDs and sender tags, with separate signed invitation/membership envelopes. It does not implement arbitrary HTML/archive conversation contributions merely because one-off messaging supports those document types. The broader MIME transport above remains a target requirement. The local service uses a creator/source coordinator and retained per-recipient delivery records. Public network transport, snapshot digest chaining, request validity/revision proof fields, detailed per-member policy mutations and publication schema coverage must each be reconciled with the final source and tests; none is implied by this draft. Subsequent operations not described by the submission schema require a schema update before external conformance claims.
