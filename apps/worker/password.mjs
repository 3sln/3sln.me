import { argon2id } from '../../vendor/hash-wasm/argon2-workers.mjs';
import { secureEqual } from '../../packages/identity/crypto.mjs';

export function createWorkerArgon2Hasher(crypto = globalThis.crypto) {
  const parameters = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' };
  return {
    dummyHash: '$argon2id$v=19$m=19456,t=2,p=1$R0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0c$9tLroxbSbCfoHVkG03K2Gm/gZgJJysqgzviXx72h6xU',
    async hash(password) { return argon2id({ ...parameters, password, salt: crypto.getRandomValues(new Uint8Array(32)) }); },
    async verify(password, encoded) {
      if (typeof encoded !== 'string' || !/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{43}\$[A-Za-z0-9+/]{43}$/.test(encoded)) return false;
      const salt = Uint8Array.from(atob(encoded.split('$')[4]), c => c.charCodeAt(0));
      try { return secureEqual(await argon2id({ ...parameters, password, salt }), encoded); } catch { return false; }
    },
  };
}
