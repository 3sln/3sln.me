import {h,icon,badge,pageHeader,helpers,interfaceText} from './release-primitives.mjs';

// Account limits are decimal bytes throughout the service and this surface.
export function formatStorage(bytes,locale='en'){
 const value=Math.max(0,Number(bytes)||0),units=['B','kB','MB','GB','TB'];
 const exponent=value?Math.min(4,Math.floor(Math.log10(value)/3)):0;
 return `${new Intl.NumberFormat(locale,{maximumFractionDigits:exponent?2:0}).format(value/(1000**exponent))} ${units[exponent]}`;
}
export const formatAnnualPrice=(cents,currency,locale='en')=>new Intl.NumberFormat(locale,{style:'currency',currency:currency??'USD',maximumFractionDigits:Number(cents)%100?2:0}).format(Number(cents)/100);
export function storageMeter(state,{compact=false}={}){
 const storage=state.data?.storage;if(!storage)return null;
 const {btn}=helpers(state),used=formatStorage(storage.usedBytes,state.locale),limit=formatStorage(storage.storageBytes,state.locale);
 const meter=h('meter').props({min:0,max:Math.max(1,storage.storageBytes),value:Math.min(storage.storageBytes,storage.usedBytes)}).attrs({'aria-label':'Account storage used'}).classes('storage-meter',storage.overLimit?'over-limit':'');
 if(compact)return btn([h('span','Storage').classes('storage-label'),h('strong',interfaceText('{used} of {limit}',{used,limit})),meter,storage.overLimit?badge('Over storage limit','warning'):null],{kind:'navigate',view:'billing'},'sidebar-storage');
 return h('div',h('div',h('div',h('span','ACCOUNT STORAGE').classes('eyebrow'),h('h2',interfaceText('{used} used',{used})),h('p',interfaceText('of {limit} available on your plan',{limit})).classes('muted')),badge(storage.overLimit?'Over storage limit':'Current usage',storage.overLimit?'warning':'good')).classes('storage-summary'),meter,h('p',interfaceText('{remaining} available · {reserved} reserved for uploads',{remaining:formatStorage(storage.remainingBytes,state.locale),reserved:formatStorage(storage.reservedBytes??storage.pendingUploadBytes,state.locale)})).classes('field-help')).classes('usage-overview');
}
export default function billingView(state){
 const {btn}=helpers(state),storage=state.data?.storage,billing=state.billing;
 const enabled=billing?.enabled===true&&billing?.configured===true&&!state.offline,currentPlan=billing?.plan??storage?.plan??'free';
 const plans=billing?.plans??[];
 const subscription=billing?.subscription;
 const subscriptionStatus={active:'Active',canceled:'Canceled',past_due:'Payment overdue',unpaid:'Payment overdue',trialing:'Trial',incomplete:'Awaiting payment'}[subscription?.status]??'Pending confirmation';
 return h('div',pageHeader('Storage & billing','A little room now. More room when you need it.',btn([icon('rules'),'Refresh status'],{kind:'load-billing'},'button secondary',state.billingLoading||state.offline)),
  storage?h('section',storageMeter(state),storage.overLimit?h('p','Your space is full. You can still read, export, and delete your content. Remove some content or choose more storage to add new items.').classes('alert','warning').attrs({role:'status'}):null,h('div',...[
   ['Messages',storage.messagesBytes,storage.messageCount],['Hosted files',storage.objectsBytes,storage.objectCount]
  ].map(([title,bytes,count])=>h('div',icon(title==='Messages'?'inbox':'storage'),h('div',h('span',title),h('strong',formatStorage(bytes,state.locale)).attrs({translate:'no'}),h('small',interfaceText('{count} items',{count:new Intl.NumberFormat(state.locale).format(count??0)})))))).classes('storage-breakdown'),h('p','Your account allowance includes messages and files hosted here. Files at external providers do not use this allowance. Search indexes and service operating budgets are accounted for separately.').classes('storage-explanation')).classes('panel','storage-panel'):h('p','Storage information is unavailable. Refresh status to try again.').classes('alert'),
  h('section',h('div',h('h2','Room to grow'),h('p','Annual plans. Straightforward storage.').classes('muted')).classes('billing-section-heading'),
   state.billingLoading?h('p','Loading plans…').attrs({role:'status'}):null,
   state.billingError?h('p',state.billingError).attrs({role:'alert'}).classes('alert','error'):null,
   !enabled&&!state.billingLoading?h('p','Paid plans are not available on this service yet. Your current storage remains available.').attrs({role:'status'}).classes('billing-availability'):null,
   h('div',...plans.map(plan=>h('article',h('div',h('h3',plan.name),plan.id===currentPlan?badge('Your plan','good'):null).classes('plan-heading'),h('p',formatStorage(plan.storageBytes,state.locale)).attrs({translate:'no'}).classes('plan-capacity'),h('p',plan.annualAmount?interfaceText('{amount} / year',{amount:formatAnnualPrice(plan.annualAmount,plan.currency,state.locale)}):'Free').classes('plan-price'),h('p',plan.id==='free'?'A personal home to start with.':plan.id==='plus'?'More room for everyday life.':'Space for your growing collection.').classes('muted'),btn(plan.id===currentPlan?'Current plan':plan.id==='free'?'Included with your account':currentPlan==='free'?'Choose plan':'Manage plan',{kind:currentPlan==='free'?'billing-checkout':'billing-portal',plan:plan.id},plan.id==='plus'?'button primary full':'button secondary full',!enabled||plan.id==='free'||plan.id===currentPlan),!enabled&&plan.id!=='free'?h('small','Available when paid plans launch.').classes('field-help'):null).classes('panel','plan-card',plan.id==='plus'?'featured-plan':'').key(plan.id))).classes('plans-grid'),
   !plans.length&&!state.billingLoading?h('p','Plan information is unavailable. Refresh status to try again.').classes('field-help'):null,
   subscription?h('dl',h('div',h('dt','Subscription status'),h('dd',subscriptionStatus)),Number.isFinite(subscription.validUntil)?h('div',h('dt','Current allowance until'),h('dd',new Intl.DateTimeFormat(state.locale,{dateStyle:'medium'}).format(subscription.validUntil)).attrs({translate:'no'})):null,subscription.cancelAtPeriodEnd?h('div',h('dt','Renewal'),h('dd','Ends after the current period')):null).classes('billing-subscription'):null,
   h('div',h('p','If your plan ends, your allowance returns to the free plan. Your existing content stays safe; adding new content pauses if it exceeds the allowance.').classes('field-help'),btn('Manage subscription',{kind:'billing-portal'},'button secondary',!enabled||currentPlan==='free'),h('p','Payments and subscription changes open securely with Polar. Your plan updates after the service confirms the change.').classes('field-help')).classes('billing-management'))
 ).classes('billing-view');
}
