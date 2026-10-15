// Contact-delivery v1 transport framing. Both parsers yield the same
// `{envelope, body}` semantic operation; neither consults credentials.
import { fail, strictText, textEncoder, mimeValid } from './store.mjs';
import { strictJSON, validateEnvelope, checkBody, decodeBody, DELIVERY_LIMITS, CONTACT_DELIVERY_CONTRACT } from './contact-delivery.mjs';

const malformed = () => fail('invalid_multipart');
const indexOf = (bytes, needle, from) => { outer: for (let i = from; i <= bytes.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer; return i; } return -1; };
const startsAt = (bytes, needle, at) => needle.every((b, i) => bytes[at + i] === b);
const tchar = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
// One parameter list parser with duplicate rejection, used for both the
// request Content-Type and each part's Content-Disposition.
const parameters = (value, head) => {
  const m = new RegExp(`^${head}((?:\\s*;\\s*${tchar}=(?:${tchar}|"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"))*)\\s*$`, 'i').exec(value); if (!m) malformed();
  const out = new Map(); for (const [, name, raw] of m[1].matchAll(new RegExp(`;\\s*(${tchar})=(${tchar}|"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*")`, 'g'))) { const k = name.toLowerCase(); if (out.has(k)) malformed(); out.set(k, raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw); }
  return out;
};
export function multipartBoundary(contentType) {
  if (typeof contentType !== 'string' || contentType.length > 256) malformed();
  const params = parameters(contentType, 'multipart/form-data'), boundary = params.get('boundary');
  if (params.size !== 1 || !boundary || !/^[0-9A-Za-z'()+_,./:=?-]{1,70}$/.test(boundary)) malformed();
  return boundary;
}
const partHeaders = block => {
  if (block.byteLength > 1024 || block.some(b => b > 0x7e || (b < 0x20 && b !== 0x0d && b !== 0x0a))) malformed();
  const headers = new Map(); for (const line of strictText(block).split('\r\n')) { const m = /^([A-Za-z0-9-]+):[ \t]*(.*?)[ \t]*$/.exec(line); if (!m || /[\r\n]/.test(m[2])) malformed(); const k = m[1].toLowerCase(); if (headers.has(k) || !['content-disposition', 'content-type'].includes(k)) malformed(); headers.set(k, m[2]); }
  const disposition = parameters(headers.get('content-disposition') ?? '', 'form-data');
  if ([...disposition.keys()].some(k => !['name', 'filename'].includes(k)) || !disposition.has('name')) malformed();
  return { name: disposition.get('name'), filename: disposition.get('filename'), type: headers.get('content-type') };
};

// Exactly two parts, `envelope` (application/json) and `message` (the exact
// document bytes). No preamble, epilogue, transfer encoding, nested multipart,
// extra/duplicate parts or headers. Filenames (standard FormData sends
// `filename="blob"` for Blob parts) and the boundary are inert.
export async function parseMultipartDelivery(contentType, bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) malformed();
  if (bytes.byteLength > DELIVERY_LIMITS.maxRequestBytes) fail('too_large');
  const boundary = multipartBoundary(contentType), dash = textEncoder.encode(`--${boundary}`), delimiter = textEncoder.encode(`\r\n--${boundary}`), crlf = [13, 10], blank = textEncoder.encode('\r\n\r\n');
  if (!startsAt(bytes, [...dash, ...crlf], 0)) malformed();
  const parts = new Map(); let at = dash.length + 2;
  for (;;) {
    if (parts.size >= 2) malformed();
    const headEnd = indexOf(bytes, blank, at); if (headEnd < 0 || headEnd - at > 1024) malformed();
    const head = partHeaders(bytes.subarray(at, headEnd)), start = headEnd + 4, end = indexOf(bytes, delimiter, start); if (end < 0) malformed();
    if (!['envelope', 'message'].includes(head.name) || parts.has(head.name)) malformed();
    parts.set(head.name, { ...head, bytes: bytes.subarray(start, end) });
    at = end + delimiter.length;
    if (startsAt(bytes, [45, 45], at)) { at += 2; if (at !== bytes.length && !(at + 2 === bytes.length && startsAt(bytes, crlf, at))) malformed(); break; }
    if (!startsAt(bytes, crlf, at)) malformed(); at += 2;
  }
  const envelopePart = parts.get('envelope'), message = parts.get('message');
  if (!envelopePart || !message || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(envelopePart.type ?? '')) malformed();
  if (envelopePart.bytes.byteLength > DELIVERY_LIMITS.maxEnvelopeBytes || message.bytes.byteLength > DELIVERY_LIMITS.maxBodyBytes) fail('too_large');
  const envelope = await validateEnvelope(strictJSON(envelopePart.bytes), options);
  if (message.type !== envelope.payload.content.mimeType) fail('unsupported_media');
  const body = message.bytes.slice(); await checkBody(envelope, body, options.crypto);
  return { envelope, body };
}

// Contact RPC request: exact `{version,tx,resource,contract,method,args}`
// parsed strictly from raw bytes (a generic JSON.parse would silently drop
// duplicate members before canonicalization).
export async function parseRPCDelivery(bytes, options = {}) {
  const request = strictJSON(bytes, { maxBytes: DELIVERY_LIMITS.maxRequestBytes }), keys = ['version', 'tx', 'resource', 'contract', 'method', 'args'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || keys.some(k => !Object.hasOwn(request, k)) || Object.keys(request).some(k => !keys.includes(k))) fail('invalid_envelope');
  if (request.version !== '0' || request.contract !== CONTACT_DELIVERY_CONTRACT || request.method !== 'deliver') fail('invalid_envelope');
  const args = request.args;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 2 || !Object.hasOwn(args, 'envelope') || !Object.hasOwn(args, 'bodyBase64url')) fail('invalid_envelope');
  const envelope = await validateEnvelope(args.envelope, options);
  if (request.tx !== envelope.payload.operationId || request.resource !== envelope.payload.recipient.resource) fail('invalid_envelope');
  const body = decodeBody(args.bodyBase64url); await checkBody(envelope, body, options.crypto);
  return { envelope, body, resource: request.resource, tx: request.tx };
}

// Sender-side encoders for an already signed envelope.
export function multipartDeliveryBody(envelope, body, boundary = `bindle-${globalThis.crypto.randomUUID()}`) {
  if (!/^[0-9A-Za-z'()+_,./:=?-]{1,70}$/.test(boundary) || !mimeValid(envelope?.payload?.content?.mimeType) || !(body instanceof Uint8Array) || indexOf(body, textEncoder.encode(`\r\n--${boundary}`), 0) >= 0) fail('invalid_multipart');
  const head = textEncoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="envelope"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(envelope)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="message"\r\nContent-Type: ${envelope.payload.content.mimeType}\r\n\r\n`), tail = textEncoder.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + body.length + tail.length); out.set(head); out.set(body, head.length); out.set(tail, head.length + body.length);
  return { contentType: `multipart/form-data; boundary=${boundary}`, bytes: out };
}
export const rpcDeliveryRequest = (envelope, bodyBase64url) => ({ version: '0', tx: envelope.payload.operationId, resource: envelope.payload.recipient.resource, contract: CONTACT_DELIVERY_CONTRACT, method: 'deliver', args: { envelope, bodyBase64url } });
