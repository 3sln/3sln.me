// ACT-3 browser adapter for the inert text/html subset of packages/content/render.mjs.
// That server module is outside jstools.config.mjs's public boundary. Keep this small
// reconstruction identical (parity-tested) until the integrator can share its public entry.
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const tags=new Set('p div span br hr b strong em i u s ul ol li pre code blockquote h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr td th'.split(' '));
const csp="default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
export function activityDocument(content){
 if(!['text/plain','text/html'].includes(content.mimeType)||typeof content.body!=='string'||new TextEncoder().encode(content.body).byteLength>48000)throw Error('Activity content is unavailable.');
 const body=content.mimeType==='text/plain'?`<pre>${escape(content.body)}</pre>`:content.body.split(/(<[^>]*>)/g).map(part=>{if(!part.startsWith('<'))return escape(part);const m=/^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>$/.exec(part);return m&&tags.has(m[2].toLowerCase())?`<${m[1]}${m[2].toLowerCase()}>`:'';}).join('');
 return {kind:'document',sandbox:'',referrerPolicy:'no-referrer',csp,html:`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`};
}
