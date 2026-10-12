# Portable UUID identity and separate name certificates

Status: implementation candidate under development, 2026-10-12. Human reviewer: ___ Date: ___ Outcome: ___. This document reflects the user's latest decision: **a recovery file contains no handle or name assignment**. Names are bound to the stable UUID by a separate, independently downloadable public certificate. Earlier combined recovery/name proposals are superseded. See [permanent names](identity-names.md), [encrypted recovery envelope](recovery-file.md), [decision ledger](../../DEVLOG.md) and [production gates](security.md).

## Identity and artifacts

The identity is an immutable, canonical lowercase UUIDv4. A free or paid name routes to that UUID and may be certified separately. Recovery must not depend on the current spelling, preferred alias or availability of a name. Signing and encryption keys belong to the UUID; neither answers nor handles generate them.

The two artifacts have separate purposes and contents:

| Artifact | Contents and handling |
| --- | --- |
| Encrypted recovery file | Provider-signed issuer, UUID, random reset credential, original signing private key and separate encryption private key, with bounded warning/version metadata. No handle, alias, assignment identifier or name certificate, including within encoded signed payloads. Keep the complete signed payload inside answer-derived authenticated encryption. |
| Public name certificate | Provider-signed issuer, UUID, exact canonical handle, assignment identifier and issuance time. No private keys, reset credentials or private recovery proof. Download separately; it can be shared as evidence of historical assignment. |

Changing or adding a name does not require a new recovery file. A name certificate is historical issuance evidence, not a current login credential or a permission grant. A certificate supplied with its own untrusted verification key does not establish provider authority.

Preserving a UUID and keychain preserves cryptographic identity. Keeping old contact links operational additionally requires original routing and current grant, expiry, quota, quarantine, collection and key-status records. Private keys alone cannot reconstruct deleted grants, revive revoked permissions or recover missing messages/files. Existing provider OAuth credentials, application consents and passkey private keys are outside this recovery package.

## Recovery wire schema and API

Keep the existing outer `3sln-recovery` envelope version 1 and its Argon2id, normalization, AES-GCM, bounds and every-answer requirements. Independently version its decrypted payload as version 2. The exact parser and cryptographic implementation are `packages/recovery/identity-backup.mjs`.

```js
createIdentityBackup({issuer, entity, keychain, recoveryToken, warning}, authority)
verifyIdentityBackup(backup, authority, {issuer, entity})
validateIdentityBackup(backup)
```

The decrypted shape is `{version:2,issuer,entity,recoveryToken,warning,keychain,proof}`. `entity` is the UUIDv4. The keychain is `{version:1,signing:{kid,privateJWK},encryption:{kid,privateJWK}}`. Original ECDSA P-256 signing identity and its `kid` are adopted from AccountObject; export must not generate a replacement if a signer exists. Encryption uses an independently generated ECDH P-256 key with a different key ID and scalar. Provisioning that key does not establish that existing content uses it or that messaging is end-to-end encrypted. Future encryption use requires its own context-bound KDF and authenticated-encryption protocol.

The proof is `{alg:'ES256',kid,payload,signature}`, where payload is unpadded canonical base64url of the exact bounded JSON backup object before the proof is added. Sign the UTF-8 bytes of `3sln-identity-backup-v2.ES256.<provider-kid>.<payload>`. The proof payload is reversible and contains private keys and the reset token; it must never be published as a public identity certificate. The complete proof, keychain and reset credential remain inside the answer-encrypted file. A generic or UUID-based download filename avoids putting a handle in the recovery artifact's public name.

Reject unknown fields, names embedded in a v2 schema, unsupported versions/algorithms, malformed canonical encoding, invalid UUIDs, incorrect key usage, identical signing/encryption material and private/public scalar-point mismatches. Verify correspondence cryptographically; importing a supplied private JWK alone is not proof that its public coordinates match its scalar. The implementation uses isolated sign/verify correspondence checks for P-256 scalar-point validity, including the encryption key, without publishing those temporary validation signatures or using the encryption key for application signatures.

## Separate name certificate API

```js
createNameAssignment({issuer, entity, handle, assignmentId, issuedAt}, authority)
verifyNameAssignment(certificate, authority, {issuer, entity, handle, assignmentId})
```

The result is `{version:1,type:'3sln-name-assignment',issuer,entity,handle,assignmentId,issuedAt,proof}`. Its proof signs UTF-8 `3sln-name-assignment-v1.ES256.<provider-kid>.<payload>`, where payload contains the canonical public fields only. Signing and verification use a distinct purpose from recovery. Copying a recovery proof into a name certificate fails verification. The creator accepts only the exact public inputs; passing a keychain or reset credential fails rather than silently serializing it.

Certificate handles must already be in the canonical form returned by the shared namespace parser. Lookup accepts supported case/Crockford spelling variants, but certificates retain the exact signed canonical spelling. The assignment identifier binds the retained identity assignment lineage; several name claims for the same UUID may share it. Exact issuer, UUID and handle disambiguate each signed name. A new paid alias receives a separate name certificate and does not modify the recovery payload or the canonical free name. The name certificate does not promise data retention or authorize restoration of a deleted account.

## Provider trust and custody

