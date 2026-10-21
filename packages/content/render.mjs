import { fail, strictText, fromBase64url, boundedString, mimeValid } from '../core/records.mjs';

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

export const CONVERSATION_INVITE_MIME='application/vnd.3sln.conversation-invite+json';
export const CONVERSATION_EVENT_MIME='application/vnd.3sln.conversation-event+json';
export function conversationText(mimeType,bytes){
 if(![CONVERSATION_INVITE_MIME,CONVERSATION_EVENT_MIME].includes(mimeType))return null;
 if(bytes.byteLength>100000)fail('invalid_conversation_content');
 let value;try{value=JSON.parse(strictText(bytes));}catch{fail('invalid_conversation_content');}
 const event=mimeType===CONVERSATION_EVENT_MIME,keys=event?['version','kind','conversationId','source','eventId','threadId','replyTo','title','text','actor','tags','createdAt']:['version','kind','conversationId','source','invitationId','title','permissions','expiresAt'];
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
 if(!value||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||value.version!==1||value.kind!==(event?'event':'invitation')||!uuid(value.conversationId)||typeof value.title!=='string'||value.title.length>100||!value.source||Object.keys(value.source).some(k=>!['origin','owner'].includes(k))||!uuid(value.source.owner))fail('invalid_conversation_content');
 let origin;try{origin=new URL(value.source.origin);}catch{fail('invalid_conversation_content');}if(!['https:','http:'].includes(origin.protocol)||origin.origin!==value.source.origin||origin.username||origin.password)fail('invalid_conversation_content');
 if(event){if(!uuid(value.eventId)||!uuid(value.threadId)||value.replyTo!==null&&!uuid(value.replyTo)||typeof value.text!=='string'||value.text.length>16000||typeof value.actor!=='string'||value.actor.length>2048||!Array.isArray(value.tags)||value.tags.length>32||value.tags.some(t=>typeof t!=='string'||t.length>100)||!Number.isSafeInteger(value.createdAt))fail('invalid_conversation_content');return value.title+'\n\n'+value.text;}
 if(!uuid(value.invitationId)||!Number.isSafeInteger(value.expiresAt)||!value.permissions||Object.keys(value.permissions).some(k=>!['send','invite','admin'].includes(k))||['send','invite','admin'].some(k=>typeof value.permissions[k]!=='boolean'))fail('invalid_conversation_content');
 return value.title+'\n\nConversation invitation. Open Conversations to review membership and choose whether to join.';
}

export function validateContent(mimeType, bytes) {
  conversationText(mimeType,bytes);
  if (mimeType === 'text/plain' || mimeType === 'text/html') strictText(bytes);
  if (mimeType === WEB_ARCHIVE_MIME) inspectWebArchive(bytes);
}

export function renderMessage({ mimeType, bytes }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 10485760) fail('invalid_content');
  const conversation=conversationText(mimeType,bytes);if(conversation!==null)return renderMessage({mimeType:'text/plain',bytes:new TextEncoder().encode(conversation)});
  if (mimeType === WEB_ARCHIVE_MIME) return renderMessage(inspectWebArchive(bytes).entrypoint);
  if (!['text/plain', 'text/html'].includes(mimeType)) return { kind: 'download', mimeType: 'application/octet-stream', contentDisposition: 'attachment', nosniff: true };
  const source = strictText(bytes);
  const body = mimeType === 'text/html' ? inertHTML(source) : `<pre>${escape(source)}</pre>`;
  return {
    kind: 'document', sandbox: '', referrerPolicy: 'no-referrer', csp: CONTENT_CSP,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CONTENT_CSP}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`,
  };
}
