# Boot token and host administration

Provisional design and local backend implementation, 2026-10-14. This is host/reference-implementation behavior shared by 3sln.me and self-hosted installs. It is not part of the Bindle protocol. Human reviewer: __________ Date: __________ Outcome: __________.

The user direction is recorded in DEVLOG ("Boot token and administrator model direction"). The independent privileged-access review is in [boot-and-admin-review](../release/boot-and-admin-review.md).

## Summary

- **Boot** is a deploy-token principal with the permanently reserved name `boot`. It is not an account: it has no inbox, storage, recovery file, badge or directory entry. One single-use token claims it or restores it. Its access expires after a configured window (default 24 hours).
- **Administrators** are ordinary signed-in internal accounts that hold the built-in `admin` role. Only boot can grant or revoke `admin`.
- **Roles** are privilege bundles. **Badges** are presentation. Both are classified as `internal` (reserved/internal accounts only) or `user` (assignable to anyone). Only boot classifies.
- Every privileged action needs a fresh step-up, goes through a per-actor rate window, and commits under optimistic revisions together with an entry in a hash-chained, append-only audit log.

Modules: [boot.mjs](../../packages/identity/boot.mjs) (token), [roles.mjs](../../packages/identity/roles.mjs) (pure policy), [admin-store.mjs](../../packages/identity/admin-store.mjs) (durable invariants), [admin.mjs](../../packages/identity/admin.mjs) (service), [admin-http.mjs](../../packages/runtime/admin-http.mjs) (routes, not yet mounted), [scripts/boot-token.mjs](../../scripts/boot-token.mjs) (CLI). Tests: [tests/boot-admin.test.mjs](../../tests/boot-admin.test.mjs).

## Boot token

Format: `boot1.<base64url(JSON {v:1, iss, purpose:'boot', ts, nonce, secret})>`. `iss` is the exact `APP_ORIGIN`. `ts` is the mint time in milliseconds. `nonce` is 16 random bytes and `secret` is 32 random bytes, both base64url.

Deployment holds only `BOOTSTRAP_TOKEN_SHA256`, the lowercase hex SHA-256 of the whole token string. The digest is not a secret: the token has 256 bits of entropy, so knowing the digest gives no way to use it. The token never sits in server environment, logs or the durable store.

Verification order (`verifyBootToken`):

1. Bounded syntax check.
2. Constant-time comparison (`secureEqual`) of the computed digest with the configured digest. The comparator is injectable so tests can show it always gets two full 64-character strings.
3. Exact typed claims: `v`, `purpose`, `iss === APP_ORIGIN`, nonce/secret shape.
4. Mint window: at most 30 minutes old, with up to 2 minutes of future skew.

Every failure returns the same `invalid_boot_token`.

**Single use.** The store record `boot-token/<digest>` is the only use counter. It moves `absent → reserved → consumed`. A reservation is the use: it binds the setup browser (hash of the `bindle_setup` cookie), records the WebAuthn registration challenge, and gives a 10-minute completion deadline.

- The first concurrent `start` wins. Another browser always gets `boot_token_consumed`.
- `complete` consumes the token and installs boot in one commit, guarded by the reservation's revision. Two concurrent completes produce one boot.
- The store itself refuses to delete, rewrite or re-reserve a consumed token, and refuses any transition that skips `reserved`.
- An abandoned reservation burns the token. That is deliberate: "one use, then redeploy."
- Consumed records are kept forever. A stale digest deployed again is refused by that record. If the store has been wiped, the 30-minute mint window still refuses it.

**Claim vs restore.** The server decides the mode: restore if a boot principal exists, claim otherwise. Both run the same consume path.

- Claim creates `boot/principal` (generation 1).
- Restore replaces boot's credentials, increments the generation (which invalidates every older boot session), keeps the original `claimedAt`, and re-arms `expiresAt`.
- Administrators, roles and claims are untouched.

