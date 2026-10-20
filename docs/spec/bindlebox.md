# BindleBox interop v1 — normative draft

Status: **design candidate**, 2026-10-20. Nothing here is implemented, published or production-verified. Identifiers under `https://spec.bindle.example/` and hosts under `.example` are placeholders until publication authority is agreed. MUST/SHOULD/MAY are draft requirements.

Architecture and rationale: [BindleBox architecture](../architecture/messaging-app.md). Extraction: [messaging extraction](../architecture/messaging-extraction.md). Review: [messaging app review](../release/messaging-app-review.md). Protocol/security/interop sign-off: reviewer ___ / date ___ / outcome ___.

This profile defines peer-to-peer messaging between independent messaging apps acting for Bindle identities. It depends on the following core work:

- [protocol](protocol.md);
- [extensions](extensions.md);
- the generic link envelope in [links](links.md) §1–§5 and §7.1–§9;
- [message content](message-content.md);
- the core directory/identity-document profile (unimplemented);
- the `key-delegation.v1` feature (§3, assumed);
- the links contract (§4.2, assumed).

Each assumed core interface is marked **Assumed**, and must be reconciled with its owner before anything is implemented.

It replaces these drafts for peer messaging:

| Draft | Reused | Removed |
| --- | --- | --- |
| [contact delivery](contact-delivery.md) | Envelope, display-string rules, verification order, replay | Bearer RPC, anonymous branches |
| [links](links.md) | Contact type (§6, §6.1–§6.3, delivery half of §7.5) | — |
| [contact endpoints](contact-tokens.md) | — | Legacy `?sig=` and inbox bearers |
| [conversations v1](conversations.md) | — | Central authority, `actor:"bearer"` |

The [scaling spike](../release/messaging-scaling-spike.md) P0 items are answered in architecture §18.

## 1. Terms and identifiers

- **Principal**: a Bindle identity `(iss, sub)`, where `iss` is the provider origin and `sub` is the stable account UUID.
- **Occupant**: the recipient's mailbox resource in the messaging-ingress slot (§2.1), hosted by a messaging app.
- **Ingress**: the occupant's public HTTPS delivery URL.
- **Delegate key**: an app-held P-256 key certified for a principal (§3).
- **Obligation**: a sender's durable duty to deliver one envelope to one recipient.

| Identifier | Value |
| --- | --- |
| Profile | `https://spec.bindle.example/bindlebox/v1` |
| Messaging-ingress slot | `https://spec.bindle.example/slots/messaging-ingress/v1` |
| Mailbox contract | `https://spec.bindle.example/bindlebox/v1/contracts/mailbox` |
| Contact link type | `https://spec.bindle.example/bindlebox/v1/links/contact` |
| Author purpose | `https://spec.bindle.example/bindlebox/v1/purposes/author` |
| Receipt purpose | `https://spec.bindle.example/bindlebox/v1/purposes/receipt` |
| Ingress descriptor media type | `application/vnd.bindlebox.ingress+json` |
| Intake media type | `application/vnd.bindlebox.intake+json` |

## 2. Slot, contract and ingress descriptor

### 2.1 Messaging-ingress slot manifest

