# Contact delivery: independent design review

Review date: 2026-10-14. This is a design review, not implementation or interoperability certification. The proposed contact-delivery contract and peer conversation profile are not enabled by this review. Runtime, SDK and published contract files were not changed. Human decision remains blank.

## Independent starting position

Use one typed delivery operation with equivalent semantics over a signed contact URL and a narrowly scoped contact-bearer RPC. Keep authorization to deliver, evidence of authorship, recipient retention and approval to converse distinct. A capability holder may have permission to send without proving a named author. A valid author signature does not grant delivery, create membership or make content safe to render.

An explicit `one-off`/`conversation-init` discriminator is preferable to guessing from MIME type, HTML, a reply address or the presence of a secret. A one-off may forbid this protocol's reply flow without controlling the recipient's independent copy or preventing unrelated communication. A conversation initiation proposes state; it cannot make the recipient or other named peers members automatically.

## Current implementation evidence and compatibility gaps

| Area | Current source | Consequence for the proposal |
| --- | --- | --- |
| Signed contact POST | [HTTP multipart parser](../../packages/runtime/http.mjs) accepts `message`, collection, MIME, idempotency key, subject/title and tags. It rejects repeated form fields and caps decoded content at one MiB. | Existing contact-token prose says a blob; the actual field is `message`. Specify an explicit new representation rather than silently interpreting legacy fields as the new envelope. |
| Minted contact bearer | [Contact endpoints](../../packages/messaging/contact-endpoints.mjs) use a distinct inbox JWT, audience `/api/messages`, short lifetime and exact live parent claims. | It is not an OAuth token or current RPC credential. A new RPC profile needs separate explicit typing, audience and validation. |
| Shared receipts | [Messaging service](../../packages/messaging/messages.mjs) keys receipts by parent grant plus idempotency key, fingerprints content and metadata, and rechecks live authority before returning replay. | Keep this sharing across URL and RPC. Minting another child token must not create another allowance or receipt namespace. |
| Receipt costs | [Account controller](../../packages/runtime/accounts.mjs) verifies scope/tags before supplemental receipt admission and blob storage. Established authorized replay returns through the service. | Existing supplemental limits count admitted new attempts and may remain consumed after downstream failure; do not claim all admission accounting is an atomic accepted-message count. |
| RPC | [Federation service](../../packages/federation/service.mjs) uses OAuth/resource grants and an entity/client transaction journal. | A contact delivery resource must not enter ordinary preferences, resource discovery, object storage, app messages or owner operations. Its contact-parent journal is a separate authority domain. |
| Tags and Views | [Tag policy](../../packages/messaging/tag-policy.mjs) distinguishes paired required/optional claims from legacy sender annotations. | Required tags are server-added; requested tags must be approved options. Views are mutable projections, never authority. Preserve hidden legacy authorization partitions until deliberately migrated. |
| Conversations | [Runtime](../../packages/conversations/runtime.mjs) has local/source coordination and bounded configured peer calls; [conversation-v1](../artefacts/conversation-v1.json) is an existing local submission schema. | Neither implements the proposed independent signed peer graph. A new initiation envelope cannot silently upgrade old shared-bearer conversation access or republish v1 with incompatible meaning. |

The [prior conversation architecture](../architecture/conversation-contact-design.md) remains the design context: independent owner copies, identity proofs separate from the shared secret, directed local approval, bounded return-control permission and no central online message sequencer. Its future public contract must be identified as such.

## Required authority and validation boundaries

1. **Select exactly one authority profile.** Reject conflicting URL and Authorization credentials. Verify the new contact JWT's type, algorithm, issuer, audience, resource, method and parent relationship; reject legacy inbox/OAuth/owner credentials in that validator. An unverified subject may only select a bounded routing target. It cannot authorize a resource lookup or mutation. Explicit typing and mutually exclusive validation address cross-token confusion. [JWT best current practices](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.12).
2. **Bind the actual recipient.** Envelope issuer, owner identity, contact parent and resource must equal verified authority. A handle is presentation/routing metadata, not a substitute for an authority/key-bound principal. The same UUID at another provider must not inherit admission, trust or a block exception. No callback, identity key URL or participant endpoint is automatically fetchable merely because a bearer holder supplied it.
3. **Intersect kind and content policy.** A grant allowing plain text does not implicitly permit conversation creation; a conversation-kind grant does not permit arbitrary body formats. Validate kind, MIME, decoded bytes, metadata, proposed roster size, proof size and total request bytes before storage or expensive remote discovery. Never accept a hidden conversation payload in an anonymous one-off to bypass admission limits.
4. **Make authorship honest.** Anonymous one-off admission is an explicit recipient option. A receiving provider's signature attests to its receipt record, not the sender's identity. Conversation initiation requires a creator identity signature over the exact proposed state and first content. Supplied display names, sender metadata, shared-secret possession, email authentication and recipient-signed contact tokens cannot replace that proof. Signed hostile content still uses the same isolated renderer.
5. **Constrain contact RPC before general dispatch.** Only the exact contact resource, versioned contract and delivery method are reachable. Reject aliases, batches, unrelated methods and owner session fallback. Reuse RPC framing without inheriting resource synchronization, preference access or OAuth app-grant authority. Capability-only requests omit browser credentials and reject redirects; CORS is response access policy, not sender identity proof.

