// Tags domain (docs/architecture/tags.md): owner tag rules and the tag label
// registry. Migration slice 1 of docs/architecture/app-engine.md, with Views.
// The rules engine itself (packages/messaging/tags.mjs) stays pure; MessagingService
// owns the transactions, and this provider narrows it to one owner.
import {StorageError} from '../../storage/policy.mjs';
import {AppAction,AppQuery,OwnerScopedProvider} from '../engine.mjs';

export class TagRulesProvider extends OwnerScopedProvider {
 // accountStore is declared for the owner binding check in OwnerScopedProvider; MessagingService owns the transactions.
 static deps=['accountStore','messaging'];
 scope({messaging},owner){return {rules:()=>messaging.rules(owner),replace:rules=>messaging.setRules(owner,rules),remove:id=>messaging.deleteRule(owner,id),restoreDefault:id=>messaging.restoreDefaultRule(owner,id),labels:()=>messaging.tagLabels(owner),setLabel:input=>messaging.setTagLabel(owner,input)};}
}

/** The owner's rules. Not a pure read: the first read seeds the versioned defaults (one transaction, idempotent). */
export class TagRules extends AppQuery {
 static operation='rules.list';static deps=['tagRules'];static refreshOn=['rules-changed'];
 fetch({tagRules}){return tagRules.rules();}
}
/** `input`: {rules}. Replaces the whole list; server-owned default markers and revisions are re-stamped. */
export class ReplaceRules extends AppAction {
 static operation='rules.replace';static deps=['tagRules'];static changes='rules-changed';
 run({tagRules}){return tagRules.replace(this.input?.rules);}
}
/** `id`: the rule to remove, in one transaction. Returns the remaining rules. */
export class DeleteRule extends AppAction {
 static operation='rules.delete';static deps=['tagRules'];static changes='rules-changed';
 run({tagRules}){return tagRules.remove(this.id);}
}
/** `id`: a shipped default rule; restores its current definition and keeps the enabled choice. */
export class RestoreDefaultRule extends AppAction {
 static operation='rules.restore-default';static deps=['tagRules'];static changes='rules-changed';
 run({tagRules}){return tagRules.restoreDefault(this.id);}
}
export class TagLabels extends AppQuery {
 static operation='tags.labels';static deps=['tagRules'];static refreshOn=['tag-labels-changed'];
 fetch({tagRules}){return tagRules.labels();}
}
/** `input`: {id?, label, expectedRevision?}; `label: null` removes. Renaming never retags anything. */
export class SetTagLabel extends AppAction {
 static operation='tags.set-label';static deps=['tagRules'];static changes='tag-labels-changed';
 run({tagRules}){const input=this.input;if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','label','expectedRevision'].includes(k)))throw new StorageError('invalid_tag_label','Choose a tag label.');return tagRules.setLabel(input);}
}
export const TAG_PROVIDERS={tagRules:TagRulesProvider};
export const TAG_OPERATIONS=[TagRules,ReplaceRules,DeleteRule,RestoreDefaultRule,TagLabels,SetTagLabel];
