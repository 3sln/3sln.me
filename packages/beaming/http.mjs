import {CloudflareTurnAdapter} from './turn.mjs';
import QRCode from 'qrcode';
import {BeamError,beamView,uuid} from './index.mjs';
import {IdentityCrypto} from '../identity/crypto.mjs';
const ic=new IdentityCrypto();
const fail=(c,m,s)=>{throw new BeamError(c,m,s);};
async function devices(env,id){const account=await env.IDENTITY_REPOSITORY.get(id);if(!account||account.status!=='active')fail('beam_device_unavailable','The account is unavailable.',409);return {account,devices:await Promise.all((account.sessions||[]).filter(s=>s.expiresAt>Date.now()).map(async s=>({id:s.id||await ic.hash('session-public-id',s.hash),label:s.label||'Browser session'})))};}
async function validateOffer(env,record,actor){
 const sender=await devices(env,record.sender),recipient=record.sender===record.recipient?sender:await devices(env,record.recipient);
 if(!sender.devices.some(d=>d.id===record.senderDevice)||record.recipientDevice&&!recipient.devices.some(d=>d.id===record.recipientDevice))fail('beam_device_revoked','A transfer device has signed out or expired.',410);
 if(actor.account!==record.sender&&actor.account!==record.recipient)fail('beam_forbidden','You are not a transfer participant.',403);
 if(!record.recipientDevice&&!recipient.devices.some(d=>record.allowedDevices.includes(d.id)))fail('beam_device_revoked','The receiving devices are no longer signed in.',410);
}
async function validatePermission(env,record,accountHandle){
 if(record.permission?.kind!=='contact')return;
 const permission=await accountHandle(env,record.recipient).beamPermission(record.recipient,record.sender,{grantId:record.permission.id});
 if(permission.kind!=='contact'||permission.id!==record.permission.id)fail('beam_contact_revoked','The contact permission for this offer is no longer active.',403);
}
async function displayOffer(env,record,view,accountHandle){const sender=await devices(env,record.sender);return {...view,senderHandle:sender.account.handle,senderDeviceLabel:sender.devices.find(d=>d.id===record.senderDevice)?.label||'Browser session'};}
export async function beamRoutes({path,url,request,env,owner,object,accountHandle,body,json}){
 if(!path.startsWith('/api/beams')&&!['/api/profile','/api/contacts/redeem','/api/contacts/directory'].includes(path)&&!/^\/api\/contacts\/[^/]+\/beam$/.test(path)&&!path.startsWith('/api/contacts/profile/')&&!path.startsWith('/api/contacts/directory/'))return null;
 const id=owner.account.id,device=owner.devices.find(d=>d.current)?.id,actor={account:id,device};if(!device)fail('beam_device_unavailable','Sign in on this device first.',401);
 if(path==='/api/profile')return json(await object.beamProfile(id,request.method==='PUT'?await body(request):undefined));
 if(path==='/api/beams/status')return json(await object.beamStatus(id));
 const grant=/^\/api\/contacts\/([a-f0-9-]{36})\/beam$/.exec(path);if(grant)return json(await object.beamContactEnable(id,grant[1],await body(request)));
 if(path==='/api/contacts/redeem'){
 const input=await body(request);let target,claims;try{target=new URL(input.url);if(target.origin!==env.APP_ORIGIN)throw new Error();claims=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(target.searchParams.get('sig').split('.')[1].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));}catch{fail('contact_invalid_redemption','This signed contact URL is invalid.',400);}
 if(!uuid(claims.sub))fail('contact_invalid_redemption','This signed contact URL is invalid.',400);await devices(env,claims.sub);const binding=await accountHandle(env,claims.sub).beamContactRedeem(claims.sub,input.url,id);return json(await object.beamContactRemember(id,binding,input.url));
 }
 const forget=/^\/api\/contacts\/directory\/([a-f0-9-]{36})$/.exec(path);if(forget)return json(await object.beamContactForget(id,forget[1]));
 if(path==='/api/contacts/directory'){
 const rows=await object.beamDirectory(id),result=[];for(const r of rows){try{const peer=accountHandle(env,r.peer);const info=await peer.beamContactInfo(r.peer,id,{grantId:r.grantId}),available=await devices(env,r.peer);result.push({...r,handle:available.account.handle,...info});}catch(error){if(!error.code)throw error;result.push({...r,beamEnabled:false,profile:null});}}return json(result);
 }
 const profile=/^\/api\/contacts\/profile\/([a-f0-9-]{36})$/.exec(path);if(profile){const contact=(await object.beamDirectory(id)).find(r=>r.peer===profile[1]);if(!contact)fail('contact_not_found','Import a signed contact link first.',404);const requested=url.searchParams.get('grantId');if(requested&&requested!==contact.grantId)fail('profile_grant_mismatch','Use this contact’s recorded grant.',403);return json(await accountHandle(env,profile[1]).beamDisclosed(profile[1],id,{grantId:contact.grantId}));}
 if(path==='/api/beams/invites'){
 const invite=await object.beamInviteCreate(id,await body(request),device);return json({...invite,url:`${env.APP_ORIGIN}/#beam-invite=${encodeURIComponent(invite.token)}`});
 }
 if(path==='/api/beams/invites/redeem'){
 const input=await body(request),pieces=typeof input.token==='string'?input.token.split('.'):[];if(pieces.length!==3||!uuid(pieces[0])||!uuid(pieces[1])||!/^[A-Za-z0-9_-]{43}$/.test(pieces[2]))fail('beam_invite_invalid','This nearby invitation is invalid.',400);
 await devices(env,pieces[0]);const inviter=accountHandle(env,pieces[0]),joined=await inviter.beamInviteJoin(pieces[0],input.token,id),recipient=joined.direction==='send'?id:pieces[0],sender=joined.direction==='send'?pieces[0]:id;
 const receivingDevice=joined.direction==='send'?device:joined.device,sendingDevice=joined.direction==='send'?joined.device:device;
 const sendingAccount=await devices(env,sender);if(!sendingAccount.devices.some(d=>d.id===sendingDevice))fail('beam_device_revoked','The sending device is no longer signed in.',410);
 const receivingAccount=await devices(env,recipient);if(!receivingAccount.devices.some(d=>d.id===receivingDevice))fail('beam_device_revoked','The receiving device is no longer signed in.',410);
 await accountHandle(env,recipient).beamPair(recipient,joined.id,sender,joined.expiresAt,receivingDevice,sendingDevice);return json({peer:pieces[0],inviteId:joined.id,direction:joined.direction,expiresAt:joined.expiresAt});
 }
 const inviteQR=/^\/api\/beams\/invites\/([a-f0-9-]{36})\/qr\.svg$/.exec(path);if(inviteQR){const share=await object.beamInviteURL(id,inviteQR[1]);return new Response(await QRCode.toString(share,{type:'svg',width:320,margin:2}),{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});}
 const invite=/^\/api\/beams\/invites\/([a-f0-9-]{36})$/.exec(path);if(invite)return json(await object.beamInviteGet(id,invite[1]));
 if(path==='/api/beams/offers'){
 const input=await body(request);if(!uuid(input.recipient))fail('beam_recipient_invalid','Choose a valid recipient.',400);const receiver=accountHandle(env,input.recipient),permission=await receiver.beamPermission(input.recipient,id,{...input,consume:true}),target=await devices(env,input.recipient);
 if(input.recipient===id&&input.deviceId===device)fail('beam_same_device','Choose a different receiving device.',400);
 if(permission.kind==='nearby'&&permission.senderDevice!==device)fail('beam_invite_device','Create the nearby offer on the paired sending device.',403);
 const deviceId=permission.kind==='nearby'?permission.deviceId:input.recipient===id?input.deviceId:undefined;
 const record=await object.beamCreate(id,actor,{...input,deviceId,devices:target.devices.map(d=>d.id),permission});
 try{await receiver.beamNotify(input.recipient,record);}catch(error){await object.beamAction(id,record.id,actor,'reject',{});throw error;}return json(beamView(record,actor),201);
 }
 if(path==='/api/beams/mailbox'){
 const mailbox=await object.beamMailbox(id,device),outbox=await object.beamOutbox(id,device),offers=[],seen=new Set();
 for(const reference of [...mailbox.offers,...outbox]){if(seen.has(reference.id))continue;try{const sender=accountHandle(env,reference.sender),r=await sender.beamRaw(reference.sender,reference.id);await validateOffer(env,r,actor);await validatePermission(env,r,accountHandle);offers.push(await displayOffer(env,r,await sender.beamAction(reference.sender,r.id,actor,'get',{}),accountHandle));seen.add(reference.id);}catch(error){if(!error.code)throw error;}}return json({...mailbox,offers});
 }
 const offer=/^\/api\/beams\/([a-f0-9-]{36})\/([a-f0-9-]{36})(?:\/(accept|reject|signal|ice))?$/.exec(path);
 if(offer){const sender=accountHandle(env,offer[1]),r=await sender.beamRaw(offer[1],offer[2]);await validateOffer(env,r,actor);await validatePermission(env,r,accountHandle);if(offer[3]==='ice'){const issued=await sender.beamIce(offer[1],offer[2],actor);try{const current=await sender.beamRaw(offer[1],offer[2]);if(current.state!=='accepted')fail('beam_not_accepted','This transfer is no longer accepted.',409);await validateOffer(env,current,actor);await validatePermission(env,current,accountHandle);}catch(error){if(issued.relayEnabled){const adapter=new CloudflareTurnAdapter({keyId:env.CLOUDFLARE_TURN_KEY_ID,apiToken:env.CLOUDFLARE_TURN_API_TOKEN});for(const username of new Set(issued.iceServers.map(s=>s.username).filter(Boolean)))try{await adapter.revoke(username);}catch{}}throw error;}return json(issued);}return json(await displayOffer(env,r,await sender.beamAction(offer[1],offer[2],actor,offer[3]||'get',request.method==='POST'?await body(request,70000):{}),accountHandle));}
 return json({error:'not_found'},404);
}
export function beamAllowedMethods(path){
 if(/^\/api\/contacts\/directory\/[^/]+$/.test(path))return ['DELETE'];
 if(/^\/api\/beams\/invites\/[^/]+\/qr\.svg$/.test(path))return ['GET'];
 if(['/api/beams/status','/api/beams/mailbox','/api/contacts/directory'].includes(path)||/^\/api\/beams\/invites\/[^/]+$/.test(path)&&path!=='/api/beams/invites/redeem'||/^\/api\/contacts\/profile\/[^/]+$/.test(path))return ['GET'];
 if(['/api/beams/offers','/api/beams/invites','/api/beams/invites/redeem','/api/contacts/redeem'].includes(path)||/^\/api\/beams\/[^/]+\/[^/]+\/(accept|reject|signal|ice)$/.test(path))return ['POST'];
 if(path==='/api/profile')return ['GET','PUT'];if(/^\/api\/contacts\/[^/]+\/beam$/.test(path))return ['PUT'];if(/^\/api\/beams\/[^/]+\/[^/]+$/.test(path))return ['GET'];return null;
}