**Credentials.** The operator sets one passkey (resident, user-verified, with a dedicated random WebAuthn user ID) or one password of 15–128 characters. There is **no recovery file**. A standing recovery secret for the most privileged principal would outlive its purpose. Lost access is recovered with a new token, which needs deploy authority. `complete` requires `acknowledgeExpiry:true`: the UI must make the operator acknowledge the expiry time and that recovery means redeploying.

**Expiry.** `BOOT_ACCESS_HOURS` (1–72, default 24) sets `expiresAt` from claim or restore. After that, boot sessions, login and step-up return `boot_expired`. Only a new token revives boot. Boot sessions last at most 1 hour and never outlive `expiresAt`. At most three are kept.

## Boot and administrator sessions

- **Boot** uses its own `__Host-bindle_boot` cookie (`bindle_boot` on localhost): HttpOnly, SameSite=Strict, Path=/, plus a JSON-returned CSRF token. It shares nothing with account sessions or the multi-account vault.
- **Administrators** use their normal account session and CSRF. `IdentityService.stepUpBegin`/`stepUp` re-verifies the password or a session-bound passkey assertion and sets `session.stepUpAt`.
- `IdentityService.privileged(context, windowMs)` requires that stamp: 5 minutes for mutations, 15 minutes for reads. Boot step-up works the same way, and boot login counts as a step-up.
- **Explicit actor.** Every console request carries `X-Bindle-Admin-Actor: boot|admin`. The server checks only that credential. There is never an ambient fallback from one to the other, so a page holding both cookies cannot confuse them.

## Roles, capabilities and badge classes

The catalog is stored durably as `{version:1, capabilities, roles, badgeClasses}` ([validateCatalog](../../packages/identity/roles.mjs)):

- **Capabilities** are host-defined IDs such as `support.read`, each with a class. The prefixes `admin.` and `boot.` are reserved and refused.
- **Roles** have a class, a name, a description and a capability list. A `user`-class role may contain only `user`-class capabilities (validation refuses anything else). The built-in `admin` role is implicit, internal, immutable and has no custom capabilities. Custom roles cannot be named `admin` or carry administrator powers.
- **Badge classes** map configured badge IDs to `internal`, `delegable` or `user`. An unclassified badge counts as `internal`, so the default `system` shield cannot be put on ordinary users. An `internal` badge can be assigned only by boot. A `delegable` badge is internal-only, but administrators may assign it.
- **Delegable internal roles.** Boot may set `delegable:true` on an internal role. Administrators can create internal accounts through claims, so the only internal roles they may *add* are delegable ones. Every other internal role stays boot-only (review finding F1).

**Internal accounts.** An account is internal only when verified provenance shows it on every read. There is no stored flag an admin could set. Two kinds of provenance count:

- a valid `bs1` system marker (`systemBadge`), or
- an onboarding marker whose invitation nonce, digest, name, owner and assignment exactly match an admin-minted reserved-name claim record.

Ordinary accounts can never become internal through the console.

**Assignment rules** ([assignmentDecision](../../packages/identity/roles.mjs)):

- Roles must exist (unknown roles fail closed). There are at most 16.
- `internal`-class roles need an internal target.
- Boot may set any valid roles, including granting or revoking `admin`.
- An administrator may not change their own roles, may not touch a target that currently holds `admin`, may not add `admin`, and may add only delegable internal roles.
- Boot is not an account, so no account operation can address it.

The same rules apply to badges (`badgeDecision`), with badge classes taking the place of role classes.

**Catalog edits** (`catalogChangeAllowed`): boot may change anything. An administrator may add, edit or delete only `user`-class roles, using existing `user`-class capabilities. Administrators may never change capability or badge classifications or touch internal roles.

> **Deviation from the coordinator's draft:** the draft gave all capability sets to boot alone. This design lets administrators edit user-class roles. The user's direction said administrators "configure badges and roles". Here they can only rearrange capabilities that boot has already declared safe for anyone, which is equivalent to assigning those capabilities directly.

