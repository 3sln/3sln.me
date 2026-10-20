// HTTP routes of slice 12, Automation (docs/architecture/app-engine.md §12): browser automation tools, grants and invocations (packages/automation/http.mjs).
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {automationRoutes,automationAllowedMethods} from '../../automation/http.mjs';
import {json,body} from './shared.mjs';

export const allowedMethods=automationAllowedMethods;
export const stages={
 async beforeActivity({request,path,owner,object}){
    const automationResponse=await automationRoutes({path,request,owner,object,body,json});if(automationResponse)return automationResponse;
 },
};
