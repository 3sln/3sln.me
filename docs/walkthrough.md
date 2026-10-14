# Local app walkthrough

Captured from the actual local Wrangler app, the gated deployment and real Chrome, 2026-10-11–12. These are test accounts; no live recovery credentials, contact capabilities or private answers appear in the images. **Production release remains disabled.** External-provider setup, notification delivery, full federation and account-retention/deletion still require the work recorded in [DEVLOG](../DEVLOG.md).

The new encrypted recovery flow passed real passkey and password signup, restoration, file rotation and replay rejection, with independent adversarial checks. Personal information remains vulnerable to offline guessing; the UI recommends an extra private passphrase.

## 1. Start with an identity

Public documentation, self-hosting links and language selection remain accessible without an account. Local signup offers passkeys or a password, terms acknowledgement, then mandatory recovery setup.

![Start with an identity](walkthrough-assets/landing.png)

## 2. Choose how to unlock the recovery file

Select one to twelve questions, choose a type and add optional public hints. Every answer contributes to encryption. A private passphrase is recommended because personal information can be guessed offline. Demo question names intentionally resemble navigation labels to check that user content remains unchanged.

![Choose how to unlock the recovery file](walkthrough-assets/recovery-questions.png)

## 3. Download only the encrypted file

The random server recovery credential is inside the encrypted payload. Questions, types and hints are readable; answers and credentials are absent from the downloaded public fields.

![Download only the encrypted file](walkthrough-assets/recovery-download.png)

## 4. Test every answer before activation

A successful local round-trip is required before account confirmation. It tests the in-memory encrypted envelope; the user must still keep the downloaded copy safe.

![Test every answer before activation](walkthrough-assets/recovery-verify.png)

## 5. Confirm the file is saved

Account activation follows a tested unlock and explicit saved-file acknowledgement. Wrong answers do not reset the account or reveal which answer was wrong.

![Confirm the file is saved](walkthrough-assets/recovery-confirm.png)

## 6. Recovery on a narrow phone screen

The question editor fits 320-pixel and 390-pixel viewports. Reordering questions preserves native answer controls; no answer is projected into application state.

![Recovery on a narrow phone screen](walkthrough-assets/recovery-mobile.png)

## 7. Localized controls, unchanged personal content

Spanish restoration uses the same encrypted format and normalization. Public prompts and hints from the file remain user content and are never translated.

![Localized controls, unchanged personal content](walkthrough-assets/recovery-spanish.png)

## 8. A private inbox

Signed invitations deliver bounded messages into allowed collections. Owner read status, collection moves, rules and quarantine are separate from untrusted sender annotations.

![A private inbox](walkthrough-assets/inbox.png)

## 9. Control each invitation

Each contact endpoint has its own scope, expiry and limits. Quarantine or revoke it independently. Opening the signed URL does not deliver a message or consume its message quota.

![Control each invitation](walkthrough-assets/contacts.png)

## 10. Manage access to the account

Enroll multiple passkeys, review signed-in devices and revoke sessions. Email linking and optional email sign-in remain disabled until the outbound service is configured.

![Manage access to the account](walkthrough-assets/security.png)

## 11. Choose resources with clear availability

S3-compatible and WebDAV setup are available behind reviewed endpoint rules. OAuth providers are visibly unavailable until their applications, flows and conformance are configured; this screenshot does not establish working external-provider delivery.

![Choose resources with clear availability](walkthrough-assets/resources.png)

## 12. Choose notification channels

Preferences include channels, delays, repeat limits and collections. Hosted push/reminder delivery is still a release gate; storing preferences is not evidence of real delivery.

![Choose notification channels](walkthrough-assets/notifications.png)

## What these checks establish

The isolated browser suite exercises maintained Argon2id in a dedicated worker, Node/browser interoperability and the archived seven-type vector, malicious public metadata, wrong answers, wrong-provider files, duplicate submits, cancellation, real virtual-authenticator WebAuthn and full recovery rotation. Mobile layout and Spanish/user-content checks run separately. Production CAPTCHA, physical devices, low-memory performance, inbox delivery and all external storage providers remain separate verification.

## 13. See storage usage and annual plans

