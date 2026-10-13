# Annual plan unit economics

Initial USD base catalog updated by the user on 2026-10-13: Free 500 MB, Paid 5 GB/$5 yearly, Plus 100 GB/$35 yearly, Ultra 1 TB/$250 yearly. Units are decimal; 1 TB is 1,000 GB. Billing remains disabled. These are planning calculations, not measured production costs or an invoice ceiling. The previous analysis is retained as a [superseded historical snapshot](unit-economics-2026-10-12.md).

Actual buyer prices come from configured Polar currency prices. This model uses only the base USD scenario; it does not forecast settlement value, FX, tax or contribution for other currencies. Reconcile those against actual provider transactions before treating regional prices as equally profitable.

## Storage and payment baseline

R2 Standard storage is $0.015/GB-month. Polar Starter's modeled domestic annual transaction fee is 5% + $0.50. Both rates were checked against primary sources on 2026-10-13. Free provider allowances belong to the entire deployment; they are not allocated to each user. Tax, international cards, payout, refunds, disputes and higher Polar subscription plans can change payment economics. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Polar pricing](https://polar.sh/resources/pricing).

| Plan | Annual gross | Modeled payment fee | Full logical payload storage/year | Remaining before other costs |
| --- | ---: | ---: | ---: | ---: |
| Free, 500 MB | $0 | $0 | $0.09 | −$0.09 |
| Paid, 5 GB | $5 | $0.75 | $0.90 | $3.35 |
| Plus, 100 GB | $35 | $2.25 | $18.00 | $14.75 |
| Ultra, 1 TB | $250 | $13.00 | $180.00 | $57.00 |

Formula: quotaGB × occupancy × $0.015 × 12. This table assumes one retained payload copy and full occupancy throughout the year. Staging, old versions and archives add physical bytes; two full copies of an Ultra account cost $360/year before activity, exceeding its gross revenue. Bounded physical retention and cleanup are necessary for these prices. A storage allowance does not include an equivalent TURN relay allowance.

## Reproducible activity scenarios

Run `node scripts/cost-model.mjs`. The calculator now accepts free/paid/plus/ultra cohorts and includes line items, payment fees, shared allowance rounding, semantic sensitivities and fleet totals. It makes no provider requests. Other provider-rate inputs retain their documented 2026-10-12 snapshot and must be rechecked before launch. [Calculator](../../scripts/cost-model.mjs).

The model's unrestricted typical full-storage scenario uses a 1.10 physical-to-logical byte multiplier, with its explicitly listed request/index assumptions. Ultra shares Plus's illustrative activity profile; larger storage is not assumed to imply proportionally more requests or vectors. This is a sensitivity calculation, not a capacity measurement.

| Full-storage typical scenario/year | Free | Paid | Plus | Ultra |
| --- | ---: | ---: | ---: | ---: |
| Modeled infrastructure before shared allowances | $0.206 | $1.769 | $23.460 | $201.660 |
| Net annual receipts before payout | $0 | $4.25 | $32.75 | $237.00 |
| Contribution before payout/support/overhead | −$0.206 | $2.481 | $9.290 | $35.340 |

Substituting the implemented per-owner launch semantic maxima gives:

| Full-storage comparison/year | Free | Paid | Plus | Ultra |
| --- | ---: | ---: | ---: | ---: |
| Modeled infrastructure | $0.404 | $1.496 | $21.120 | $199.320 |
| Contribution before payout/support/overhead | −$0.404 | $2.754 | $11.630 | $37.680 |

This comparison holds nonsemantic workload assumptions fixed, uses 1,000 retained vectors, 500 queries/month and 1,000 document embedding attempts/month, and includes no additional budget-authority overhead. Retained vectors cost money after admissions stop. Free users require an explicit funded subsidy; unused paid storage can improve margins but must not be assumed for every subscriber.

## Actual admission boundaries

Covered logical mutations and physical bucket-put attempts share one activity ledger. Free permits 500/hour and 1,000/day; Paid, Plus and Ultra permit 2,000/hour and 10,000/day. All use rolling windows, with 120 units/app/minute and 240/account/minute. The service ceiling is 10 million admitted units/month, including its archive reserve. A normal hosted upload uses a logical unit plus a physical unit. Failed admitted work is nonrefundable. [Enforcement and migration](storage-write-costs.md).

These counters do not cover every billed request, row, read, semantic operation or external service. Account and service authorities add their own SQL/DO costs. HTTP abuse checks, signup budgets, byte quota, index/count bounds, bounded retries and cleanup complement them. Service shard exhaustion can occur while capacity remains in another partition. Monthly provider invoice reconciliation is still required.

The portal's visible idle file-offer polling can produce 86,400 requests per 30-day month for a continuously open device, more than the illustrative typical account profile. Multiple devices multiply this. Activity writes are coalesced, but permission/authentication reads remain. Measure real request fan-out, active duration, rows, FTS churn, restoration, physical retention and payload downloads before treating a scenario as representative.

Production evidence remains pending: provider billing reconciliation, measured workloads, actual payments/payouts, abuse controls, backup/restore at meaningful size and a funded free-service reserve. The implementation's 1 TB quota is not a claim of a tested 1 TB restoration or a one-blob upload; object and message size/count limits remain separate. Economics/operations reviewer ___ / Date ___ / Outcome ___.
