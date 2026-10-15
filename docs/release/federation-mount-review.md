# Federation, embed origin and admin mount: security review

Date: 2026-10-14. Target: the uncommitted root mount in `packages/runtime/http.mjs`, the Worker and Node composition (`apps/worker/{index,federation,objects}.mjs`, `apps/node/{server,resources}.mjs`, `wrangler*.jsonc`), the manifest and components-profile alignment (`packages/federation/{authorization-entries,components-profile,http}.mjs`, `packages/runtime/federation.mjs`), and publication of the provisional profile descriptor (`packages/core/public-contracts.mjs`, `scripts/build-docs.mjs`).

Lens: route exposure, CSP/COOP merge, flag gating, manifest truthfulness, cookie and actor confusion. One independent reviewer read the code and confirmed M1 with a proof of concept, which it then deleted.

**No human sign-off is implied.** The production gates in [security](../spec/security.md) and DEVLOG.md still apply. Production defaults are unchanged: entries need `FEDERATION_ENABLED` and `FEDERATION_ENTRY_ENABLED`; the embed origin also needs a valid `EMBED_ORIGIN`; administration needs `BOOTSTRAP_TOKEN_SHA256`, or `ADMIN_ENABLED=true` after boot.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| ___ | ___ | ___ |

## What was mounted

- **Embed origin:** routed before the app-origin check. It serves `/embed` (a per-client shell, or a constant inert page), `/embed/assets/*`, `/embed/sw.js` and `/embed/api/*`, which goes to `handleEmbedAPI`. Shell and API requests pass IP and subnet admission. Every other path returns 404. The embed origin sets no cookies and sends no CORS headers. Shell headers follow [components profile §3](../profiles/components-v1.md):
  - `frame-ancestors` lists the client's redirect-URI origins, or `'none'` for unknown clients;
  - `script-src 'self'` and Trusted Types `bindle-embed`;
  - `private, max-age=300`, a strong ETag, `Origin-Agent-Cluster`, COEP `require-corp` and CORP `cross-origin`.

  The islands build (`apps/embed/**`, another agent) is not present yet. Until `/embed/shell.html` is built, known clients get the inert page with `no-store`.
- **Authorization entry:**
  - `handleAuthorizationEntry` runs ahead of `handleFederation`, after the existing federation IP admission. It uses the caller's IP pseudonym as `remote`.
  - Owner context comes from the tab's multi-account member cookie, with the legacy cookie as fallback.
  - The entry document goes through `securePage(brandPage(), {keepPolicy:true})`. The handler's CSP (`frame-src 'none'`) and COOP survive; only the build's import-map hash is added to `script-src` (F7).
- **Composition:**
  - Worker: one global entry store, the `FederationObject` instance `bindle-federation-v1/authorization-entries`, with a role marker that excludes owner shards, and alarm `cleanup()`.
  - Node: `federation/authorization-entries.sqlite`, with an alarm.
  - Neither adapter has a session-ending hook, so end-session is forced off and never advertised.
- **Manifest (F8 and components profile S1/S2):**
  - `features["authorization-entry.v1"]` appears only when `FEDERATION_ENTRIES` is mounted.
  - `profiles["https://3sln.me/artefacts/profiles/components/v1"]` (`embed_origin`, `protocol`, `parts`, `credential_binding`) appears only when the embed routes are mounted, DPoP is configured and the shell is built.
  - `features["intents.v1"]` stays as before.
  - No flat draft members remain. The core authority manifest no longer advertises entries by itself.
- **Admin:** `adminRoutes` sits inside `/api/` after the identity context is built. The onboarding gate becomes `onboardingEnabled || ADMIN_CLAIMS_ENABLED`. The Worker has an `AdminAuthority` Durable Object with migration tag `v6`; Node has `admin.sqlite`. Both adapters share one identity resource set, with `reservedHandle` and `runtimeName` wired in.
- **Registry:** the components descriptor is published as a provisional `manifest-profile` at `/artefacts/profiles/components/v1.json`. Its source stays beside the decision note until sign-off.

