# UI adversarial review

Review date: 2026-10-11. Automated adversarial review is engineering evidence, not human security or product approval. Human reviewer: ___ Date: ___ Outcome: ___

## Scope and evidence

The portable browser harness in `tests/e2e/` uses Playwright with actual Chromium. `E2E_CHROME` overrides the browser path, `E2E_BASE_URL` the loopback URL, and `E2E_ARTIFACTS` the artifact directory (default `/tmp/3sln-e2e`). The adversarial suite explicitly intercepts API responses to exercise failures; it does not establish that the corresponding live backend works. Actual Worker lifecycle checks are recorded separately below. No deployment or third-party account operation is authorized by these tests.

Run against a running local Worker:

```sh
node --test tests/e2e/ui-adversarial.test.mjs
```

## Findings and verification

| Finding | Risk / reproduction | Status |
| --- | --- | --- |
| Browser boot fails on space-containing class token | Real Chrome rejects dodo `.classes('button secondary')` via DOMTokenList.add. Initial UI stops rendering before auth form. | Fixed class splitting; actual Chromium regression passed. |
| Recovery result treated as authenticated session | Identity recovery clears old credentials and returns pending setup, while UI called acceptSession; user can become stranded. | Fixed; real Worker credential replacement and recovery-file rotation passed. |
| Interrupted setup discards pending capability | Reload/canceled passkey loses pendingToken; handle already reserved. | Real Worker password setup reload/resume passed after the signup response was received. |
| Stale session retains private UI | Mutation 401 only displays error with old private account data retained. | Fixed; actual Chromium fault-injection regression passed. |
| Modal accessibility | aria-labelledby references absent title; closing does not restore initiating focus. | Fixed; actual Chromium fault-injection regression passed. |
| Contact limits mismatch | UI reads nested claims while adapter returns flat expiry/quotas. | Actual UI contact creation and displayed expiry/quotas passed. |
| Message content contract mismatch | Backend returns `{message,render}` while UI reads only metadata. | Live hostile HTML delivery and readable sandbox rendering passed; no script execution. |
| Password length mismatch | UI minimum12, identity minimum15. | Aligned to15 characters. |
| Native input cleanup crashes | Dodo restored absent minLength/maxLength through rejected negative DOM setters when switching auth views or closing dialogs. | Length constraints moved to attributes; real signup and modal regression passed. |
| Mobile controls unavailable | Hidden desktop sidebar removed access to collections and sign-out. | Mobile collections and account sign-out added; browser layout regression passed. |

## Release limitations

Human usability, assistive technology, Safari/Firefox, device-native passkeys, real provider connections, delivered email/push, production Turnstile challenge handling, and published PWA installability require independent verification. A virtual authenticator verifies the browser/server WebAuthn ceremony, not a specific physical authenticator. Fault injection is recorded distinctly from live Worker results. No human approval has been fabricated.

## Verified browser evidence

- Ten adversarial browser checks passed against actual Worker-served assets: 320/390px landing layout; accessible modal name, focus trap and restoration; stale-session private-data erasure; duplicate-submit guard; offline data clearing and API-cache exclusion; missing message fields; mobile collections/modal layout. Fault API responses were explicitly injected. Native browser runtime errors fail these tests. Two added checks verified readable hostile HTML inside a sandbox with no script or outbound request, and full public-shell reload after service-worker installation while offline.
- Real Worker passkey lifecycle passed: signup with Chromium CDP virtual authenticator; server registration verification; unauthenticated state until recovery download and confirmation; downloaded file contents; session HttpOnly/SameSite cookie; logout; server-verified passkey assertion login. Turnstile uses the explicit local-development token. No production abuse-protection claim follows.
- Password signup exposed Worker dynamic-WebAssembly incompatibility in Argon2; static module integration fixed it. Real password signup, interrupted setup reload/resume, consumed recovery-file credential replacement, and new recovery-file confirmation passed. Contact signing exposed Worker-specific public JWK shape incompatibility; explicit public-only JWK fixed UI contact creation. Explicit RPC fault envelopes fixed error mapping. Real MIME restrictions, identical replay deduplication, quota exhaustion and revocation (including rejection of a previously accepted replay) all passed. Consumed recovery files cannot be reused.
- Public contact landing initially redirected to the homepage because Cloudflare canonicalized `/index.html`; root-asset fallback now preserves the landing path. The composer performs no delivery on GET and reuses its delivery key after a failed response; Chromium regression passed.
- Screenshots are kept under `/tmp/3sln-e2e/`; no recovery-file contents or contact bearer URLs are captured.

## Remaining interruption caveat

The tested reload/resume starts after a successful signup response. If the server commits signup and the response is lost before the browser receives its pending capability, the browser cannot recover that capability using the current flow. Pending-capability expiry also needs a defined user-facing restart path. These remain release considerations; the browser tests do not establish resilience to every network interruption.

## Final automated result

`node --test tests/e2e/ui-adversarial.test.mjs`: **10 passed**.

`E2E_CLIENT_IP=203.0.113.24 node --test tests/e2e/worker-flow.test.mjs`: **2 passed**, covering complete multi-step live flows. Local test metadata isolates the signup budget; this header is not a production client authority.

The real Worker test requires the explicit local configuration and refuses non-loopback targets. For repeat runs, choose a fresh documentation-range `E2E_CLIENT_IP` or use a fresh local Wrangler persistence directory; rate-limit failures remain enabled. No tests call deployment or third-party provider APIs.

Screenshots: `landing-desktop.png`, `landing-mobile-320.png`, `landing-mobile-390.png`, `dialog-mobile.png`, `offline-shell.png`, `live-passkey-inbox-desktop.png`, `live-contacts-desktop.png`, `live-resources-desktop.png`, `live-notifications-desktop.png`, `live-security-desktop.png`, `live-security-mobile.png`, `live-inert-message-desktop.png`, and `live-inbox-mobile.png`.
