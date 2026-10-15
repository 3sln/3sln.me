import test from 'node:test';
import assert from 'node:assert/strict';
import { argon2id } from 'hash-wasm';
import { decryptRecoveryFile, encryptRecoveryFile, inspectRecoveryFile, normalizeAnswer, validateQuestions,
  KDF_PARAMETERS, MAX_FILE_BYTES } from '../packages/recovery/index.mjs';
import { RECOVERY_V1_VECTOR as vector } from '../packages/recovery/vectors.mjs';

const options = { deriveKey: argon2id, crypto: globalThis.crypto };
const clone = value => structuredClone(value);
function vectorFile() {
  return { format: '3sln-recovery', version: 1, normalization: '3sln-answers-v1',
    questions: clone(vector.questions), kdf: { ...KDF_PARAMETERS, salt: vector.salt },
    cipher: { name: 'AES-256-GCM', iv: vector.iv }, ciphertext: vector.ciphertext };
}
function deterministicCrypto() {
  let offset = 0;
  return { subtle: globalThis.crypto.subtle, getRandomValues(bytes) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = offset++;
    return bytes;
  } };
}
// Header/answer binding is a property of the AEAD construction, not of the KDF.
// Binding tests use a fast keyed substitute; the archived vector and the
// independent audit suite exercise real Argon2id.
const fastOptions = { crypto: globalThis.crypto, deriveKey: async ({ password, salt, hashLength }) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...password, ...salt]))).slice(0, hashLength) };
const fastFile = async () => encryptRecoveryFile(vector.payload, vector.questions, vector.answers, { ...fastOptions, crypto: deterministicCrypto() });
function encode(bytes) { return Buffer.from(bytes).toString('base64url'); }
function changeByte(encoded) {
  const bytes = Buffer.from(encoded, 'base64url'); bytes[0] ^= 1; return encode(bytes);
}

test('portable recovery file matches archived Argon2id/AES-GCM vector and preserves random service credential', async () => {
  let derivedHex;
  const deriveKey = async request => {
    assert.deepEqual(Object.keys(request), ['password', 'salt', 'memorySize', 'iterations', 'parallelism', 'hashLength', 'outputType']);
    assert(request.password instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(request.password), JSON.stringify(['3sln-recovery-answers-v1',
      vector.questions.map((q, i) => [q.id, q.type, vector.normalizedAnswers[i]])]));
    assert.equal(request.memorySize, 65536); assert.equal(request.iterations, 3);
    assert.equal(request.parallelism, 1); assert.equal(request.hashLength, 32); assert.equal(request.outputType, 'binary');
    const key = await argon2id(request); derivedHex = Buffer.from(key).toString('hex'); return key;
  };
  const file = await encryptRecoveryFile(JSON.stringify(vector.payload), vector.questions, vector.answers,
    { deriveKey, crypto: deterministicCrypto() });
  assert.equal(derivedHex, vector.keyHex);
  assert.deepEqual(file, vectorFile());
  assert.deepEqual(await decryptRecoveryFile(JSON.stringify(file), vector.answers, options), vector.payload);
  const content = JSON.stringify(file);
  assert(!content.includes(vector.payload.recoveryToken));
  assert(!content.includes(vector.payload.issuer));
  assert(!content.includes(vector.answers[6]));
});

test('every selected answer is required and contributes to the one derived key', async () => {
  const file = await fastFile();
  assert.deepEqual(await decryptRecoveryFile(file, vector.answers, fastOptions), vector.payload);
  const replacements = ['Different name', '2000-03-01', '101020003', 'AB10123', '+4412012345678', '0018', 'different private phrase'];
  for (let i = 0; i < vector.answers.length; i++) {
    const answers = [...vector.answers]; answers[i] = replacements[i];
    await assert.rejects(decryptRecoveryFile(file, answers, fastOptions), { code: 'recovery_file_authentication_failed' });
  }
  await assert.rejects(decryptRecoveryFile(file, vector.answers.slice(1), options), /Answer every selected/);
  const empty = [...vector.answers]; empty[1] = '';
  await assert.rejects(decryptRecoveryFile(file, empty, options), /cannot be empty/);
});

