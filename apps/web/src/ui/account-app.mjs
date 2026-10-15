import { dodo as d } from '../shared/stack.mjs';
const {div,header,main,section,h1,h2,h3,p,span,strong,button,label,input,small,footer,code}=d;
const request=(target,kind,detail={})=>target.dispatchEvent(new CustomEvent('account-request',{detail:{kind,...detail},bubbles:true}));
export default function accountApp({snapshot,error}) {
  const resourceIds=snapshot?.preferences?.storage??[];
  const active=snapshot?.grants?.filter(g=>g.active&&g.expiresAt>Date.now())??[];
  const fragment=snapshot?.fragment;
  return main(
    header(div('3sln.me').classes('brand'),span('Bindle · account preview').classes('badge')),
    div('Local development preview. This account contains demo data. Email delivery, passkeys, and external storage connections are not active.').classes('notice'),
    section(div('Keep the keys. Choose the access.').classes('eyebrow'),h1('Your online life, under your control.'),p('An open identity. Resources you choose. A clear record of what each app can use.')).classes('hero'),
    error?p(error).attrs({role:'alert'}):snapshot?div(
      section(
        div(
          div('New access request').classes('eyebrow'),h2('MyUnifiedDrive wants to connect'),p('An example app is requesting your storage preferences to sync files between your devices.'),p('https://myunifieddrive.example').classes('origin'),
          div().classes('rule'),h3(fragment.title),p(fragment.description),p(fragment.id).classes('origin'),
          h3('Choose which storage the app may use'),p('Only the resources you select below will be shared. No resource is selected for you.'),
          ...(snapshot.resources??[]).map(r=>label(input().props({type:'checkbox',value:r.id,name:'resource',disabled:!resourceIds.includes(r.id)}),div(strong(r.name),span(resourceIds.includes(r.id)?'Already configured in this shared preference':'Not assigned to this preference; unavailable to this request'),span(r.id))).classes('choice')),
          p('Allowed operations: read known files, write files, and delete files.').classes('warning'),
          p(active.length?`This fragment currently has ${active.length} active app grant(s). Review each below before changing it.`:'No apps currently have access to this fragment.'),
          label(input().props({type:'checkbox',name:'acknowledged'}),div('I understand this app can read, write, and delete files in the selected storage.')).classes('choice'),
          div(button('Allow selected storage').classes('primary').on({click:event=>{ const card=event.currentTarget.closest('.consent');const resources=[...card.querySelectorAll('input[name=resource]:checked')].map(x=>x.value); const acknowledged=card.querySelector('input[name=acknowledged]').checked; request(event.currentTarget,'consent',{resources,acknowledged});}}),button('Decline').on({click:event=>request(event.currentTarget,'decline')})).classes('buttons'),
          p().props({id:'consent-status'}).attrs({role:'status','aria-live':'polite'}).classes('status')
        ).classes('card','consent'),
        div(div('Access ledger').classes('eyebrow'),h2('Apps with access'),...(active.length?active.map(g=>div(h3(g.client),p(`Operations: ${g.methods.join(', ')}`),p(`Resources: ${g.resources.map(id=>snapshot.resources.find(r=>r.id===id)?.name??id).join(', ')}`),button('Revoke access').on({click:event=>request(event.currentTarget,'revoke',{id:g.id})})).classes('grant')):[p('No active grants. Nothing is shared until you allow it.').classes('empty')]),p('Revoking stops future calls. It cannot erase copies an app already made.').classes('muted')).classes('card')
      ),
      section(
        div(div('Portable identity').classes('eyebrow'),h2('Sign in with Bindle'),d.h('bindle-sign-in'),p().props({id:'login-status'}).attrs({role:'status'}).classes('status')).classes('card'),
        div(div('Shared preference').classes('eyebrow'),h2('Configure storage'),p('Choose resources available for future app requests. Saving does not give any app new access. Removing a resource blocks its existing grants.'),
          ...snapshot.resources.map(r=>label(input().props({type:'checkbox',name:'configured-resource',value:r.id,checked:resourceIds.includes(r.id)}),div(r.name)).classes('choice')),
          button('Save storage preference').on({click:event=>{const card=event.currentTarget.closest('.card');request(event.currentTarget,'preferences',{storage:[...card.querySelectorAll('input[name=configured-resource]:checked')].map(x=>x.value)});}}),p('This request is optional: you can decline without configuring storage.').classes('muted')).classes('card'),
        div(div('Connected resources').classes('eyebrow'),h2('Your storage'),...snapshot.resources.map(r=>div(h3(r.name),p(r.id).classes('origin'),code(r.contracts.join('\n')).classes('contract')).classes('grant')),p('External connectors need a backend credential vault and provider authorization before they can be enabled.').classes('muted')).classes('card'),
        div(div('Account security').classes('eyebrow'),h2('Emails & passkeys'),p('No verified emails or passkeys exist in this preview.'),p('Email linking must confirm both email ownership and the destination account. Passkeys require a verified WebAuthn ceremony.'),button('Not available in this preview').props({disabled:true})).classes('card')
      )
    ).classes('grid'):p('Loading your account…').attrs({role:'status'}),
    footer('Built with the 3sln stack · Open contracts, independent providers · Development preview')
  ).classes('shell');
}
