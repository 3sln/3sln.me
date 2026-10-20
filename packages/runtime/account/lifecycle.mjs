// AccountController slice 9, Lifecycle and retention (docs/architecture/app-engine.md §12). The methods live in
// packages/runtime/lifecycle-runner.mjs and own their gate: `invoke` runs them after the lifecycle fence,
// outside the account gate. Status and ticks stay reachable while purging; reactivation while suspended.
import {lifecycleMethods} from '../lifecycle-runner.mjs';
export const methods=lifecycleMethods;
export const rpc={
 lifecycleStatus:{lifecycle:'purging'},
 lifecycleReactivate:{lifecycle:'suspended'},
 lifecycleEverPaid:{lifecycle:'purging'},
 lifecycleTick:{lifecycle:'purging'},
};
