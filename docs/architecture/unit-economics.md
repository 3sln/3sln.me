# Annual plan unit economics

Pricing verified against official pages on **2026-10-12**, USD, decimal GB. These are transparent planning calculations, not production measurements or a guarantee against a large invoice. The requested plans remain **500 MB free, 5 GB/$5 yearly, 100 GB/$30 yearly**. Human approval of operating limits is pending; see D037 and the current review entry in [DEVLOG](../../DEVLOG.md). Nothing here enables billing or production release.

**Conclusion:** the prices can cover bounded storage and modest activity. They cannot fund unrestricted writes, indexing, copies or free-account growth. Full Pro storage with the unrestricted 50,000-vector sensitivity leaves **$4.54/year** after domestic payment fees and modeled technical costs. Substituting the implemented launch semantic limits raises this comparison to **$6.88/year**, before additional budget-authority overhead, payout and support. The heavy scenario loses **$0.63/Plus** and **$8.20/Pro/year** even before those overheads. Keep these prices only with enforced operating budgets and an explicit free-service subsidy.

## Rates and shared allowances

All included usage below belongs to the **provider account/deployment**, once; it never belongs to each application user. Use marginal rates for product economics, aggregate allowances for invoice forecasts. A paid Workers account adds **$5/month**. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

| Meter | Marginal USD rate | Shared paid-plan inclusion |
| --- | ---: | ---: |
| R2 Standard payloads | $0.015/GB-month | 10 GB-month/month |
| R2 Class A writes/lists | $4.50/million | 1 million/month |
| R2 Class B reads/heads | $0.36/million | 10 million/month |
| Worker requests | $0.30/million | 10 million/month |
| Worker CPU | $0.02/million ms | 30 million ms/month |
| DO requests | $0.15/million | 1 million/month |
| DO active duration | $12.50/million GB-seconds | 400,000 GB-seconds/month |
| SQLite DO metadata/index | $0.20/GB-month | 5 GB-month/month |
| SQLite rows read | $0.001/million | 25 billion/month |
| SQLite rows written | $1/million | 50 million/month |
| Vectorize queried dimensions | $0.01/million | 50 million/month |
| Vectorize stored dimensions | $0.05/100 million | 10 million |
| Workers AI neurons | $0.011/1,000 | 10,000/day, no rollover |

