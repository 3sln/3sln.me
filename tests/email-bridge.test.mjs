// BRIDGE engine through the Node adapter: admission and generic refusal, MIME bounds, forged senders, automated
// mail, the single invariant auto-reply and its rate limits, replay and duplicate Message-IDs, holding and delivery
// to the public-message-intake occupant (missing, disabled, refusing, lost), and the acceptance follow-up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {world,rawMail,text,CONFIG,DOMAIN,OWNER,OTHER,ORIGIN,AUTHSERV,NOW} from './email-bridge-helpers.mjs';
import {BRIDGE_LIMITS,GENERIC_REFUSAL,BRIDGE_OPERATIONS,invariantText,followupText,parseEmail,authResults,headerMailbox,mailbox,MIME_LIMITS,REPLY_SUBJECT,bridgeConfig} from '../packages/email-bridge/index.mjs';
import {parseProvenance,intakeDigest} from '../packages/bindlebox-protocol/index.mjs';

const REJECT={action:'reject',reason:GENERIC_REFUSAL};
const replyBody=r=>text(r.raw).split('\r\n\r\n')[1].replace(/\r\n/g,' ').trim();

test('flags: EMAIL_BRIDGE_ENABLED and BINDLEBOX_ENABLED are both required and default off; no directory lookup when off',async()=>{
 for(const config of [{...CONFIG,EMAIL_BRIDGE_ENABLED:'false'},{...CONFIG,BINDLEBOX_ENABLED:undefined},{...CONFIG,APP_ORIGIN:'http://localhost:8787'},{APP_ORIGIN:ORIGIN}]){
  const w=await world({config});assert.deepEqual(await w.receive(rawMail()),REJECT);assert.equal(w.directoryCalls.length,0);assert.equal(w.replies.length,0);
  await assert.rejects(w.bridge.settings(OWNER),{code:'not_found'});assert.deepEqual(await w.bridge.drain(OWNER),{delivered:0,held:true,reason:'disabled'});
 }
 assert.equal(bridgeConfig({}).enabled,false);
 for(const name of ['bridge.receive','bridge.admit','bridge.drain','bridge.accepted','bridge.reply-outcome','bridge.settings','bridge.configure','bridge.status','bridge.suppress'])assert.ok(BRIDGE_OPERATIONS[name],name);
});

test('admission: unknown, owner-disabled, unpaid, inactive, reserved, plus-addressed and foreign-domain recipients get the identical generic refusal and no reply',async()=>{
 const w=await world();
 const cases=[['nobody'],['bob'],['dave'],['erin'],['postmaster'],['bob+tag'],['bob','other.example']];
 for(const [local,domain=DOMAIN] of cases)assert.deepEqual(await w.receive(rawMail(),{to:`${local}@${domain}`}),REJECT,local);
 assert.equal(w.replies.length,0);assert.equal((await w.rows()).length,0,'the default-off owner setting stored nothing');
 // Header To/Cc never route: the envelope recipient alone decides.
 await w.enable();assert.deepEqual(await w.receive(rawMail({to:`bob@${DOMAIN}`}),{to:`nobody@${DOMAIN}`}),REJECT);
 assert.equal((await w.receive(rawMail(),{to:`BOB@${DOMAIN.toUpperCase()}`})).action,'accept','case-insensitive envelope recipient');
});

