# Cloudflare email deployment

Hosted system mail uses `sys.3sln.me`, reserving bare-domain addresses for potential user email. `MAIL_SENDER_DOMAIN="sys.3sln.me"` is explicit in the hosted configuration; account links and branding remain on `3sln.me`.

Hosted email uses the Cloudflare Email Sending beta `EMAIL.send({from,to,subject,text,headers})` structured binding. It returns a `messageId` acknowledgement; inbox arrival still needs operational verification. No Resend account, API key, MIME builder or `cloudflare:email` import is needed. [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

The checked-in production configuration declares `EMAIL` and sets `MAIL_ENABLED="false"`. The adapter also requires a working binding and an exact HTTPS `APP_ORIGIN`. The separate local configuration has no email binding. Tests use injected binding doubles; the dry run does not send mail. Do not add a remote email binding to local development for ordinary tests.

## Current live verification

The account owner corrected the onboarded sender domain to `sys.3sln.me`. The previous test used `sys.3sln.com` and was rejected before acceptance; that result does not establish authorization for the corrected domain. The corrected test from `notify@sys.3sln.me` succeeded through a real remote Cloudflare `EMAIL` binding and returned a provider `messageId`. This verifies binding acceptance and sender authorization; recipient inbox arrival is not yet confirmed. Keep `MAIL_ENABLED="false"` pending delivery verification and completion of the relevant hosted flows.

Email Sending onboards each subdomain separately; check the exact domain under **Compute → Email Service → Email Sending**. [Cloudflare subdomain onboarding](https://developers.cloudflare.com/email-service/configuration/subdomains/).

## Sender policy and connected behavior

| Sender | Resource | Current connection |
| --- | --- | --- |
| `verify@sys.3sln.me` | Email association confirmation | Worker identity mailer; `/email/confirm#token=…`, same requesting browser session |
| `login@sys.3sln.me` | Email sign-in confirmation | Worker identity mailer; `/email/login#token=…`, only accounts explicitly enabling email sign-in |
| `notify@sys.3sln.me` | Generic unread-message reminder | Injectable `sendReminder` resource; hosted dispatcher delivery is still unconnected |
| `accounts@sys.3sln.me` | Inactivity/deletion notices | Finite `sendAccountNotice` resource; lifecycle scheduling and event calls remain unconnected |
| `security@sys.3sln.me` | Recovery/passkey/password alerts | Finite `sendSecurityAlert` resource; security event calls remain unconnected |

The application chooses fixed sender roles; callers cannot override them. Hosted `3sln.me` configuration yields the five addresses above. Wrangler additionally limits the binding with `allowed_sender_addresses`. The portable identity and notification services continue to accept injected delivery resources. [Binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

Self-hosted Cloudflare deployments use `APP_ORIGIN`'s hostname as the sender domain by default. Operators may set `MAIL_SENDER_DOMAIN` to a different onboarded DNS domain; the adapter validates DNS labels and still fixes the local parts to `verify`, `login`, `notify`, `accounts` and `security`. Update the deployment's binding `allowed_sender_addresses` to the corresponding five addresses when using your own domain. `BRAND_NAME` controls the email subject brand and otherwise defaults to the app hostname. These are operator settings, not per-message caller input. Verification and unsubscribe links remain bound to the app's exact HTTPS origin even when the sender domain differs. Node and other hosts continue to inject their own delivery resource.

Email templates currently use English. Locale selection and integration with the application's translation catalogue remain release work; UI localization does not establish localized email delivery.

Verification links expire in ten minutes. A GET does not sign in or associate an email; the user must confirm. Reminder bodies omit sender names and message content. The fragment unsubscribe link is a manual browser flow, and the adapter sends `List-Unsubscribe` without claiming RFC 8058 one-click support. Cloudflare controls `Message-ID`; the adapter does not set it. [Email headers](https://developers.cloudflare.com/email-service/reference/headers/).

## Setup the account owner must complete

1. Confirm that the Cloudflare account has **Workers Paid** and can access **Compute → Email Service → Email Sending** beta, and that `3sln.me` uses Cloudflare DNS. Email Sending is available on Workers Paid; verified-destination Email Routing sends alone are free on all plans. [Service availability](https://developers.cloudflare.com/email-service/).
2. Choose **Onboard Domain** for `sys.3sln.me`. Review the proposed bounce MX, SPF, DKIM and DMARC records, including existing mail policy, before authorizing onboarding. Wait for the domain to become ready. This work has not changed DNS or onboarded a domain. [Cloudflare onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/).
3. Confirm this account's Email Sending supports application mail to ordinary user recipients. Email Sending domain onboarding is the intended service for this app; old Email Routing send bindings limited to manually verified destination addresses cannot support public signup. The binding reference still describes verified destinations, so confirm actual account capability before enabling public email flows. The deployed binding deliberately restricts senders and does not hardcode user destinations. [Email Sending overview](https://developers.cloudflare.com/email-service/), [binding reference](https://developers.cloudflare.com/email-service/configuration/send-bindings/).
4. After onboarding, set `MAIL_ENABLED="true"` only in the intended configuration for explicitly authorized delivery verification and deploy through the gated workflow. Keep `RELEASE_READY="false"` until the complete release gates pass. Check all five allowed addresses against domain policy; outbound sender authorization is based on the onboarded domain. Inbound support mailboxes/routing are separate work.
5. Perform an explicitly authorized recipient test for association and sign-in, including delivery, spam placement, expired links and scanner-safe confirmation. Validate suppression/bounce handling and sending quotas for that account. Keep release status and feature claims provisional until the end-to-end checks pass.

## Failure and retry limits

The adapter rejects malformed envelopes, control characters, unknown notice types and substituted link origins before calling the binding. Provider failures become a generic error with a known code only; the adapter does not log recipient addresses, tokens, bodies or raw provider errors.

`sendReminder` accepts the existing caller payload, including its retry key, but Cloudflare's documented structured API offers no idempotency argument. A retry can send duplicate mail, especially after provider acceptance followed by a lost acknowledgement. Stable headers or message IDs do not establish exactly-once delivery. Production dispatch needs a durable delivery ledger and an explicit duplicate-tolerant retry policy; neither the binding nor its acknowledgement resolves that ambiguity. Follow the notification and lifecycle gates in [security.md](../spec/security.md) and [DEVLOG.md](../../DEVLOG.md).
