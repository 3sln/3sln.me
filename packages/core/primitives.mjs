// Shared value primitives. Portable and side-effect free: no platform API, no
// storage. Public build source (jstools.config.mjs) because shared client/server
// modules import it. The SDK keeps standalone copies: it ships as standalone bundles.

// Lowercase hyphenated UUID of any version.
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Lowercase RFC 9562 version 4 UUID, as crypto.randomUUID() produces.
export const UUID_V4=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isUUID=value=>typeof value==='string'&&UUID.test(value);
export const isUUIDv4=value=>typeof value==='string'&&UUID_V4.test(value);

// Deterministic JSON for fingerprints and digests: object keys sorted by code
// unit, arrays in order, everything else as JSON.stringify encodes it (so an
// undefined member encodes as `undefined`, not `null`). Changing these rules
// changes every stored fingerprint.
export const canonical=value=>{
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
 return JSON.stringify(value);
};
