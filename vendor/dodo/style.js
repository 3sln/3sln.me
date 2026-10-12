/**
 * `@3sln/dodo/style` — shadow DOM scoping bound to dodo's default instance.
 *
 *     import {css, scoped} from '@3sln/dodo/style';
 *
 *     const styles = css`p { color: rebeccapurple; }`;
 *
 *     scoped({styleSheets: [styles]}, p('scoped, and unreachable from outside'))
 *
 * `css` has no dependency on dodo and is re-exported as-is. This module needs
 * no reactive API — nothing here re-renders on its own.
 */
import * as dodo from './index.js';
import styleFactory from './src/style.js';

export * from './src/style.js';
export {default as style} from './src/style.js';

export const {scoped, reconcileShadow, detachShadow} = styleFactory({dodo});
