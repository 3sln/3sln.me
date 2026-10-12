import { Action, Query } from '../shared/stack.mjs';
export class Account extends Query {
  static deps = ['api'];
  async boot({api}, {notify,engineFeed}) {
    let sequence = 0;
    this.refresh = async () => { const current=++sequence; try { const snapshot=await api.get(); if(current===sequence) notify({snapshot}); } catch(error) { if(current===sequence) notify({error:error.message}); } };
    this.feed=engineFeed;
    engineFeed.addEventListener('account-updated',this.refresh);
    await this.refresh();
  }
  kill() { this.feed.removeEventListener('account-updated',this.refresh); }
}
export class ChangeAccount extends Action {
  static deps=['api'];
  constructor(path,body) {super();this.path=path;this.body=body;}
  async execute({api},{engineFeed}) {await api.post(this.path,this.body);engineFeed.dispatchEvent(new Event('account-updated'));}
}
