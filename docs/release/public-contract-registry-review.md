# Public JSON contract registry — independent review

Date: 2026-10-13. Status: frozen source and focused shared/Worker review complete; no blocker found in this registry slice. The final combined release build and publication checkpoint remain separate. This is not human release approval or external interoperability certification.

Human protocol/security reviewer: __________  Date: __________  Outcome: __________

## Scope and criteria

The registry must expose actual machine definitions at their exact canonical identifiers, with browser requests receiving JSON rather than a prose page. Published aliases must preserve source bytes and `$id`; schema validity must not imply live authorization or provider conformance. The catalog must distinguish the existing resource RPC contracts from the conversation submission envelope, without inventing a conversation v2 contract or publishing an experimental fixture simply because it exists on disk.

Public GET, HEAD and OPTIONS behavior must be bounded to the catalog and registry. It must not initialize identity state, reflect cookies or broaden private-route CORS. Redirect handling must be confined to the asset adapter's exact authored canonicalization. Public pages and the machine index must link to definitions that the build actually emits. Source schemas are reviewed as existing drafts, not redefined by this routing change.

## Source findings

Reviewed the [publication catalog](../../packages/core/public-contracts.mjs), [documentation generator](../../scripts/build-docs.mjs), [shared HTTP router](../../packages/runtime/http.mjs), [Worker asset adapter](../../apps/worker/index.mjs), source artifacts and changed specification links.

The explicit catalog contains five resource contracts: object storage, preferences, profile, resource descriptor and resource scoping. Each retains its existing versioned identifier and JSON Schema source. The conversation v1 entry is separately labeled a provisional local submission schema. It is not a complete RPC interface, and the registry does not advertise proposed conversation v2 features. Draft/publication status is separate from formal release or external conformance.

The generator checks source `$id` against the catalog and copies the original JSON bytes. It removes the prior output artifact directory after the general asset-copy phase, then emits only the allowlist and the HTML/JSON registry. This ordering is material: the unchanged general copy configuration initially copies the artifact directory, but the final publication step removes obsolete or experimental files. The superseded automation fixture is excluded from the final generated output. A newly added source file cannot publish itself through the catalog.

The canonical identifiers, explicit `.json` targets and exact `/docs/artefacts/` plus older flat `/artefacts/<name>-v1.json` aliases resolve through the same catalog. HTML Accept does not substitute documentation for JSON. Successful definitions use `application/schema+json`, `nosniff`, public bounded caching and a canonical Content-Location; registry JSON uses `application/json`. HEAD has no body, OPTIONS performs no asset read, and mutation methods return 405. Unknown contract and documentation-artifact paths return errors rather than a console fallback. These operations do not consult account identity or establish any resource authority.

The registry page uses ordinary links and separately retained prose documentation. The public documentation sanitizer still excludes internal architecture/release bookkeeping and preserves normative content. The shared Worker adapter adds only the exact registry-index-to-directory redirect, with same-origin/path restrictions; its actual Worker regression passed as described below.

## Independent local evidence

An independent rerun of `node --test tests/contract-registry.test.mjs tests/public-documentation.test.mjs` passed **7/7**. Tests generate isolated temporary documentation output, not the shared frontend asset build. They check byte equality, identifiers, all registry JSON links, HTML-Accept requests, legacy source aliases, cookies having no effect, no identity-engine call, HEAD/OPTIONS/method restrictions, absent proposed/experimental artifacts, stale-output removal, conditional 304 behavior and public documentation filtering.

The follow-ups are resolved: older flat artifact paths are exact catalog aliases; final output cleanup remains after the general copy phase; and actual Worker regressions cover directory canonicalization and malicious/repeated redirects. Independent `node --test tests/worker/contract-registry.test.mjs` passed **2/2** after the initial sandbox attempt could not bind loopback (`EPERM`). The permitted rerun used the same test/source and performed no production calls. It confirms actual Worker JSON bytes for canonical, explicit and both legacy path forms with HTML Accept, registry/index links, HEAD, absent v2 and exact index canonicalization. Alternate origin/path/query/fragment and repeated redirects fail. The implementer’s final shared **7/7** and Worker **2/2** logs were also inspected (`/tmp/bindle-contract-registry-final.log`, `/tmp/bindle-worker-contract-registry-final.log`).

No remaining blocker was found in the frozen routing/catalog/documentation slice. Final combined full-suite/build evidence is owned by the coordinator and must include the final registry output; these focused tests do not establish that a public deployment already serves it. No publication or production fetch was performed by this reviewer. Human approval and external interoperability evidence remain separate.

Human release decision: __________  Date: __________  Outcome: __________
