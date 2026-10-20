// AccountController slice 3, Contacts and intake (docs/architecture/app-engine.md §12): contact tokens, links, intake, previews and developer contact.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {developerContactTier,developerContactLink} from '../developer-contact.mjs';
import {linkAudienceDecide,inspectContactLink,signOwnLinkResponse,authorLinkEnvelope} from '../contact-links.mjs';
import {contactIntake} from '../../messaging/tag-policy.mjs';
import {CONVERSATION_INVITE_MIME} from '../../messaging/content.mjs';
import {encryptSecret,decryptSecret} from '../secrets.mjs';
import {StorageError} from '../../storage/policy.mjs';

export const methods={
  async contacts(owner){const beamGrants=await this.metadata.list({prefix:'beam/grant/'});const names=await this.metadata.list({prefix:'contact-name/'});return (await this.tokens.list(owner)).map(g=>({id:g.id,beamEnabled:beamGrants.get('beam/grant/'+g.id)?.beamEnabled===true,profileFields:beamGrants.get('beam/grant/'+g.id)?.profileFields||[],discloseProfile:Boolean(beamGrants.get('beam/grant/'+g.id)?.profileFields?.length),name:names.get(`contact-name/${g.id}`)||'Contact link',active:g.active,quarantined:Boolean(g.quarantined),createdAt:g.createdAt,expiresAt:g.claims.exp*1000,collections:g.claims.collections,mimeTypes:g.claims.mimeTypes,form:g.endpoint?.form==='link'?'link':'legacy',conditional:Boolean(g.endpoint?.claims?.audience),...g.endpoint?.claims?.audience?.policy?{policy:g.endpoint.claims.audience.policy}:{},kinds:g.endpoint?.form==='link'?g.endpoint.claims.kinds:['one-off'],intake:g.endpoint?contactIntake(g):null,messagesUsed:g.messagesUsed,maxMessages:g.claims.maxMessages,bytesUsed:g.bytesUsed,maxBytes:g.claims.maxBytes}));},
  async developerContactTier(owner){return developerContactTier(this,owner);},
  async developerContactLink(owner,handle){return developerContactLink(this,owner,handle);},
  async linkAudienceDecide(owner,parent,principal){return linkAudienceDecide(this,owner,parent,principal);},
  async inspectContactLink(owner,url){return inspectContactLink(this,owner,url);},
  async contactMetadata(owner,url,locales){const {grant}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});return this.endpoints.linkMetadata(url,{locales});},
  async mintDeliveryToken(owner,url){const {grant}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});return this.endpoints.mintDelivery(url);},
  async createContact(owner,handle,input){await this.warm(owner);if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Error('Contact name is required');const signer=await this.signingKey(owner);const issued=await this.endpoints.create(owner,{...input,handle,kid:signer.kid});return this.finishContact(owner,issued,input);},
  // New-form (bindle_meta) owner links: unconditional, one-off, intake tags (links §6, §6.2).
  async createContactLink(owner,handle,input){await this.warm(owner);const allowed=['name','mimeTypes','expiresAt','maxMessages','maxBytes','maxMessageBytes','autoTags','optionalTags','labels'];if(!input||Object.keys(input).some(k=>!allowed.includes(k))||typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new StorageError('invalid_contact','Choose a name and limits for this contact link.');const collection=(await this.messages.collections(owner)).find(c=>c.active);if(!collection)throw new StorageError('invalid_collection','Your incoming store is unavailable.',409);const signer=await this.signingKey(owner),{autoTags=[],optionalTags=[],labels={},name,...limits}=input;return this.finishContact(owner,await this.endpoints.createLink(owner,{...limits,handle,kid:signer.kid,collections:[collection.id],kinds:['one-off'],requiredTags:autoTags,optionalTags,tagLabels:labels}),{name});},
  async createSystemContactLink(owner,handle,options,name){await this.warm(owner);const signer=await this.signingKey(owner);return this.finishContact(owner,await this.endpoints.createLink(owner,{...options,handle,kid:signer.kid}),{name});},
  async finishContact(owner,issued,input){await this.metadata.put(`contact-name/${issued.grant.id}`,input.name.trim());if(input.beamEnabled!==undefined||input.profileFields!==undefined||input.discloseProfile!==undefined)await this.beamContacts.enable(owner,issued.grant.id,{beamEnabled:input.beamEnabled??false,...input.profileFields!==undefined?{profileFields:input.profileFields}:{},...input.discloseProfile!==undefined?{discloseProfile:input.discloseProfile}:{}});const encryptedURL=await encryptSecret({url:issued.url},this.config.KEY_ENCRYPTION_KEY),storedURL=await this.metadata.transaction(async tx=>{const path=`contact-url/${issued.grant.id}`,prior=await tx.get(path);if(prior!==undefined)return prior;await tx.put(path,encryptedURL);return encryptedURL;});const url=(await decryptSecret(storedURL,this.config.KEY_ENCRYPTION_KEY)).url;return {...(await this.contacts(owner)).find(g=>g.id===issued.grant.id),url};},
  async contactURL(owner,id){const g=(await this.tokens.list(owner)).find(g=>g.id===id);if(!g)throw new Error('Contact not found');const record=await this.metadata.get(`contact-url/${id}`);return (await decryptSecret(record,this.config.KEY_ENCRYPTION_KEY)).url;},
  async contactIntake(owner,id){return this.endpoints.intake(owner,id);},
  async updateContactIntake(owner,id,input){if(!input||Object.keys(input).some(k=>!['revision','autoTags','optionalTags','labels'].includes(k)))throw new StorageError('invalid_contact_tags','Choose automatic and optional tags.');return this.endpoints.updateIntake(owner,id,input);},
  async rotateContactChallenge(owner,id){const {url}=await this.endpoints.rotateChallenge(owner,id);await this.metadata.put(`contact-url/${id}`,await encryptSecret({url},this.config.KEY_ENCRYPTION_KEY));return {url};},
  async signLinkResponse(owner,handle,link){return signOwnLinkResponse(this,owner,handle,link);},
  async authorLinkEnvelope(owner,input){return authorLinkEnvelope(this,owner,input);},
  async revokeContact(owner,id){await this.tokens.revoke(owner,id);return {revoked:true};},
  async quarantineContact(owner,id,value){return this.endpoints.quarantine(owner,id,value);},
  // Over HTTP, inbox bearers are retained only as the conversation-v1 invitation credential on legacy
  // parents that allow invitations; anonymous message submission with them is retired (links §6.1, §10).
  async mintContact(owner,url){const {grant}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});return this.endpoints.mint(url);},
  async mintInvitationBearer(owner,url){const {grant,form}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});if(form==='link'||!grant.claims.mimeTypes.includes(CONVERSATION_INVITE_MIME))throw new StorageError('not_acceptable','This contact link accepts only identity-authored messages.',406);return this.endpoints.mint(url);},
};

export const rpc={
 contacts:{},
 createContact:{},
 createContactLink:{},
 contactURL:{},
 contactIntake:{},
 updateContactIntake:{},
 rotateContactChallenge:{},
 revokeContact:{},
 quarantineContact:{},
 mintContact:{},
 mintInvitationBearer:{},
 contactMetadata:{},
 mintDeliveryToken:{},
 signLinkResponse:{},
 authorLinkEnvelope:{},
 developerContactTier:{},
 developerContactLink:{gate:'none'},
 linkAudienceDecide:{gate:'none'},
 inspectContactLink:{gate:'none'},
};
