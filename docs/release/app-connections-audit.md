# Connected application lifecycle audit

Status: independent source and local runtime review completed on 2026-10-12; production remains disabled. Human approval: reviewer ___ / date ___ / outcome ___. This document does not assert adapter or external-provider conformance.

The review covers owner/client binding, dissociation and reconnect generations, pending OAuth requests and previously issued tokens, partial authorization-shard failures, data retention, collection projection and protective actions when account work is exhausted. An owner connection is an ordinary resource lifecycle; the existing MCP service remains a separately authenticated transport, and a recorded connection alone does not prove an imported app implements a Bindle contract.

Required invariants:

- Server-authenticated OAuth client identity determines producer provenance; request labels and IDs do not establish authority.
- Account-local dissociation takes effect before best-effort authorization cleanup. A failing shard cannot leave subsequent tool calls authorized.
- Reconnect creates a fresh generation. Old grants, codes, refresh tokens and pending approvals cannot regain authority merely because the same client reconnects.
- Owner data remains in its existing resources. Dissociation removes capability relationships, not unrelated files, inbox contents or storage integrations.
- App-connection descriptors cannot appear as storage collections or claim object-storage conformance.
- Disconnect remains available when ordinary mutation work capacity is exhausted. Cross-owner access fails without revealing private existence.
- Connection listing and cleanup are bounded owner control-plane operations; ordinary calls do not fan out to every authorization shard.

Implementation findings and reproducible adversarial validation will be recorded here after the backend interface is reconciled.

## Findings and reconciliation

The first implementation accepted any owner resource ID for dissociation, so a storage integration could be disabled by the app-connection endpoint. This was corrected to require an app-connection kind/provider, valid positive generation and owner match. Registration now rejects colliding non-app descriptors and malformed generations; dissociation rejects safe-integer overflow before changing durable data. The audit also requested binding the authenticated client ID at admission and final account dispatch; actual MCP paths now enforce that match.

MCP grants pin the connection ID and generation. Account-local dissociation advances the generation and marks the connection inactive. It does not contact all 64 authorization shards: old grants expire normally, while token verification, code/refresh issuance and final account dispatch independently consult the live connection. Reconnecting uses a new generation, so old grants cannot revive. Calls admitted before dissociation may already have completed external effects; no claim of remote rollback is made.

Inspected consent requests bind the reviewing owner and then-current generation. They fail after dissociation even if that app reconnects. Actual durable MCP authorization now rejects approval unless that owner first inspected the request; there is no fallback that silently captures a new connection generation during approval. An independent regression verifies rejection leaves no app resource, then inspection and explicit approval succeeds. Inspection establishes the server-side review snapshot, not a claim that a person read or understood the page.

Connection records use existing `resource/*` custody and archival. Storage listings exclude app connections; their descriptors have no domain contracts and do not claim object-storage or imported-MCP-tool conformance. Owner data is retained. DELETE `/api/apps/:id` occurs after owner authentication and CSRF validation and before ordinary work admission, so dissociation remains available when work capacity is exhausted. Listing bounds fail visibly instead of silently truncating. Retained disconnected records intentionally remain tombstones; the 100-connection limit includes these records, so long-term tombstone compaction and a developer-friendly reconnection/error policy remain operational follow-up work.

## Validation and limits

`node --test tests/app-connections-audit.test.mjs`: **11 passed** on Node 24 with its experimental SQLite adapter. Tests independently cover reconnect generations; storage/data preservation; cross-owner denial; colliding descriptors; corrupt and exhausted generations; old access/refresh/code denial; stale inspected consent; final dispatch after local dissociation without shard cleanup; bounded listing; authenticated producer/client binding; and rejection of never-inspected consent without resource creation. The durable tests use real Node account and MCP authorization adapters rather than fake bearer verification.

This is source and local behavior review. It does not establish production Worker deployment, imported endpoint conformance, external credential revocation, remote data deletion, or browser usability. Account activation and authorization-grant creation span distinct durable authorities: an interrupted approval can leave an active app record with no successful agent login. That record grants no implicit capability and can be disconnected or retried. Account-local dissociation remains the safety authority during partial failures.

Partial UI failure review confirms app-catalog reads and authorization-grant reads are independent: a healthy app catalog retains its disconnect controls when grant listing fails, and successful local disconnect state is retained when subsequent refresh reads fail. Request sequencing rejects superseded refreshes; existing owner-flow checks reject cross-account late results. This behavior is covered by the frontend agent’s DOM tests; native-browser usability remains separate.
