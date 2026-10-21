# Brokering key set and RFC 9068 access tokens (EXT-X5): independent review

Date: 2026-10-20. Status: provisional. An AI security reviewer independently reviewed the implementation and its findings were fixed in the same workstream. No human sign-off, deployment, secret provisioning or production verification has happened. `BROKERING_ENABLED` stays `false`, and no adapter passes the `brokering` option yet.

Human protocol/security reviewer: __________  Date: __________  Outcome: __________

## Scope

- `packages/federation/signing.mjs`: the key set, custody and rotation, `mintAccessToken`, `peekAccessToken`, `verifyAccessToken` and `brokeringEnabled`.
- The brokering JWKS route (`/oauth/brokering/jwks`) and the manifest member in `packages/federation/http.mjs`.
- `tests/federation-signing.test.mjs` (8 tests).

There is no consumer-facing minting route; that is EXT-X8. SET minting is EXT-X6. The event key is already published and its purpose is fixed to `secevent+jwt`.

Design references: integrations §5.3, §5.5, §6.1 and §7, and extensibility-design §6 and the X5 row.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | Medium | After a compromise, the replacement key started signing before verifiers could see it. Verifiers refetch on an unknown kid at most once a minute, and the 300 s HTTP cache delays them further. | **Fixed.** Every purpose now keeps a published standby key, scheduled for `max(now + lead, activatedAt + rotateAfter)`. `revoke` promotes the standby at once and then stages a new one. A test checks that a verifier holding the key set from before the compromise accepts the replacement. |
| 2 | Medium | Every unauthenticated JWKS GET (including 304s) opened a serialized transaction and could write. That can contend with severance commits. | **Fixed.** `jwks()` is a read-only snapshot, memoized per instance for `cacheMs` (5 s). It writes only to provision a missing set. Due transitions run on signing, rotation, revocation or `maintain()`. Retiring keys are filtered by `removeAt` when the set is read. A test checks that 100 reads open no transactions and never write. |
| 3 | Low | ES256 signatures were malleable: replacing `s` with `n − s` still verified. | **Fixed.** The signer normalizes `s` to the lower half of the curve order, and the verifier refuses high `s`. Tested. |
| 4 | Low | `sign(purpose, typ, payload)` accepted any combination of purpose and `typ`. | **Fixed.** `sign(purpose, payload)` now fixes the `typ`: `event` signs `secevent+jwt`, and every other purpose signs `at+jwt`. Tested. |
| 5 | Low | The minimum overlap (330 s) ignored verifier clock error (360 s, §7.2) and the 10-minute SET window (§6.1). | **Fixed.** The minimum overlap is now 630 s. The default stays at 3600 s. |
| 6 | Low | The minimum lead time (300 s) was weaker than the 1-hour verifier cache bound. | **Fixed.** `lead` must be at least `DEFAULT_LEAD` (3600 + 300 + 60 s). |
| 7 | Info | The flag is not wired to a route yet. | **Recorded.** The integrator must construct `brokeringKeys` over federation metadata in the serialization domain and pass `brokering:{enabled:brokeringEnabled(env), jwks}` to `handleFederation`. Flag-off behaviour (no route, no manifest member, key store never touched) is tested. |
| 8 | Info | `KEY_ENCRYPTION_KEY` is used as a raw AES-GCM key in `runtime/secrets.mjs` and as HKDF input here. | **Accepted.** Brokering keys use their own HKDF-derived key (`info` `bindle-brokering-keys-v1`, issuer salt). AES-GCM additional data binds issuer, kid, purpose and public point. Moving other uses to HKDF is outside X5. |

## Accepted limitations

These are speculative or design-level, and are recorded rather than changed.

- **Revocation does not reach caches.** Verifier caches (up to 1 h) and HTTP caches (300 s) can keep a revoked key accepted. The compromise procedure therefore must increment every connection generation and emit the §7 events (EXT-X6/X8). The operator runbook must add a CDN purge of the JWKS path. `revoke` returns the purpose and the replacement kid so the caller can do this.
- **One token can race a revocation.** `sign` reads a snapshot and decrypts outside the transaction, so a concurrent `revoke` can still let one token be signed with the compromised key. Generation increments cover that token.
- **Erasure is limited by backups.** Erasing a private key removes it from the current record only. Durable Object or Node point-in-time copies may keep the sealed value, which remains protected by `KEY_ENCRYPTION_KEY`. Operator backup policy has to cover this.
- **`describe` scope.** The verifier accepts a `describe` token for any single contract whose only method is `describe`. Binding it to the resource-scoping contract URL belongs to the scoping slice.
- **The manifest member is provisional.** With the flag on, the manifest carries a top-level `brokering_jwks_uri`, which is unsigned and non-normative. It is not `features["brokered-resources.v1"].jwks_uri`, because AMD-C6 forbids declaring the feature before preferences/v2 and minting are mounted. Clients ignore unknown members. Conforming integrations fetch keys only from the feature member, so EXT-X8 must move the URI into the feature declaration and remove the top-level member.

## Checked and found sound

- **Headers.** The header must be exactly `{alg, typ, kid}`. `alg:none`, HS256 confusion with the public key as secret, ES384, `jwk`, `jku`, `crit` and `x5u` are all rejected. Only exact `at+jwt` is accepted; `application/at+jwt` is refused because the profile mints only `at+jwt`.
- **Encoding.** Base64url must be canonical. JSON must be canonical, which rejects duplicate members and whitespace. Raw signatures must be exactly 64 bytes.
- **Key sets.** Duplicate kids, private members, foreign algorithms or curves, `use` other than `sig`, and sets of more than 64 keys are refused. The kid's purpose prefix must match `bindle.purpose`, and event kids are never access keys.
- **Audience and claims.** `aud` must match exactly, must not be an array, and must not be on the issuer origin. Lifetimes are bounded per purpose (300 s, or 60 s for discover and describe), and leeway is at most 30 s. Discover and describe tokens must have `client_id` equal to the issuer. The resource must be on the audience origin.
- **Unknown connections.** An unknown (`iss`, connection) is rejected before any key lookup (§5.5 step 1).
- **Provider-side verification.** `keys.verify` also requires that the signing key was active when the token was issued.
- **JWKS response.** It exposes only public members, with `Cache-Control: public, max-age=300, must-revalidate`, a strong ETag with 304 support, `Access-Control-Allow-Origin: *` and `nosniff`. Failures return 503 with `no-store`. The legacy `/oauth/jwks` stays empty.

## Verification

- `npm test`: 1402 pass, 0 fail.
- `npm run test:worker`: 53/53, rerun after the review fixes.
- `npm run check:worker`: dry run succeeded.

No browser behaviour changed.
