import {isUUID} from '../core/primitives.mjs';
export const BEAM_LIMITS=Object.freeze({maxFiles:16,maxBytes:100_000_000,maxFileBytes:100_000_000,offerTtlMs:300000,sessionTtlMs:900000,maxPending:128,maxSignals:128,maxSignalBytes:262144});
export class BeamError extends Error {constructor(code,message,status=400){super(message);this.name='BeamError';this.code=code;this.status=status;}}
const fail=(code,message,status)=>{throw new BeamError(code,message,status);};
export const uuid=isUUID;
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):0;
export function beamFunding(config){return {bytes:positive(config.BEAM_MONTHLY_DELIVERY_BYTES),offers:positive(config.BEAM_MONTHLY_OFFERS)};}
export function beamFiles(input){
 if(!Array.isArray(input)||!input.length||input.length>BEAM_LIMITS.maxFiles)fail('beam_file_count','Choose between one and sixteen files.');
 const files=input.map(f=>{if(!f||Object.keys(f).some(k=>!['id','name','size','type'].includes(k))||typeof f.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(f.id)||typeof f.name!=='string'||!f.name.trim()||f.name.length>255||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\]/.test(f.name)||['.','..'].includes(f.name)||!Number.isSafeInteger(f.size)||f.size<0||f.size>BEAM_LIMITS.maxFileBytes||typeof f.type!=='string'||f.type.length>128||/[\u0000-\u001f\u007f]/.test(f.type))fail('beam_invalid_file','The file metadata or size is invalid.');return {id:f.id,name:f.name,size:f.size,type:f.type};});
 if(new Set(files.map(f=>f.id)).size!==files.length)fail('beam_invalid_file','File IDs must be unique.');
 if(files.reduce((n,f)=>n+f.size,0)>BEAM_LIMITS.maxBytes)fail('beam_size_limit','The offer exceeds 100 MB.');return files;
}
export function beamView(record,actor){
 const role=actor.account===record.sender&&actor.device===record.senderDevice?'sender':'recipient';
 const {allowedDevices,signals,signalBytes,nextSeq,iceIssued,...publicRecord}=record;
 return {...publicRecord,role,signals:signals.filter(s=>s.role!==role).map(({role,...s})=>s),nextSeq:nextSeq[role]+1};
}
export class BeamService {
 constructor({metadata,config,entitlement,clock=()=>Date.now()}){Object.assign(this,{metadata,config,entitlement,clock});}
 month(){return new Date(this.clock()).toISOString().slice(0,7);}
 async status(owner){const paid=(await this.entitlement(owner)).plan!=='free',limits=beamFunding(this.config),usage=await this.metadata.get('beam/usage')||{month:this.month(),bytes:0,offers:0};return {enabled:this.config.BEAM_ENABLED==='true',paid,available:this.config.BEAM_ENABLED==='true'&&paid&&limits.bytes>0&&limits.offers>0,limits:{...BEAM_LIMITS,monthlyBytes:limits.bytes,monthlyOffers:limits.offers},usage:usage.month===this.month()?usage:{month:this.month(),bytes:0,offers:0},stunEnabled:this.config.BEAM_STUN_ENABLED==='true',relayUnavailableReason:this.config.BEAM_RELAY_BUDGET?'turn_not_configured':'relay_budget_enforcement_unavailable',relayEnabled:this.config.BEAM_TURN_ENABLED==='true'&&Boolean(this.config.BEAM_RELAY_BUDGET?.reserve&&this.config.BEAM_RELAY_BUDGET?.commit&&this.config.CLOUDFLARE_TURN_KEY_ID&&this.config.CLOUDFLARE_TURN_API_TOKEN)};}
 async create(owner,actor,input){
 if(!uuid(input.recipient)||!Array.isArray(input.devices)||!input.devices.length||input.devices.length>10||input.devices.some(id=>typeof id!=='string'||id.length>128)||input.deviceId&&!input.devices.includes(input.deviceId)||owner===input.recipient&&!input.deviceId)fail('beam_device_unavailable','Choose an active receiving device.',409);
 const files=beamFiles(input.files),bytes=files.reduce((n,f)=>n+f.size,0),status=await this.status(owner);
 if(!status.enabled)fail('beam_disabled','Beaming is not enabled.',503);if(!status.paid)fail('beam_paid_required','A paid plan is required to send files.',403);if(!status.available)fail('beam_unfunded','Beaming has no funded allowance configured.',503);
 return this.metadata.transaction(async tx=>{
 const records=await tx.list({prefix:'beam/offer/',limit:BEAM_LIMITS.maxPending+1});for(const [path,record]of records)if(record.expiresAt<=this.clock())await tx.delete(path);
 if([...records.values()].filter(r=>r.expiresAt>this.clock()).length>=BEAM_LIMITS.maxPending)fail('beam_pending_limit','Too many pending transfers.',429);
 let usage=await tx.get('beam/usage');if(usage?.month!==this.month())usage={month:this.month(),bytes:0,offers:0};
 if(usage.bytes+bytes>status.limits.monthlyBytes||usage.offers+1>status.limits.monthlyOffers)fail('beam_allowance_exceeded','Your monthly beaming allowance has been reached.',429);
 const record={id:crypto.randomUUID(),sender:owner,recipient:input.recipient,senderDevice:actor.device,recipientDevice:input.deviceId||null,allowedDevices:input.deviceId?[input.deviceId]:input.devices,files,state:'offered',selected:[],createdAt:this.clock(),expiresAt:this.clock()+BEAM_LIMITS.offerTtlMs,signals:[],signalBytes:0,nextSeq:{sender:0,recipient:0},iceIssued:{},permission:input.permission||null};
 await tx.put('beam/offer/'+record.id,record);await tx.put('beam/usage',{month:usage.month,bytes:usage.bytes+bytes,offers:usage.offers+1});return record;
 });
 }
 async raw(id){if(!uuid(id))fail('beam_not_found','Transfer not found.',404);const r=await this.metadata.get('beam/offer/'+id);if(!r)fail('beam_not_found','Transfer not found.',404);return r;}
 authorize(r,actor){if(r.expiresAt<=this.clock())fail('beam_expired','This transfer has expired.',410);if(actor.account===r.sender&&actor.device===r.senderDevice)return 'sender';if(actor.account===r.recipient&&r.allowedDevices.includes(actor.device)&&(!r.recipientDevice||r.recipientDevice===actor.device))return 'recipient';fail('beam_forbidden','This transfer belongs to another device.',403);}
 async action(id,actor,operation,input={}){return this.metadata.transaction(async tx=>{
 const r=await tx.get('beam/offer/'+id);if(!r)fail('beam_not_found','Transfer not found.',404);const role=this.authorize(r,actor);
 if(operation==='get')return beamView(r,actor);
 if(operation==='accept'){
 if(role!=='recipient'||r.state!=='offered')fail('beam_not_pending','The offer has already been claimed or closed.',409);
 if(!Array.isArray(input.fileIds)||!input.fileIds.length||new Set(input.fileIds).size!==input.fileIds.length||input.fileIds.some(id=>!r.files.some(f=>f.id===id)))fail('beam_selection_required','Select valid files before accepting.');
 r.selected=[...input.fileIds];r.recipientDevice=actor.device;r.state='accepted';r.expiresAt=this.clock()+BEAM_LIMITS.sessionTtlMs;
 }else if(operation==='reject'){
 if(!['offered','accepted'].includes(r.state))fail('beam_not_pending','This transfer is closed.',409);r.state=role==='sender'?'cancelled':'rejected';r.signals=[];r.signalBytes=0;
 }else if(operation==='signal'){
 if(r.state!=='accepted')fail('beam_not_accepted','The receiver must select files and accept first.',409);
 if(!Number.isSafeInteger(input.seq)||input.seq!==r.nextSeq[role]+1)fail('beam_signal_sequence','The signaling sequence is invalid.',409);
 if(!['offer','answer','candidate','complete'].includes(input.type)||input.type==='offer'&&role!=='sender'||input.type==='answer'&&role!=='recipient')fail('beam_signal_role','This signaling message is not allowed.');
 const encoded=JSON.stringify(input.data),encodedBytes=encoded?new TextEncoder().encode(encoded).byteLength:0;if(!encoded||typeof input.data!=='object'||input.data===null||encodedBytes>(input.type==='candidate'?2048:65536)||r.signals.length>=BEAM_LIMITS.maxSignals||r.signalBytes+encodedBytes>BEAM_LIMITS.maxSignalBytes)fail('beam_signal_limit','The signaling data exceeds its bounds.',413);
 if(['offer','answer'].includes(input.type)&&r.signals.some(s=>s.type===input.type))fail('beam_signal_duplicate','Session descriptions may only be sent once.',409);
 if(['offer','answer'].includes(input.type)&&(Object.keys(input.data).some(k=>!['type','sdp'].includes(k))||input.data.type!==input.type||typeof input.data.sdp!=='string'||!input.data.sdp.startsWith('v=0')))fail('beam_signal_invalid','The session description is invalid.');
 if(input.type==='candidate'&&(typeof input.data.candidate!=='string'||Object.keys(input.data).some(k=>!['candidate','sdpMid','sdpMLineIndex','usernameFragment'].includes(k))))fail('beam_signal_invalid','The ICE candidate is invalid.');
 if(input.type==='complete'&&(Array.isArray(input.data)||Object.keys(input.data).length))fail('beam_signal_invalid','Completion signals contain no payload.');
 if(input.type==='complete'&&role!=='recipient')fail('beam_signal_role','Only the receiver can mark receipt complete.');
 r.nextSeq[role]=input.seq;r.signals.push({seq:input.seq,type:input.type,data:input.data,role});r.signalBytes+=encodedBytes;if(input.type==='complete'){r.state='complete';r.signals=[];r.signalBytes=0;}
 }else fail('beam_invalid_action','Unsupported transfer action.');
 await tx.put('beam/offer/'+id,r);return beamView(r,actor);
 });}
 async outbox(owner,device){return [...(await this.metadata.list({prefix:'beam/offer/',limit:129})).values()].filter(r=>r.sender===owner&&r.senderDevice===device&&r.expiresAt>this.clock());}
 async mailbox(owner,device){const rows=await this.metadata.list({prefix:'beam/mailbox/',limit:BEAM_LIMITS.maxPending+1}),offers=[];for(const [path,r]of rows){if(r.expiresAt<=this.clock()){await this.metadata.delete(path);continue;}if(r.owner===owner&&r.devices.includes(device))offers.push({sender:r.sender,id:r.id,expiresAt:r.expiresAt});}return {offers,pollAfterMs:5000};}
 async notify(owner,input){return this.metadata.transaction(async tx=>{const rows=await tx.list({prefix:'beam/mailbox/',limit:BEAM_LIMITS.maxPending+1});let live=0;for(const [path,r]of rows){if(r.expiresAt<=this.clock())await tx.delete(path);else live++;}if(live>=BEAM_LIMITS.maxPending)fail('beam_mailbox_full','The receiving mailbox is full.',429);await tx.put('beam/mailbox/'+input.id,{owner,sender:input.sender,id:input.id,devices:input.allowedDevices,expiresAt:input.createdAt+BEAM_LIMITS.offerTtlMs+BEAM_LIMITS.sessionTtlMs});return {queued:true};});}
 async cleanup(){for(const prefix of ['beam/offer/','beam/mailbox/','beam/invite/','beam/nearby/'])for(const [path,r]of await this.metadata.list({prefix,limit:129}))if(r.expiresAt<=this.clock())await this.metadata.delete(path);}
}
