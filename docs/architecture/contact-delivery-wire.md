# Contact delivery wire decision

Status: provisional design; no runtime or publication claim. Reviewer ___ / date ___ / outcome ___.

The proposed [wire specification](../spec/contact-delivery.md) gives signed contact URL POST and contact-authorized RPC one envelope, one live parent authority, and one receipt namespace. The complete [candidate JSON definition](artefacts/contact-delivery-v1.schema.json) deliberately lives outside the public artefact catalog. Root review, implementation, conformance tests, and explicit registry publication remain gates. Conversation v2 remains unpublished.

## Recommendation and boundaries

Use `kind:"one-off",noReply:true` for a document that carries no reply authority. Use `kind:"conversation-init",noReply:false` for the same document plus a protected signed proposal, shared conversation gate secret, and a narrowly bound acceptance return allowance. These are explicit grant permissions, not heuristics based on HTML, MIME, or subject. Neither creates universal membership; each owner approves peers and keeps its own copy. The return allowance reuses the directed invitation acceptance model rather than introducing a new general callback or application-state service.

Both paths authenticate the live contact parent. Identity-authored requests additionally sign the same canonical envelope. **Superseded, proposed (user decision 2026-10-14):** the earlier explicit unverified mode for anonymous one-offs is withdrawn. Every link delivery, one-off or conversation-init, carries a verified identity author proof, and the provider admission receipt is evidence of admission, not a substitute for it. The sole exception is app messages via the front-end SDK app-connection path ([app messages](../spec/app-messages.md)), which is not link delivery. Existing anonymous `?sig=` delivery stays implemented until the same change that ships authored delivery retires it; see [bindle links](bindle-links.md).

Reuse `application/vnd.bindle.contact-token+jwt` with the explicit `profile="contact-delivery-v1"` negotiation parameter. Keep a distinct protected JWS `typ` and RPC audience/resource/method class. A legacy representation returned by a server that ignores the parameter is rejected, never upgraded. Adding a second media type offered little benefit; reusing the legacy token's audience or pretending it is an OAuth app grant would incorrectly enlarge authority.

The candidate resource address belongs to one contact parent. The RPC dispatcher accepts only `deliver` for this contract and resource, deriving the owner from verified scope. It cannot traverse descriptors, read profiles or preferences, choose another owner, or invoke general account methods. Generic RPC framing is reused; its app/client journal is not reused by inventing a client identity. Shared parent/operation receipts govern both transports.

## Current source and differences

| Source | Existing behavior | Required candidate work |
| --- | --- | --- |
| `packages/runtime/http.mjs` | Signed multipart uses `message`, not the older prose's `blob`; permits legacy metadata fields and form/header precedence. Inbox JSON accepts text or standard-base64 `dataBase64`. | Strict two-part parser; duplicate JSON keys rejected before canonicalization; exact metadata/body consistency; canonical base64url RPC body; reject ambiguous credentials and mismatched idempotency IDs. |
| Contact endpoint/token services | Signed endpoints and inbox JWTs have different existing audiences; live parent/key/grant checks and parent receipts already exist. | Explicit new immutable parent profile/kind/authorship scope; narrowly minted RPC child token; no automatic expansion of legacy grants. |
| `packages/federation/service.mjs` | RPC currently authenticates an ordinary OAuth resource grant. | Separate contact credential dispatcher that preserves the resource/method intersection without fabricating an OAuth session or app connection. |
| Messaging and receipt budget | Existing count/byte receipt attempts, parent lifetime caps, retained storage quota and combined activity/physical-write safeguards apply. | Preserve all guards; new receipt semantics must not relabel conservative nonrefundable admitted attempts as successful deliveries. |
| Conversation invitation runtime | Validates then receives the invitation document and persists room invitation state in separate steps. | Durable admission intent/reconciliation so an acknowledged initial document cannot lose its pending proposal across a crash. No cross-provider atomic transaction is promised. |
| Published conversation v1 | Legacy submission schema, optional bearer authorship, existing ordering authority. | Independently reviewed v2 bootstrap and directed consent. Do not mutate the existing JSON or advertise v2 conformance. |
| Current identity key lookup | Conversation-specific public key endpoint; not a generic handle directory. | Minimal provider-advertised directory and pinned identity-key continuity before this candidate's identity profile is interoperable. |

