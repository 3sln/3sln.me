# Event buses — normative draft

Status: **provisional draft, 2026-10-20, revision 2.** Revision 1 was wargamed by two independent reviewers, and revision 2 answers their findings ([events and consent review](../release/events-consent-review.md)). The revision 2 fixes have not been independently re-reviewed. Rationale and host UX: [consent experience](../architecture/consent-experience.md). User direction: [DEVLOG, "Event buses, rich consent and incremental authorization"](../../DEVLOG.md#2026-10-20--event-buses-rich-consent-and-incremental-authorization-user-direction). Human sign-off: reviewer ___ / date ___ / outcome ___. Nothing here is implemented or production-verified.

This document extends [protocol §3–§5](protocol.md), [contracts](contracts.md), [extensions](extensions.md) and [integrations](integrations.md). It defines interoperability rules only. It defines no user interface beyond the security disclosures it lists, and no SDK behaviour. Identifiers under `https://spec.bindle.example/` are placeholders. MUST/SHOULD/MAY express draft requirements. §14 lists the core amendments this draft needs. They are **proposed and unsigned**.

## 1. Model and the reuse decision

An **event bus** is an append-only, ordered, bounded log of small typed records belonging to one entity. Applications and provider features publish records to it and read them from it.

**Decision: a bus is not a new primitive.** It is assembled from existing mechanisms:

| Concept | Existing mechanism | Consequence |
| --- | --- | --- |
| What a kind of bus means: its purpose, payload schema, retention and ordering, who may publish and read | A **bus manifest**: a [slot manifest](extensions.md#2-slot-manifests) with selection `exclusive` and a critical `slot.bus` member (§2) | Public, immutable and digest-pinned, with the same fetch, bound and versioning rules as every fragment |
| One entity's bus of that kind | The slot's single **occupant**: an entity-owned resource implementing the [`event-bus/v1` contract](#4-the-event-bus-contract) | It lives in the owner's resource pool. The owner chooses it, and can remove or replace it. |
| Who hosts the bus | The occupant's hosting: provider built-in (§3.1) or a [brokered](integrations.md#5-brokered-resources) integration resource (§3.2) | "Who hosts" is an owner choice, with no new mechanism |
| Read, write or readwrite access | An ordinary fragment grant on the bus manifest, with exact methods (§5) | It shows up in every grant listing, revocation path and token check that already exists |
| Push delivery to integrations | The integration SET channel and its transactional outbox ([integrations §6](integrations.md#6-events), EXT-X6) | A new doorbell event type only (§7.2) |

**Why the reuse fits.** Three alternatives were weighed.

- *A new `bus` primitive with its own grants.* Rejected. It would duplicate grant storage, revocation, consent and "who has access" listings, and every provider would have to implement a second authorization model.
- *A bus as a plain contract with no manifest.* Rejected. A contract fixes methods, but buses differ in payload schema, purpose and retention. Pinning those per bus kind needs a public immutable document, and the fragment/slot document is the existing one.
- *A bus as an ordinary non-slot fragment.* Rejected. Hosting choice, the owner-only occupant assignment, the no-preselection rule, replacement review and provider consumers would all have to be re-specified. Slots already specify them.

A bus therefore adds **one contract, one slot member and one event type**. It adds no authorization primitive, no token type, no RPC transport and no new endpoint kind. A provider without this feature sees an ordinary fragment with a resource field (§12).

## 2. Bus manifests

A bus manifest is a slot manifest ([extensions §2](extensions.md#2-slot-manifests)) that meets these conditions:

- `slot.selection` is `exclusive`, so `fields[slot.field].cardinality` is `{"min":0,"max":1}`;
- `fields[slot.field].contracts` is exactly `["https://spec.bindle.example/contracts/event-bus/v1"]`;
- `slot.crit` contains `"bus"`;
- `slot.bus` is valid under §2.1.

The manifest MUST NOT contain fields other than the bus field. Owner settings for a bus belong to its host, not to a shared fragment, so consumers cannot read them as configuration.

```json
{
  "id": "https://tasks.example/buses/task-changes/v1",
  "title": "Task changes",
  "description": "A record each time a task is created, completed or reassigned.",
  "publisher": "https://tasks.example",
  "fields": {
    "bus": {"title": "Task changes bus", "type": "resource", "cardinality": {"min": 0, "max": 1},
            "contracts": ["https://spec.bindle.example/contracts/event-bus/v1"]}
  },
  "slot": {
    "v": 1, "crit": ["bus"], "field": "bus", "selection": "exclusive",
    "consumers": ["application", "provider"],
    "bus": {
      "v": 1,
      "types": ["created", "completed", "reassigned"],
      "payload": {
        "type": "object", "additionalProperties": false, "required": ["task"],
        "properties": {
          "task": {"type": "string", "maxLength": 128},
          "title": {"type": "string", "maxLength": 200},
          "assignee": {"type": "string", "maxLength": 320}
        }
      },
      "max_record_bytes": 2048,
      "retention": {"min_seconds": 3600, "max_seconds": 604800},
      "publishers": ["application"],
      "readers": ["application", "provider"],
      "history": "owner-choice",
      "categories": ["personal-data"],
      "effects": {
        "read":  {"en": "See tasks as they are created, completed or reassigned, including titles and assignees."},
        "write": {"en": "Add task changes that other connected apps will see."}
      }
    }
  }
}
```

### 2.1 The `slot.bus` member

| Member | Required | Meaning and bounds |
| --- | --- | --- |
| `v` | yes | `1`. |
| `types` | yes | 1–32 record type names, each matching `^[a-z][a-z0-9.-]{0,47}$`. Every record carries exactly one of them. |
| `payload` | yes | The record payload schema, in the bus schema subset (§2.2). It applies to every type. Publishers that need per-type shapes use optional properties. |
| `max_record_bytes` | yes | 64–16,384. The maximum UTF-8 JSON size of a record's `data`. A host MAY enforce a smaller limit and advertises it (§4.4). |
| `retention` | yes | `min_seconds` (0 or more) and `max_seconds` (1–2,592,000, which is 30 days). A host retains records for at least `min_seconds` and at most `max_seconds`, subject to the record cap (§4.4). A host that cannot honour `min_seconds` MUST NOT become this bus's occupant. |
| `publishers` | yes | A nonempty subset of `application` and `provider`: who may hold `publish`. |
| `readers` | yes | A nonempty subset of `application` and `provider`: who may hold `read` and `subscribe`. Each value MUST also appear in `slot.consumers`. |
| `history` | no | `"never"` (default) or `"owner-choice"`. Whether a new reader may see records published before its grant (§6.3). |
| `categories` | no | The sensitivity categories of [incremental authorization §8.3](incremental-authorization.md#83-sensitivity-categories). They can only raise risk. |
| `effects` | yes | Plain-text descriptions, one for `read` and one for `write`. Each is a map from BCP 47 tag to a string of at most 200 code points, with at most 8 tags, and MUST include `en`. They are publisher-attributed consent text (§10.3). |

There is no ordering member: every bus is totally ordered (§6.1). There is no delivery member: every bus supports pull, and push is a host capability (§7). Neither choice is a per-manifest decision in v1.

**Validation.** A `slot.bus` that fails any rule makes the slot **invalid**. Under [extensions §2.2](extensions.md#22-validation-and-unrecognized-slots), the document is then processed as an ordinary fragment without slot semantics. A provider that recognizes `slot` but not `bus` treats the slot as unrecognized, because `bus` is in `crit`. Either way, no provider applies only part of the bus semantics.

### 2.2 Bus schema subset

`payload` is a JSON Schema (2020-12) document restricted to the keywords below. Any other keyword, `$ref`, `$defs` or remote reference makes the manifest invalid.

- `type` (one of `object`, `array`, `string`, `integer`, `number`, `boolean`, `null`, or an array of them), `enum` (at most 64 values), `const`;
- for objects: `properties`, `required`, and `additionalProperties`, which MUST be `false`;
- for arrays: `items` and `maxItems`, which is required and at most 256;
- for strings: `maxLength`, which is required and at most 4,096, and `format`, limited to `uri` (HTTPS only), `date-time` and `uuid`. `pattern` is forbidden, because it would let a manifest impose catastrophic-backtracking cost on hosts;
- for numbers: `minimum`, `maximum` and `multipleOf`. Integers MUST stay within the safe integer range.

Nesting depth is at most 6. Across the whole schema there are at most 128 properties. The serialized manifest stays within the 16 KiB slot bound. Every string and array is bounded, so a valid record's worst-case size can be computed from the schema. `max_record_bytes` still governs.

### 2.3 Versioning

A bus manifest is immutable at its URL. Any change to `payload`, `types`, `publishers`, `readers`, `history`, `categories` or `retention` requires a new URL, which is a **new bus**. The new manifest MAY name its predecessor in `slot.supersedes`. Under [extensions §7](extensions.md#7-versioning-change-and-disappearance), a provider MAY offer the owner a migration step that assigns a new bus. It never copies records or grants. Producers that need a transition period publish to both buses under separate grants.

So the "payload schema version" is the manifest URL. Records carry no schema version member, and a consumer reading one bus never meets two payload shapes.

## 3. Hosting

The owner chooses the single occupant under the ordinary slot rules ([extensions §5.1](extensions.md#51-assigning-occupants)):

- only the owner assigns it;
- no candidate is preselected, including the built-in;
- candidates are ordered neutrally;
- replacing it shows every affected consumer.

### 3.1 Provider-hosted buses

A provider that declares `events.v1` with `hosting: true` (§13) offers a **generic built-in occupant** for every valid, recognized bus manifest, without a per-manifest `extensions` declaration. This is the one generalization of the built-in rule ([extensions §4.2](extensions.md#42-what-declarations-mean)), and it is needed because a provider cannot list every bus manifest that will ever exist. The provider creates the bus resource in the owner's pool only on an owner action, and only once per (entity, bus manifest). It is an issuer-hosted resource, so:

- revocation is immediate (protocol §4);
- RPC goes to the issuer endpoint with ordinary tokens;
- push delivery (§7.2) is available.

A provider MAY limit the number of hosted buses per entity (§9), and MAY block bus manifests under [extensions §7](extensions.md#7-versioning-change-and-disappearance) policy.

### 3.2 Integration-hosted buses

An integration that declares an `occupant` extension for a bus slot, and whose discovery returns a resource claiming `event-bus/v1`, can host the bus as a brokered resource. Every rule of [integrations §4–§7](integrations.md#4-resource-discovery) applies. In addition:

- `publish` is write-capable. Under [AMD-C8/C10](integrations.md#57-introspection), the hosting integration MUST introspect live before executing every `publish`, without cached authorization (§4.1 marks it `introspect: true`). An integration whose provider lacks `introspection_endpoint` cannot host buses that have application publishers.
- `read` follows the 360 s bounded revocation for read-only brokered access (integrations §7.3). Consent discloses this (§10.2).
- **Brokered buses are pull-only in v1.** Only the provider signs SETs, so only provider-hosted buses get push doorbells. A brokered host MUST reject `subscribe` with `unsupported_method`.
- The host attests publishers from the verified brokered token's `client_id` (§6.2). Consumers rely on the host for attribution, and consent says so.
- **Reader floor on brokered buses.** The provider cannot see a brokered bus's head, so it states the floor as a time. Every brokered token for `read` carries the claim `bindle.bus: {"floor_at": <Unix seconds of first read approval>, "history": true|false}` (AMD-C15). The host MUST return only records with `published_at` > `floor_at` unless `history` is `true`. An app MUST NOT assume a reader floor on a brokered bus whose tokens lack this claim.
- **Introspection load.** The provider rate-limits introspection per (integration, connection), at 120 per minute on the reference host, and counts each call as one activity unit on the account meter. An exhausted budget makes introspection answer `active: false`, so the publish fails closed.
- **Brokered hosts learn readers.** The host sees each reader's `client_id` in its tokens. Consent discloses this (§10.2).

### 3.3 Why both are allowed

Provider hosting is the safe default for personal data, because revocation is immediate and the provider meters cost. Integration hosting covers buses whose natural home is the producing service, and keeps such data out of the provider. Every brokered publish costs the provider a live introspection call (§3.2), so integration hosting does not suit high-volume buses in v1. The owner sees the host's verified origin before assigning it, and the choice is reversible: replacing the occupant creates a new, empty bus. **Records never migrate between hosts.** Migration would require the old host to hand data to the new one, which is exactly the kind of cross-party flow brokering avoids.

## 4. The event-bus contract

ID: `https://spec.bindle.example/contracts/event-bus/v1` (placeholder). Arguments reject unknown members. RPC follows protocol §5, including the transaction journal.

| Method | `x-methods` metadata | Arguments | Result |
| --- | --- | --- | --- |
| `publish` | `effect: "write"`, `introspect: true` | `{type, data}` | `{receipt, published_at}` |
| `read` | `effect: "read"` | `{cursor}`, `{start}` or neither; optional `limit` (1–100, default 50) and `wait` (0–25 seconds, default 0) | `{records, cursor, head, oldest, gap}` |
| `subscribe` | `effect: "write"` (it writes subscription state, not the bus; consent presents it as part of read access, §5) | `{}` | `{subscribed: true}` |
| `unsubscribe` | `effect: "write"` | `{}` | `{subscribed: false}` |

The bus occupant also implements [resource-descriptor/v1](contracts.md#resource-descriptor-v1) and reports the §4.4 limits.

### 4.1 `publish`

- The host validates `type` against `types`, `data` against the pinned `payload` schema, and the size against `max_record_bytes` and its own limit. A failure returns `invalid_args`, and nothing is stored.
- **The journal is the dedup mechanism.** `tx` is the idempotency key under protocol §5. A repeated `tx` with the same fingerprint returns the original result, and with a different fingerprint returns `tx_conflict`. Hosts MUST keep publish journal entries for at least 24 hours or the bus's `retention.max_seconds`, whichever is shorter, **but never less than 10 minutes**, and advertise the value as `txRetentionSeconds`.
- On success the host assigns the next `seq` and stamps `publisher` and `published_at` (§6.2). Record and head update commit atomically.
- **`receipt` is opaque** and at most 128 characters, unique per record and meaningful only to the host. It is not the global `seq`. A publish-only app would otherwise learn the bus's total activity, including other publishers' timing, by publishing periodically. A publisher with read access can find its record's `seq` by reading.
- A publisher MUST NOT retry an `indeterminate` publish under a fresh `tx` (protocol §5).

### 4.2 `read`

- `start` is `"oldest"` or `"latest"`. `cursor` is an opaque string of at most 512 characters from an earlier result for the same bus and grant. With neither, the default is `"latest"`.
- `records` is a list of records in `seq` order (§6.1). All of them are visible to this reader (§6.3), and they fit within the reader's `limit` and the host's response bound.
- `head` is the latest `seq` visible to this reader. `oldest` is the earliest retained `seq` visible to this reader, or `null` if there is none. **`head`, `oldest` and `gap` are computed only over records above the reader's floor (§6.3)**, so none of them reveals activity before the floor. A cursor that points below the floor resumes at the floor without reporting a gap.
- `gap` is `null`, or `{from, to}`: the `seq` range the reader asked for that is no longer retained. **Hosts MUST report a gap rather than silently skip it.** A cursor older than retention yields a gap and resumes at `oldest`.
- With `wait > 0` and no newer records, the host holds the request until a record arrives or `wait` elapses, then answers. This is long-polling. Hosts MAY cap `wait` lower and MUST bound concurrent waits (§9).
- `read` never writes host state. **Cursors are held by the client.** A cursor is bound by the host, for example by MAC, to (bus resource, connection or client, reader floor, position). It is not bound to the grant identifier, which changes whenever a grant is widened, so a widening does not invalidate cursors. A cursor presented by another client, under another floor, or after the read grant was revoked and re-approved with a new floor, fails with `invalid_args`, and nothing is revealed. Forged or foreign cursors fail the same way.

### 4.3 `subscribe` and `unsubscribe`

`subscribe` registers the calling integration's connection for doorbells (§7.2). It is allowed only when all of these hold:

- the host is the provider (§3.1);
- the caller is an integration with a valid `events_endpoint` whose pinned manifest `events` list includes `bus-advanced/v1`;
- the caller's grant includes `read` and `subscribe`.

Otherwise it returns `unsupported_method` or `forbidden`. A subscription is keyed by (bus resource, connection, grant). It is deleted by the same commit that revokes or replaces that grant, suspends or disconnects the connection, or removes the bus. `subscribe` is idempotent.

### 4.4 Host limits (descriptor `limits`)

`maxRecordBytes`, `retentionSeconds` (the effective value, within the manifest range), `maxRetainedRecords`, `maxRetainedBytes`, `publishPerMinute` (per publisher), `maxWaitSeconds`, `push` (boolean), `txRetentionSeconds`, plus the descriptor's standard `maxRequestBytes` and `maxResultBytes`. When the record or byte cap is reached, the oldest records age out first, and readers see a `gap`. A publish never fails because of retention.

## 5. Access modes and grants

Access is requested and granted as an ordinary fragment request for the bus manifest ([protocol §3](protocol.md#3-fragments-and-preference-values)), with methods on the bus field's `event-bus/v1` contract.

| Mode (presentation name) | Methods in the request | Who may request it |
| --- | --- | --- |
| read | `read`, plus `subscribe` and `unsubscribe` when push is wanted. Presented as one read capability, because push adds no data access. | Parties listed in `readers` |
| write | `publish` | Parties listed in `publishers` |
| readwrite | the union of both | Parties in both lists |

Rules:

- A request that names `subscribe` or `unsubscribe` without `read` is invalid. A provider declaring `events.v1` MUST refuse a request for a method whose mode the manifest excludes for applications.
- The owner may approve a subset, for example read but not write. The outcome is then `partial`, with the exact approved methods ([incremental authorization §6](incremental-authorization.md#6-outcomes)).
- Grants bind the pinned manifest digest. A bus grant never covers another bus manifest URL, not even a successor.
- **Owner-only operations are not contract methods.** Purging every record, deleting the bus, changing effective retention and reading subscription health are host owner-interface actions. No app grant reaches them.
- A provider feature that reads or publishes (`provider` in `readers` or `publishers`) does so only through an explicit owner enablement under [extensions §5.3](extensions.md#53-provider-consumers), and appears in the bus's access list.

## 6. Records, ordering and visibility

### 6.1 Record shape and ordering

```json
{"seq": 4182, "type": "completed", "published_at": 1792500123,
 "publisher": {"kind": "application", "client_id": "https://tasks.example/bindle/client.json",
               "origin": "https://tasks.example"},
 "attested_by": "https://example.org",
 "data": {"task": "t-77", "title": "File taxes"}}
```

- `seq` is a positive integer that the host assigns, strictly increasing per bus with no reuse. **The bus is totally ordered by `seq`.** Every reader sees records in the same order. The order is the host's commit order, so records from one publisher keep that publisher's commit order. There is no cross-bus order.
- `seq` values visible to one reader may have holes, for example records published before its grant (§6.3) or records still in a publish that has not committed. Holes inside the retained range are not gaps. `gap` reports only data lost to retention.
- `published_at` is host time in Unix seconds. It is informational and never used as a cursor.
- Records are immutable. Publishers cannot edit or delete them, and there is no tombstone record type in v1. Records leave the bus only through retention, an owner purge or bus deletion.

### 6.2 Producer attribution

`publisher` is stamped by the host from authenticated authority, never from arguments:

- `{"kind":"application","client_id","origin"}`, where `origin` is the client's verified origin; or
- `{"kind":"provider","feature"}`, where `feature` is the enabling declaration's `ref`.

`attested_by` is the host's origin: the issuer for provider-hosted buses, the integration origin for brokered ones. It arrives in-band from the host, so **consumers MUST compare it with the origin they called**: the issuer, or `broker.origin` from their preferences v2 projection. They MUST discard records whose `attested_by` differs.

- **Provider-hosted buses.** Attribution is as strong as the provider's token checks, so consumers MAY rely on it.
- **Brokered buses.** The host derives `client_id` from the provider-signed brokered token, which proves which app the provider authorized. The stamp itself is the integration's claim, though, and nothing stops a dishonest host from forging records. Consumers MUST treat brokered attribution as asserted by `attested_by`, and consent discloses this (§10.2).
- Record payloads are never signed end to end in v1. A consumer that needs cross-host provenance needs a separate contract.

### 6.3 Visibility and history

- **Reader floor.** Each read grant has a floor `seq`: the bus head at the moment the grant **first gained `read`**. Later widenings, such as adding `subscribe`, do not move it. For brokered buses, the floor is the `floor_at` time (§3.2). The reader sees only records with a greater `seq`. When the manifest's `history` is `"owner-choice"`, the owner MAY lower the floor to `oldest` during consent, an explicit and default-off choice. The floor is recorded in the grant, and reapproval or widening never lowers it silently.
- `start: "oldest"` means the oldest visible record, not the oldest retained one.
- **Publish-only grants read nothing.** A `write` grant never returns records, `seq` values, heads or subscriber information. Its `publish` results carry only an opaque receipt.
- **Consumer isolation.** No method reveals another reader's existence, cursor, lag, subscription or doorbell state to **another app**. Records reveal which publishers wrote them, never who reads them. Per-bus rate-limit refusals are reported as `rate_limited` with a `Retry-After` derived only from the caller's own per-publisher window, so the shared per-bus limit is not an oracle for others' activity. A host does learn its readers: the provider for hosted buses, and the integration for brokered ones. This is disclosed (§10.2).

## 7. Delivery

### 7.1 Pull (all hosts)

Every reader can pull with `read`, using a cursor. With `wait`, pulling is near-real-time. Browser applications use pull. For provider-hosted buses, pulls run the live grant check on each call, so revocation takes effect at the next request, and a held long-poll is answered with `forbidden` once it is revoked (§8).

### 7.2 Push doorbells (provider-hosted buses, integrations only)

Push is a **doorbell, not data**. The provider sends this event over the existing SET channel ([integrations §6.1](integrations.md#61-delivery)):

| Event identifier (placeholder) | Payload beyond `connection`, `generation`, `seq` | Integration obligation |
| --- | --- | --- |
| `…/events/bus-advanced/v1` | `bus` (the reader's opaque scoped resource `id` from its preferences projection), `head` | Pull with `read` from its own cursor when convenient. The event carries no records. |

Rules:

- **No outbox entry per publish.** A publish updates the bus head only. The delivery scheduler compares each subscription's `notified_head` with the bus head, so the transactional outbox holds at most **one pending doorbell per subscription**, coalesced the same way `preferences-updated` markers are (integrations §6.3). The payload and `head` are taken at send time.
- A host sends at most one doorbell per subscription per 5 seconds, and SHOULD send it within 5 seconds of a publish when budgets allow.
- Retry, the 72-hour window, degradation and 4 KiB response bounds are those of integrations §6.4. A doorbell dropped after the window is harmless, because the next one, or a pull, recovers.
- `seq` in the payload is the connection's event counter (integrations §6.1). `head` is the bus position. They are unrelated.
- Integrations MUST ignore a doorbell for a bus they no longer hold a grant on. The event leaks nothing new, because its `bus` id is the integration's own projection id.

**Why a doorbell.**

- *Data minimization.* Records travel only on authenticated pulls, under a live grant check at read time.
- *Revocation.* No record sits in an outbox after its grant is revoked.
- *Cost.* Outbox writes scale with subscribers and coalescing windows, not with publishes.
- *Backpressure.* The consumer pulls at its own pace, and a slow consumer costs the host nothing but retention.

The cost is one extra round trip of latency. Inline data in push is left to a later version (open question Q3 in the [consent experience](../architecture/consent-experience.md#13-open-questions-for-the-user)).

### 7.3 Server-sent events (optional, deferred)

A host MAY offer SSE streaming of `read` results in a later version. v1 does not define it. On the reference host, held SSE connections would keep Durable Objects active, whereas WebSockets can hibernate. Long-poll `wait` gives comparable latency within bounded budgets. SSE is therefore deferred until a measured need exists.

### 7.4 Guarantees

| Property | Guarantee |
| --- | --- |
| Publish | At most once per `tx` within the journal retention. `indeterminate` is possible and is never retried under a new `tx`. |
| Pull | Every visible retained record with `seq` above the cursor, in order. Loss through retention is always reported as a `gap`. |
| Doorbell | At least once while within the retry window. It may be duplicated, delayed or coalesced, and it may be lost after the window. It is never needed for correctness. |
| Consumer dedup | By `seq`, because a record's `seq` never changes. |
| End-to-end | No exactly-once processing claim. Consumers make their handling idempotent by `seq`. |

## 8. Revocation and lifecycle

| Event | Provider-hosted bus | Integration-hosted bus |
| --- | --- | --- |
| Read grant revoked or reduced | The next `read` fails, and a held `wait` returns `forbidden` within 5 s. The subscription is deleted in the same commit, and no further doorbells are sent. | Bounded by `access_ends_by` (at most 360 s), or earlier when acknowledged (integrations §7). |
| Write grant revoked | The next `publish` fails. | The next `publish` fails, because publish requires introspection. |
| Owner replaces the occupant (a new bus) | Grants on the old resource are revoked under the slot replacement review ([extensions §3.4](extensions.md#34-policy-is-not-authority)). Consumers see the new bus in `requiresConsent` until re-approved. | The same, plus `credential-revoked` and `resource-detached` events. |
| Owner purges records | Records are deleted, `head` is kept, and readers see a `gap`. | The integration is told by its owner interface. |
| Owner deletes the bus | The resource is removed. Grants on it become unusable, and the field is unconfigured. | `resource-detached` is sent. |
| Connection suspended or disconnected | Its grants are unusable and its subscriptions deleted. | integrations §7. |
| A publish or long-poll is in flight at revocation | Requests already admitted may complete, but no records are returned after the commit. | integrations §7.3, "no recall". |

Records already read are not recalled. Consent says so.

## 9. Quotas, backpressure and cost

Every bus operation is bounded before any storage or egress. The reference values below are 3sln.me policy and need product review. A protocol host MUST publish its own values in descriptor `limits` (§4.4).

| Control | Reference-host value |
| --- | --- |
| Hosted buses per entity | 8 on Free, 32 on paid plans |
| Retained records per bus | 10,000. Effective retention is at most 7 days on Free and 30 days on paid plans, within the manifest range. |
| Publish rate | 60 per minute per publisher per bus, and 120 per minute per bus |
| Publish cost | **A separate event allowance**, metered by the same durable meter machinery as the [storage-write and activity meter](../architecture/storage-write-costs.md) but in its own counters, so publishing can never exhaust the owner's own writes. Reference values: 2,000 publishes per account per day on Free and 20,000 on paid plans, and at most 50 % of the daily allowance per publisher. Each attempt also counts toward the shared whole-service monthly ceiling. Owner operations, such as purge, delete and settings saves, are never charged to the event allowance. Records are stored in the account's SQLite, not in object storage, so a publish incurs no bucket put. |
| Retained bytes | At most 16 MiB per bus (`maxRetainedBytes`), and counted toward the account's storage quota. Aging out by bytes comes before any account-quota failure, so a bus can never fill the owner's storage. |
| Subscriptions (push) | 16 per bus and 64 per account |
| Doorbells | At most 1 per subscription per 5 s, and at most 2,000 per account per hour, shared fairly across buses: one bus gets at most a quarter. Excess is coalesced, never queued. |
| Long-polls | 1 concurrent `wait` per (grant, bus), at most 2 per client per account, and 8 per account. Over a cap, the host answers at once with `rate_limited` and a `Retry-After` of at least 10 s. It never degrades to `wait` 0, which would invite tight polling. Each account also has a daily budget of 172,800 wait-seconds (two continuous waiters). After it is spent, waits answer immediately with `Retry-After` of at least 60 s until the next UTC day. |
| Reads | Bounded by per-grant request rate (2 per second) and response size (256 KiB). Each grant gets 2,000 free empty reads (no records returned) per day. After that, each empty read costs one unit of the event allowance. Non-empty reads are free. |

**Cost model.** A publish costs one event-allowance unit, one SQLite row insert and one head update, in a single transaction. Retention cleanup deletes rows in batches during the account's maintenance alarm, and deletes are not charged. Push costs are bounded by subscriptions × windows, not by publishes. **The fan-out amplification factor is at most 16 doorbells per coalescing window, independent of publish volume**, and each doorbell's follow-up pull is a read.

Long-polls are the main residual cost. A client that re-polls immediately keeps the account's Durable Object resident for as long as it keeps polling: the 25 s ceiling does **not** let the object idle. The daily wait-second budget is therefore the real bound, about two object-days of residency per account per day at worst. Empty-read charging bounds tight polling. Reference implementations SHOULD hold waits in a per-bus notifier outside the account object if measurement shows residency cost matters (open question). Exhausted budgets return `rate_limited` with `Retry-After`. That error means no effect occurred (AMD-C4).

## 10. Security and privacy requirements

### 10.1 Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| A reader exfiltrates more than it was granted | It reads only its own floor and later records, from one bus, through cursors bound to its grant. Schemas forbid unknown properties, so publishers cannot smuggle extra fields past the schema. Payload content is still whatever publishers write: consent shows the publisher-attributed read effect and the categories. |
| A publisher spoofs another producer | `publisher` comes from token authority (§6.2). `data` cannot contain a member named `publisher`, because the envelope is separate from `data`. On brokered buses, attribution is the host's claim and is disclosed. |
| Cross-consumer correlation | No reader or subscriber listing, and cursors are bound to the grant (§6.3). |
| Schema bombs and regex denial of service | The bounded subset forbids `pattern` and `$ref` and caps depth and size (§2.2). |
| Cost amplification through fan-out, long-polling or polling | Coalesced and fair-shared doorbells, wait caps with a daily wait budget, empty-read charging, a separate event allowance with a per-publisher share, per-bus byte caps, and metered introspection (§3.2, §9). |
| A malicious manifest that pretends to be harmless | Effects text is publisher-attributed and never provider-verified unless reviewed. `categories` can only raise risk. The provider derives a risk floor from the contract metadata ([incremental authorization §8](incremental-authorization.md#8-describable-effects-and-risk-interop)). |
| A look-alike bus manifest | Exact URL matching. The manifest host is always displayed (extensions §9). |
| A replayed doorbell SET | integrations §6.1 `jti` and `iat` handling. A replay causes at most one harmless pull. |
| An integration host fabricates records | It cannot be prevented, so it is disclosed. Only the owner can choose an integration host. |
| Data persists after disconnect | Readers' copies are not recalled (disclosed). Purge and delete stay owner actions, and the provider-hosted bus is deleted with the account. |

### 10.2 Required disclosures before approval

In addition to protocol §3 and integrations §5.2, before approving any bus grant the provider MUST show:

- the bus title, manifest host and verified host origin;
- the access mode being granted;
- the publisher-attributed effect text for that mode, labelled with its source;
- the effective retention;
- whether earlier records will be visible (§6.3);
- for read access, the apps and provider features that can currently publish, and for write access, those that can currently read;
- for integration-hosted buses: that the host receives every record, learns which apps read it, attests attribution itself, and that read revocation can take up to 6 minutes;
- for write access: that apps approved to read later will also see what this app writes.

These disclosures MUST be visible without expanding a collapsed section. A disclosure that needs an extra click to reveal does not meet this requirement.

### 10.3 Text handling

`effects`, `title` and `description` are untrusted plain text: bidi-isolated, never rendered as markup, and never shown with a trusted badge unless the host's own review applies. The host chooses a locale from `effects` by its normal negotiation and falls back to `en`.

## 11. Relationship to existing event mechanisms

| Mechanism | What it is | Relationship to buses |
| --- | --- | --- |
| `preferences-updated` and the revocation events ([integrations §6.2](integrations.md#62-event-types)) | Provider → one integration control plane: configuration snapshots and severance | **Not a bus, and never published to one.** Buses reuse its transport (SETs over RFC 8935 with signing, retries and the outbox) and add one event type, `bus-advanced`. Configuration and revocation never travel on a bus. |
| [Activity](activity.md) | App → human. Signed notification items with push routing, read state and retention policy | **Separate.** Bus records are machine data with no read state, no notification and no push to devices. A bus record never becomes activity automatically. An app that wants to tell the owner something publishes activity under its own activity grant. The provider exposes no "activity bus", which would let apps read the owner's notifications. |
| RPC transaction journal | Idempotency for mutations | **Reused unchanged** as publish deduplication (§4.1). |
| BindleBox send-queue SSE | App-internal progress channel | Unrelated. App-internal transports are not buses. |

## 12. Interoperability without support

| Situation | Behaviour |
| --- | --- |
| The provider lacks `extensions.v1` | The manifest is an ordinary fragment with one resource field requiring `event-bus/v1` (AMD-C1). It works if the provider has some occupant implementing the contract, but without slot or bus semantics, a reader floor or built-in hosting. Apps MUST NOT assume a reader floor unless `events.v1` is declared. |
| The provider has `extensions.v1` but lacks `events.v1` | The slot is unrecognized because of `crit` (extensions §2.2), and is processed as an ordinary fragment. |
| The provider lacks `brokered-resources.v1` | Only provider-hosted buses exist. |
| The integration lacks `events_endpoint` | Pull only. |

## 13. Feature declaration

`"events.v1": {"hosting": true|false, "push": true|false, "event_bus_contract": "<contract URL>"}`, declared in provider `features`.

- `hosting` means the generic built-in occupant of §3.1. `push` means doorbells for hosted buses, which requires `integrations.v1`.
- The feature requires `extensions.v1`. Without it, clients apply §12.
- It is advertised only when implemented and mounted, never because a flag is set.

## 14. Core amendments — proposed (unsigned)

| ID | Document | Amendment |
| --- | --- | --- |
| AMD-C12 | protocol §2 feature table | Add `events.v1` (§13). |
| AMD-C13 | contracts | Publish `event-bus/v1` with the §4 methods, `x-methods` metadata and descriptor limits. |
| AMD-C14 | extensions §4.2 | A provider declaring `events.v1` with `hosting: true` offers a generic built-in occupant for every recognized bus slot, without a per-slot declaration. It is created only by owner action and never preselected. |
| AMD-C15 | integrations §5.3, §6.2 | Add `bus-advanced/v1` (§7.2). It is sent only to connections whose pinned `events` list it. Adding it to `events` is a staged manifest change (integrations §2.3). Add the brokered token claim `bindle.bus` (§3.2). |

## 15. Conformance tests

- **Manifest:** every §2.1 and §2.2 rule; `pattern`, `$ref` and unbounded strings rejected; `crit` handling on providers without `events.v1`; exclusive cardinality; extra fields rejected; exact URL matching and supersession without copying.
- **Hosting:** the built-in occupant created only on owner action and never preselected; brokered `publish` introspection; brokered `subscribe` rejected; occupant replacement producing an empty bus with consumer re-review.
- **Contract:** schema validation and size limits; opaque publish receipts; journal floor of 10 minutes; `tx` deduplication and `tx_conflict`; `indeterminate` without a new-`tx` retry; total order under concurrent publishers; gap reporting after retention and purge; cursors surviving grant widening and rejected under another client, another floor or after re-approval; `wait` bounds and concurrency caps.
- **Visibility:** reader floor by default, including `floor_at` enforcement on brokered hosts; `head`, `oldest` and `gap` clipped to the floor; `history: "owner-choice"` honoured only when the owner opted in; write-only grants reading nothing; no subscriber oracle in any response or timing that a reader controls.
- **Delivery:** at most one pending doorbell per subscription; coalescing; no doorbell after grant revocation (same commit); duplicate `jti` handling; recovery after a doorbell loss.
- **Revocation:** every §8 row, including a held long-poll returning `forbidden`.
- **Quotas:** every §9 limit; the event allowance separate from owner writes; the per-bus byte cap; empty-read charging; the wait-second budget; metered introspection; doorbell fan-out bounded independent of publish rate.