test('public question metadata, KDF salt, IV, ciphertext, and question order are authenticated', async () => {
  const base = await fastFile();
  const modifications = [
    file => { file.questions[0].prompt += '!'; },
    file => { file.questions[0].hint += '!'; },
    file => { file.questions[0].id = 'renamed'; },
    file => { file.questions[0].type = 'passphrase'; },
    file => { file.kdf.salt = changeByte(file.kdf.salt); },
    file => { file.cipher.iv = changeByte(file.cipher.iv); },
    file => { file.ciphertext = changeByte(file.ciphertext); },
    file => { file.questions.reverse(); },
  ];
  for (const mutate of modifications) {
    const file = structuredClone(base); mutate(file);
    const answers = file.questions[0].id === 'phrase' ? [...vector.answers].reverse() : vector.answers;
    // The changed type uses a valid passphrase string so it reaches GCM verification.
    if (file.questions[0].type === 'passphrase' && file.questions[0].id === 'name') {
      const validAnswers = [...answers]; validAnswers[0] = vector.normalizedAnswers[0];
      await assert.rejects(decryptRecoveryFile(file, validAnswers, fastOptions), { code: 'recovery_file_authentication_failed' });
    } else {
      await assert.rejects(decryptRecoveryFile(file, answers, fastOptions), { code: 'recovery_file_authentication_failed' });
    }
  }
  const missingHint = structuredClone(base); delete missingHint.questions[1].hint;
  assert.deepEqual(await decryptRecoveryFile(missingHint, vector.answers, fastOptions), vector.payload);
});

test('safe inspection copies only bounded unauthenticated public header and never derives a key', () => {
  const file = vectorFile(); const header = inspectRecoveryFile(JSON.stringify(file));
  assert.equal(Object.hasOwn(header, 'ciphertext'), false);
  assert.deepEqual(header.questions, file.questions);
  header.questions[0].prompt = 'Changed copy';
  assert.equal(file.questions[0].prompt, vector.questions[0].prompt);
  assert.equal(Object.hasOwn(header, 'recoveryToken'), false);
});

test('normalization is deterministic across Unicode, frozen whitespace and formatting equivalents', () => {
  assert.equal(normalizeAnswer('text', '\t JOSÉ\n\u0085  Smith \u3000'), 'josé smith');
  assert.equal(normalizeAnswer('text', 'José'), normalizeAnswer('text', 'Jose\u0301'));
  assert.notEqual(normalizeAnswer('text', 'José'), normalizeAnswer('text', 'Jose'));
  assert.equal(normalizeAnswer('text', 'Ｆｕｌｌ－Ｗｉｄｔｈ'), 'full-width');
  assert.equal(normalizeAnswer('text', 'StrAße'), 'straße');
  assert.notEqual(normalizeAnswer('text', 'Straße'), normalizeAnswer('text', 'STRASSE'));
  assert.equal(normalizeAnswer('text', 'İ I ı'), 'i\u0307 i ı');
  assert.equal(normalizeAnswer('text', 'O’Connor, Jr.'), 'o’connor, jr.');
  assert.equal(normalizeAnswer('passphrase', ' Café '), ' Café ');
  assert.equal(normalizeAnswer('passphrase', 'Cafe\u0301'), 'Café');
  assert.notEqual(normalizeAnswer('passphrase', 'Secret '), normalizeAnswer('passphrase', 'secret'));
  assert.notEqual(normalizeAnswer('passphrase', 'Secret '), normalizeAnswer('passphrase', 'Secret'));
  assert.equal(normalizeAnswer('passphrase', ' '), ' ');
  assert.equal(normalizeAnswer('ssn', '００１\u00a0-０２-０００３'), '001020003');
  assert.equal(normalizeAnswer('national-id', ' ab - ００１２３ '), 'AB00123');
  assert.equal(normalizeAnswer('phone', '+44 (0)20-1234.5678'), '+4402012345678');
  assert.equal(normalizeAnswer('pin', ' ００１７ '), '0017');
  assert.notEqual(normalizeAnswer('pin', '0017'), normalizeAnswer('pin', '1017'));
  for (const [type, invalid] of [['ssn', '123.45.6789'], ['national-id', 'ß123'], ['national-id', 'AB'],
    ['phone', '00442012345678'], ['phone', '02012345678'], ['phone', '+442012345678 ext 2'],
    ['pin', '00 17'], ['pin', '001-7'], ['pin', '123']]) assert.throws(() => normalizeAnswer(type, invalid));
  for (const type of ['text', 'passphrase', 'date', 'ssn', 'national-id', 'phone', 'pin']) {
    for (const invalid of ['\ud800', '\udfff', 'hello\u200b', 'hello\u0000', 'hello\u2066']) assert.throws(() => normalizeAnswer(type, invalid));
  }
  assert.throws(() => normalizeAnswer('passphrase', 'some\nphrase'));
  assert.throws(() => normalizeAnswer('text', '😀'.repeat(257)), /too long/);
  assert.throws(() => normalizeAnswer('text', 'a'.repeat(1025)), /too long/);
  assert.throws(() => normalizeAnswer('unknown', 'hello'), /Unsupported/);
});

