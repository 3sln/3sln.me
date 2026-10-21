// BRIDGE responses (messaging-app.md §13 step 4; public-email-bridge.md "Safe response"; RFC 3834). Exactly two
// fixed texts exist: the single invariant auto-reply and the acceptance follow-up. Neither copies anything from the
// inbound message (no subject, body, display name or header), and neither depends on occupancy, delivery outcome,
// disposition, classification or whether the recipient has an app. The only inputs are the two envelope addresses,
// the sign-up origin, the time and a Message-ID derived from the ingress fingerprint.
import {mailbox} from './mime.mjs';

export const REPLY_SUBJECT='Your email was received';
export const FOLLOWUP_SUBJECT='Your message was accepted';
export const invariantText=link=>`This address receives messages through Bindle. Your email was received. The recipient reads Bindle messages in their messaging app, and email replies may not reach them. To start a conversation, get Bindle: ${link}`;
export const followupText=link=>`The person you emailed through Bindle accepted your message. Email replies may still not reach them. To continue the conversation, sign up for Bindle here: ${link}\n\nThis is a one-time automated notice. You will not receive further notices about this message.`;
// RFC 3834 §5 and the common Microsoft suppression header; X-Bindle-Bridge is our own loop marker (mime.mjs hints).
export const RESPONSE_HEADERS=Object.freeze({'Auto-Submitted':'auto-replied','X-Auto-Response-Suppress':'All','X-Bindle-Bridge':'auto-reply'});
export const FOLLOWUP_HEADERS=Object.freeze({'Auto-Submitted':'auto-replied','X-Auto-Response-Suppress':'All','X-Bindle-Bridge':'accepted'});

const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const two=n=>String(n).padStart(2,'0');
export const rfc5322Date=ms=>{const d=new Date(ms);return `${DAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;};
// Plain words wrapped at 76 octets; the texts are ASCII, so 7bit needs no encoding.
const wrap=text=>text.split('\n').map(p=>{const out=[];let line='';for(const w of p.split(' ')){if(line&&line.length+1+w.length>76){out.push(line);line=w;}else line=line?`${line} ${w}`:w;}out.push(line);return out.join('\r\n');}).join('\r\n');
const httpsLink=v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&u.href===v&&/^[!-~]+$/.test(v)&&v.length<=200;}catch{return false;}};

/** The invariant auto-reply as raw RFC 5322 bytes (for the platform's per-event `reply()`). Addresses are re-validated
 * as strict dot-atom mailboxes, so no CR, LF, quote or angle bracket can reach a header. */
export function buildReply({from,to,link,now,messageId}){
 const f=mailbox(from),t=mailbox(to);if(!f||!t||!httpsLink(link)||!Number.isSafeInteger(now)||!/^[a-f0-9]{32}$/.test(messageId??''))throw Object.assign(new Error('Invalid reply envelope.'),{code:'reply_invalid'});
 const domain=f.slice(f.lastIndexOf('@')+1);
 const head=[`From: Bindle automated reply <${f}>`,`To: <${t}>`,`Subject: ${REPLY_SUBJECT}`,`Date: ${rfc5322Date(now)}`,`Message-ID: <${messageId}.bridge@${domain}>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=us-ascii','Content-Transfer-Encoding: 7bit',...Object.entries(RESPONSE_HEADERS).map(([k,v])=>`${k}: ${v}`)];
 return new TextEncoder().encode(`${head.join('\r\n')}\r\n\r\n${wrap(invariantText(link))}\r\n`);
}
/** The acceptance follow-up for a structured transport (`EMAIL.send`): fixed subject, text and headers. */
export function buildFollowup({to,link}){
 const t=mailbox(to);if(!t||!httpsLink(link))throw Object.assign(new Error('Invalid follow-up envelope.'),{code:'reply_invalid'});
 return {to:t,subject:FOLLOWUP_SUBJECT,text:followupText(link),headers:{...FOLLOWUP_HEADERS}};
}
