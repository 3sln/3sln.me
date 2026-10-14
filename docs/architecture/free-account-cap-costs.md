# Free-account cap and funded exposure

Planning checkpoint: 2026-10-13, USD, decimal GB. Current user direction is **10,000 free-signup admissions and 100,000 total signup admissions**, with a paid checkout path when only free capacity is exhausted. Pending/failed setups and deleted accounts conservatively retain their admission charges. The two counters share one durable authority; existing stock is preserved. This is not a live free-account census. See [admission semantics](free-account-admission-cap.md).

The initial free-origin cohort at full 500 MB quotas costs approximately **$75/month or $900/year in payload storage alone**. Paid-origin accounts can later lose their subscription and fall back to free. Consequently the total potential free population can still approach the 100,000 overall stock: **$750/month or $9,000/year**, before metadata/physical overhead. Paid-origin history is not assumed to provide perpetual subscription revenue.

The count limit is not an invoice limit. There is no measured production traffic distribution yet, and rejected requests still incur some Worker, rate-counter and authentication work. Do not interpret this document as a guaranteed maximum bill.

## Storage exposure

Each free account has 500,000,000 logical bytes. At 100,000 accounts, everyone filling their quota means 50 TB. Standard R2 payload storage alone is approximately $750/month or $9,000/year before the shared allowance. Staging, history, snapshots and metadata can increase physical bytes. The table deliberately excludes those costs.

| Accounts | Full logical storage | Storage/month | Storage/year |
| --- | ---: | ---: | ---: |
| 1,000 | 500 GB | $7.50 | $90 |
| 10,000 | 5 TB | $75 | $900 |
| 100,000 | 50 TB | $750 | $9,000 |

For 100,000 accounts averaging 5MB, 50MB or 500MB, the corresponding payload-only monthly costs are $7.50,$75 or $750. A 10% physical-overhead assumption changes them to $8.25,$82.50 or $825 before allowances. The 10% value is a sensitivity, not an enforced amplification bound.

Official Standard R2 prices are $0.015/GB-month,$4.50/million Class A operations and $0.36/million Class B operations. Shared monthly inclusions are 10 GB, 1M Class A and 10M Class B. Billable quantities are rounded upward. Egress has no R2 transfer fee; proxy CPU/read operations still cost money. Infrequent Access is $0.01/GB-month with retrieval charges, higher operation prices and a 30-day minimum. Its lifecycle is not implemented here, so this estimate claims no cold-storage savings. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Reproducible workload sensitivities

Run `node scripts/free-account-cost-model.mjs`. It makes no provider calls. These are three explicit hypothetical fleets, each containing 10,000 free accounts. They are not forecasts, measured traces or safe invoice ceilings.

| Assumption / result | Low utilization | Moderate activity | Full storage and high activity |
| --- | ---: | ---: | ---: |
| Average logical payload/account | 5MB | 50MB | 500MB |
| Dynamic Worker requests/account/month | 100 | 1,000 | 10,000 |
| Total dynamic requests/month | 1M | 10M | 100M |
| Covered R2 writes/month | 100,000 | 500,000 | 1M |
| R2 reads/month | 1M | 10M | 100M |
| DO SQLite storage | 10 GB | 20 GB | 50 GB |
| D1 search/directory storage | 1 GB | 10 GB | 20 GB |
| DO SQLite rows written/month | 4M | 10M | 50M |
| D1 rows written/month | 1M | 2M | 10M |
| Modeled infrastructure/month | **about $20** | **$40.16** | **$296.81** |
| Modeled infrastructure/year | **about $242** | **$481.92** | **$3,561.72** |

Common assumptions: 1.10 physical/logical payload ratio, 10 ms Worker CPU/request, four billed DO calls/request, 50 ms active duration/call at 128 MB, SQL reads below their respective included allowances, and a $13.06 semantic planning reserve. Metadata/row-write values are independent input sensitivities: an activity unit is not a SQL row or a DO call. The linear duration assumption conservatively ignores overlap between concurrent calls to one object; long nonhibernating tasks can cost much more. The JSON output provides each line item. D1 and SQLite byte/row rounding is a conservative planning convention; the documentation does not explicitly require every whole-GB or million-row rounding used here. R2 and DO request/duration rounding is documented. Free allowances are credited once per modeled service, assumed otherwise unused; shared 3sln infrastructure can consume them. No payment proceeds subsidize these free-only fleets.