test('date normalization uses strict year-first Gregorian rules with no locale or timezone guessing', () => {
  for (const value of ['2000-02-29', '2000/2/29', '2000.2.29', ' ２０００－２－２９ ']) assert.equal(normalizeAnswer('date', value), '2000-02-29');
  assert.equal(normalizeAnswer('date', '0001/1/1'), '0001-01-01');
  assert.equal(normalizeAnswer('date', '2400/2/29'), '2400-02-29');
  for (const value of ['0000-01-01', '1900-02-29', '2100-02-29', '2023-02-29', '2024-04-31',
    '2024-00-01', '2024-13-01', '2024-01-00', '2024-1/1', '02/03/2000', '20-01-01',
    '2024-01-01T00:00:00Z', '+2024-01-01', '10000-01-01']) assert.throws(() => normalizeAnswer('date', value));
});

test('unsupported schema, arbitrary resource requests and oversized data fail before key derivation', async () => {
  let derives = 0;
  const forbiddenOptions = { crypto: globalThis.crypto, deriveKey() { derives++; throw new Error('Must not derive'); } };
  const modifications = [
    file => { file.format = 'legacy-recovery'; }, file => { file.version = 2; },
    file => { file.normalization = 'future-profile'; }, file => { file.unknown = true; },
    file => { file.questions[0].type = 'password'; }, file => { file.questions[0].unexpected = true; },
    file => { file.questions[1].id = file.questions[0].id; }, file => { file.questions = []; },
    file => { file.questions = Array(13).fill(file.questions[0]); },
    file => { file.questions[0].prompt = 'a'.repeat(241); }, file => { file.questions[0].hint = '😀'.repeat(61); },
    file => { file.questions[0].hint = null; }, file => { file.questions[0].prompt = '<script>\u0000</script>'; },
    file => { file.kdf.memoryKiB = 1000000000; }, file => { file.kdf.iterations = 0; },
    file => { file.kdf.parallelism = 128; }, file => { file.kdf.version = 16; },
    file => { file.kdf.name = 'pbkdf2'; }, file => { file.kdf.keyBytes = 16; }, file => { file.kdf.extra = 0; },
    file => { file.kdf.salt += '='; }, file => { file.kdf.salt = encode(new Uint8Array(15)); },
    file => { file.kdf.salt = `${file.kdf.salt.slice(0, -1)}x`; },
    file => { file.cipher.name = 'AES-CBC'; }, file => { file.cipher.extra = true; },
    file => { file.cipher.iv = encode(new Uint8Array(13)); },
    file => { file.ciphertext = encode(new Uint8Array(16)); },
    file => { file.ciphertext = encode(new Uint8Array(16401)); },
  ];
  for (const mutate of modifications) {
    const file = vectorFile(); mutate(file);
    assert.throws(() => inspectRecoveryFile(file), { code: 'recovery_file_invalid' });
    await assert.rejects(decryptRecoveryFile(file, vector.answers, forbiddenOptions), { code: 'recovery_file_invalid' });
  }
  for (const input of [' '.repeat(MAX_FILE_BYTES + 1), '{', 'null', '[]', JSON.stringify(vector.payload), 5]) {
    await assert.rejects(decryptRecoveryFile(input, vector.answers, forbiddenOptions), { code: 'recovery_file_invalid' });
  }
  await assert.rejects(decryptRecoveryFile(vectorFile(), ['a'.repeat(1025), ...vector.answers.slice(1)], forbiddenOptions), /too long/);
  assert.equal(derives, 0);
});

