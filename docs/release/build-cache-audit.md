# Browser build and cache review

Date: 2026-10-12. Reviewer: independent architecture/security agent. Human release sign-off: **pending**. Production release remains disabled; this review does not approve deployment.

## Scope and evidence

The review reads the local `@3sln/js-tools` implementation (`../js-tools/src/{build,config,modules,workers,vendor,wireup,verify,entry-points,headers}.js`), the repository's build adapter, HTTP response policy, recovery worker loader and generated service-worker boundary. Local source inspection is evidence about those files, not confirmation of a differently packaged release. Installed-package and browser checks must establish the actual integrated behavior.

The intended public tree contains browser app modules, SDK modules, public recovery codecs, handle normalization, localization, portal modules and vendored 3sln libraries. Identity services, runtime adapters, credentials, server configuration, private key values, account data, recovery payloads and test fixtures must stay outside it. Cryptographic implementation source is public; runtime key material is not a build input.

## Design findings

1. **Complete the actual `.mjs` graph.** The inspected builder fingerprints configured `.mjs` sources but adds automatic module-map keys only for `.js`. The adapter completes exact source aliases from the returned module manifest, regenerates the wireup with `wireupSource`, and checks every staged module against emitted URL resolution. This closes a real production-only missing-module failure. Built-in bare-specifier verification alone is insufficient: it permits `node:` imports and does not prove the public emitted graph is complete.
2. **Preserve module identity.** Project imports remain authored source bytes. Repository-relative staging preserves neighbour traversal, and origin-absolute source aliases resolve to the same hashed URL. Vendored dodo, ngin and Bab must each have one browser module identity, including dodo's reactive subpath; independent duplicate bundles or stable source copies would break that invariant.
3. **Bundle workers independently.** Document import maps do not apply inside workers. The recovery KDF worker must be the builder's standalone hashed bundle, selected from a trusted same-origin generated mapping. The HTTP worker response must retain the restrictive recovery policy, including the required WebAssembly permission; checking only the former fixed filename would miss it.
4. **Authorize the injected import map narrowly.** js-tools wireup creates an inline import map and supports copying its script nonce to that map. The integrated HTTP policy instead authorizes the exact SHA-256 hash of the generated import-map JSON, carried in trusted built HTML. This keeps immutable HTML unchanged while authorizing only the intended inline map. Same-origin external module permission remains; broad inline-script permission is unnecessary.
5. **Version the full shell.** The upstream build ID does not cover copied HTML and static files. The adapter computes a replacement identity over final immutable assets, copied public files and generated HTML. Any cache generation must also account for service-worker implementation changes and every stable asset it precaches. A module-only ID is insufficient.
6. **Keep generations coherent.** Installation must finish the complete declared graph before activation. New workers should wait for old controlled pages rather than replacing their dependencies midway through use. Fetches and cache lookup must remain inside one named generation; new network HTML must not overwrite an old cached root while referencing a different generation. Cleanup must affect only this application's cache namespace.
7. **Never cache private responses.** Cache candidates must be generated public paths, successful expected same-origin responses with no redirect, authentication cookies, private/no-store policy or unexpected HTML fallback for a script. API, recovery navigation, contact/grant URLs, authorization flows, query-bearing requests and user-selected URLs are outside the offline shell. In particular, the generic offline root must not replace a strict recovery page.

## Integration status

The build adapter and service-worker implementation have received source review. The installed package is pinned to `@3sln/js-tools` 0.2.0. Its requirement for at least one dependency is handled with an explicit `hash-wasm` browser dependency; server dependencies are not discovered. Recovery source staging is restricted to three named public codec files, with identity limited to `handles.mjs`. Vendor library source aliases converge instead of publishing duplicate stable script copies.

The service-worker generator covers emitted assets, including vendor chunks and a separately hashed static offline document. Each file has a full SHA-256 digest. Installation verifies the complete set before writing the generation; missing files, changed bytes, redirects, private/no-store policy and cookies reject it. The cache version also hashes the service-worker template after this review identified the policy-only-update collision. Root navigation remains network-first without caching its response; only failure falls back to the declared static offline document. Recovery, authorization and contact navigation receive no generic fallback. Existing clients retain their controller: no `skipWaiting` or `clients.claim` is used.

Independent read-only checks of generated artifacts passed: all 177 import-map aliases resolved to emitted files; all 62 mapped `.mjs` project modules preserved their source bytes; dodo root/reactive aliases shared their corresponding target identity; the import-map CSP hash matched its exact serialized JSON; no runtime, billing or identity-service module appeared in mapped targets. These counts describe the inspected build and may change with later sources. A standalone hashed recovery worker was present.

Independent focused service-worker tests passed, **5/5** (`node --test tests/public-build-cache.test.mjs`). They exercise rejected install on absent/tampered/private dependencies, generation isolation, uncached live HTML, private-route exclusions and storage failure without deleting the active generation.

An independent actual Node HTTP check served the complete generated precache list with custom branding. It found an integration failure: `/manifest.webmanifest` is dynamically parsed, serialized and branded by HTTP, so its bytes cannot match the static build digest (even default branding changed 422 bytes to 394). The implementer removed the dynamic manifest from precaching while retaining the ordinary live manifest link. A final recheck of build `8469915a2bc6a2303880` passed for **all 100 declared assets**, with exact SHA-256 matches and public cache policies.

The same HTTP check confirmed `/recovery/setup` returns 200, `Cache-Control: no-store`, the exact generated import-map hash in CSP, and no third-party script permission or broad inline-script permission. The hashed recovery worker received `wasm-unsafe-eval` with same-origin script/connect/worker restrictions, `frame-src 'none'` and `base-uri 'none'`. Final actual-browser verification belongs to the coordinator's aggregate test record in `DEVLOG.md`; these HTTP checks do not substitute for browser execution. No implementation files were edited by this reviewer.

