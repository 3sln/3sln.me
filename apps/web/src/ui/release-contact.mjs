import {systemTag} from '../../../../packages/messaging/tags.mjs';
import {h,icon,badge,field,select,helpers,interfaceText,fire} from './release-primitives.mjs';
import {composable,audienceOf,sentFor,writable,intentLink} from '../bl/contact-link.mjs';
const reasons={'paid-required':'This link currently accepts messages from paid accounts.'};
const types={'text/plain':'Plain text','text/html':'HTML document'};
// Bidi isolation for interpolated identities/origins (FSI…PDI; origins are always LTR).
const iso=v=>'⁨'+v+'⁩',ltr=v=>'⁦'+v+'⁩';
export const fullDate=(value,locale)=>value?new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric'}).format(new Date(value)):'—';
const tagLabel=t=>systemTag(t.id)?interfaceText(systemTag(t.id).label):h('bdi',t.label??t.id).attrs({dir:'auto',translate:'no'});
function linkInfo(state,intake){return [
 h('dl',h('div',h('dt','Link type'),h('dd',intake.conditional?'Conditional contact link':'Contact link')),h('div',h('dt','Accepts'),h('dd',intake.mimeTypes.map(t=>types[t]??t).join(', '))),h('div',h('dt','Message size'),h('dd',interfaceText('Up to {size} KB',{size:String(Math.floor(intake.maxMessageBytes/1024))}))),h('div',h('dt',intake.quotaScope==='principal-day'?'Messages per day':'Messages'),h('dd',String(intake.maxMessages))),h('div',h('dt','Link expires'),h('dd',fullDate(intake.expiresAt,state.locale)))).classes('contact-limits'),
 intake.conditional?h('div',icon('shield'),h('p','This link accepts messages only from identities its owner’s service considers eligible. The owner’s service (this site) decides eligibility, not the sender’s app.')).classes('info-strip','contact-conditional'):null,
 writable(intake)?null:h('p','This link accepts content from apps, not written messages.').attrs({role:'status'}).classes('security-note','contact-app-only')];}
