// HTTP routes of slice 5, Conversations (docs/architecture/app-engine.md §12): public conversation endpoints and owner conversations (packages/conversations/http.mjs).
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {publicConversationRoutes,ownerConversationRoutes,conversationAllowedMethods} from '../../conversations/http.mjs';
import {json,body,limit,accountHandle} from './shared.mjs';

export const allowedMethods=conversationAllowedMethods;
// Conversation writes are not admitted against the activity budget.
export const admission={exempt:path=>path.startsWith('/api/conversations')};
export const stages={
 async public({request,env,execution}){
   const conversationPublic=await publicConversationRoutes(request,env,{account:accountHandle,body,json,limit,execution});if(conversationPublic)return conversationPublic;
 },
 async owner({request,env,id}){
    const conversationOwner=await ownerConversationRoutes(request,env,{owner:id,account:accountHandle,body,json});if(conversationOwner)return conversationOwner;
 },
};
