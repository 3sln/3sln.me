/**
 * `@3sln/dodo/animate` — enter/exit animation bound to dodo's default instance.
 *
 *     import {withPresence} from '@3sln/dodo/animate';
 *
 * `runAnimation` has no dependency on dodo and is re-exported as-is.
 *
 * If you build your own dodo with `dodo(userSettings)`, bake your own copy and
 * inject your own reactive API:
 *
 *     import reactive from '@3sln/dodo/src/reactive.js';
 *     import animate from '@3sln/dodo/src/animate.js';
 *
 *     const userSettings = {dodo: myDodo};
 *     const {withPresence} = animate({
 *       ...userSettings,
 *       reactive: reactive(userSettings),
 *     });
 */
import * as dodo from './index.js';
import animateFactory from './src/animate.js';
import {watch} from './reactive.js';

export * from './src/animate.js';
export {default as animate} from './src/animate.js';

export const {withPresence} = animateFactory({dodo, reactive: {watch}});
