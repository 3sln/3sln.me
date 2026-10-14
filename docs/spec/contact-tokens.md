# Signed contact endpoints — implementation draft

Status: the signed endpoint is now the primary sharing primitive, replacing the earlier URL-fragment bearer design. `ContactEndpointService` implements endpoint signatures, live parent grants and short-lived inbox-token minting. HTTP content negotiation, multipart parsing and presentation belong to the Worker/UI adapters. This is a project-private protocol draft; the proposed MIME type is not claimed to be registered. Human review: reviewer ___ / date ___ / outcome ___. See [messaging](messaging.md), [notifications](notifications.md), [security](security.md), and [DEVLOG](../../DEVLOG.md).

## One URL, three explicit operations

An entity shares a signed contact endpoint, as a link or QR code:

`https://3sln.example/users/alice/contact/ENDPOINT_ID?sig=ENDPOINT_JWS`

Examples use the reserved `.example` domain until publication authority is agreed. The ordinary URL path identifies the endpoint; URL userinfo such as `https://alice@host` is not an account route. The signed query is the capability. Possession authorizes message submission within the live invitation's scope and quotas, not sender identity, inbox reading, account login or owner actions.

| Request | Representation or operation |
| --- | --- |
| `GET` with default/browser HTML acceptance | Human composer UI; verifies the capability but never sends a message or consumes delivery quota. |
| `GET` with `Accept: application/vnd.bindle.contact-token+jwt` | Returns a distinct compact inbox bearer JWT as the response body, with that Content-Type and `Cache-Control: no-store`. Minting never delivers a message or adds a per-token database record. |
| `POST` to the same signed URL, `multipart/form-data` | Explicit delivery: one `message` part, selected `collection`, explicit `mimeType`, bounded optional `subject` and sender `tags`, plus `idempotencyKey`. The receiver enforces endpoint scope and live quotas atomically. |

Unsupported methods return 405; unsupported negotiated representations return 406. The adapter must apply normal Accept specificity/quality semantics, rather than treating a header substring as consent to any representation. HEAD, link previews, prefetches and scanners never deliver. No redirect to third-party hosts is allowed in this flow. A bearer returned by the machine GET can instead be presented to the issuer's inbox API in `Authorization: Bearer TOKEN`. It is not itself a replacement endpoint or a signing key.

Machine requests may use capability-based CORS (`Access-Control-Allow-Origin: *`) without credentials, owner cookies or session-dependent results. Preflight grants only the documented methods/headers and does not mint or deliver. The capability is the authority; CORS is not an authorization boundary. Implementations serving personalized owner state must not mix that state into this public capability response. SDKs fetch only the user-supplied verified endpoint, omit credentials and refuse cross-origin redirects.

## Signature profiles and key custody

