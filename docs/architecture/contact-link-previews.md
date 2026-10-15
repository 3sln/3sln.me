# Contact link pages, previews and intents (3sln.me host)

Status: implemented locally on the Worker and Node adapters (links integration, 2026-10-14); not deployed or production-verified. Interop rules live in [links §6.4](../spec/links.md#64-contact-intents-and-link-previews) and the `intents.v1` feature in [protocol §2](../spec/protocol.md#2-discovery-and-login); this note covers only how 3sln.me renders and hands off. Reviewer ___ / date ___ / outcome ___.

## Public contact page

The default HTML representation of `/users/:handle/contact/:id` is the console document decorated server-side (`packages/runtime/contact-preview.mjs`):

- `<title>`, description, `robots: noindex, nofollow`, `referrer: no-referrer`, Open Graph (`og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image`) and a `summary` Twitter card;
- an oEmbed discovery link to `/oembed?format=json&url=<canonical link>`;
- hidden `web+bindle://send-message` and `web+bindle://add-contact` anchors for non-script parsers.

Only a link that verifies, belongs to an active recipient and passes the per-network `contact-preview` bound gets the owner's grant-permitted profile (display name and avatar, the same disclosure as the contact-profile representation). Everything else, including revoked, expired and quarantined links, renders the generic 3sln.me card with no intents and `og:url` set to the site origin. The capability URL in `og:url`, oEmbed and the intents is rebuilt from the shared raw-query parser, so unrelated parameters are never reflected. All values are HTML-escaped and stripped of control and bidi characters. HTML with `bindle_data` is refused (`link_malformed`) and nothing on this path writes state.

`og:image` for a shared avatar is `/users/:handle/contact/:id/avatar?<capability>`: a bounded, rate-limited `302` to the owner's own HTTPS avatar URL after verifying the link. The host never fetches the avatar itself, so there is no server-side request forgery surface; the generic card is the PNG brand avatar. oEmbed responses are `type: link` only and omit a thumbnail when the avatar's dimensions are unknown.

The page itself contains no composer and no delivery call. It shows the link's form, whether it is conditional (with a policy-level explanation), accepted kinds and media types, limits, expiry, the permitted profile, the two intent buttons, and a secondary "Sign in or sign up with 3sln.me" option. That option is hidden once a same-origin session check finds a signed-in account; strict session cookies are absent on the first cross-site navigation from a chat app, so detection is always client-side after the static page loads.

## Handoff into the console

A signed-in viewer is offered "Send a message" or "Add to contacts", which navigate to `/console#contact=<link>&intent=send-message|add-contact`. The fragment keeps the capability out of server logs. Sign-in and sign-up started from the contact page carry `{link, intent}` in session-scoped storage and return directly into the same prompt. When several accounts are signed in the console asks which one to use first. Send-message runs the console contact flow: intake metadata, the conditional disclosure and one-click signed audience response, composing, and identity-authored delivery. Add-contact uses the existing saved-contact flow.

The installed PWA registers `web+bindle` as a protocol handler (`/console?intent=%s`) and, where supported, captures contact links through `handle_links` and `launch_handler`. Captured links open as the public page, which then detects the session and offers the handoff.

## Other providers

The "Sign in or sign up" option also accepts a handle at another provider. The page discovers that provider's manifest with the SDK discovery code and its limits. Only if the manifest's `features["intents.v1"]` lists the intent with a same-origin `login_endpoint` does it offer to continue there with `bindle_intent=<intent URI>`, after telling the viewer that the contact link will reach that provider. Failures fall back to the intent buttons. 3sln.me declares `intents.v1` with both intents and `login_endpoint = <origin>/console` and treats `bindle_intent` as untrusted input: a well-formed `web+bindle` intent with one HTTPS contact link, at most 8,192 characters, no nesting, scrubbed from the address bar, never acted on without the prompt. Because `bindle_intent` is a query parameter, deployments must redact it from access logs and traces like `sig` and `bindle_meta`.

Pending human decisions: the generic card copy, whether to show the bio in previews (currently excluded), and production log-redaction configuration for `bindle_intent`.
