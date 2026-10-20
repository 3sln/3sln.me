# App engine architecture review

Date: 2026-10-15. This review covers `docs/architecture/app-engine.md` and the
pilot:

- the core in `packages/app/*`;
- the Views and Tags domains end to end;
- the engine harness, CLI and client harness.

It was done by an independent architecture review agent, which read the 3sln
stack deck (`../stack/deck/`) and `vendor/ngin`, and ran:

- `npm test` (1295/1295);
- `tests/worker/app-engine.test.mjs` on real workerd;
- the engine, CLI and client pilot suites.

The architecture lead then fixed the findings listed below. This is a working
review by agents. It is **not** user sign-off: Reviewer ___ Date ___ Outcome ___.

## Verdict

The pilot is sound, and ngin is used faithfully. Specifically:

- instance deps carry `{actor}`;
- `OwnerScopedProvider` releases what it obtained, including on a failed obtain;
- results arrive as feed events and facts go on `engineFeed`;
- no Action dispatches another Action;
- live queries are sequenced, contained and torn down;
- the audit interceptor only observes;
- the single-transaction `DeleteRule` is a real fix, and its seeded lost-update
  test is not vacuous.

Three findings blocked parallel migration. All three are fixed.

## Findings and resolution

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | Major | `invoke` matched the lifecycle fence, gate placement and activity by RPC method name. Every dispatched operation is named `dispatch`, so billing, unsubscribe, identity keys, MCP, links and conversations would break as they migrate. The plan deferred this to slice 9, which runs last. | **Fixed.** Operations declare `lifecycle`, `gate` and `activity` statics. `operations()` validates them, and `operationPolicy` exposes them. `AccountController.invoke` passes the policy to `lifecycleBlocked` and `lifecycleActivity`, both of which gained a `policy` parameter, and to its outside-gate branch. An unknown operation gets the strictest level. Tests are in `tests/engine-app-core.test.mjs`. |
| 2 | Major | The harness tested the production Actions, but not the production composition, which was built inline in `AccountController`. Production label IDs and the clock ignored the `random` and `clock` providers. | **Fixed.** `accountProviders()` (`packages/app/account.mjs`) is called by both `AccountController` and `createTestEngine`. Production `MessagingService` takes `systemClock`/`cryptoRandom`. The remaining difference (production `messaging` is pre-built over the side-effecting store) is documented in §8 and assigned to slice 2. |
| 3 | Major | `ownerOf` checked only the actor's shape. The account-to-owner binding lived in `warm()`, which the harness, the CLI, `owned()` and future direct callers skip. | **Fixed.** `OwnerScopedProvider.obtain` compares the actor's owner with the store's bound `owner` key and refuses with `forbidden` during the lease. `TagRulesProvider` now declares `accountStore` so it gets the same check. This is tested. |
| 4 | Minor | `faultOf` was described as the single serializer, but only the CLI used it. The `$fault` envelope returns the raw message of coded system errors. | **Deferred to Phase 0, and the documents are corrected.** §4, §7 and the `faults.mjs` header now describe the current state. Switching `invoke` and the HTTP catch changes statuses for unknown errors (400 to 500), so it gets its own change. |
| 5 | Minor | `perform` resolved on `result`, before the interceptors' `leave` and the lease release. | **Fixed.** `perform` awaits `complete` and returns the captured result. A failing `leave` now fails the call. This is tested. |
| 6 | Minor | A live query attached its fact listeners after the first fetch, so a fact during that fetch could be missed. | **Fixed.** Listeners are attached first, and the first fetch goes through the same sequence counter. |
| 7 | Minor | No test showed that a workerd async storage transaction rolls back `ctx.storage.sql`. Node `itemIndex` reads bypass the gate. | **Documented** in §4 as not yet verified, with a failure-path workerd test required before slices 2 and 8. The Node read caveat is stated: "correct without the gate" holds for writes. |
| 8 | Minor | The live-query test's `seen.length <= 3` could pass with a broken owner filter. One PRNG served both faults and IDs. | **Fixed.** A counting `ViewsProvider` override asserts exactly three reads for this owner and none for the other. The harness uses separate PRNG streams for fault draws and IDs. |
| 9 | Minor | `IncomingProvider` treats a missing `itemIndex` as "upgrading", which is inference from presence. The `TagRules` query writes, because it seeds defaults. | **Documented** in code. Both are behaviour carried over from before the migration. |
| 10 | Nit | The review document was missing. `engine-billing` named the wrong slice. `--db` could open a live account file. Service-level suites keep their `engine-*` names. | **Fixed:** this document; the slice number; the CLI refuses a file whose `records` table has an `owner` key (tested). **Deferred:** renaming the suites. It is recorded in `docs/release/test-audit-messaging.md` and left to each slice, to avoid churn. |

Other points from the review:

- The §13.4 list was incomplete. It now includes the change that
  `incoming.update` warms the account before it validates input.
- §12 left some shared files without owners: `accounts.mjs`,
  `lifecycle-runner.mjs`, and `messages.mjs`/`item-index.mjs` (needed by slices
  4 and 8). Phase 0 now assigns them.

## Verification after fixes

Run on 2026-10-15:

| Gate | Result |
|---|---|
| `npm test` | 1299/1299 (baseline 1283; +16: engine-views 4→10, engine-tag-rules 4, engine-cli 2, engine-app-core 4) |
| `npm run test:worker` | 52/52 (baseline 51) |
| `npm run test:ui-state` | 205/205 (baseline 200, plus 5 client engine tests). In 2 of 4 full runs, `ui-chaos` "recovery unlock: a lost reply…" timed out at 60 s under parallel load. It passed 3/3 alone and on the final full run. That test exercises the recovery flow, which this change does not touch. Recorded as an open flake, not resolved. |
| `npm run test:dom` | pass |
| `npm run build:assets` | pass |
| `npm run check:worker` | pass |
| `npm run test:e2e` | pass |
