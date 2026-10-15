// Handle parsing (protocol §2, auth.md "Identity and discovery"): a single local
// part and a DNS host; no userinfo, paths, ports or control characters. Kept as a
// leaf module so elements can validate input before any window opens without
// loading the client.
export const noDefault=host=>!host||host==='none';
export function parseIdentity(value, defaultHost = '3sln.me', {allowInsecureLocalhost=false}={}) {
  const raw = String(value??'').trim();
  // With no default host (default-host="none") only complete handles are accepted.
  if(!raw.includes('@')&&noDefault(defaultHost))throw new Error('Enter a handle like alex@provider.example.');
  const handle = raw.includes('@') ? raw : `${raw}@${defaultHost}`;
  const parts = handle.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /[\s\x00-\x1f\x7f/?#\\]/.test(handle)||parts[0]?.includes(':')||!allowInsecureLocalhost&&handle.includes(':')) throw new Error('Enter a handle like alex@provider.example.');
  const local=allowInsecureLocalhost&&/^localhost(?::[0-9]{1,5})?$/.test(parts[1]);
  if(!local&&parts[1].includes(':'))throw new Error('Use a complete provider hostname.');
  const parsed=new URL(`${local?'http':'https'}://${parts[1]}`),host=local?parsed.host:parsed.hostname;
  if (!local&&(/^\d+(\.\d+){3}$/.test(host) || !host.includes('.') || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)))) throw new Error('Use a complete provider hostname.');
  return { handle: `${parts[0]}@${host}`, username: parts[0], host, manifestUrl: `${local?'http':'https'}://${host}/.well-known/bindle/manifest.json` };
}
