# Conservative free-account admission ceiling

The configured service ceiling is 100,000 lifetime admitted signup attempts. This is a conservative stock limit on accounts that can become free, **not** a live count of currently free accounts. Pending setup, failed creation after admission, paid upgrades, deleted accounts and unused reservations all remain charged. Upgrading or deleting an account never releases its admission. Paid expiry can therefore fall back to free without taking a newly reusable slot from another account.

Implemented configuration: `SIGNUP_MAX_ADMISSIONS=100000` in both Worker configurations and the portable fallback. Node reads the same environment variable, with explicit server configuration taking precedence. Self-host operators can set a different positive decimal integer. This changes the ceiling on the existing `signup:lifetime-admission` durable authority; it does not create a new namespace or reset its stored `lifetime` count. Malformed limits and corrupt persisted counts fail closed. Lowering the ceiling below the already consumed count stops further admissions without rewriting the count.

The existing attempt, IP, subnet, country, global hourly and daily guards continue to intersect this ceiling. Capacity is debited only after challenge, terms, method/password and applicable handle validation, before allocation/creation. A later error can consume capacity permanently. The signup counter is used only during admitted signup; ordinary sign-in, reads and writes do not consult it. Under the existing ten/hour global admission ceiling, adding a sharded allocator would introduce migration/reconciliation risk without removing an ordinary-traffic bottleneck.

## Existing-account baseline and migration gate

The original counter covered only admissions after its introduction. It is not proof that older or administratively imported accounts are counted. Before claiming the service has a total ceiling of 100,000 free-capable accounts, the operator must inventory any account cohort outside that authority and reserve it without double-counting already charged admissions. During this reconciliation, stop new signup or use a proven fenced snapshot. Keep the same durable counter/binding across deployments and backups; do not delete or reset the abuse object as a cache. This patch performs no production inventory, counter mutation, deployment or migration and makes no claim that the deployed baseline has been verified.

Do not subtract deleted or paid accounts during that reconciliation: the chosen model is deliberately nonreusable. If an unknown old cohort cannot be bounded, leave signup gated until it can. A missing original durable authority after data loss cannot safely be treated as a fresh production capacity pool merely because the generic counter initializes missing state to zero on a new host.

## A future reusable current-free limit

A true current-free cap needs durable owner slot ownership and a defined transition when capacity is full. Every transition to free must acquire or retain a slot before free entitlements become effective, including subscription expiry, cancellation, refunds, billing uncertainty, restore/import and administrative changes. Current billing derives free status lazily from expired paid state; simply decrementing a counter on upgrade would permit overbooking later. Pending setup also needs bounded reservation expiry with a durable fence preventing late activation after reuse. The product must decide what happens to a previously paid account whose downgrade cannot acquire capacity while retaining read/export and account-recovery access.

If measured signup volume eventually justifies partitioning, a finite lease design can reserve disjoint batches from a central stock authority into a fixed set of lanes. Count issued-but-unused and uncertain leases against the stock, bind every batch to durable generation/ordinal, and make retry allocation idempotent. Never return uncertain or expired batches without a fence proving no stale lane can spend them. Preserve previously consumed stock and outstanding leases during layout migration; two namespaces must not each start with 100,000. A lease optimization does not solve billing transition semantics or make a nonreusable counter a current-free census. This alternative is not implemented.

## Evidence and decision

Focused tests cover preserved existing count when raising the limit, one winner under concurrent final-slot claims, recreation/alarm durability, lower configured ceilings, corrupt records and checked-in Worker configuration. Full-core and independent evidence are recorded in DEVLOG. No account or paid-plan data was changed to manufacture capacity.

Architecture reviewer: __________  Date: __________  Outcome: __________

Capacity/product reviewer: __________  Date: __________  Outcome: __________
