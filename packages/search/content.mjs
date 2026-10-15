import { migrateTags } from '../messaging/tags.mjs';
import { inspectWebArchive, WEB_ARCHIVE_MIME, conversationText } from '../messaging/content.mjs';
import { fail, DEFAULT_BUDGETS } from './schema.mjs';

// Extraction is inert text only. It never executes HTML, follows links, fetches
// remote media, expands recursive archives, or guesses OCR/transcription.
export function extractSearchText({ mimeType, bytes }, { maxInputBytes = 1048576, maxTextBytes = DEFAULT_BUDGETS.maxTextBytes } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > maxInputBytes) fail('search_extraction_limit');
  const conversation=conversationText(mimeType,bytes);if(conversation!==null)return extractSearchText({mimeType:'text/plain',bytes:new TextEncoder().encode(conversation)},{maxInputBytes,maxTextBytes});
  if (mimeType === WEB_ARCHIVE_MIME) return extractSearchText(inspectWebArchive(bytes).entrypoint, { maxInputBytes, maxTextBytes });
  if (!['text/plain', 'text/html'].includes(mimeType)) return { text: '', supported: false, truncated: false };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid_search_encoding'); }
  if (mimeType === 'text/html') text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&(?:lt|gt|quot|apos|amp|nbsp);/g, entity => ({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&', '&nbsp;': ' ' })[entity]);
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const encoded = new TextEncoder().encode(text), truncated = encoded.length > maxTextBytes;
  if (truncated) { let end = maxTextBytes; while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--; text = new TextDecoder().decode(encoded.slice(0, end)); }
  return { text, supported: true, truncated };
}

export function messageSearchDocument(message, { revision = message.revision, extraction } = {}) {
  message = migrateTags(message);
  const content = extractSearchText(message, extraction);
  return {
    id: `message:${message.id}`, owner: message.owner, source: { kind: 'message', id: message.id }, revision,
    type: message.mimeType === 'message/rfc822' ? 'email' : 'message', title: message.senderMetadata?.subject || '', text: content.text,
    tags: message.tags || [], classification: message.classification || 'unclassified', createdAt: message.receivedAt,
    acl: { readers: [message.owner] }, quarantined: Boolean(message.quarantined), deleted: false, embeddingAllowed: false,
  };
}
