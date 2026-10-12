# Device and contact file beaming — provisional v1

Design date: 2026-10-12. Human reviewer ___ / date ___ / outcome ___. Implementation and browser evidence belong in [DEVLOG](../../DEVLOG.md); this document defines required behavior and does not certify production readiness. The [security release gates](security.md) remain applicable and production release remains disabled. See [architecture and relay economics](../architecture/beaming.md).

## Product and authority

A paid sender can offer several local files over an encrypted WebRTC data channel. The receiver chooses which files to accept and where to save them. Payloads do not pass through application storage. No storage upload, inbox attachment, cloud backup or offline delivery is implied. Both browser sessions must stay open and reachable throughout the transfer. Paid eligibility comes from trusted billing state, never a client-supplied plan name. Receiving does not require a paid subscription.

There are three separate entry paths:

| Path | Discovery | Authority and receiving device |
| --- | --- | --- |
| Own devices | Registered authenticated sessions owned by the sender | Choose a particular other device; that session must explicitly accept. |
| Remote contact | Previously exchanged signed contact URL and live beam permission | Notify all of the recipient's eligible signed-in devices; the first acceptance atomically claims the offer for one session. |
| Nearby | Sender or receiver displays a short-lived one-use QR/link, optionally encoded on an NFC tag | The other authenticated device joins without an existing contact relationship; the recipient still reviews and accepts the exact manifest. |

An account device entry represents a registered session, not proof that its browser is running. Show last-seen information separately from current reachability. A remote contact does not gain access to the recipient's device inventory. No background browser push, native notification delivery, offline receipt, or device wakeup is promised by a portal poll or by the existence of a subscription record. Offers shown in an open authenticated portal are in-portal notifications; external push requires its own implemented and verified adapter.

## Contact directory and disclosure

Contact links remain governed by [signed contact endpoints](contact-tokens.md). Saving an ordinary signed contact link does not require or grant beam permission. The link owner explicitly opts into beaming; redemption binds the authenticated redeemer to the live endpoint grant, with revocation checked when creating and accepting an offer. GET, link previews and QR scans never silently grant persistent authority or accept files. The built-in directory retains bounded contact entries, an encrypted copy of the signed link, account identity, and only voluntarily disclosed profile fields. It provides remove controls; the link owner controls grant revocation.

Sharing a name and avatar is optional and separate from allowing offers. Each contact-link grant has a `profileFields` allowlist, initially empty, drawn from `displayName`, `bio`, and `avatar`. Disclosure requires both the profile's global `discloseToContacts` switch and the exact live grant's field allowlist; directory reads use the particular imported grant. A different grant for the same peer must not expand the fields returned for this link. Persist and display only the fields the owner chose to disclose. A name or avatar is a self-asserted presentation field; authenticate the account independently and label the account identity even when the profile is absent. Do not call a legal name, avatar, or email verified merely because the session is authenticated. The local UI presents an avatar URL as an explicit external link; it does not automatically fetch the remote image on contact review.

The signed endpoint also supports a public, capability-authorized contact-profile representation under `application/vnd.bindle.contact-profile+json`, a project-private proposed media type with no IANA registration claimed. Holding the exact live signed link is sufficient to request its owner-selected profile fields; account login and directory import are not prerequisites for that representation. Consequently disclosure consent must say **anyone holding this link can read its selected fields**. Public profile reads must verify the signature and live parent, respect media-type quality/explicit exclusions, use no-store/no-referrer, return no device inventory or internal grant state, and never mint a token or establish a relationship as a side effect. HTML composition and inbox-token negotiation remain separate representations.

Direction matters: permitting Alice to offer to Bob does not implicitly permit Bob to offer to Alice. A directory can list both sides while retaining separate directional permissions. Removing the parent contact grant blocks new remote offers; already saved recipient files cannot be retracted. Nearby pairing does not create a permanent contact or whitelist entry unless a separate explicit contact action does so.

