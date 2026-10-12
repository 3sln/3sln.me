import { ANSWER_NORMALIZATION, assertFields, normalizeAnswer, validateArray, validateQuestions, validateText } from './normalization.mjs';

export { ANSWER_NORMALIZATION, MAX_METADATA_BYTES, MAX_QUESTIONS, MAX_TEXT_BYTES, QUESTION_TYPES, normalizeAnswer, validateQuestions } from './normalization.mjs';

export const RECOVERY_FORMAT = '3sln-recovery';
export const RECOVERY_VERSION = 1;
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const KDF_PARAMETERS = Object.freeze({ name: 'argon2id', version: 19, memoryKiB: 65536, iterations: 3, parallelism: 1, keyBytes: 32 });

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const envelopeFields = ['format', 'version', 'normalization', 'questions', 'kdf', 'cipher', 'ciphertext'];
const kdfFields = [...Object.keys(KDF_PARAMETERS), 'salt'];

function formatError(message = 'Unsupported or malformed encrypted recovery file.') {
  const error = new TypeError(message); error.code = 'recovery_file_invalid'; return error;
}
function authenticationError() {
  const error = new Error('The file could not be decrypted. Check every answer and the recovery file.');
  error.code = 'recovery_file_authentication_failed'; return error;
}
function encode(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value, minBytes, maxBytes, label) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw formatError(`Invalid ${label}.`);
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { throw formatError(`Invalid ${label}.`); }
  if (bytes.length < minBytes || bytes.length > maxBytes || encode(bytes) !== value) throw formatError(`Invalid ${label}.`);
  return bytes;
}
function bytesOfJSON(value, maxBytes, label) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > maxBytes) throw formatError(`${label} is too large.`);
  return bytes;
}
function readEnvelope(input) {
  if (typeof input === 'string') {
    if (input.length > MAX_FILE_BYTES || encoder.encode(input).length > MAX_FILE_BYTES) throw formatError('Recovery file is too large.');
    try { input = JSON.parse(input); } catch { throw formatError('Recovery file must contain valid JSON.'); }
  }
  try {
    assertFields(input, envelopeFields, 'encrypted recovery file');
    if (input.format !== RECOVERY_FORMAT || input.version !== RECOVERY_VERSION || input.normalization !== ANSWER_NORMALIZATION) throw formatError();
    const questions = validateQuestions(input.questions);
    assertFields(input.kdf, kdfFields, 'recovery KDF');
    for (const [field, expected] of Object.entries(KDF_PARAMETERS)) if (input.kdf[field] !== expected) throw formatError('Unsupported recovery KDF parameters.');
    const salt = decode(input.kdf.salt, 16, 16, 'recovery salt');
    assertFields(input.cipher, ['name', 'iv'], 'recovery cipher');
    if (input.cipher.name !== 'AES-256-GCM') throw formatError('Unsupported recovery cipher.');
    const iv = decode(input.cipher.iv, 12, 12, 'recovery IV');
    const ciphertext = decode(input.ciphertext, 17, MAX_PAYLOAD_BYTES + 16, 'recovery ciphertext');
    const envelope = {
      format: input.format, version: input.version, normalization: input.normalization,
      questions, kdf: { ...KDF_PARAMETERS, salt: input.kdf.salt },
      cipher: { name: input.cipher.name, iv: input.cipher.iv }, ciphertext: input.ciphertext,
    };
    bytesOfJSON(envelope, MAX_FILE_BYTES, 'Recovery file');
    return { envelope, salt, iv, ciphertext };
  } catch (error) { if (error.code === 'recovery_file_invalid') throw error; throw formatError(error.message); }
}

// The inspected metadata has not yet been authenticated. Render it as text only.
export function inspectRecoveryFile(input) {
  const { envelope } = readEnvelope(input);
  const { ciphertext, ...header } = envelope;
  return header;
}

function authenticatedHeader(envelope) {
  return encoder.encode(JSON.stringify([
    envelope.format, envelope.version, envelope.normalization,
    envelope.questions.map(q => [q.id, q.type, q.prompt, q.hint ?? '']),
    [envelope.kdf.name, envelope.kdf.version, envelope.kdf.memoryKiB,
      envelope.kdf.iterations, envelope.kdf.parallelism, envelope.kdf.keyBytes, envelope.kdf.salt],
    [envelope.cipher.name, envelope.cipher.iv],
  ]));
}

