# System identity invitation operations

Provisional local implementation, 2026-10-13. Human reviewer: __________ Date: __________ Outcome: __________.

An invitation authorizes one protected alias and a host-derived system/developer badge on one new stable identity. It grants no administrative API, paid subscription, storage bypass or message authority. The account retains a numeric canonical handle. Existing protected-name assignments and tombstones cannot be overwritten. No particular developer identity or production invitation is provisioned by this document.

## Private operator files

Create a new private key file using a destination under operator-controlled storage:

```sh
node scripts/system-bootstrap.mjs key --out /private/operator/system-bootstrap.key
```

The command writes a fresh32-byte base64url HMAC key to an exclusive0600 file. It never prints the key. Configure the same bytes as the provider's `SYSTEM_BOOTSTRAP_KEY` through its secure secret mechanism. Keep this key separate from recovery signing, session, contact and object-encryption keys. Do not put its bytes in command arguments, source configuration, logs or this ledger. Production secret installation and invitation issuance are separate operator actions; no installation happens automatically during build or public lookup.

Create an invitation file:

```sh
node scripts/system-bootstrap.mjs invite \
  --key-file /private/operator/system-bootstrap.key \
  --origin https://accounts.example \
  --handle sys \
  --role system \
  --hours 24 \
  --out /private/operator/system-invitation.json
```

Only reserved handles and roles `system` or `developer` are accepted. Optionally add `--email operator@example.org` to pin the first setup recipient. The CLI generates owner UUID, immutable assignment UUID and nonce; validity defaults to24hours and cannot exceed7days. Output is exclusive0600, key inputs must be private regular files owned by the invoking operator, and symlink replacement is refused. The private invitation JSON contains a `token`; transfer the file through an appropriate private channel. Treat it as a capability. File metadata outside the token is presentation only.

Use `/console?systemBootstrap` to import the file or paste its opaque token into private transient input. Never place it in a URL, Query store, telemetry, local storage or ordinary app preference. The UI first calls same-origin `POST /api/auth/system/bootstrap/begin` to establish a private HttpOnly browser-binding cookie, then submits the explicit invitation/credential/terms/CAPTCHA action. No GET creates an identity or consumes the invitation.

## Durable boundary and interrupted work

The exact-origin, purpose-bound HMAC claims contain the reserved handle, role, owner UUID, assignment UUID, nonce, issuance and expiry. Namespace reservation atomically binds those claims and the setup browser to the protected alias. A durable nonce/full-claims-digest receipt consumes one overall admission, never a free-origin admission. The receipt is retained; no clock, daily cleanup or subscription transition refunds it. No client `signupPlan` can select this internal lane.

Numeric canonical allocation, namespace reservation, overall admission and account creation are separate durable transactions. Recovery preserves their exact owner/assignment and full claim digest; it never frees an uncertain protected alias or creates a replacement identity. Extra unused numeric handles may be burned by interrupted allocation. Acknowledged admission with a missing/corrupt receipt fails closed. The role marker is checked against the reserved namespace on account creation and cannot be added, removed or changed by ordinary account CAS/import.

Expiry is checked again immediately before account creation after credential work; an expired attempt keeps its permanent reservation and consumed stock for explicit reconciliation. Once an account exists, replay of the invitation never returns a fresh setup credential. A lost response after password account creation can resume using the configured password and protected alias. A lost response before passkey registration can require operator repair because no primary credential may yet exist. Expired invitations, lost browser binding, namespace conflicts, unexplained receipts and uncertain unfinished records also need explicit operator reconciliation; there is no automatic reset or namespace recycling tool in this slice. Do not fabricate success or restore old invitation authority by clearing records.

The resulting identity stays pending until primary credential, verified contact and downloaded/tested recovery are complete. Optional pinned email is enforced through first activation, including recovery of an unactivated identity. Its first-activation marker clears only with that successful activation CAS. After legitimate activation, ordinary verified-contact changes and recovery remain possible; the original mailbox does not permanently control the identity. Public badges expose role/handle only, never the pinned email, invitation nonce or setup secret.

Key rotation invalidates outstanding signed invitations but does not alter existing identity credentials or role provenance. Secure backup and explicit repair procedures must preserve the namespace and admission receipts. Local tests use ephemeral keys and injected mail resources; they establish no production account, email delivery or deployed-provider conformance.

## Relationship to the boot token and admin console (2026-10-14)

The [boot and administration design](boot-and-admin.md) adds a separate deploy-token principal, `boot`. Boot and administrators mint reserved-name claim tokens through the ordinary onboarding lane, for day-to-day use. This HMAC invitation lane stays as an offline CLI path. Accounts it creates count as internal for role purposes. Existing assignments and markers stay valid with no migration. `boot` itself can never be the handle of a system invitation.

Boot token CLI (writes a private 0600 file; stdout carries only the non-secret digest):

```sh
node scripts/boot-token.mjs mint --origin https://accounts.example --out /private/operator/boot-token.json
# prints BOOTSTRAP_TOKEN_SHA256=<hex>; deploy that value, then claim within 30 minutes of minting
node scripts/boot-token.mjs digest --in /private/operator/boot-token.json
```

Each token is single-use across claim and restore. To restore lost boot access, mint and deploy a new digest. Never deploy a digest you did not mint yourself.