## Findings and resolution

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| M1 | Low (PoC) | The owner-context resolver selected the **default** member for header-less writes. A header-less consent or entry decision could therefore target the default account rather than the tab's account, unlike the `/api/` rule. The resolver also decrypted cookies on token and RPC routes. | **Fixed.** When a vault is present, a header-less write is anonymous, so owner steps fail closed. Cookieless requests skip cookie work. `apps/web/src/authorize.mjs` now sends `X-Bindle-Account` and `X-Bindle-Session-Context`. The real-browser federation suite covers the consent page. |
| M2 | Low | With the entry flag on, the manifest advertises `authorization-entry.v1`, but the provider UI (`authorize.mjs`) cannot yet complete `?entry=`. The browser half of F6 (popup `targetOrigin` checks) is also missing. | **Open, accepted as a release gate.** `FEDERATION_ENTRY_ENABLED` stays off outside local tests until the entry UI and the F6 browser evidence land. The HTTP slice itself is verified in a real browser (see Evidence). |
| M3 | Low | Once the islands build emits `/embed/*`, the app origin's asset fallthrough would serve island code under the app origin. | **Fixed.** `/embed` and `/embed/*` return 404 on the app origin. Test added. |
| M4 | Low | `EMBED_ORIGIN` accepted `http:` and IP literals. A malformed value threw inside Worker `resources()` and took down every request. | **Fixed.** HTTPS without an IP literal is required, with loopback allowed only under `LOCAL_DEVELOPMENT`. An invalid value disables components instead of throwing. Test added. |
| M5 | Low (availability) | Every entry operation, including unauthenticated document loads for random IDs, goes to one global Durable Object. The controls are the federation read lanes (120/min per IP) and the entry budgets. | **Accepted for now.** Follow-up: answer unknown IDs without a store call (for example with a MAC'd entry ID) and shard per client. |
| M6 | Info | `/api/admin/*` and runtime-name onboarding were mounted whenever the admin binding existed, even without `BOOTSTRAP_TOKEN_SHA256`. `boot/begin` sets a setup cookie with no rate limit. | **Fixed for gating.** Admin is mounted only when boot is configured or `ADMIN_ENABLED=true`, on both Worker and Node. Test added. **Open:** rate-limiting `boot/begin` belongs to the owner of `admin-http.mjs`. |

Fixed during integration, before the review: browsers omit `Origin` on same-origin GETs, so the entry `view` route would have refused the provider page. The check now requires `Sec-Fetch-Site: same-origin` when `Origin` is absent on a GET. POST still requires the exact Origin. Test added.

## What held (reviewer)

- Embed-origin isolation: no path reaches app routes, cookies or CORS. `run_worker_first` keeps the asset layer behind the Worker. Node answers only the exact embed host.
- `keepPolicy` is reachable only from the entry handler's HTML response.
- `/oauth/revoke` is advertised and mounted. End-session is never advertised.
- Entry selection and decision check `selection.owner`, and the owner shard checks again.
- The admin actor must be named explicitly. The boot cookie is parsed only by `admin-http.mjs`.
- Owner and entry roles exclude each other in `FederationObject`.

## Evidence

- Results on 2026-10-14:

  | Check | Result |
  | --- | --- |
  | Browser gate (`npm run test:e2e`) | 84/84 portal, 4/4 federation, 2/2 authorization entry |
  | `npm test` | 1076 of 1078 pass. 1 failure: `tests/islands-worker.test.mjs`, which belongs to the islands agent. |
  | `npm run test:worker` | 49/49 |
  | `npm run test:ui-state` | 168/169. 1 failure: `contact-links` foreign-provider copy, which belongs to the links agent. |
  | `npm run check:worker` (dry run) | Passes, with the `ADMIN_AUTHORITY` binding |
 `tests/federation-mount.test.mjs` covers F7, F8, the embed shell contract, flag gating, the Worker facade, Node composition and admin gating.
- Real browser against the local Worker, in `tests/e2e/authorization-entry.test.mjs`, run by the browser gate in its own Worker with the entry flag and a loopback embed origin:
  - cookieless CORS creation;
  - entry document CSP and COOP, with no CSP violations;
  - selection and decision through member cookies;
  - PKCE code exchange;
  - single use;
  - per-client `frame-ancestors` framing, the inert page for unknown clients, and refusal of the cross-site embed API.
- Not verified: the islands shell itself (not built), FedCM, the browser half of F6, and behaviour on deployed Workers.
