# Local app walkthrough

Captured from the actual local Wrangler app and real Chrome, 2026-10-11. These are test accounts; no live recovery credentials, contact capabilities or private answers appear in the images. **Production release remains disabled.** External-provider setup, notification delivery, full federation and account-retention/deletion still require the work recorded in [DEVLOG](../DEVLOG.md).

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

The visible account meter shows 500 MB on the free plan, reserved uploads and a messages/files breakdown. Plus is 5 GB for $5/year; Pro is 100 GB for $30/year. Checkout remains disabled until Polar setup and verification. These additional screenshots use the actual Chrome-rendered portal with explicitly mocked account/API data to exercise UI states; they do not prove live billing or deployed storage capacity.

![Storage usage and annual plans](walkthrough-assets/storage-desktop.png)

![Storage on a narrow phone](walkthrough-assets/storage-mobile.png)

## 14. Search messages across the account

Lexical and tag search support bounded cursor pages, index-lag notices and opening messages outside the initial inbox page. Semantic search remains unavailable until its provider is configured and verified. User-authored titles and snippets retain their language and render as inert text.

![Account search](walkthrough-assets/search-desktop.png)
