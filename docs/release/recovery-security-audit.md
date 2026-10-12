# Encrypted recovery file: independent security review

Review date: 2026-10-11. Reviewer: delegated implementation-independent security audit agent. Human release reviewer: ___ Date: ___ Outcome: ___. This is scoped engineering evidence, not cryptographic certification or production approval.

Status: core and browser integration source review completed; independent real-Chrome adversarial tests passed. The actual production gates in [security](../spec/security.md) and [DEVLOG](../../DEVLOG.md) remain applicable.

## Scope and threat model

Reviewed the [v1 contract](../spec/recovery-file.md), `packages/recovery/index.mjs`, `packages/recovery/normalization.mjs`, `scripts/recovery-kdf-worker.mjs`, `packages/runtime/http.mjs`, and the existing identity recovery/resume transaction. Also reviewed `apps/web/src/providers/recovery-file.mjs`, the browser private submission vault, composition dispatch, recovery Actions, question rendering, fresh document navigation, and signup confirmation.

The feature protects an independently random recovery credential with a single key derived from all selected answers. An attacker with the envelope has an unlimited offline guessing oracle through its GCM tag. Birthdays, IDs, phone numbers, short PINs, and correlated biographical facts may be known. Argon2 increases guessing cost; it cannot make these facts secret. One question is permitted, so low-entropy configurations are a deliberate product tradeoff. The recommendation for an additional private passphrase and a readable-metadata warning must remain visible in setup and restore.

## Prioritized findings

No unresolved critical/high-severity implementation defect was demonstrated in the reviewed core and browser integration. This is limited evidence about the exercised code, not a guarantee against undiscovered defects. The remaining release requirements and trust boundaries below remain open.

**Release evidence still required:** supported low-memory/mobile browser performance, supported Unicode repertoire, human comprehension of offline guessing and public hints, and independent specialist cryptographic review remain unverified. These are documented release requirements, not findings that the current mock/unit evidence can close.

**Portability limitation:** v1 intentionally uses native JavaScript normalization and lowercasing. Newly assigned Unicode characters may behave differently across engine Unicode data versions. Existing v1 files must retain their named algorithm; silently changing it would lock users out. The spec accurately distinguishes lowercasing from full case folding and does not claim universal cross-version equivalence.

**Metadata/phishing boundary:** prompts and hints are readable and unauthenticated until successful decryption. GCM authentication prevents successful recovery after unauthorized metadata changes; it cannot authenticate the text before a user types answers. Uploaded text must remain inert, and the app must never navigate or send credentials to file-selected issuers. The independent browser test verifies inert HTML/link-shaped metadata and issuer rejection before any recovery API request.

**Document isolation boundary:** fresh first-party recovery documents with restrictive CSP can avoid loading Turnstile beside the answer fields. They do not sandbox an already malicious script previously granted the same origin's authority: retained same-origin windows, pending setup authority, and origin storage remain relevant. Describe this as a recovery document that does not load third-party scripts, not protection against prior origin compromise.

## Reproducible evidence

Run:

```sh
node --test tests/recovery-audit.test.mjs tests/identity.test.mjs
```

Observed result: **25 passed, 0 failed**. Four audit tests use the installed real `hash-wasm` Argon2id, not a substitute derivation function. The independent AES check decrypts the implementation's deterministic envelope through Node's `createDecipheriv('aes-256-gcm', ...)` with an explicitly constructed expected answer tuple and AAD. Its fixed salt/IV are test fixtures only.

The implementation owner's final core suite and audit suite were also run together with `node --test tests/recovery-file.test.mjs tests/recovery-audit.test.mjs`: **14 passed, 0 failed**. After review of the setup hint guard, the owner suite additionally checks exact/type-normalized public hint equality rejection before derivation (without changing restore compatibility), the archived real Argon2id key/ciphertext vector in `packages/recovery/vectors.mjs`, Gregorian/Unicode normalization, binary-buffer cleanup, and remaining envelope tampering combinations. The canonical password encoding has a separate 32 KiB cap before worker invocation to bound JSON escaping overhead.