## Canonical envelope and replay criteria

Both transports should decode to the same semantic request before validation and deduplication. Multipart boundaries, filenames, transport headers, JSON spacing and base64 representation cannot change operation identity. The normative profile must define strict UTF-8, duplicate-key rejection, allowed fields and number/string limits; a generic `JSON.parse` after the fact cannot detect duplicate members. If JCS is selected, use its exact rules and test vectors rather than describing a custom key-sorting helper as equivalent. JCS also requires rejection of duplicate property names and invalid Unicode data. [JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1).

Require exactly one envelope and one content part, with no duplicated names or conflicting MIME metadata. Treat filenames as non-authoritative and never as storage paths. Multipart permits repeated fields in general; this protocol must explicitly narrow that behavior. [Multipart form-data specification](https://www.rfc-editor.org/rfc/rfc7578.html#section-5.2).

Define digest and byte length over decoded original bytes, not rendered text, normalized line endings or the base64 spelling. RPC encoding should be canonical unpadded base64url with round-trip validation and a predecode bound. Optional tags need one specified order rule so semantic sets do not accidentally create conflicting retries. Required tags are obtained from the live grant, not accepted from sender metadata.

The durable key should include the recipient and stable parent contact plus operation ID. Bind the fingerprint to version, kind, creation time, recipient, MIME, content digest/length, subject, selected tags, author principal and every signed initialization/return-control claim. Exclude randomized signature bytes only when the independently verified signed claims are identical; excluding the whole proof object would allow changing author or proposed authority under one receipt.

Publish the new-operation age window, allowed future skew and receipt retention. Changing creation time or minting a token does not renew an existing operation. An expired or missing journal must not be interpreted as permission to retry an uncertain send under a fresh ID. Live revocation/quarantine/expiry checks precede receipt disclosure. Deleting message content must not remove a still-needed replay tombstone and permit redelivery.

Receipt success means durable local admission, which can include owner-local quarantine. The external receipt must not disclose private quarantine rules; the owner interface must distinguish held content from ordinary delivery. It is not evidence that the owner read the message, accepted a conversation, or that all peers received it. Retained bytes, receipt, quota commitment and notification work require one recoverable acceptance boundary; post-commit notification failure must not turn a retry into a second message. Cross-actor invitation setup needs a durable intent/reconciliation path, not a claim of a transaction spanning providers.

## Conversation-specific attack review

The shared secret is a possession gate, not an author key, history key or global membership decision. Store it separately from renderable content and notification/search metadata. Bind its digest/epoch and proposed state into the creator's signature; encrypt protected payloads if the chosen wire profile promises confidentiality beyond TLS. Do not claim end-to-end secrecy from hosted providers that hold the owner's private keys.

The creator can propose peers but cannot approve them on another owner's behalf. Do not fetch each proposed participant or fan out the first body before that receiver's independent authorization. Bound all pending state and allow rejection without forced body storage. A return-control allowance must name the exact proposal digest, intended recipient identity/key, return resource, nonce, expiry and one small consent-response purpose. It must not expose the sender's history or general inbox capability.

Acceptance must bind the selected account identity and a fresh local admission incarnation. Sign-in alone, or changing accounts during setup, must not approve the conversation. Reacceptance does not restore old grants or authorize historical backfill. Retained content remains the recipient's independent copy. Local removal blocks new local acquisition; it cannot instantly revoke remote copies or make an offline peer learn a membership change. Deterministic causal display is not a global chronological sequencer.

## Alternatives assessed

| Alternative | Assessment |
| --- | --- |
| Put new meanings into existing inbox JWT and multipart fields | Small implementation diff, but ambiguous author/kind authority and unsafe token substitution. Prefer an explicit new profile with a deliberate legacy adapter. |
| Use ordinary OAuth RPC for all contacts | Suitable for connected app resources, but introduces account/app consent semantics into possession-based first contact. A narrow contact bearer is clearer for this use case. |
| Treat every one-off as a conversation | Forces unused secret/membership machinery and obscures no-reply delivery. Keep explicit kinds sharing one acceptance pipeline. |
| Shared secret alone authenticates every peer | Simple but a leak impersonates every actor and authorizes unintended history. Require identity signatures and directed local consent independently. |
| Issuer-specific per-peer delivery tokens | Useful attenuation alternative; needs explicit issuance/rotation/bootstrap and cannot itself prove author identity. Do not dismiss offline-verifiable tokens as inherently needing an always-online issuer. |

## Implementation and interoperability gates

| Test family | Required evidence |
| --- | --- |
| Transport equivalence | Same operation URL then RPC and vice versa gives one local item, one logical receipt and one notification; fresh child token cannot reset any parent budget. |
| Parser differentials | Duplicate JSON members and multipart parts, invalid UTF-8, noncanonical base64url, wrong length/digest, MIME mismatch, extra fields and tag-order vectors rejected consistently before blob writes. |
| Authority confusion | Legacy inbox/OAuth/owner token, dual credentials, foreign parent/resource, unauthorized kind, broader methods and signed but unapproved participant all fail without privileged dispatch. |
| Replay and crashes | Changed author/genesis/body conflicts; authorization revoked before replay; lost response after commit; failure before commit; retained receipt after local delete; journal expiry yields honest uncertainty. |
| Quotas | Encoded and decoded bounds; author lookup/verification work caps; owner and parent limits shared across transports; failed admitted attempts documented; protected control messages cannot become a storage bypass. |
| Conversation consent | Named but nonconsenting peers receive no body; bounded bootstrap response; wrong account and stale admission cannot accept; leave/rejoin does not backfill; partitions do not create false global membership claims. |
| Presentation and privacy | Shared secrets/capabilities absent from notifications, search, logs, exports and HTML; sender labels accurately distinguish verified identity from provider admission and unverified metadata. |
| Versioning | Unsupported profile/kind has a typed error; no downgrade on failure; machine schema examples validate; legacy clients retain explicit old behavior. |

## Disposition and sign-off

Initial independent recommendation: proceed with a separate typed contact profile and shared parent acceptance pipeline. No runtime test suite was rerun for this documentation-only analysis.

## Final proposal cross-review

Read the [wire proposal](../spec/contact-delivery.md), [architecture decision](../architecture/contact-delivery-wire.md) and [private candidate schema](../architecture/artefacts/contact-delivery-v1.schema.json). They now require a separate protected token type and explicit media-type profile parameter, exact parent-bound `deliver` resource, mandatory conversation creator signature, optional explicitly unverified one-offs, JCS/domain-separated proofs, canonical decoded-byte commitments, 24-hour new-operation age with 60-second future skew and at least 48-hour receipt/fence retention. The media type is reused without reinterpreting the legacy `/api/messages` bearer. A server ignoring the profile parameter cannot silently downgrade the client.

The final prose addresses the independent findings: duplicate authority-bound participants are prohibited; return control verifies the recipient key identified in signed genesis, with a renewed allowance needed after accepted key continuity; semantic fingerprints retain all defined proof metadata and claims while excluding only signature bytes; and pending invitation state must survive a recoverable owner-local admission boundary. There is no provider-spanning transaction, automatic participant acceptance, resource fetching/fanout based only on the proposal, or shared-secret impersonation claim.

The design is suitable for the next implementation review, with no remaining structural blocker in those boundaries. It is not yet a complete deployed interoperability surface: exact new signed-endpoint issuance shape, admission-key discovery/rotation, generic identity-directory continuity, strict parser implementation, crash-safe admission and the future conversation-v2 acceptance contract remain explicit gates. Candidate JSON alone does not enforce duplicate JSON member rejection, decoded digest/length equality, semantic uniqueness, key verification, live authority or time/receipt behavior. Those require shared runtime validation and cross-language vectors. Publication and production enablement remain separate decisions.

Final precision requests are resolved in the reread: signed-POST HTTP202 is distinct from ordinary RPC HTTP200 result/contract-error framing; identity/unverified authorship modes have an explicit kind intersection; and immutable signed-parent profile/version, resource, kind and authorship fields are required. The design author's exact schema/signature vectors are additional evidence, not a substitute for the future transport and failure-injection tests above.

Independently verified the [public cryptographic fixture](../architecture/artefacts/contact-delivery-v1.vectors.json) with Node Web Crypto: canonical bytes for this ASCII-key/integer example, body/semantic/signed-byte SHA-256 digests, both randomized ES256 signatures over identical claims, and rejection after a signed-byte mutation all pass. The fixture contains no private key and uses reserved example domains. This isolated check does not establish authenticated discovery, a general JCS implementation, schema validation or actual delivery interoperability.

The subsequent independent rerun of [contact specification tests](../../tests/contact-delivery-spec.test.mjs) passes **3/3**: fixed cryptographic fixture, re-signature/replay versus semantic tampering, and body-consistent public example with resolved candidate-schema references. No application build or runtime modification was performed by this review.

| Human reviewer | Date | Decision |
| --- | --- | --- |
| | | |