The visible account meter shows 500 MB on the free plan, reserved uploads and a messages/files breakdown. Paid is 5 GB for $5/year; Plus is 100 GB for $35/year; Ultra is 1 TB for $250/year. All three paid tiers share the same activity limits. Checkout remains disabled until Polar setup and verification. These additional screenshots use the actual Chrome-rendered portal with explicitly mocked account/API data to exercise UI states; they do not prove live billing or deployed storage capacity.

![Storage usage and annual plans](walkthrough-assets/plans-catalog-desktop.png)

![Storage on a narrow phone](walkthrough-assets/plans-catalog-mobile.png)

## 14. Search messages across the account

Lexical and tag search support bounded cursor pages, index-lag notices and opening messages outside the initial inbox page. Semantic search remains unavailable until its provider is configured and verified. User-authored titles and snippets retain their language and render as inert text.

![Account search](walkthrough-assets/search-desktop.png)


## File beaming and nearby pairing

Paid senders can select several files, choose a registered device or saved contact, and review the names and declared size. Nearby QR pairing does not require a saved contact. The recipient chooses which files to receive; remote offers appear on eligible devices and only one device can accept.

![File sending and nearby pairing](walkthrough-assets/beaming-desktop.png)

![File sending on a narrow phone](walkthrough-assets/beaming-mobile.png)

![Spanish localization with unavailable paid sending](walkthrough-assets/beaming-spanish.png)

These screenshots use explicitly mocked paid-account/API fixtures. Browser tests exercised native WebRTC between two local portals and verified selected-file bytes; they do not establish internet NAT traversal, TURN relay, push delivery or real paid entitlements. Streaming uses a user-approved file destination where supported, with a bounded 32 MiB memory fallback elsewhere. TURN remains disabled pending credentials and an enforceable relay-spend budget.


## Agent consent and connected apps

The HTTP MCP consent page identifies the requesting app, callback origin and signed-in account. Every collection/action checkbox starts unchecked. Deletion has a separate warning; the user can deny the request. Connections can be revoked in the portal.

![Granular MCP consent](walkthrough-assets/mcp-consent-desktop.png)

![MCP consent on a narrow phone](walkthrough-assets/mcp-consent-mobile.png)

These screenshots use mocked authorization-request metadata. Separate actual Worker tests verify PKCE, audience, scoped tools, refresh rotation and revocation. An upstream app/MCP resource importer remains a design, not a deployed feature.

## Conversations and reply-all

Every conversation message targets the full active membership. The recipient list and per-recipient delivery outcomes stay visible; a partial delivery never appears as complete. Shared-secret authors are labeled unverified. Joining, invitations, individual permissions and removal each have explicit controls.

![Conversation and partial delivery](walkthrough-assets/conversations-desktop.png)

![Conversation on a phone](walkthrough-assets/conversations-mobile.png)

These screenshots use mocked conversation records/delivery outcomes. Durable Node and real local HTTP tests separately verify posting, admission, reply-all, epoch rotation, restart and sanitized inbox/search content. General cross-host federation and production conformance remain gated.

## Visible monthly activity and semantic consent

Storage and monthly covered-change usage each show remaining capacity. Exhaustion preserves account reading, export, deletion and security controls. Semantic search requires explicit consent for limited English excerpts to be processed by Workers AI.

![Storage and monthly activity](walkthrough-assets/billing-activity.png)

![Semantic search consent](walkthrough-assets/semantic-search-consent.png)

These images use bounded API fixtures. Real Workers AI inference and insertion/query/deletion checks ran separately against all four hosted Vectorize shards.


## Connected app resources and disconnection

Connected apps now tracks the app connection independently of its individual agent logins. Review the app's identity, presentation source, resource URL and granted collections/actions. Revoking one agent login leaves the connection intact; disconnecting the app stops new calls and invalidates the connection's tokens and grants. Owner data stays in its resources. Reconnecting requires fresh consent and cannot revive old credentials.

![Connected app resource and separate agent login](walkthrough-assets/connected-apps-desktop.png)

![Connected apps on a narrow phone](walkthrough-assets/connected-apps-mobile.png)

These screenshots use explicitly mocked app/manifest/grant records. Separate real Worker tests verify listing, CSRF-protected disconnection, token and refresh denial, and storage preservation. Independent durable tests cover reconnect generations, pending consent, corrupt records and final dispatch checks. A failed grant listing leaves healthy app disconnect controls available.