test('MIME bounds: oversized, lying rawSize, malformed and over-structured mail is refused whole with the same reason, stored nowhere',async()=>{
 const w=await world();await w.enable();
 const big=rawMail({body:'x'.repeat(MIME_LIMITS.rawBytes)});
 assert.deepEqual(await w.receive(big),REJECT,'declared size over the limit');
 assert.deepEqual(await w.receive(big,{rawSize:1000}),REJECT,'a smaller claimed size is not trusted');
 const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(65536));}});
 assert.deepEqual(await w.bridge.receive({from:'alice@sender.example',to:`bob@${DOMAIN}`,raw:stream,rawSize:10}),REJECT,'endless stream stops at the limit');
 const nested=depth=>{let body='leaf',ct='text/plain';for(let i=0;i<depth;i++){body=`--b${i}\r\nContent-Type: ${ct}\r\n\r\n${body}\r\n--b${i}--`;ct=`multipart/mixed; boundary=b${i}`;}return {ct,body};};
 const deep=nested(6),parts=Array.from({length:40},(_,i)=>`--z\r\nContent-Type: application/octet-stream\r\n\r\npart${i}`).join('\r\n')+'\r\n--z--';
 const malformed=[
  rawMail({headers:['Content-Transfer-Encoding: base64'],body:'not*base64!'}),
  rawMail({contentType:true,headers:['Content-Type: multipart/mixed; boundary=zz'],body:'--zz\r\n\r\nunterminated'}),
  rawMail({raw:'From: a@sender.example\r\nBroken header line\r\n\r\nbody'}),
  rawMail({headers:['From: Mallory <mallory@evil.example>']}),
  rawMail({raw:'Subject: no author\r\n\r\nbody'}),
  rawMail({raw:'From: a@sender.example\rSubject: bare CR\r\n\r\nbody'}),
  rawMail({header:'a@sender.example, b@sender.example'}),
  rawMail({header:'Group: a@sender.example;'}),
  rawMail({header:'Alice (comment) <alice@sender.example>'}),
  rawMail({headers:['Content-Transfer-Encoding: quoted-printable'],body:'bad =ZZ escape'}),
  rawMail({headers:['Content-Transfer-Encoding: x-uuencode']}),
  rawMail({contentType:true,headers:[`Content-Type: ${deep.ct}`],body:deep.body}),
  rawMail({contentType:true,headers:['Content-Type: multipart/mixed; boundary=z'],body:parts}),
  rawMail({contentType:true,headers:['Content-Type: text/plain; charset=x-unknown-charset']}),
  rawMail({raw:`From: a@sender.example\r\n${Array.from({length:300},(_,i)=>`X-H${i}: v`).join('\r\n')}\r\n\r\nbody`}),
 ];
 for(const [i,raw] of malformed.entries())assert.deepEqual(await w.receive(raw,{rawSize:raw.byteLength}),REJECT,`case ${i}`);
 assert.equal((await w.rows(OWNER,'item/')).length,0);assert.equal(w.replies.length,0);
 // A valid multipart message with QP text, base64 HTML and an attachment is normalized into inert parts.
 const mixed=rawMail({contentType:true,headers:['Content-Type: multipart/mixed; boundary="=_b"'],body:['--=_b','Content-Type: multipart/alternative; boundary=alt','','--alt','Content-Type: text/plain; charset=iso-8859-1','Content-Transfer-Encoding: quoted-printable','','Caf=E9 at noon=','?','--alt','Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',btoa('<p>CafÃ©</p>'),'--alt--','--=_b','Content-Type: application/pdf; name="x.pdf"','Content-Disposition: attachment; filename="x.pdf"','Content-Transfer-Encoding: base64','','JVBERi0=','--=_b--'].join('\r\n')});
 const parsed=await parseEmail(mixed,{envelopeFrom:'alice@sender.example',authservId:AUTHSERV});
 assert.deepEqual(parsed.message.parts.map(p=>p.mimeType),['text/rfc822-headers','text/plain','text/html','application/pdf']);
 assert.equal(text(Uint8Array.from(atob(parsed.message.parts[1].dataBase64url.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))),'Café at noon?');
});

