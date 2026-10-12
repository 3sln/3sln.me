import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, webcrypto } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { encryptRecoveryFile, decryptRecoveryFile, inspectRecoveryFile } from '../packages/recovery/index.mjs';

// Independently reviewed boundaries; the implementation owner's broader suite
// is tests/recovery-file.test.mjs. These tests use real Argon2id and a second
// AES-GCM API, not a substitute KDF or mocked authentication primitive.
const payload = { version: 1, issuer: 'https://identity.example', handle: 'alice', recoveryToken: 'audit-only-random-token', warning: 'Private fixture' };
const questions = [
  { id: 'leading', type: 'pin', prompt: 'Your PIN', hint: 'All digits matter' },
  { id: 'phrase', type: 'passphrase', prompt: 'Your phrase', hint: '' },
];
const answers = ['０００７', ' Élan "\\ private '];
const fixedCrypto = {
  subtle: webcrypto.subtle,
  getRandomValues(bytes) { bytes.set(Array.from({ length: bytes.length }, (_, i) => i + 1)); return bytes; },
};
let fixture;
test.before(async () => { fixture = await encryptRecoveryFile(payload, questions, answers, { deriveKey: argon2id, crypto: fixedCrypto }); });

test('audit: real Argon2 tuple and envelope decrypt with independent Node AES-GCM API', async () => {
  const password = Buffer.from(JSON.stringify(['3sln-recovery-answers-v1', [
    ['leading', 'pin', '0007'], ['phrase', 'passphrase', ' Élan "\\ private '],
  ]]));
  const key = await argon2id({ password, salt: Uint8Array.from({ length: 16 }, (_, i) => i + 1), memorySize: 65536, iterations: 3, parallelism: 1, hashLength: 32, outputType: 'binary' });
  const aad = Buffer.from(JSON.stringify([
    '3sln-recovery', 1, '3sln-answers-v1',
    [['leading', 'pin', 'Your PIN', 'All digits matter'], ['phrase', 'passphrase', 'Your phrase', '']],
    ['argon2id', 19, 65536, 3, 1, 32, 'AQIDBAUGBwgJCgsMDQ4PEA'],
    ['AES-256-GCM', 'AQIDBAUGBwgJCgsM'],
  ]));
  const bytes = Buffer.from(fixture.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from('AQIDBAUGBwgJCgsM', 'base64url'));
  decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()])), payload);
  key.fill(0); password.fill(0);
});

test('audit: own getters at every object/array boundary are rejected without execution', () => {
  for (const path of [['ciphertext'], ['kdf', 'salt'], ['cipher', 'iv'], ['questions', 0], ['questions', 0, 'hint']]) {
    const copy = structuredClone(fixture);
    let parent = copy, calls = 0;
    for (const name of path.slice(0, -1)) parent = parent[name];
    Object.defineProperty(parent, path.at(-1), { enumerable: true, configurable: true, get() { calls++; throw new Error('getter executed'); } });
    assert.throws(() => inspectRecoveryFile(copy), { code: 'recovery_file_invalid' });
    assert.equal(calls, 0, `getter at ${path.join('.')} must not execute`);
  }
});

test('audit: malformed/downgraded/oversized envelope rejects before real KDF entry', async () => {
  let calls = 0;
  const deriveKey = options => { calls++; return argon2id(options); };
  const cases = [
    file => { file.kdf.memoryKiB = 8; }, file => { file.kdf.iterations = 1e12; },
    file => { file.kdf.version = 16; }, file => { file.normalization = 'future'; },
    file => { file.questions[0].prompt = 'x'.repeat(241); },
    file => { file.questions[1].id = file.questions[0].id; },
    file => { file.cipher.iv += '='; }, file => { file.ciphertext = 'A'.repeat(21868); },
    file => { Object.setPrototypeOf(file.kdf, { malicious: true }); },
    file => { Object.defineProperty(file, Symbol('extra'), { value: 1 }); },
  ];
  for (const change of cases) {
    const copy = structuredClone(fixture); change(copy);
    await assert.rejects(decryptRecoveryFile(copy, answers, { deriveKey }), { code: 'recovery_file_invalid' });
  }
  assert.equal(calls, 0);
});

test('audit: attacker-readable prompt/hint metadata and each selected answer are authenticated', async () => {
  for (const change of [
    file => { file.questions[0].prompt = 'Attacker prompt'; },
    file => { file.questions[0].hint = 'Attacker hint'; },
    file => { file.questions[0].id = 'different'; },
  ]) {
    const copy = structuredClone(fixture); change(copy);
    await assert.rejects(decryptRecoveryFile(copy, answers, { deriveKey: argon2id }), { code: 'recovery_file_authentication_failed' });
  }
  const reversed = structuredClone(fixture); reversed.questions.reverse();
  await assert.rejects(decryptRecoveryFile(reversed, [...answers].reverse(), { deriveKey: argon2id }), { code: 'recovery_file_authentication_failed' });
  for (const wrong of [['0008', answers[1]], [answers[0], ' Élan "\\ private']]) {
    await assert.rejects(decryptRecoveryFile(fixture, wrong, { deriveKey: argon2id }), { code: 'recovery_file_authentication_failed' });
  }
  assert.deepEqual(await decryptRecoveryFile(fixture, ['0007', ' E\u0301lan "\\ private '], { deriveKey: argon2id }), payload);
});
