import { h,icon,badge,date,field,pageHeader,helpers,interfaceText } from './release-primitives.mjs';
export default function securityView(state){
  const {btn,date}=helpers(state),a=state.data?.account??state.session?.account??{},credentials=state.data?.credentials??[],devices=state.data?.devices??[];
  return h('div',pageHeader('A home worth protecting.','Manage your identity and how you access your account.',btn([icon('logout'),'Sign out'],{kind:'signout'},'button secondary')),
    h('div',h('section',h('div',icon('shield')).classes('section-icon'),h('h2','Your identity'),
      h('dl',h('div',h('dt','Handle'),h('dd',`${a.handle}@${state.config.handleOriginHost??state.brand.host}`)),h('div',h('dt','Account status'),h('dd',a.status??'Active')),h('div',h('dt','Sign-in method'),h('dd',`${a.passkeyCount??0} passkey(s)${a.hasPassword?' · Password enabled':''}`))).classes('settings-details'),h('p','Keep your recovery file private and backed up. Losing both your sign-in credentials and recovery file can permanently lock you out.').classes('security-note')).classes('panel'),
    h('section',h('h2','Passkeys & password'),h('p','Register a passkey on each device you trust. Removing a passkey also revokes sessions authenticated with it.').classes('muted'),
      ...credentials.map(key=>h('div',h('div',h('strong',key.label??'Passkey').attrs({translate:'no'}),h('p',`${key.deviceType??'Authenticator'}${key.backedUp?' · Backed up':''} · Added ${date(key.createdAt)}`).classes('field-help')),btn('Remove',{kind:'open-modal',modal:{kind:'remove-passkey',credential:key}},'text-button danger')).classes('credential-row').key(key.id)),
      credentials.length?null:h('p',`${a.passkeyCount??0} verified passkey(s)${a.hasPassword?' and a password are':' are'} configured.`).classes('muted'),btn([icon('plus'),'Add a passkey'],{kind:'open-modal',modal:{kind:'add-passkey'}},'button secondary'),h('p','Adding and removing keys requires a recent sign-in. A final sign-in method cannot be removed.').classes('field-help')).classes('panel'),
    h('section',h('h2','Signed-in devices'),h('p','Review the sessions that can access your account. Revoking a session signs that device out.').classes('muted'),
      ...devices.map(device=>h('div',h('div',h('strong',device.label??'Browser session').attrs({translate:'no'}),device.current?badge('This device','good'):null,h('p',interfaceText('Last active {date} · Expires {expiry}',{date:date(device.lastUsedAt??device.createdAt),expiry:date(device.expiresAt)})).classes('field-help')),btn('Revoke',{kind:'open-modal',modal:{kind:'revoke-device',device}},'text-button danger')).classes('credential-row').key(device.id)),
      devices.length?null:h('p','Device session information is unavailable.').classes('muted'),btn('Sign out other devices',{kind:'open-modal',modal:{kind:'revoke-other-devices'}},'button secondary')).classes('panel'),
    h('section',h('h2','Email addresses'),h('p','Email is optional. Adding an address requires verification before it can be used for delivery.').classes('muted'),
      a.verifiedEmail?h('div',h('span',a.verifiedEmail).attrs({translate:'no'}),badge('Verified','good')).classes('credential-row'):null,
      btn('Add email address',{kind:'open-modal',modal:{kind:'email'}},'button secondary',!state.config.emailEnabled),!state.config.emailEnabled?h('p','Email linking is not enabled on this service.').classes('field-help'):null).classes('panel'),
    h('section',h('h2','Apps with access'),...(state.data.grants??[]).filter(g=>g.active).map(grant=>h('div',h('strong',grant.client),h('p',(grant.methods??[]).join(', ')),btn('Revoke access',{kind:'revoke-grant',id:grant.id},'text-button danger')).classes('credential-row')),
      (state.data.grants??[]).some(g=>g.active)?null:h('p','No apps have access to your resources.').classes('muted')).classes('panel')
    ).classes('settings-grid'));
}
export function securityDialog(state){
  const m=state.modal,{btn,form}=helpers(state);
  if(m.kind==='add-passkey')return {title:'Add a key for this device.',body:form([field('label','Passkey name','text',{required:true,maxLength:80,placeholder:'e.g. Personal phone'}),h('p','Your browser will ask you to create a passkey. Give it a name you will recognize later.').classes('muted')],{kind:'add-passkey'},'Create passkey')};
  if(m.kind==='remove-passkey')return {title:'Remove this passkey?',body:h('div',h('p',`Remove “${m.credential.label??'Passkey'}” and revoke its signed-in sessions? You must keep at least one way to sign in.`),btn('Remove passkey',{kind:'remove-passkey',credentialId:m.credential.id},'button danger-button'))};
  if(m.kind==='revoke-device')return {title:'Sign this device out?',body:h('div',h('p',`Revoke “${m.device.label??'Browser session'}”?${m.device.current?' This is the device you are using now.':''}`),btn('Revoke device session',{kind:'revoke-device',sessionId:m.device.id},'button danger-button'))};
  if(m.kind==='revoke-other-devices')return {title:'Keep only this device signed in?',body:h('div',h('p','All other sessions will lose access. Their passkeys stay registered and can sign in again.'),btn('Sign out other devices',{kind:'revoke-other-devices'},'button danger-button'))};
  return null;
}
