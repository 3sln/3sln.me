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
