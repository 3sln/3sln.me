/**
 * `@3sln/dodo/context` — the context module bound to dodo's default instance.
 *
 *     import {withContext, useContext} from '@3sln/dodo/context';
 *
 * Built with `@3sln/dodo/reactive`'s `watch` injected, so the components here
 * and that module's `watch` are one system. Import `watch` itself from
 * `@3sln/dodo/reactive`.
 *
 * If you build your own dodo with `dodo(userSettings)`, bake your own copy and
 * inject your own reactive API:
 *
 *     import reactive from '@3sln/dodo/src/reactive.js';
 *     import context from '@3sln/dodo/src/context.js';
 *
 *     const userSettings = {dodo: myDodo};
 *     const {withContext, useContext} = context({
 *       ...userSettings,
 *       reactive: reactive(userSettings),
 *     });
 */
import * as dodo from './index.js';
import contextFactory from './src/context.js';
import {watch} from './reactive.js';

export {default as context} from './src/context.js';
export {settings} from './src/settings.js';

export const {
  withContext,
  withEncapsulatedContext,
  useContext,
  contextCell,
  readContext,
  attachContext,
  updateContext,
  detachContext,
} = contextFactory({dodo, reactive: {watch}});