The provider recovery/name signing private key is independent of user keys and `KEY_ENCRYPTION_KEY`. It never enters either artifact as a private key and must not be derived from the credential-encryption secret. Node development adapters persist their authority with private filesystem permissions across restarts; deployed adapters require explicitly configured stable authority. An absent authority must fail before creating account keys or issuing a recovery credential.

Verify against the independently selected provider's trusted key, never an issuer URL, key URL or bundled authority chosen by the file. The browser may obtain a public authority from the currently selected same-origin provider; this uses that origin's TLS trust and does not protect against provider compromise. Offline verification requires a separately trusted saved public key. File decryption remains independent of server keys, but the current browser workflow's online authority verification and live account recovery require provider availability.

Provider rotation requires retained trusted verification history and an explicit compromise policy; a single configured signer is not a completed rotation system. A retired public key can support historical signature inspection without granting current recovery authority. Configured credentials and local signatures are not evidence of production custody or external conformance.

## Export and retained-account recovery

1. Require the existing limited setup authority or a separately authorized recent owner session. Warm AccountObject state before export. Idempotently adopt the existing signer and persist a distinct encryption key once under the account gate.
2. Validate signing authority before key creation. Issue a signed UUID/keychain/reset package and commit its random-token hash under identity revision/CAS checks. Do not return a usable package after a failed commit. Cross-object partial work must remain retryable without changing identity keys.
3. Encrypt the package in the isolated first-party recovery document. Retain every-answer local decrypt verification and explicit save acknowledgement before activation. Neither a download click nor an in-memory round trip proves a durable filesystem write.
4. On restore, decrypt and verify exact schema, issuer, trusted provider signature and key correspondence. The server independently checks the full signed v2 package, current UUID and original keys, plus the current reset credential or its active transaction resume credential. Name state is not a verification input to recovery.
5. Compare against retained keys without creating missing keys or replacing current keys during verification. Reject absent accounts, missing key state, altered keys or unavailable authority. Automatic key repair/import and account reconstitution are separate future protocols.
6. On first recovery revoke old password/passkeys and sessions, preserve a transaction-scoped resume hash and its original payload-version requirement, and enter recovering. Resumption preserves newly completed setup. Replacement-file confirmation atomically reactivates the same UUID and removes old resume authority. A consumed token or copied private key alone cannot start another recovery.

Persist a v2-required marker on upgraded accounts. Omitting the proof or presenting a stripped v2 reset token must not invoke the legacy path. An original v1 transaction remains resumable as v1 while its replacement v2 file is prepared; activation enforces v2 for future recoveries. Explicitly recognized legacy v1 files contain a handle and random token, but no portable keys. That old format remains supported only where live account policy permits it; malformed v2 files never downgrade. The unreleased earlier name-bearing v2 candidate is rejected by the current strict schema.

Keep private keys, answers, tokens and decoded recovery payloads out of logs, public UI state, telemetry, URLs and browser persistence. A public handle may be returned beside the recovery content for setup display; it is not part of the downloaded encrypted recovery payload. The provider's stored private-key copy remains encrypted under `KEY_ENCRYPTION_KEY`; losing that key does not prevent offline file decryption, but the current retained-account flow does not repair unreadable provider records automatically.

## Return, compromise and missing state

For retained accounts, returning restores access to the same UUID and keys. Existing active unexpired contact links can resume once the account becomes active; expired, revoked, exhausted or absent grants remain denied. Recovery is not full compromise remediation: it preserves identity keys, email-login settings and unrelated application/resource permissions. Replacing the reset credential cannot erase a copied private key. Key rotation/retirement requires an explicit future flow and must prevent rollback from old files.

Handles are permanently nonreassignable under [the name policy](identity-names.md). Permanent claims are not sufficient recovery authorization. Reconstitution after identity deletion additionally requires retained recovery authority, key-generation continuity, live revocation state and a crash-safe restoration protocol. Missing those records must fail closed even if a name certificate or old private key is valid. A backup predating revocation must never revive a grant, and another provider cannot claim the original provider's name namespace without an authenticated migration protocol.

Offline guessing of the recovery answers now exposes durable private key material as well as a reset credential. Retain the existing explanation of PII entropy and private-passphrase recommendation. Token revocation cannot revoke decrypted copies of keys.

## Evidence and review

Required tests cover signed recovery without names even in encoded proof, separate public certificates without private material, purpose/domain separation, tampered UUID/token/keys/signatures, provider mismatch, key correspondence, strict UUIDv4 and name canonicalization, no-proof downgrade, consumed token replay, legacy resume across upgrade, retained signer/contact state, missing account/key rejection, restart authority persistence, and absence of mutation when authority is unavailable. Browser evidence includes online proof verification, isolated recovery documents, encrypted-only downloads and no private values in UI projections/storage. Name-ledger migration, key rotation, missing-account reconstitution and production recovery operations remain separate gates.

| Decision | Direction | Human sign-off |
| --- | --- | --- |
| UUID recovery | Stable UUIDv4 and private keychain; names excluded from signed recovery contents. | User direction, 2026-10-12; reviewer ___ / Date ___ / Outcome ___ |
| Public assignment | Separate downloadable provider-signed UUID/name certificate; no private recovery material. | User direction, 2026-10-12; reviewer ___ / Date ___ / Outcome ___ |
| Retained-state boundary | Current live state controls recovery/permissions; no automatic missing-account/key reconstruction. | Reviewer ___ / Date ___ / Outcome ___ |
