import { Provider, Action, Query } from '../../vendor/ngin/index.js';

export const contributionKinds = Object.freeze(['navigation','views','commands','settings','translations','contracts','routes','keybindings']);
const own = (object,key) => Object.hasOwn(object,key);
const order = (a,b) => (a.order??0)-(b.order??0) || a.module.localeCompare(b.module,'en') || a.id.localeCompare(b.id,'en');
function freeze(value) { if(value && typeof value==='object' && !Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value; }

// Modules are application code selected by the composition root. There is no
// discovery, downloaded code, lifecycle registry, eval or mutable install API.
export function compilePortalModules(modules=[]) {
  const byId=new Map();
  for(const module of modules){if(!module || typeof module.id!=='string' || !/^[a-z][a-z0-9.-]*$/.test(module.id))throw new TypeError('A module needs a stable id.');if(byId.has(module.id))throw new Error(`Duplicate portal module: ${module.id}`);if(!Array.isArray(module.dependencies??[])||(module.dependencies??[]).some(dep=>typeof dep!=='string')||new Set(module.dependencies??[]).size!==(module.dependencies??[]).length)throw new TypeError('Module dependencies must be distinct module ids.');byId.set(module.id,module);}
  const sorted=[],done=new Set();
  function visit(id,path=[]){if(done.has(id))return;if(path.includes(id))throw new Error(`Portal module dependency cycle: ${[...path,id].join(' -> ')}`);const module=byId.get(id);if(!module)throw new Error(`Missing portal module dependency: ${id}`);for(const dep of [...(module.dependencies??[])].sort())visit(dep,[...path,id]);done.add(id);sorted.push(module);}
  for(const id of [...byId.keys()].sort())visit(id);
  const buckets=Object.fromEntries(contributionKinds.map(kind=>[kind,[]]));
  for(const module of sorted){for(const kind of Object.keys(module.contributions??{})){if(!own(buckets,kind))throw new Error(`Unknown portal contribution kind: ${kind}`);for(const item of module.contributions[kind]){if(!item || typeof item.id!=='string'||!item.id)throw new TypeError(`A ${kind} contribution needs an id.`);if(buckets[kind].some(prior=>prior.id===item.id))throw new Error(`Duplicate ${kind} contribution: ${item.id}`);if(item.order!==undefined&&!Number.isFinite(item.order))throw new TypeError('Contribution order must be finite.');if(kind==='views' && typeof item.factory!=='function')throw new TypeError('A view needs a pure UI factory.');if(kind==='commands' && (typeof item.execute!=='function'||typeof item.capability!=='string'||!item.capability||!item.deps||typeof item.deps!=='object'))throw new TypeError('A command needs execute, declared deps and a capability.');if(kind==='routes' && (typeof item.action!=='function'||!(item.action.prototype instanceof Action)||typeof item.capability!=='string'||!item.capability||!['GET','POST','PUT','PATCH','DELETE'].includes(item.method)||typeof item.path!=='string'||!item.path.startsWith('/api/')))throw new TypeError('A backend route needs an Action, method, API path and a capability.');if(kind==='routes'&&buckets.routes.some(prior=>prior.method===item.method&&prior.path===item.path))throw new Error(`Duplicate backend route: ${item.method} ${item.path}`);buckets[kind].push({...item,module:module.id});}}}
  for(const items of Object.values(buckets))items.sort(order);
  const snapshot=freeze({modules:sorted.map(module=>({id:module.id,dependencies:[...(module.dependencies??[])]})),...buckets});
  return Object.freeze({snapshot:()=>snapshot,list:kind=>{if(!own(buckets,kind))throw new Error(`Unknown portal contribution kind: ${kind}`);return snapshot[kind];},get:(kind,id)=>{if(!own(buckets,kind))throw new Error(`Unknown portal contribution kind: ${kind}`);return snapshot[kind].find(item=>item.id===id);}});
}

export class PortalContributionsProvider extends Provider {
  static deps=[];
  constructor(){super();this.resource=compilePortalModules(this.constructor.modules??[]);}
  obtain(){return Promise.resolve(this.resource);}
  release(){}
}
export function portalContributionsProvider(modules){const resource=compilePortalModules(modules);return class ConfiguredPortalContributionsProvider extends Provider {static deps=[];obtain(){return Promise.resolve(resource);}release(){}};}
export class PortalContributions extends Query {
  static deps=['portalContributions'];
  constructor(kind){super();this.kind=kind;}
  fetch({portalContributions}){return this.kind?portalContributions.list(this.kind):portalContributions.snapshot();}
}

// The capability provider obtains an authority-narrowed handle before execute.
// The command never receives an engine or container. It cannot bypass leasing.
export class RunPortalCommand extends Action {
  constructor(registry,id,detail={}){super();const command=registry.get('commands',id);if(!command)throw new Error(`Unknown portal command: ${id}`);this.command=command;this.detail=detail;const declared=Array.isArray(command.deps)?Object.fromEntries(command.deps.map(name=>[name,{}])):command.deps;this.deps={...declared,portalAccess:{capability:command.capability,command:id}};}
  execute(resources,context){return this.command.execute(resources,this.detail,context);}
}
export function composePortalViews(registry,capabilities){if(!capabilities || typeof capabilities.t!=='function')throw new TypeError('Views need injected translation capability.');if(own(capabilities,'engine')||own(capabilities,'dispatch')||own(capabilities,'container'))throw new TypeError('UI capabilities cannot expose the engine.');const ui=Object.freeze({...capabilities});return Object.freeze(Object.fromEntries(registry.list('views').map(view=>{const render=view.factory(ui);if(typeof render!=='function')throw new TypeError(`View factory must return a renderer: ${view.id}`);return [view.id,render];})));}
export * from './keybindings.mjs';
