// Contact-link previews and the add-contact intent (docs/architecture/contact-link-previews.md).
// Only the link owner's grant-permitted profile is ever shown; nothing about any audience,
// nothing from unrelated query parameters, and nothing that delivers or consumes state.
import {parseLinkQuery,parseLinkMeta} from '../messaging/bindle-links.mjs';
// User decision (2026-10-14): one registrable scheme for web and native handlers (links §6.4).
export const BINDLE_INTENT_SCHEME='web+bindle',CONTACT_INTENTS=Object.freeze(['send-message','add-contact']);
const CONTACT_PATH=/^\/users\/((?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9}))\/contact\/([a-f0-9-]{36})$/;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain=(value,max)=>typeof value==='string'?value.replace(/[\p{Cc}\u2028\u2029‪-‮⁦-⁩]/gu,'').trim().slice(0,max):'';
// The avatar redirect only ever points at an HTTPS image path, so the route is not a general redirect.
const imageURL=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&/\.(?:png|jpe?g|webp|gif|avif)$/i.test(url.pathname);}catch{return false;}};
export const contactIntent=(intent,link)=>`${BINDLE_INTENT_SCHEME}://${intent}?contact-url=${encodeURIComponent(link)}`;
// Canonical capability URL from the shared raw-query parser only (never unrelated parameters).
export function canonicalContactLink(origin,target){
 let url;try{url=new URL(target);}catch{return null;}const match=CONTACT_PATH.exec(url.pathname);if(url.origin!==origin||!match)return null;
 let query;try{query=parseLinkQuery(target);}catch{return null;}
 if(query.form==='link'&&query.data===undefined){let sub;try{const claims=parseLinkMeta(query.meta).claims;if(claims.aud===origin+url.pathname)sub=claims.sub;}catch{}return sub?{link:`${origin}${url.pathname}?bindle_meta=${query.meta}`,path:url.pathname,search:`?bindle_meta=${query.meta}`,handle:match[1],sub}:null;}
 if(query.form!=='legacy'||[...url.searchParams.keys()].join()!=='sig')return null;
 const sig=url.searchParams.get('sig');if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sig)||sig.length>16384)return null;
 let sub;try{sub=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(sig.split('.')[1].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)))).sub;}catch{}
 return typeof sub==='string'&&/^[a-f0-9-]{36}$/.test(sub)?{link:`${origin}${url.pathname}?sig=${sig}`,path:url.pathname,search:`?sig=${sig}`,handle:match[1],sub}:null;
}
// Resolves the owner-permitted profile; every failure (revoked, expired, quarantined, unknown) is the generic card.
export async function contactPreview({env,target,profile}){
 const origin=env.APP_ORIGIN,brand=env.BRAND_NAME||'3sln.me',generic={brand,origin,verified:false,title:`Send a private message on ${brand}`,description:'A private contact link. Messages come from verified identities and the recipient decides what is accepted.',image:`${origin}${brand==='3sln.me'?'/branding/3sln-avatar.png':'/generic-icon.svg'}`,imageSize:512};
 const canonical=canonicalContactLink(origin,target);if(!canonical)return generic;
 let shared;try{shared=await profile(canonical);}catch{return generic;}
 const name=plain(shared?.profile?.displayName,100),avatar=typeof shared?.profile?.avatar==='string'&&imageURL(shared.profile.avatar);
 return {...generic,verified:true,link:canonical.link,intents:Object.fromEntries(CONTACT_INTENTS.map(intent=>[intent,contactIntent(intent,canonical.link)])),...name?{name,title:`Send a private message to ${name}`}:{},...avatar?{image:`${origin}${canonical.path}/avatar${canonical.search}`,avatarURL:shared.profile.avatar}:{}};
}
// Default HTML representation: Open Graph, Twitter card, oEmbed discovery, robots and the intent link.
export function injectPreview(html,preview){
 const meta=[`<meta name="robots" content="noindex, nofollow">`,`<meta name="referrer" content="no-referrer">`,`<meta property="og:type" content="website">`,`<meta property="og:site_name" content="${esc(preview.brand)}">`,`<meta property="og:title" content="${esc(preview.title)}">`,`<meta property="og:description" content="${esc(preview.description)}">`,`<meta property="og:url" content="${esc(preview.link??preview.origin)}">`,`<meta property="og:image" content="${esc(preview.image)}">`,`<meta name="twitter:card" content="summary">`,`<meta name="twitter:title" content="${esc(preview.title)}">`,`<meta name="twitter:description" content="${esc(preview.description)}">`,`<meta name="twitter:image" content="${esc(preview.image)}">`,
  ...preview.link?[`<link rel="alternate" type="application/json+oembed" href="${esc(`${preview.origin}/oembed?format=json&url=${encodeURIComponent(preview.link)}`)}" title="${esc(preview.title)}">`]:[]].join('');
 const intent=preview.intents?`<nav hidden data-bindle-intents><a data-bindle-intent="send-message" href="${esc(preview.intents['send-message'])}">Send a message with a Bindle app</a><a data-bindle-intent="add-contact" href="${esc(preview.intents['add-contact'])}">Add this contact in a Bindle app</a></nav>`:'';
 const head=`<title>${esc(preview.title)}</title><meta name="description" content="${esc(preview.description)}">${meta}`,base=html.replace(/<meta name="description" content="[^"]*">/,'');
 return (/<title>[^<]*<\/title>/.test(base)?base.replace(/<title>[^<]*<\/title>/,()=>head):base.replace('</head>',()=>head+'</head>')).replace(/<\/body>|$/,match=>intent+match);
}
// oEmbed (https://oembed.com) `link` type only; never `rich`/`video` HTML.
// A shared avatar has unknown dimensions, so only the fixed generic card is offered as a thumbnail.
export const oembed=preview=>({version:'1.0',type:'link',provider_name:preview.brand,provider_url:preview.origin,title:preview.title,...preview.name?{author_name:preview.name}:{},...preview.avatarURL?{}:{thumbnail_url:preview.image,thumbnail_width:preview.imageSize,thumbnail_height:preview.imageSize}});