Names/descriptions may come from Bindle app metadata or linked/discovered web app manifests. The UI keeps the registered identity and source visible, uses initials, and never loads external icons automatically. Optional Node discovery has a verified DNS-pinned adapter and passed a read-only public MDN example check. Cloudflare external discovery and a raster icon cache remain unconfigured release work.


## 22. Browser tools and assistant connections

Automation hub separates OAuth assistant connections from explicitly enabled tools in the current browser session. Collection/action choices start unchecked. Browser tools have no verified assistant identity; writes and deletions require review. Disabling tools removes native registration and backend access. Unsupported browsers retain assistant connection management.

The desktop and review images below come from real Chrome WebMCP using experimental flags against the actual local Wrangler app: exact collection listing, confirmed file creation, byte readback and revocation passed without mocked browser or owner APIs. This does not establish production browser availability or integrations with third-party app tools. The 320-pixel mobile image uses clearly labeled simulated browser/HTTP fixtures for layout and interaction checks.

![Actual native browser tools with scoped access](walkthrough-assets/browser-automation-native-desktop.png)

![Review an actual native tool's file creation](walkthrough-assets/browser-automation-native-review.png)

![Browser automation on a narrow phone — simulated API fixture](walkthrough-assets/browser-automation-mobile-fixture.png)

The shared callable design also allows apps to request human command presentation independently of a palette or automation transport. General external app commands, cooperative frame import and closed-browser execution remain proposed rather than implemented.


## 23. Canonical 3sln branding

The app now uses the canonical assets from the organization repository: outlined wordmark, gradient mark, 512px PWA/avatar image and inline email logo. The logo keeps its proportions on mobile. The landing screenshots are actual local Wrangler pages; the email image is a browser preview using a mocked send binding, not a delivered email or an inbox-provider avatar. Self-hosted branding remains generic.

![Canonical 3sln.me landing page](walkthrough-assets/branding-desktop.png)

![Canonical logo on a narrow phone](walkthrough-assets/branding-mobile.png)

![Inline email branding — simulated send binding](walkthrough-assets/email-branding-fixture.png)

## 24. Managed Google Drive setup and reconnect

Google authorization creates a dedicated folder for this connection's files; arbitrary existing files are not imported or enumerated. Apps keep their own directory files. The review states the 1 MiB upload limit, managed-file/version bounds and physical retention in Drive. Reconnect requires the same Google account and preserves the original resource, folder and key map. Disconnect removes local credentials without revoking the whole Google OAuth project.

These desktop/mobile images use explicit Google/OAuth fixtures. Actual Worker tests verify authentication, encrypted state, PKCE, callback cleanup and consent-denial handling; durable Node tests verify gateway write/read/range/replay and reconnect against simulated Google endpoints. Live Google-account verification still awaits credentials.

![Google Drive setup — simulated provider](walkthrough-assets/google-drive-setup-fixture.png)

![Google Drive setup on a phone — simulated provider](walkthrough-assets/google-drive-setup-mobile-fixture.png)


## 25. First live deployment

The first Cloudflare Worker is live at [3sln.me](https://3sln.me). These screenshots are from the actual deployed interactive app, after its API-driven UI loaded. Signup remains closed server-side and in the UI; docs and branding assets are available. Google/email/MCP remain unconfigured or disabled until the required secrets and release work are verified. No account was created during this smoke check.

![Actual gated Cloudflare deployment](walkthrough-assets/deployed-landing-desktop.png)

![Actual gated deployment on a phone](walkthrough-assets/deployed-landing-mobile.png)

## 26. Stable identity and permanent handle aliases

A new free account receives a short `n.<Crockford Base32>` handle automatically. Its UUID stays stable. Account & security shows the UUID, numbered handle, and separate public name-certificate download. A customer with verified paid subscription history can claim one permanent custom alias, even after cancellation; the original numbered handle continues to work. The encrypted recovery file contains the UUID and private identity keys, with no name assignment.

These screenshots show the real local Wrangler app and a real passkey account, without a simulated paid subscription. Chrome verified a separate certificate download, case-insensitive numbered-handle login, and cancellation during signature verification. Paid-history and alias retention after cancellation are verified by provider fixtures and durable runtime tests; live Polar verification remains pending.

![Actual local identity and permanent-alias controls](walkthrough-assets/identity-names-desktop.png)

![Identity controls on a narrow phone](walkthrough-assets/identity-names-mobile.png)

## 27. Bindle login, consent and shared resource scopes

These images show the real local Wrangler provider and real Chrome. The separate `bindle-client.example` integrating app is a controlled document fixture; discovery, cross-origin API requests, PKCE code exchange, durable account authentication, preference consent, resource RPC and revocation use the actual Worker. No OAuth/provider responses are mocked. Chrome's explicit local-network permission lets this HTTPS fixture reach the loopback provider during testing.

The review shows the signed-in account, registered app origin, requested values, exact resource methods, shared field scope and existing consumers. Optional fragments can be declined before configuration. Scope controls apply to every consumer of the preference field; the app receives an opaque resource reference and an attenuated bearer, without the owner's underlying resource ID or private scope prefix.

![Actual local Bindle consent](walkthrough-assets/bindle-consent-desktop.png)

![Bindle consent on a phone](walkthrough-assets/bindle-consent-mobile.png)

Owners can reopen Shared preferences from Connected apps. Editing a shared field shows its original values, new controls and the exact affected apps and their existing methods. A deliberate confirmation and revision/consumer checks protect against stale review. Browser verification changed a private storage prefix, rejected the old resource token, obtained a replacement reference, and wrote/read a relative filename without exposing that prefix. Revoking the app's preference grant subsequently denied access. A separate test completed password sign-in back into the pending consent page; identity-only login provided no resource access.

![Reviewing an update to shared preferences](walkthrough-assets/bindle-shared-preferences.png)

Active apps renew five-minute access tokens through rotating credentials held only in memory, within an absolute eight-hour session. The browser test triggered the SDK renewal threshold and verified one actual provider rotation for parallel calls, followed by fresh tokens for the same opaque resource. Provider expiry, refresh reuse and revocation have separate runtime coverage. Reloading the app requires a fresh login.

Production federation and public release remain gated. This verifies the implemented local integration, not live external-provider interoperability or email account materialization.

## 28. Included storage and temporary object links

Every account has built-in storage ready to assign to apps. Resources shows its shared account storage meter and a one rolling daily and hourly activity allowance, distinguishes it from external connections, and prevents disconnecting the built-in resource. These screenshots show the actual local Worker account on desktop and a narrow phone; no storage connector was added to make the example work.

![Included account storage and quota](walkthrough-assets/built-in-storage-desktop.png)

![Included storage on a phone](walkthrough-assets/built-in-storage-mobile.png)

The browser test used an app's scoped resource token to mint a write-only URL for one object with a fixed size and create condition, uploaded raw bytes, then minted a read-only URL and downloaded the same bytes. Both used the required headers returned by the contract. Uploading through the read URL was denied; revoking the app grant immediately denied the provider-proxy download URL. Prefix confinement and the account quota remain enforced. Native provider URLs may remain usable until expiry, which is explained during consent.

The activity meter combines covered changes and storage write attempts in one ledger. Each attempt uses a unit, so a single action can consume multiple units; replacements count even when stored bytes stay unchanged. Daily usage covers the preceding 24 hours and hourly usage the preceding hour. Paid, Plus and Ultra share the same activity limits. Exhaustion pauses covered changes and uploads until earlier activity leaves the rolling window; reading, exporting, deleting and security controls remain available. Separate browser fault fixtures verify Spanish labels and a 429 resource-save response: the form keeps its draft, displays a clear retry message, and sends no automatic second request.


## 29. Account creation and verified contact setup

The landing page provides a distinct Create account action, clear language selection and separated sign-in controls. The header stays readable at 320 pixels, including the logo suffix. New account setup offers email or device notifications without requesting notification permission merely by visiting the page.

![English landing and sign-in](walkthrough-assets/landing-signin-en-1440.png)

![English sign-in at 320 pixels](walkthrough-assets/landing-signin-en-320.png)

![Spanish account creation and contact choice](walkthrough-assets/landing-signup-email-es-320.png)

An account remains pending until it has a working verified contact channel, a primary credential, and a downloaded and tested private recovery file. The screen explains possible periodic unpaid-account checks, suspension and deletion; connected external-provider data is not deleted. Notification permission alone does not satisfy the server gate: push requires receipt of the encrypted challenge after a visible notification succeeds. Unsupported or outdated service workers offer the email alternative. Automatic inactivity deletion is not enabled by this UI.

![Pending account email verification](walkthrough-assets/account-contact-native-password.png)

![Activated account after contact and recovery verification](walkthrough-assets/account-contact-native-active-password.png)

These contact screenshots use the actual built portal, durable local Node identity adapter and real Chrome, with a process-local mail transport capturing the actual generated verification code. Password and virtual-passkey flows both verified the email, downloaded and tested the encrypted recovery file, then activated the same account. Losing pending browser storage resumed setup through the primary credential without issuing a normal session prematurely. This demonstrates local enforcement; it does not claim external email delivery or live browser push-provider conformance. Separate service-worker and UI tests cover bounded challenge handling, early delivery, outdated workers and explicit permission controls.


## 30. Published landing polish

Captured from https://3sln.me on2026-10-13 after deployment of sourcea54eff8, Worker48789f11-635c-480b-8ecf-8a05bc437ec7. The redundant “The Idea” navigation link is removed; its explanatory section remains. Header selectors, touch targets and narrow layout are polished. The real compact Turnstile widget is mounted and fully visible, with no horizontal overflow at320px or1440px and no browser runtime errors. The challenge shown here has not been solved, and no account or payment was created for these screenshots.

![Published landing on desktop](walkthrough-assets/deployed-polished-landing-1440.png)

![Published landing at320pixels](walkthrough-assets/deployed-polished-landing-320.png)

Public documentation is an explicit31-page English developer set plus canonical artefacts; project tracking, audits and this walkthrough stay in the repository. Signup is open with Turnstile, verified email or acknowledged push, credentials and tested recovery required. Routine notifications and automatic retention suspension/deletion remain unfinished; this landing deployment does not certify the whole release.


## 31. Balanced selector and conditional rectangular challenge

Published source4d0420a, Worker349ef5c2-3bc7-47a3-851f-00bb35938705 supersedes the compact widget shown above. The language selector has matching12pxtext and arrow edge insets. Turnstile uses flexible rectangular sizing with interaction-only appearance: automatic checks run without a visible widget, and Cloudflare can show a65px-high interactive challenge when needed. Narrow forms accommodate its300pxminimum without clipping or resetting the challenge. [Cloudflare configuration](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/).

![Balanced selector](walkthrough-assets/deployed-balanced-selector.png)

![Published entry at320pixels](walkthrough-assets/deployed-balanced-entry-320.png)

![Published entry on desktop](walkthrough-assets/deployed-balanced-entry-1440.png)

Fresh productionChrome confirms the real widget is mounted but hidden (zero height) in these screenshots, no horizontal overflow at320/1440, matching selector insets and no runtime errors. Local browser fixtures additionally verify the visible challenge in signin/signup/email/device forms at320/390/1440. No claim of a solved production challenge or account creation is made.


## 32. Recipient details on a contact page

The composer displays only the profile fields permitted by the live signed contact link and the owner's profile-sharing setting. Name and biography remain literal text; the recipient handle stays visible. The avatar URL opens through an explicit shared-avatar link, without an automatic external image request. Optional profile failures do not block a valid composer.

![Local Worker contact page with name-only disclosure](walkthrough-assets/contact-page-scoped-profile.png)

This screenshot comes from the actual local Worker flow with a test account, name-only field grant, and signed-in viewer. It establishes local field filtering, not a new live production user's disclosure. The deployed UI is sourceba06983, Worker6de3be20-c53d-41fa-8554-154b58c9346a. A fresh anonymous productionChrome check confirms an invalid capability shows no profile, performs no profile lookup, has no320px overflow and no runtime errors. No production account or message was created by the check.


## 33. Public pages follow the system theme

Published source52bb3bc, Workerda76c802-982b-43d8-b164-adadbaac4416. Landing and public account pages match the browser's light/dark preference, including forms, native selectors, focus states and logo. Turnstile keeps its automatic theme; changing preferences preserves its mounted instance. The signed-in console retains its existing light palette.

![Production light landing on desktop](walkthrough-assets/live-system-theme-light-1440.png)

![Production dark landing on desktop](walkthrough-assets/live-system-theme-dark-1440.png)

![Production dark entry at320pixels](walkthrough-assets/live-system-theme-dark-320.png)

Fresh productionChrome checks cover light/dark at320/1440pixels: correct palette/logo,12pxselectorarrow, stable widget identity through preference switches, no horizontal overflow or runtime errors. Local browser checks additionally cover Spanish, contrast, focus, contact/recovery/MCP pages and the console. No production account or message was created.


## 34. Guided signup, neutral dark mode, and automatic TV sign-in

Source7be2b62, assetbuild1fcee438b80c6a9d365a, Worker18430d4c-1ccf-49df-b21d-1e083b67e02f. The public page now explains three practical benefits: one account for compatible apps, storage you choose, and controlled contact links. Recovery details remain in setup. The misleading Service status placeholder has been removed from the landing footer. Dark surfaces are neutral charcoal; this supersedes the green-tinted dark palette in appendix33.

### Signup asks one question at a time

Choose a sign-in method, a contact channel, an email address when relevant, accept terms, then create the credential. Verification and the downloaded/tested recovery file still gate activation. Back navigation preserves relevant choices and private email drafts; changing language or theme preserves native inputs. A failed submitted signup requires a fresh security proof. No request is sent while the automatic security check is still running.

![Signup method on desktop](walkthrough-assets/signup-wizard-method-en-light-1440.png)

![Charcoal signup on a small screen](walkthrough-assets/signup-wizard-method-en-dark-320.png)

![Choose a contact channel](walkthrough-assets/signup-wizard-contact-en-light-320.png)

![Enter the email to verify](walkthrough-assets/signup-wizard-email-en-dark-320.png)

![Terms as a separate step](walkthrough-assets/signup-wizard-terms-en-light-320.png)

![Credential as a separate step](walkthrough-assets/signup-wizard-credential-en-dark-320.png)

![Spanish credential step](walkthrough-assets/signup-wizard-password-es-dark-320.png)

These staged screenshots use controlled local browser fixtures. Actual local Node and Worker checks separately exercise passkey/password setup, mandatory email proof, recovery download/test, pending resume and assertion login. Pause clears local authority and cancels KDF work; late completions cannot restore it. It does not undo an activation already submitted with the user's confirmation.

### Phone and TV sign-in advances automatically

After choosing phone/TV sign-in, the page displays a spinner while Turnstile checks and the QR request is prepared. Turnstile remains interaction-only. The QR appears without a second Show QR click. Request errors require explicit retry; failed polling cannot create an automatic retry loop. The phone still requires explicit approval after comparing the code on both screens.

![Actual local Worker automatically generated TV QR](walkthrough-assets/live-automatic-tv-qr.png)

![Actual local Worker TV signed in after explicit phone approval](walkthrough-assets/live-automatic-tv-approved.png)

The TV screenshots use real local Worker authentication with test accounts, rather than a production phone approval. Deterministic backend race tests separately establish that successful cancellation fences pending session issuance or revokes only the linked session, preserving other devices. A late cookie may arrive but the revoked token has no authority. Failed/uncertain cancellation is reported honestly; legacy unlinked consumed requests cannot claim targeted revocation.

### Receipt protection and CI

The same deployment includes supplemental recipient-wide and contact-parent count/byte admission limits, documented in the public messaging specification. Confirmed plan capacity, stable parent-token identity, durable counters and authorized matching-replay behavior are tested. Failed downstream attempts can conservatively consume an admission. Automated multi-label classification and rejection-summary delivery remain separately designed features, with independent budgets and paid per-ingress opt-in proposed.

Final evidence: local core637/637 (includes12 isolated lifecycle draft tests outside the commit), actualworkerd37/37, UIstate82/82 and focusedChrome18/18. Independent reviewer action/provider28/28 and backend cancellation9/9 passed. Linux notification fixtures now set their permission state explicitly, retaining denied/unsupported and old-service-worker safety checks. [GitHub Checks succeeded for the published source](https://github.com/3sln/3sln.me/actions/runs/38476903697).


### Production screenshots and checks

Fresh anonymous Chrome checks confirm the published benefit copy, removed status placeholder, light/charcoal surfaces,12pxselectorarrow, no horizontal overflow at320/1440pixels, and no runtime errors. Guided signup reaches the credential screen one question at a time; returning to the email step preserves the draft. The test did not submit signup, send mail, create an account or approve a login.

![Published neutral dark landing](walkthrough-assets/live-portal-neutral-dark-1440.png)

![Published light landing](walkthrough-assets/live-portal-neutral-light-1440.png)

![Published signup on a small screen](walkthrough-assets/live-portal-signup-dark-320.png)

![Production device flow waiting for its security check](walkthrough-assets/live-portal-device-check.png)

The production headless device probe remained at the security check and was cancelled through the UI; no device-start response or phone approval was observed. It therefore establishes the waiting/cancel interface rather than a positive production QR/login. Automatic QR and explicit approval are established by the actual localWorker screenshots/tests above. No security check was bypassed.


## 35. Static landing, Views, and signup capacity

These screenshots are controlled local browser evidence from the earlier frozen build `78d5a3e3962dc93ac21b`, before the rich-message renderer work. They are not production screenshots. The landing is an immediately rendered static document; authenticated functionality lives at `/console`. Public docs contain curated integration material and a registry linking to actual machine-readable definitions.

![Static landing on desktop](walkthrough-assets/static-landing-en-1440.png)

![Spanish static landing on a small screen](walkthrough-assets/static-landing-es-320.png)

Messages share one stream. Saved Views filter it by tags/read state rather than creating separate inbox containers.

![Saved message Views](walkthrough-assets/message-views-390.png)

![Spanish message Views](walkthrough-assets/message-views-es-390.png)

When free signup capacity is exhausted, the app can offer verified paid signup or an email-confirmed waitlist. The backend independently enforces capacity. An uncertain checkout stays uncertain; returning from checkout is not payment proof. These fixtures do not create a real subscription or send production mail.

![Paid signup plan choices](walkthrough-assets/paid-signup-plans-390.png)

![Uncertain checkout with explicit retry guidance](walkthrough-assets/paid-signup-checkout-unknown-390.png)

![Confirmed waitlist](walkthrough-assets/waitlist-confirmed.png)


## 36. App messages, reviewed submissions, and motion controls

These are local Chrome screenshots of frozen build `d089927129d93a7c490a`, not production evidence. The actual Worker fixture connects a registered app through explicit Messages consent, delivers HTML through the SDK, and mounts its isolated reader. The app's verified origin stays visible; disconnecting or disabling message permission fences later delivery.

![An app message in the console](walkthrough-assets/worker-app-message-rich-frame.png)

![App message permission disabled](walkthrough-assets/app-notifications-disabled.png)

Form submission requires foreground review of the destination and fields. The following Node fixtures use real account authentication and the prepare/dispatch/history paths, with a controlled external transport; they do not establish live third-party delivery. The service worker is disabled in these fixtures.

![Reviewing a message form submission](walkthrough-assets/message-submission-review.png)

![Submission status with reviewed navigation links](walkthrough-assets/message-status-links.png)

HTML postbacks retain the original and previous states. A lost response remains uncertain and cannot automatically resend the form. Fetched HTML opening in a separate tab is deferred; normal safe links and reviewed redirect links remain available.

![Postback history and original message](walkthrough-assets/message-postback-history.png)

![An uncertain submission](walkthrough-assets/message-submission-unknown.png)

Message animations start enabled, respect reduced motion, and have a finite display budget. The local preference disables them and survives language changes. External animated media is currently blocked rather than claimed as fully controlled.

![Spanish message animation preference](walkthrough-assets/app-message-animation-preferences-es.png)

Verification for this frozen build: core802/802 (including12 unrelated lifecycle draft tests), Worker46/46, UI state109/109, main browser76/76 and separate federation4/4. Independent motion, credentialless broker, and submission/history checks passed. This evidence does not claim open production federation, complete account deletion, or a deployed contact-delivery v2 protocol.


## 37. Private-host onboarding and generated badges

These two screenshots are actual Chrome rendering of source fixtures with all requests intercepted under reserved `.example` hosts. They use the current stylesheet and portal components, with synthetic identities and no real delivery services. They are UI evidence, not production screenshots. Separate actual Worker integration verifies issuance, per-name admission, recovery activation and alias sign-in while public signup remains closed.

A private invitation reveals only its permitted available names. The URL fragment is scrubbed before the portal loads; previews and GETs cannot claim a name.

![Choosing an invited name](walkthrough-assets/private-onboarding-names.png)

The host provides badge names, descriptions and SVG blocks. The app generates a cached sprite; identity properties or an injected resolver select its symbols. Labels and descriptions remain accessible, and badges do not change authority.

![Local host badge in the account screen](walkthrough-assets/host-badges-console.png)

The pictured badge and identity are synthetic. Definitions and resolver hooks are host-owned; an identity cannot submit SVG or a badge URL. The first SVG profile supports static primitive shapes and deliberately refuses gradients, author references, CSS, animation and active/external content.