function profileBlock(profile){return profile?h('section',h('p','Shared by this contact link').classes('field-help'),profile.displayName?h('strong',h('bdi',profile.displayName).attrs({dir:'auto'})).attrs({translate:'no'}):null,profile.bio?h('p',profile.bio).attrs({translate:'no',dir:'auto'}).classes('contact-profile-bio'):null,profile.avatar?h('a','View shared avatar').props({href:profile.avatar,target:'_blank',rel:'noreferrer noopener'}).classes('text-button'):null).classes('contact-recipient-profile'):null;}
// Public page (links §9): description and hand-off only. No composer and no messaging API.
export function contactPage(state){
 const {btn,form,alerts}=helpers(state),page=state.contactPage??{},intake=page.intake,account=state.session?.account,endpoint=page.link,signup=page.signup;
 const heading=h('div',badge('A PERSONAL INVITATION'),h('h2',interfaceText('Send a message to {recipient}.',{recipient:iso(page.profile?.displayName??state.route.recipient)})).classes('contact-recipient-heading'),h('p',interfaceText('Contact identity: {identity}',{identity:iso(`${state.route.recipient}@${state.config.handleOriginHost??state.brand?.host??''}`)})).classes('field-help'),profileBlock(intake?page.profile:null));
 if(!intake)return h('div',heading,alerts(),state.error&&endpoint?h('div',btn('Try again',{kind:'reload-contact-page'},'button secondary',page.retrying)).classes('buttons'):state.error?null:h('p','Checking this contact link…').attrs({role:'status'}).classes('field-help'));
 const intents=endpoint?h('nav',writable(intake)?h('a','Send a message with your Bindle app').props({href:intentLink('send-message',endpoint),rel:'noreferrer'}).classes('button','secondary','contact-intent'):null,h('a','Add to contacts in your Bindle app').props({href:intentLink('add-contact',endpoint),rel:'noreferrer'}).classes('button','secondary','contact-intent')).attrs({'aria-label':'Open with a Bindle app'}).classes('buttons','contact-intents'):null;
 const host=state.config.handleOriginHost??state.brand?.host??'',identity=account?`${account.handle}@${host}`:'';
 const options=account?h('section',h('p',interfaceText('Signed in as {identity}.',{identity:iso(identity)})).classes('contact-sender'),h('div',writable(intake)?btn('Send a message',{kind:'contact-handoff',intent:'send-message'},'button primary'):null,btn('Add to contacts',{kind:'contact-handoff',intent:'add-contact'},'button secondary')).classes('buttons')).classes('contact-signed-in')
  :h('section',h('p','No Bindle app?').classes('field-help'),btn(interfaceText('Sign in or sign up with {brand}',{brand:state.brand?.name??'3sln.me'}),{kind:'contact-auth',mode:'signin'},'button primary'),
   form([field('handle','Your handle on another provider','text',{autoComplete:'username',placeholder:'alex@provider.example',maxLength:300,required:true})],{kind:'discover-provider'},'Find my provider'),
   page.providerError?h('p',page.providerError).attrs({role:'alert'}).classes('alert','error'):null,
   page.provider?h('div',h('p',interfaceText('This contact link will be sent to {host} so you can continue there.',{host:ltr(page.provider.host)})).classes('security-note'),h('div',...page.provider.intents.map(intent=>btn(interfaceText(intent==='send-message'?'Continue with {host} to send a message':'Continue with {host} to add this contact',{host:ltr(page.provider.host)}),{kind:'continue-with-provider',intent},'button primary'))).classes('buttons')).classes('contact-provider'):null,
   signup&&!signup.free&&signup.paid?h('p',h('span','Free accounts are closed for now. '),btn('Create a paid account',{kind:'contact-auth',mode:'paid'},'text-button')).classes('field-help'):null,
   signup&&!signup.open&&signup.waitlist?h('p',h('span','New accounts are paused. '),h('a','Join the waitlist').props({href:'/console?waitlist=1'}).classes('text-button')).classes('field-help'):null,
   h('p','Messages through contact links always come from a verified identity. After signing in you return here to send or save this contact.').classes('field-help')).classes('contact-signin');
 return h('div',heading,h('p','This contact link sets what you can send and where it goes.').classes('muted'),...linkInfo(state,intake),alerts(),intents,options);
}
// Console send-message view: the opener flow lives inside the signed-in shell.
export function handoffView(state){
 const {btn,form,alerts}=helpers(state),handoff=state.handoff,intake=handoff?.intake,account=state.session?.account,host=state.config.handleOriginHost??state.brand?.host??'',identity=account?iso(`${account.handle}@${host}`):'';
 const trusted=(text,kind,cls)=>h('button',text).props({type:'button',disabled:state.busy}).classes(...cls.split(' ')).on({click:event=>fire(event.currentTarget,kind,{nativeEvent:event})});
 const recipient=(()=>{try{const url=new URL(handoff?.link);return iso(`${url.pathname.split('/')[2]}@${url.host}`);}catch{return null;}})();
 const shell=(...body)=>h('section',h('div',h('h1','Contact link'),btn('Close',{kind:'cancel-handoff'},'text-button')).classes('page-heading'),recipient&&!handoff?.foreign?h('p',interfaceText('To: {recipient}',{recipient})).classes('contact-recipient'):null,alerts(),...body).classes('panel','contact-handoff').attrs({'aria-busy':state.busy?'true':'false'});
 if(!handoff)return shell(h('p','No contact link is open.').classes('muted'));
 if(handoff.foreign)return shell(h('p','Contact links on other services can’t be used from here yet.').attrs({role:'status'}).classes('security-note','contact-foreign'));
 if(!handoff.intent)return shell(h('p','What would you like to do with this contact link?'),h('div',btn('Send a message',{kind:'choose-handoff',intent:'send-message'},'button primary'),btn('Add to contacts',{kind:'choose-handoff',intent:'add-contact'},'button secondary')).classes('buttons'));
 if(!intake)return shell(state.error?(handoff.intent==='send-message'?h('div',btn('Try again',{kind:'reload-contact'},'button secondary')).classes('buttons'):null):h('p','Checking this contact link…').attrs({role:'status'}).classes('field-help'));
 const info=linkInfo(state,intake);if(!writable(intake))return shell(...info);
 if(sentFor(state))return shell(h('div',icon('check'),h('h3','Your message is on its way.'),h('p',interfaceText('Sent as {identity}. The recipient’s service accepted it; this does not mean it has been read.',{identity}))).attrs({role:'status'}).classes('empty-state','contact-sent'),h('div',btn('Write another message',{kind:'write-another'},'button secondary'),btn('Close',{kind:'cancel-handoff'},'text-button')).classes('buttons'));
 const a=audienceOf(state);
 if(intake.conditional&&a?.state!=='eligible')return shell(...info,
  a?.state==='ineligible'?h('p',interfaceText('Checked as {identity}: ',{identity}),reasons[a.reason]??'This contact link does not currently accept messages from your account.').attrs({role:'status'}).classes('alert','contact-ineligible'):a?.state==='stale'?h('p',interfaceText('Checked as {identity}: that eligibility check expired or was already used.',{identity})).attrs({role:'status'}).classes('alert'):a?.state==='unverifiable'?h('p',interfaceText('Checked as {identity}: your identity could not be verified for this link.',{identity})).attrs({role:'status'}).classes('alert'):a?.state==='unavailable'?h('p','Eligibility could not be checked right now. Try again shortly.').attrs({role:'status'}).classes('alert'):null,
  a?.state==='ineligible'?null:h('div',h('p',interfaceText('Continuing reveals your handle and identity ({identity}) to {origin}. That site decides whether you are eligible.',{identity,origin:ltr(handoff.origin??'')})),h('p','Nothing is shared until you continue. The check is valid for a few minutes and can be used once.').classes('field-help')).classes('security-note','contact-disclosure'),
  h('div',a?.state==='ineligible'?btn('Try again',{kind:'reload-contact'},'button secondary'):a?.state==='unverifiable'?btn('Sign in again',{kind:'open-accounts'},'button primary'):trusted(interfaceText('Continue as {identity}',{identity}),'continue-as-audience','button primary'),btn('Switch account',{kind:'open-accounts'},'button secondary')).classes('buttons'));
 const choices=intake.mimeTypes.filter(t=>types[t]);
 return shell(...info,h('form',
  h('p',interfaceText('Sending as {identity}',{identity})).classes('contact-sender'),
  choices.length>1?select('mimeType','Message type',choices.map(t=>[t,types[t]]),choices[0]):null,
  field('subject','Subject','text',{maxLength:200,placeholder:'A short title'}),
  intake.optionalTags.length?h('fieldset',h('legend','Optional tags'),...intake.optionalTags.map(t=>h('label',h('input').props({type:'checkbox',name:'selectedTags',value:t.id}),h('span',tagLabel(t))).classes('checkbox-field').key(t.id))).classes('contact-optional-tags'):null,
  h('label',h('span','Your message'),h('textarea').props({name:'text',rows:8,required:true,placeholder:'Write something thoughtful…'}).attrs({maxlength:String(Math.min(intake.maxMessageBytes,1048576))}).classes('input','message-compose')).classes('field'),
  h('p','The recipient will see your identity. Only share information you intend them to keep.').classes('field-help'),
  h('div',h('button',state.busy?'Please wait…':'Send message').props({type:'submit',disabled:state.busy||state.offline||!composable(state)}).classes('button','primary'),btn('Switch account',{kind:'open-accounts'},'text-button')).classes('buttons')
 ).on({submit:event=>{event.preventDefault();if(state.busy||state.offline||!composable(state)||!event.currentTarget.checkValidity())return;fire(event.currentTarget,'send-authored-message',{form:event.currentTarget,nativeEvent:event});}}).classes('form').attrs({'aria-busy':state.busy?'true':'false'}));
}