test('forged senders: misaligned envelope, header From or Reply-To, failing or unverifiable DMARC and sender-supplied results are accepted silently with no reply (no backscatter)',async()=>{
 const w=await world();await w.enable();
 const forged=[
  [rawMail({from:'victim@innocent.example',messageId:'<f1@x>'}),{from:'attacker@evil.example'}],// envelope differs from header From
  [rawMail({headers:['Reply-To: victim@innocent.example'],messageId:'<f2@x>'})],
  [rawMail({auth:'fail',messageId:'<f3@x>'})],
  [rawMail({auth:null,messageId:'<f4@x>'})],
  // The sender adds its own "pass" under our authserv-id beside the receiver's real result: two headers, so unknown.
  [rawMail({auth:'fail',headers:[`Authentication-Results: ${AUTHSERV}; dmarc=pass`],messageId:'<f5@x>'})],
  [rawMail({auth:null,headers:['Authentication-Results: mx.evil.example; dmarc=pass'],messageId:'<f6@x>'})],
  [rawMail({messageId:'<f7@x>'}),{from:''}],
 ];
 for(const [raw,opts] of forged)assert.equal((await w.receive(raw,opts)).action,'accept');
 assert.equal(w.replies.length,0,'nothing was sent to any asserted address');
 const map=new Map([['authentication-results',[`${AUTHSERV}; dmarc=pass`,`${AUTHSERV}; dmarc=pass`]]]);assert.equal(authResults(map,AUTHSERV).dmarc,'unknown');
 assert.equal(authResults(new Map([['authentication-results',[`${AUTHSERV}; dmarc=pass`]]]),undefined).dmarc,'unknown','no configured authserv-id, no trust');
 // Provenance carries the observations as assertions only.
 await w.bridge.drain(OWNER);const claims=w.deliveries.map(d=>parseProvenance(d.rpc.args.provenance).claims);
 assert.equal(claims.length,7);assert.deepEqual(claims.map(c=>c.dmarc),['pass','pass','fail','unknown','unknown','unknown','pass']);
 assert.deepEqual(claims[0].sender,{envelopeFrom:'attacker@evil.example',headerFrom:'Alice Example <victim@innocent.example>'});
 assert.equal(claims[1].sender.replyTo,'victim@innocent.example');
 for(const c of claims){assert.equal(c.iss,ORIGIN);assert.equal(c.channel,'email');assert.equal('author' in c,false);}
 // Header injection: addresses with CR/LF or quotes never parse; nothing inbound reaches a generated header.
 assert.equal(mailbox('a@b.example\r\nBcc: x@y.example'),null);assert.equal(headerMailbox('"x\r\nBcc: y" <a@b.example>'),null);
 assert.deepEqual(await w.receive(rawMail({messageId:'<f8@x>'}),{from:'a@b.example\r\nBcc: x@y.example'}),REJECT);
});

test('automated mail: auto-submitted, list, bulk, bounces, mailer-daemon/noreply, one-time codes and bridge loops are held and delivered but never replied to',async()=>{
 const w=await world();await w.enable();
 const automated=[
  [{headers:['Auto-Submitted: auto-replied']},'auto-submitted'],
  [{headers:['List-Id: <news.sender.example>']},'list-id'],
  [{headers:['List-Unsubscribe: <https://sender.example/u>']},'list-unsubscribe'],
  [{headers:['Precedence: bulk']},'precedence-bulk'],
  [{headers:['X-Auto-Response-Suppress: OOF, AutoReply']},'auto-response-suppress'],
  [{contentType:true,headers:['Content-Type: multipart/report; report-type=delivery-status; boundary=r'],body:'--r\r\nContent-Type: text/plain\r\n\r\nUndeliverable\r\n--r\r\nContent-Type: message/delivery-status\r\n\r\nStatus: 5.1.1\r\n--r--'},'delivery-report'],
  [{from:'mailer-daemon@sender.example'},'sender-shape'],
  [{from:'no-reply@sender.example'},'sender-shape'],
  [{subject:'Your verification code',body:'Use 482913 to sign in.'},'one-time-code'],
  [{headers:['X-Bindle-Bridge: auto-reply']},'bridge-loop'],
 ];
 for(const [i,[opts,hint]] of automated.entries()){const r=await w.receive(rawMail({...opts,messageId:`<a${i}@x>`}),{from:opts.from??'alice@sender.example'});assert.equal(r.action,'accept',hint);}
 assert.equal((await w.receive(rawMail({messageId:'<null@x>'}),{from:'<>'})).action,'accept','null reverse path (bounce)');
 assert.equal(w.replies.length,0);
 await w.bridge.drain(OWNER);const hints=w.deliveries.map(d=>parseProvenance(d.rpc.args.provenance).claims.automation);
 for(const [i,[,hint]] of automated.entries())assert.ok(hints[i].includes(hint),`${hint}: ${hints[i]}`);
 assert.ok(hints.at(-1).includes('null-sender'));
});

