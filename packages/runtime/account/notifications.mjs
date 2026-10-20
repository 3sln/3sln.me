// AccountController slice 10, Notifications, push, app connections and MCP account tools (docs/architecture/app-engine.md §12): notification preferences, push devices, app connections and MCP account operations.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {appNotificationCheck} from '../app-notifications.mjs';
import {mcpCollections as accountMcpCollections,mcpOperation as accountMcpOperation} from '../../mcp/account.mjs';

export const methods={
  async appConnections(owner){return this.apps.list(owner);},
  async appConnectionBinding(owner,clientId){return this.apps.binding(owner,clientId);},
  async appConnect(owner,client,expected){return this.apps.register(owner,client,expected);},
  async appBindleConnect(owner,client,expected,permissions={}){return this.apps.register(owner,client,expected,{transport:'bindle',notifications:permissions.notifications===true,expectedNotificationGeneration:permissions.expectedNotificationGeneration,provenance:{kind:'oauth-consent',issuer:this.config.APP_ORIGIN}});},
  async appDisconnect(owner,id){return this.apps.disconnect(owner,id);},
  async appNotificationSettings(owner,id,input){await this.warm(owner);return this.apps.notificationSettings(owner,id,input);},
  async appNotificationCheck(owner,connection,clientId){await this.warm(owner);return appNotificationCheck(this,owner,connection,clientId);},
  async appConnectionCheck(owner,id,generation,clientId){return this.apps.check(owner,id,generation,clientId);},
  async mcpCollections(owner){return accountMcpCollections(this,owner);},
  async mcpOperation(owner,clientId,tool,args,connection){await this.apps.check(owner,connection?.id,connection?.generation,clientId);return tool==='collections_list'?this.mcpCollections(owner):accountMcpOperation(this,owner,clientId,tool,args);},
  async notificationPreferences(owner,input,verifiedEmail){return input===undefined?this.notifications.preferences(owner):this.notifications.setPreferences(owner,input,{verifiedEmail});},
  async subscribe(owner,input){return this.notifications.subscribe(owner,input.subscription||input,input.label);},
  async removeSubscription(owner,id){return this.notifications.unsubscribeDevice(owner,id);},
  async unsubscribe(owner,token){return this.notifications.unsubscribe(token);},
  async unsubscribeLink(owner){return `${owner}.${await this.notifications.issueUnsubscribe(owner,'email')}`;},
};

export const rpc={
 notificationPreferences:{},
 subscribe:{},
 removeSubscription:{},
 unsubscribe:{lifecycle:'suspended'},
 unsubscribeLink:{},
 appConnections:{warm:true},
 appConnectionBinding:{warm:true},
 appConnect:{warm:true},
 appBindleConnect:{warm:true},
 appDisconnect:{warm:true},
 appNotificationSettings:{warm:true},
 appNotificationCheck:{warm:true},
 appConnectionCheck:{warm:true},
 mcpCollections:{},
 mcpOperation:{warm:true,activity:'resource-use'},
};
