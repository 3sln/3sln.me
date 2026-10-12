# Encrypted recovery files — envelope v1 candidate

Status: implemented core candidate with Node and real-Chrome cryptography evidence, 2026-10-11. Human reviewer: ___ Date: ___ Outcome: ___. Browser flow evidence and remaining limits are recorded in the [independent audit](../release/recovery-security-audit.md). This document does not establish production readiness or human approval. See [security gates](security.md) and [decision ledger](../../DEVLOG.md).

The outer encryption envelope remains version 1. New signed payloads use version 2 as specified in [UUID recovery and separate name certificates](recovery-identity.md): UUID, signing/encryption keychain and reset credential, with no handle or name assignment. Name certificates download separately. Legacy payload version 1 remains recognized under live account compatibility policy.

## Purpose and threat model

The user selects one or more typed questions and answers every selected question. **All selected answers contribute to one encryption key**. The browser encrypts the random server-issued recovery credential and, for signed payload v2, the UUID-bound signing and encryption keychain; personal information never generates account, signing, or recovery credentials. Anyone possessing the file can attempt unlimited offline guesses. Dates of birth, national IDs, phone numbers, and short PINs may already be known or breached. Combining correlated personal facts does not establish high entropy, and Argon2id does not turn public facts into secrets. Offer an additional private passphrase and recommend it clearly, without substituting a mandatory password for the requested question-based workflow.

Only the combined answer tuple is processed. Do not save per-answer hashes, correctness indicators, partial recovery shares, or alternative weaker key slots. There is no server secret, device key, browser-storage key, account password, or passkey dependency in file decryption. A compatible implementation plus the file and all answers is sufficient on another device. Server-side recovery still requires the live account and current recovery credential.

Question wording, question types, IDs, and optional hints are unencrypted. A hint must never be a copy of its answer; the UI explains that anyone with the file can read it. Setup rejects a hint exactly equal to the raw answer or equal after that answer type's normalization, before deriving a key. This narrow check cannot detect revealing prose, partial answers, or indirect clues. The guard applies only to encryption; it does not change authenticated metadata or prevent decrypting an existing file. The file itself remains sensitive even when encrypted. Legacy payload v1 included the account handle. Signed payload v2 excludes handles and name assignments entirely; issuer, UUID and keys remain encrypted. New recovery filenames use the UUID rather than a handle. Answers are not a verification of legal identity, phone ownership, or government-issued identifiers.

## Public interface

The browser cryptography module exposes these operations; injected dependencies enable shared browser/Node conformance tests:

```js
inspectRecoveryFile(input)
encryptRecoveryFile(payload, questions, answers, { deriveKey, crypto })
decryptRecoveryFile(file, answers, { deriveKey, crypto })
```

`input` is bounded JSON text or an already parsed plain JSON object. `inspectRecoveryFile` validates the entire envelope before expensive work and returns only bounded public metadata. `questions` is an ordered array of `{id, type, prompt, hint?}`. `answers` is an equally sized array of strings in that order. The payload has its independent version: legacy v1 includes issuer, handle and random recovery token; signed v2 includes issuer, immutable UUID, signing/encryption keychain, random token and provider proof, with no name or assignment. `encryptRecoveryFile` returns the plain envelope object (the browser serializes it to JSON for download). `inspectRecoveryFile` returns a copied, validated header object containing every envelope field except `ciphertext`; this metadata is still unauthenticated. `decryptRecoveryFile` returns the parsed and validated original payload object. Optional missing hints become empty strings in copied metadata, matching the explicit AAD equivalence below.

Question IDs are unique ASCII identifiers matching `[A-Za-z0-9_-]{1,64}`. Types are exactly `text`, `date`, `ssn`, `national-id`, `phone`, `pin`, or `passphrase`. Unknown types are rejected; none silently becomes text. Question order is preserved in the file and UI. Reordering, replacing, or removing a question changes the key input and authenticated metadata.

## Answer normalization profile `3sln-answers-v1`

Normalization provides predictable formatting tolerance, not fuzzy guessing. Never make spelling guesses, remove accents, infer missing digits, replace visually similar letters, guess a country, or try multiple dates. Show the normalization rule alongside the input. Do not display normalized secrets in a persistent review summary. Validate string length before normalization and encoding; reject unpaired UTF-16 surrogates. Reject control and invisible format characters, apart from the explicitly accepted text whitespace below. Every result must be nonempty.

