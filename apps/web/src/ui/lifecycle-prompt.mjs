import {h,helpers} from './release-primitives.mjs';

/** Server-derived account lifecycle prompt ("I'm still using it"). Shown only
 * when the server reports enforced suspension; the deadline is never computed here. */
export function lifecyclePrompt(state){
 const lifecycle=state.lifecycle;if(!lifecycle?.required)return null;const {btn}=helpers(state);
 const days=Number.isInteger(lifecycle.deadlineDays)&&lifecycle.deadlineDays>0?lifecycle.deadlineDays:null;
 const text=lifecycle.deletionScheduled===true?(days?`Action required, or your account will be deleted in ${days} days.`:'Action required: this unpaid account is suspended after a period without use.'):'Action required: this unpaid account is suspended after a period without use.';
 return h('section',
  h('h2','Are you still using this account?'),
  h('p',text),
  h('p','Your hosted data is kept while the account is suspended, but it cannot be used or changed until you reactivate it. Data in connected external storage is never deleted by this process.'),
  lifecycle.reauthenticate?h('p','For your security, sign in again, then confirm within 15 minutes.').attrs({role:'status'}):null,
  btn('I’m still using it',{kind:'reactivate-account'},'button primary')
 ).attrs({role:'region','aria-label':'Account status'}).classes('panel','lifecycle-prompt');
}
