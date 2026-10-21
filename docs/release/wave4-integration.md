# Wave 4 integration review

Status: provisional local integration, 2026-10-21. No production release or independent approval is implied. DEVLOG.md is intentionally unchanged at the user's direction. The existing default-off flags and [production security gates](../spec/security.md) remain in force.

| Decision | Implementation and boundary | Reviewer / date / outcome |
| --- | --- | --- |
| X6/X7 host ports | Worker and Node compose signing over the persistent brokering key store, public egress, minting and messaging describe. Node discovery/describe POSTs pin validated IPv4 addresses into TLS connections. Worker routing uses its strictly-public fetch compatibility setting plus DoH screening. Fixture checks do not establish production egress verification. | ___ / ___ / provisional |
| X8 projection stub | The snapshot port explicitly reports unavailable; X6 holds preference markers and refuses new projection marks until X8 is mounted. No preferences/v2 or severance completion is claimed. Revocation/control events and doorbells have their own mounted delivery paths. | ___ / ___ / provisional |
| EV-3 live grant check | A trusted federation-shard port checks identity, grant, read approval, exact connection generation, pinned manifest and assignment. The account-store commit checks the current connection and reader floor. Avoiding a callback into the account gate prevents subscribe deadlocks. Publish notifications, subscribe and owner resume wake X6; reader revocation cancels subscriptions. | ___ / ___ / provisional |
| X10 classifier | The canonical slot is registered, served by the local public artefact registry and shared with BindleBox. Discovery offers only a configured, explicitly assigned classifier. No automatic assignment, threshold, live model accuracy or remote publication is claimed. | ___ / ___ / provisional |
| IA-4 request island | Standard SDK registration, shell/channel/worker boot and key-attested frame-initiated incremental delivery are mounted only with the existing incremental port. Tokens/results go to the exact attested embed origin; plain fallback uses the registered callback. | ___ / ___ / provisional |
| BindleBox archive and shell | The separate default-off app serves its web client through authenticated owner operations. Archive storage uses the object-storage contract; an external key-holder port is mandatory outside explicitly enabled local tests. See [archive composition](../../apps/bindlebox/web/README.md). | ___ / ___ / provisional |

Imported signed material is checked before use, import admission is held until control state commits, and newly staged large bodies use authenticated encryption in user storage. These local checks do not establish a production key-custody or recovery arrangement. Existing historical records without a preserved signature must not be presented as verified.

Open work outside this integration scope remains X8 (projection/severance and draining), the X7 issuer-wide hint directory and AMD-C10 checks, app-initiated push configuration (Q11), and remaining conformance/release review. No external integration, production key holder, live classifier quality or delivery service is production-verified by these tests.

Local validation includes regression coverage for import holds at admission and commit, restored replay boundaries, signature/projection/body binding on archive import, ciphertext staging/tamper refusal and bounded encrypted reads, verified contact creation, Rejected text reads, timeline/revision transfer, and exact-origin incremental delivery. Actual Node and workerd composition tests sign discovery tokens and SETs through the durable brokering stores. Chromium and Firefox request-island checks cover both locales, both themes and 320/390/1440 px layouts.

| Gate | Final local result |
| --- | --- |
| `npm test` | 1,929 passed; 6 pre-existing conformance TODOs; no failures |
| `npm run test:worker` | 65 passed |
| `npm run test:ui-state` | 258 passed |
| `npm run test:dom` | Passed |
| `npm run build:assets` | Passed, including the separate BindleBox browser bundle |
| `npm run check:worker` | Passed (dry run only) |
| `npm run test:bindlebox` | 194 passed |
| `npm run test:bindlebox:web` | 41 passed |
| Full `npm run test:e2e` | 180 passed; 4 WebKit skips; exit 0 |
| Full `E2E_DEVICE_AUTHORIZATION=1 npm run test:e2e` | 180 passed; 4 WebKit skips; exit 0 |

The full e2e gates are run serially. Earlier parallel attempts encountered unexpected browser closures; isolated recovery/federation reruns and the final serial default run passed. The offline-shell assertion now checks that the added request container stays inert while disabled, and the provider-matrix check waits for asynchronous island mounting. WebKit page creation times out in this environment; Chromium and Firefox checks run normally.
