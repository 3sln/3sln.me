// Account placement composition shared by AccountController (Worker DO and Node) and the engine test
// harness, so both build the same domain providers over their own platform resources. Platform and effect
// resources are passed in; each migration slice appends its domain's provider map (one line).
import {VIEW_PROVIDERS} from './domains/views.mjs';
import {TAG_PROVIDERS} from './domains/tags.mjs';
import {ACTIVITY_PROVIDERS} from './domains/activity.mjs';
import {ACTIVITY_PUSH_PROVIDERS} from '../messaging/notifications.mjs';
export function accountProviders({accountStore,itemIndex,messaging,clock,random,audit}){
 return {accountStore,itemIndex,messaging,clock,random,audit,...VIEW_PROVIDERS,...TAG_PROVIDERS,...ACTIVITY_PROVIDERS,...ACTIVITY_PUSH_PROVIDERS};
}