**Effective authority** (`effectiveAuthority`, also exposed as `AdminService.authority(owner)` for embedders) is recomputed at read time. It drops undefined roles, drops internal roles on non-internal accounts, and drops `admin` on inactive accounts. When boot reclassifies a held role, ordinary holders lose it immediately, with no migration.

## Reservations and claim tokens

**Name sets and precedence:**

- The effective reserved set is: `boot` (always) ∪ `HOST_NAME_POLICY.reserved` ∪ `HOST_NAME_POLICY.onboarding` ∪ durable runtime reservations.
- Static configuration is a floor. It cannot be removed at runtime. A `static` profile record may still store default roles/badges for a statically reserved name.
- Runtime reservations add to the floor. They are refused for names that already have an assignment. A runtime reservation written while a paid claim races in is rolled back if the name turns out to be assigned.
- `unreserve` removes only a runtime record. It refuses if an outstanding claim exists or if the namespace has any assignment or tombstone. Assignments are never released.
- `boot` cannot appear in a policy onboarding list (configuration fails closed), an onboarding invitation, a `bs1` invitation, a reservation or a claim. `configuredReservedName` treats `boot` as reserved even when an explicit policy leaves it out.
- `IdentityService` takes an optional `reservedHandle(name)` hook (`AdminService.isReserved`). Paid-handle claims fail closed on runtime reservations and on hook errors.

**Claim tokens reuse the ordinary onboarding lane (`bo1`):**

1. An administrator or boot mints a claim for exactly one reserved name. Only boot may mint claims for names reserved by deployment configuration (`HOST_NAME_POLICY.reserved` and the defaults such as `ray` or `security`), because the binding is permanent. Administrators mint only for runtime reservations. The claim carries roles, badges and a lifetime of 1–168 hours (default 24, from the reservation profile when omitted). One name per token, so authority is person-specific.
2. The service signs the invitation with `ONBOARDING_KEY` and durably records `claim/<nonce>` (digest, claims, roles, badges, `issuing`). It then runs the existing onboarding `issue` step in-process. That reserves the namespace as `operator-alias` and marks the claim `issued`.
3. The onboarding port gets `runtimeName(name, digest)`. It admits a non-static name only for the exact digest of an `issuing`/`issued` claim. A CLI-signed `bo1` naming the same name with different owners is refused. Static onboarding names still need `ONBOARDING_ENABLED`.
4. The claimant uses the existing `/token-onboarding#token=…` flow, with credential, terms and tested recovery gates. Roles from the claim apply once the account exists. The `principal/<owner>` record is written on the first role change.
5. A link lost in transit is re-derived deterministically (`claimLink`, audited). Only boot or the administrator who minted the claim may retrieve it.
6. `revokeClaim` stops an unstarted claim immediately. It refuses once setup has started. A revoked claim never counts as internal provenance, even if a racing setup completes.
7. **Release of unused claims** (coordinator decision, provisional): `onboardingReserve` indexes each new `preissued` reservation by expiry (`identity-onboarding-expiry/<expiresAt>/<name>`, in the same storage as the namespace row) and arms that storage's alarm for `expiresAt` + 10 minutes. The identity alarm (`IdentityRepository.alarm`: the Node `identities.sqlite` alarm, or the Worker IdentityDirectory namespace-bucket alarm) runs `onboardingSweep`. In one transaction with the row, it deletes only an `operator-alias` row still `preissued`, unbound, unadmitted, without a canonical handle, whose digest and expiry match the index entry, once past the grace. It never touches assigned, allocated, paid, system, claiming or consumed rows, names in `HOST_NAME_POLICY` (reserved or onboarding, including the defaults) or `boot`. Because release and `onboardingClaim` are transactions on the same row, exactly one wins. Revoked claims are released at their expiry, not at revocation. The runtime reservation and the expired admin claim record stay, so the name is still reserved until an administrator unreserves it or mints a new claim. Rows written before this change have no index entry and are not swept.

