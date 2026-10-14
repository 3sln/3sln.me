# Message content — normative draft

This profile defines the meaning and permitted effects of message content. It does not prescribe a renderer, programming language, browser API, client SDK, or storage implementation. **MUST**, **MUST NOT**, **SHOULD**, and **MAY** express conformance requirements. Publication of this draft does not establish that every provider or client implements every optional capability.

A message is an immutable sequence of bytes with a declared media type and separately scoped metadata. Receiving bytes, presenting content, following a link, and submitting a form are distinct operations with distinct authorization. Acceptance MUST NOT imply permission to execute content or contact another service.

## Media types and acceptance

The message transport MUST preserve the accepted bytes and declared media type. A transport MAY impose a smaller payload limit or narrower media-type allowlist than a content profile permits. Senders MUST satisfy the live delivery grant, transport limits, and recipient policy; supporting a viewer does not bypass those constraints. A refusal MUST NOT be reported as successful delivery.

| Content class | Interpretation |
| --- | --- |
| `text/plain` | Strict UTF-8 text. Present as literal text; markup, script-looking strings, and escape sequences confer no execution authority. |
| `text/html` | Strict UTF-8 HTML authoring input. Present only the recipient's supported safe subset under the rules below. The received document is not a trusted application. |
| Other permitted media types | Opaque bytes unless the recipient explicitly supports a corresponding content profile. Offer an authenticated download or an inert unsupported-content indication. Do not infer executable presentation from a filename, extension, or content sniffing. |
| Negotiated archive or structured-content extension | Interpret only under its explicit versioned format, validation limits, and recipient policy. An archive label alone does not authorize extraction, resource loading, scripting, or navigation. |

A receiver claiming the text presentation profile MUST decode plain text and HTML strictly as UTF-8 and MUST reject invalid text encodings rather than silently substituting an active format. Media-type parameters and transport framing are governed by the selected transport. The current reference message APIs use canonical lowercase `type/subtype` tokens without parameters; this is not a requirement to rewrite arbitrary MIME-bearing transports.

A recipient MAY render less formatting than the author supplied. Unsupported content MUST NOT acquire more authority through a fallback. It is valid to present HTML as reduced formatting or literal text when the client cannot safely provide its richer capabilities. The interface SHOULD make that limitation understandable without misrepresenting the original bytes.

No general-purpose ZIP, WARC, MHTML, or browser “WebArchive” interoperability is established by this profile. The reference service's experimental `application/vnd.3sln.web-archive+json` is described separately below; its project-private name is not a standardized umbrella archive type.

## Content, metadata, and provenance

The presentation MUST keep the message's accepted bytes distinct from recipient-local annotations and submission results. A local result MUST NOT be represented as a newly signed statement by the original author merely because it is displayed in the same message card. Export and history MUST preserve that distinction.

Subject, title, tag, display-name, icon, and avatar fields are presentation data. They MUST NOT establish an identity, a system role, delivery authority, or permission to submit an action. A client MUST derive verified sender context from the applicable authenticated message or app-connection evidence, not from HTML, CSS, an image, or a user-supplied name. An unverified legacy sender MUST NOT receive a verified identity badge.

Presentation metadata MUST be bounded and displayed without interpreting it as executable content. Recipient-owned tags, read state, classification, and Views remain separate from untrusted sender annotations. A message's styling MUST NOT obscure or restyle the host's trusted sender, destination, permission, or error indicators.

## HTML and styling

An HTML message MUST NOT execute author-supplied code, access the host application's state or credentials, or obtain authority through event handlers, embedded applications, custom executable elements, executable URLs, or equivalent mechanisms. Sanitization MUST occur before content can cause effects. Removing a dangerous element after it has executed or initiated a request is insufficient.

Supported styling MAY affect the message's own presentation. It MUST NOT affect the surrounding application, place author-controlled content over trusted review controls, or provide a path to host state. A client MUST constrain content complexity and rendering work. Unsupported or unsafe constructs MUST be removed, made inert, or cause a safe fallback; claiming support while rendering an unsafe alternative is not conformant.

The client MUST retain the ability to stop rendering or reduce presentation capabilities when it cannot maintain these boundaries. A safe reduced-format implementation is permitted. Two conforming clients need not produce identical pixels or sanitized markup, but they MUST preserve the same authority boundaries and MUST NOT silently change the meaning of a supported form submission.

## External resources and privacy

Displaying or previewing a message MUST NOT silently contact an external origin. External images, styles, fonts, media, imports, and analogous resources require recipient policy that explicitly permits the corresponding disclosure. Remote resources MUST be blockable by the recipient, independently of accepting or retaining the message. The default profile blocks these requests.

Permission to load one resource MUST NOT become an unrestricted request channel. An implementation that permits external resources MUST bound their origins, number, sizes, formats, caching, and lifetime; prevent conditional resource requests from revealing private form input; and disclose the relevant privacy effect. A provider-mediated fetch requires its own network authorization and abuse controls. It MUST NOT become an arbitrary proxy to private or internal network services.

