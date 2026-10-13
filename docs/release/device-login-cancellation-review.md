# Device sign-in cancellation and late poll review

Status: narrow backend fix implemented locally; independent review and human release decision are separate. Production remains gated.

Human reviewer: __________  Date: __________  Outcome: __________

## Finding and scope

Before this change, `DeviceLogin.poll` marked a request consumed before loading the owner account and issuing a session. `cancel` returned `{cancelled:false}` for consumed requests. An approved poll paused after consumption could therefore finish issuing a valid shared-TV session after the user pressed Cancel. An already issued session also survived cancellation. This required the original browser secret/binding and an explicit, recent authenticated phone approval; it was a cancellation/privacy defect, not a phone-approval bypass.

The HTTP adapter installs an HttpOnly session cookie from an authorized service result. Ignoring stale JSON in frontend state cannot revoke that server session or undo a browser-managed response cookie. This review does not claim that aborting fetch always installs or always suppresses a cookie; a real browser timing test is a separate integration gate. No production account/session actions were performed.

Owned implementation is limited to [device-login.mjs](../../packages/identity/device-login.mjs) and [focused cancellation tests](../../tests/device-login-cancellation.test.mjs). Existing origin, CAPTCHA/start admission, device-secret hash, requesting-browser binding, phone confirmation, approving-session validation, session expiry and single-consumer checks remain. No ordinary authenticated-request lookup was added. Frontend cancellation/status work has separate ownership and review in [signup-wizard-review.md](signup-wizard-review.md).

## Cross-record cancellation fence

Account and device-request records can reside in different identity shards. There is no transaction spanning both records. The fix uses their existing linearizable compare-and-swap operations:

1. Poll reads the approved owner account and validates the approving session. It prepares a new session in local memory against that one account revision.
2. Poll consumes the device request by CAS, persisting the exact prepared session hash and session ID. The raw session token/CSRF token remain absent from the request. The stored account session carries the request ID for traceability.
3. Poll saves the prepared account against its original revision exactly once. It never reloads and retries issuance after a failed account CAS. The consumed request remains nonreplayable on failure.
4. Cancel first marks the request cancelled by CAS. For a linked consumed request it then removes only the recorded session hash from the immutable approved owner account. It always commits an account revision advance, including when the target session is absent.
5. If cancellation commits that account fence first, the pending poll save fails. If poll saves first, cancellation removes its session. Only acknowledged cleanup/fencing returns `{cancelled:true}`. Cancellation CAS retries and account cleanup retries are bounded at four each.
6. After its save, poll rereads the request. Cancellation observed there triggers targeted compensation and an access-denied result. If a late authorized HTTP response races after that read, successful cancellation has still invalidated its token server-side.

A late invalid cookie can still overwrite another cookie in the same browser; this is a client availability concern, not a surviving authorized TV session. Clearing an arbitrary current session cookie or revoking unrelated sessions would be an incorrect substitute for targeted cancellation.

## Failure and retry limits

A crash after the request becomes cancelled but before account cleanup cannot produce a successful cancellation response. A retry of the same bound cancellation completes cleanup. A lost acknowledgement after durable cleanup likewise yields an error and can be retried safely. Poll's post-save check also attempts compensation when it sees cancellation. No background reconciliation queue is claimed; until cleanup/fencing succeeds, an earlier issued session may still be valid. Frontend must preserve uncertainty on error/false results rather than claim that request expiry revokes an issued session.

Cancellation intentionally remains possible after request expiry when the caller still possesses the original binding and secret. HTTP binding cookies normally expire after five minutes and a newer start replaces the binding; losing it prevents this cancellation path. Existing authenticated session management on the approving device is the fallback. Device-request expiry does not shorten an already issued session's normal expiry.

A missing owner account needs no revocation: the stale account CAS cannot recreate a deleted account. Concurrent unrelated session creation/revocation is preserved through reload and exact-hash filtering during cleanup. Account repository failures propagate instead of becoming false success. Legacy consumed records lacking a session link return `{cancelled:false,reason:'session_not_linked'}`; there is no guess by label/source and no blanket logout.

## Local evidence and release gates

The original race was reproduced with actual `IdentityService`/`DeviceLogin` and isolated in-memory linearizable CAS repositories. The resumed poll returned an authorized token accepted by the real session validator after cancellation returned false. No raw tokens were printed.

The new deterministic tests exercise cancellation before the prepared account save (target absent), after session save before response, and after authorized response; bounded cleanup conflicts; lost storage acknowledgement; retry after request expiry; duplicate and legacy cancellation; binding/origin/secret rejection; account deletion; and concurrent unrelated session preservation. They check resulting tokens using `IdentityService.authorized`, not frontend state alone. Existing identity tests cover explicit account/code approval, one consume winner, denial/expiry, revoked phone sessions and session-store conflicts.

Focused tests: 9 passed, 0 failed. Full `npm test`: 637 passed, 0 failed (local log `/tmp/bindle-device-cancellation-tests.log`). Independent agent review of the frozen backend diff found no blocker and independently reran the nine focused tests successfully; its evidence is recorded in [signup-wizard-review.md](signup-wizard-review.md). This is not human release approval. Actual Worker and browser races remain coordinator-owned integration checks; local CAS tests are not production transport evidence.

Decision reviewer: __________  Date: __________  Outcome: __________