For text whitespace, use a frozen character set: U+0009–000D, U+0020, U+0085, U+00A0, U+1680, U+2000–200A, U+2028–2029, U+202F, U+205F, U+3000. Convert each run to one ASCII space and trim leading/trailing spaces. Do not rely on locale-sensitive comparison or an evolving Unicode property expression. NFKC may convert compatibility spaces before this step. Numeric formatting separators below are the ASCII characters listed, plus this whitespace set; other punctuation is rejected.

| Type | v1 transformation and acceptance |
| --- | --- |
| `text` | NFKC, frozen whitespace collapse/trim, ECMAScript locale-independent `toLowerCase()`, then NFC. Preserve accents and punctuation. `  ALICE   Smith ` equals `alice smith`; `José` and `Jose` differ. |
| `date` | NFKC and outer whitespace trim. Accept a four-digit year, one/two-digit month, one/two-digit day using the same separator `-`, `/`, or `.` throughout. Validate Gregorian day/month/leap-year rules for years 0001–9999. Emit `YYYY-MM-DD`. Prefer a labelled native date field with explicit year-month-day fallback. Never use `Date.parse`, a locale guess, two-digit years, or timezone conversion. |
| `ssn` | NFKC; remove permitted whitespace and ASCII hyphens only; require exactly nine ASCII digits. Preserve zeros. This is formatting, not an assertion that a number was issued or belongs to the user. |
| `national-id` | NFKC; remove permitted whitespace and ASCII hyphens; accept 3–40 ASCII letters/digits; uppercase ASCII letters. Preserve zeros. Use a user-chosen prompt identifying the document/country. This generic type is deliberately bounded; IDs requiring other scripts or significant punctuation should use text. |
| `phone` | NFKC; remove permitted whitespace and ASCII `(`, `)`, `.`, `-`; require `+[1-9][0-9]{7,14}`. Preserve all remaining digits, including national leading zeros. Require the country calling code explicitly; do not guess from device locale, convert `00`, strip trunk prefixes, or accept extensions. The same number, as saved originally, is required even after the user changes phones. |
| `pin` | NFKC and outer whitespace trim; require 4–32 ASCII digits. Preserve all leading zeros; do not strip internal spaces/separators. Use text/password input with numeric keyboard hints, never a number input. |
| `passphrase` | NFC only. Case, punctuation, and ordinary spaces remain significant, including leading/trailing spaces. Require a nonempty bounded string; recommend a long private phrase. Do not silently apply the text type's convenience transformations. |

Lowercasing is **not full Unicode case folding**. `Straße` and `STRASSE` remain different in this profile; dotted/dotless Turkish I retain their standard locale-independent distinctions. NFKC also intentionally merges some compatibility characters, such as full-width ASCII, reducing the set of distinct answers. These tradeoffs must be explained accurately. Current JavaScript engines provide Unicode normalization/casing, but their Unicode data versions can differ for newly assigned characters. Archive this profile's source and golden vectors; establish the supported-browser Unicode repertoire in release verification. Do not claim universal Unicode-version independence without shipping frozen Unicode tables and rejecting out-of-repertoire input. A future frozen-table or full-casefold scheme needs a new named profile, while old files retain this exact algorithm.

No current-date comparison participates in date normalization, because the same file must produce the same key later. Setup may separately explain improbable dates without changing the encoded value. All supplied answers must satisfy their type; an empty or malformed answer cannot be omitted from the tuple.

## Envelope and cryptography

Implemented v1 outer JSON schema:

```json
{
  "format": "3sln-recovery",
  "version": 1,
  "normalization": "3sln-answers-v1",
  "questions": [{"id":"q1","type":"text","prompt":"Your chosen question","hint":"Optional public hint"}],
  "kdf": {"name":"argon2id","version":19,"memoryKiB":65536,"iterations":3,"parallelism":1,"keyBytes":32,"salt":"BASE64URL"},
  "cipher": {"name":"AES-256-GCM","iv":"BASE64URL"},
  "ciphertext": "BASE64URL_CIPHERTEXT_AND_TAG"
}
```

Generate an independent, uniformly random 16-byte salt and 12-byte IV with the cryptographic RNG for every file. Derive 32 bytes using Argon2id version 19 with exactly 65,536 KiB, three iterations, and one lane. This is an application profile, **not** an assertion that it equals RFC 9106's four-lane second recommendation. Measure on supported low-memory phones before release. A resource failure must fail clearly without silently lowering the cost or switching KDFs. No pepper or Argon2 secret input is used.