test('plain-object API rejects accessors, sparse arrays and hidden schema fields', () => {
  const accessor = vectorFile(); let getterCalled = false;
  Object.defineProperty(accessor, 'questions', { get() { getterCalled = true; return vector.questions; }, enumerable: true });
  assert.throws(() => inspectRecoveryFile(accessor)); assert.equal(getterCalled, false);
  const hidden = vectorFile(); Object.defineProperty(hidden, 'hidden', { value: true }); assert.throws(() => inspectRecoveryFile(hidden));
  const symbol = vectorFile(); symbol[Symbol('hidden')] = true; assert.throws(() => inspectRecoveryFile(symbol));
  const sparse = vectorFile(); delete sparse.questions[2]; assert.throws(() => inspectRecoveryFile(sparse));
  const arrayProp = vectorFile(); arrayProp.questions.extra = true; assert.throws(() => inspectRecoveryFile(arrayProp));
  assert.throws(() => validateQuestions([{ id: 'q', type: 'text', prompt: 'Question', hint: null }]));
});

test('encryption requires one key implementation with no fallback and wipes byte buffers after use', async () => {
  await assert.rejects(encryptRecoveryFile(vector.payload, vector.questions, vector.answers, { crypto: globalThis.crypto }), /Argon2id/);
  await assert.rejects(encryptRecoveryFile(vector.payload, vector.questions, vector.answers,
    { crypto: globalThis.crypto, deriveKey: async () => 'f'.repeat(64) }), /32 key bytes/);
  let password; let derived;
  const file = await encryptRecoveryFile(vector.payload, vector.questions, vector.answers, {
    crypto: deterministicCrypto(), async deriveKey(request) { password = request.password; derived = await argon2id(request); return derived; },
  });
  assert.deepEqual(file, vectorFile());
  assert(password.every(byte => byte === 0)); assert(derived.every(byte => byte === 0));
  const first = await encryptRecoveryFile(vector.payload, [vector.questions[0]], [vector.answers[0]], options);
  const second = await encryptRecoveryFile(vector.payload, [vector.questions[0]], [vector.answers[0]], options);
  assert.notEqual(first.kdf.salt, second.kdf.salt); assert.notEqual(first.cipher.iv, second.cipher.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('setup refuses public hints that reveal the complete raw or equivalent typed answer before deriving', async () => {
  let derives = 0;
  const forbiddenOptions = { crypto: globalThis.crypto, deriveKey() { derives++; throw new Error('Must not derive'); } };
  for (const [type, answer, hint] of [
    ['text', 'Alice Smith', ' ALICE  SMITH '],
    ['date', '2000-02-29', '2000/2/29'],
    ['ssn', '001-02-0003', '001020003'],
    ['national-id', 'AB-00123', 'ab00123'],
    ['phone', '+44 (0)20 1234 5678', '+4402012345678'],
    ['pin', ' 0017 ', '0017'],
    ['passphrase', 'A private secret', 'A private secret'],
  ]) {
    const question = [{ id: 'q', type, prompt: 'Question', hint }];
    await assert.rejects(encryptRecoveryFile(vector.payload, question, [answer], forbiddenOptions), error =>
      error.message === 'A public hint cannot contain the whole recovery answer.' && !error.message.includes(answer));
  }
  assert.equal(derives, 0);
  // No fuzzy/substring restriction; these hints are distinct and ordinary hints
  // need not conform to the answer's type. Authentication remains unchanged.
  const file = await encryptRecoveryFile(vector.payload,
    [{ id: 'q', type: 'pin', prompt: 'Your selected PIN', hint: 'First two digits are 00' }], ['0017'], options);
  assert.deepEqual(await decryptRecoveryFile(file, ['0017'], options), vector.payload);
});
