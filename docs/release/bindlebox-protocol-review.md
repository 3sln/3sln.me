# Bindle Messaging protocol library review (BB-B1)

Date: 2026-10-20.

**Scope.** `packages/bindlebox-protocol/*`, the pure protocol library for the Bindle Messaging interop draft ([spec](../spec/bindlebox.md)). The package keeps its `bindlebox` name until the app rename. Tests: `tests/bindlebox/protocol*.test.mjs`. Fixed vectors: `tests/bindlebox/vectors/`.

**Method.** The library was reviewed by one independent security-reviewer subagent, read-only, with executable probes. It looked at:
- signature substitution;
- canonicalization;
- domain separation;
- certificate validation;
- parser differentials;
- replay;
- honest outcomes.

The implementer then fixed every confirmed finding and added a regression test for each.

**This is agent review, not human sign-off.** Human sign-off: reviewer ___ / date ___ / outcome ___. Nothing here is production-verified or interop-verified. A local test pass is not an interop claim (spec §13).

## What the library is

The library is pure and deterministic. It has no storage, network, clock or randomness of its own, and its only platform dependency is Web Crypto. Core `contact-delivery*.mjs` was copied and adapted under roadmap conflict resolution 13; the core originals are unchanged.

The import-boundary test passes: the library imports only its own files.

The directory key resolution (`resolveKey`) and delegation status (`status`) are injected ports. `index.mjs` documents the engine admission order.

## Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| BR-1 | high | The signed `principal.identityURI` was not tied to `(issuer, subject)` and was handed to the key and status ports. §3.4 builds the status URL from it. An attacker could steer the status check to an attacker-controlled path on the provider origin, for example a second account certifying the same public key, and so pass status for a revoked key. Identity URLs could also carry a query. | **Fixed.** `resolveKey` must return the directory's canonical `identityURI`, and authentication refuses a mismatch. `identityURI` and `identityDocument` refuse queries. The port contract (verify.mjs header) says the status port derives its URL from the directory. |
| BR-2 | medium | `classifyFailure` fell through to terminal `rejected` for 2xx/1xx/0/408/425. | **Fixed.** Only 400, 409, 413 and 415 are terminal, plus 401, 403, 404 and 410 after one repair. Anything else is `unknown` and is retried with the identical envelope. |
| BR-3 | medium | `multicastOutcome` dropped rotation context, and made `author_unverifiable` terminal. A per-context result has no status or `Retry-After`. | **Fixed.** `knownRotation` and `linked` are passed through. A multicast `author_unverifiable` stays `unknown`. **Spec gap:** §7.3 results carry no per-context status. Reconcile with the spec owner. |
| BR-4 | low | The pair gate did not tie the token digest to an incarnation. An ordinary token admitted a `peer-hello`, and the converse also held. | **Fixed.** The edge entry keeps `tokenDigests` and `helloDigests` apart. |
| BR-5 | low | A missing invitation `expiresAt` never expired. | **Fixed.** It now fails closed with `not_authorized`. |
| BR-6 | low | Display strings admitted U+061C, U+200E and U+200F. The gap was inherited from core. | **Fixed.** The filter now refuses `\p{Bidi_Control}`, U+200B and U+FEFF. The core original is not edited; noted for its owner. |
| BR-7 | low | URLs accepted trailing-dot hosts, IP literals and loopback names in production. | **Fixed.** These are refused unless `allowLoopback` (development only) is set. |
| BR-8 | low | `streamState(start)` contradicted the meaning of `peer-hello` `startCounter`. | **Fixed (interpretation).** `start` is the first expected counter. Recorded below for spec confirmation. |
| BR-9 | low | `genesis.proof.delegation` was never checked. | **Fixed.** It must certify the creator's `jkt`, `iss` and `sub`. It is outside the signed input, and downstream code must not trust it further. |
| BR-10 | low | Receipt verification enforced the certificate lifetime against "now". That made the receipts needed for §8.2 reconciliation unverifiable after about 24 h. | **Fixed per spec text.** The lifetime is checked at `receivedAt`, which must be no later than now plus skew. The status check stays required, so revocation is still honoured. |
| — | info | Binding comparisons ran after the status fetch. | **Fixed.** Status runs last in `verifyEnvelope`, invitation responses and introductions. A regression test proves a binding mismatch costs no status fetch. |

The fuzz suite also found an issue. A caller-supplied array with a replaced prototype escaped `parseMulticastResults` as a `TypeError`. **Fixed:** the input is detached first, and genesis validation also detaches its input.

## Interpretations and spec items to reconcile (provisional, unsigned)

- **`secret-share` status.** `secret-share` is added to the status-required set, because it installs a secret. Spec §3.4 omits it.
- **Signing per recipient.** The event ID excludes `recipient`, but the signed payload includes it. Each recipient's envelope is therefore signed separately, while the event ID is shared. Architecture §9.1 says the envelope is signed "once"; it should read once per recipient.
- **Replay outcomes.** For records, the same replay key with the same event ID and a different delivery context returns `duplicate-event`. A different event ID returns `equivocation`. For link kinds, a different digest is `operation_conflict`.
- **`acceptListed`.** It is optional; absent means `false`. `binding` is present exactly on `accept`.
- **`bodyDigest` without a body.** A receipt's `bodyDigest` is `null` exactly when the envelope has no body. Spec §8.1 lists no null case.
- **Binding incarnation.** A binding incarnation may not be `hello`. Opaque identifiers are 1 to 64 visible ASCII characters, which keeps the pair-token input injective.
- **Intake digest.** Public-intake `normalizedDigest` is SHA-256 over the JCS of `message`. The spec's "canonical parts" is undefined.
- **Gap and introduction liveness** (reviewer notes, spec owner):
  - The 1,024 counter jump is measured from the lowest unexpired gap, so one old gap can hold an honest sender at `counter_gap` for up to 7 days.
  - Abandoned gaps beyond 256 read as duplicates.
  - Relayed introductions must carry a certificate that is valid at relay time. A certificate lasts at most 24 h, so introductions relayed later fail.
- **Error codes.** Certificate-bound binding mismatches return `author_unverifiable`. §8.3 has no dedicated code for them.

## Verification

- **Bindle Messaging suite.** `npm run test:bindlebox` passes 44 tests:
  - protocol: 20;
  - vectors: 10;
  - fuzz: 5;
  - engine skeleton and import boundary.
- **Seeded fuzz.** It also passed 300 rounds at each of the seeds 1, 1000, 2000, 5000 and 9000. The default is 60 rounds; set `BINDLEBOX_FUZZ_ROUNDS`.
- **Full suite.** `npm test` passes 1,470 tests with 6 todo and 0 failures.
- **Fixed vectors.** There are 21 signed objects, covering every kind and every record type:
  - the certificate;
  - a renewed certificate;
  - genesis;
  - invitation responses (accept and decline);
  - receipts (link, record and control);
  - multipart;
  - multicast;
  - the pair token and edge key;
  - a contact-delivery v1 signature for the negative domain-separation case.
- **Negative coverage.** The tests cover tampering, substitution between principals, keys and objects, and the four domain prefixes. They also check that a contact-delivery v1 signature never verifies.