Worker Standard's base is $5/month, with 10M requests and 30M CPU ms included; excess costs $0.30/M requests and $0.02/M CPUms. Asset requests are free when served directly, but this deployment currently routes its public documents through Worker code. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

DO calls cost $0.15/M beyond 1M, and active duration costs $12.50/MGB-seconds beyond 400,000 GB-seconds, with billable-unit rounding. DO SQLite storage is $0.20/GB-month beyond 5 GB; rows include 25B reads and 50M writes, then $0.001/M reads and $1/M writes. Idle eligible objects do not accrue duration; an actor held awake for a month is a different workload from an idle account. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

D1 separately uses $0.75/GB-month beyond 5 GB, 25B included reads and 50M writes with the same incremental row prices. Search index amplification, FTS writes and failed-request counter updates need measurements. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

The configured 384-dimensional embedder costs about $0.020/M input tokens; Vectorize dimensions have separate stored/queried billing. The current $5 monthly work-admission estimate does not erase retained-vector charges, SQL costs or authority overhead. The $13.06 reserve conservatively combines that $5 with the existing calculator's 2M retained-vector sensitivity; it is not another enforced budget or a classifier allocation. Semantic service membership remains capped at 1,000, independent of 100,000 account admissions. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/).

These tables exclude support, taxes, monitoring/log retention, payment fees, extra system mail, backup replicas, external connector charges, unexpected background operations and paid-account loads. TURN is disabled and SMTP/classifier bridges remain design-only. Their future costs cannot be silently added inside this reserve.

## Existing safeguards and remaining exposure

The service already caps covered logical mutations plus physical storage-put attempts at 10M units/month, sharded into finite allowances. If every such unit were a Standard R2 Class A attempt, that line item would be $40.50/month after the free inclusion. Normal hosted writes often spend both a logical and physical unit, so this is deliberately conservative for covered operations. This is not a cap on all R2 operations, identity backups, SQL writes, reads or dynamic requests. At 100,000 active users, the entire 10M allowance averages 100 units/account/month; at two units/upload that is roughly 50 uploads, before other mutations and the maintenance reserve. Larger owner limits do not create extra global capacity. Growth may require increased funded service capacity or workload prioritization.

Global signup remains 10/hour and 200/day, plus regional, subnet and IP controls. At 200/day, admitting 100,000 accounts takes at least 500 days; concentrating in one region can be slower. Temporary/bot setups consume the same finite admission stock. Cleanup of inactive unpaid accounts is still not a production executor, so this projection does not subtract future automatic deletions.

Anonymous traffic, authenticated reads, idle polling, extra devices, rate checks and SQL/actor fanout can still exceed these hypothetical scenarios. Therefore there is **no proven finite all-in dollar maximum from the 100,000 account cap alone**. Before actively recruiting at this size, measure request fanout/CPU/actor duration/index bytes and provider invoices, reduce idle polling, bound physical retention, configure sampled logs, and introduce funded read/notification/background-work guards where the measurements show exposure. A future global spending controller must use finite sharded leases, reserve security/recovery capacity and fail closed for costly optional work; no single global per-request database counter is proposed.

Recommendation: use the current 10,000 free-origin ceiling as a funding/capacity review checkpoint, and measure the first 1,000 active accounts carefully. The 100,000 overall ceiling does not prove economic readiness for 100,000 full free-fallback accounts. A $100/month subsidy can accommodate some low-use scenarios; it does not guarantee full storage and substantial activity, nor cover paid-origin fallback and retained over-quota data after subscription loss.

Human funding/product signoff: __________  Date: __________  Outcome: __________
Independent economics/security review: [review](../release/free-account-cap-economics-review.md).
