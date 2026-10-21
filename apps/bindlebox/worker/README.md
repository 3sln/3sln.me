# BB-B8 application shells

Provisional local implementation, 2026-10-20. No production verification or independent approval is implied.
DEVLOG.md is integrator-owned during this wave; this note supplies the B8 handoff without editing that ledger.

| Decision | Reviewer | Date | Outcome |
| --- | --- | --- | --- |
| SQLite-backed DO KV API and co-transactional recovery alarm | ___ | ___ | ___ |
| Trusted service adapter/verifier interfaces below | ___ | ___ | ___ |
| Monotonic local authorization snapshots and connection binding | ___ | ___ | ___ |
| Slot snapshots/digests, including the classifier shared with B5/X10 | ___ | ___ | ___ |

## Placement and configuration

`../wrangler.jsonc` is the separate app Worker config. It creates a SQLite `MailboxObject` namespace and 64
SQLite link-index shards. It defaults `BINDLEBOX_ENABLED` to `false`, disables workers.dev/preview URLs, and
uses reserved `.example` identifiers. Root Worker configuration and core imports remain untouched.

Run Node with `node apps/bindlebox/node/server.mjs`. It listens on `127.0.0.1:8790`, defaults off, and creates no
database while disabled. `createNodeShell`/`listenNodeShell` accept configured adapters; the CLI optionally loads
a local `BINDLEBOX_ADAPTER_MODULE` exporting `services` and `egress`. A single Node process owns its database
directory. The implementation uses SQLite WAL/FULL, serialized async transactions, and typed BLOB values.

Node and Worker share the mailbox composition, ngin operations and HTTP translator. B4 conversation and B5
organization providers are composed over the same mailbox store. UI, OAuth installation screens, and the storage-setup fragment's
published document are B9/integration work. The placeholder product name lives only in `brand.mjs`.

## Trusted ports and provisioning

Worker bindings `BINDLEBOX_SERVICES` and `BINDLEBOX_EGRESS`, or the equivalent Node objects, are explicit
operator-supplied adapters. None is configured here. They wrap ordinary consented provider APIs, not private
provider internals. All network-backed methods require bounded, restricted egress. Missing authentication,
verification, directory, certification or egress fails closed. Descriptors omit `verifies` because a configured
issuer is not evidence of current directory availability.

`services` implements:

- `authenticate({authorization,method,url})` → `{kind:'owner',owner}` after live app-credential verification.
  Cookies and body/query/forwarding-header owner claims never select a mailbox.
- `resolveKey(query)`, `delegationStatus(query)`: identity directory/pinned continuity and revocation lookup.
- `links({owner,method,input})`: ordinary links contract; `consumerKey` supplies a verified public bridge key.
- `certify({owner,renew,input})`: the ordinary issue/renew delegation contract, authenticated by the app's own
  connection credential. Input contains a public key, fixed purposes and IDKEYS-2's proof of possession.
- `publicJwks()`: the confidential client's public signing keys, separate from per-user delegate keys.
- `verifyIntegration({url,authorization,purpose,resource?,contract?,method?})` → normalized
  `{owner,issuer,connection,generation,purpose,resource?,methods?,grant?,consumer?,live?}`. It MUST perform the
  integrations spec's known-connection-before-fetch, signature, purpose/audience, subject, time, generation,
  resource and method checks. Write methods require fresh live introspection on every request (`live:true`).
  It MUST NOT return `live:true` from cached authorization. The mailbox independently checks current local
  connection/generation/grant state, and rechecks it in each write transaction.
- `verifyEvent({url,token})` → `{owner,issuer,connection,generation,seq,jti,type,payload}` only after every SET
  validation in integrations §6.1. `type` is normalized to the event name, e.g. `connection-revoked`.

`egress.fetch(Request)` MUST implement restricted HTTPS egress with connect-time private-address/DNS screening,
no redirects, cancellation, and network budgets. The engine also enforces connect/total/response bounds. There
is no unrestricted global-fetch fallback. External adapter conformance and actual service availability are
unverified. A populated binding/key is not proof of either.

Trusted code calls `MailboxObject.provision(owner,{receive,authorization})` or `shell.provision` on Node; there
is no HTTP provisioning or generic-dispatch route. `receive` uses the existing `receive.configure` input.
`authorization` is `{revision,active,recipients:[{issuer,subject}],connection?,generation?}`. Revisions only rise;
broker calls require the connection/generation binding. Local recipients are an explicit one-off consent snapshot.
Conversation tasks additionally use B4's live room, accepted-peer, block and incarnation checks inside the queue
transaction; they never derive permission from a signed draft or a browser request. Occupancy changes must be
reflected by the trusted integration adapter. Disconnect removes renewal immediately and cancels pending sends at
the next drain. A resumed SET never reinstalls consent; trusted provisioning installs a newer snapshot.
After the provider's explicit key-delegation consent, trusted installation code dispatches
`shell.delegation-renew` once to acquire the first certificate; subsequent renewal is driven by alarms.

