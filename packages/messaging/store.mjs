// Reference adapter. Production adapters MUST provide serializable transactions
// and rollback; a sequence of unrelated KV reads/writes does not satisfy this API.
export class MemoryMessagingStore {
  #records = new Map();
  #tail = Promise.resolve();
  async transaction(operation) {
    const previous = this.#tail;
    let unlock;
    this.#tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    const working = structuredClone(this.#records);
    const tx = {
      get: async key => structuredClone(working.get(key)),
      set: async (key, value) => { working.set(key, structuredClone(value)); },
      delete: async key => { working.delete(key); },
      list: async prefix => [...working].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    };
    try { const result = await operation(tx); this.#records = working; return structuredClone(result); }
    finally { unlock(); }
  }
}

export class MessagingFault extends Error {
  constructor(code, message = code) { super(message); this.name = 'MessagingFault'; this.code = code; }
}
export const fail = (code, message) => { throw new MessagingFault(code, message); };
export const key = (...parts) => parts.map(part => encodeURIComponent(String(part))).join('/') + '/';
export { canonical } from '../core/primitives.mjs';
export const textEncoder = new TextEncoder();
export const strictText = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid_utf8'); } };
export const base64url = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const fromBase64url = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('invalid_encoding');
  try {
    const result = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
    if (base64url(result) !== value) fail('invalid_encoding');
    return result;
  } catch { fail('invalid_encoding'); }
};
export const digest = async (crypto, value) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? textEncoder.encode(value) : value)));
export const boundedString = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export const mimeValid = value => typeof value === 'string' && value.length <= 150 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value);