- Fixed Argon2id v19, 64 MiB, three iterations, one lane, and a 32-byte result feed AES-256-GCM with a 128-bit tag. Production encryption requests separate random salt and IV buffers.
- The explicit AAD binds format, version, normalization profile, ordered question ID/type/prompt/hint tuples, all KDF parameters and salt, cipher identity, and IV. Tests demonstrate prompt/hint/ID/order tampering and changing either answer fail authentication.
- Leading-zero PINs and full-width digits converge as specified. NFC-equivalent private phrases decrypt, while removing a significant phrase space fails authentication.
- Plain-object/array accessors at envelope, nested KDF/cipher, question-array, and question-object boundaries are rejected without invoking their getters. Unexpected symbols and foreign prototypes fail closed. This is an input-data boundary, not a sandbox for hostile JavaScript `Proxy` traps already executing in the same realm.
- Downgraded/oversized KDF settings, unknown profiles, overlong metadata/ciphertext, duplicate question IDs, and noncanonical base64url reject before entering Argon2.
- Existing identity tests cover mandatory credential proof/acknowledgement, replacement invalidation, parallel activation/recovery races, and reuse of the original recovery token to resume interrupted recovery without resetting already configured replacement credentials. Confirmation of a replacement removes the original resume authority.

Core review also confirms exact-schema bounded payload validation after GCM authentication, generic authentication failure for validly formatted wrong answers/tampering, private nonextractable imported AES keys, best-effort wiping of byte buffers, and no alternate weaker key slots or per-answer correctness hashes. Invalid answer syntax can fail type validation before derivation; this does not expose a stored per-answer verifier. Garbage-collected strings cannot be reliably wiped.

The coordinator reports a separate real-Chrome test at `tests/e2e/recovery-crypto.test.mjs`: Node/browser interoperability and tampered-hint failure with the actual dedicated worker under the actual isolated-route CSP. That test intentionally bypasses the portal UI and does not establish complete signup/recovery browser behavior. Its result must remain distinct from full-flow evidence.

## Browser integration evidence

With the assembled assets and local runtime listening at `http://localhost:8787`, run:

```sh
node --test tests/e2e/recovery-security.test.mjs
```

Observed final result: **2 passed, 0 failed**, using actual Chrome, the current UI, real Argon2id worker, and non-live encrypted fixtures. The first sandbox launch failed with Chrome `SIGABRT`; the authorized run outside that sandbox completed. No production deployment, real account takeover, or live CAPTCHA verification was performed.

The first independent test imports a valid encrypted envelope whose public prompt resembles an HTML image with an event handler and whose hint resembles an external URL. Both remain text: no injected element, navigation, or related network request occurs. An incorrect answer produces the generic failure and clears the answer field. A correct answer decrypts a file for a different issuer, then fails the provider check before any `/api/auth/recover` request. The fixture answer and token appear in neither observed network requests, browser storage, nor serialized native intent details. The local recovery document contains no Turnstile script. Production route exclusion is additionally supported by source review; these local tests do not verify real CAPTCHA issuance or expiry.

The second test submits twice and navigates at the actual worker creation boundary. Exactly one native worker is created and one explicit termination is observed, with no recovery API call. Test instrumentation wraps the native Worker; it does not replace its cryptography. A test-only numeric sessionStorage counter observes termination across document unload, because DevTools can discard unload console events. That counter contains no application data. The initial console-only check was inconclusive and is not treated as proof of a surviving browser worker.

During review the UI owner hardened `pagehide` by calling the captured recovery cancel function synchronously before the engine's asynchronous provider teardown. Other reconciliations include restore normalization guidance and wording that describes testing the encrypted file/answers rather than claiming a downloaded file was reread.

Source review confirms:

- Signup fetches the random recovery payload only after full navigation to `/recovery/setup`. Restore enters `/recovery/restore` after a CAPTCHA-only timestamped handoff; the existing limited pending token remains the separate same-tab resume mechanism.
- The browser provider rejects wrong issuers, malformed handles, and malformed recovery tokens after authenticated decryption and before API transmission. No uploaded issuer selects an endpoint. Legacy plaintext files are rejected without a downgrade fallback.
- Raw answer fields are captured into a private submission map and cleared. The composition layer removes the native form reference before constructing Actions, which receive an opaque operation ID; secret values are consumed privately. Recovery projections contain public question metadata and status flags. This does not sandbox other same-origin DOM event listeners already capable of reading inputs.
- All selected answers are required. A single active worker has fixed parameters, a timeout, explicit completion/error/cancellation termination, and no lower-cost retry. Uploaded metadata is rendered as unlocalized text.
- Only the encrypted envelope reaches the download helper. Confirmation requires a download invocation, successful local answer re-entry/decryption matching the pending random token, and explicit acknowledgement. Decryption checks the private-memory envelope, not a filesystem reread. Neither a download-click flag nor this round-trip proves durable filesystem storage.
- The original random server credential and recovery/resume semantics remain intact. The server sees that credential only where the existing download/confirmation/recovery protocol needs it, never the question answers.

The UI owner's successful end-to-end flow evidence is separate from this independent adversarial test. Full low-memory/mobile testing, live CAPTCHA handoff/expiry behavior, and human usability/security sign-off remain outstanding.
