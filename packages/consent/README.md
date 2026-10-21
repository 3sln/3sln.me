# CX-1 consent model

Pure, deterministic, unmounted library. No I/O, persistence, clock, grant changes,
route or UI. `ConsentMethod`, `ConsentContract`, `ConsentBus`, `ConsentGrant` and
`ConsentModel` are ngin `AppQuery`s over the `consent` provider. Every query
requires `config.INCREMENTAL_AUTH_ENABLED` to be `true` or `'true'`; absence is off.
`CONSENT_OPERATIONS` is a local registry, deliberately outside account routing.

Compose `createConsentProvider({contracts,manifests,apps,readers,resources,
registrableDomain})` into an engine's `consent` slot. These are **trusted provider
facts**, not fields an app can submit:

- `contracts`: exact URL → `{schema,digest}` from verified immutable contract
  pins; raw or `sha256-` prefixed digests. Catalogue copy requires both an exact
  URL and matching digest. The provider snapshot must not contain an unverified
  digest paired with an arbitrary schema. Catalogue source pins and en/es copy
  live in `reviewed-contracts.mjs`; they are local/provisional data, not human
  release approval. Activity v2 has no published pinned contract yet and uses
  the publisher/fallback path; app-messages v1 has catalogue copy.
- `manifests`: exact fragment URL → `{schema,digest}` from validated fragment
  pins (EV-1 for feeds). Publisher identity comes from the identifier's HTTPS
  host, never a free-text `publisher` claim. Settings fields must be atomic.
- `apps`: verified client ID URL → `{reviewed: true|false}` from the app directory.
  Missing apps are unreviewed; request fields cannot change review status.
- `readers`: fragment URL → current readers `[{app,categories?,capabilities?}]`.
  `capabilities` contains `{contract,method}` from live grants; `categories` are
  provider-derived categories for other powers. Refresh this snapshot when
  readers or their grants change. Tier-4 reader powers raise feed-write risk.
- `resources`: resolved resource ID → `{brokerOrigin?}` from verified descriptors.
  A normalized grant's `resource` selects this disclosure; request-supplied
  `brokerOrigin` is ignored. Broker location never changes risk.
- `registrableDomain(host)`: required synchronous resolver backed by an accurate
  public suffix implementation, including private suffixes. Missing resolution
  fails closed. No last-two-label heuristic is shipped. Tests use a fixture-only
  resolver for reserved `.example` hosts and explicit multi-label test cases.

Objects or Maps are accepted for these tables and snapshotted at composition.
They must be scoped to the authorized consent entry before composition: this
library computes presentation and eligibility, not access to account facts.

All queries take `{app,locale?}` plus the operation-specific input. Locale input
is `{account,uiLocales,browser}`, each a tag, whitespace-separated tags or an
array. Unsupported choices fall through; shipped languages are en/es. Publisher
maps use BCP 47 lookup, then English with a language note when needed.

```js
new ConsentMethod({input:{app,contract,method:'get',locale:{account:'es'}}});
new ConsentContract({input:{app,contract,methods:['get','put']}});
new ConsentBus({input:{app,fragment,mode:'readwrite'}});
new ConsentGrant({input:{app,kind:'settings',fragment,fields:['day']}});
new ConsentModel({input:{app,grants:[
 {id:'files',kind:'contract',contract,methods:['get','delete'],label:'Photos',purpose:'Organize my files'},
 {id:'events',kind:'bus',fragment,mode:'read'},
],reason:'Plan my week'}});
```

Method, contract and bus queries are projections of the same rules used by
`ConsentGrant` and `ConsentModel`. Grant kinds are `contract`, `bus`, `settings`.
Contract grants take explicit method names (no wildcard). Cards and rows sort
by descending tier, preserving request order for ties; private reads precede
ordinary reads within a card. The numeric tier is always 1–4; private reads are
a tier-1 variant. Multiple tier-4 categories retain every label. Risk includes
text labels, icon, rule weight, chips, expansion, confirmation and preselection
facts, so a consumer can convey risk without colour. No UI is implemented here.

Precedence is exact pinned catalogue copy, named publisher summary, then a
provider fallback with the method identifier kept separate. App purpose/reason
never supply effect copy; they are separate, host-labelled `app-claim` values.
The model returns cards before its reason; consumers must render each purpose
after its capability rows. Catalogue wording says “Description from 3sln.me's
catalogue”, superseding the draft's review badge per the user's CX-1 direction.
Feed catalogue sentences and publisher effect quotes are separate objects;
catalogue provenance never attaches to a publisher quote or app-chosen label.

Untrusted labels/claims carry plain text, isolation and direction hints; labels
are capped at 40 code points, claims at 200. A renderer must use text nodes,
quoted isolated chips, and publisher `lang`/language notes. Summaries use complete
per-locale templates; publisher method summaries produce a count-and-details
summary. Render required recipients/history/field facts from the future entry
adapter alongside this model; the library does not invent them from copy.

Unreviewed apps are refused with `invalid_request` for every known tier-4 item,
including public access and indirect feed-write effects. Missing/unknown effects
are Change. Categories and reviewed floors only raise risk. Unreviewed
self-published methods/feed reads have a Change floor. Unreviewed publisher
metadata never preselects an item; neither do private reads or tiers 3–4.
Subscription bookkeeping on the exact pinned feed contract is read access.

Residual: a third-party publisher can mislabel an unreviewed write as read. Its
text stays attributed and unreviewed, as accepted by the design review. This
model does not enforce RPC authority or attest provider behaviour. No production
capability or external service conformance is implied. Human sign-off and
comprehension/browser testing remain release gates; DEVLOG is intentionally
untouched under this workstream's instructions.