Required tags are receiver-applied from the link's intake configuration, and the sender's optional tags are a bounded selection from its allowlist. **Superseded, proposed (user decision 2026-10-14):** both lists are mutable, revisioned, server-side per-link configuration editable by the owner without reissuing the link, not signed claims; legacy signed values seed it.  immutable original delivery tags feed owner rules. Views are organization, not delivery or read authority. Legacy collection ACL labels cannot be discarded during this transition.

## Integrity and retry decisions

JCS canonicalization and a domain-separated ES256 proof bind all payload semantics and the exact body digest. Hash semantic proof payloads and key IDs, excluding only randomized signature bytes from operation fingerprints. A re-signature of identical claims is not another operation; changing claims under the same operation ID conflicts.

A 24-hour admission horizon with 60 seconds of future skew is paired with at least 48 hours of receipt/indeterminate-fence retention. Minting child tokens, switching transports, deleting local content, or declining an invitation does not reset the operation. Revoked authority cannot replay private receipt details. Failed or unknown persistence must not manufacture success or trigger an automatic new-ID retry.

The protected genesis lists proposed participants, not their consent. Duplicate authority-bound principals are rejected even when their resource or key differs. Return authority verifies the approached participant's pinned genesis key and exact proposal/nonce; it carries no document/history/profile authority. Existing received copies and independently authorized history are not erased by a sender's noReply flag or expiry.

## Implementation sequence and gates

1. Review the exact candidate schema, complete examples, canonical digest/proof vectors, kind scope, and the identity-only authorship rule (no anonymous exception, per the 2026-10-14 user decision), including retirement of anonymous `?sig=` delivery in the same change. Keep the actual contract out of the public registry until implementation, conformance evidence and registry bytes agree. Human sign-off records remain provisional tracking, not a new permission prerequisite for authorized work.
2. Implement bounded strict parsers and shared semantic validation independent of HTTP/RPC framing. Test duplicate keys/parts, Unicode, canonical encodings, MIME disagreement, body digest, all bound identities, dual credentials and scope attenuation.
3. Add explicit new-profile parents and short-lived RPC child capabilities. Test legacy token rejection, no privilege expansion, current revocation before replay, and cross-transport parent receipt reuse.
4. Add durable local admission intents for body, receipt, protected invitation, quota and notification/index obligations. Inject crashes before/after blob commit and state reconciliation; verify no duplicate or partially acknowledged invitation.
5. Implement the separately reviewed identity/directory and conversation-v2 acceptance interfaces. No synthetic guest identity, automatic reciprocal membership, or new-member history grant.
6. Publish only the actual interoperable definition, exact JSON registry route and tested supported-profile discovery. Existing endpoints remain explicit legacy profiles; no silent downgrade when a new profile is unavailable.

Pending decisions: exact admission-signing key discovery profile and historical retention; operator-configurable kind limits below the wire ceiling; deployed identity continuity and future conversation-v2 acceptance conformance. These cannot be inferred from the candidate JSON alone. This change intentionally does not implement delivery, rename existing published artefacts, or add a new application-state subsystem.

## Implementation notes (slice L0, provisional)

`packages/messaging/contact-delivery.mjs`, `contact-delivery-wire.mjs` and `contact-delivery-service.mjs` implement the parsers, author verification and admission described in the spec, with [review](../release/contact-delivery-impl-review.md); nothing is routed yet. Reference-host compatibility detail: the live parent record carries `delivery:{resource,kinds,collection,conditional?}`. `collection` is an internal legacy authorization partition that places the record in the owner's single logical incoming store; it is never sender-visible or sender-selectable and is not part of the wire profile. Receipt rows are keyed `(owner, parent, author issuer, author subject, operationId)` and retain the applied intake revision. Receipt garbage collection, blob staging and receipt-budget wrapping remain L4 work. No conversation-init vector exists yet for the nested-signature rule (S3).

## Executable vectors

[Fixed vectors](artefacts/contact-delivery-v1.vectors.json) contain exact canonical bytes, body/semantic digests, a public test key and two independently generated valid ES256 signatures of the same claim. The test private key was discarded; this is not a published identity or live credential. `node --test tests/contact-delivery-spec.test.mjs` verifies both proofs, domain separation, claim-mutation failure, equal replay identity for re-signatures, complete public example bytes, and internal schema references. It does not claim a complete JSON Schema validator or a production JCS/strict parser; those remain implementation conformance gates.
