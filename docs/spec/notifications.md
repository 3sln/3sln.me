# Message notifications — implementation draft

Status: preferences, subscriptions, transactional events, leased jobs, reminders, and unsubscribe logic are implemented in the core. Web Push/email transport, service-worker installation and real-device/browser delivery are adapter responsibilities with separate verification. Decision sign-off: reviewer ___ / date ___ / outcome ___. See [messaging](messaging.md), [security](security.md), and [DEVLOG](../../DEVLOG.md).

## Preferences and subscriptions

The full preference object is:

```json
{
  "enabled": true,
  "push": { "enabled": false },
  "email": { "enabled": false, "delayMinutes": 60, "repeatHours": 24, "maxReminders": 3 },
  "collections": [],
  "excludeTags": [],
  "quiet": { "enabled": false, "startHour": 22, "endHour": 8, "utcOffsetMinutes": 0 }
}
```

Both channels require explicit opt-in. Global pause suppresses both. Empty collections means all; otherwise only selected live account collections qualify. Tags in `excludeTags` mute matching messages. Quarantined, read and deleted messages never qualify. Email delay is 5–10,080 minutes, repeat interval 1–720 hours, and reminders 1–10 per message. Quiet hours use a visibly explicit fixed UTC offset, including overnight windows; they do not track named-zone DST changes. Equal start/end means quiet all day. The UI must explain these settings rather than imply automatic local-time handling. No content previews are sent; payload is a generic unread-message notice linking to the authenticated inbox.

`setPreferences(owner,preferences,{verifiedEmail})` requires an adapter-confirmed verified email when enabling reminders. The adapter must recheck the current verified email and suppression/bounce state immediately before sending, including changes made after preference opt-in. Never trust a browser-supplied verification flag. Authentication/recovery mail is a separate category and must not be silently controlled by optional message-reminder preferences.

`subscribe(owner,{endpoint,keys},label)` saves up to ten devices. Endpoints are treated as delivery secrets and restricted to configured HTTPS push-service origins; default origins cover FCM, Mozilla and Apple. Subscription keys require bounded base64url encoding. Device lists expose label/ID/time, not endpoint secrets. Users can remove each device or pause push globally; permission revocation, expired subscriptions, and sign-out cleanup need UI support. Delivery status 404/410 removes an expired device. User gesture and browser permission are required before creating a subscription, following the [Push API](https://www.w3.org/TR/push-api/).

## Transactional outbox and delivery

Acceptance writes an event atomically with the message. Releasing an unread quarantined message can create its missing event. `claimDue(owner,{limit,leaseMs})` returns leased jobs per message/channel/device after checking live preferences, unread status and collection/tag/quarantine filters. Leases are 1–300 seconds, default 60; concurrent workers claim a job once. Email timing uses current preferences and last successful reminder; successful delivery resets attempts, increments reminders, and sets the next repeat. Failures back off exponentially up to one hour; eight attempts suspend the job. `finish(owner,id,lease,{delivered,gone})` rejects stale leases.

Before each actual transport call, workers invoke `authorizeDelivery(owner,id,lease)` and separately validate current delivery address/subscription state. The delivery payload contains no sender identity, message bytes, token, subject text, or embedded remote media. A provider can still infer that an account receives notifications, and an OS lock screen can expose the generic notice. Do not promise E2EE for server-custodied messages merely because Web Push payload transport uses encryption.

Use a transport idempotency key including job ID and reminder ordinal (`delivered + 1`). A job ID alone would suppress intended later reminders at a provider offering long-lived deduplication. Delivery is at-least-once: a crash after provider acceptance but before persisted completion can cause a retry; provider idempotency reduces duplicates. A preference/read change after the final eligibility check may race an already-in-flight send and cannot retract it. Scheduled alarms/cron or a queue must wake the account again after delay, quiet hours, retries, and reminders; no in-memory timer is sufficient for deployment. Dead jobs and bounded event retention require visible operational handling.

## Unsubscribe and email hygiene

`issueUnsubscribe(owner,channel)` issues 256 random bits, stores only a SHA-256 digest, and scopes the record to email, push, or all. Tokens expire after 366 days and reveal no account address. `unsubscribe(token)` is idempotent and disables that channel without signing in. Keep unsubscribing separate from authentication, contact grants and account deletion. GET renders confirmation and changes no state, preventing automated link scanning from disabling notifications. A user-confirmed POST applies it. Mail adapters may additionally implement standards-based one-click POST, signed email headers, and abuse protections according to [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058); the core does not by itself implement email header authentication or DKIM.

Use the unsubscribe capability only on a dedicated HTTPS endpoint; redact it from access logs, set no-referrer/no-store, and include a visible unsubscribe link in every optional reminder. Sender authentication, SPF/DKIM/DMARC, bounce/complaint suppression, address changes, consent timestamps and compliant sender identity need verified operational configuration. No actual email or push delivery is claimed until transport integration and device/mailbox testing have passed.

## Evidence and gates

Core tests cover defaults and verified-email enforcement, unread reminders, atomic leasing/retry, stale completions, pending unsubscribe, quiet/filter/quarantine/read/delete suppression, endpoint allowlists, and removed devices. Required integration checks include actual encrypted Web Push generation/VAPID, supported-device installation/permission flow, notification click to authenticated inbox, mail delivery and one-click unsubscribe, verified-address change races, lease crash recovery, clock/timezone changes, persistent scheduling, dead-letter handling, suppression after bounce and sensitive-data redaction. These are release gates, not inferred from unit tests.
