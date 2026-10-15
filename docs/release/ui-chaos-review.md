# UI chaos suites: independent review

Reviewer: independent review agent. Date: 2026-10-14. Automated review is engineering evidence, not human approval. Verdict below is provisional. Human reviewer: ___ Date: ___ Outcome: ___

## Scope

New, uncommitted suites:

- `tests/browser/ui-chaos.mjs` (happy-dom UI-state level; also in `npm run test:ui-state`), 9 tests.
- `tests/e2e/chaos.mjs` (shared Playwright fault harness), `tests/e2e/ui-chaos.test.mjs` (20 tests), `tests/e2e/ui-chaos-scale.test.mjs` (4), `tests/e2e/ui-chaos-contention.test.mjs` (2). These run in Playwright against a throwaway local Worker and are registered in `scripts/run-browser-checks.mjs`.
- `tests/browser/islands-chaos.mjs` (islands harness copy with a fault hook; starts its own Worker), 2 tests.

The product fixes these suites guard were read for context only. No product or test file was edited.

## Method

1. Read every test. For each one, checked whether it asserts a user-visible invariant: no stuck busy state, honest errors, no success for an unknown outcome, no double submission, no stale account data after a switch, recovery without reload where promised, no console errors. Then reasoned from the product code whether a regression of the guarded behaviour would make it fail. No mutation testing was done, because the working tree is shared.
2. Ran each suite 5 times, one run at a time, through a scratchpad runner named `ui-chaos-review-runner.sh`. The runner has been stopped. Assets were already built and were not rebuilt.

Environment: macOS (Darwin 23.6), headless Chromium via Playwright. Load average was 4.2–5.5 throughout because other agents were working in the same tree. No timeouts were seen.

## Results

### `node --experimental-loader ./tests/browser/loader.mjs --test tests/browser/ui-chaos.mjs`

| Run | Result | Duration (node:test) |
| --- | --- | --- |
| 1 | 9/9 pass | 2.32 s |
| 2 | 9/9 pass | 2.27 s |
| 3 | 9/9 pass | 2.23 s |
| 4 | 9/9 pass | 2.21 s |
| 5 | 9/9 pass | 2.27 s |

### `node scripts/run-browser-checks.mjs tests/e2e/ui-chaos.test.mjs tests/e2e/ui-chaos-scale.test.mjs tests/e2e/ui-chaos-contention.test.mjs`

| Run | Result | Duration (node:test / wall incl. Worker) |
| --- | --- | --- |
| 1 | 26/26 pass | 62.2 s / 64 s |
| 2 | 26/26 pass | 60.8 s / 62 s |
| 3 | 26/26 pass | 61.4 s / 63 s |
| 4 | 26/26 pass | 60.5 s / 62 s |
| 5 | 26/26 pass | 61.2 s / 63 s |

The slowest tests were stable across runs:

- two-tab contention: about 11.6 s
- retained-memory rounds: about 11.4 s
- device QR: about 6.25 s, because it waits for the real 5 s poll interval
- 5,000-message inbox: 2.6–3.1 s

### `node --test tests/browser/islands-chaos.mjs`

| Run | Result | Duration (node:test) |
| --- | --- | --- |
| 1 | 2/2 pass | 3.71 s |
| 2 | 2/2 pass | 3.84 s |
| 3 | 2/2 pass | 3.77 s |
| 4 | 2/2 pass | 3.79 s |
| 5 | 2/2 pass | 3.78 s |

No flaky failures in 15 runs (185 test executions).

## Findings (by severity)

### Medium: assertions that can pass vacuously or race the event they guard

1. **Late sign-in reply after going offline** (`tests/e2e/ui-chaos.test.mjs:40-44`).
   - Problem: after `c.release(gate)`, the test waits for `!document.querySelector('.user-summary')`. That condition is already true before the late reply is processed, so the check passes immediately. The test then sets `c.model.signedIn=false` before reconnecting (line 43), so the reconnect session recheck would erase a session that was wrongly applied.
   - Effect: if the late reply regressed into opening a session, the window to see it is very short. The final checks can still pass.
   - Fix: wait for the released response to be delivered (`page.waitForResponse`, or a fixture flag set in the handler), then frames, then assert. Keep `model.signedIn` true while asserting.
2. **Superseded View response** (`tests/e2e/ui-chaos.test.mjs:86-88`).
   - Problem: the "no Loading messages" wait can already be true once Home has rendered. Two animation frames then stand in for "the late Work page has been processed".
   - Effect: this depends on timing. A regression that applied the stale page a little later could still pass.
   - Fix: await the response for the held `view=work` request before the frames.
