/**
 * `@3sln/dodo/reactive` — the reactive module bound to dodo's default instance.
 *
 *     import {cell, watch} from '@3sln/dodo/reactive';
 *
 * `@3sln/dodo/context` is built with this exact `watch` injected, so the two
 * entry points render through one component.
 *
 * If you build your own dodo with `dodo(userSettings)`, or you want to replace
 * the scheduler or the error view, bake your own copy — and inject it into
 * `context` so the two stay one system:
 *
 *     import reactive from '@3sln/dodo/src/reactive.js';
 *     import context from '@3sln/dodo/src/context.js';
 *
 *     const {watch} = reactive({dodo: myDodo});
 *     const {withContext} = context({dodo: myDodo, reactive: {watch}});
 */
import * as dodo from './index.js';
import reactiveFactory from './src/reactive.js';

export * from './src/reactive.js';
export {default as reactive} from './src/reactive.js';
export {settings} from './src/settings.js';

export const {watch} = reactiveFactory({dodo});
