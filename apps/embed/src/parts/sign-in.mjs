// #sign-in (profile §6): one provider-labelled control that starts an island flow with intent `login`.
// P10: no storage access and no network request after the shell loads until a user activates it, so the worker
// starts lazily inside the flow. The label is a catalogue key chosen by props, never embedder text.
import {h,defined} from './dom.mjs';
import {signInLabels} from '../../../../packages/i18n/islands-catalogue.mjs';
export function signInPart({model,t,host,arming,startFlow}){
  const hooks=arming.guard(()=>startFlow());
  return Object.freeze({
    view:()=>h('button',h('span').classes('mark').attrs(defined({'aria-hidden':'true'})),h('span',t(signInLabels[model.props.label??'continue'],{host})).classes('label'))
      .classes('control','signin',model.props.variant==='outline'?'outline':'filled').attrs(defined({type:'button','aria-busy':model.flow?'true':'false'})).on(hooks),
    start(){},
    update(){},
  });
}
