// HTTP routes of slice 11, Beaming (docs/architecture/app-engine.md §12): beams, beam contacts, invites and the beam profile (packages/beaming/http.mjs).
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {beamRoutes,beamAllowedMethods} from '../../beaming/http.mjs';
import {json,body,accountHandle} from './shared.mjs';

export const allowedMethods=beamAllowedMethods;
// Withdrawing disclosure is protective (never refused for capacity); beam traffic other than invites is not admitted.
export const admission={
 protective:[
  {match:path=>path==='/api/profile',test:change=>change.discloseToContacts===false},
  {match:(path,method)=>method==='PUT'&&/^\/api\/contacts\/[^/]+\/beam$/.test(path),test:change=>change.beamEnabled===false||Array.isArray(change.profileFields)&&change.profileFields.length===0&&change.beamEnabled!==true},
 ],
 exempt:path=>path.startsWith('/api/beams/')&&!['/api/beams/invites','/api/beams/invites/redeem'].includes(path),
};
export const stages={
 async owner({request,env,url,path,owner,object}){
    const beamResponse=await beamRoutes({path,url,request,env,owner,object,accountHandle,body,json});if(beamResponse)return beamResponse;
 },
};
