# Messages from connected apps

Versioned implementation draft. The RPC contract is [`app-messages/v1`](/artefacts/contracts/app-messages/v1.json); the shared [preference fragment](/artefacts/preferences/app-messages/v1.json) describes the `messages` resource field. Available behavior depends on provider configuration and live grants. App messages use normal message content and metadata, not a separate SDK action descriptor format.

An app requests the fragment as optional at login, including `messages` and the exact `createOwn` method. The owner assigns their local app-message resource and explicitly approves the method. Login, profile access, and file access do not grant Messages permission. The resource belongs to the consenting owner; apps cannot select another recipient or sender. Connected apps exposes a separate Messages setting. Disabling it suppresses future admission and pending notification work; enabling requires fresh method consent and does not revive old credentials.

```js
const requests = [{
  fragment: 'https://3sln.me/artefacts/preferences/app-messages/v1',
  required: false,
  purpose: 'Send you updates about work you requested.',
  fields: ['messages'],
  methods: { messages: {
    'https://3sln.me/artefacts/contracts/app-messages/v1': ['createOwn']
  }}
}];
// Complete ordinary provider login and explicit resource/method consent first.
const {values} = await client.readPreferences(requests[0].fragment);
const message = await client.userMessage(values.messages, {
  subject: 'Your export is ready',
  mimeType: 'text/html',
  body: '<p>Your export has finished.</p><a href="https://app.example/exports" data-bindle-action>Open export</a>',
  tags: ['export-ready']
});
```

The SDK produces `transactionId` and `createdAt` once and wraps the accepted resource result as `{transactionId, createdAt, result}`. On failure these identifiers are attached to the error so callers can deliberately retry the same operation. Preserve the identifiers and exact content on retry; the SDK never silently creates a replacement operation after an uncertain send. Wire `transactionId` equals RPC `tx`. An operation older than 24 hours, or over 60 seconds in the future, is refused even after a new login. Retained receipt state is bounded; there is no unlimited replay guarantee.

`subject` is nonempty, at most 120 Unicode code points. `body` is nonempty, at most 12,000 code points, with `text/plain` (default) or `text/html` MIME. Entire encoded JSON args is at most 16 KiB. Supply at most 31 distinct nonempty tags, each at most 64 code points, without controls. `app-message` is reserved and automatically added by the provider. Rules match original validated delivery tags through `tagsAll`; later owner organization remains independent. No `actions`, sender, recipient, channel, icon URL or origin override is accepted.

The provider requires the actual browser Origin to match the exact registered origin bound to the access/resource token, including when the provider itself is the caller origin. Missing, opaque or mismatched origins are refused before message effects. An app-origin iframe retains its own origin; importing an SDK into another website does not inherit the source script's origin. This isolates normal browser websites, not publisher code or nonbrowser forged headers. Leaked credentials remain an authorization incident; the method is owner-only and live-revocable.

Accepted messages have provider-signed admission provenance: registered app ID/name/origin, owner, connection and Messages generations, transaction/time, MIME, subject, tags and exact body digest. Verify against the issuer's HTTPS `/.well-known/bindle/app-notification-keys.json`, not an arbitrary key supplied alongside a message. Signatures attest provider admission under the connection; they do not prove publisher authorship, brand endorsement or the truth of the body. No private key enters browser content. The normal message stream retains app origin/name, private read state, tags, Views, storage metering and owner rules. Cached icons may be shown only after safe local validation; remote URLs are never passed directly to notification resources.

Default connection ceilings are 10 admitted attempts/minute and 100/day, intersected with owner receipt, work and storage limits. Accepted identical retries do not create another message/blob/job. Changed content under a retained transaction conflicts. A crash with unknown admission remains indeterminate. Local Messages disable/disconnect is checked at durable commit and notification dispatch; a granular federation grant revoked after a call has already dispatched may allow that in-flight admission to finish. Subsequent calls fail.

Forms and marked links are authored in ordinary HTML. Shared sanitization, link/action heuristics, credentialless submission and retained postback history are separate renderer safeguards; message admission alone never executes a form or author script. All message links are presented as new-tab links. Forms requesting `target="_blank"` are not supported in this initial profile and stay inert. A submitted HTML response carrying `Bindle-Target: _blank` produces an informational status without replacing the message; fetched-HTML result tabs are deferred. Redirects open a reviewed new-tab GET destination without forwarding the submission body or replacing the message. A successful nonempty HTML result normally becomes a retained local presentation; the original and earlier results remain available in history. Renderer/transport availability must be established before claiming these interactive features are enabled.

Non-HTML and empty responses show a status without replacing the message. A form endpoint can return `application/vnd.bindle.submission-status+json` for a custom plain-text toast:

```json
{"type":"success","message":"Saved your changes.","actions":[{"label":"View result","href":"https://app.example/result"}]}
```

Supported types are `success`, `info`, `warning`, and `error`. The message is limited to 500 Unicode code points. At most two actions are accepted, each with a plain-text label of at most 80 code points and an absolute HTTPS URL without embedded credentials. These are navigation links: the console shows their destinations and opens them in new tabs with opener isolation. They cannot submit another form or execute a callback. An HTTP error remains an error even if the JSON declares success.

Form submission requires a verified original app message, live permission, fresh foreground review, and an operator-approved destination. Local HTML result revisions remain readable but do not inherit the original message's form authority.

## Provider setup

Register reviewed exact client origins/callbacks through `FEDERATION_CLIENTS` and the published fragment through `FEDERATION_SCHEMAS`. Configure a separate EC P-256 provider attestation key in secret `APP_NOTIFICATION_SIGNING_JWK` and publish the matching verify-only keys through `APP_NOTIFICATION_PUBLIC_JWKS`. `node scripts/app-message-key.mjs --out-dir PRIVATE_DIRECTORY` generates both values into an owner-only directory without printing private material. Keep historical public keys during rotation. The private key must never appear in public vars, manifests, logs or git. An unconfigured/mismatched signer fails closed. See [provider federation configuration](../deployment/federation.md).