test('auto-reply: exactly one fixed text for an accepted, aligned, DMARC-passing personal sender; nothing inbound echoed; owner can switch it off',async()=>{
 const w=await world();await w.enable();
 await w.receive(rawMail({subject:'Bcc: injected@evil.example',body:'Quote me back'}));
 assert.equal(w.replies.length,1);const [r]=w.replies,raw=text(r.raw);
 assert.equal(r.from,`bob@${DOMAIN}`);assert.equal(r.to,'alice@sender.example');
 assert.equal(replyBody(r),invariantText(`${ORIGIN}/`));
 assert.match(raw,/^From: Bindle automated reply <bob@3sln\.example>\r\nTo: <alice@sender\.example>\r\nSubject: Your email was received\r\nDate: Wed, 21 Oct 2026 09:00:00 \+0000\r\nMessage-ID: <[a-f0-9]{32}\.bridge@3sln\.example>\r\n/);
 assert.match(raw,/\r\nAuto-Submitted: auto-replied\r\nX-Auto-Response-Suppress: All\r\nX-Bindle-Bridge: auto-reply\r\n\r\n/);
 for(const leak of ['injected','Quote me','Alice Example','Lunch','In-Reply-To','References'])assert.equal(raw.includes(leak),false,leak);
 assert.ok(raw.split('\r\n').every(l=>l.length<=78));
 const w2=await world();await w2.enable(OWNER,{enabled:true,autoReply:false});await w2.receive(rawMail());assert.equal(w2.replies.length,0);
 // Without a trusted dmarc=pass and no platform gate, Node never replies; without a reply port it never claims.
 const w3=await world({sendReply:false});await w3.enable();await w3.receive(rawMail());const [[,ledger]]=await w3.rows(OWNER,'reply/');assert.equal(ledger.initial,'none');
});

test('auto-reply invariance: identical bytes whether the recipient has an occupant, none, a refusing or disabled app, or a failing one',async()=>{
 const bytes=[];
 for(const mode of ['store','none','refuse','busy','lost','bad']){
  const w=await world({mode});await w.enable();await w.receive(rawMail());await w.bridge.drain(OWNER);
  assert.equal(w.replies.length,1,mode);bytes.push(text(w.replies[0].raw));
 }
 assert.equal(new Set(bytes).size,1);
 // Delivery happens after the reply was decided: the reply never waits on or learns from the occupant.
 const w=await world({mode:'store'});await w.enable();await w.receive(rawMail());assert.equal(w.deliveries.length,0);assert.equal(w.replies.length,1);
});