**Existing system invitations:** the `bs1` HMAC CLI path stays as an offline, immutable-marker lane. Its accounts count as internal. Existing assignments stay valid with no migration. Admin-minted claims replace it for day-to-day use.

## Administrator operations

All are POST, step-up gated, rate-limited per actor (60 mutations or 300 reads per 10 minutes, counted in the same transaction as the action) and audited:

- **Reservations:** reserve or update a profile, unreserve.
- **Claims:** mint, retrieve link, revoke.
- **Catalog:** edit, within the rules above.
- **Users:** look up one user by exact handle, account UUID or verified email; set roles or badges; suspend or reactivate.
- **Read-only:** overview, list principals, read the audit log. Overview and principal listing are rate-limited and audited. The audit read itself is the only unaudited read.

**Lookup** returns ID, handle and aliases, status, timestamps, badge IDs, internal/provenance, roles, effective authority, a masked email (`p***@example.org`) and the principal revision. It never returns password or recovery hashes, credentials, sessions, CSRF tokens, setup or pending state, or the full email. The audit log records only the masked email query. There is no prefix search, scan or export.

**Suspension** applies only to `active` accounts. It sets status `suspended`, clears sessions, and records an admin hold on the principal. Reactivation lifts only an admin hold. It never overrides lifecycle states. Administrators cannot suspend themselves or another administrator; boot can.

**Lifecycle freeze** (coordinator decision, provisional): reactivation records `lastHold {at, releasedAt}` on the principal (role writes keep it). `AdminService.lifecycleHold(owner)` is a trusted port, not an HTTP operation, returning `{held, since, releasedAt}`. `AccountLifecycle` now requires an `adminHold` port. A held or unreadable hold stops every automatic step: no notices, no warning→suspended, no suspended→purge-review. The hold is checked again after finance review, before any transition. A release, including one that happened between two steps, resumes once: active and warning return to `active` with a fresh inactivity clock. Suspended and purge-review return to `suspended` with a fresh notice episode, so a full notice and grace cycle must run again. Paid protection is still evaluated first. `planAccountLifecycle` takes the same `adminHold` option. **Not wired:** `AccountLifecycle` is an unintegrated draft. No scheduler runs warnings, suspension or deletion today, and the Worker `scheduled` handler deletes nothing. The port takes effect only when the lifecycle executor is integrated with `adminHold: owner => admin.lifecycleHold(owner)`.

## Audit log

`audit/<seq>` entries contain `{at, actor{kind, owner?, handle?, session}, action, target, before, after, seq, prev, hash}`, where `hash = SHA-256(prev + canonical entry)`.

- An entry is appended only inside the same store transaction as the change it describes. There is no write or delete API for audit keys, and `verifyAudit` re-walks the chain.
- Cross-store edits (badges, suspension) commit their store writes (such as the suspension hold), the target revisions they decided on, and an `intent` entry in one transaction. The identity compare-and-swap follows, then an `applied`/`failed` entry together with any compensating writes.
- Audit reads verify the returned page against the previous entry's hash. `{verify:true}` re-walks the whole chain. Entries are JSON-normalized before hashing.
- Both boot and administrators can read the log. Boot step-up, login and logout are also audited. The only unaudited write is the unauthenticated boot login-challenge housekeeping.

The chain shows tampering by anyone who edits storage without rewriting every later entry. It cannot stop a storage administrator who recomputes the whole chain. Anchoring the head externally is an open option.

## Durable state

There is one linearizable authority: a SQLite file on Node, or one Durable Object (proposed `ADMIN_AUTHORITY`, name `admin-v1`) on Workers. Keys: `boot/principal`, `boot/sessions`, `boot-token/<digest>`, `catalog`, `reservation/<name>`, `claim/<nonce>`, `claim-name/<name>`, `principal/<owner>`, `audit/<seq>`, `audit-head`, `rate/<actor>`. `AdminStorage.commit({expect, writes, audit, rate})` is the only write. It checks every expected revision, enforces the token and audit invariants, and assigns revisions.

