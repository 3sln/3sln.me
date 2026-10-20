// Helpers shared by the AccountController core and its slices (packages/runtime/account/index.mjs).
export async function archiveDigest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
