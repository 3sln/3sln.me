// AccountController slice 12, Automation (docs/architecture/app-engine.md §12): browser automation grants and
// tool calls. The methods live in packages/automation/account.mjs; `rpc` lists what `invoke` accepts.
import {automationMethods} from '../../automation/account.mjs';
export const methods=automationMethods;
export const rpc=Object.fromEntries(Object.keys(automationMethods).map(name=>[name,{}]));
