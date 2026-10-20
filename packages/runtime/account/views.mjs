// AccountController slice 1, Views and tags (docs/architecture/app-engine.md §12): views, incoming, tag rules and labels (engine facades).
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {SavedViews,CreateView,UpdateView,DeleteView,IncomingPage,UpdateIncoming} from '../../app/domains/views.mjs';
import {TagRules,ReplaceRules,RestoreDefaultRule,TagLabels,SetTagLabel} from '../../app/domains/tags.mjs';

export const methods={
  // Compatibility facades over the engine (existing callers and tests); routes use `dispatch`.
  async listViews(owner){return this.dispatch(owner,{operation:SavedViews.operation});},
  async createView(owner,input){return this.dispatch(owner,{operation:CreateView.operation,input});},
  async updateView(owner,id,input){return this.dispatch(owner,{operation:UpdateView.operation,id,input});},
  async deleteView(owner,id,input){return this.dispatch(owner,{operation:DeleteView.operation,id,input});},
  async updateIncoming(owner,input){return this.dispatch(owner,{operation:UpdateIncoming.operation,input});},
  async queryIncoming(owner,input={}){return this.dispatch(owner,{operation:IncomingPage.operation,input});},
  async tagLabels(owner){return this.dispatch(owner,{operation:TagLabels.operation});},
  async setTagLabel(owner,input){return this.dispatch(owner,{operation:SetTagLabel.operation,input});},
  async restoreDefaultRule(owner,id){return this.dispatch(owner,{operation:RestoreDefaultRule.operation,id});},
  async rules(owner,rules){return this.dispatch(owner,rules===undefined?{operation:TagRules.operation}:{operation:ReplaceRules.operation,input:{rules}});},
};

export const rpc={
 tagLabels:{},
 setTagLabel:{},
 restoreDefaultRule:{},
 rules:{},
 listViews:{},
 createView:{},
 updateView:{},
 deleteView:{},
 queryIncoming:{},
 updateIncoming:{},
};
