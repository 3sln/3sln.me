# Independent browser background failure diagnosis

Date: 2026-10-14. Source/diagnostic review only; frozen assets `d0894d61d7781b92e3cf` were not rebuilt. No runtime or frontend source changes were made.

The initial broad run reported all six message-submission subcases passing, followed by a file-level unhandled rejection attributed to the `before` hook. A temporary `/tmp` preload logged the rejection stack without catching the promise, changing exit status or suppressing the test runner's failure. One focused local Node/browser run passed 7/7; the next reproduced the original failure while retaining all seven passing test assertions and a failing file result.

Evidence: `/tmp/bindle-submissions-late-assertion-permitted.log` (clean focused run), `/tmp/bindle-submissions-late-repeat-1.log` (reproduction and stack). The initial restricted execution stalled and was terminated; it is not counted as a passing run. Tests use genuine local Node identity/SQLite/HTTP/browser behavior, controlled external transport and disabled service workers, not live egress or production accounts.

## Actual failure

The captured stack starts in Playwright's `assert`, then `FrameManager.frameAttached` (`node_modules/playwright-core/lib/coreBundle.js:24475`), `_FrameSession._onFrameAttached` and the Chromium CDP session event handler. The violated invariant is that a child frame ID must not already exist in Playwright's frame map when it receives an attachment event with a known parent.

The rejection occurs during the transition after the `status` subcase, before the `error` subcase completes. The test runner reports it after the file's tests because the browser's asynchronous event infrastructure originated in the `before` hook. That attribution does not establish a SQLite teardown error or a failure after account storage closed.

Installed Playwright is 1.64.0. Its local browser manifest selects Chromium 156.0.8078.4, revision 1248; that bundled executable is absent. The repository helper instead selects installed system Chrome when present (Chrome 155 in the existing browser evidence). This version difference and rapid opaque `srcdoc` frame transitions are plausible contributors, not independently proven root causes of the duplicate event.

## Concrete next checks

1. Run the unchanged case against the matching Playwright-managed Chromium, if installed under the coordinator's direction. Keep system Chrome evidence separately identified.
2. Alternatively, test an explicit user Close action between cases and await renderer-frame detachment before opening the next message. This separates independent case lifecycles without removing native pointer, sandbox, cookie-free dispatch, history or unknown-result assertions. It does not prove that rapid switching is fixed.
3. Keep any remaining automation rejection fatal. Do not swallow `Assertion error`, patch Playwright's invariant, weaken frame isolation or call a clean retry a fix.

Source inspection separately found that `SqliteMetadata.close()` clears a scheduled timer but does not drain an already executing asynchronous alarm. An alarm catch path can attempt another database read after close, and that recovery attempt has no outer rejection handler. This is a distinct potential shutdown race; the captured browser failure does **not** implicate it. A proper separate fix would stop admission/rearming, track and drain in-flight alarm/background tasks before closing SQLite, preserve persisted future alarms, and test both normal completion and failure during shutdown. Simply swallowing all database errors would hide faults.

## Pinned-browser follow-up

The coordinator installed Playwright's matching Chromium and changed the shared helper to prefer that pinned executable. Independent binary verification reports **Google Chrome for Testing 156.0.8078.4**. Three unchanged focused runs retained the temporary stack-only diagnostic: runs 1 and 2 passed **7/7** each; run 3 again passed the six submission subcases but failed the file on the same duplicate child-frame attachment assertion. Logs are `/tmp/bindle-submissions-pinned-repeat-{1,2,3}.log`. Consequently the browser-version difference alone does not explain or fix the intermittent failure; a single clean integrated run must not be described as resolving it.

The separate Node alarm change was independently source-reviewed and its two focused tests passed **2/2**. A closed flag and idempotent close prevent post-shutdown alarm recovery reads/rearming, while an open alarm failure retains its normal retry. This is a narrow rejection/lifecycle fix: close remains synchronous and does not drain in-flight work, and an alarm already claimed/deleted before its callback is not guaranteed to complete or persist a retry during shutdown. It does not fix the captured Playwright assertion.

## Assessment of the next fixture ordering

Using the installed Playwright-managed headless shell and an explicit normal Close action between independent message cases is a reasonable diagnostic/fixture change. Waiting for real frame detachment describes an observable lifecycle boundary, unlike arbitrary sleeps or ignoring the driver assertion. Keep the native history pointer and original/result replacement checks inside the HTML case, together with all cookie, authority, external-network, result, replay and send-count assertions.

Closing before reloading the unknown-result case narrows that check to reload after closing the detail. Preserve explicit unknown replay/no-resend checks and reopen the same message after reload when possible; do not describe this as testing reload with an active unknown-result frame. Rapid direct switching and reload while a frame remains open remain separately unverified if excluded from this gate. These are assessment criteria, not evidence that the proposed changes have passed. No product change or sandbox relaxation is warranted solely to avoid an automation invariant failure.

## Headless-shell and explicit Close evidence

After the coordinator changed the helper to Playwright's default pinned headless shell and added real Close/frame-detachment boundaries, independent version output remained **156.0.8078.4** (`/tmp/bindle-submissions-shell-version.log`). Three diagnostic runs retained unsuppressed rejection reporting. Runs 1 and 2 passed **7/7**. Run 3 had no frame-attachment assertion or unhandled rejection, but failed the status subcase because `response.json()` could not retrieve its body through CDP: `Network.getResponseBody: No data found for resource with given identifier`. The other five subcases passed; the file correctly failed. Logs: `/tmp/bindle-submissions-shell-repeat-{1,2,3}.log`.

This is not a clean stability gate. It establishes absence of the previous assertion in these three runs, not a general fix. The proposed next diagnostic is a test-only observer of the actual page fetch response using a cloned body, preserving the original response and every real submission/cookie/pointer assertion while avoiding delayed CDP body retrieval. It must not replace the real request with a fixture response, resend it, suppress errors or alter production behavior.

## Stabilized independent-case gate

The coordinator added a narrow test-only fetch observer for the real message-postback response. It reads a clone asynchronously and returns the original response; it does not synthesize a response, repeat a request or wait for clone parsing before returning the response to the application. The fixture still observes the actual HTTP response status/URL, checks the captured body's matching status/URL and absence of parsing errors, and retains native pointer/history, cookie/header, source-preservation, replay and server transport-count assertions.

Independent reruns on the pinned headless shell **156.0.8078.4** passed **three consecutive runs of 7/7** (21/21), with the stack diagnostic retained and no suppressed rejection, CDP body error or HTML frame timeout. Evidence: `/tmp/bindle-submissions-observed-repeat-{1,2,3}.log`. No product, sandbox or build changes were made by this review. This supports the stabilized independent-case gate; it does not establish a fix for the previously excluded rapid-switch/reload-open automation path. The coordinator owns the subsequent full browser suite.

| Human reviewer | Date | Decision |
| --- | --- | --- |
| | | |
