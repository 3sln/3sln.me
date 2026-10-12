export function parseIdentity(value, defaultHost = '3sln.me') {
  const raw = value.trim();
  const handle = raw.includes('@') ? raw : `${raw}@${defaultHost}`;
  const parts = handle.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /[\s\x00-\x1f\x7f/:?#\\]/.test(handle)) throw new Error('Enter a handle like alex@provider.example.');
  const host = new URL(`https://${parts[1]}`).hostname;
  if (/^\d+(\.\d+){3}$/.test(host) || !host.includes('.') || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw new Error('Use a complete provider hostname.');
  return { handle: `${parts[0]}@${host}`, username: parts[0], host, manifestUrl: `https://${host}/.well-known/bindle/manifest.json` };
}
export async function discoverIdentity(value, { fetcher = fetch, signal } = {}) {
  const identity = parseIdentity(value);
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
  const response = await fetcher(identity.manifestUrl, { signal: boundedSignal, credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
  // Only a definite absence allows fallback. Network failures must not silently switch providers.
  if (response.status === 404 || response.status === 410) return { identity, kind: 'email-fallback', provider: 'https://3sln.me' };
  if (!response.ok) throw new Error(`Provider discovery failed (${response.status}).`);
  if (!response.headers?.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('Provider manifest must be JSON.');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); throw new Error('Provider manifest is too large.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    text = new TextDecoder().decode(joined);
  } else text = await response.text();
  if (new TextEncoder().encode(text).length > 65536) throw new Error('Provider manifest is too large.');
  const manifest = JSON.parse(text);
  const issuer = `https://${identity.host}`;
  if (!manifest || manifest.version !== '0' || manifest.issuer !== issuer) throw new Error('Unsupported manifest version or mismatched issuer.');
  if (!Array.isArray(manifest.login_presentation) || !manifest.login_presentation.includes('redirect')) throw new Error('Provider must support redirect login.');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'rpc_endpoint', 'jwks_uri']) {
    if (typeof manifest[key] !== 'string') throw new Error(`Missing provider endpoint: ${key}.`);
    const endpoint = new URL(manifest[key]);
    if (endpoint.origin !== issuer || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Provider endpoints must belong to the issuer origin.');
  }
  const login = new URL(manifest.authorization_endpoint);
  return { identity, kind: 'provider', manifest, loginUrl: login.href, presentation: 'redirect' };
}