test('rate limits: 30-day per-sender cooldown, per-recipient and per-domain daily caps, the global budget and the suppression list',async()=>{
 const w=await world();await w.enable();await w.enable(OTHER);
 await w.receive(rawMail({messageId:'<r1@x>'}));await w.receive(rawMail({messageId:'<r2@x>',body:'again'}));await w.receive(rawMail({messageId:'<r3@x>'}),{to:`carol@${DOMAIN}`});
 assert.equal(w.replies.length,1,'one reply per sender in 30 days, across recipients');
 w.clock.advance(BRIDGE_LIMITS.senderCooldownMs+1);await w.receive(rawMail({messageId:'<r4@x>'}));assert.equal(w.replies.length,2,'cooldown elapsed');
 // Per recipient: at most 20 replies a day to distinct senders of distinct domains.
 const before=w.replies.length;for(let i=0;i<BRIDGE_LIMITS.recipientRepliesDaily+3;i++)await w.receive(rawMail({from:`p${i}@d${i}.example`,messageId:`<p${i}@x>`}),{from:`p${i}@d${i}.example`});
 assert.equal(w.replies.length-before,BRIDGE_LIMITS.recipientRepliesDaily-1,'the recipient cap counts today\'s earlier reply');
 // Per sender domain across recipients.
 const w2=await world();for(const o of [OWNER,OTHER])await w2.enable(o);
 for(let i=0;i<BRIDGE_LIMITS.domainRepliesDaily+5;i++){const to=i%2?`carol@${DOMAIN}`:`bob@${DOMAIN}`;await w2.receive(rawMail({from:`s${i}@bulk.example`,messageId:`<d${i}@x>`}),{from:`s${i}@bulk.example`,to});}
 assert.equal(w2.replies.length,2*BRIDGE_LIMITS.recipientRepliesDaily<BRIDGE_LIMITS.domainRepliesDaily?2*BRIDGE_LIMITS.recipientRepliesDaily:BRIDGE_LIMITS.domainRepliesDaily);
 // Global budget exhausted: no reply, mail still accepted and held.
 const w3=await world();await w3.enable();await w3.senderStore.put('w/global/replies-v1',{start:NOW,count:BRIDGE_LIMITS.globalRepliesDaily});
 assert.equal((await w3.receive(rawMail())).action,'accept');assert.equal(w3.replies.length,0);
 // Suppression list: operator suppression and a permanent provider refusal both stop replies.
 const w4=await world();await w4.enable();await w4.bridge.suppress('alice@sender.example');await w4.receive(rawMail());assert.equal(w4.replies.length,0);
 const [[,ledger4]]=await w4.rows(OWNER,'reply/');assert.equal(ledger4.initial,'suppressed:suppressed');
 const w5=await world({sendReply:async()=>{throw Object.assign(new Error('suppressed'),{code:'E_RECIPIENT_SUPPRESSED'});}});await w5.enable();
 assert.equal((await w5.receive(rawMail())).action,'accept','a failed reply never turns into a refusal');
 assert.equal((await w5.rows(OWNER,'reply/'))[0][1].initial,'failed');
 w5.clock.advance(BRIDGE_LIMITS.senderCooldownMs+1);await w5.receive(rawMail({messageId:'<later@x>'}));
 assert.deepEqual((await w5.rows(OWNER,'reply/')).map(([,l])=>l.initial),['suppressed:suppressed'],'the provider refusal suppressed the sender');
});

test('replay and duplicates: the same mail (even with new trace headers or via another alias) is held and answered once; a reused Message-ID with other content is refused',async()=>{
 const w=await world();await w.enable();
 const first=rawMail();assert.equal((await w.receive(first)).action,'accept');
 const retried=new TextEncoder().encode('Received: from relay2.example by mx\r\n'+text(first));assert.equal((await w.receive(retried)).action,'accept');
 assert.equal((await w.receive(first,{to:`robert@${DOMAIN}`})).action,'accept','second alias of the same owner');
 assert.equal((await w.rows(OWNER,'item/')).length,1);assert.equal(w.replies.length,1);
 assert.deepEqual(await w.receive(rawMail({body:'different content, same id'})),REJECT,'conflict, not an overwrite');
 const noId=rawMail({messageId:null,body:'no id'});await w.receive(noId);await w.receive(noId);assert.equal((await w.rows(OWNER,'item/')).length,2,'missing IDs dedupe on content within the window');
 await w.bridge.drain(OWNER);assert.equal(w.deliveries.length,2);
 const txs=w.deliveries.map(d=>d.rpc.tx);assert.equal(new Set(txs).size,2);
 // After the dedup window the same bytes are new mail, but the occupant still dedups on fingerprint.
 w.clock.advance(BRIDGE_LIMITS.dedupMs+1);assert.equal((await w.receive(first)).action,'accept');assert.equal((await w.rows(OWNER,'queue/')).length,1);
});

