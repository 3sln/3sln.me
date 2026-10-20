# App-originated activity — core interoperability draft

Draft, 2026-10-20. **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative. This document defines observable admission, provenance, and lifecycle rules for activity from installed apps, including notifications, alerts, and app messages. It defines neither host UI nor an SDK API. Peer-to-peer communication belongs to a separate messaging application and specification.

The [2026-10-20 scope direction](../../DEVLOG.md#2026-10-20--scope-reduction-messaging-leaves-core-manifest-extensions-activity-stays) establishes that activity remains in core. The detailed protocol choices below are provisional; [review and sign-off](../release/activity-design-review.md#decision-record) remain open. The existing [app-message implementation profile](app-messages.md) is a compatibility baseline, not an implementation of this entire draft. In particular, its published `createOwn` schema does not acquire new fields or methods through this document. A versioned machine binding, canonical signing format, and conformance fixtures are required before advertising this profile.

## Authority and submission

An installed app is represented by an authenticated app connection belonging to one consenting account. Installation, login, profile access, resource access, and permission for an external notification channel are separate authorities. None implicitly grants activity admission. Submission MUST require an explicit activity method grant for that connection and the account's activity resource. The resource and authenticated authority determine the destination account; an app MUST NOT select another recipient, sender, app identity, or notification channel through content fields.

A binding MUST provide create, replace, and retract operations, with independently grantable mutation methods. All operations MUST validate the issuer, resource audience, account, registered app principal, connection incarnation, live grant, and account policy before effects. Disabling admission or disconnecting MUST prevent subsequent mutations and undispatched notifications. Re-enabling MUST NOT widen an old credential; a replacement connection MUST NOT inherit mutation authority over the previous incarnation's items. History retention is recipient policy.

Front-end-only apps MAY submit through a public-client SDK using the same granted resource path. They MUST NOT need an embedded publisher private key, contact link, or ordinary messaging identity. A browser binding MUST check the actual exact request origin against the registered origin bound to its credential before effects, rejecting absent, opaque, or mismatched origins, including a mismatched provider origin. CORS permission alone is insufficient. Importing code from an app's domain does not confer that app's identity. An app-origin embedded context retains its own origin. Origin checking is browser isolation, not publisher authorship proof: nonbrowser clients can forge headers, and stolen valid credentials remain compromised authority.

Noninteractive workloads and built-in integrations MUST have an explicitly authenticated, app-bound authority profile; they MUST NOT use a privileged unlabelled sender or an origin-check bypass. Supporting the browser profile does not imply that a provider hosts background app execution.

## Item identity, attribution, and signed evidence

An app principal is an issuer-qualified registered app identifier, independent of its mutable name or icon. A connection incarnation additionally distinguishes installations/reconnections under the destination account. The provider MUST derive these values from trusted registration and authorization state. An item's identifier is provider-assigned and account-scoped; possession of it grants no read or mutation authority.

Every admitted revision MUST have verifiable, purpose-separated signed admission evidence binding:

- Profile/version, admitting issuer, destination account, item identifier, and revision.
- App principal, registered origin and attributed metadata revision, connection identifier/incarnation, and applicable permission generation.
- Operation identifier, operation creation time, admission time, operation kind, and preceding revision where applicable.
- Exact content digest and declared media type, subject, app tag identifiers, priority, collapse key, and expiry, including explicit absent/default values.

The binding MUST specify a canonical representation, digest/signature algorithms, key discovery, and rotation behavior. Verification MUST anchor to the admitting issuer's authenticated key discovery, never a key or discovery URL supplied only alongside the item. Historical verification material MUST remain available for retained signed history or be preserved through an authenticated archival mechanism. Missing or unverifiable evidence MUST NOT be promoted to verified app activity or gain form authority.

A provider admission signature attests which approved app connection submitted the admitted operation. It is not an independent publisher signature, code attestation, brand endorsement, or assertion that the content is true. App display names, icons, and content MUST NOT replace the authenticated app attribution. Provider-produced alerts, if supported, require a distinct authenticated system source; an app cannot request that source.

The app association is mandatory structural metadata and an implicit app filter facet on every item. It MUST survive owner organization, label changes, app tag edits, and export. Neither the app nor recipient-local tag editing can turn an app item into an unattributed or system-originated item.

## Tags

App-defined tags are namespaced identifiers: the logical identifier is the pair **(authenticated app principal, local tag ID)** in an app-tag namespace. A local ID MUST match `[a-z0-9][a-z0-9._-]{0,63}`. At most 31 distinct app tag IDs are admitted per revision. A wire binding MUST encode the pair unambiguously; it MUST NOT concatenate arbitrary display names or interpret a caller-supplied namespace as authority. The provider supplies the app principal. Identical local IDs from different apps are different tags.

Host/system tags and recipient-owned tags occupy separate typed namespaces. Apps MUST NOT set, remove, or impersonate them, including classifier provenance or structural app attribution. A host MAY derive system tags from authenticated structural facts or recipient rules. App tags and labels are untrusted data and MUST NOT confer system meaning through case folding, Unicode normalization, reserved-prefix look-alikes, or a familiar label. Labels are optional presentation metadata, not identifier equality. A binding that carries them MUST bound them and keep them separate from identifiers.

App updates MAY replace the app-tag partition. They MUST NOT overwrite recipient tags or classification. Rules using app tags MUST match qualified identifiers, not a flat local ID shared across apps. Recipient organization and policy MUST remain distinguishable from the original signed revision's tag assertions.

## Content and notification hints

This initial profile admits only strict UTF-8 `text/plain` and `text/html`, reusing the normative content, external-resource, navigation, submission, result-provenance, and motion rules in [message-content](message-content.md). Its service-specific implementation notes do not become activity wire requirements. Subject and body MUST be nonempty after whitespace checking, with at most 120 and 12,000 Unicode code points respectively. A serialized mutation request MUST fit within 16 KiB UTF-8, including metadata; a binding MUST define the measured request envelope. Providers MAY publish smaller limits and MUST reject excess input explicitly rather than truncate signed meaning. Archives, attachments, executable content, and separate action descriptors are outside this initial profile.

HTML MAY contain forms and marked action links. Receiving or notifying MUST NOT execute them, load remote resources, or imply submission permission. Unsupported forms MUST remain inert. A submission requires separately authorized exact destination, fields, source revision, and live authority, with no ambient credentials on any submission hop. Redirects MUST NOT automatically replay submissions or forward credentials. A postback is recipient-local untrusted outcome content; it MUST preserve original evidence and MUST NOT be treated as an app replacement revision, shared reply, read receipt, or newly authorized continuation form. An app replacement or retraction MUST invalidate pending approvals tied to an earlier source revision. Already attempted external effects can remain uncertain and cannot be undone by retracting the item.

`priority` is an advisory enum: `low`, `normal` (default), or `urgent`. It is signed app input, not an entitlement. Recipient/provider rules MAY demote, suppress, batch, or otherwise override it. No value guarantees push, bypasses quiet periods or channel consent, or establishes an emergency delivery service. Apps MUST NOT select devices, sounds, lock-screen previews, or policy overrides through this profile. Admission success means retained admission, not notification transport acceptance or device delivery.

## Retries and collapse

Every mutation MUST carry a stable operation identifier and immutable creation time. Deduplication scope MUST include issuer, account, app principal, and connection incarnation. An identical authorized retry MUST return the retained outcome without a second item, revision, or notification event. Reusing the identifier with different operation kind, target, revision precondition, or content MUST conflict. Live authorization MUST also apply to cached outcomes.

A binding MUST publish a finite operation-age/skew window and receipt retention covering the entire interval in which an operation could be admitted. It MUST retain a replay fence for uncertain effects until that interval ends. Exhausting receipt capacity MUST refuse new operations rather than evict live fences. After the acceptance window, an operation MUST NOT execute as new, even if its receipt was removed. A lost response or indeterminate outcome MUST NOT trigger automatic resubmission under a fresh identifier.

An optional `collapseKey` is an opaque case-sensitive ASCII token matching `[A-Za-z0-9._-]{1,64}`, scoped to the same issuer/account/app/connection incarnation. Its sole meaning is permission to coalesce pending notification work for that group. It MUST NOT replace, erase, merge read state, or mutate another retained item. Notification coalescing MUST consider only currently eligible items; a muted item cannot replace an eligible notice's content. Distinct admitted items remain distinct and quota-accounted. Content replacement requires the explicit operation below. Equal keys in different scopes never interact.

## Lifecycle and recipient state

| Operation/state | Required semantics |
| --- | --- |
| Create | Assign an item ID and revision 1; preserve admitted content/evidence. Atomically record admitted state and its notification event, or durably record uncertainty where storage spans boundaries. |
| Replace | Require the owning app connection and exact expected current revision. Append a new signed revision; never overwrite signed bytes. The complete replacement contains subject, content, app tags, priority, collapse key, and expiry. A stale revision conflicts; it is not last-writer-wins. |
| Retract | Require the same owning connection and exact expected revision. Append a signed terminal tombstone. Disable actions and undispatched notifications. Retention of earlier content is recipient policy; retraction is not forced erasure or recall of delivered push/external effects. |
| Expire | Optional `expiresAt` is an absolute UTC time defined by the binding. It MUST be later than admission and within advertised provider limits. At or after expiry, disable actions, pending notifications, and further app mutations even if cleanup has not run. Retained content remains inert under recipient retention policy. Absence imposes no app deadline, but does not override retention. |
| Read/unread | Private recipient state, independent of app content revisions. Apps MUST NOT read or set it, obtain read receipts through this profile, or reset it by replacing content. An explicit recipient policy MAY make replacements unread; the app cannot choose that policy. A recipient read-state mutation MUST identify the revision being acknowledged and MUST NOT acknowledge a concurrent newer revision. |

Retraction, expiry, or recipient deletion is terminal for that item identifier. A replacement cannot revive it or extend an elapsed expiry. A pre-expiry replacement MAY change expiry only within current provider limits. New items cannot inherit the terminal item's read state or authority. A provider MUST preserve sufficient bounded tombstone/replay state to enforce these rules; an unknown/deleted ID MUST NOT become an upsert target.

Recipient-local read, archive, tags, retention, and postback history MUST remain independent of app replacements. Replacements MUST NOT automatically reset archive state or enqueue a new external notification; that requires explicit recipient routing policy. Apps MUST NOT query the recipient's feed, rules, tags, devices, or local result history using mutation permission. A mutation outcome MAY expose the app's accepted item ID, revision, and admission time, but MUST NOT reveal those private states.

## Limits and scope

Providers MUST enforce finite per-connection and aggregate per-account admission/work/storage limits, plus bounded mutation histories, tag cardinality, receipt/tombstone storage, and notification queues. Creates, replacements, new collapse keys, retries, and reconnections MUST NOT bypass aggregate limits. Cheap retry/authorization guards MAY charge attempts without duplicating accepted effects. Limits MUST be discoverable in the versioned binding or its authenticated capability response; refusals MUST distinguish invalid input, denied authority, stale revision, expiry, rate/capacity limits, and indeterminate outcomes. Rate refusals SHOULD include a bounded retry delay without exposing other apps' activity. Retraction also needs bounded capacity; a reserved safety lane MAY prevent ordinary create traffic from starving it.

No conversation addressing, contact delivery, participant lists, peer identities, replies, shared read receipts, message fan-out, federation between peers, or public-email bridge is defined here. A messaging app MAY submit its own app-attributed activity under ordinary connection consent and limits; this does not turn core activity into its peer message transport. Notification providers, delivery channels, host feed layout, search, routing-rule UI, and SDK naming remain outside this interop draft. See the [3sln.me activity-center design](../architecture/activity-center.md).
