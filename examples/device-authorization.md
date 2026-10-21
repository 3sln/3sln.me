# CLI and native TV device authorization

LA6 is a mock-provider SDK slice. The provider routes and feature declaration
belong to later workstreams; a configured key does not establish interoperability.
All hosts here are reserved `.example` placeholders. The package remains private;
this checkout imports `packages/sdk/src/device.mjs` directly. A published package
export and a live provider walkthrough remain integration work.

`device-authorization-cli.mjs` shows a native terminal adapter. Replace the
placeholder configuration only for a provider that declares the complete Bindle
device profile and an operator-registered public client eligible for this grant.
The configured issuer is the trust anchor; retrieve its manifest with HTTPS,
without redirects or cookies. The helper checks the feature, grant types, ES256
and same-origin endpoints before creating a device request.

```js
import {createDeviceClient} from '../packages/sdk/src/device.mjs';
import {nodeDeviceFetch} from './device-authorization-node-transport.mjs';

const client=createDeviceClient({
 issuer:'https://provider.example',clientId:'https://acme.example/cli',manifest,
 fetcher:nodeDeviceFetch,
 confirm:async({subject,refreshExpiresAt},{signal})=>
  nativeUI.confirmAccount(subject,refreshExpiresAt,{signal}),
});
try{
 const display=await client.start({signal});
 nativeUI.showDeviceCode(display); // URL and code, never the device_code.
 const session=await client.poll({signal}); // Returns only after account confirmation.
 // Keep this client alive while using its DPoP-bound credentials.
 // Refresh explicitly before access expires; request(body) POSTs to the declared RPC endpoint.
}finally{await client.dispose();} // Stops polling and attempts session revocation.
```

Transport injection is required. Node's built-in `fetch` adds `Sec-Fetch-Mode`,
which this profile requires providers to reject. The example's `nodeDeviceFetch`
uses raw HTTPS, follows no redirects and sends no browser headers or cookies.
A native TV/network adapter must meet those same requirements. The helper passes
an `AbortSignal` and a 15-second per-request timeout; adapters must honor it.

Display `verificationUri` and `userCode` together as selectable plain text. Require
the person to **type or paste the code shown on the requesting device into the
provider page**, including when a QR code or link is also displayed. Never replace
the code with a QR-only display. The helper deliberately ignores a provider's
optional complete URI and opens no browser itself. The terminal example opens
only the base verification URI after an Enter keypress, in the system browser.
Never use an embedded webview.

For a native TV interface, use the SDK engine's `DeviceAuthorizationDisplay`
query or `client.display()`. Render `userCode` in large, high-contrast monospaced
text with room for the complete URL; prevent automatic translation. Set its
native screen-reader label to `codeLabel`, which separates characters for speech.
Present `instructions` as text, and provide labelled Cancel and Get a new code
controls that call `cancel()` and then `start()`. Keep the code stable; announce
state changes once rather than reading a countdown every second. This slice
includes no browser UI or DOM renderer: browser clients must use redirect/FedCM.

Without a hint, `confirm(account,{signal})` must return exactly `true` before the
SDK retains or returns tokens. The prompt receives the subject and expiration,
never tokens. For a typed complete `identity` handle, also pass `expectedSubject`
from an independently trusted account record; subjects are opaque and cannot be
derived safely from handles. A mismatch aborts and attempts RFC 7009 revocation.
Rejected confirmation, cancellation after issuance and invalid token responses
also attempt revocation. These attempts are best effort; `revoke()` returns a
boolean indicating the HTTP outcome and always forgets local credentials.

The engine exports Actions for start, polling, cancellation, refresh, resource
requests and revocation, plus the display Query. The thin client dispatches these
same operations. Tests inject a mock provider, virtual clock, wait function and
confirmation adapter into that real ngin engine; cryptographic signatures are
verified with WebCrypto.

Keys default to non-extractable P-256 WebCrypto keys. Both key handles and tokens
are memory-only. `keys: {create(crypto), proof(key,options)}` can adapt an OS key
store: `create` returns `{jwk,jkt,...opaqueHandle}` and `proof` returns a compact
ES256 DPoP JWT using that handle. `jkt` must match the public JWK. `options` includes
`htu`, `nonce`, `crypto`, `clock` and, for resource calls, `accessToken` (bind it as
`ath`). Persist refresh tokens only alongside their private key through a secure
platform store; this slice supplies no plaintext key-file fallback or persistence
implementation.

The token type must be DPoP on both initial exchange and refresh. Resource calls
include `Authorization: DPoP` and an access-token-bound proof; there is no Bearer
fallback. Polling waits at least the advertised interval, adds five seconds on
each `slow_down`, and honors a greater provider interval. Nonce challenges retry
with fresh proofs at the polling interval. Repeated nonce challenges are bounded.
All terminal errors, including `expired_token`, require a new flow. Uncertain
network failures also end the flow: a lost single-use success must not be replayed.
Refresh uses the same key, preserves the original absolute expiry and clears the
session on failure. `invalid_grant` requires another sign-in. The helper assumes
no minimum credential lifetime.

`request(body)` does not retry resource calls automatically, including nonce
challenges. It retains a valid response nonce for the next explicit call; decide
whether another write is safe using the contract's effect/idempotency rules.
Cancellation stops local work and ignores late responses. No client cancellation
endpoint exists in the profile, so a pending remote request expires at the
provider. Provider-side eligibility, consent, storage and revocation propagation
remain later slices; this helper makes no production or provider-conformance claim.
