# Authorization entry, app sessions and embed credentials: implementation review

Date: 2026-10-14. Target: the uncommitted server slice for [adaptive app sign-in](../architecture/adaptive-app-sign-in.md) D1/S4, A2 and the server half of A5:
- `packages/federation/{authorization-entries,dpop,app-sessions,embed-bindings,components-profile}.mjs`
- `packages/runtime/federation-entry-http.mjs`
- edits to `packages/federation/{service,http,runtime}.mjs`, `packages/runtime/federation.mjs` and `apps/worker/federation.mjs`

Lens: OAuth 2.0, RFC 9449 DPoP, RFC 7009 and browser-component security. One independent reviewer read the code and ran proofs of concept against it. Its temporary script was deleted.

**No human sign-off is implied.** The production gates in [security](../spec/security.md) and DEVLOG.md still apply. Nothing here is mounted in `packages/runtime/http.mjs` yet.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| ___ | ___ | ___ |

## What held

The reviewer checked each of these by reading the code and the tests.

**Claims and credentials**
- No path delivers a claim or an embed credential to a client.
- A claim is minted only when an attested `embed-popup` entry is approved through the entry route. Results in plain mode drop the claim.
- Codes, refresh tokens, access tokens, claims, embed credentials and embed sessions each use their own hash domain. None of them is accepted at another endpoint.
- Owner requests created from an entry refuse the legacy decision route.

**DPoP proofs**
- The header may contain only `typ`, `alg` and `jwk`, and the JWK may contain only public members.
- Only ES256 is accepted, and the signature is checked before the nonce.
- `htu` is compared without its query, and `iat` must be within ±60 s.
- Nonces are HMAC-signed, purpose-separated and single-use, and each `jti` is single-use. `ath` is checked.
- A missing or stale nonce gets `use_dpop_nonce` with the `DPoP-Nonce` header.

**Opener-key handshake**
- The handshake proof has its own `typ` (`bindle-embed+jwt`).
- The challenge is single-use, and the proof carries the `entry` claim.

**Codes and sessions**
- PKCE S256 and the `dpopJkt` code binding hold. `auth_time` is returned only for `reauthenticate`.
- Owner selection is idempotent and binds one owner per entry.
- A bound refresh token used without its key neither renews nor revokes the session at the token endpoint.

## Findings and resolution

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| F1 | Medium | A bound session ended after 127 rotations, because the history limit counted as reuse. With 5-minute access tokens that is about 9–11 hours. | **Fixed.** Bound families keep a ring of the 64 most recent hashes and delete older refresh records instead of revoking. Test: 140 rotations, then reuse of a recent token still revokes. |
| F2 | Low–medium | An old token from a bound family's history could revoke the family through RFC 7009 without the key. | **Fixed.** A bound family is revoked only by its current token. Old tokens are a silent no-op. Test added. |
| F3 | Medium | Entry budgets were keyed by the caller-supplied `clientId`, so distributed callers could drain a victim client's budget. Without `remote` there was no per-caller limit. | **Fixed.** Budgets are per caller address, per client from that address, and global (raised to 20,000 per 10 min). Creation is refused without a remote address. Distributed exhaustion of the global budget is still possible and needs root-adapter subnet admission. Test added. |
| F4 | Low | `select` saved the irreversible plain-mode declaration before checking the owner. | **Fixed.** Plain mode is saved only inside the owner-authenticated selection transaction. Test added. |
| F5 | Low | The per-account limit of 32 families threw before the per-client limit of 8 could evict. | **Fixed.** Per-client eviction runs first. Test added. |
| F6 | Info–low | The checks on embed-entry creation, challenge and verify rely on `Origin` and Fetch Metadata headers, which non-browser callers can forge. A server-side app can attest its own key. It still cannot receive the claim, because the popup posts only with `targetOrigin` set to the embed origin. | **Open, recorded as a release gate.** Step 3 of the §8 argument is enforced in the browser, not the server. Browser evidence must show the popup accepts a proof only from `opener` at the embed origin and posts `done` only to the embed origin. |
| F7 | Low | The entry document's CSP was partial. | **Fixed in the handler:** full strict CSP with `frame-src 'none'`. **Open for mounting:** the root `securePage` replaces the CSP, and its current policy allows a frame source. The mount must keep the handler's CSP or `frame-src 'none'` for this document. **Mounted 2026-10-14:** `securePage(…,{keepPolicy:true})` keeps the handler CSP and COOP, adding only the import-map hash ([federation mount review](federation-mount-review.md)). |
| F8 | Info | With `FEDERATION_ENTRY_ENABLED=true` the manifest advertises routes that no adapter mounts yet. | **Open.** Keep the flag off until the coordinator mounts the http.mjs hunks and composes `federationEntries`. **Mounted 2026-10-14:** the feature is advertised only while `FEDERATION_ENTRIES` is composed, and the components profile only with a served embed shell ([federation mount review](federation-mount-review.md)). The flag stays off until the entry UI exists (M2). |
| F9 | Info | `selection.session` is recorded but not checked. Embed rows of pruned families stay until they expire. A bogus `token_type_hint` revealed routing. | **Hint fixed:** unknown hints are ignored (RFC 7009 §2.1), and shard errors other than `invalid_client` are a silent success. The other two are accepted: the rows are unusable, and decisions are owner-checked. |

## Remaining limitations

These are stated honestly and are not findings:
- Access tokens stay `token_type: Bearer`. Only refresh tokens are DPoP-bound, which RFC 9449 §5 allows for public clients. auth.md says `token_type:"DPoP"`, so the coordinator must reconcile it.
- FedCM is not implemented.
- Embed streams (the islands design caps them at 2 per partition) are not implemented. Sessions are capped at 4 per frame key, evicting the oldest.
- A valid proof from the wrong key is rejected but not logged.
- Components-profile manifest fields are provisional and confined to `components-profile.mjs`.
- No real-browser evidence exists.