The Argon2 password/message is UTF-8 JSON with no extra whitespace, constructed in this exact array form from normalized answers:

```js
['3sln-recovery-answers-v1', questions.map((q, i) => [q.id, q.type, normalizedAnswers[i]])]
```

Use AES-256-GCM with a 128-bit authentication tag. Ciphertext is the encrypted UTF-8 JSON recovery payload followed by the tag, matching Web Crypto's result format. No separate answer-verification hash is stored. The additional authenticated data is UTF-8 JSON of the following explicit ordered tuple, with no extra whitespace:

```js
[
  envelope.format, envelope.version, envelope.normalization,
  envelope.questions.map(q => [q.id, q.type, q.prompt, q.hint ?? '']),
  [envelope.kdf.name, envelope.kdf.version, envelope.kdf.memoryKiB,
   envelope.kdf.iterations, envelope.kdf.parallelism,
   envelope.kdf.keyBytes, envelope.kdf.salt],
  [envelope.cipher.name, envelope.cipher.iv]
]
```

Only plain JSON data with the exact schema is accepted. Base64url uses the unpadded canonical URL alphabet; decode and re-encode must agree. No arbitrary property-order dependence, locale sorting, caller-supplied AAD, or JSON replacer participates. Missing and empty hints are intentionally equivalent. Public prompt/hint strings remain byte-for-byte as stored after setup validation; restore must not translate or renormalize them before AAD verification.

Metadata is authenticated **after successful decryption**, not before the user sees it. Display uploaded prompts/hints as untrusted text with length bounds and no HTML, Markdown, links, or network actions. Altered metadata or wrong answers produce the same generic authentication-failure outcome; do not identify which answer was wrong. Unsupported schemas and malformed input may produce separate format errors before the KDF. Never retry an unsupported encrypted envelope as an older plaintext format. Existing plaintext file compatibility, if retained, requires a distinct, explicitly recognized legacy path and must never be an encryption fallback.

## Bounds before cryptographic work

Reject files exceeding 128 KiB before reading/parsing where the browser exposes file size, and check the actual UTF-8 byte length afterward. Reject arrays/primitives where objects are required, unknown top-level/nested fields, unsupported versions/profiles/algorithms, duplicate question IDs, and unexpected types. The envelope has a fixed shallow schema; no attacker-provided recursion is processed.

- One to twelve questions; every selected question has one answer.
- Prompt: 1–240 UTF-8 bytes. Optional hint: 0–240 UTF-8 bytes. IDs follow the bounded ASCII grammar above.
- Each raw and normalized answer: at most 1,024 UTF-8 bytes; additionally reject a raw UTF-16 length over 1,024 before normalization to bound transient allocations. Total raw answer material: at most 12 KiB. The UTF-8 encoded JSON answer tuple additionally has a 32 KiB cap, enforced before worker invocation, because JSON escaping can expand raw input.
- Salt: exactly 16 decoded bytes. IV: exactly 12 decoded bytes. Ciphertext: 17 through 16,400 decoded bytes, allowing at most 16 KiB plaintext plus tag.
- All KDF numbers must be integers equal to the one supported profile. Do not accept arbitrary file-provided memory/iteration/parallelism requests.
- One active derivation per screen; disable repeated submits. Terminate the worker on cancellation, navigation, or completion. Do not launch a KDF while merely inspecting a file.

After authentication, parse the bounded payload and verify its expected recovery schema, nonempty bounded token, and issuer against the current explicitly selected provider before sending any credential. Never redirect to, fetch, or post answers/tokens to an issuer taken from unauthenticated file content.

## Browser and service integration

Use the pinned maintained `hash-wasm` package already present in the lockfile. Its `argon2id` API accepts byte arrays; `memorySize` is in KiB, `hashLength` is bytes, and `outputType: 'binary'` returns bytes. Bundle only the required local assets, retain package provenance/license, and use an injected adapter rather than a hand-written KDF. A dedicated same-origin Web Worker keeps memory-hard work off the UI thread and can be terminated to release its WASM instance. Browser WASM compilation may require CSP `script-src 'wasm-unsafe-eval'`; do not broaden to general `'unsafe-eval'`. This browser dependency does not change the Worker server runtime's separate static-WASM requirements.

