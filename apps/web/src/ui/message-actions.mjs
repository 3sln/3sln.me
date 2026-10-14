import {h,helpers,fire} from './release-primitives.mjs';
export function messageActionDialog(state){
 const m=state.modal,{btn}=helpers(state);if(m?.kind!=='message-action')return null;
 const review=state.messageActionReview;if(!review||!safeNavigationURL(review.url))return {title:'Message action expired',body:h('p','Open the message and try again.')};
 const action=m.actionKind==='link'?h('a','Open in new tab').props({href:safeNavigationURL(review.url).href,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'}).classes('button','primary'):m.available?h('button','Send once').props({type:'button',disabled:state.busy}).classes('button','primary').on({click:event=>fire(event.currentTarget,'submit-message-action',{id:m.id,nativeEvent:event})}):null;
 return {title:m.actionKind==='link'?'Open this message link?':'Review message submission',body:h('div',
  h('div',h('p','Destination'),h('p',h('bdi',review.url).attrs({translate:'no',dir:'ltr'})).classes('security-note')).classes('message-action-destination'),
  m.actionKind==='form'?h('div',h('p','These fields will be sent without your account cookies or login tokens.'),h('dl',...review.fields.flatMap(([name,value])=>[h('dt',h('bdi',name).attrs({translate:'no'})),h('dd',h('pre',value).attrs({translate:'no'}))])),!m.available?h('p','Form submission is unavailable for this message.').attrs({role:'status'}):null).classes('message-action-fields'):null,
  h('p','A response may update your local view. The original message remains available.').classes('field-help','message-action-footnote'),
  h('div',action,btn('Cancel',{kind:'close-modal'},'button secondary')).classes('message-action-buttons')
 ).classes('message-action-review')};
}

export function messageOutcomeView(state){const outcome=state.messageOutcome;if(!outcome)return null;const tone=['success','info','warning','error'].includes(outcome.toast?.type)?outcome.toast.type:outcome.type==='unknown'?'warning':'info';return h('section',outcome.toast?h('p',outcome.toast.message).attrs({translate:'no'}):outcome.type==='unknown'?h('p','The submission outcome is unknown. It will not be sent again.'):h('p','Submission completed.'),...(outcome.toast?.actions??[]).slice(0,2).map(action=>{const url=safeNavigationURL(action.href);if(!url||typeof action.label!=='string'||[...action.label].length>80)return null;return h('a',h('span',action.label).attrs({translate:'no'}),h('small',h('bdi',url.origin).attrs({translate:'no',dir:'ltr'}))).attrs({title:url.href}).props({href:url.href,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'}).classes('button','secondary');}),outcome.type==='redirect'&&typeof outcome.location==='string'?redirectLink(outcome.location):null).classes('submission-toast','submission-'+tone).attrs({role:tone==='error'?'alert':'status'});}

function redirectLink(value){try{const url=safeNavigationURL(value);if(!url)return null;return h('a',h('span','Open redirect in new tab'),h('small',h('bdi',url.origin).attrs({translate:'no',dir:'ltr'}))).props({href:url.href,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'}).attrs({title:url.href}).classes('button','secondary');}catch{return null;}}

function safeNavigationURL(value){if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f]/.test(value))return null;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url:null;}catch{return null;}}
