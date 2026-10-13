import {DurableObject} from 'cloudflare:workers';
import {PlanCatalogRegistry,cachedCatalogPort,catalogFingerprint} from '../../packages/billing/registry.mjs';
export class PlanCatalogObject extends DurableObject{constructor(ctx,env){super(ctx,env);this.registry=new PlanCatalogRegistry({metadata:ctx.storage,config:env});}get(){return this.registry.get();}refresh(){return this.registry.refresh();}applyWebhook(event){return this.registry.applyWebhook(event);}resolveRefund(event){return this.registry.resolveRefund(event);}}
const ports=new Map();
export function workerCatalogPort(env){if(!env.PLAN_CATALOG)return;const key=catalogFingerprint(env);if(!ports.has(key)){if(ports.size>=16)ports.delete(ports.keys().next().value);ports.set(key,cachedCatalogPort(env.PLAN_CATALOG.get(env.PLAN_CATALOG.idFromName('polar-plan-catalog-v1'))));}return ports.get(key);}
