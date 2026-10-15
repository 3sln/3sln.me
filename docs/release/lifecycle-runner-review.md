# Account lifecycle runner review

An independent reviewer read the lifecycle executor wiring on 2026-10-14 and changed nothing. The review focused on data-loss safety, paid-account protection and idempotency. This document records local implementation evidence. It is not a release approval, and it does not show that any notice was delivered in production. Human sign-off: Reviewer ___ / Date ___ / Outcome ___.

## What was reviewed

- `packages/runtime/account-lifecycle.mjs`: the phase model. It now has a committed `purging` fence, a two-day unused threshold (per the user's request in the spec, replacing the draft's three days), a one-hour setup window that does not count as use, a dry-run planner and `restartAfterGap`.
- `packages/runtime/lifecycle-runner.mjs`: the ports, the request-path fence, the activity hook, the tick and reactivation.
- `packages/runtime/lifecycle-storage.mjs`: purge batches and cold tiering.
- `packages/runtime/lifecycle-scheduler.mjs`: the leased, bounded sweep.
- `packages/identity/lifecycle-tombstone.mjs`: the identity tombstone and the admin-hold port.
- `packages/messaging/dispatcher.mjs`: `dispatchLifecycleNotice`.
- Worker and Node adapters, the wrangler configuration, the service worker and the console prompt.

## Findings and resolution

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | High, reproduced | A suspended account whose deadline passed while the executor was in dry run or off could be purged soon after live mode resumed, with no new notice, even though the owner had used it in the meantime. | Fixed. Every live tick records `lifecycle/live-v1`. If more than eight days pass without a live tick, `restartAfterGap` runs: a warning returns to active with a fresh one-year clock, and a suspended or purge-review account restarts a full suspended notice episode. Alarms re-arm at most seven days apart. Regression test added. |
| 2 | Medium, reproduced | The deletion tombstone was enforced only in live mode, so switching to dry run or off revived the deleted account. | Fixed. The tombstone is checked in every mode, in `lifecycleBlocked` and at the start of `alarm()`. Regression test added. |
| 3 | High, evident | Polar webhooks (`billingWebhookVerified`) were refused for suspended accounts, so a payment could not be recorded. | Fixed. Webhooks and setup billing status are allowed while suspended or purging, and a verified webhook schedules a prompt tick. Regression test added. |
| 4 | Medium, evident | A paid account stayed fenced until its next tick, and a review that found a payment only placed a hold. | Fixed. While suspended, the fence checks payment protection and cancels in the same request. A review that finds a payment runs `cancelForPaid` once local protection records it. |
| 5 | Medium, suspected | The Polar order review counted only paid, unrefunded orders on current catalog products, so a refunded or archived-product payer could look never-paid. | Fixed in follow-up. Observing any order, refund or subscription for any product sets a monotonic `lifecycle/ever-paid-v1` marker, from webhooks (before relevance filtering) or from the live lookup, and `accountRemovalProtection` honours it. The live lookup (`packages/runtime/lifecycle-finance.mjs`) lists orders and subscriptions by external customer with no product or status filter. Every step out of `active` needs that lookup to succeed, and so does purge: enabling purge forces `polar` mode even if `LIFECYCLE_FINANCE_REVIEW=local-only`. A failure, malformed page or customer mismatch holds. Tests cover refund, partial refund, chargeback, archived product, deleted product, a webhook marker, a missed webhook recovered by API, API outage and ambiguity. Residual: a customer deleted in Polar can hide orders from the lookup, so only a previously observed marker or local billing evidence protects that account. |
| 6 | Medium, suspected | The final wipe and the tombstone write were not atomic. | Fixed. The tombstone is written before the wipe. Node's `purgeAll({keep})` preserves it inside one transaction. The Worker issues `deleteAll` and the restoring `put` without an intervening await. If the Worker loses that tombstone, the sweep rewrites it from the identity tombstone. |
| 7 | Low–Medium | An account armed late got the two-day unused window. | Fixed. An account older than one day when armed starts with the one-year clock. |
| 8 | Low | The archive was deleted before the last fence. | Fixed. The fence now runs first. |
| 9 | Low | Attempts continued to a suppressed or bounced channel. | Fixed. A blocked notice channel stops new attempts and holds. |
| 10 | Low | Suspended-account notices announced deletion even when purge was disabled. | Fixed. With purge disabled, email uses `suspended-notice`, push carries `deletion:false`, and the prompt omits a deletion date. |

The reviewer also confirmed the following as sound:

- **Purge preconditions.** Purge starts only after:
  - the suspended grace period has elapsed;
  - three spaced attempts, with at least one accepted;
  - a financial proof no older than five minutes;
  - a fresh check of local payment protection and the admin hold;
  - the external-mapping check.
  Each batch first runs a fence step. Deletes are limited to `messages/<owner>/` and `objects/<owner>/`. No external connector delete exists, and accounts with external resources are held at purge review.
