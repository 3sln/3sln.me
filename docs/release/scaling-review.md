# Independent scaling and cost review

Date: 2026-10-11. Scope: repository architecture inspection and primary-source pricing/capability verification. Companion design: [storage, search and operating cost](../architecture/scaling.md). This is an independent assessment of the existing implementation, not a production certification or a second independent review of its own companion design. Human reviewer: ___ Date: ___ Outcome: ___.

## Finding summary

| ID | Priority | Finding | Required resolution / evidence |
| --- | --- | --- | --- |
| SC-01 | High before high-capacity release | Message list reads/sorts the full account metadata; `/api/messages` obtains a newest-100 snapshot. Hosted object list rejects cursors. | Indexed keyset pages and all-history coverage tests; search cannot reuse the loaded page as its corpus. |
| SC-02 | High before high-capacity release | Cold metadata restore reads one 8 MiB/2,000-row archive and restores it in one transaction; account gates span external I/O. | Bounded segment manifest/restore and short reservation/commit gates; cold/hot-account latency measurements. |
| SC-03 | High before paid release | Current custody includes multiple physical stores and delayed garbage. Raising the quota is insufficient evidence of aggregate quota or sustainable cost. | Shared durable accounting, reservations/reconciliation, orphan/old-version cleanup and full-occupancy invoice model. |
| SC-04 | High before semantic claim | A semantic provider, persistent vectors, extraction coverage and derived-index consistency need independent verification. | Real embeddings with model identity, degraded-state reporting, relevance corpus, delete/revision/ACL tests; no hash similarity represented as learned semantics. |
| SC-05 | High before broad growth | One `directory-v1` holds identity records and claims. Per-account DOs do not distribute that workload. | Directory load benchmark and fenced partition/claim migration before saturation. |
| SC-06 | Medium | Node is a single-process synchronous SQLite adapter with unbounded account/abuse handle maps. | Bounded handle lifecycle and event-loop/RSS/FD soak; distributed Node cannot be advertised yet. |
| SC-07 | High before paid release | $30/year for fully occupied 100 GB yields $10 after modeled Starter fee and R2, before every other cost; 500 MB free requires subsidy. | Cost budgets for metadata, search, backups, email and support, plus explicit subsidy envelope. Requested prices remain unchanged and configurable. |
| SC-08 | Medium | 1 MiB message/object payload bounds and smaller generic JSON limits are separate from storage capacity. | Honest capability/UI limits now; later streaming upload protocol, multipart cleanup and body-limit tests. |

## Review evidence and limits

Inspected `packages/runtime/accounts.mjs`, `packages/runtime/http.mjs`, `packages/runtime/offload-metadata.mjs`, `packages/messaging/messages.mjs`, `packages/messaging/store.mjs`, `apps/worker/objects.mjs`, `apps/worker/index.mjs`, `apps/node/resources.mjs`, `AGENTS.md` and the existing decision ledger. Findings refer to the source baseline inspected during this work; concurrent billing/search implementations must be reconciled by the coordinator rather than silently declared complete here.

Official Cloudflare documentation verifies that SQLite-backed DOs support FTS5. The existing generic KV interface does not implement the proposed indexed schema. Pricing was checked against official R2, DO, Vectorize and Polar pages linked in the companion design. Current Polar Starter is 5% + $0.50; historical Early Member eligibility was not inferred. No credentials, paid products, subscriptions or live vector indexes were created by this review.

This documentation-only audit ran no throughput, production-region, 100 GB ingest, restore, billing-conformance or relevance benchmarks. Existing automated application tests do not establish those properties. The proposed p99 targets and migration thresholds are acceptance criteria, not measurements. Production release stays gated.

## Cross-review checklist for the coordinator

- Ensure implemented search covers authoritative stored items and marks unsupported/unindexed sources; distinguish lexical fallback, local development semantics and real provider semantics.
- Verify billing defaults preserve the three requested prices, use decimal storage bytes, require authenticated owner checkout and verified server-side entitlement updates, and leave missing external configuration unavailable.
- Reconcile actual quota paths for message ingest and hosted object replacement/deletion, archive restore and reservation recovery. Keep monotonic revisions while allowing actual usage to decrease.
- Record adapter/test evidence and unresolved SC findings in `DEVLOG.md`. A partial local improvement must not close a finding that requires production capacity or recovery proof.
- Obtain independent code/security review of the implementation and later human sign-off in the blank slots; this author's architectural proposal is not its own second-review approval.
