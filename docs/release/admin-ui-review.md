# Admin console UI review

Date: 2026-10-14. Scope: the boot and administrator console (`apps/web/src/admin-entry.mjs`, `admin-console.mjs`, `bl/admin-*.mjs`, `ui/admin-*.mjs`, `providers/admin-*.mjs`, the admin CSS, Spanish strings) and the narrow backend additions in `packages/identity/admin.mjs`, `packages/runtime/admin-http.mjs` and `packages/core/abuse-policy.mjs`. Design: [boot-and-admin](../architecture/boot-and-admin.md).

Two independent agent reviews were run: one on security (privilege surface, data leakage, CSRF and step-up) and one UX red-team review (accessibility, responsiveness, copy, state bugs). Both are agent reviews. They are not human sign-off.

Human reviewer: __________ Date: __________ Outcome: __________.

## Security review

The review found no critical or high findings.

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| S1 | A boot sign-out could fail silently: logout swallowed errors, and the cookie was cleared only on success. Anyone could trigger a revision conflict through `boot/login/begin`. A reload then reopened the console. | Medium-low | Fixed. `/api/admin/boot/logout` always clears the boot cookie (409 if the server-side revocation failed). `bootLogout` retries on conflict. The UI shows `logout_unconfirmed` instead of "signed out". Covered by tests. |
| S2 | An administrator's step-up stamps the whole account session and outlived the console. | Low | Fixed. `POST /api/admin/step-up/end` (`AdminService.endStepUp`) withdraws `stepUpAt`. "Leave administration" calls it, and so does a best-effort keepalive request on `pagehide`. Tested. |
| S3 | Admin console data had no local expiry. | Low | Fixed. `Tick` drops all admin console data once 15 minutes have passed since the last step-up, then re-enters the console, which asks for a new step-up. Tested. |
| S4 | `boot/session` returns the boot CSRF token to the cookie holder. The real defence is the exact Origin plus a SameSite=Strict cookie. | Info | Accepted and documented. A per-IP rate limit on it remains a possible hardening step. |
| S5 | Passkey-only administrator step-up is enforced only at the route. | Info | Mitigated. A test asserts that `IdentityService.stepUp` has exactly one call site, the passkey-only admin route. |
| S6 | Back/forward cache showed a blank, torn-down page. | Info | Fixed. On `pageshow` with `persisted`, the page reloads. |

The reviewer confirmed as sound:

- Ordinary accounts and anonymous visitors never load `admin-console.mjs`.
- Admin modules are excluded from the service-worker precache.
- The boot token, challenges and CSRF tokens are held only in memory.
- The claim link is validated against the origin and shown once.
- Generation-based stale-response dropping works.
- The actor header is explicit.
- Retry after step-up happens once.
- The option helpers match the server rules.
- `bootEnd` and restore interact correctly.

## UX red-team review

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| U1 | Focus was lost when the step-up dialog offered only a password. | High | Fixed. The password field now carries `data-autofocus`. |
| U2 | The capability class saved on `change`, and the select went stale after a cancel. | High | Fixed. Each row has an explicit "Save class" button. The select is re-keyed by class, catalog revision and modal state. |
| U3 | The reveal copy said "Shown once" while a "Retrieve link" button was offered, and it pointed to roles "above" that were not shown. | High | Fixed. The copy now reads "Copy it now… only boot or the minting administrator can retrieve it again". The panel lists the claim's roles and badges. |
| U4 | Phase changes (expiry, sign-out, end) did not move focus. | Medium | Fixed. On any phase change, focus moves to `#admin-heading`, and the reason appears in the alert region. |
| U5 | Session expiry was not prominent, and the banner was not sticky on phones. | Medium | Fixed. In the last 5 minutes, a red "Session ends in…" warning shows. A compact sticky banner shows at ≤760px. |
| U6 | Navigating during an in-flight mint lost the reveal. | Medium | Fixed. Navigation is ignored while an operation is busy. The reveal is kept while the user stays on Claims, and the mint result switches to Claims. |
| U7 | Boot setup cleared both passwords on any failure. | Medium | Fixed. Password fields are no longer cleared on submit; they disappear only with the screen. |
| U8 | Muted text contrast was below AA in light mode. | Medium | Fixed for the admin scope (`--muted:#56645c`). The global token is unchanged. |
| U9 | Spanish: a missing string, "a las" used with full date-times, and "Termina en" for "Finish within". | Medium | Fixed. The string was added, the wording now uses "el {time}" or "hacia el {time}", and the phrase reads "Completa la configuración en menos de {time}". |
| U10 | The alert region could be announced twice. | Low | Fixed. `aria-live` was removed from the wrapper. |
| U11 | The countdown's `aria-label` hid its content. | Low | Fixed. The countdown now uses `aria-labelledby` pointing to the countdown text. |
| U12 | The step-up dialog stacked its buttons and gave no reason for appearing. | Low | Fixed. The buttons sit in one row, and the dialog explains that loading the console needs confirmation and that the action continues afterwards. |
| U13 | The confirm dialog lacked `aria-describedby`, and "Delete this role?" did not say how many accounts hold the role. | Low | `aria-describedby` was added. The holder count is deferred: the console has no bounded way to count holders. |
| U14 | Controls disabled while busy can drop focus. | Low | Deferred. This matches the existing console convention. |

The reviewer flagged two screenshot defects, both from screenshots taken before later CSS changes. The "Boot" pill rendered oversized because the `.boot` class collided with an existing rule; it was renamed to `actor-boot`. Administrators saw a disabled "Save badge classes" button; it is now hidden. The screenshots were re-taken in `artifacts/browser/admin-*.png`.

## Additional hardening (coordinator request)

`POST /api/admin/boot/begin` is now rate limited through the existing abuse policy (`operation:'boot-begin'`):

- 5 per minute and 20 per hour for each IP pseudonym.
- 200 per hour globally.

Tests cover it in `tests/boot-admin.test.mjs`.

## Remaining gaps

- `/api/config` still derives `tokenOnboardingEnabled` from static `ONBOARDING_ENABLED` alone. Admin-minted claims are admitted on the server, but the onboarding UI refuses them until `packages/runtime/http.mjs` adds `||env.ADMIN_CLAIMS_ENABLED===true` at the two `tokenOnboardingEnabled` sites (owned by the mounting agent). The e2e test shims only this config flag and records when it did.
- The onboarding namespace still binds claims that were never used or have expired. `identity-shards` needs a narrowly scoped release of expired `preissued` reservations that have no binding (coordinator decision; not implemented here).
- The admin suspension lifecycle freeze is described in the UI copy as the coordinator's decision. The backend still sets identity status only. The account-controller freeze is not wired.