Sources: [R2](https://developers.cloudflare.com/r2/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [DO compute and SQLite](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/), [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/).

R2 has no internet egress fee, but GET/HEAD operations still cost money. Standard storage has no minimum retention period. R2 rounds storage to whole GB-month and request overages to million-request units. DO documentation also specifies rounding after included usage; the calculator conservatively rounds each DO meter to its listed billing unit. Rounded invoice estimates need comparison with actual invoices before launch. Idle hibernatable objects incur no duration, but retained SQLite storage does. DO allocation is 128 MB, modeled as 0.128 GB (matching Cloudflare’s decimal-unit examples); duration is active wall time, including waits, shared across concurrent requests on the same object. Index updates add written rows. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

For cheap compact English embeddings this model uses `@cf/baai/bge-small-en-v1.5`: 384 dimensions, maximum 512 tokens/input. Its page lists $0.0202/million tokens; the central table rounds to $0.020. The calculator uses the listed 1,841 neurons/million tokens × $0.011/1,000 = **$0.020251/million tokens**. This is an explicit reconciliation, not an assumed free service. BGE-M3's central listed inference rate is lower ($0.012/million), but model quality, language coverage and downstream vector dimensions must be evaluated before choosing it. [BGE-small model](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/), [AI rates](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## Payment and retained bytes

Use Polar **Starter 5% + $0.50/transaction**. Early Member eligibility is unverified; its 4% + $0.40 plus 0.5% subscriptions must not be assumed. Non-US cards add 1.5%; percentage fees apply to tax-inclusive checkout value. Stripe payouts add $2/active payout month plus 0.25% + $0.25/payout; cross-border conversion can add 0.25–1%. Disputes cost $15 regardless of outcome. Starter has no separate subscription surcharge. [Polar pricing](https://polar.sh/resources/pricing)

| Plan | Annual net after one domestic, tax-free payment | One full payload copy/year | Remainder before any other cost |
| --- | ---: | ---: | ---: |
| Free | $0 | $0.09 | −$0.09 |
| Plus | $4.25 | $0.90 | $3.35 |
| Pro | $28.00 | $18.00 | $10.00 |

With tax added at 25% and an international card, the net before payout is $4.09375/Plus and $27.0625/Pro. Assumptions: displayed annual price excludes tax, one successful payment, no discounts/refunds, collected tax is not merchant revenue. Tax-inclusive advertised pricing would need another model. A $15 dispute fee alone consumes more than four typical Plus account contributions; refunds and lost principal would add further loss. Payment risk reserves are therefore separate from infrastructure limits.

Payload cost is `quotaGB × occupancy × physicalMultiplier × 0.015 × 12`. The multiplier includes versions, staging, trash, delayed cleanup and backups. R2's own managed durability is already in the storage rate; do not multiply for replicas the application does not create. A second application-retained full Pro copy costs another $18/year, making payload alone exceed the $28 net payment. Logical byte quota cannot control physical retained bytes without a cleanup bound.

## Reproducible workload assumptions

Run `node scripts/cost-model.mjs`; it prints JSON inputs, line items, scenario totals, ratios and fleet estimates. The script can also read a JSON file with `cohorts` and `options`. Each cohort has `plan`, `profile`, `count` and optional `override` (for example `occupancy: 1`). It makes no provider calls. Source: [calculator](../../scripts/cost-model.mjs).

For example, save this as `/tmp/cost-input.json`, then run `node scripts/cost-model.mjs /tmp/cost-input.json`:

```json
{
  "cohorts": [
    {"plan": "free", "profile": "typical", "count": 1000},
    {"plan": "plus", "profile": "typical", "count": 100},
    {"plan": "pro", "profile": "typical", "count": 20, "override": {"occupancy": 1}}
  ],
  "options": {"aiActiveDays": 1, "supportPerAccountYear": 0.25, "otherAnnual": 120}
}
```

These are unrestricted sensitivity scenarios, not measured population percentiles or proposed runtime allowances. Several exceed the implemented launch guard of 1,000 lifetime vector upsert attempts per owner and 500 semantic queries/month; the runtime-policy comparison below is separate. Monthly values below use **Free / Plus / Pro** order. Ingest includes changes/reindex work as well as new content. All existing corpus sizes are steady-state assumptions; bootstrap and full rebuilds must be added separately. The heavy case is deliberate legal full-quota usage that would be loss-making without published operational limits.

| Input | Idle retained account | Typical active | Heavy active | Abusive, per account |
| --- | --- | --- | --- | --- |
| Payload occupancy | 100% | 20% | 100% | 100% |
| Physical multiplier | 1.05 | 1.10 | 1.10 | 2.00 |
| Worker/DO requests/month | 0 | 1k / 5k / 20k | 10k / 50k / 200k | 10 million |
| Mutations/month | 0 | 100 / 500 / 2k | 1k / 5k / 20k | 10 million |
| SQLite GB | .002 / .02 / .2 | .005 / .03 / .15 | .03 / .15 / 1 | 1 |
| Retained vectors | 0 | 1k / 10k / 50k | 5k / 25k / 100k | 1 million |
| Semantic queries/month | 0 | 100 / 300 / 1k | 1k / 3k / 10k | 1 million |
| Worker CPU/request | 0 | 5 ms | 10 ms | 20 ms |
| DO active time | hibernates | 20 ms/request | 50 ms/request | one object active all 30 days |

The idle case assumes no live semantic index and no queries; if its vectors remain stored, add that charge. Deleting an index changes search readiness and is not an automatic product policy. No overlapping DO requests are assumed for typical/heavy duration; measure actual active periods instead of adding overlapping spans in production.

Per mutation assume **2 R2 Class A operations, 12 total billable SQL rows written** (including indexes/outbox/counters), and 256 new embedding tokens. Per request assume 0.4 R2 Class B reads and 100 SQL rows examined. Query embeddings add 32 tokens/query. These totals must cover all dispatched work; retries, rebuilds, mail and extra identity/abuse DO calls require extra budget when present. A request that scans the corpus instead of 100 rows violates this assumption. Twelve row writes is a planning input, not a measured FTS write amplification bound.

For monthly `N` stored vectors, `Q` queries and `D=384`, queried dimensions follow the provider's published formula `(N+Q)D` when the index is queried; stored dimensions are `ND`. With no queries the queried charge is zero. It is **not `N×Q×D`**. The model allocates each cohort's stored dimensions once; shared-index layouts and actual billing attribution still need measurement. [Vectorize formula](https://developers.cloudflare.com/vectorize/platform/pricing/)

Annual technical cost before shared allowances is twelve times the sum of every monthly meter × its rate. Infrastructure includes Worker/DO compute, R2, SQL, embedding and Vectorize. It excludes external mail, logging, queue services, OCR, generative answers, domain/zone fees, Node hosting, support, acquisition, refunds, FX and engineering. This is not total cost of ownership. The fleet calculator accepts `supportPerAccountYear` and `otherAnnual` for those costs. The model assumes no separate billed queue service; if Cloudflare Queues is deployed, add its measured operations.

## Results and failure sensitivity

All account amounts below are **annual marginal USD before deployment allowances/fixed fees**. Contribution means payment net minus technical cost, before overhead. Free accounts always require subsidy.

| Scenario | Free cost | Plus cost | Plus contribution | Pro cost | Pro contribution |
| --- | ---: | ---: | ---: | ---: | ---: |
| Idle, full payload | 0.099 | 0.993 | 3.257 | 19.380 | 8.620 |
| Typical, 20% payload | 0.127 | 0.977 | 3.273 | 7.620 | 20.380 |
| Typical activity, **100% payload** | 0.206 | 1.769 | 2.481 | 23.460 | 4.540 |
| Heavy, full payload | 0.898 | 4.877 | **−0.627** | 36.199 | **−8.199** |
| Abusive illustrative traffic | 3,427.978 | 3,429.598 | **−3,425.348** | 3,463.798 | **−3,435.798** |

The abusive case is **not a maximum**. Storage-byte limits do not bound churn, unauthorized requests, free-account creation or repeated failed work. One thousand such accounts would imply millions of dollars/year at these marginal rates. Reject work before paid downstream operations and meter identity/signup traffic globally.

For full-storage typical Pro, the $23.46 cost comprises $19.80 physical R2 storage, $2.465 vector costs, $0.36 SQL storage, $0.288 SQL writes, $0.251 R2 operations, $0.132 embeddings, $0.024 SQL reads and $0.140 Worker/DO compute. Cheap inference is not the dominant search expense in this scenario. Initial embedding of 50,000 chunks × 256 tokens adds about $0.259 before shared AI allowance; a rebuild also incurs SQL/blob/vector and job execution work, and must not run freely on every login.

Useful independent sensitivities, before allowances:

- One million additional R2 Class A operations/month costs **$54/year**; one million extra SQL rows written/month costs **$12/year**.
- 100,000 retained 384-dimensional vectors and 3,000 queries/month cost **$4.97664/year** for Vectorize alone.
- One continuously active 128 MB DO costs **$4.1472 per 30-day month** at marginal duration rates; 1,000 such objects are $4,147.20/month before shared allowance and rounding.
- An extra 1 GB SQL index costs **$2.40/year**; another full Pro payload copy costs **$18/year**.
- Five minutes of human support at an illustrative $30/hour costs **$2.50**, exceeding the full-storage typical Plus contribution. That wage/time is a planning assumption, not a provider quote.

## Free subsidy and fleet break-even

With no overhead, `freeAccountsPerPaid = max(0, paidContribution) / freeAnnualCost`. A typical Plus supports **25.79** typical free accounts at zero remaining margin; Pro supports **160.60**. Spending only half that contribution gives **12.90** and **80.30**. These optimistic occupancy-dependent ratios must not become unlimited promises. At full storage with typical activity for everyone, ratios fall to **12.04** and **22.03**, or **6.02** and **11.02** using half the contribution. Heavy paid accounts support **zero** because they already lose money.

Adding $0.25 support/year to every account reduces typical ratios to **8.02/Plus** and **53.41/Pro**, before shared overhead. Full-storage ratios with that support fall to **4.89/Plus** and **9.41/Pro**. Formula: `max(0, paidContribution − paidSupport − allocatedOverhead) / (freeCost + freeSupport)`. Treat each free cohort as a recurring financial liability, including abandoned accounts.

The following fleet forecasts apply shared allowances once, R2/DO rounding, $60/year Workers base, and 12 monthly Stripe payouts ($27 fixed/year plus 0.25% of net receipts). AI is conservatively concentrated into **one active day/month**; the daily free allocation is never multiplied by 30 unless usage really occurs on 30 days. Monthly workload repeats for 12 months; 30 days is used for always-active DO duration.

| Fleet | Annual net receipts | Infrastructure including base | Payout fees | Contribution before other overhead |
| --- | ---: | ---: | ---: | ---: |
| 1,000 free + 100 Plus + 20 Pro, typical | $985.00 | $350.87 | $29.46 | **$604.67** |
| Same, plus $0.25/account/year support and $120/year other costs | $985.00 | $350.87 | $29.46 | **$204.67** after those costs |
| Same counts, all heavy | $985.00 | $1,712.65 | $29.46 | **−$757.12** |
| 10,000 free, heavy | $0 | $8,209.29 | $0 | **−$8,209.29** |

Under typical assumptions, no free users or support, the same calculator first reaches positive contribution at **23 Plus-only** or **4 Pro-only** subscribers, including those fixed Workers/payout costs and provider allowances. This is a tiny-deployment invoice crossover, not a scalable product margin. At scale the per-account marginal costs are the relevant comparison. Add actual fixed overhead before relying on break-even counts. Irregular annual renewals also make cash flow different from revenue recognized over the service year.

## Implemented launch-policy comparison

Source reviewed on 2026-10-12: [owner semantic budget](../../packages/search/semantic-budget.mjs), [durable vector reservations](../../packages/search/cloudflare.mjs), and [global admission budget](../../packages/runtime/semantic-budget.mjs). These source-level controls do not establish a deployed provider configuration or live invoice verification.

Per owner, the implementation permits at most **1,000 lifetime upsert reservations**, **1,000 document embedding attempts/month**, and **500 semantic queries/month**, truncates input to **480 UTF-8 bytes**, and reserves **512 tokens per embedding attempt**. Owner monthly counters also cap 768,000 embedding tokens, 576,000 vector dimensions and $0.025 estimated operation spend. Failed/uncertain attempts consume reservations; deletions do not restore the lifetime upsert budget. The lifetime limit therefore includes revisions/retries and can stop enrichment before 1,000 distinct documents succeed. It is a restrictive launch bound, not unlimited updating of a 1,000-document index.

Global defaults admit **1,000 semantic owners**, at most **2 million lifetime upserts**, **$5/month estimated operation spend** and **$0.50/day estimated operation spend**. These are application admission estimates, not guaranteed provider bill caps. The global budget can stop work before any individual owner's allowance; 1,000 owners cannot all consume their monthly maxima simultaneously. Existing storage/index costs continue after new operations stop.

The calculator's `launchPolicy` output holds the full-storage typical scenario's nonsemantic meters fixed and substitutes **1,000 retained vectors, 500 queries/month and up to 1,000 document embedding attempts/month**, charging 512 tokens per document/query. Keeping document attempts at the maximum every month is conservative even when lifetime upserts have been exhausted. It excludes additional budget-authority SQL/DO overhead pending measurement; therefore the totals below are a comparison scenario, not a certified cost ceiling.

| Annual amount before shared allowances | Free | Plus | Pro |
| --- | ---: | ---: | ---: |
| Direct embedding + Vectorize at owner maxima | $0.258 | $0.258 | $0.258 |
| Full-payload comparison technical cost | $0.404 | $1.496 | $21.120 |
| Contribution before overhead | −$0.404 | $2.754 | $6.880 |

Against unrestricted typical Pro's 50,000 vectors and 1,000 queries/month, direct semantic cost falls from **$2.597 to $0.258/year**, saving **$2.339/year (90.1%)**. Its full-storage modeled contribution rises from **$4.540 to $6.880**, with all nonsemantic assumptions held fixed. The byte excerpt and lifetime update cap materially limit search coverage; present that tradeoff to users. Free owners saturating these semantic limits cost more than the proposed $0.249 total free-account envelope below, so those broader spend proposals are **not fully implemented** by the semantic guard.

For a recurring-stock sensitivity, 1 million retained 384-dimensional vectors in queried indexes add **$3.84/month queried-stock cost plus $0.192/month storage**, before allowances. Adding the $5 monthly operation-admission estimate gives **$9.032/month direct semantic planning exposure**; the more conservative 2-million-vector stock case is **$13.064/month**. These intentionally overcount some upsert work already in the provider formula. They assume the priced model, measured operation estimates and bounded stock remain valid; they omit Worker/DO/SQL cost, billing changes, retries outside these paths and any unrelated provider usage. A $5 operation ledger must never be advertised as a $5 Cloudflare bill limit.

## Provisional operating envelopes

Propose annual **non-payload technical spend** budgets of **$0.15 free, $1 Plus, $3 Pro**, with physical payload bytes capped at 1.10× logical quota through bounded staging/version retention. At full payload this allows up to **$0.249/free, $1.99/Plus, $22.80/Pro** total marginal technical costs and leaves **$2.26/Plus, $5.20/Pro** before payout/overhead. Pro typical vectors must shrink below 50,000, queries/churn must decrease, or this $3 budget must increase: typical non-payload cost is $3.66. This is an explicit product tradeoff, not an implemented restriction or approved allowance.

1. Keep durable per-account reservations for byte growth **and estimated paid work**. Reserve worst-case provider tokens, operations, rows and retry attempts before starting, settle against measured usage, and debit failed work too. A ledger per request that itself creates many writes needs its own measured budget. Use aggregate service tokens leased in bounded batches to avoid a hot centralized budget object and to bound outstanding reservations.
2. Enforce item/metadata/vector counts and model token limits independently of payload GB. Rate-limit mutation churn, queries, upload parts, extraction CPU, payload downloads/heads and request fan-out. Budget index rebuilds and old/new generations together. No client-controlled model or unbounded queue retries; deduplicate by content/model version.
3. Pause optional semantic enrichment at 90% of its envelope, expose coverage state, and refuse new enrichment at 100%. Preserve indexed lexical/tag search and bounded reads/export/delete under reserved safety capacity. Core write throttles and count limits need public terms before paid launch; budget exhaustion must not silently drop accepted work.
4. Keep DOs hibernatable; do not hold an object awake during client connection lifetime or provider waits. Use short serialized metadata sections and bounded background jobs. Measure full active time and actual SQL rows written, including indexes/deletes/alarms.
5. Create a **global monthly liability envelope**, not merely per-account limits: `admittedFree × fullUsageFreeCost + paid variable cost + fixed costs + reserve`. Choose an explicit cash-funded subsidy. Stop new free signups when admitted obligations exceed it; lowering current traffic does not erase retained-storage costs. For example $25/year of subsidy buys at most **100** full-use accounts at the proposed $0.249 cost before overhead, not thousands. No deletion of existing data is authorized by a spend alert.
6. Rate-limit unauthenticated traffic at the edge before DO/R2/AI calls; cap CPU/subrequests and test floods, retry storms, tiny-item spam and abandoned multipart uploads. Maintain a service-wide circuit breaker that disables optional writes/AI and stops admission. Account for outstanding work, billing-unit jumps and detection lag when setting the trigger. A safety reserve must exceed maximum in-flight spend plus accrued storage liabilities. Incoming Worker requests themselves can still cost money; application counters alone cannot guarantee a hard provider invoice ceiling.

Cloudflare documents configurable CPU/subrequest limits and email budget alerts. An alert is notification, not a proven automatic invoice cap; CPU limits do not cap request count, R2 or AI. Verify controls by fault-injection and reconcile provider billable meters before opening registration. [Workers CPU limits](https://developers.cloudflare.com/workers/platform/pricing/), [subrequest limits](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/), [budget alerts](https://developers.cloudflare.com/changelog/post/2026-06-15-budget-alerts-default-on/)

Release evidence still required: measured request/write amplification, P50/P95/P99 account workloads, cost of FTS churn and restoration, provider invoice reconciliation, actual payment/payout setup, abuse kill-switch tests and a funded free-service reserve. Configured keys, passing arithmetic or this document do not establish any of those capabilities.

## Current portal polling and unmeasured overhead

The file-offer portal uses a 30-second idle polling interval while a signed-in document is visible, and a 5-second interval during an accepted or waiting transfer. Polling stops when the document is hidden, offline, signed out or disposed. A continuously visible idle client can therefore generate **86,400 mailbox requests per 30-day month**; multiple devices multiply that activity. That is materially above the earlier 1,000-request typical free-account scenario. Account activity writes now coalesce within fifteen minutes, unchanged warm-owner reads no longer rewrite the owner, and scheduling preserves earlier pending work, but those changes do not eliminate authentication/permission RPCs and SQL reads. Use measured mailbox fan-out, pending-offer counts and active hours in the calculator before treating the typical scenario as representative. Hibernating push/WebSocket delivery and complete production push dispatch remain separate work. Sender/receiver signaling and TURN are additional operating costs, not hidden within storage GB.


Covered-change admission now has provisional monthly owner caps of 1,000/5,000/10,000 and a 250,000 service cap. Durable leases add their own writes: an approximate 1.125 logical metadata puts per admitted unit would mean 281,250 puts at the service ceiling, before index amplification. Logical puts are not measured Cloudflare billable rows. Reads, security/privacy controls, billing upgrades, beaming signaling and incoming requests remain outside this counter. These restrictions reduce mutation exposure, but do not establish an invoice cap or make the earlier typical polling assumptions representative.