## Operational limits

- Current service-worker policy retains prior generations rather than deleting a cache potentially used by an existing page. This favors correctness but can accumulate public files until browser storage eviction; a future cleanup policy needs client-lifecycle evidence.
- A first-time registration intentionally does not claim the already open page. Tests and installation instructions must perform a navigation after `serviceWorker.ready` before expecting a controller.
- Immutable offline HTML is served byte-for-byte with its exact import-map CSP hash. Per-request nonce or provider-brand transformations would invalidate its authenticated bytes. Custom branding applies to live HTML; the immutable offline fallback uses the built public branding. The dynamically branded web manifest remains network-only.
- Staged browser directory allowlists remain a maintenance boundary. New source under those directories must be reviewed for browser suitability; the complete graph check rejects imports outside the staged public graph.

## Additional Worker and external-SDK review

Actual Chromium/Worker testing by the coordinator exposed a platform-specific installation failure that Node verification could not detect: Cloudflare's assets binding redirects the hashed offline document from its `.html` URL to an extensionless URL. The service worker correctly rejects that redirect. The recommended correction is a narrow Worker asset adapter: only for the generated offline HTML path, accept a 307/308 whose location is the exact same-origin path minus `.html`, with no query, fragment or credentials; follow once through the assets binding, never an arbitrary network fetch, and require terminal successful HTML. This preserves byte authentication and existing documentation routing. Changing the global HTML-handling policy would require separate directory/index route migration and is unnecessary for this case. Integrated Worker verification is required after the correction.

`docs/integration.md` documents importing `packages/sdk/src/login-element.mjs`; that module imports its neighbour `identity.mjs`. App-local import-map aliases cannot serve a separate integrating document. Preserve these original stable public entry URLs with revalidating ESM loaders targeting content-addressed standalone modules; bundle the login element's small dependency graph so it requires no app import map. The identity module has no module dependencies. If these URLs are offered for cross-origin embedding, both the loader and immutable targets need anonymous public CORS without credentials. A browser test must use another origin without the app map. This preserves an intent-only draft SDK component and does not imply a released OAuth/interoperability service. Implementation and cross-origin browser verification are pending at this review stage.

## Development dependency security review

The coordinator's dependency audit identified the chain `@3sln/js-tools@0.2.0` → `@web/dev-server-hmr@0.1.12` → `@web/dev-server-core@0.4.1` → chokidar 3 → vulnerable braces. The recommendation is an exact scoped npm override of HMR 0.1.12's core dependency to **0.7.5**, followed by lockfile regeneration and a fresh dependency audit. Overriding chokidar alone would force a new watcher API into an old core and is less well supported.

Installed primary source supports the scoped override: HMR imports core only with TypeScript `import type`; compiled HMR JavaScript has no runtime core import. Its runtime collaborators already come from the main dev server's newer core. The old/new `Plugin` interfaces differ only in making the server optional, which HMR does not use. `WebSocketsManager` source differs only in an explicit `.js` relative-import extension. The consumed methods and fields (`on`, `send`, `webSocketImport`, watcher `change`/`unlink`, logger `debug`, configuration `rootDir`) remain compatible.

An independent smoke check passed using the actual core 0.7.5 `WebSocketsManager`, actual chokidar 4 watcher and HMR 0.1.12: startup succeeded, `import.meta.hot` was transformed, the HMR client referenced the correct websocket module, and an actual temporary-file edit emitted `hmr:update` for that module. No network listener or user data was involved. The coordinator owns package/lockfile changes and must confirm removal of the old core/chokidar/braces subtree with `npm ls`, a clean `npm audit`, and the ordinary build/test gates. This recommendation resolves the dependency rather than waiving it as development-only.

## Approval

| Decision | Reviewer | Date | Outcome |
| --- | --- | --- | --- |
| Public source boundary and unchanged import graph | Independent architecture/security agent | 2026-10-12 | Source and generated artifact checks passed |
| Cache generation and strict recovery CSP | Independent architecture/security agent | 2026-10-12 | Source, 5 focused tests and full HTTP digest verification passed; actual-browser evidence recorded separately |
| Production deployment | Human release authority | — | Unsigned; production remains disabled |

## Worker canonicalization and SDK compatibility closure

Actual Chrome identified Workers Assets returning307 for the generated offline `.html` URL; strict precache fetching correctly rejected it. The Worker adapter now follows one exact same-origin extensionless canonicalization through the original ASSETS binding, requires terminal200 HTML, and leaves bytes unchanged. Worker regression checks reject external, query-bearing, alternate-path and repeated redirects. Node behavior and global HTML routing are unchanged.

The documented SDK URLs remain revalidating loaders to standalone js-tools ESM bundles, so other origins need no app import map. Anonymous CORS applies only to those two loaders and their bundle paths; this grants no account API access. Actual Chrome verifies a distinct-origin embed, parser and login-intent event, immutable bundle policy and no import map. The SDK remains intent-only rather than implying released federation.

## Final coordinator verification

Actual Chrome/local Wrangler full portal suite passes41/41, including immutable policy, strict import-map CSP, isolated KDF, offline reload, standalone distinct-origin SDK embedding, signup/recovery, connected apps and automation. Core430/430, UI-state56/56 and actual Worker27/27 pass; production Wrangler dry-run succeeds. Dependency audit identified an obsolete HMR type-only core subtree; the reviewed scoped core0.7.5 override and fresh subtree resolution remove it, yielding zero vulnerabilities. The independent compatibility smoke uses the actual modern watcher and websocket manager and verifies a real file-change HMR update. No public release gate was enabled.
