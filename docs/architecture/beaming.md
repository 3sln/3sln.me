# Beaming architecture and relay budget

Research and design date: 2026-10-12. Reviewer ___ / date ___ / outcome ___. These decisions are provisional. See the [beaming contract](../spec/beaming.md), [unit economics](unit-economics.md), [security gates](../spec/security.md) and [DEVLOG](../../DEVLOG.md). No deployment or provider credential provisioning is implied.

## Boundaries

The control plane stores accounts, contact grants, short-lived invitations, immutable manifests, offer status and bounded signaling. The data plane is a browser-to-browser WebRTC data channel. Direct connectivity avoids service payload relay; TURN is a separately funded connectivity fallback. Do not route file bytes through HTTP polling, Durable Objects, R2, message attachment storage or a general WebSocket relay while presenting this as the same cost model.

Configured application allowances belong to the **paid sender**: the receiving account does not need a paid plan or an offer allowance to approve a transfer or create a nearby receiving invitation. The supplied rollout configuration allows 20 offers and 1 GB of declared bytes per sender/month; this is a control-plane admission choice, not a relay entitlement or provider invoice guarantee. `BEAM_STUN_ENABLED=true` optionally supplies the fixed free `stun:stun.cloudflare.com:3478` service. Without that flag or TURN, ICE uses host candidates only. STUN contacts Cloudflare to discover network addressing and does not relay file payloads; external reachability still needs real-network testing.

Sender account storage owns each offer and serializes transitions. Recipient account storage contains bounded mailbox references, allowing multiple signed-in devices to discover the same remote offer. Claiming is one atomic transition at the sender authority; mailbox copies never decide ownership. Own-device and nearby-receiver offers include an explicit receiving session. Live session revocation and paid-sender status are rechecked across control-plane boundaries. Cross-account fan-out needs failure cleanup and cannot be treated as one transaction without an actual common authority.

Use polling only while the relevant page is active, with delay/backoff and request budgets. An idle-open page can generate more billable control-plane operations than a file transfer. A future persistent channel needs hibernation and measured duration cost; no data-plane loop should keep an account object alive for the entire file duration. Bound reads, writes, per-session signals and historical rows independently of file bytes.

## Cloudflare TURN facts

Cloudflare lists TURN at **$0.05 per decimal GB** sent from its edge to a TURN client, including protocol overhead, and a **1,000 GB shared free tier**. STUN is free. These are provider-account allowances, not per-subscriber entitlements. [Official TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)

The management API creates a TURN key using `POST /accounts/{account_id}/calls/turn_keys`; its documented body has an optional name and requires `Calls Write`. The returned key ID and secret belong on the server. This is distinct from the short-lived credential returned to an end-user browser. [Official key API](https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/)

