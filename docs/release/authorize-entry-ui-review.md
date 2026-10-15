# Authorization entry UI (slice A7): review record

Status: provisional, local evidence only, 2026-10-14. Sign-off: reviewer ___ / date ___ / outcome ___ (unsigned; nothing here is approval).

Scope: the provider page for `authorization_endpoint?entry=<id>`. Sources:

- Page logic: `apps/web/src/bl/authorize-entry{,-embed,-arming,-page}.mjs`
- UI: `apps/web/src/ui/authorize-entry{,-consent}.mjs`. The consent kit is extracted unchanged from `apps/web/src/authorize.mjs`, which now uses it.
- Strings: `packages/i18n/authorize-catalogue.mjs`

Design sources:

- `docs/architecture/adaptive-app-sign-in.md` (rev 2): §5, §7.3–7.4, §9, §10.2, §13.2
- `docs/release/coop-opener-spike.md`
- `docs/architecture/multi-account-sessions.md` and `docs/architecture/multi-account-ui.md`

Two independent reviewers looked at this slice, one for security and one as a UX red team. Both read the code; neither edited files.

## What is implemented (local behaviour)

- **Intents:**
  - **login and select-account:** a chooser over this browser's validated members (`GET /api/auth/accounts`). Each account has a one-click "Continue as …". For identity-only entries, that click is the decision, and the disclosure sits next to it.
  - **reauthenticate:** lists only the constrained subject. `maxAge` is enforced by the server. A `reauthentication_required` response leads to a fresh sign-in, then continue.
  - **end-session:** an explicit confirmation that names the account. The app gets back only `result=completed` or `result=canceled`.
- **Consent:** requests with fragments reuse the existing consent screens.
- **Owner steps:** every owner request names its member (`X-Bindle-Account` and `X-Bindle-Session-Context`) and carries that member's own CSRF token, read from `/api/session` with the member headers. The console's default member is never switched.
- **Presentations:**
  - App-opened popups and redirects are COOP-isolated. The code goes to the registered callback, after exact URI validation (D7).
  - Frame-initiated entries show nothing, and fetch no account data, until the opener-key handshake succeeds.
    - Bridge messages go only to `window.opener`, with `targetOrigin` set to the embed origin. That origin comes from the entry view, or else from the manifest components profile.
    - When the frame acknowledges, the popup closes. With no acknowledgement, the code alone goes to the callback: the claim is dropped and the opener is nulled.
    - With no proof, the page runs `location.replace(&mode=plain)`.
- **Clickjacking defences:**
  - The server sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The client also checks `top !== self`, plus a sandbox probe, before making any request.
  - Approval buttons use a 600 ms delay-to-arm. The page must be visible and focused. Trusted events only. The press must start while armed. Arming resets on blur, hide, width resize and every change of decision surface or account set. Approval buttons are `aria-disabled` until armed and never take default focus.

## Findings and dispositions

| # | Reviewer | Finding | Disposition |
|---|---|---|---|
| S-1 | Security (M) | Account rows that load or refresh late appeared already armed. | **Fixed:** the arming key includes the account set, session contexts and busy state. |
| S-2 | Security (M) | A press that started before arming counted once released. | **Fixed:** a trusted pointerdown or keydown must happen while armed, and each press activates once. The notice region moved below the controls so a notice cannot shift them. |
| S-3 | Security (L) | Anonymous cancel and end-session sent cookies. | **Fixed:** these requests use `credentials:'omit'`. |
| S-4 | Security (L) | A back-forward-cache restore showed a dead page. | **Fixed:** a persisted `pageshow` reloads. |
| S-5 | Security (L) | The embed fallback navigated with the opener still attached. | **Fixed:** the opener is nulled first. The 3 s acknowledgement wait is kept, per §7.4. A late acknowledgement can still race the fallback, which gives one code and no claim; recorded as residual. |
| S-6 | Security (L) | `javascript:` and `data:` callbacks matched themselves. | **Fixed:** callbacks must be `https:`, or loopback `http:`. |
| U-1 | UX (H) | Height-only (URL-bar) resizes disarmed approval while scrolling. | **Fixed:** only width changes re-arm. |
| U-2 | UX (H) | Early taps were dropped silently. | **Fixed:** a polite notice says "Ready in a moment. Select the button again." |
| U-3 | UX (H) | Reauthentication was a dead end. | **Fixed:** dedicated copy ("choose Add account and sign in again as …"), with the action "I've signed in again, continue". |
| U-4 | UX (H) | Trust signals were weak. | **Fixed:** "App website: host" plus the full origin appear under the heading on every screen. The consent heading names the app. |
| U-5/6 | UX (M) | A focus box appeared on load, and layout items collided. | **Fixed:** focus moves only after user interaction. The disclosure moved above the sign-in section. "Check again" is a plain text button. |
| U-7 | UX (M) | `window.open` with `noopener` hid a blocked popup. | **Fixed:** sign-in is a real `target=_blank rel="noopener noreferrer"` link. |
| U-8/9 | UX (M) | Signing in as the wrong account gave no feedback, and "Check again" reported no result. | **Fixed:** a "signed in, but not as the requested account" hint (a boolean only), and "Check again" reports its result. |
| U-10/11 | UX (M) | The "identity ID" wording was jargon, and the Spanish duration grammar was wrong. | **Fixed:** wording updated, and the Spanish now uses "hace menos de {duration}". |
| U-12–14, 17–18 | UX (L) | Repeated host in end-session, duplicated handles, bidi marks in the title, live regions. | **Fixed:** end-session heading is "Sign out {account}?". The duplicate handle label is gone. The title is plain text. There is one persistent live region. |
| U-15 | UX (L) | The entry's `uiLocales` is ignored. | Open: the page uses the stored preference or the browser language. |
| U-16 | UX (L) | The "Bindle · Your provider" brand text is hard-coded. | Open: kept the same as the existing consent page. |

