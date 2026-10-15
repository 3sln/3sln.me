// <bindle-monogram subject="…">: a deterministic, offline identity picture
// derived only from the approved subject URL. Nothing is fetched. Pattern and
// tones come from islands-protocol (profile Appendix A), shared with islands;
// the tile code (tile.mjs) loads on first render.
import {ElementBase,h,reconcileShadow,localize} from './shared.mjs';
import {css} from '../../../../vendor/dodo/style.js';
export {monogramPattern} from '../islands-protocol.mjs';

let tile=null;
const loadTile=()=>tile??=import('./tile.mjs');

export class BindleMonogramElement extends ElementBase {
  static observedAttributes=['subject','lang','theme','label'];
  #media=null;#tile=null;
  connectedCallback(){
    this.#media??=this.ownerDocument.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')??null;
    this.#media?.addEventListener?.('change',this.#rerender);this.render();
  }
  disconnectedCallback(){this.#media?.removeEventListener?.('change',this.#rerender);}
  attributeChangedCallback(){if(this.isConnected)this.render();}
  // Re-evaluates the effective scheme after an embedder theme change the element cannot observe.
  refreshTheme(){if(this.isConnected)this.render();}
  #rerender=()=>{if(this.isConnected)this.render();};
  render(){
    if(!this.#tile){loadTile().then(module=>{this.#tile=module;this.#rerender();});return;}
    const {identityStyle,monogramCells,tileCss}=this.#tile,subject=this.getAttribute('subject');
    const {t}=localize(this),view=this.ownerDocument.defaultView,theme=['light','dark'].includes(this.getAttribute('theme'))?this.getAttribute('theme'):'auto';
    // Auto inherits the embedder's color-scheme; an unset ('normal') value follows the OS preference.
    const inherited=theme==='auto'?view?.getComputedStyle?.(this)?.colorScheme:'';
    const scheme=theme!=='auto'?theme:!inherited||inherited==='normal'?'light dark':undefined;
    const tileView=h('span',h('span',...monogramCells(subject)).classes('monogram-grid')).classes('monogram','id-tile').attrs({role:'img','aria-label':this.getAttribute('label')||t('Identity picture'),part:'monogram'}).style(identityStyle(subject));
    reconcileShadow(this,[h('span',tileView).classes('root',theme).style(scheme?{'color-scheme':scheme}:{})],[css.in(view)`:host{display:inline-block}.root{display:contents}.monogram{display:inline-block;inline-size:var(--bindle-monogram-size,var(--bindle-avatar-size,32px));block-size:var(--bindle-monogram-size,var(--bindle-avatar-size,32px))}${tileCss}`]);
  }
}
