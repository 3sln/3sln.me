# Beaming and relay setup

Status: implementation and local verification in progress; production remains gated. Nearby QR pairing, named signed-in devices and remote beam-enabled contacts have separate authorization paths. Account storage quota is not a relay bandwidth allowance. See [protocol](../spec/beaming.md) and [architecture](../architecture/beaming.md).

`BEAM_ENABLED` controls the paid file-offer feature. Hosted rollout placeholders permit 20 offers and 1 GB of declared delivery bytes per account/month; these are application admission limits, not transport byte enforcement. No file payload is stored in the signaling service. Owner sessions and contact permissions must remain live through acceptance/signaling. A receiver selects files and one device atomically claims the transfer.

## Cloudflare TURN

The server adapter uses `CLOUDFLARE_TURN_KEY_ID` and secret `CLOUDFLARE_TURN_API_TOKEN` to request short-lived ICE credentials from Cloudflare Realtime. Never expose the long-lived API token in browser assets or set it in public Wrangler vars. The existing Wrangler OAuth login does not list Realtime/Calls key management authorization; a dedicated operator TURN key is required. No actual credential issuance is verified yet.

`BEAM_TURN_ENABLED` remains **false**. Credentials and a boolean alone cannot enable relay: a real injected enforcement resource is also required. The Cloudflare TURN API does not document a per-tenant delivered-byte budget; credential TTL, declared file sizes and per-allocation approximate rate limits do not establish a hard invoice ceiling against hostile credential reuse. There is no reviewed production enforcement adapter yet. Hosted/local templates explicitly enable the free fixed `stun:stun.cloudflare.com:3478` endpoint through `BEAM_STUN_ENABLED`; self-hosters can disable it. STUN supports direct connectivity and reveals network information to the STUN service; it does not carry file payloads or enable paid relay. Keep direct WebRTC available where a direct connection succeeds, and report relay unavailable honestly when NAT/firewalls prevent it.

Cloudflare charges $0.05/GB of outbound TURN traffic, with a shared 1,000 GB/month Realtime allowance across TURN and SFU. Treat that as one provider-account allowance, not an allowance for every paid user. Protocol overhead and multiple relay paths can add bytes. At marginal rates, 5 GB/month is $3/year at one outbound-copy equivalent, which consumes most of a $5 plan's contribution. A 100 GB/month relay promise costs $60/year before overhead. Sources: [TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/), [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/), [credential generation](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

## Devices, notifications and receiving files

Device names label signed-in devices; revoked or expired sessions cannot silently claim transfers. Existing session/device retention is distinct from a durable forever-online device registry. In-portal notifications/polling do not establish background push delivery. VAPID and actual notification dispatch must be configured and tested before claiming background device wake-up.

Streaming to disk requires browser File System Access support and an explicit user-selected destination. Other browsers use bounded downloads; oversized transfers must be refused or reduced rather than buffering an entire arbitrary-sized file. Web NFC supports NDEF tags on supported browsers, not general phone-to-phone tap; QR and copyable invitations remain fallbacks.