The service always includes the actor's own record and the target's role and claim records in `expect`: the administrator's `principal/<owner>` and the catalog, or boot's `boot/principal`. So revoking an administrator, editing the catalog or restoring boot makes in-flight decisions fail with `conflict` instead of applying them.

## Admin console (later UI slice): screens and API

All endpoints are `POST /api/admin/...` with the exact `Origin`, `X-CSRF-Token` and `X-Bindle-Admin-Actor` headers.

1. **Boot setup** (`/console?boot`, token pasted or imported from the CLI file, never put in a URL):
   - `boot/begin` sets the setup cookie.
   - `boot/status` returns `{configured, token: unused|reserved|used}`.
   - `boot/start {bootToken}` returns `{mode: claim|restore, registrationOptions, completeBy, accessMs}`.
   - The operator chooses passkey or password and ticks a mandatory acknowledgement such as "Boot access ends at <time>. Lost access needs a new token and redeploy."
   - `boot/complete` sets the boot cookie.
   - Clear errors for consumed tokens, expired setup and wrong origin.
2. **Boot sign-in / step-up:** `boot/login/begin`, `boot/login`, `boot/step-up`, `boot/logout`. A persistent countdown banner shows the time to `bootExpiresAt` and, at expiry, explains the redeploy path.
3. **Administrator step-up:** `step-up/begin` and `step-up` (password or passkey) using the normal account session. A modal opens whenever an operation returns `step_up_required`.
4. **Overview** (`overview`): actor, boot status (active, expires at, last restored, token digest prefix), catalog and revision, badge classes, static and runtime reservations, recent claims, audit head. Administrators see a prominent notice when boot is active or was restored recently. That notice is how they spot an unexpected restore.
5. **Reservations:** `reservations/set {name, roles?, badgeIds?}`, `reservations/remove {name}`.
6. **Claims:** `claims/mint {name, roles?, badgeIds?, hours?}` returns `{link, expiresAt, nonce}`. Show the link once, with copy, and a reminder that it is a bearer capability. Also `claims/link {nonce}` and `claims/revoke {nonce}`.
7. **Roles and capabilities** (`catalog {catalog, expectedRevision}`): class and capability controls are disabled for administrators and explained as boot-only.
8. **Users:**
   - `users/lookup {handle|owner|email}`
   - `users/roles {owner, roles, expectedRevision}`
   - `users/badges {owner, badgeIds}`
   - `users/suspend` and `users/reactivate {owner}`
   - Show only the classes the target may receive. Present administrator targets read-only to administrators.
   - `principals {startAfter?}` for paging.
9. **Audit** (`audit {fromSeq?}`): entries with before/after diffs, chain verification status and the actor for each row.

### Console implementation notes (frontend slice, 2026-10-14, provisional, unsigned)

The console is implemented in `apps/web/src/admin-entry.mjs` (loaded only on `/console?boot` or `/console?admin`) and `apps/web/src/admin-console.mjs` (operations, dynamically imported only after a boot session or administrator authority is confirmed; excluded from the service-worker precache). Review: [admin-ui-review](../release/admin-ui-review.md). Narrow backend additions for it, following the coordinator's provisional decisions:

- `boot/session` (POST, boot cookie + exact Origin, no step-up granted) returns the boot session's CSRF token and expiries so a reload does not need a new sign-in.
- `boot/end {confirm:'end-boot-access'}` (mutation step-up) lets boot end its own access early: status `ended`, all boot sessions dropped, audited as `boot.end`; only a new token restores it.
- `access` (administrator actor, account session + CSRF, no step-up) tells the signed-in account only whether it holds administrator authority.
- `step-up` through the admin routes accepts only `method:'passkey'` (`passkey_required` otherwise).
- Overview claims carry `linkAvailable` (boot, or the minting administrator).
- `step-up/end` withdraws the account session's step-up (used on leaving the console); `boot/logout` always clears the boot cookie; `boot/begin` is rate limited (`boot-begin`: 5/min and 20/h per IP pseudonym, 200/h global).