PII entry occurs in fresh first-party `/recovery/setup` and `/recovery/restore` documents that do not load Turnstile or other third-party JavaScript. Their CSP allows only first-party scripts/connections, prohibits frames, and grants only `wasm-unsafe-eval` for the dedicated worker. Signup navigates after credential setup and fetches the plaintext recovery payload only after entering the fresh setup document. Restore runs the CAPTCHA on the sign-in document before navigation; sessionStorage transfers only its timestamped short-lived challenge token, not answers, a decrypted payload, or a recovery credential. The restore document requires a challenge no older than four minutes and the server still validates the actual challenge. An expired challenge requires returning to sign-in and re-entering answers; local-development challenge bypass is not production CAPTCHA verification. The existing limited pending setup token remains in same-tab sessionStorage for resumability.

This removes normally loaded third-party scripts from the answer document; it is not a sandbox against an already compromised same-origin script. A malicious prior script may retain same-origin window authority or access origin storage and pending setup authority. Merely removing an old script element would also not remove its authority. Do not claim isolation from prior origin compromise.

Keep raw answers, normalized answers, decrypted payloads, and recovery credentials in private operation state only. Do not place them in UI projections, session/local storage, URLs, logs, analytics, crash reports, or server requests except the existing recovery credential where necessary. Public question metadata can be projected for rendering. Clear references and input fields on cancellation/completion; byte buffers can be wiped where practical, but garbage-collected JavaScript strings cannot promise reliable erasure. Prevent event-dispatch diagnostics from recording form data.

`downloadRecovery` currently creates a random credential and stores only its hash. The browser receives the transient plaintext payload, encrypts it locally, and downloads **only the encrypted envelope**. Retain the random credential privately for the existing `confirmRecovery` proof. Encryption or download failure must not enable confirmation. The current acknowledgement proves possession of the server credential and explicit acknowledgement, not that a durable local filesystem write actually succeeded. The implemented setup additionally requires re-entering every answer and decrypting the encrypted envelope held in private memory before confirmation. It compares the decrypted random token with the pending payload. This checks the chosen answers and generated ciphertext; it does not reread the downloaded file or prove a durable filesystem write. Do not overstate what this local round-trip and download-click flag prove.

For legacy v1, `recover` receives the decrypted token and required abuse proof. Signed v2 additionally submits the complete provider-signed UUID/keychain payload for independent server validation; answers remain on the device. On first accepted recovery, the service clears old credentials/sessions, enters `recovering`, and preserves a hash allowing the same old token to resume that transaction. Resume rotates limited pending authority without erasing newly configured credentials or a replacement file. Confirming a replacement file reactivates the account and removes old resume authority. Keep existing atomic revision/conflict checks and these resume semantics; encryption must not accidentally make an interrupted recovery unrecoverable.

## Required evidence

Unit/conformance coverage must include every answer contributing; order/ID/type binding; formatted SSN, phone, date and PIN equivalents; leading zeros; strict Gregorian dates; rejection of ambiguous dates; Unicode composed/decomposed and full-width vectors; whitespace; text/passphrase case differences; quoted/backslash/newline JSON boundaries; malformed Unicode; wrong answers; metadata/ciphertext/salt/IV tampering; unknown/downgraded algorithms; oversized fields and files; duplicate IDs; and unsupported type/version rejection before KDF invocation. Keep a fixed ciphertext vector produced with deterministic test RNG and known expected key, and exercise it in Node and a real browser with the maintained implementation.

Browser verification additionally covers selecting/removing questions, every-answer-required validation, optional hints, no-answer network/storage leakage, cancellation and repeated submission, encrypted-only download, reload/resume, successful file recovery on a fresh browser context, CSP/worker assets, failed decryption without server mutation, provider mismatch, and replacement-file confirmation invalidating the old token. Run `npm test` after core/server changes and record actual DOM/browser and low-memory-device evidence. Automated tests do not replace independent cryptographic review, human comprehension testing, or the existing production gates.

## Primary references

- [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html): Argon2id construction and parameter-selection guidance; the application deliberately fixes one bounded profile.
- [hash-wasm maintained source/API](https://github.com/Daninet/hash-wasm): confirm installed version and actual types when integrating.
- [Unicode stability policy](https://www.unicode.org/policies/stability_policy.html) and [normalization FAQ](https://www.unicode.org/faq/normalization.html): normalization/casefold stability, distinctions from lowercasing, and newly assigned-character caveats.
