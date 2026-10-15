// Identity tile primitives shared by <bindle-monogram> and the avatar view: the
// per-subject tones of decision note §7.1 and the subject monogram cells. Colours
// and pattern come from islands-protocol (profile Appendix A), so islands and
// elements paint identical bytes (M6).
import {h} from '../../../../vendor/dodo/index.js';
import {monogramColors,monogramPattern} from '../islands-protocol.mjs';

// Per-subject tones for both schemes as custom properties; CSS picks the scheme.
export function identityStyle(subject){
  const light=monogramColors(subject,'light'),dark=monogramColors(subject,'dark');if(!light||!dark)return {};
  return {'--_id-bg-l':light.background,'--_id-fg-l':light.foreground,'--_id-bg-d':dark.background,'--_id-fg-d':dark.foreground};
}
export const monogramCells=subject=>(monogramPattern(subject)?.cells??[]).map(on=>h('span').classes('cell',on&&'on'));
// Shared tile rules: light-dark() follows the root's color-scheme live; engines
// without it use light tones, switched by the root's light/dark/auto class.
export const tileCss=`
.id-tile{box-sizing:border-box;border-radius:50%;overflow:hidden;flex:none;background:var(--_id-bg-l);background:light-dark(var(--_id-bg-l),var(--_id-bg-d));color:var(--_id-fg-l);color:light-dark(var(--_id-fg-l),var(--_id-fg-d))}
.id-tile .cell.on{background:var(--_id-fg-l);background:light-dark(var(--_id-fg-l),var(--_id-fg-d))}
@supports not (color:light-dark(#000,#fff)){
.root.dark .id-tile{background:var(--_id-bg-d);color:var(--_id-fg-d)}.root.dark .id-tile .cell.on{background:var(--_id-fg-d)}
@media (prefers-color-scheme:dark){.root.auto .id-tile{background:var(--_id-bg-d);color:var(--_id-fg-d)}.root.auto .id-tile .cell.on{background:var(--_id-fg-d)}}
}
.monogram-grid{display:grid;grid-template-columns:repeat(5,1fr);inline-size:100%;block-size:100%;padding:12.5%;box-sizing:border-box}
@media (forced-colors:active){.id-tile{background:Canvas;color:CanvasText;border:1px solid CanvasText}.id-tile .cell.on{background:CanvasText;forced-color-adjust:none}.id-tile .initials{color:CanvasText;forced-color-adjust:none}}
`;
