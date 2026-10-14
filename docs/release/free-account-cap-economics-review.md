# Free-account admission and economics — independent review

Date: 2026-10-13. Status: the initial single-ceiling review below is historical. The current design enforces 100,000 total and 10,000 free-origin lifetime admissions; revised backend and calculator checks are complete, with integrated frontend/release checks separate. No implementation blocker was found in the earlier nonreusable admission model. This is not funding approval, a production inventory attestation or a maximum-invoice guarantee.

Human capacity/funding reviewer: __________  Date: __________  Outcome: __________

## Prior 100,000-ceiling admission criteria and findings

Reviewed the [portable abuse policy](../../packages/core/abuse-policy.mjs), [durable counter](../../packages/runtime/accounts.mjs), [Node configuration](../../apps/node/server.mjs), both Worker configurations, [focused tests](../../tests/signup-admission.test.mjs) and [admission design](../architecture/free-account-admission-cap.md).

The accepted implementation retains the exact `signup:lifetime-admission` authority and increases its configured/default ceiling to 100,000. It does not reset existing stock, introduce a second namespace, refund failed admissions or release capacity on payment/deletion. Counter updates remain transactional. Concurrent claims cannot spend the same final slot; alarms remove expiring windows without erasing lifetime usage. A lower ceiling and malformed/corrupt state refuse further admissions. Node environment configuration now reaches the same policy, with explicit server configuration taking precedence.

The counter intersects the existing IP/subnet/region/hour/day admission controls. It is debited after existing challenge, terms and credential-input checks, before account allocation/creation; later failures can permanently consume stock. It is not added to ordinary sign-in/read/write paths. Strict configuration parsing now rejects malformed numeric strings instead of relying on JavaScript coercion.

This bounds the cohort counted by that authority, including accounts that later become paid or free again. It is not a census of 100,000 currently active free accounts. The design correctly gates a total deployment claim on reconciliation of older/imported cohorts and preservation of the original counter/binding. Missing authority after data loss cannot safely become a fresh production pool. No inventory or production counter change was performed in this review.

Reusing slots on upgrade would be unsafe with current lazy subscription expiry: a later return to free could overbook capacity. A reusable model requires durable owner slot ownership and guarded transitions for expiry, refunds, restore/import and administrative changes. Pending reservation expiry also needs a fence against late activation. These requirements remain future design, not implemented behavior.

Independent focused test rerun: **7/7 passed**, including real durable Node signup, environment/config precedence, restart preservation, final-slot contention, corrupt counts and lower limits. The implementer's final working-tree core log was inspected: **648/648 passed**, `/tmp/bindle-admission-cap-final-tests.log`. The working tree also contains coordinator-known unrelated lifecycle draft tests; their inclusion in this count does not place those drafts in the admission release slice.

## Prior 100,000-account sensitivity review

Reviewed [the cost document](../architecture/free-account-cap-costs.md), [calculator](../../scripts/free-account-cost-model.mjs), current [free-plan quota](../../packages/billing/catalog.mjs), [combined activity/storage-write budget](../../packages/runtime/storage-write-budget.mjs), semantic limits and the prior semantic calculator.

The free quota is 500,000,000 decimal bytes. At 100,000 fully occupied accounts that is 50 TB logical payload and approximately $750/month of Standard R2 storage before the shared allowance. This excludes metadata, snapshots, staging, histories and physical amplification. The calculator's 10% overhead is an assumption, not an enforced upper bound.

Official price pages were independently checked on the review date. The R2 rates and included storage/operation quantities match; its billing rounds excess units upward. The Worker model includes its monthly base once and applies its request/CPU inclusions once, rather than giving each account a free allowance. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

DO SQLite and D1 are modeled as separate services with their respective storage prices and tabled row allowances. Each allowance is assumed available once for this provider-account workload; other applications can consume it. DO duration uses allocated 128 MB and rounded billing units. Summing assumed per-call active time does not measure actual duration: overlapping calls share actor wall-clock time, while pending I/O/nonhibernating work can extend it. D1 whole-unit rounding is an explicit conservative estimator choice rather than an independently verified invoice rule. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

An independent Python recomputation checked every modeled line item and aggregate against the JavaScript report. The three monthly sensitivities are $56.16, $454.81 and $3,406.325 before display rounding; annual values are $673.92, $5,457.72 and $40,875.90. These calculations reproduce the stated assumptions; they do not validate those assumptions against production traffic.

The $13.06 semantic amount is a planning reserve derived from the existing $5 admitted-work estimate plus a retained-vector sensitivity. It is not another enforced global budget or an SMTP/classification allocation. The selected embedding model and Vectorize are separately metered, and retained vectors are not free merely because new work stops. The model page lists approximately $0.0202 per million input tokens; the central pricing table rounds that figure. [Embedding model](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/), [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/).

The implemented 10M monthly allowance counts covered logical mutations and physical put attempts together. It is not 10M free uploads, SQL rows or total HTTP requests. Internal admissions do not map one-to-one to provider billing: reads, rejected traffic, authentication, rate counters, alarms, indexing and RPC fanout can add costs. An all-Class-A sensitivity of $40.50 after the R2 inclusion is only a bound for that covered operation category under its stated assumptions.

The document correctly avoids claiming an all-in dollar maximum. It identifies unmeasured traffic, shared allocations, paid workloads and excluded operating expenses, and keeps funding signoff blank. The proposed 10,000-account review milestone is a recommendation, not a silently enforced lower cap. A genuine spend controller would need measured work-to-billing relationships and finite funded allowances while preserving recovery/security access.

Human economics/security decision: __________  Date: __________  Outcome: __________

## Revised two-counter source checkpoint

The latest source enforces 100,000 total lifetime admissions and 10,000 free-origin lifetime admissions in the same original authority, including conservative one-time legacy migration. Paid pending spends total stock and requires verified first payment before activation, including after recovery; this is not a 10,000 live-free-account census. Independent focused capacity/admission tests passed 13/13 as part of the 26-test paid/waitlist audit. See [the current review](signup-waitlist-review.md) for source boundaries and the corrected recovery bypass. The implementer's final backend log records 674/674 passing tests after the recovery-marker fix; see the linked review for the independent focused evidence. Later unrelated changes need their own integrated run. Paid-origin accounts can later fall back to free, so up to the total counted cohort may eventually create free-plan storage exposure; the 10,000 free-origin ceiling does not establish a $75/month storage upper bound.

## Revised 10,000-account arithmetic checkpoint

Independently reran the current calculator and recomputed every scenario line item and aggregate with Python Decimal arithmetic. The 10,000-account low/moderate/high sensitivities are respectively **$20.185, $40.160 and $296.810 per month**, or **$242.220, $481.920 and $3,561.720 per year**, before display rounding. The revised document agrees with these results. Decimal recomputation also avoids a binary-floating-point boundary accidentally rounding an exact storage unit upward.

At 10,000 fully occupied free-origin accounts, payload storage alone is $75/month before allowances and overhead. This is a cohort sensitivity, not the host's maximum storage cost: paid-origin accounts can later become free, so the counted 100,000-account total has a $750/month payload-only sensitivity. The document now states both populations explicitly. Shared provider allowances, measured actor duration, excluded operating costs, the separate $13.06 planning reserve and the absence of an enforced invoice ceiling remain limitations described above.
