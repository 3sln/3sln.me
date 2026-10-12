import { assertFields, validateText } from './normalization.mjs';
import { normalizeHandle } from '../identity/handles.mjs';

export const MAX_IDENTITY_BACKUP_BYTES = 16 * 1024;
const te = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(message = 'Invalid portable identity backup.') { throw new TypeError(message); }
function enc(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function dec(value, length, max = length) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  let bytes; try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), x => x.charCodeAt(0)); } catch { invalid(); }
  if (bytes.length < length || bytes.length > max || enc(bytes) !== value) invalid(); return bytes;
}
function json(value) { const bytes = te.encode(JSON.stringify(value)); if (bytes.length > MAX_IDENTITY_BACKUP_BYTES) invalid('Identity backup is too large.'); return bytes; }
function fields(value, names) { assertFields(value, names, 'identity backup'); }
function id(value) { if (typeof value !== 'string' || !uuid.test(value)) invalid('Invalid identity or key ID.'); return value; }
function jwk(value, privateKey, purpose = 'signing') {
  const base = ['kty', 'crv', 'x', 'y', ...(privateKey ? ['d'] : [])];
  fields(value, [...base, ...['key_ops', 'ext', 'alg', 'use', 'kid'].filter(k => Object.hasOwn(value ?? {}, k))]);
  if (value.kty !== 'EC' || value.crv !== 'P-256') invalid();
  dec(value.x, 32); dec(value.y, 32); if (privateKey) dec(value.d, 32);
  if (value.ext !== undefined && typeof value.ext !== 'boolean') invalid();
  if (value.alg !== undefined && value.alg !== (purpose === 'signing' ? 'ES256' : 'ECDH-ES')) invalid('Invalid key algorithm.');
  if (value.use !== undefined && value.use !== (purpose === 'signing' ? 'sig' : 'enc')) invalid('Invalid key purpose.');
  if (value.kid !== undefined) validateText(value.kid,'JWK key ID',{maxBytes:128});
  if (value.key_ops !== undefined) {
    const allowed = purpose === 'signing' ? [privateKey ? 'sign' : 'verify'] : (privateKey ? ['deriveKey','deriveBits'] : []);
    if (!Array.isArray(value.key_ops) || value.key_ops.length > allowed.length || new Set(value.key_ops).size !== value.key_ops.length || value.key_ops.some(op => !allowed.includes(op))) invalid('Invalid key operations.');
  }
  return Object.fromEntries(base.map(k => [k, value[k]]));
}
function publicJWK(privateJWK) { const { d, ...publicKey } = privateJWK; return publicKey; }
function keychain(value) {
  fields(value, ['version','signing','encryption']); if (value.version !== 1) invalid();
  const result = { version: 1 };
  for (const purpose of ['signing','encryption']) { fields(value[purpose], ['kid','privateJWK']); result[purpose] = { kid:id(value[purpose].kid), privateJWK:jwk(value[purpose].privateJWK,true,purpose) }; }
  if (result.signing.kid === result.encryption.kid || result.signing.privateJWK.d === result.encryption.privateJWK.d || JSON.stringify(publicJWK(result.signing.privateJWK)) === JSON.stringify(publicJWK(result.encryption.privateJWK))) invalid('Signing and encryption keys must be independent.');
  return result;
}
async function correspondence(chain, crypto) {
  // ECDSA proof of possession also verifies ECDH P-256 scalar/public-point
  // correspondence without relying on an importer's treatment of supplied x/y.
  for (const purpose of ['signing','encryption']) {
    const privateJWK = chain[purpose].privateJWK;
    const priv = await crypto.subtle.importKey('jwk',privateJWK,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
    const pub = await crypto.subtle.importKey('jwk',publicJWK(privateJWK),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const sig = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},priv,challenge);
    if (!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,sig,challenge)) invalid('Private and public keys do not correspond.');
  }
}
function identity(input) {
  validateText(input.issuer,'Issuer',{maxBytes:256}); const url = new URL(input.issuer);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) || url.origin !== input.issuer) invalid('Issuer must be an origin.');
  id(input.entity);
}
function nameClaims(input) {
  identity(input); id(input.assignmentId);
  if (normalizeHandle(input.handle)!==input.handle) invalid('Name certificates require the canonical assigned name.');
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) invalid();
  return {version:1,type:'3sln-name-assignment',issuer:input.issuer,entity:input.entity,handle:input.handle,assignmentId:input.assignmentId,issuedAt:input.issuedAt};
}
async function authorityKey(authority, privateKey, crypto) {
  validateText(authority.kid,'Authority key ID',{maxBytes:128});
  const key = authority[privateKey ? 'privateKey' : 'publicKey']; if (!key) invalid('Trusted provider authority key is required.');
  const result = key.type ? key : await crypto.subtle.importKey('jwk',jwk(key,privateKey),{name:'ECDSA',namedCurve:'P-256'},false,[privateKey?'sign':'verify']);
  if (result.algorithm.name !== 'ECDSA' || result.algorithm.namedCurve !== 'P-256' || result.type !== (privateKey?'private':'public')) invalid(); return result;
}
async function sign(value, domain, authority, crypto) {
  const payload = enc(json(value)); const key = await authorityKey(authority,true,crypto);
  const signature = enc(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,te.encode(`${domain}.ES256.${authority.kid}.${payload}`))));
  return {alg:'ES256',kid:authority.kid,payload,signature};
}
async function verify(proof, value, domain, authority, crypto) {
  fields(proof,['alg','kid','payload','signature']); if (proof.alg !== 'ES256' || proof.kid !== authority.kid) invalid('Untrusted provider authority.');
  dec(proof.payload,1,MAX_IDENTITY_BACKUP_BYTES); const sig=dec(proof.signature,64);
  if (proof.payload !== enc(json(value))) invalid('Identity backup claims do not match its signature.');
  if (!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},await authorityKey(authority,false,crypto),sig,te.encode(`${domain}.ES256.${proof.kid}.${proof.payload}`))) invalid('Invalid provider signature.');
}
export async function generateIdentityKeychain({ signing, crypto = globalThis.crypto } = {}) {
  const create = async name => ({kid:crypto.randomUUID(),privateJWK:await crypto.subtle.exportKey('jwk',(await crypto.subtle.generateKey({name,namedCurve:'P-256'},true,name==='ECDSA'?['sign','verify']:['deriveBits'])).privateKey)});
  const result = keychain({version:1,signing:signing ?? await create('ECDSA'),encryption:await create('ECDH')}); await correspondence(result,crypto); return result;
}
export async function createIdentityBackup(input, authority, {crypto = globalThis.crypto} = {}) {
  fields(input,['issuer','entity','keychain','recoveryToken','warning']); json(input); input=structuredClone(input); identity(input);
  const chain = keychain(input.keychain); await correspondence(chain,crypto);
  validateText(input.recoveryToken,'Recovery credential',{maxBytes:1024}); validateText(input.warning,'Recovery warning',{maxBytes:2048});
  const backup = {version:2,issuer:input.issuer,entity:input.entity,recoveryToken:input.recoveryToken,warning:input.warning,keychain:chain};
  const result = {...backup,proof:await sign(backup,'3sln-identity-backup-v2',authority,crypto)}; json(result); return result;
}
export function validateIdentityBackup(input) {
  if (typeof input === 'string') { if (input.length > MAX_IDENTITY_BACKUP_BYTES) invalid(); input=JSON.parse(input); }
  fields(input,['version','issuer','entity','recoveryToken','warning','keychain','proof']); json(input);
  if (input.version !== 2) invalid(); identity(input); keychain(input.keychain);
  validateText(input.recoveryToken,'Recovery credential',{maxBytes:1024}); validateText(input.warning,'Recovery warning',{maxBytes:2048});
  const {proof,...backup}=input; fields(proof,['alg','kid','payload','signature']);
  validateText(proof.kid,'Authority key ID',{maxBytes:128});
  if (proof.alg !== 'ES256' || proof.payload !== enc(json(backup))) invalid();
  dec(proof.signature,64); dec(proof.payload,1,MAX_IDENTITY_BACKUP_BYTES);
  return structuredClone(input);
}
export async function verifyIdentityBackup(input, authority, expected = {}, {crypto = globalThis.crypto} = {}) {
  input=validateIdentityBackup(input); const chain=keychain(input.keychain);
  const {proof,...backup}=input; await verify(proof,backup,'3sln-identity-backup-v2',authority,crypto);
  for (const name of ['issuer','entity']) if (expected[name] !== undefined && input[name] !== expected[name]) invalid('Backup belongs to another identity.');
  await correspondence(chain,crypto); return structuredClone(input);
}

// Name certificates are independently downloadable PUBLIC artifacts. Never add
// identity private keys or reset credentials to their claims or encoded proof.
export async function createNameAssignment(input, authority, {crypto = globalThis.crypto} = {}) {
  fields(input,['issuer','entity','handle','assignmentId','issuedAt']);
  const claims=nameClaims(input);
  return {...claims,proof:await sign(claims,'3sln-name-assignment-v1',authority,crypto)};
}
export async function verifyNameAssignment(input, authority, expected = {}, {crypto = globalThis.crypto} = {}) {
  if (typeof input === 'string') { if (input.length > MAX_IDENTITY_BACKUP_BYTES) invalid(); input=JSON.parse(input); }
  fields(input,['version','type','issuer','entity','handle','assignmentId','issuedAt','proof']); json(input); input=structuredClone(input);
  const claims=nameClaims(input);
  if(input.version!==claims.version || input.type!==claims.type)invalid('Invalid name certificate purpose.');
  await verify(input.proof,claims,'3sln-name-assignment-v1',authority,crypto);
  for(const name of ['issuer','entity','handle','assignmentId'])if(expected[name]!==undefined&&input[name]!==expected[name])invalid('Name certificate belongs to another assignment.');
  return structuredClone(input);
}