## Required wiring (root/coordinator)

`admin-http.mjs` is not mounted. Proposed hunks:

- `packages/runtime/http.mjs`: `import {adminRoutes,adminPath} from './admin-http.mjs';`. Inside the `/api/` block, right after the `context` object is built and before `accountPath`: `if(adminPath(path))return await adminRoutes({path,request,env,local,context,body,json});`. Change the onboarding gate to `!(onboardingEnabled(env)||env.ADMIN_CLAIMS_ENABLED===true)` so admin-minted claims work without static onboarding names.
- `apps/node/resources.mjs`: `const adminDb=new SqliteMetadata(join(directory,'admin.sqlite')),adminStore=new AdminStorage(adminDb);`. Return `adminStore` and close `adminDb`.
- `apps/node/server.mjs` and `apps/worker/index.mjs`: build one shared identity resource object. Pass `reservedHandle:name=>admin.isReserved(name)` and an onboarding port with `runtimeName:(n,d)=>admin.runtimeName(n,d)`. Set `ports.ADMIN_SERVICE=()=>admin`, where `admin=new AdminService({store,identity:new IdentityService(sameResources),onboarding,webauthn,passwordHasher,rateLimiter,config:settings})`. Set `ADMIN_CLAIMS_ENABLED` when `ONBOARDING_KEY` is valid.
- `apps/worker/objects.mjs` + `wrangler*.jsonc`: `export class AdminAuthority extends DurableObject{constructor(ctx,env){super(ctx,env);this.storage=new AdminStorage(ctx.storage);}invoke(method,args){return this.storage.invoke(method,args);}}`, a binding `ADMIN_AUTHORITY`, and a new `new_sqlite_classes` migration. The Worker store is `remoteAdminStore((m,a)=>env.ADMIN_AUTHORITY.get(env.ADMIN_AUTHORITY.idFromName('admin-v1')).invoke(m,a))`.

## Threat notes

- **Token theft:** the token lives only in the operator's 0600 file and transient browser memory. A stolen token is usable for at most 30 minutes from mint, and only if nobody has used it yet. The first use binds a browser.
- **Deploy race:** deploy promptly after minting and claim at once. `boot/status` shows `reserved` or `used` if someone else got there first, and the audit log keeps the attempt.
- **Social engineering of restore:** restore requires changing deployment configuration to a digest. Operators must mint their own token and never deploy a digest someone else supplied. Restores are audited and shown prominently to administrators.
- **Confused deputy:** the explicit actor header, separate cookies, and boot not being an account mean neither credential can act as the other.
- **Malicious administrator:** an administrator can create runtime-reserved internal accounts, but can give them only user-class roles, delegable internal roles and non-internal badges. Boot should mark a role or badge delegable only when it would trust any administrator to hand it out. Administrator creation, static-name claims and everything else internal stay boot-only.
- **Known limits:** boot password guessing is limited per IP only. `boot/status` publicly shows whether a live digest is unused. Boot cannot end its own access early. Restore does not undo administrators created by a compromised boot; boot must revoke them explicitly. Claims minted by boot stay usable until their own expiry, even after boot expires.

## Open questions

1. ~~Release for unused claims~~: decided (coordinator, provisional). See step 7 under claim tokens.
2. Should badge *definitions* become runtime-editable? Today they stay `BADGE_DEFINITIONS` configuration, and only classification and assignment are runtime state.
3. Should the audit head be anchored externally (for example, periodically emailed to the operator)?
4. ~~Admin suspension lifecycle freeze~~: decided (coordinator, provisional). See **Lifecycle freeze**. Production wiring waits for the lifecycle executor.
5. Should administrators need a passkey, rather than allowing password-only step-up?
6. Should boot be able to end its own access early, and should outstanding claims minted by boot be revoked when boot expires?
