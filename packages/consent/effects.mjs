import {AppQuery,operations} from '../app/engine.mjs';
import {fault} from '../app/faults.mjs';
export {createConsentProvider} from './model.mjs';
function enabled(config){if(config?.INCREMENTAL_AUTH_ENABLED!==true&&config?.INCREMENTAL_AUTH_ENABLED!=='true')fault('consent_disabled','Consent model is disabled.',404);}
export class ConsentMethod extends AppQuery {static operation='consent.method';static deps=['config','consent'];fetch({config,consent}){enabled(config);return consent.method(this.input);}}
export class ConsentContract extends AppQuery {static operation='consent.contract';static deps=['config','consent'];fetch({config,consent}){enabled(config);return consent.contract(this.input);}}
export class ConsentBus extends AppQuery {static operation='consent.bus';static deps=['config','consent'];fetch({config,consent}){enabled(config);return consent.bus(this.input);}}
export class ConsentGrant extends AppQuery {static operation='consent.grant';static deps=['config','consent'];fetch({config,consent}){enabled(config);return consent.grant(this.input);}}
export class ConsentModel extends AppQuery {static operation='consent.model';static deps=['config','consent'];fetch({config,consent}){enabled(config);return consent.model(this.input);}}
// Deliberately not ACCOUNT_OPERATIONS: no route, account RPC or UI is mounted.
export const CONSENT_OPERATIONS=operations(ConsentMethod,ConsentContract,ConsentBus,ConsentGrant,ConsentModel);
