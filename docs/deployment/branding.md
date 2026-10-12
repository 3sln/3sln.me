# Canonical 3sln branding

Source: `3sln/.github`, local checkout `../dotgithub`, revision `458ad44a83a9f4b54136c96ca74122cabd99be8b`. The original mark, outlined light/dark wordmarks and 512px PNG avatar were copied unchanged into the web assets. The mark supplies the SVG favicon; the PNG supplies the PWA/apple-touch icon and email inline image. The wordmark retains its outlined Inter lettering. Source notes describe Inter's SIL Open Font License.

Hosted mail uses the exact avatar PNG as a CID inline attachment with escaped HTML and the existing plaintext content. It performs no remote logo fetch and adds no tracking pixel. Self-hosted operators retain their own name and generic web/icon presentation; their mail does not include the 3sln mark. No live email was sent for this change.

The PNG at `/branding/3sln-avatar.png` is also ready for sender-profile uploads. A message attachment does not set the avatar in Gmail's inbox. Domain-level sender logos require receiver-supported BIMI and applicable domain/logo certification; no BIMI DNS record or certificate has been configured by this change. See [Google's BIMI setup requirements](https://support.google.com/a/answer/10911320) and [Cloudflare's inline email attachment API](https://developers.cloudflare.com/email-service/examples/email-sending/email-attachments/).
