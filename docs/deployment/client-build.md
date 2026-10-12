# Client build and public cache model

The application now uses pinned `@3sln/js-tools`0.2.0 through `jstools.config.mjs` and `scripts/build-assets.mjs`. Run `npm ci` and `npm run build:assets` before local Wrangler/Node or browser checks. `dev:worker`, `dev:node` and `check:worker` build these same artifacts; local Wrangler exercises the production import-map model.

Project modules remain authored ES modules, emitted individually with content-addressed URLs. Vendored dodo/ngin/Bab snapshots remain single source graphs; absolute and relative aliases converge to the same emitted module. Only the existing browser crypto package is selected for js-tools dependency bundling. The recovery worker and external SDK entries are standalone ESM bundles because a Worker or embedding document does not inherit the portal's import map. No server adapters, identity policy, billing logic or credentials are shipped by the explicit public-source boundary.

Pinned0.2.0 emits `.mjs` files but automatically maps only `.js`, and its graph verifier does not model this app's origin-absolute imports. The adapter completes the authoritative emitted map for `.mjs` and authored public URLs, verifies the entire staged graph against that map, then regenerates bootstraps using js-tools' `wireupSource`. Source imports and module bytes stay unchanged. These compatibility steps are explicit; they are not a fork or a second application bundler.

Generated HTML references hashed styles and classic bootstraps. The bootstrap installs the import map before loading the app. HTML carries the exact import-map SHA-256; the HTTP adapter permits that hash in CSP without broad inline-script permission. Live HTML stays `no-store`. Successful `/assets/` responses are immutable for one year; changed code, CSS, worker or bootstrap content changes its URL. Stable SDK loaders use `no-cache` and forward to standalone hashed modules. Anonymous CORS is restricted to the two documented SDK loaders and their bundle targets.

`.output/public/build-manifest.json` describes public build identity, entries, import aliases, workers and SDK targets. `.output/client-manifest.mjs` is an operator/build artifact outside the served tree. Neither contains account configuration, private keys or credentials.

The service worker is generated from the final emitted artifacts, public presentation files and matching immutable offline HTML. It verifies each response's full SHA-256 before publishing a cache generation. API, configuration, recovery authority, signed contact requests, account responses and credentials never enter that cache. The runtime-branded web manifest remains network-only. Cache identity includes public bytes and service-worker policy; no hand-maintained module list or manual cache-version bump remains.

Workers Assets canonicalizes `.html` to extensionless URLs. A narrow Worker adapter follows exactly one same-origin internal canonicalization for the generated offline snapshot, requiring terminal successful HTML and preserving bytes. It rejects alternate paths, query-bearing/external locations and repeated redirects. Other HTML routing is unchanged; Node serves the built snapshot directly.

Updates use the browser's waiting-worker lifecycle. Existing tabs retain their worker/cache; a first install controls a page after navigation. Old public generations are retained until browser eviction; bounded cleanup requires future client-lifecycle evidence. The immutable offline snapshot uses built branding, while live self-hosted HTML receives configured branding. Deployment must preserve release gates and namespace/signing-key operational requirements.

See [independent review](../release/build-cache-audit.md) and [DEVLOG](../../DEVLOG.md) for actual runtime/browser evidence and human sign-off places.

The lockfile uses a narrowly scoped override for HMR0.1.12’s type-only dev-server-core dependency, aligning it to the already used0.7.5 core. This removes the obsolete chokidar3/braces subtree. Independent modern-core/HMR change-event testing passes; the complete dependency audit reports zero vulnerabilities. Reassess this compatibility override when updating the pinned tooling.