## Nearby pairing

An invitation binds its creator account/session, direction (`send` or `receive`), random identifier and two-minute expiry. Its secret is unguessable, short lived, one use, and is not an account login token. Redemption requires an authenticated user and a deliberate POST; concurrent redemption can succeed once. Pairing binds both actual browser sessions and creates one scoped opportunity for the designated sender to offer files to the designated receiving session. A sender-created invitation lets its creator send after the peer joins; a receiver-created invitation lets the joining sender offer to its creator. The recipient's final acceptance remains mandatory in either direction. Admission consumes the pairing before offer creation; a subsequent validation/funding failure requires a new invitation rather than replaying the old capability.

Use a secret-bearing fragment or equivalently protected transport, remove it from history after capture, and exclude it from logs, referrers and analytics. Never send the full invitation to a third-party QR renderer. QR is local encoding of the same invitation. Treat a photographed/copied QR as a leaked capability, not proof of physical proximity. Show the joined counterparty's authenticated account before consent and allow cancellation/reissue if the wrong person joined. Cross-provider identity federation and anonymous guest receipt are separate future protocols.

Web NFC is a convenience for NDEF tag exchange where available. Browser Web NFC does not implement phone-to-phone peer mode or host card emulation, and feature presence does not establish compatible hardware. Offer QR and copy/paste alternatives. [Chrome's Web NFC implementation](https://developer.chrome.com/docs/capabilities/nfc)

## Manifest, acceptance and lifecycle

Offers carry an immutable bounded manifest of unique opaque file IDs, display names, integer byte lengths and advisory media types. Show sender identity, all filenames, individual sizes and selected total bytes before acceptance; selection may include a strict subset. Empty files are valid; an empty selection is not acceptance. Size arithmetic must remain within safe integers. Filenames are untrusted text: reject traversal/path separators, NUL/control characters and excessive length; prevent bidi tricks from hiding extensions. Never interpret media type or filename as executable content or a filesystem path.

The persisted state machine is `offered → accepted → complete`, with `rejected` and `cancelled` terminal alternatives. Expiration is checked against the timestamp; the browser additionally reports connection/write failure and cancellation. Only the sender may create/cancel its offer; only an eligible recipient session may accept/reject. Recipient acceptance atomically freezes selected IDs and receiving session. Other devices see that it was claimed and cannot negotiate, change selection or receive bytes. Every subsequent operation checks live participant sessions and expiry. Endpoint revocation/account disablement cancels future server-mediated operations; an already-established peer channel cannot be forcibly recalled solely by deleting server metadata.

Initial local bounds are deliberately modest: 16 files, 100,000,000 total offered bytes, a five-minute pending interval and a fifteen-minute accepted interval. These are application admission limits, not storage-plan quotas or TURN cost limits. The server must also bound pending offers, accepted sessions, per-account and service-wide requests, manifest bytes, retained metadata and signaling. Expiration must be enforced on access and old durable rows eventually reclaimed. Failure is explicit; do not mark delivery complete merely because all calls to `send()` returned.

## Signaling contract

The current local adapter uses the following same-origin routes; caller identity is the authenticated portal session. HTTP mutations pass the primary app's origin/CSRF boundary.

| Route | Operation |
| --- | --- |
| `GET /api/beams/status` | Paid eligibility, configured admission limits and relay availability |
| `POST /api/beams/offers` | `{recipient, deviceId?, inviteId?, files}`; own-device offers require `deviceId` |
| `GET /api/beams/mailbox` | Device-visible offer metadata and polling interval |
| `GET /api/beams/{sender}/{id}` | Authorized participant view and opposite-role signals |
| `POST /api/beams/{sender}/{id}/accept` | `{fileIds}`; atomically claim receipt and selected files |
| `POST /api/beams/{sender}/{id}/reject` | Recipient rejection or sender cancellation |
| `POST /api/beams/{sender}/{id}/signal` | `{seq, type, data}`; SDP data includes matching `type` and `sdp` |
| `POST /api/beams/{sender}/{id}/ice` | Direct/STUN settings or explicitly authorized funded relay credentials |
| `POST /api/beams/invites` | `{direction: "send" | "receive"}`; short-lived nearby bootstrap |
| `POST /api/beams/invites/redeem` | `{token}`; authenticated one-use redemption |
| `GET /api/beams/invites/{id}` | Creator's bounded invitation status |
| `GET /api/beams/invites/{id}/qr.svg` | Authenticated locally generated QR, with no-store and no external QR service |
| `POST /api/contacts/redeem` | `{url}`; validate signed link and bind redeemer |
| `GET /api/contacts/directory` | Caller-owned contact directory |
| `PUT /api/contacts/{id}/beam` | `{beamEnabled, profileFields?}`; owner-controlled remote permission and optional profile-field allowlist |
| `DELETE /api/contacts/directory/{peer}` | Remove the caller's saved contact link; this does not revoke the other owner's parent grant |
| `GET, PUT /api/profile` | View/update the caller's optional contact profile |

Route existence does not imply permission or delivery. Fail closed on an unknown route/version, inactive session, unauthorized method or unavailable budget. `recipient` and `{sender}` are account IDs; their presence in a URL never authenticates a caller.

Signaling is authenticated same-origin application traffic. A sender-owned durable record is the authority; recipient mailbox records are references to it. Role and account/session ownership are derived from authenticated credentials, never from JSON sender labels. Offer IDs and signaling sequence numbers are correlation, not authority. Allow SDP and ICE only after consent; do not expose peer network addresses to all devices notified of a remote offer. Never return TURN secrets before final acceptance and funded relay authorization.

Signal records carry a role, monotonic sequence, bounded type and payload under this protocol version. Accept only the expected SDP offer/answer roles and bounded ICE candidates. The local adapter rejects a repeated or out-of-order sequence with `beam_signal_sequence`; it does not implement idempotent signaling retries. A client must not blindly replay an uncertain POST or replace accepted signaling with different content. Reject unknown peer roles, oversized SDP/candidates, signals after terminal state, stale sessions and non-participants. Apply endpoint CSRF/origin checks to browser mutations. Do not log SDP, ICE addresses, invitation secrets or file names in general telemetry.

## Streaming data contract

The browser implementation defines the concrete versioned frame format. Its required invariants are:

1. The peer connection uses a reliable ordered data channel, bounded messages and a bounded send queue. Chunk size respects the negotiated SCTP maximum. SCTP supplies retransmission; do not add an unbounded application retransmission queue. Connection failure requires a new offer/consent in v1; there is no implied resumable transfer across reloads.
2. Before bytes, bind the channel to the accepted offer, selected IDs and immutable sizes. Reject an unknown file, out-of-order offset, extra byte, duplicate header, oversized frame or file count. Byte counters use checked integers. Metadata cannot silently replace the reviewed manifest.
3. Read slices/streams of the local file. Apply both transport backpressure (`bufferedAmount`) and receiver write acknowledgements/credit. Transport buffering alone does not bound a receiver whose disk writes are slow. Bound queued receive events and abort on a peer that ignores credit.
4. Check chunk integrity with bounded-memory hashing and verify final length before commit. A digest sent by the sender detects corruption/protocol mistakes; it does not certify that the file is safe or honestly named. Never call whole-file `arrayBuffer()` solely to hash a large transfer.
5. Acknowledge file completion only after the write succeeds and the sink closes. Overall completion needs all selected files acknowledged by the receiving side. Cancellation, sink failure, disconnect or expiry closes channels, stops source reads, rejects pending waits, aborts the active sink and releases retained buffers/object URLs.

These choices build on the [WebRTC data-channel specification](https://www.w3.org/TR/webrtc/#rtcdatachannel): application framing, acceptance and integrity semantics are project rules, not browser-provided file-transfer behavior. DTLS protects bytes in transit, including across TURN. The service still sees manifest/signaling metadata and controls the delivered client code and identity binding; this is not an independently authenticated cryptographic identity or an anonymity guarantee.

### Local browser wire version

The channel label is `3sln-beam-v1`. It carries bounded JSON control messages and separate binary `ArrayBuffer` chunks. IDs always refer to the previously accepted server manifest. Current limits are **16 KiB per chunk**, **2,048 characters per control message**, **16 queued receive events**, and **64 KiB queued receive payload**. The SHA-256 digest is lowercase hexadecimal over that chunk's bytes. The sender waits for a matching post-write acknowledgement with a 30-second timeout before reading the next chunk.

| Direction | Frame |
| --- | --- |
| Sender → receiver | `{kind:"start", id}` |
| Sender → receiver | `{kind:"chunk", id, offset, length, hash}`, immediately followed by exactly `length` binary bytes |
| Receiver → sender | `{kind:"ack", id, offset}` with the next expected byte offset, after verified bytes are written |
| Sender → receiver | `{kind:"end", id, size}` |
| Receiver → sender | `{kind:"complete", id}` after sink finalization |

SCTP handles network retransmission; reconnect/resume is not implemented by this framing. Per-chunk SHA-256 plus ordered offsets and exact final size checks detects corruption and truncation without retaining the whole file. Changing this format requires a new negotiated version, rather than silently interpreting a peer's unknown control message.

## Save destinations and browser limits

Prefer a user-selected File System Access writable sink, writing chunks as they arrive and awaiting each write. Request the destination during a user gesture before accepting the offer. A multi-file directory picker must not silently overwrite existing files; require explicit replacement consent or choose unique names. A picker cancellation declines/abandons acceptance. A stream adapter must propagate aborts and disk/quota errors. The [File System Access draft](https://wicg.github.io/file-system-access/) defines permission and user activation requirements; support must be detected at runtime.

When a true writable destination is unavailable, the local browser uses a **32 MiB aggregate Blob fallback**. Explain the fallback size limit before consent, reject oversized selected totals, and offer another capable device. Blob creation can transiently retain additional copies; budget accordingly. An anchor-triggered browser download establishes that bytes were handed to the browser download mechanism, not that the operating system finished saving them. A `ReadableStream` alone is not a cross-browser streaming download-to-disk API. Do not add a third-party download service, invisible iframe or service-worker workaround while claiming the same privacy/security properties.

Desktop, mobile, tablet and TV are capability classes to test, not blanket support claims. Check WebRTC, cryptographic APIs, file input/save behavior, foreground suspension, focus/remote-control navigation, and actual disk saving. TV browsers without usable download support must show the limitation and let users choose another receiving device. Browser pairing still needs service connectivity; a shared Wi-Fi network or nearby QR does not imply offline operation.

## Release verification

- Authorization: nonparticipants, revoked sessions, wrong own-device target, directionally revoked contacts, forged sender labels, unapproved profile disclosure, invitation replay/expiry and simultaneous two-device acceptance.
- Transfer: multi-file subset, empty file, changing file source, malicious metadata/frame/offset, corruption, early close, receiver disk failure, stalled disk, bounded sender/receiver memory, mid-write cancel and acknowledged completion.
- Browser: real two-browser peer connection and saved-byte comparison; desktop/mobile restrictive NAT; unsupported TV/save APIs; permission denial; QR both directions; NFC only on tested supported hardware.
- Operations: durable restart/expiry cleanup, mailbox flood, abusive signaling, trusted billing transitions, global admission stop, authenticated request costs, and actual TURN spend controls before enabling hosted relay.
- Privacy: no secrets in logs/history, no remote avatar request, no filenames in push, selected-file and account identity comprehension.

Passing local protocol/unit tests establishes local behavior only. Human security, interoperability and funding decisions stay provisional until signed in DEVLOG.
