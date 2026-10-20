// AccountController slice 11, Beaming (docs/architecture/app-engine.md §12): beams, beam contacts and invites.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {BeamError} from '../../beaming/index.mjs';
import {CloudflareTurnAdapter} from '../../beaming/turn.mjs';
import {encryptSecret,decryptSecret} from '../secrets.mjs';

export const methods={
  async beamOutbox(owner,device){return this.beams.outbox(owner,device);},
  async beamStatus(owner){return this.beams.status(owner);},
  async beamCreate(owner,actor,input){const result=await this.beams.create(owner,actor,input);await this.scheduleAlarm(result.expiresAt);return result;},
  async beamRaw(owner,id){return this.beams.raw(id);},
  async beamAction(owner,id,actor,operation,input){const result=await this.beams.action(id,actor,operation,input);if(operation!=='get')await this.scheduleAlarm(result.expiresAt);return result;},
  async beamMailbox(owner,device){return this.beams.mailbox(owner,device);},
  async beamNotify(owner,input){const result=await this.beams.notify(owner,input);await this.scheduleAlarm(input.expiresAt);return result;},
  async beamProfile(owner,input){return this.beamContacts.profile(owner,input);},
  async beamContactEnable(owner,id,input){return this.beamContacts.enable(owner,id,input);},
  async beamContactRedeem(owner,url,peer){return this.beamContacts.redeem(owner,url,peer);},
  async beamContactRemember(owner,binding,url){const result=await this.beamContacts.remember(owner,binding);if(typeof url==='string'){const record=await this.metadata.get('beam/directory/'+binding.owner);record.encryptedURL=await encryptSecret({url},this.config.KEY_ENCRYPTION_KEY);await this.metadata.put('beam/directory/'+binding.owner,record);}return result;},
  async beamDirectory(owner){const rows=await this.beamContacts.directory(owner);return Promise.all(rows.map(async r=>{const record=await this.metadata.get('beam/directory/'+r.peer);return {...r,...record?.encryptedURL?await decryptSecret(record.encryptedURL,this.config.KEY_ENCRYPTION_KEY):{}};}));},
  async beamContactForget(owner,peer){return this.beamContacts.forget(owner,peer);},
  async beamPermission(owner,peer,input){return this.beamContacts.permission(owner,peer,input);},
  async beamContactInfo(owner,peer,input){return this.beamContacts.contactInfo(owner,peer,input);},
  async contactProfile(owner,url){return this.beamContacts.publicProfile(owner,url);},
  async beamDisclosed(owner,peer,input){return this.beamContacts.disclosed(owner,peer,input);},
  async beamInviteCreate(owner,input,device){const result=await this.beamContacts.createInvite(owner,input,device);const record=await this.metadata.get('beam/invite/'+result.id);record.encryptedToken=await encryptSecret({token:result.token},this.config.KEY_ENCRYPTION_KEY);await this.metadata.put('beam/invite/'+result.id,record);await this.scheduleAlarm(result.expiresAt);return result;},
  async beamInviteURL(owner,id){await this.beamContacts.invite(owner,id);const r=await this.metadata.get('beam/invite/'+id),secret=await decryptSecret(r.encryptedToken,this.config.KEY_ENCRYPTION_KEY);return `${this.config.APP_ORIGIN}/#beam-invite=${encodeURIComponent(secret.token)}`;},
  async beamInviteGet(owner,id){return this.beamContacts.invite(owner,id);},
  async beamInviteJoin(owner,token,peer){return this.beamContacts.joinInvite(owner,token,peer);},
  async beamPair(owner,id,peer,expiresAt,deviceId,senderDevice){return this.beamContacts.pair(owner,id,peer,expiresAt,deviceId,senderDevice);},
  async beamIce(owner,id,actor){
    const r=await this.beams.raw(id),role=this.beams.authorize(r,actor);if(r.state!=='accepted')throw new BeamError('beam_not_accepted','Accept the selected files first.',409);
    const status=await this.beams.status(owner);if(!status.paid)throw new BeamError('beam_paid_required','The sending plan is no longer paid.',403);
    if(!status.relayEnabled)return {iceServers:this.config.BEAM_STUN_ENABLED==='true'?[{urls:['stun:stun.cloudflare.com:3478']}]:[],relayEnabled:false};
    await this.metadata.transaction(async tx=>{const current=await tx.get('beam/offer/'+id);if(!current)throw new BeamError('beam_expired','This transfer has expired.',410);this.beams.authorize(current,actor);if(current.state!=='accepted')throw new BeamError('beam_not_accepted','This transfer is no longer accepted.',409);if(current.iceIssued[role])throw new BeamError('beam_turn_already_issued','TURN credentials were already issued for this participant.',409);current.iceIssued[role]='issuing';await tx.put('beam/offer/'+id,current);});
    const bytes=r.files.filter(f=>r.selected.includes(f.id)).reduce((n,f)=>n+f.size,0)*2;
    const reservation=await this.config.BEAM_RELAY_BUDGET.reserve({owner,transfer:id,role,maxBytes:bytes,ttl:300});if(!reservation?.enforced)throw new BeamError('beam_turn_unfunded','An enforceable relay allowance is required.',503);
    const adapter=new CloudflareTurnAdapter({keyId:this.config.CLOUDFLARE_TURN_KEY_ID,apiToken:this.config.CLOUDFLARE_TURN_API_TOKEN}),issued=await adapter.issue({ttl:300});
    try{await this.config.BEAM_RELAY_BUDGET.commit(reservation);await this.metadata.transaction(async tx=>{const current=await tx.get('beam/offer/'+id);if(!current)throw new BeamError('beam_expired','This transfer has expired.',410);this.beams.authorize(current,actor);if(current.state!=='accepted')throw new BeamError('beam_not_accepted','This transfer is no longer accepted.',409);current.iceIssued[role]=true;await tx.put('beam/offer/'+id,current);});}catch(error){for(const username of new Set(issued.iceServers.map(s=>s.username).filter(Boolean)))try{await adapter.revoke(username);}catch{}throw error;}return {...issued,relayEnabled:true};
  },
};

export const rpc={
 beamInviteURL:{},
 beamOutbox:{},
 beamStatus:{},
 beamCreate:{},
 beamRaw:{},
 beamAction:{},
 beamMailbox:{},
 beamNotify:{},
 beamIce:{},
 beamProfile:{},
 beamContactEnable:{},
 beamContactRedeem:{},
 beamContactRemember:{},
 beamDirectory:{},
 beamContactForget:{},
 beamPermission:{},
 beamDisclosed:{},
 beamContactInfo:{},
 contactProfile:{},
 beamInviteCreate:{},
 beamInviteGet:{},
 beamInviteJoin:{},
 beamPair:{},
};
