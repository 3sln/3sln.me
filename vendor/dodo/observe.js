/**
 * `@3sln/dodo/observe` — element observation bound to dodo's default instance.
 *
 *     import {withElementSize, withVisibility} from '@3sln/dodo/observe';
 *
 * The cells (`elementSize`, `elementVisibility`, `elementIntersection`) have no
 * dependency on dodo and are re-exported as-is.
 *
 * If you build your own dodo with `dodo(userSettings)`, bake your own copy and
 * inject your own reactive API:
 *
 *     import reactive from '@3sln/dodo/src/reactive.js';
 *     import observe from '@3sln/dodo/src/observe.js';
 *
 *     const userSettings = {dodo: myDodo};
 *     const {withElementSize} = observe({
 *       ...userSettings,
 *       reactive: reactive(userSettings),
 *     });
 */
import * as dodo from './index.js';
import observeFactory from './src/observe.js';
import {watch} from './reactive.js';

export * from './src/observe.js';
export {default as observe} from './src/observe.js';

export const {withElementSize, withVisibility} = observeFactory({dodo, reactive: {watch}});