`BINDLEBOX_KEY_ENCRYPTION_KEY` is an operator-supplied 32-byte canonical base64url key (not generated or set by
this workstream). HKDF derives a mailbox key; AES-GCM binds the owner and delegate thumbprint. Only sealed key
material persists, and imported signing keys are non-extractable. Certificates are checked against directory
keys, principal, client, ingress, key thumbprint and all fixed purposes. Renewal keeps the key, schedules at
half-life, persists a retry before network work, and fences a concurrent authorization change at commit.

## HTTP surface

Every endpoint is absent while `BINDLEBOX_ENABLED` is off.

- `POST /bindle/ingress`: bounded protocol delivery, capability-index check, then `receive.deliver` or
  `conversations.receive`. `POST /bindle/ingress/return/:token` routes invitation responses through the durable
  return-capability index to `conversations.respond`.
- `POST /api/send`: prepared signed envelopes and message bytes (`body`: null, byte array or base64url), max
  4 MiB JSON. Returns the engine's committed queue snapshot; it does not claim delivery.
- `GET /api/send`, `GET /api/send/:id`, `POST /api/send/:id/retry`, `POST /api/send/:id/cancel`.
- `GET /api/events`: durable progress JSON, or finite SSE replay with `Accept: text/event-stream` and
  `Last-Event-ID`. Clients reconnect; `reset` requires a snapshot refetch. No idle streaming timer.
- `POST /api/delegation/renew`: dispatches certificate renewal, never returns private material.
- `GET /bindle/client.json`: carries `integration.json` as `bindle_integration`; JWKS at `/bindle/jwks.json`.
- `POST /bindle/resources`, `/bindle/rpc`, `/bindle/events`: verified discovery, mailbox describe/linkRevoked,
  public intake, and SET dispatch. Preference SETs retain bounded snapshots without expanding local grants.

Queue claim/finish/submission/cancellation and their alarms commit together. A crash during remote delivery
leaves a leased obligation and a recovery alarm; retries retain the immutable operation ID and signed bytes.
Final tasks remove the alarm unless renewal or an edge publication remains. Node startup scans persisted
mailboxes and restores alarms without waiting for a request. Edge publication also has durable retry wiring.
Both hosts publish link and pair/return indexes, drain B4's durable conversation work and invitation responses,
and recover unsubmitted conversation operations. None of this changes B4's protocol/state algorithms.

## Verification and remaining integration gates

`tests/bindlebox/worker-shell.test.mjs` runs real workerd with SQLite DOs, commits recipient custody, kills the
runtime during an unresolved ACK, restarts the same persistence directory, and verifies automatic alarm retry,
one recipient effect, receipt persistence, lease spacing, transactional rollback and alarm cleanup. It also
covers Node recovery with no incoming request and HTTP intent translation. `worker-integration.test.mjs`
exercises the owned operations through `tests/bindlebox/helpers/engine`, sealed-key restart, manifest/slot
validation, local broker authority and SET ordering. Test keys/verifiers are fixtures, not configured services.

BB-CUT still needs every other prerequisite, bridge/archive integration and simulator/browser gates; this
workstream does not authorize cutover. Provider directory, introspection, installation/occupancy, ordinary
credential storage and storage-resource adapters require integration and independent review. The classifier
slot exactly snapshots the extensions spec's ordered/any-error example; that policy requires a pinned
read/pure decision-model contract, and B5's consumer remains conservative about ambiguous dispatch failures.

Local gate results (2026-10-20, concurrent Wave 3 checkout): B8's 15 tests pass, including the workerd crash/
recovery, finite SSE RPC transport, conversation index and live peer-authorization checks. Final `npm test`:
1,715 pass, 0 fail, 6 TODO. `test:worker`: 59 pass. `test:ui-state`: 215 pass. `test:dom`, `build:assets`, root
`check:worker` and the separate app's Wrangler dry run pass. Earlier B4/LA3 failures no longer reproduce after
other workstreams' changes landed. Full `test:e2e`: 176 pass, 3 fail (`tests/e2e/signup-views.test.mjs` and two
`tests/e2e/ui-adversarial.test.mjs` cases), 4 WebKit environment skips. B8 did not edit other workstreams' files
to fix these failures. No commit, release, secret provisioning or deployment was performed; all Wrangler
verification used `--dry-run`.