test('holding queue: no occupant or a disabled bridge holds mail (fail closed) and it expires visibly; delivery resumes when an occupant appears',async()=>{
 const w=await world({mode:'none'});await w.enable();await w.receive(rawMail());
 assert.deepEqual((await w.bridge.drain(OWNER)).delivered,0);assert.equal(w.deliveries.length,0);
 let status=await w.bridge.status(OWNER);assert.equal(status.queued,1);assert.equal(status.items[0].reason,'no-occupant');
 // Flags off: drain never contacts anything.
 const off=await world({config:{...CONFIG,BINDLEBOX_ENABLED:'false'}});assert.equal((await off.bridge.drain(OWNER)).reason,'disabled');
 // Owner switch off: paused, held.
 await w.enable(OWNER,{enabled:false});w.state.mode='store';assert.equal((await w.bridge.drain(OWNER)).reason,'paused');assert.equal(w.deliveries.length,0);
 await w.enable(OWNER,{enabled:true});w.clock.advance(BRIDGE_LIMITS.idleMs);assert.equal((await w.bridge.drain(OWNER)).delivered,1);
 status=await w.bridge.status(OWNER);assert.equal(status.queued,0);assert.equal(status.items[0].state,'delivered');assert.equal(status.items[0].disposition,'stored-receipt');
 // Expiry: a held item past the occupant's window expires visibly, never delivered stale.
 const e=await world({mode:'none'});await e.enable();await e.receive(rawMail());e.clock.advance(BRIDGE_LIMITS.holdMs);e.state.mode='store';await e.bridge.drain(OWNER);
 assert.equal(e.deliveries.length,0);assert.equal((await e.bridge.status(OWNER)).items[0].state,'expired');
});

test('delivery outcomes: terminal refusal, retryable busy, and an indeterminate attempt at a removed occupant is reported unknown and never re-sent',async()=>{
 const w=await world({mode:'bad'});await w.enable();await w.receive(rawMail());await w.bridge.drain(OWNER);assert.equal((await w.bridge.status(OWNER)).items[0].state,'refused');
 const b=await world({mode:'busy'});await b.enable();await b.receive(rawMail());await b.bridge.drain(OWNER);
 let s=await b.bridge.status(OWNER);assert.equal(s.items[0].state,'queued');assert.equal(s.items[0].reason,'occupant-busy');
 b.state.mode='store';b.clock.advance(BRIDGE_LIMITS.backoffMs);await b.bridge.drain(OWNER);assert.equal((await b.bridge.status(OWNER)).items[0].state,'delivered');
 assert.equal(new Set(b.deliveries.map(d=>d.rpc.tx)).size,1,'the retry reuses the same tx');
 const l=await world({mode:'lost'});await l.enable();await l.receive(rawMail());await l.bridge.drain(OWNER);
 s=await l.bridge.status(OWNER);assert.equal(s.items[0].reason,'indeterminate');
 l.state.seat={id:'seat-2',resource:'https://other.box.example/bindle/mailbox/x'};l.state.mode='store';l.clock.advance(BRIDGE_LIMITS.maxBackoffMs);await l.bridge.drain(OWNER);
 s=await l.bridge.status(OWNER);assert.equal(s.items[0].state,'unknown');assert.equal(l.deliveries.length,1,'never re-sent to the new occupant');
 // Same occupant after an uncertain attempt: retried with the same tx (the occupant dedups it).
 const k=await world({mode:'lost'});await k.enable();await k.receive(rawMail());await k.bridge.drain(OWNER);k.state.mode='store';k.clock.advance(BRIDGE_LIMITS.maxBackoffMs);await k.bridge.drain(OWNER);
 assert.equal((await k.bridge.status(OWNER)).items[0].state,'delivered');assert.equal(new Set(k.deliveries.map(d=>d.rpc.tx)).size,1);
 // The RPC body is exactly the §9 deliver with a verifiable digest.
 const rpc=k.deliveries[0].rpc,claims=parseProvenance(rpc.args.provenance).claims;
 assert.deepEqual(Object.keys(rpc).sort(),['args','contract','method','resource','tx','version']);assert.equal(claims.normalizedDigest,await intakeDigest(rpc.args.message));
});