Short-lived ICE credentials come from `POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers`, authenticated with the server-side TURN key token and a TTL. Revocation is `POST .../credentials/{username}/revoke`. Validate response structure and fixed allowed TURN hosts, redact credentials, and never expose the long-lived token. [Official credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

The service documents approximate per-allocation data and packet rate limits, including **50–100 Mbps**, with higher bursts. These apply separately to allocations, not to the account. The reviewed APIs do not document a configurable per-key or per-customer byte budget. Consequently these rate limits cannot establish an application monthly spend ceiling. [Official service limits](https://developers.cloudflare.com/realtime/turn/#limits)

Use non-identifying per-offer/owner tags and provider analytics to attribute usage. Analytics can group bytes by key, username and custom identifier; these are monitoring facilities, not inline byte authorization. Do not put email addresses or contact names in provider tags. [Official analytics](https://developers.cloudflare.com/realtime/turn/analytics/), [credential tagging](https://developers.cloudflare.com/realtime/turn/replacing-existing/)

## Why hosted TURN remains off by default

A browser user can extract a TURN credential and create traffic unrelated to the approved manifest. The application cannot enforce its claimed file byte count on that independent relay connection. Local byte checks, a signed manifest, a monthly reservation, a short credential TTL, revocation calls and a boolean named “budget enforced” do not remove this gap. Clients can also underreport completion statistics or open other relay allocations.

Therefore the default hosted configuration issues **no TURN credentials** and reserves **zero hosted relay budget**. Direct WebRTC/STUN may still work; networks requiring a relay must show an actionable connection failure. Adding a key does not enable relay. A production relay adapter must demonstrate externally enforced aggregate bytes/spend or another provable worst-case bound before activation. A provider contract with a hard cap, or an independently operated relay with enforced aggregate bandwidth and allocation limits, needs separate engineering, funding and verification. Cloudflare analytics alerts alone do not satisfy that requirement.

For any future funded adapter, admission must reserve a conservative envelope atomically from both payer and global budgets, include both participants and retransmission/protocol overhead, cap concurrent allocations and issuance rate, and fail closed if budget authority is unavailable. Unknown/failed credential issuance consumes its reservation until reconciled. No refund may rely solely on browser-reported bytes. Cancellation should revoke issued credentials and stop renewal, but cannot promise instantaneous cessation of already in-flight provider work. Provider usage reconciliation and anomaly shutdown supplement the external enforcement.

## Marginal cost sensitivity

The following is arithmetic using the published $0.05/GB rate; it is not a measured overhead factor or an included product allowance. Billable relay bytes can differ from logical file bytes and depend on selected paths, retries and overhead. Two billable traversals are shown as a conservative sensitivity, not a claim that every WebRTC transfer is charged twice.

| Logical bytes sent each month | Annual cost at 1× billable bytes | Annual cost at 2× billable bytes |
| --- | ---: | ---: |
| 0.1 GB | $0.06 | $0.12 |
| 1 GB | $0.60 | $1.20 |
| 5 GB | $3.00 | $6.00 |
| 100 GB | $60.00 | $120.00 |

At **$5/year for 5 GB storage**, 5 GB/month of relayed file traffic already costs $3/year before overhead and all existing storage/payment costs. At **$35/year for 100 GB storage**, 100 GB/month of relayed traffic exceeds gross annual revenue. Storage quota must never automatically become a monthly relay entitlement. The shared free tier can reduce a small deployment's invoice, but cannot fund an uncapped promise to every subscriber.

Direct traffic still incurs authentication, mailbox polling, signaling and database costs. Reserve those separately; a disabled relay does not establish a zero-cost feature. Existing annual-plan contribution estimates do not yet include measured beaming control-plane amplification. Publish no unlimited beaming/relay promise until the funding envelope and operational caps are approved.

## Review disposition and evidence

| Decision | Current disposition | Evidence required before stronger claim |
| --- | --- | --- |
| Paid sender, free receiver; separate remote/nearby/own-device routes | Provisional product contract | User-flow review and trusted billing tests |
| Recipient claims exactly one session and selected file set | Required invariant | Concurrent acceptance and revocation tests |
| In-portal notifications | Local adapter behavior to verify | Two-session browser test; external push remains separate |
| Chunked transfer and bounded save fallback | Required invariant | Saved-byte comparison, slow sink, hostile sender and memory checks |
| Cloudflare TURN integration | Provider API researched; hosted relay disabled | Real credentials, externally enforced budget, restrictive NAT and invoice reconciliation |
| Production release | Disabled | All existing and beaming-specific security/funding gates signed |

Independent design review identified credential reuse as the principal new financial boundary and receiving-session claims as the principal authorization boundary. This review is an engineering finding, not human sign-off. Exact implemented API/frame fields and verification results must be reconciled in DEVLOG before reporting completion.

### Independent local security review — 2026-10-12

Reviewer: Codex delegated engineering review. Outcome: the following local regressions have been addressed and tested; human security/funding approval remains unsigned.

| Reviewed issue | Resolution and evidence |
| --- | --- |
| Sender could miss acceptance when only recipient mailboxes were polled | Authorized sender outbox records are merged into mailbox results; route regression covers discoverability. |
| Remote contact directory exposed receiving sessions | Device inventory removed from remote directory responses; independent regression rejects its presence. |
| A second live contact grant could substitute for a revoked original grant | Offer checks pin the original grant ID; independent regression denies substitution. |
| Global profile sharing could disclose more than a particular link allowed | Global switch AND exact per-link field allowlist; tests cover a second grant, revoked grant, omitted grant and ordinary non-beam contact relationship. |
| Contact-profile negotiation could disregard explicit exclusions | Quality/specificity selector; tests cover higher-quality HTML, profile exclusion, wildcard specificity, unsupported types and invalid quality. |
| Public profile reads might create relationships or reveal internal fields | Pure read representation exposes only identity URI, beam availability and selected fields; independent test covers no writes and quarantine denial. Cryptographic endpoint verification remains delegated to the established signed-endpoint service. |
| Cancellation while opening a file writer could leak a late writer | Provider aborts the writer when opening finishes after cancellation; independent asynchronous regression verifies the abort and closed peer. |
| Successful transfers could retain browser resources | Empty-file receipt regression verifies writer close, connection close and binding removal. |

Evidence: [route/profile security tests](../../tests/beaming-security.test.mjs), [browser lifecycle security tests](../../tests/browser/beaming-security.mjs), [durable runtime tests](../../tests/beaming-runtime.test.mjs). Browser lifecycle tests use controlled peer/writer adapters; they do not establish physical-device download or restrictive-NAT compatibility. Live TURN, external push, NFC hardware, TV saving and independently enforced relay billing remain release evidence gaps. No review here upgrades those capabilities merely because a secret placeholder or configuration flag exists.