- **Tombstone.** It uses a compare-and-swap, keeps the handle and assignment so the name is never recycled, and releases the email claim through the repository's own protocol.
- **Recovery and concurrency.** Purge resumes from its cursor after a crash. Notice reservations carry a lease and a generation check. Lifecycle sections run outside the account gate, so no deadlock was found.
- **Flags.** Both default safely, and the dry run never sends, fences, changes phase, tiers or deletes.

## Independent check of item 5 (2026-10-14)

A second read-only reviewer found no Critical or High issue: no path reaches `purging` without a fresh, successful live lookup, and the ever-paid marker is write-once.

- **Webhooks for non-active identities (Low).** Payment webhooks for admin-suspended or recovering identities were dropped before the marker was written. **Fixed:** for any non-deleted identity, the route now records the marker through the restricted `lifecycleEverPaid` method before the billing status filter.
- **Webhook events dropped before handling (Low, not changed).** `order.created`, dispute events and payloads that fail strict SDK validation never reach the account. Billing webhook parsing belongs to another owner, so the live lookup covers these cases.
- **Payment arriving after the fence (Low, documented).** A payment whose webhook arrives after the `purging` fence commits cannot stop deletion: the proof can be up to 60 seconds old, and webhooks for the tombstoned identity are ignored. Checkout is refused while purging, and an unresolved checkout already holds purge review.
- **Not verifiable offline.** Polar's real list semantics remain unconfirmed: whether omitting `status` returns refunded and void orders, whether orders for archived or deleted products are still listed, and whether a customer deleted in Polar keeps its `external_id`. These need a sandbox check before purge is enabled.

## Cold storage design

Checked against Cloudflare documentation on 2026-10-14:

- The R2 Workers binding has `head`, `get`, `put`, `delete` and `list`.
- `put` accepts `storageClass`, `onlyIf` and `sha256`.
- There is no copy operation and no in-place class change.
- `CopyObject` (S3 API) can change an object's class.
- Lifecycle rules can only move objects to Infrequent Access, by age and prefix, and that move is one-way.

So the closest approach the binding supports is to rewrite identical bytes at the same key with `storageClass: 'InfrequentAccess'`, guarded by `onlyIf.etagMatches`, for owned references only. The job runs in bounded batches and stops if the account is reactivated.

- Access is denied by the lifecycle fence, not by the storage tier, and Infrequent Access objects remain readable once the account is reactivated.
- Objects are not rewritten back to Standard on reactivation.
- Node's `FileBucket` reports the job as unsupported.

Economics: Infrequent Access has a 30-day minimum storage charge, a retrieval fee and higher write prices. For hosted objects capped at 1 MiB over a 30-day suspension, rewriting costs more than it saves. `LIFECYCLE_COLD_MIN_BYTES` defaults to 4 MiB, above the roughly 1.9 MB break-even: 0.005 USD/GB-month saved over the 30-day minimum must cover one $9/M write and a $0.36/M source read, and reads after reactivation pay 0.01 USD/GB retrieval. Smaller objects, including every current hosted object (capped at 1 MiB), stay Standard and are protected by the fence alone.

## Verification

All local, with injected transports and a deterministic clock. No real mailbox or push endpoint was contacted.

- `tests/lifecycle-runner.test.mjs`: 13 tests. They cover:
  - the full timeline for a new account through to purge and a tombstoned handle;
  - a year of inactivity;
  - paid exemption, including after suspension;
  - the admin hold, including a hold raised during purge;
  - reactivation at each stage, and that purging cannot be undone;
  - recovery after a crash and an unknown send outcome;
  - dry run and off;
  - delivery failure and suppression;
  - the hold for accounts with external resources;
  - the dispatcher;
  - the sweep's lease, cursor and resume;
  - the review follow-ups.
- `tests/account-lifecycle.test.mjs`: 18 model tests.
- `tests/worker/lifecycle.test.mjs`: real workerd. It covers the 423 fence over HTTP, CSRF-guarded reactivation, the cron sweep in the `LifecycleScheduler` Durable Object, and purge with `deleteAll`, R2 deletion and an identity tombstone that blocks login.
- `tests/browser/lifecycle-prompt.mjs`: DOM checks of the prompt and the reactivation action.

Full suites after the follow-ups, run on a working tree shared with other agents:

| Suite | Result |
| --- | --- |
| `npm test` | 1141/1141 |
| `npm run test:worker` | 51/51 (the webhook test now accepts only the ever-paid marker write) |
| `npm run test:ui-state` | 185/185 |
| `npm run check:worker` | Passed. The dry run lists the `LIFECYCLE_SCHEDULER` binding and `LIFECYCLE_*` variables. |

No deployment was made, and production delivery remains unverified.