function validatePayload(input) {
  if (typeof input === 'string') {
    if (input.length > MAX_PAYLOAD_BYTES || encoder.encode(input).length > MAX_PAYLOAD_BYTES) throw formatError('Recovery payload is too large.');
    try { input = JSON.parse(input); } catch { throw formatError('Recovery payload must contain valid JSON.'); }
  }
  // Keep the existing service credential and payload schema unchanged.
  assertFields(input, ['version', 'issuer', 'handle', 'recoveryToken', 'warning'], 'recovery payload');
  if (input.version !== 1) throw formatError('Unsupported recovery payload version.');
  validateText(input.issuer, 'Recovery issuer');
  validateText(input.handle, 'Recovery handle');
  validateText(input.recoveryToken, 'Recovery credential');
  validateText(input.warning, 'Recovery warning', { maxBytes: MAX_PAYLOAD_BYTES });
  const payload = { version: input.version, issuer: input.issuer, handle: input.handle, recoveryToken: input.recoveryToken, warning: input.warning };
  bytesOfJSON(payload, MAX_PAYLOAD_BYTES, 'Recovery payload');
  return payload;
}

function requireDependencies({ deriveKey, crypto = globalThis.crypto } = {}) {
  if (typeof deriveKey !== 'function') throw new TypeError('An Argon2id key derivation implementation is required.');
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') throw new TypeError('Web Crypto is required.');
  return { deriveKey, crypto };
}

async function keyFromAnswers(questions, answers, salt, deriveKey, crypto, protectHints = false) {
  validateArray(answers, 'Recovery answers');
  if (answers.length !== questions.length) throw new TypeError('Answer every selected recovery question.');
  const normalized = questions.map((question, index) => normalizeAnswer(question.type, answers[index]));
  if (protectHints) {
    for (let i = 0; i < questions.length; i++) {
      const hint = questions[i].hint;
      if (!hint) continue;
      let normalizedHint;
      try { normalizedHint = normalizeAnswer(questions[i].type, hint); } catch { /* Public hints need not be valid typed answers. */ }
      if (hint === answers[i] || normalizedHint === normalized[i]) {
        normalized.fill(null);
        throw new TypeError('A public hint cannot contain the whole recovery answer.');
      }
    }
  }
  const password = bytesOfJSON(['3sln-recovery-answers-v1', questions.map((q, i) => [q.id, q.type, normalized[i]])], 32768, 'Encoded recovery answers');
  let bytes;
  try {
    bytes = await deriveKey({ password, salt, memorySize: KDF_PARAMETERS.memoryKiB,
      iterations: KDF_PARAMETERS.iterations, parallelism: KDF_PARAMETERS.parallelism,
      hashLength: KDF_PARAMETERS.keyBytes, outputType: 'binary' });
    if (!(bytes instanceof Uint8Array) || bytes.length !== KDF_PARAMETERS.keyBytes) throw new TypeError('Argon2id must return exactly 32 key bytes.');
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    password.fill(0);
    if (bytes instanceof Uint8Array) bytes.fill(0);
    normalized.fill(null);
  }
}

export async function encryptRecoveryFile(payload, questions, answers, options) {
  const { deriveKey, crypto } = requireDependencies(options);
  payload = validatePayload(payload);
  questions = validateQuestions(questions);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope = { format: RECOVERY_FORMAT, version: RECOVERY_VERSION, normalization: ANSWER_NORMALIZATION,
    questions, kdf: { ...KDF_PARAMETERS, salt: encode(salt) }, cipher: { name: 'AES-256-GCM', iv: encode(iv) } };
  const key = await keyFromAnswers(questions, answers, salt, deriveKey, crypto, true);
  const plaintext = bytesOfJSON(payload, MAX_PAYLOAD_BYTES, 'Recovery payload');
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: authenticatedHeader(envelope), tagLength: 128 }, key, plaintext);
    envelope.ciphertext = encode(new Uint8Array(encrypted));
    return envelope;
  } finally { plaintext.fill(0); }
}

export async function decryptRecoveryFile(input, answers, options) {
  // Reject every untrusted format/parameter/size before invoking the KDF.
  const { envelope, salt, iv, ciphertext } = readEnvelope(input);
  const { deriveKey, crypto } = requireDependencies(options);
  const key = await keyFromAnswers(envelope.questions, answers, salt, deriveKey, crypto);
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv,
      additionalData: authenticatedHeader(envelope), tagLength: 128 }, key, ciphertext));
    return validatePayload(decoder.decode(plaintext));
  } catch { throw authenticationError(); }
  finally { plaintext?.fill(0); }
}
