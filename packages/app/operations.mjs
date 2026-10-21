// Wire registry of account-placement operations: the names the account single
// writer accepts through `AccountController.dispatch` and the engine CLI runs.
// Each migration slice appends its domain's list (one line); nothing else here changes.
import {operations} from './engine.mjs';
import {VIEW_OPERATIONS} from './domains/views.mjs';
import {TAG_OPERATIONS} from './domains/tags.mjs';
import {ACTIVITY_OPERATIONS} from './domains/activity.mjs';
export const ACCOUNT_OPERATIONS=operations(...VIEW_OPERATIONS,...TAG_OPERATIONS,...ACTIVITY_OPERATIONS);