Bundling a resource inside an accepted archive does not automatically grant permission to decode or display it. Unknown, malformed, recursive, or unsupported resource formats MUST remain inert. A recipient MAY choose static representations instead of animated or active formats.

Notification icons and previews MUST obey the same recipient disclosure policy. A sender-supplied icon URL MUST NOT cause an unreviewed request when a notification is displayed. A neutral icon is a conforming fallback. Delivery of a notification MUST NOT execute a message action.

## Links and navigation

A link is a navigation proposal, not an instruction. Merely receiving, parsing, displaying, focusing, or previewing a message MUST NOT navigate or submit data. Navigation requires an intentional recipient action and validation of the destination scheme and authority.

The trusted interface MUST make the actual destination available for review. Author text, styling, or a display name MUST NOT substitute for the destination. An unexpected change of origin requires recipient review. A supported external navigation MUST prevent the destination from gaining a controlling relationship to the account page or receiving the account page as a referrer.

Following a link is distinct from a form submission. An ordinary visit to another website can use that site's own browser credentials; the cookie-free submission requirement below MUST NOT be presented as a guarantee that an external website visit is anonymous.

The current reference navigation profile permits explicitly selected HTTPS links without URL user information. Other schemes require separately defined support; a client MUST NOT infer that support from arbitrary HTML.

## Forms and submissions

Form markup MAY describe recipient input and submit controls. It MUST NOT itself grant network, account, signing, or resource authority. Unsupported forms MUST remain inert with an understandable indication; the client MUST NOT silently change an unsupported method, encoding, destination, or target into a different submission.

Before sending, the recipient MUST deliberately approve the exact supported destination and submitted fields through trusted interface controls outside author styling. The host MUST validate the current message/source revision, declared form, selected fields, and applicable authority. Only the exact declared field values reviewed by the recipient may be sent; author-controlled changes after review invalidate that approval. Hidden or fixed fields MUST match their authorized declaration. Undeclared fields, submission overrides, or changed destinations MUST NOT acquire authority from an earlier review.

Actual submission requests MUST carry no ambient cookies, account-session credentials, or unrelated app authorization on any submission hop. An explicitly scoped submission capability is permitted. Authenticated local reading and preparation are separate operations; their authority MUST NOT be forwarded to the destination. Redirect responses MUST NOT cause automatic form resubmission or credential forwarding.

Anonymous submission MUST remain distinct from identity disclosure. Signing or identifying a submission requires separate explicit recipient authorization for the exact purpose, audience, message/action, and submitted content. The reference profile does not currently provide optional identity signing for message forms.

The host MUST bound preparation lifetime, attempts, request/response bytes, retained history, and network work. An accepted operation MUST have a stable identity and a durable outcome or uncertainty record before an external effect can be attempted. A replay MUST NOT silently repeat an operation whose outcome is unknown. The interface MUST distinguish known failure, known response, and unknown outcome; a timeout is not proof that the external action failed or was canceled.

A supported response MAY update the recipient's local presentation while preserving the original and earlier revisions. It MUST NOT silently send a conversation reply, disclose history to another participant, mark a message read, authorize a new action, or alter the author's signed content. Result content remains untrusted and subject to the same presentation rules.

### Current reference submission profile (non-normative service notes)

The implemented profile is deliberately narrower than the general semantics above:

- Only original, provider-verified app-message HTML with a live consenting app connection and an explicitly operator-approved destination origin can submit. Legacy unsigned messages and recipient-local HTML revisions do not inherit this authority.
- Forms use POST and URL-encoded bounded string fields. Files, multipart submissions, GET submission, external form associations, per-control submission overrides, and duplicate scalar field names are unsupported. A bounded multiple-choice select may repeat its declared name.
- A form with `target="_blank"` is unsupported and MUST remain inert. Fetched-HTML separate-tab viewers are deferred; the client MUST NOT silently submit such a form inline.
- A successful, nonempty `text/html` response normally appends a local result and becomes the current presentation. A `Bindle-Target: _blank` response hint instead records an informational status explaining that separate-tab response display is not supported; it does not expose a fetched-HTML viewer or replace the current body.
- A redirect records an outcome and offers validated HTTPS navigation. It does not change the current body, follow the redirect automatically, or repeat the submitted request at the new URL.
- Every non-HTML, empty, or 204 successful response is status-only. The bounded `application/vnd.bindle.submission-status+json` profile supports plain `success`, `info`, `warning`, or `error` status text and at most two HTTPS navigation links. HTTP errors remain errors even if a response body claims success.
- Notification action locators only open the foreground message. They do not submit it.

These limitations MUST be exposed honestly. Availability of ordinary HTML presentation or of an app-message delivery grant MUST NOT imply that form submission is enabled.

## Recipient motion policy