This is a slot per [extensions §2](extensions.md#2-slot-manifests). The manifest is immutable at its URL.

```json
{
  "id": "https://spec.bindle.example/slots/messaging-ingress/v1",
  "title": "Receives messages",
  "description": "The one app that receives peer messages, contact links and bridged email for you.",
  "publisher": "https://spec.bindle.example",
  "fields": {
    "occupants": {
      "title": "Messaging app",
      "type": "resource",
      "cardinality": {"min": 0, "max": 1},
      "contracts": ["https://spec.bindle.example/bindlebox/v1/contracts/mailbox"]
    }
  },
  "slot": {"v": 1, "field": "occupants", "selection": "exclusive", "consumers": ["provider", "application"], "supersedes": null}
}
```

A provider that routes links to messaging apps declares `{"slot": "…/messaging-ingress/v1", "role": "consumer", "ref": "messaging-address", "purpose": "Tells senders where to deliver your messages."}`. A messaging app's integration manifest declares `{"slot": "…/messaging-ingress/v1", "role": "occupant", "ref": "mailbox"}`. An app that also accepts bridged email declares an occupant entry for `…/slots/public-message-intake/v1` (the example slot of extensions §4.1), and its mailbox resource implements that slot's contract (§9).

### 2.2 Mailbox contract (provider to occupant)

Provider consumers invoke the mailbox resource over ordinary resource RPC ([protocol §5](protocol.md#5-rpc-transport)) using the brokered consumer credential.

| Method | Args | Result |
| --- | --- | --- |
| `describe` | `{}` | The ingress descriptor body of §2.3, without `expiresAt`. |
| `linkRevoked` | `{jti}` | `{}`. Informs the occupant that the provider revoked a link. |
| `receiveBridged` | §9 | §9 |

`describe` MUST be side-effect free. The provider MUST validate the result against §2.3 before serving it, and treats an invalid result as "no occupant".

### 2.3 Ingress descriptor

The descriptor answers `GET <contact link>` with `Accept: application/vnd.bindlebox.ingress+json` at the link's owner host, once links §8 steps 1–2 have succeeded. The body is JSON:

| Member | Meaning |
| --- | --- |
| `version` | `1` |
| `profiles` | Nonempty array of supported profile identifiers. Includes `…/bindlebox/v1`. |
| `ingress` | Absolute HTTPS URL on the occupant's origin, with no userinfo, query or fragment. |
| `multicast` | Optional absolute HTTPS URL (§7.3). |
| `limits` | `{maxParticipants, maxMessageBytes, maxEnvelopeBytes, maxBatchContexts?}`, each a positive safe integer no larger than the §11 maxima. |
| `kinds` | The link's signed `kinds`. |
| `expiresAt` | Unix milliseconds, at most 1 hour after the response. |

- **Errors.** With no occupant, or an occupant whose `describe` failed validation, the owner host returns `recipient_unavailable`: 503 with `Retry-After` when it knows of a transient binding change, otherwise 404. The body is uniform and reveals nothing about the account.
- **Response headers.** Responses are `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, with credentialless CORS (`*`), and they never vary on cookies.
- **Side effects.** Resolution delivers nothing and consumes no quota.
- **Sender caching.** A sender MAY cache a descriptor until `expiresAt`. On 404, 410 or `ingress_moved` from the ingress, it MUST discard the cache and re-resolve at most once per attempt.
- **Profile negotiation.** A sender MUST pick a profile listed in `profiles`. It MUST NOT downgrade to an unlisted profile or to any unauthored path.

**Resolution by principal.** A conversation peer whose stored ingress fails with 404, 410 or `ingress_moved` re-resolves at `GET {identityURI}/messaging` with the same Accept header. This route is served by the principal's provider under the directory profile (**assumed**).

- It returns the same body, minus `kinds`.
- Responses are credentialless and rate-limited per client network and per principal.
- It discloses only that the principal has an occupant and where its ingress is; the ingress still demands credentials.
- A provider MAY withhold the route when the owner opts out. Peers then rely on the owner's new occupant sending an `ingress` record (§6.3).

Host-wide fetch rules apply to descriptor fetches, ingress POSTs and directory lookups. Senders MUST use HTTPS (loopback only in explicit development), MUST NOT follow redirects, MUST screen private, loopback and link-local addresses at connect time, and MUST bound connect, response size and total time.

### 2.4 Assumed members from integrations

`docs/spec/integrations.md` did not exist when this was written. **Assumed**:

- the brokered-resource consumer credential and the occupant RPC endpoint (cited by extensions §5.3);
- an integration-manifest `webhook` that receives provider events: preference change, identity-key rotation, `linkRevoked`, occupant removal, lifecycle.

The occupant learns its owner's current identity public key from the webhook's key-rotation event and from an initial `identity` read at installation.

## 3. Principals and delegate keys

### 3.1 Author descriptor

`author` is `{principal:{issuer, subject, identityURI}, identityDocument, keyId, delegate}`:

- `keyId` is the principal's identity signing key, exactly as the directory publishes it;
- `delegate` is `"jkt:"` followed by the RFC 7638 SHA-256 thumbprint (canonical unpadded base64url) of the delegate public key.

`identityURI` and `identityDocument` MUST have `issuer` as their origin. Naming is as in contact delivery S13 and stays provisional.

### 3.2 Delegation certificate (core feature `key-delegation.v1`, assumed)

A provider declaring `"key-delegation.v1": {}` in `features` issues certificates to an app installation only after explicit owner consent naming the purposes. A certificate is a compact JWS. Its protected header is exactly `{alg:"ES256", kid:<identity keyId>, typ:"bindle-key-delegation+jwt"}`. Its payload contains exactly:

| Member | Definition |
| --- | --- |
| `bindle` | `"key-delegation"` |
| `v` | `1` |
| `iss`, `sub` | The principal. |
| `delegate` | `{kty:"EC", crv:"P-256", x, y}`, a public key only. |
| `jkt` | RFC 7638 thumbprint of `delegate`. |
| `purposes` | A nonempty, unique, ascending array of purpose URIs. |
| `client` | `{client_id, origin}` of the app installation. |
| `cnx` | Opaque connection-incarnation identifier, 1 to 64 characters. |
| `since` | Unix seconds at which this `jkt` was first certified for this principal and connection. |
| `jti` | Unique certificate ID. |
| `iat`, `exp` | Unix seconds, with `iat < exp ≤ iat + 86400`. |

The JWS rules of links §3.1 apply: strict I-JSON, exact members, received-bytes signing input, and a 64-byte signature. A provider MUST stop issuing certificates for a `cnx` immediately when the connection is revoked or the occupant removed, when the account is suspended, or when the owner revokes the key. Every profile verified against an identity key MUST reject a delegate key, and every profile verified against a delegate key MUST check that the certificate lists that profile's purpose.

### 3.3 Verifying an author

A receiver MUST perform all of these checks:

1. Resolve the principal's identity key under the directory profile, with pinned continuity. A key embedded in the message, certificate or headers is never a trust anchor.
2. Verify the certificate signature with that key, its `typ` and its `bindle` value.
3. Check that `iss`/`sub` equal `author.principal`, that `jkt` equals `author.delegate` and the thumbprint of `delegate`, and that `purposes` contains the author purpose.
4. Check `iat - 60 ≤ now ≤ exp + 60`, and `payload.createdAt ≥ (since - 60) × 1000`.
5. Verify `proof.signature` (§5.3) with `delegate`.

Until the directory profile exists, a receiver can resolve only principals whose provider exposes a directory to it. All other principals are refused with `author_unverifiable` (401), and no network fetch is attempted.

### 3.4 Delegation status (optional, assumed)

`GET {identityURI}/delegations/{jkt}` returns `{status:"active"|"revoked", revokedAt?}`, which receivers MAY cache for up to 5 minutes. For `conversation-init` and for accepting a new peer, a receiver MUST check status, or refuse with `author_unverifiable` (503 with `Retry-After`) when status cannot be determined. For any other record, it MAY rely on certificate expiry. The lookup goes through the same SSRF and fetch budget as directory lookups.

## 4. Contact link type

### 4.1 Meta members

This type is defined over the generic link envelope of [links](links.md) §2–§5. `type` is `…/bindlebox/v1/links/contact`.

The exact meta member set is the common members (links §3.2) plus `sub, resource, kinds, mimeTypes, maxMessages, maxBytes, maxMessageBytes`, with an optional `audience` (links §7.1).

- `kinds` is a nonempty, unique, ascending subset of `["conversation-init","one-off"]`.
- `resource` is an opaque parent identifier at most 128 characters long, meaningful only to the occupant.
- `collections` and tag members MUST NOT appear.

Bounds and quota semantics are those of contact endpoints. On a conditional link, quotas apply per verified author principal per UTC day (links §7.1). An unconditional link MUST reject `bindle_data`.

### 4.2 Issuance (core links contract, assumed)

A messaging app obtains links through a provider-hosted resource implementing `https://spec.bindle.example/contracts/links/v1`, requested by fragment. Its methods:

- `issue({type, claims})` returns `{link, jti}`. The provider fills `iss`, `aud`, `jti`, `iat`, `exp`, signs with the identity key and stores the exact header and claims.
- `revoke({jti})` returns `{}`.
- `evaluate({jti, principal})` returns `{state}`, one of `eligible`, `ineligible`, `unavailable`, under links §7.5 reuse rules.

The provider issues only types that some slot the caller occupies is registered to handle. For this type, that means the caller is the current messaging-ingress occupant.

When the occupant changes, links remain valid. The provider gives the new occupant the list of live link records (`jti` with the exact claims) through the links resource.

### 4.3 Intake configuration

The occupant stores intake per parent, as in links §6.2:

- `revision`;
- `autoTags`;
- `optionalTags` with labels.

These are disjoint, hold at most 32 IDs together, and are updated by compare-and-swap. Intake is owner-private organization. It is not part of the link, the signature or `md`.

### 4.4 Intake representation

`GET {ingress}/intake` with `Authorization: BindleLink <bindle_meta>` and `Accept: application/vnd.bindlebox.intake+json` returns `{version:1, intakeRevision, optionalTags:[{id,label?}], kinds, mimeTypes, maxMessageBytes, quotaScope, expiresAt, conditional, policy?}`. These are the members of links §6.3 minus `form` and `type`.

The request is side-effect free. It MUST NOT disclose `autoTags`, policy tags, quota usage or anything about the requester.

### 4.5 Presenting the link at delivery

A delivery through a contact link sends `Authorization: BindleLink <bindle_meta>` to the ingress. The occupant MUST:

1. parse the value under links §2 rule 4;
2. verify the meta per links §3.3, against the identity key it holds for `sub` and its stored exact claims;
3. check that the link is not revoked by itself or by the provider, and that `type` is this type;
4. check that `payload.recipient.contactId` equals `jti` and `payload.recipient.resource` equals `resource`.

Failures produce the uniform `link_invalid` (401). `bindle_data` MUST NOT be presented at delivery (`link_malformed`).

### 4.6 Conditional links

At admission, the occupant obtains the decision for the author principal through `evaluate`, reusing a decision as links §7.5 permits. `ineligible` is `audience_ineligible` (403). `unavailable` is `audience_unavailable` (503).

## 5. Envelope

### 5.1 Shape

The envelope is exactly `{payload, proof}`. The payload fields are:

| Field | Definition |
| --- | --- |
| `version` | `1` |
| `profile` | `…/bindlebox/v1` |
| `kind` | `one-off`, `conversation-init` or `conversation-record` |
| `noReply` | `true` exactly for `one-off`, otherwise `false` |
| `operationId` | Lowercase UUID, stable across retries |
| `createdAt` | Unix milliseconds, immutable |
| `recipient` | For link kinds: `{issuer, owner, contactId, resource}`, matching the presented link. For `conversation-record`: `{issuer, owner, conversationId, incarnation}`, the recipient principal and its admission incarnation for this author. |
| `content` | `{mimeType, byteLength, sha256}` of the exact body, or `null` for control records without a body |
| `subject` | Plain text, at most 200 code points |
| `optionalTags` | Link kinds only: a sorted, unique subset of the current intake allowlist (at most 32). Empty for records. |
| `author` | §3.1 |
| `conversation` | Required for `conversation-init` (§6.1). Absent otherwise. |
| `record` | Required for `conversation-record` (§6.3). Absent otherwise. |

The parsing rules are those of contact delivery "One semantic envelope":

- display strings carry no `Cc` characters, line or paragraph separators, or bidi controls (S6);
- unknown or duplicate members, nonfinite or unsafe numbers, invalid Unicode and a byte-order mark are rejected;
- no normalization is applied;
- the sender chooses no destination, folder or collection.

Bodies use [message content](message-content.md). The v1 body limit is 1 MiB, and v1 has no separate attachment transfer: the body is the whole custody unit. The envelope limit is 64 KiB.

### 5.2 Domain prefixes

| Signed object | Prefix |
| --- | --- |
| Envelope proof | `bindlebox-envelope-v1\n` |
| Genesis | `bindlebox-genesis-v1\n` |
| Receipt | `bindlebox-receipt-v1\n` |
| Invitation response | `bindlebox-invitation-response-v1\n` |
| Multicast context | `bindlebox-context-v1\n` |

These are added to the [links §7.2](links.md) signature-domain table. They differ from every `bindle-contact-*` prefix, so a contact-delivery v1 signature never verifies as BindleBox.

### 5.3 Proof

`proof` is `{alg:"ES256", kid, delegation, signature}`:

- `kid` is `author.delegate`;
- `delegation` is the compact certificate of §3.2;
- `signature` is canonical unpadded base64url of the 64-byte `r||s` over `prefix || UTF8(JCS({alg, kid, payload}))`, using RFC 8785 JCS.

`delegation` is outside the signed input. A sender MAY replace it with a renewed certificate for the same `jkt` on retry.

### 5.4 Semantic digest and event identity

`semanticEnvelope` is the envelope with `proof.signature`, `proof.delegation` and every nested signature or certificate removed. `payloadDigest = SHA256(UTF8(JCS(semanticEnvelope)))`.

- For `conversation-record`, the **event ID** is `payloadDigest` computed with the `recipient` member also removed. The same author event therefore has one ID across all recipients, while each recipient's delivery context still binds its own incarnation.
- Randomized signature bytes and renewed certificates never change identity.

## 6. Conversations

### 6.1 Genesis and bootstrap

`conversation` is `{genesis, sharedSecret, returnControl}`, trimmed from contact delivery "Conversation bootstrap".

- `sharedSecret` is 256 random bits, encoded as 43-character base64url.
- `genesis` is `{payload, proof}` signed by the creator's delegate key with the genesis prefix. Its payload is `{version:1, profile, conversationId (UUID), createdAt, creator: author descriptor, participants: [{principal, keyId}] (2 to maxParticipants, unique principals, creator and approached recipient each exactly once), secretEpoch (UUID), secretDigest (SHA-256 of the secret), subject, content}`.
- `returnControl` is `{resource, nonce (22-character base64url), expiresAt (at most 7 days after createdAt), maxResponseBytes: 8192}`. It authorizes only §6.2.

The participant list is a **proposal**, not a roster. Receiving it admits nobody. The invitee MUST refuse with `participants_exceeded` (403) when `participants.length` exceeds its own `maxParticipants`.

### 6.2 Invitation response

The invitee POSTs `{payload:{version:1, profile, conversationId, genesisDigest, nonce, decision:"accept"|"decline", responder: author descriptor, ingress, incarnation, createdAt}, proof}` to `returnControl.resource`, signed with the invitation-response prefix.

- `ingress` and `incarnation` are present only on `accept`. `incarnation` is a fresh opaque ID (1 to 64 characters) that the responder will require on records from the creator.
- The creator verifies the responder against the `keyId` in the genesis participant entry, under §3.3, with the status check of §3.4. The origin of `ingress` MUST equal the `client.origin` of the responder's certificate.
- `accept` adds the responder to the creator's accepted-peer set, with the returned ingress and incarnation.
- After `expiresAt` the response is refused with `invitation_expired` (410).

### 6.3 Records

`record` is `{type, conversationId, epoch, counter, previous, parents, target?, data?}`:

- `counter` is the author's monotonic stream position, starting at 1.
- `previous` is the author's prior event ID, or `null` when `counter` is 1.
- `parents` holds at most 8 event IDs.
- `epoch` is the secret epoch the sender used.

| `type` | Body | Members | Receiver effect |
| --- | --- | --- | --- |
| `message` | yes | — | Append. |
| `edit` | yes | `target` (event ID by the same author) | New revision. The original is retained. |
| `retract` | no | `target` (same author) | Tombstone. Suppresses any later render of the target. |
| `peer-proposal` | no | `data:{principal, keyId, ingress}` | Offer to the owner. Never auto-accepted. |
| `peer-response` | no | `data:{proposal (event ID), decision, ingress?, incarnation?}` | Updates the proposer's view of this owner. |
| `rotate` | no | `data:{newEpoch, secretDigest}`. The new secret travels only in the protected `X-BindleBox-Secret` part of §7.1 to accepted peers. | Proposal. Local selection is explicit. |
| `leave` | no | — | Courtesy notice. The receiver removes the author from its outgoing audience. |
| `ingress` | no | `data:{ingress}` | Updates the receiver's ingress binding for this author. Accepted only when the origin of `ingress` equals the `client.origin` of the record's delegation certificate. When principal resolution (§2.3) is available, the receiver also confirms the new ingress there before switching. |

Unknown `type` values are refused (`record_unsupported`, 415). `target` MUST reference an event whose author equals this author. Otherwise the record is `record_forbidden` (403).

### 6.4 Conversation credential

Records travel with `Authorization: BindleConversation <secretEpoch>.<sharedSecret>`. The credential is a pre-authentication gate only. Before any crypto or directory work, the receiver checks that `(conversationId, author principal)` is in its accepted-peer set, that the epoch is one it currently accepts, and that `recipient.incarnation` is its current incarnation for that author. A failure of any of these is the uniform `not_authorized` (403). The secret never appears in URLs, logs, search, notifications, previews or exports without capabilities.

### 6.5 Consent, block and late events

- **Block.** A local block or removal immediately invalidates the author's incarnation. Records from that original author are refused, even when forwarded by others.
- **Re-acceptance** issues a new incarnation, through a `peer-response` or by re-invitation. Records bound to an old incarnation are refused (`incarnation_stale`, 409).
- **Late events.** A valid signature never overrides a newer local block.
- **Equivocation.** Two different events with the same `(author, conversationId, counter)` are equivocation: the receiver keeps both as evidence, quarantines the later one and stops accepting that author's branch until the owner acts.

## 7. Transports

### 7.1 Single delivery

The sender POSTs to `{ingress}` with `multipart/form-data` carrying:

1. an `envelope` part (`application/json`);
2. a `message` part whose Content-Type equals `content.mimeType`, omitted when `content` is `null`;
3. for `rotate` records only, a protected `secret` part (`application/octet-stream`, the 32 secret bytes).

The multipart framing rules of contact delivery "Signed contact URL POST" apply: no preamble, no duplicate or extra parts, only two part headers, no transfer encodings, and inert filenames.

There is exactly one credential: `BindleLink` for link kinds, `BindleConversation` for records. Cookies are not sent. An optional `Idempotency-Key` header MUST equal `operationId`.

### 7.2 Success

The success response is 200 `{receipt}` (§8.1).

### 7.3 Multicast (optional)

Multicast is available when a descriptor names `multicast`. A sender MAY combine deliveries of **one identical body** to recipients whose own descriptors name that same URL. It POSTs to `{multicast}` with `multipart/form-data`:

- a `batch` part: `{version:1, batchId (UUID), content, contexts:[{credential:{scheme:"BindleLink"|"BindleConversation", value}, ingress, envelope}]}`;
- the `message` part.

Every context MUST share `batch.content`, and every `ingress` MUST be one that this host serves. The number of contexts is at most `limits.maxBatchContexts`, which is itself at most 32. The `batch` part is at most 512 KiB.

The response is 200 `{results:[{index, state, receipt?, error?}]}`, with one entry per context in order. `state` takes these values:

| `state` | Meaning |
| --- | --- |
| `delivered` | A receipt for owner custody is included. |
| `accepted-host` | Staged. The sender must reconcile later. |
| `rejected` | Error code included. |
| `unknown` | Outcome not known. |

The host MUST process each context exactly as a §7.1 request to its ingress would be processed: credential, author, budgets, replay and its own owner transaction. An error confined to one context never fails another. An unknown or unauthorized context returns `recipient_unavailable`, so the result for an unknown mailbox matches the result for an unauthorized one. A whole-request failure (400, 413, 429, 503) leaves every context unresolved.

The sender reconciles unresolved contexts with unchanged envelopes, by single POST or by a later batch. It never resends automatically a context that is already resolved. A host MUST charge each context against the recipient allowances that an individual request would consume.

## 8. Receipts, replay, windows and errors

### 8.1 Receipt

`receipt` is `{payload, proof}`. Its payload is exactly `{version:1, purpose:"bindlebox-receipt-v1", recipient: principal, ingress, operationId, eventId?, payloadDigest, bodyDigest, kind, receivedAt, state:"delivered", custody:"complete"}`.

The proof is signed by the recipient occupant's delegate key, whose certificate carries the receipt purpose, using the receipt prefix. It includes `delegation`. The sender verifies the receipt under §3.3 with the receipt purpose.

A receipt proves that the recipient's chosen app took durable custody of these exact bytes under this identity. It does not prove reading, notification, device delivery or consent to anything else.

### 8.2 Replay namespaces

| Kind | Namespace key | Acceptance window |
| --- | --- | --- |
| Link kinds | `(recipient owner, contactId, author principal, operationId)`, as in contact delivery S2 | `createdAt` within 24 h in the past and 60 s in the future |
| Records | `(recipient owner, conversationId, author principal, counter)`, together with `eventId` | 7 days |

For records, the receiver keeps per-author frontiers (the highest contiguous counter) plus explicit gap exceptions. A bare highest-seen counter is not sufficient, because it would discard earlier events that are still missing.

Receipts and fences are kept for 9 days. Retraction and erase anti-resurrection state is kept for the life of the conversation, and is restored together with control generations before any traffic is admitted after a restore.

The same key with a different `payloadDigest` is `operation_conflict` (409). An identical replay returns the stored receipt without another charge, write or notification, after live authorization has been rechecked.

### 8.3 Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `malformed` | 400 | Framing or schema |
| `link_malformed` | 400 | Link value invalid under links §2 |
| `link_invalid` | 401 | Link fails verification |
| `author_unverifiable` | 401 or 503 | Author cannot be verified now |
| `author_required` | 403 | No author |
| `not_authorized` | 403 | Not a peer, blocked, epoch or incarnation failure, host refusal. Uniform. |
| `audience_ineligible` | 403 | Conditional link refuses this author |
| `participants_exceeded` | 403 | Group larger than the invitee accepts |
| `record_forbidden` | 403 | Record targets another author's event |
| `operation_conflict` | 409 | Same replay key, different content |
| `incarnation_stale` | 409 | Record bound to an old incarnation |
| `invitation_expired` | 410 | Invitation response after `expiresAt` |
| `ingress_moved` | 410 | Occupant changed; re-resolve |
| `too_large` | 413 | Over a size limit |
| `record_unsupported` | 415 | Unknown record type |
| `unsupported_profile` | 415 | Profile not supported |
| `rate_limited` | 429 | Admission refused; `Retry-After` set |
| `clock_skew` | 400 | Outside skew tolerance; carries `serverTime` |
| `recipient_unavailable` | 503 or 404 | No occupant |
| `recipient_storage_unavailable` | 503 | Storage resource unavailable; `Retry-After` set |
| `audience_unavailable` | 503 | Conditional decision unavailable |

Bodies are `{error, message}` with a fixed, safe message. Responses are no-store and no-referrer, CORS is credentialless, and redirects are never issued.

**Sender retry rules.** A sender MUST treat every 5xx response, every 429, a timeout and a connection reset as retryable. It MUST retry a timeout or reset with the identical envelope. It MUST NOT retry 400, 403, 409, 413 or 415, except for the single repair step allowed after a 401 or 403 (architecture §9.3).

## 9. Bridged email (provider to occupant)

The occupant of `public-message-intake/v1` implements `receiveBridged`. It is invoked by the provider's `email-bridge` consumer (extensions §5.3) with:

```
args: {
  provenance: <compact JWS, typ "bindle-bridge-provenance+jwt">,
  parts: [{mimeType, dataBase64url}, …],
  rawDigest
}
```

The provenance JWS is signed by the provider's published bridge key (discovered like the app-notification keys). Its payload is exactly `{bindle:"bridge-provenance", v:1, iss, recipient: principal, receivedAt, envelopeFrom, headerFrom, replyTo?, messageIdHeader?, dmarc:"pass"|"fail"|"none"|"unknown", automation: hint labels, ingressFingerprint, normalizedDigest, jti}`. Parts are at most 1 MiB total after the provider's MIME bounds.

The result is `{disposition:"stored-receipt"|"stored-invitation"|"refused"}`, and the occupant MUST return it within 2 s. An ambiguous outcome is not retried at another occupant (extensions §3.2). The provider retries the same occupant with the same `tx`, or treats the outcome as `refused` for reply purposes.

The occupant MUST present bridged items as email-origin with an unverified sender. It MUST NOT sign them as authored by anyone, MUST NOT admit the sender into a conversation, and MUST NOT reply by email. A sender becomes a participant only through the bridge's mailbox-confirmation and identity flow, followed by an ordinary `conversation-init` or invitation response. The provider chooses and sends the auto-reply ([architecture §13](../architecture/messaging-app.md#13-email-bridge-handoff)).

## 10. Portable archive

To keep the user's history portable, the occupant writes to the owner's `object-storage/v1` resource under `bindlebox/v1/`:

- `manifest.json`: `{version:1, generation, segments:[{name, sha256, firstAt, lastAt}], controlGeneration}`, advanced by compare-and-swap;
- immutable JSON-lines segments of records, each `{type, …}`, where `type` is one of `item`, `body-ref`, `peer`, `incarnation`, `frontier`, `tombstone`, `link-parent`, `view`, `rule`, `tag-label`, `overlay`;
- bodies at `bodies/<sha256>`.

Received envelopes are stored with their proofs and certificates as evidence.

Conversation secrets, the incarnations this owner issued, and the peers' ingress bindings are written to a separate `sensitive` segment class. An importer handles that class like a capability: it never renders, indexes or exports it without explicit owner authority.

Delegate private keys are never written to the archive. A new occupant generates its own key and certificate. Peers verify it through the identity key, so no peer has to re-accept. Peers holding the old ingress receive 404, 410 or `ingress_moved` and re-resolve by principal (§2.3).

An importing occupant MUST apply tombstones, frontiers and blocks before it admits any new traffic.

Encryption of segments is a later profile. Until it exists, the archive is plaintext to the storage provider, and the owner MUST be told so.

## 11. Limits

These are the maximum values in v1. Hosts MAY advertise smaller limits.

| Limit | v1 maximum |
| --- | --- |
| Participants per conversation | 32 |
| Body | 1 MiB |
| Envelope | 64 KiB |
| Complete request | 1,500,000 bytes |
| Multicast contexts | 32 |
| Multicast `batch` part | 512 KiB |
| Causal parents | 8 |
| Pending proposals per conversation | 16 |
| Delegation certificate lifetime | 24 h |
| Descriptor cache | 1 h |
| Clock skew | 60 s |
| Link-kind window | 24 h |
| Record window | 7 days |
| Receipt and fence retention | 9 days |

## 12. Security considerations

- **Credentials and authorship are independent.** A link or a secret admits a delivery. The author proof names who is speaking. Neither one substitutes for the other.
- **Delegate key compromise** allows signing as the principal for BindleBox purposes only, until revocation plus the remaining certificate lifetime (§3.2). The status check on first contact and peer admission bounds the most valuable cases.
- **Expanded work.** Multicast, invitations and proposals are charged as the equivalent individual work (§7.3). No receiver fans out on behalf of a sender, and no receiver fetches recursively.
- **Enumeration resistance.** Uniform `link_invalid`, `not_authorized` and `recipient_unavailable` responses prevent enumeration of accounts and mailboxes.
- **Plaintext custody.** Providers and apps see content. This profile is not end-to-end encrypted.

See also [security](security.md) and the [review](../release/messaging-app-review.md).

## 13. Conformance and status

Fixed vectors are needed before publication:

- certificate;
- envelope for each kind;
- semantic digest with a renewed certificate;
- receipt;
- invitation response;
- multicast context;
- negative vectors for the S-rules inherited from contact delivery.

An interop claim requires two independently implemented occupants on separate origins, run through the spike's failure scenarios. A local test pass does not establish interop.

| Surface | Status |
| --- | --- |
| All of the above | Not implemented. Contact-delivery v1 code in `packages/messaging/contact-delivery*.mjs` is the starting point; see [extraction](../architecture/messaging-extraction.md). |
