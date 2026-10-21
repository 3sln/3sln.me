import {contactPage} from './release-contact.mjs';
import { h,badge,logo,helpers } from './release-primitives.mjs';
export default function publicPage(state){
  const {btn,form,alerts}=helpers(state),route=state.route;
  let content;
  if(route.kind==='contact')content=contactPage(state);
  else if(route.kind==='unsubscribe')content=h('div',badge('YOUR NOTIFICATIONS'),h('h2',state.unsubscribed?'A little quieter.':'Turn off this notification channel?'),h('p',state.unsubscribed?'You are unsubscribed. This link has turned off the channel it belongs to.':'Confirm to stop notifications for the channel included in this link. You do not need to sign in.').classes('muted'),alerts(),!state.unsubscribed?btn('Unsubscribe',{kind:'unsubscribe'},'button primary'):null);
  else if(route.kind==='device'){
    // LA3 supplies the HTTP redirect. Until then this retired review surface cannot make decisions.
    const id=/^[a-f0-9-]{36}$/.test(route.requestId??'')?route.requestId:null;
    content=h('div',h('h2','Approve a sign-in'),h('a','Continue').props({href:'/approve'+(id?'#r='+encodeURIComponent(id):'')}).classes('button','primary'));
  }else content=h('div',badge(route.emailLogin?'EMAIL SIGN-IN':'EMAIL VERIFICATION'),h('h2',state.emailConfirmed?'Email confirmed.':route.emailLogin?'Confirm your sign-in.':'Link this email to your account?'),h('p',route.emailLogin?'Continue only if you requested this sign-in link.':'Confirm only if you requested this email link for the account currently signed in.').classes('muted'),alerts(),!state.emailConfirmed?btn(route.emailLogin?'Confirm & sign in':'Confirm email link',{kind:'confirm-email'},'button primary',!route.emailLogin&&!state.session?.account):null,!route.emailLogin&&!state.session?.account?h('p','Sign in to the destination account before confirming this email link.').classes('security-note'):null);
  return h('div',h('header',logo(state),h('a','Back to my space').props({href:'/console'}).classes('button','secondary')).classes('landing-nav'),h('main',h('section',content).classes('auth-card')).classes('public-main'));
}