A client offering motion-capable message presentation MUST provide a recipient-controlled setting to disable message motion. The default preference is enabled. Recipient or platform reduced-motion policy MUST be honored; a default-enabled preference does not override an existing request to reduce motion. Disabling motion MUST apply to current and subsequent message displays without changing the retained message bytes.

The recipient's host MUST enforce a finite maximum motion-exposure budget for each display episode. Bindle does not assign a universal number of seconds: the duration is recipient/provider policy, independent of author-provided durations, delays, iteration counts, or styles. A host MAY choose a shorter limit or disable motion entirely. A sender MUST NOT be able to extend the host's budget.

The budget starts when a presentation is first allowed to run motion. Routine rerendering, layout changes, new animation instances, interaction-triggered transitions, preference toggles, or rebuilding the same display MUST NOT reset it. Time spent hidden or suspended MUST NOT create additional allowance; on resumption the client MUST apply the elapsed budget before exposing moving content. Deliberately closing and reopening a message MAY begin a new display episode under recipient policy. The episode identity MUST remain scoped to the actual owner, message, and presented content revision or digest, not merely the latest history/outcome revision. A status-only result or redisplaying the same original content MUST NOT silently replenish its allowance.

When motion is disabled or its budget expires, the presentation MUST stop moving and prevent new motion in that display episode. Supported finite effects MAY advance to a well-defined final state when that is safe. Infinite effects, effects without an end, and effects whose final state cannot be established MUST stop with a static fallback. A conforming client MUST NOT promise that every animated format has a meaningful “last frame.” A recipient's stop request takes precedence over preserving an animation's preferred appearance.

These requirements cover all motion a client claims to support, including interaction-triggered transitions and pseudo-element effects. A client unable to enforce the policy for a particular presentation mechanism MUST disable that mechanism or use a static/reduced-format presentation. Author styling MUST NOT override the recipient's setting or exhausted budget. The client’s trusted reading, stop, original/history, and submission-review controls MUST remain usable without motion. Authors SHOULD provide a meaningful static presentation; the client MAY reduce formatting when author styling makes supported interaction unusable. A client cannot infer which author content is semantically essential or guarantee that every final author style leaves it visible.

Animated raster images and media are separate decoding capabilities. Stopping styling-based motion alone does not establish that GIF, animated WebP/APNG, video, or audio playback is stopped. A client that permits those formats MUST enforce the recipient's policy for them independently or provide a static/inert fallback. The current reference rich-message profile blocks such resource loading rather than claiming general animated-media control.

Motion preference persistence, enforcement mechanisms, and the chosen host duration are implementation details. Clients MUST advertise or describe only capabilities they actually enforce. The reference service's browser setting and motion budget are implementation policy. Its current motion capability covers supported styling-based effects; it does not claim general animated-media playback support.

## Experimental reference archive extension (non-normative)

The current reference library recognizes `application/vnd.3sln.web-archive+json`, a project-private experimental type. Its envelope is `{version:1,entrypoint,entries:[{path,mimeType,data}]}` with canonical unpadded base64url data. It permits at most 64 entries, 1 MiB per decoded entry, 4 MiB total decoded bytes, and a 10 MiB envelope. A transport can impose a smaller limit; the reference message ingress currently caps a message at 1 MiB.

Paths are unique bounded relative names, with no empty, dot, or dot-dot components, absolute paths, backslashes, URL syntax, percent escapes, or filesystem extraction. The accepted entry media types are `text/plain`, `text/html`, `image/png`, `image/jpeg`, and `image/webp`; the declared entrypoint must name a text entry. Compression, nested archives, external retrieval, and recursive resolution are unsupported. The reference implementation validates entries and presents only the inert text entrypoint; bundled images are not displayed.

A provider MUST NOT advertise this extension as general WebArchive support or claim interoperability with unrelated archive formats. A separately published versioned profile and interoperability evidence are required before broadening the format or its resource-loading behavior. No new RPC contract or invented action-description schema is introduced by this document.

## Conformance and implementation status

A conformance claim MUST identify which presentation, submission, archive, external-resource, and motion capabilities are enabled. Safe refusal or reduced-format presentation is required where a capability is unavailable. Tests MUST cover malformed content, encoding and size limits, host isolation, blocked effects before review, external-resource privacy, stale owner/source/form authority, unknown submission outcomes, and recipient motion overrides across rerenders and background/resume.

The reference service already contains strict text validation, a reduced-format renderer, the experimental archive validator, bounded rich-message parsing, prepared cookie-free form dispatch, local retained results, and privacy-controlled notification summaries. This is implementation status, not proof of deployment or universal client conformance. The reference service implements browser-local motion preferences and a five-second styling-motion limit, with controlled Chrome evidence; this does not establish universal client or animated-media conformance.

See [messages and Views](messaging.md), [connected-app messages](app-messages.md), [contact authorization](contact-tokens.md), and [security boundaries](security.md). These content semantics do not enlarge any of their grants.
