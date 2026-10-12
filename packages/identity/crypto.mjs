const encoder = new TextEncoder();
export function encode(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid base64url');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export class IdentityCrypto {
  constructor(crypto = globalThis.crypto) { this.crypto = crypto; }
  random(size = 32) { return encode(this.crypto.getRandomValues(new Uint8Array(size))); }
  id() { return this.crypto.randomUUID(); }
  async hash(purpose, value) { return encode(new Uint8Array(await this.crypto.subtle.digest('SHA-256', encoder.encode(`${purpose}\0${value}`)))); }
}

// Kept separate from the portable service so runtimes may supply another
// reviewed password implementation without changing the account lifecycle.
export async function createArgon2Hasher(crypto = globalThis.crypto) {
  const { argon2id, argon2Verify } = await import('hash-wasm');
  return {
    dummyHash: '$argon2id$v=19$m=19456,t=2,p=1$R0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0c$9tLroxbSbCfoHVkG03K2Gm/gZgJJysqgzviXx72h6xU',
    async hash(password) {
      return argon2id({ password, salt: crypto.getRandomValues(new Uint8Array(32)),
        parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
    },
    async verify(password, encoded) {
      // Only our fixed parameters are accepted; corrupt records cannot request
      // unbounded allocation or work from the WASM implementation.
      if (typeof encoded !== 'string' || !/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(encoded)) return false;
      try { return await argon2Verify({ password, hash: encoded }); } catch { return false; }
    },
  };
}