Both profiles use compact [JWS](https://www.rfc-editor.org/rfc/rfc7515), ES256 (P-256/SHA-256) or EdDSA/Ed25519. Edwards-key JOSE encoding follows [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037). Only locally registered account public keys are accepted; `none`, HMAC, embedded public-key substitution and remote key discovery are unavailable.

The endpoint protected header is exactly `{alg,kid,typ:"bindle-contact-endpoint+jwt"}`. Its claims are `{iss,sub,aud,jti,iat,exp,collections,mimeTypes,maxMessages,maxBytes,maxMessageBytes,requiredTags,optionalTags}`. `aud` is the exact canonical endpoint URL without its query, `jti` is the parent grant/endpoint ID, and `sub` is a stable account ID. The selected handle is part of the signed URL audience; moving or renaming that route requires an explicit compatibility policy or new endpoint, not silently rewriting its signature. The server stores the exact immutable header and claims on the parent grant before accepting the endpoint. A cryptographically valid signature alone never authorizes arbitrary newly invented claims.

The inbox protected header is exactly `{alg,kid,typ:"bindle-inbox+jwt"}`. Its claims inherit the exact parent collection/MIME/quota and required/optional tag scope, issuer and stable subject, with `aud = ISSUER/api/messages`, random `jti`, `parent = ENDPOINT_ID`, `endpoint = CANONICAL_ENDPOINT_URL`, and current `iat`/`exp`. Lifetime is at most 300 seconds and never extends parent expiry. The bearer ID is not persisted. Validation compares all inherited claims to the live parent, validates mint-time bounds and signature, and rejects unknown or expanded claims. An endpoint JWS cannot be used as an inbox token; the types and audiences are distinct.

Core signing receives an injected `signer({owner,kid,alg})` returning a private CryptoKey and stores public JWKs only. Hosted v0 can use a server-custodied per-account key encrypted at rest. UI must describe it accurately as an account signing key held by the service, without claiming user-exclusive custody or end-to-end encryption. Passkeys authenticate the owner; they are not automatically general-purpose JWS signing keys. Device-only signing and key enrollment/recovery require a separate reviewed protocol. Retiring a key invalidates its endpoints and existing bearers immediately.

## Live grants, limits and metadata trust

`ContactEndpointService({tokens,signer})` builds on the existing grant/key registry. `create(owner,{handle,...grantOptions})` returns `{grant,url,endpoint}`. `inspect(url)` verifies without writes; `mint(url)` returns `{token,tokenType:"Bearer",expiresAt,contentType}`. Its `verify(token)` and `live(tx,verified)` are the MessagingService token interface; `live` returns the parent record so every minted bearer shares quotas and idempotency receipts. The internal inspection record is not a public HTTP response: do not expose recipient quarantine status, counters, rules or private account metadata.

Acceptance rechecks key/parent activity and expiry, collection ownership, exact MIME allowlist, decoded size, remaining parent quota and account storage quota in the message transaction. Revocation blocks future minting, sends and idempotent replays from already minted bearers. Quarantine remains a live parent flag: accepted messages become quarantined and do not notify, including when sent with a previously minted bearer. Disabling a target collection revokes associated parents. Scope changes mint a new parent endpoint, never enlarge old shared copies.

New contact grants include signed `requiredTags` and `optionalTags`: disjoint, unique plain strings with at most 32 combined entries and 64 characters per entry. Required tags are added automatically on delivery. A sender may select only permitted optional tags; repeating a required tag is harmless and deduplicated. Selecting any other tag rejects delivery before storage or receipt quota consumption. Both tag lists are inherited exactly by a minted bearer. A grant with only one of the two lists is invalid. Historical grants lacking both retain their old semantics: sender tags remain annotations and do not become endorsed delivery tags.

Sender-supplied `subject` (up to 200 characters, no control characters) and `tags` are also recorded separately as `senderMetadata` and rendered as text. For new grants, validated required/selected optional tags initialize owner tags and can match `tagsAll` rules; arbitrary raw annotations cannot. Owner rules may subsequently change organizational tags or classification. Original authorized delivery tags remain the rule input, avoiding cascades. Tags grant no reading or automation permission and cannot bypass quarantine. Idempotency includes sender metadata, MIME, legacy target and bytes.

Messages and conversations form one logical incoming stream; configurable Views project that stream using metadata filters. Contact tag policy organizes incoming items without choosing a priority inbox. Existing `collections` claims remain immutable legacy authorization partitions during migration. A View is never a replacement for those claims.

Current parent caps are 32 selected collections, 32 exact lowercase MIME types, 366 days, 100,000 messages and 1 GiB cumulative bytes, with a 10 MiB per-message ceiling and 1,000 parent grants per account. Defaults are 100 messages, 10 MiB cumulative and 1 MiB per message. Minting creates no child rows, preventing unbounded stored-token growth; it still needs request-rate and signature-computation limits. Transport body limits apply before multipart buffering. Invalid endpoint/signature/expiry/unknown-grant responses are uniform and disclose no collection existence; authorized scope errors must also avoid leaking unrelated resources.

## URL secrecy and browser handling

The new query signature necessarily reaches the HTTP server and may enter infrastructure logs. Configure query redaction or omit query strings from access logs, trace spans, analytics, crash reports and CDN debugging. Every endpoint representation needs `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, with no third-party scripts, images or analytics. Never include the signed URL in notification payloads or service-worker caches. QR scans, browser history, clipboard managers, extensions, screenshots and recipients can disclose it; the UI must offer revocation and regeneration.

The human composer captures the full signed endpoint URL in memory before scrubbing the query using `history.replaceState`. Its intentional POST uses that remembered URL. Scrubbing must not break submission or transform the capability into owner authentication. Reload after scrubbing may require reopening the original shared link. A browser GET or machine token request does not consume a message quota or send anything. The earlier fragment helper and `contact+jwt` tests remain compatibility-only internal code; new public links and protocol documentation use signed endpoints.

Required release checks include actual HTTP representation negotiation, default/no-Accept HTML, scanner-safe GET/HEAD, multipart duplicate/size/type handling, CORS with credentials omitted, query/header log redaction, parent revocation/quarantine races, distinct token-type rejection, no minted-token state growth, browser history and service-worker behavior, and independent security review. Unit tests do not establish real network or operational gates.


## Typed delivery design

The [contact-delivery candidate](contact-delivery.md) specifies a common envelope for signed-URL POST and narrowly authorized contact-bearer RPC, with explicit one-off versus conversation-initiation semantics. It is proposed work, not an expansion of existing inbox tokens or an implemented conversation-v2 claim. Existing integrations must use the legacy fields and audience above until the new profile is explicitly advertised.
