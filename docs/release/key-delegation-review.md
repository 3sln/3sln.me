# Key delegation review (IDKEYS-2, BB-C3)

An independent security review (an agent) ran on 2026-10-20. It covered the provider side of `key-delegation.v1`:

- `packages/identity/delegation.mjs`;
- the delegation section of `packages/runtime/account/identity.mjs`;
- `packages/runtime/routes/delegation.mjs`;
- `tests/key-delegation.test.mjs`.

It looked at four areas:

- delegation abuse;
- an app holding certificates after uninstall;
- enumeration through the status endpoint;
- purpose confusion with identity-key signatures.

The reviewer confirmed findings both by tracing the code and by running probe scripts.

Human reviewer: ___ Date: ___ Outcome: ___.

This record does not approve a release. Production stays disabled, and everything here stays behind `BINDLEBOX_ENABLED`, which is off by default. The 24 h certificate lifetime is a provisional default pending the user's answer.

## What was implemented (local behavior only)

- **Engine operations** `delegations.{issue, renew, revoke, reconcile, list, status}` over a scoped `delegations` provider. The provider has a catalogue row.
- **Who is certified.** Certificates go only to the current messaging-ingress occupant, as reported by the `DELEGATION_SLOT_OCCUPANT` port, and only for the purposes that port reports as consented (author, receipt, archive).
  - `client` and `cnx` come from the port, never from the request.
  - With no port, or a failing one, nothing is certified.
- **Each request needs:**
  - a proof of possession of the delegate key, domain-separated;
  - an account that is still active.
  - A key that is one of the owner's identity keys is refused.
- **Lifetime.** Set by `DELEGATION_CERTIFICATE_SECONDS`: the default and maximum is 86400 s and the minimum is 300 s. An app may ask for less.
- **Signing.** Certificates are signed with the owner's current registry signing key. A test confirms they verify with `packages/bindlebox-protocol`'s `parseDelegation`/`verifyDelegation`.
- **Rotation and renewal.** A new key revokes its predecessor. Renewal keeps `since`. A revoked or pruned key is never certified again, and a key never moves to another client or `cnx`.
- **Revocation selectors:**
  - by key: the owner, or the app for its own keys;
  - by client, or all at once: the owner or the system.
- **History and audit.** History is bounded (32 records, with permanent tombstones). The audit ring is bounded (256 entries), and new keys are capped at 16 a day.
- **Public status.** `GET|HEAD {origin}/identity/<sub>/delegations/<jkt>` returns exactly `{status}` or `{status, revokedHour}`.
  - Unknown keys and unknown or inactive subjects all get the same answer, and no account is woken for them.
  - Cache headers: `public, max-age=300`, except a persisted revocation, which gets `max-age=86400, immutable`.
  - When status cannot be determined, the answer is 503 with `no-store`.
- **Owner routes:** `GET /api/delegations` and `POST /api/delegations/revoke`.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| KD-1 | Medium, confirmed | When the occupant changed, status reported `revoked` but persisted nothing. If the same occupant and `cnx` returned, the key reported `active` again. | **Fixed.** Status persists the first mismatch it observes as a revocation. A regression test covers A→B→A. The port contract should still require a unique `cnx` per incarnation (EXT-X4/C1b). |
| KD-2 | Medium, confirmed | Withdrawing a consented purpose left certificates carrying it active for up to 24 h. | **Fixed.** Status, reconcile and the issue path treat purposes that are certified but no longer consented as a mismatch, with reason `consent-withdrawn`. |
| KD-3 | Medium, confirmed | A client or all revocation that committed while a new key was being signed did not stop that key. | **Fixed.** Client and all revocations, reconcile and persisted mismatches bump a fencing epoch, which the commit compares with the value captured before signing. The account-active check is repeated before commit. A regression test covers this. |
| KD-4 | Medium | The lifecycle hooks (`revokeDelegationsFor`, `reconcileDelegations`) are not called by suspension, deletion, uninstall or slot handoff. Suspension is hidden only by the route's identity-status check, so keys revive on reinstatement. | **Open.** This needs integrator-owned files (lifecycle and admin suspension, EXT-X4, C1b). It is a production gate until it is wired. |
| KD-5 | Low, confirmed | Evicting a tombstone once more than 4096 existed let a revoked key be certified again. | **Fixed.** Tombstones are never evicted. Their growth is bounded by the new-key rate. |
| KD-6 | Low | Apps and owners could record system-style revocation reasons in the owner audit. | **Fixed.** Reasons are limited by actor kind: app gets `app`; owner gets `owner` or `compromise`; system reasons are for the system actor only. |
| KD-7 | Low | Rate limiting on the status endpoint failed open without a limiter. | **Fixed.** Outside local development it now fails closed (503). A per-subject window was added alongside the per-network one. |
| KD-8 | Low/info | Latency and status codes can separate active subjects (one account read) from nonexistent ones. | **Partly fixed.** Account-side faults other than a failing occupancy port now get the uniform `{status:'revoked'}`. The timing difference is accepted. |
| KD-9 | Info | The alias check covers only identity keys still in the registry, not pruned ones. The registry keeps only the kid of a pruned key. | **Accepted.** Exploiting it needs the identity private key. Fixing it requires a thumbprint in identity-key tombstones (`keys.mjs`, outside this stream). |
| KD-10 | Info | `max-age=300` plus a receiver's own 300 s cache can add up to about 10 minutes behind an intermediary that ignores `Age`. | **Accepted, documented.** RFC 9111 caches count `Age`. The BindleBox consumer cache (`bindlebox-engine/domains/delegation.mjs`) should honor the response's freshness; that is for the consumer owner to decide. |

## Checked without findings

- Client, ingress, `cnx`, purposes and lifetime cannot be set by the request, and lifetime never exceeds 24 h.
- At most one key is active under serialized transactions.
- Renewal reuse re-signs after identity-key rotation, a change of occupant or `cnx`, or a change of purposes.
- The `bindle-key-delegation+jwt` typ is emitted by no other signer of the identity key.
- The PoP domain differs from JWS input and from every `bindlebox-*` domain.
- With the flag off, nothing is mounted and the provider answers `not_found`.
- `delegationOperation` has no `rpc` entry.
- Neither the audit nor the owner views contain certificates.
