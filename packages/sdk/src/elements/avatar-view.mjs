// Standard avatar chain (components-profile §6.2, §7, §7.1): granted picture →
// initials → subject monogram, on one scheme-aware identity tile. Colours come
// from islands-protocol so islands and elements paint identical tones (M6).
import {h} from '../../../../vendor/dodo/index.js';
import {css} from '../../../../vendor/dodo/style.js';
import {identityStyle,monogramCells,tileCss} from './tile.mjs';
export {identityStyle,monogramCells,tileCss};
import {initials} from './initials.mjs';

const freeze=Object.freeze;
export function avatarModel(view,{pictureFailed=false}={}){
  const subject=view?.subject,profile=view?.profile??{};
  if(!pictureFailed&&typeof profile.picture==='string'&&profile.picture)return freeze({source:'picture',subject,picture:profile.picture});
  const text=initials(profile.displayName,profile.handle);
  return text?freeze({source:'initials',subject,text}):freeze({source:'monogram',subject});
}
export function avatarView(model,{label,onPictureError}={}){
  const a11y=label?{role:'img','aria-label':label}:{'aria-hidden':'true'};
  let content;
  if(model.source==='picture')content=h('img').attrs({src:model.picture,alt:'',referrerpolicy:'no-referrer',decoding:'async',loading:'lazy',part:'picture'}).on({error:()=>onPictureError?.()});
  else if(model.source==='initials')content=h('bdi',model.text).attrs({dir:'auto',part:'initials'}).classes('initials');
  else content=h('span',...monogramCells(model.subject)).classes('monogram-grid').attrs({part:'monogram'});
  return h('span',content).classes('avatar','id-tile',model.source).attrs({part:'avatar',...a11y}).style(identityStyle(model.subject));
}
export const avatarStyles=view=>css.in(view)`
.avatar{display:inline-grid;place-items:center;inline-size:var(--bindle-avatar-size,32px);block-size:var(--bindle-avatar-size,32px)}
.avatar img{inline-size:100%;block-size:100%;object-fit:cover;display:block}
.avatar .initials{unicode-bidi:isolate;font-family:system-ui,sans-serif;font-size:calc(var(--bindle-avatar-size,32px) * .4);font-weight:600;line-height:1;overflow:hidden;white-space:nowrap}
${tileCss}`;