3. **Two-tab focus refresh** (`tests/e2e/ui-chaos-contention.test.mjs:27`).
   - Problem: tab B already shows `two.handle`, so `shell(b,two.handle)` right after the synthetic `focus` resolves immediately. The "B keeps its own account" count is taken before any focus-triggered refresh has finished.
   - Fix: wait for the refresh request that focus triggers (for example a `/api/session` or `/api/auth/accounts` response on B) before asserting.
   - The later sign-out half of the test (lines 29-35) is sound.
4. **Admin 503 "wipes privileged data"** (`tests/browser/ui-chaos.mjs:195-205`).
   - Problem: the overview never loads in this fixture, because it is `step_up_required` throughout. `state.overview??null` is therefore null whatever the product does.
   - Effect: only the "way back" half asserts anything. Its regex also accepts `Back to your space`, which the comment admits is a reported limitation, not an in-place retry.
   - Fix: to guard the wipe, load an overview first (step up, then a 503 on a later step-up).

### Low: weak or loose assertions

5. **Signup triple click** (`tests/e2e/ui-chaos.test.mjs:153`).
   - Problem: `visited` deduplication cannot detect a skipped question, because a skip makes no duplicate. The test catches skips only indirectly, when a skipped step's validation raises an alert (line 151).
   - Fix: compare `visited` against the expected step list, or its length.
6. **Sign-in fault burst** (`tests/e2e/ui-chaos.test.mjs:21-26`).
   - Problem: from the second iteration on, `getByRole('alert').waitFor()` can match the previous iteration's alert. The per-kind alert check reads the first alert and only tests that it is non-empty and has no raw wording.
   - Mitigation: `c.busy()` plus `c.settled()` do make sure the reply was processed. The request-count, form-usable and no-session checks are sound.
   - Fix: also assert that the alert disappears while busy, or map each fault kind to its expected message.
7. **Unknown-outcome wording regex** (`tests/e2e/ui-chaos.test.mjs:76`). `/may|check|.../i` is broad: `may` matches unrelated text. Fix: match the transport-mapped sentence ("Check whether your request went through").
8. **Back/forward during a pending request** (`tests/e2e/ui-chaos.test.mjs:114-119`).
   - Problem: Chromium under automation never uses the bfcache, so `goBack()` is a full reload and the held `/api/views` request is simply discarded. The test only shows that a reload recovers with nothing stuck. It does not exercise "no stale state" across a history restore.
   - Fix: rename the test, or point to the bfcache replay test.
9. **Two-tab test tail** (`tests/e2e/ui-chaos-contention.test.mjs:36`). `shell(a,…).catch(…)` accepts either outcome, so the last statement asserts little about tab A. Fix: assert the expected outcome.
10. **Clipped overflow** (`tests/e2e/ui-chaos-scale.test.mjs:13,36`). `documentElement.scrollWidth - innerWidth` is meaningful, because `html` and `body` do not hide overflow. Content clipped inside `overflow:hidden` containers such as `.inbox-panel` is not detected, though.
11. **Layout and style flatness bounds** (`tests/e2e/ui-chaos-scale.test.mjs:24-25`). These are structural counts, not wall time, and were stable over 5 runs. They may still drift with renderer or Chromium versions. Treat a failure as a prompt to investigate, not proof of a regression.

### Informational: hygiene

12. **Unseeded randomness** (`tests/browser/islands-chaos.mjs:72`). `Math.random()` picks the forwarded `cf-connecting-ip`. It only partitions rate limits and does not change the order of faults, but it is not reproducible.
13. **Duplicated harness** (`tests/browser/islands-chaos.mjs:17-118`). About 100 lines are copied from `islands-embed.mjs`, including unused Firefox/WebKit launch paths and a no-op `instrument`. The two copies can drift. Consider a shared module.
14. **Dead code** (`tests/browser/ui-chaos.mjs:143,150`). `const original=f.server.answer` and the later restore have no effect.
15. **Real-time waits.**
    - The device QR test waits for the real 5 s server poll interval (`tests/e2e/ui-chaos.test.mjs:133`, with a 12 s bound).
    - The entry-page tests poll every 5 ms (`tests/browser/ui-chaos.mjs:212`) and the islands tests every 50 ms (`islands-chaos.mjs:125`).
    - All of these poll for a condition with a time bound, rather than sleeping a fixed time.
    - Other ordering is driven by events, gates and seeds.
    - No fixed sleeps that could hide a regression were found.