## Server gaps (not fixable in the page; owners: A3, the multi-account session work, and the adapters)

1. **Security reviewer S1 (high): pre-consent probe.** The entry's `decide()` deny path trusts the unverified owner prefix of the cookie. Its responses also differ depending on whether an account has been selected. The nonce and the entry ID are known to the app. An app backend could therefore learn, before consent, whether and as whom the user chose an account.
   - Fix: anonymous cancel always returns the same generic denial.
   - Authenticate the session and its CSRF token before using any owner value.
   - Treat the nonce as public.
2. **Anonymous CSRF.** The decision and end-session routes only require a non-empty `X-CSRF-Token` plus an exact `Origin`. The page sends the entry nonce as that token, and the server should define this.
3. **End-session.** Neither adapter has an `endSession` hook, so the Worker refuses end-session entries. The e2e test checks the page against a simulated route. A future hook must verify the member session and its real CSRF token.
4. **Sign-in inside the popup.** The entry CSP forbids Turnstile, so sign-in happens in a console tab. The console has no `return_to` for `?entry=` and no add-account deep link (`apps/web/src/providers/browser.mjs`).
5. **One click only for identity-only entries.** The request view has no "already approved for this client" signal, so returning apps that request fragments always see consent.
6. **No fresh-authentication binding.** Freshness cannot be bound to the entry: `maxAge` is compared with the session's creation time, so `maxAge: 0` can never succeed.
7. **Embed origin in the entry view.** The entry view should carry `embed.origin`; today the page reads it from the manifest profile. `client.name` has no length bound, and anyone holding an entry ID can use up its 3 handshake challenges.
8. **Islands and loopback HTTP.** `apps/embed/src/boot.mjs` refuses a non-HTTPS issuer, so the real island shell is inert against the loopback Worker. The e2e test drives the shipped `bridge.mjs`, `keys.mjs` and `restore.mjs` from a fixture document on the real embed origin instead.

## Evidence (2026-10-14, local)

- `npm test`: 1099/1099 pass.
- `npm run test:ui-state`: 182/182 pass, including `tests/browser/authorize-entry.mjs` (12 tests).
- `npm run build:assets` passes.
- `E2E_AUTHORIZATION_ENTRIES=1 node scripts/run-browser-checks.mjs tests/e2e/authorization-entry-ui.test.mjs tests/e2e/authorization-entry.test.mjs`: 7/7 pass on Chromium, real Worker. Covered:
  - app-initiated popup with one click and nothing disclosed before approval;
  - redirect at phone width in dark mode, and cancel;
  - reauthentication with `maxAge`;
  - end-session against a simulated route;
  - frame-initiated delivery only to the embed origin, plus an app-opened embed entry falling back to plain mode.
- `tests/e2e/federation.test.mjs` (the legacy consent page, now using the shared kit): 4/4 pass.
- Not run: Firefox, WebKit and mobile engines; third-party-cookie and partitioning variants.

The new e2e file is not yet in the default list in `scripts/run-browser-checks.mjs`, which this slice does not own.
