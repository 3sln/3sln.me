// BB-B5: owner rules, copied from MessagingService and run over original delivery/automated evidence only.
import {MailboxAction,MailboxQuery,OwnerScopedProvider} from '../engine.mjs';
import {fault} from '../faults.mjs';
import {boundedString,validTagIds,isSuspectedTag,validateTagActions,seedDefaultRules,stampRules,applyRules} from './tags.mjs';
import {mailboxTransaction,incomingItem,organizationOf,saveOrganization} from '../store/item-index.mjs';
const RULES='bb:rules',DEFAULTS='bb:rule-defaults';
const validMatch=m=>m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).every(k=>['grantId','mimeType','collection','tagsAll','source'].includes(k))&&Object.entries(m).every(([k,v])=>k==='tagsAll'?validTagIds(v)&&v.length>0:k==='source'?['classifier','heuristic'].includes(v)&&Boolean(m.tagsAll?.some(isSuspectedTag)):boundedString(v));
export function validateActions(actions,{rule=false}={}){
 validateTagActions(actions,['tags','addTags','removeTags','classification','quarantined','collection',...rule?[]:['read']]);
 if(actions.collection!==undefined&&!boundedString(actions.collection))fault('invalid_actions');
 for(const k of ['quarantined','read'])if(actions[k]!==undefined&&typeof actions[k]!=='boolean')fault('invalid_actions');
}
export async function ownerRules(tx){
 const rules=await tx.get(RULES)??[],seeded=seedDefaultRules(rules,await tx.get(DEFAULTS));if(!seeded)return rules;
 await tx.put(RULES,seeded.rules);await tx.put(DEFAULTS,seeded.state);return seeded.rules;
}
export function createRulesProvider({BINDLEBOX_ENABLED=false}={}){
 return class RulesProvider extends OwnerScopedProvider {
  static deps=['mailboxStore','clock'];
  scope({mailboxStore:store,clock},owner){
   if(BINDLEBOX_ENABLED!==true)fault('not_found','BindleBox is disabled.',404);
   const transaction=fn=>mailboxTransaction(store,owner,BINDLEBOX_ENABLED,fn);
   return {list:()=>transaction(ownerRules),replace(input){
    const rules=structuredClone(input);if(!Array.isArray(rules)||rules.length>100)fault('invalid_rules');
    return transaction(async tx=>{const ids=new Set(),state=await tx.get(DEFAULTS);
     for(const r of rules){if(!r||!boundedString(r.id)||ids.has(r.id)||typeof r.enabled!=='boolean'||!validMatch(r.match))fault('invalid_rules');validateActions(r.actions,{rule:true});ids.add(r.id);}
     const stamped=stampRules(rules,state?await ownerRules(tx):[]);await tx.put(RULES,stamped);return state?stamped:ownerRules(tx);
    });
   },remove(id){if(!boundedString(id))fault('invalid_rules');return transaction(async tx=>{const rules=await ownerRules(tx),remaining=rules.filter(r=>r.id!==id);await tx.put(RULES,remaining);return remaining;});},restore(id){
    const fresh=seedDefaultRules([],null).rules.find(r=>r.id===id);if(!fresh)fault('not_found','Default rule not found.',404);
    return transaction(async tx=>{const rules=await ownerRules(tx),at=rules.findIndex(r=>r.id===id),prior=rules[at],next={...fresh,enabled:prior?.enabled??fresh.enabled,revision:(prior?.revision??0)+1};if(at>=0)rules[at]=next;else{if(rules.length>=100)fault('invalid_rules');rules.push(next);}await tx.put(RULES,rules);return next;});
   },apply(id){return transaction(async tx=>{const item=await incomingItem(tx,id),m=organizationOf(item),before=JSON.stringify(m);m.mimeType??=item.content?.mimeType;m.grantId??=item.jti;
    await applyRules(m,await ownerRules(tx),{now:clock.now()});if(JSON.stringify(m)===before)return m;
    if(m.quarantined)m.notification=null;m.organizationRevision++;return saveOrganization(tx,{...item,notification:m.notification},m);
   });}};
  }
 };
}
export class TagRules extends MailboxQuery {
 static operation='rules.list';static deps=['rules'];static refreshOn=['rules-changed'];
 fetch({rules}){return rules.list();}
}
export class ReplaceRules extends MailboxAction {
 static operation='rules.replace';static deps=['rules'];static changes='rules-changed';
 run({rules}){return rules.replace(this.input?.rules);}
}
export class DeleteRule extends MailboxAction {
 static operation='rules.delete';static deps=['rules'];static changes='rules-changed';
 run({rules}){return rules.remove(this.id);}
}
export class RestoreDefaultRule extends MailboxAction {
 static operation='rules.restore-default';static deps=['rules'];static changes='rules-changed';
 run({rules}){return rules.restore(this.id);}
}
export class ApplyRules extends MailboxAction {
 static operation='rules.apply';static deps=['rules'];static changes='incoming-changed';
 run({rules}){return rules.apply(this.id??this.input?.id);}
}
export const RULE_OPERATIONS=[TagRules,ReplaceRules,DeleteRule,RestoreDefaultRule,ApplyRules];