test('acceptance follow-up: once, only after the recipient accepts, only to a reply-safe DMARC-validated sender, under its own caps',async()=>{
 const w=await world();await w.enable();await w.receive(rawMail());
 const [[,ledger]]=await w.rows(OWNER,'reply/'),jti=[...(await w.rows(OWNER,'reply/'))][0][0].slice(6);
 assert.equal(ledger.initial,'sent');assert.equal(w.mails.length,0,'nothing before acceptance');
 assert.deepEqual(await w.bridge.accepted(OWNER,jti),{status:'sent'});
 assert.equal(w.mails.length,1);assert.deepEqual(w.mails[0],{to:'alice@sender.example',subject:'Your message was accepted',text:followupText(`${ORIGIN}/`),headers:{'Auto-Submitted':'auto-replied','X-Auto-Response-Suppress':'All','X-Bindle-Bridge':'accepted'}});
 assert.deepEqual(await w.bridge.accepted(OWNER,jti),{status:'suppressed'});assert.equal(w.mails.length,1,'never twice');
 assert.deepEqual(await w.bridge.accepted(OWNER,'00000000-0000-4000-8000-000000000000'),{status:'suppressed'});
 assert.deepEqual(await w.bridge.accepted(OTHER,jti),{status:'suppressed'},'another owner cannot trigger it');
 // Forged, automated and unverifiable senders never get a follow-up, even when the recipient accepts.
 for(const [raw,opts] of [[rawMail({from:'victim@innocent.example',messageId:'<x1@x>'}),{from:'attacker@evil.example'}],[rawMail({headers:['List-Id: <l>'],messageId:'<x2@x>'})],[rawMail({auth:null,from:'zed@sender.example',messageId:'<x3@x>'}),{from:'zed@sender.example'}]]){
  const ww=await world();await ww.enable();await ww.receive(raw,opts);const id=(await ww.rows(OWNER,'reply/'))[0][0].slice(6);
  assert.deepEqual(await ww.bridge.accepted(OWNER,id),{status:'suppressed'});assert.equal(ww.mails.length,0);assert.equal(ww.replies.length,0);
 }
 // Owner switched replies off: no follow-up either. A sender-level cap stops a fourth follow-up in a day.
 const off=await world();await off.enable();await off.receive(rawMail());await off.enable(OWNER,{enabled:true,autoReply:false});
 assert.deepEqual(await off.bridge.accepted(OWNER,(await off.rows(OWNER,'reply/'))[0][0].slice(6)),{status:'suppressed'});
 const cap=await world();for(const o of [OWNER,OTHER])await cap.enable(o);const ids=[];
 for(let i=0;i<5;i++){await cap.receive(rawMail({messageId:`<c${i}@x>`,body:`m${i}`}),{to:i%2?`carol@${DOMAIN}`:`bob@${DOMAIN}`});}
 for(const o of [OWNER,OTHER])for(const [k,l] of await cap.rows(o,'reply/'))ids.push([o,k.slice(6),l]);
 let sent=0;for(const [o,id] of ids)if((await cap.bridge.accepted(o,id)).status==='sent')sent++;
 assert.equal(sent,BRIDGE_LIMITS.senderFollowupsDaily);
});
