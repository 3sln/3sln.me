# Conversation implementation adversarial review

Review date: 2026-10-12. Reviewer: MCP implementation agent, independently reviewing the conversation implementation. This is an automated engineering cross-review, not human security sign-off or independent-provider conformance approval. Human reviewer ___ / date ___ / outcome ___.

The review covers the local conversation service, Node account adapters, durable inbox persistence and the optional HTTP peer transport helper. Seven independent regression tests are in `tests/conversations-audit.test.mjs`. The original service author owns the fixes; the reviewer authored and reran the independent attack cases. The review did not enable production release or publish a federated discovery manifest.

| Finding | Concrete attack or failure | Resolution and verification |
| --- | --- | --- |
| Membership secret not signed | A caller retained a valid newer signed membership and substituted its own unsigned secret in the recipient update. | Membership signatures now bind `capabilityHash`; recipient rejects replacement without altering its current capability. |
| Source identity self-declared | A valid invitation contact holder signed a fabricated source account URI with its own key. | Runtime pins the source's actual same-host or configured-peer public identity before admission; the test verifies no room is persisted for a forged source key. |
| Old accepted fanout cancelled on removal | A message was durably accepted for three recipients, then one member was removed before draining. Earlier code cancelled all old-epoch obligations. | Original accepted membership remains the delivery snapshot; all three copies arrive once, while old-secret submissions fail. |
| Signature randomness broke inbound idempotency | The source signed the exact same immutable event body twice with randomized ECDSA signatures. | Recipient fingerprint uses the payload, so the second delivery creates no second inbox copy. |
| Source-selected event ID collided with owner item | A source chose the UUID of an unrelated existing owner inbox message. | Local inbox UUID derives from source URI, room and event ID; the existing record/blob remains intact. Deduplication also includes source and room. |
| Control operations escaped source retention budget | Repeated policy operations created durable receipts without consuming the room event/byte cap. | All source submissions count toward bounded retained operations/bytes; pending introductions are bounded and expired entries are pruned. |

The regression suite also attempts an unsigned creator actor/admin forgery and a caller-selected recipient subset; both fail. The configured HTTP transport rejects unapproved origins and contact-origin substitution before network access, sets `credentials: omit`, and refuses redirects. This proves those explicit checks, not DNS rebinding protection or bounded malicious response parsing.

Residual limitations and release gates remain:

- Remote HTTP peer transport is a configured adapter boundary, not an enabled production provider interoperability claim. The helper lacks independently verified DNS/connection pinning and bounded response/decompression validation; do not wire unrestricted public federation through it before those protections and tests exist.
- This review does not prove compare-and-swap revision fencing across independently implemented providers, cryptographic history chaining, crash consistency at every storage boundary, or authoritative split-brain prevention. Local controller gates and durable recipient receipts cover the tested paths.
- Per-account source retention and pending queues are bounded, but a sustained operational load/cost review, control-history retention policy and provider-level rate limits still require recorded release approval.
- User-requested hard blocks, local quarantine overrides, and independent recipient controls must be assessed against the final implemented UI and policy surface; absence of a tested control must not be described as implemented.

The [conversation specification](../spec/conversations.md), [architecture draft](../architecture/conversations.md) and `DEVLOG.md` must preserve the distinction between tested local behavior, configured external adapters and production-verified capabilities.
