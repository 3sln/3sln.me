# Bindle / 3sln.me

An open, contract-based personal identity and resource system, with a Cloudflare-hosted reference app and an unbranded self-hosted runtime. Bindle is the provisional ecosystem name. Protocols and published artefacts are implementation drafts; the production service is **not release-ready**. Decisions, human review checkpoints and remaining work are recorded in [DEVLOG.md](DEVLOG.md) and [release-status.json](release-status.json).

## Run locally

Use Node 24 and install dependencies:

```sh
npm ci
npm run dev:worker
```

Open http://localhost:8787. Local Wrangler uses Durable Objects and R2 simulators; the explicit local configuration permits a test CAPTCHA token. Never deploy `wrangler.local.jsonc`.

The same portable application also runs on Node:

```sh
npm run dev:node
```

Open http://localhost:8788. The Node adapter persists SQLite metadata and private blob/archive files under `.data/`. Back up its encryption key with the data. This adapter supports a single process; public proxy trust and distributed deployment need additional work. See [self-hosting](docs/self-hosting.md).

`npm run dev:demo` retains the older unauthenticated in-memory consent demonstration on port 3000. It is separate from the current authenticated application.

## Current implementation

The app has real WebAuthn/passkey and optional Argon2id-password login, multiple passkeys, revocable sessions, device/TV approval, mandatory encrypted recovery files, signed contact endpoints, bounded blob messaging, owner read/classification/rules, notification preferences, and storage adapter seams. Recovery files combine every selected typed answer into an Argon2id-derived AES-GCM key; readable questions/hints and the risk of guessing personal information offline are explained in the [recovery specification](docs/spec/recovery-file.md).

Static code contributions provide portal views, navigation, commands and contextual user-overridable keybindings. UI localization uses `@3sln/bab`; user content remains unchanged. The front end follows the 3sln stack's injected providers, named Actions, Query projections and pure UI factories. Vendored dependencies retain licenses and provenance.

Hosted email uses Cloudflare's send binding, disabled until domain onboarding and delivery verification. [Email setup and sender addresses](docs/deployment/email.md). Provider OAuth, complete federation/preferences interoperability, hosted notification dispatch, rich archive asset rendering, production bot controls and requested account-deletion policy remain release work. Capability flags report unavailable services honestly; screenshots are not evidence of working external providers.

## Verification

```sh
npm test
npm run test:worker
npm run test:ui-state
npm run test:dom
npm run check:worker
npm run test:e2e
```

Browser checks run against a fresh local Wrangler instance and use actual Chrome/Chromium with virtual authenticators, maintained key derivation, isolated persistence and adversarial recovery tests. `npx playwright install chromium` installs a browser when a local Chrome is unavailable. `.mcp.json` also configures Chrome DevTools MCP.

`tests/spikes/coop-opener/run.mjs` is a retained manual browser spike (COOP/opener behavior across Chromium and Firefox, results in [docs/release/coop-opener-spike.md](docs/release/coop-opener-spike.md)); it is not part of any gate. Islands and element suites that also use Firefox (`tests/browser/islands-embed.mjs`, `islands-sw.mjs`) run from `npm run test:e2e`; `tests/browser/embed-elements.mjs` and `provider-matrix.mjs` are run manually with `node --test`.

[Specifications](docs/spec/protocol.md), [module development](docs/modules.md), [independent audits](docs/release/) and the screenshot walkthrough live under `docs/`. The assets build publishes semantic HTML and Markdown documentation, machine-readable artefacts, `llms.txt` and an accessible landing page.

The GitHub publish workflow is manual and enforces the release gates. Main pushes run checks and do not deploy.
