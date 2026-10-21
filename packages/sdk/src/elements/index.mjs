// Element classes and an explicit definer. No side effects on import, so this
// module is safe to import under SSR; define.mjs is the auto-defining entry.
import {registry} from './shared.mjs';
import {BindleSessionElement} from './session.mjs';
import {BindleSignInElement} from './sign-in.mjs';
import {BindleAccountElement} from './account.mjs';
import {BindleAvatarElement} from './avatar.mjs';
import {BindleMonogramElement} from './monogram.mjs';
import {BindleRequestElement} from './request.mjs';

export {BindleSessionElement,BindleSignInElement,BindleAccountElement,BindleAvatarElement,BindleMonogramElement,BindleRequestElement};
// Theme token probing is a separate entry: elements/theme-probe.mjs.
export {monogramPattern} from './monogram.mjs';

const elements=[['session',BindleSessionElement],['sign-in',BindleSignInElement],['account',BindleAccountElement],['avatar',BindleAvatarElement],['monogram',BindleMonogramElement],['request',BindleRequestElement]];
// Skips names that are already defined, so two copies on one page are harmless
// (the first wins). A custom prefix defines fresh subclasses.
export function defineBindleElements({prefix='bindle',registry:elementRegistry=globalThis.customElements}={}){
  if(!elementRegistry)return [];
  if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(prefix))throw new Error('Invalid custom element prefix.');
  const defined=[];
  registry.sessionTags.add(`${prefix}-session`);
  // The session controller is defined first so descendants find it on upgrade.
  for(const [suffix,element] of elements){
    const name=`${prefix}-${suffix}`;if(elementRegistry.get(name))continue;
    elementRegistry.define(name,prefix==='bindle'?element:class extends element {});defined.push(name);
  }
  return defined;
}