### Tests judged meaningful (would fail on regression)

**Happy-dom suite.**
- The 100-seed account/network chaos run is seeded (mulberry32). It asserts:
  - busy is released, and no `Please wait…` or `aria-busy` is left
  - no data from the other owner is shown
  - the transport account matches the rendered account
  - "View saved." appears only after a confirmed save (a global count, so it is loose but valid)
  - no raw transport wording appears
- Timeout mapping (the GET/POST wording differs; a caller's own `AbortSignal` keeps `TimeoutError`).
- Unreadable 200 is mapped to `response_unreadable` and never to a refusal; Spanish catalogue entries exist.
- Duplicate device poll: one request.
- Recovery double submit: one request, the file is kept for retry, and there is no navigation on failure.
- Admin double step-up: one credential, no retry without a confirmed step-up.
- Entry-page load faults read as unavailable, with 404 as the "expired" control.
- Entry double press: one select, and a lost decision does not navigate.

**Playwright suites.** These tests use held gates, so double clicks land while the request is busy, which proves the busy reservation rather than relying on timing:
- sign-in fault burst
- passkey cancel and finish failure
- View save with an unknown outcome
- refresh failure after a mutation
- bfcache replay (session re-read)
- device QR interrupted state and retry
- account switch: old data hidden while the switch is held, an unknown switch shows no open account, and a retry lands only on the chosen account
- sign-out of another account
- 401 while reading erases content
- intake conflict, 503, and refresh failure
- billing: untrusted URL refused, unknown change kept for reconciliation
- billing navigation race
- contact send: the same operation is retried
- signed contact redeem
- public contact retry without the stripped capability
- 5,000-row paging, which also checks one request per page
- 20 accounts
- retained DOM, listeners, heap and documents after a forced GC
- service-worker update waits and activates for the next session
- island double activation gives one popup, a closed popup ends once as `canceled`, and 503/429 end as `unavailable` with no popup left open

Every Playwright context fails on any page error or unexpected console error (`tests/e2e/chaos.mjs:53-56`).

## Environment limitations

- Only headless Chromium was used. WebKit and Firefox are not covered by these chaos suites; the islands copy keeps launch paths for them but only exercises Chromium.
- Chromium disables the bfcache under automation. The restore path is replayed by dispatching `pagehide` and `pageshow` with `persisted:true`. That tests the product's `pageshow` handler (`apps/web/src/release.mjs:124`), not a real bfcache restore.
- Faults are injected at the HTTP boundary by fixture models in `chaos.mjs`. Contention and islands use the real local Worker. None of this is evidence that production providers (Polar, Turnstile, email/push) behave this way. Billing tests are mocked and never call Polar.
- Load average was about 5 because other agents shared the machine. Durations are indicative only.

## Verdict (provisional)

All three suites passed 5 of 5 runs, with stable durations and no flakiness seen. Most tests assert real user-visible invariants and would fail if the guarded behaviour regressed.

Four medium findings (1–4) are checks that can pass vacuously or race the event they guard:
- offline late sign-in reply
- superseded View page
- two-tab focus refresh
- admin 503 data wipe

Until those are tightened, these four tests should not be counted as evidence for their specific claims. This does not block the suites as regression coverage. Provisional: no human sign-off.

## Author follow-up (2026-10-14, not re-reviewed)

The test author addressed findings 1–4 after this review. The reviewer has not checked these changes.
- Offline late reply: the test now waits for the held login reply to be delivered (`requestfinished`) and two frames, then asserts there is no session. The fixture no longer resets the service state before reconnecting. After reconnecting, the test asserts that the console shows what the service reports.
- Superseded View: the test waits for the late Work response to be delivered, then for frames and the settled state, before asserting.
- Two tabs: B now revalidates while idle, before its held mutation. The test waits for B's `/api/account` refresh before it asserts that B kept its own account.
- Admin 503: the fixture now starts with the overview loaded and asserts it is present. The wipe assertion is therefore meaningful.
- Lower-severity fixes: the signup test now also asserts that exactly four questions were shown, so a skipped question fails it. The dead code in `tests/browser/ui-chaos.mjs` is removed. `islands-chaos.mjs` now uses a deterministic fixture IP instead of `Math.random`.
- Reruns after these changes: `ui-chaos.mjs` passed 3 of 3 runs. The e2e `ui-chaos` and `ui-chaos-contention` suites passed 3 of 3 runs (22 tests each). `islands-chaos.mjs` passed 1 of 1 run. The duplicated islands harness remains; extracting it would touch `islands-embed.mjs`, which another domain owns.
