import { fail, strictText, fromBase64url, boundedString, mimeValid } from './store.mjs';

export const WEB_ARCHIVE_MIME = 'application/vnd.3sln.web-archive+json';
export const CONTENT_CSP = "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const tags = new Set('p div span br hr b strong em i u s ul ol li pre code blockquote h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr td th'.split(' '));

// Every emitted tag is reconstructed from an inert allowlist, without attributes.
// This deliberately sacrifices links/media/styling instead of attempting regex
// removal of dangerous attributes from the original markup.
export function inertHTML(source) {
  return source.split(/(<[^>]*>)/g).map(part => {
    if (!part.startsWith('<')) return escape(part);
    const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>$/.exec(part);
    if (!match || !tags.has(match[2].toLowerCase())) return '';
    return `<${match[1]}${match[2].toLowerCase()}>`;
  }).join('');
}

export function inspectWebArchive(bytes) {
  if (bytes.byteLength > 10485760) fail('archive_too_large');
  let archive;
  try { archive = JSON.parse(strictText(bytes)); } catch { fail('invalid_archive'); }
  if (archive?.version !== 1 || !Array.isArray(archive.entries) || !archive.entries.length || archive.entries.length > 64 || !boundedString(archive.entrypoint, 240)) fail('invalid_archive');
  const names = new Set(); let total = 0;
  const entries = archive.entries.map(entry => {
    const { path, mimeType, data } = entry || {};
    // No extraction to a filesystem, recursive archives, URL fetching, compression,
    // encoded separators, aliases, absolute paths or traversal.
    if (!boundedString(path, 240) || path.startsWith('/') || /[\\:%?#]/.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..') || names.has(path) || !mimeValid(mimeType) || !['text/plain', 'text/html', 'image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) fail('invalid_archive');
    const content = data === '' ? new Uint8Array() : fromBase64url(data);
    total += content.byteLength;
    if (content.byteLength > 1048576 || total > 4194304) fail('archive_too_large');
    if (mimeType.startsWith('text/')) strictText(content);
    names.add(path); return { path, mimeType, bytes: content };
  });
  const entrypoint = entries.find(entry => entry.path === archive.entrypoint);
  if (!entrypoint || !['text/html', 'text/plain'].includes(entrypoint.mimeType)) fail('invalid_archive');
  return { entrypoint, entries, size: total };
}

export function validateContent(mimeType, bytes) {
  if (mimeType === 'text/plain' || mimeType === 'text/html') strictText(bytes);
  if (mimeType === WEB_ARCHIVE_MIME) inspectWebArchive(bytes);
}

export function renderMessage({ mimeType, bytes }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 10485760) fail('invalid_content');
  if (mimeType === WEB_ARCHIVE_MIME) return renderMessage(inspectWebArchive(bytes).entrypoint);
  if (!['text/plain', 'text/html'].includes(mimeType)) return { kind: 'download', mimeType: 'application/octet-stream', contentDisposition: 'attachment', nosniff: true };
  const source = strictText(bytes);
  const body = mimeType === 'text/html' ? inertHTML(source) : `<pre>${escape(source)}</pre>`;
  return {
    kind: 'document', sandbox: '', referrerPolicy: 'no-referrer', csp: CONTENT_CSP,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CONTENT_CSP}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`,
  };
}
