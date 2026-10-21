// BRIDGE internal account RPCs. Entitlement and occupancy are checked again at delivery, under the account gate.
import {bridgeConfig} from '../../email-bridge/engine.mjs';
import {INTAKE_SLOT,INTAKE_CONTRACT} from '../../email-bridge/wire.mjs';
import {StorageError} from '../../storage/policy.mjs';
const down=()=>{throw new StorageError('recipient_unavailable','The recipient is unavailable.',503);};
export const methods={
 async emailBridgeEntitled(owner){
  if(!bridgeConfig(this.config).enabled||await this.metadata.get('owner')!==owner)return false;
  const account=await this.config.IDENTITY_ACCOUNT?.(owner);if(account?.status!=='active')return false;
  const e=await this.billing.entitlement(owner);return ['paid','plus','ultra'].includes(e.plan)&&e.provisional!==true&&e.validUntil>Date.now();
 },
 async integrationsIntakeSeat(owner){
  if(!await this.emailBridgeEntitled(owner)||![true,'true'].includes(this.config.INTEGRATIONS_ENABLED)||![true,'true'].includes(this.config.BROKERING_ENABLED))return null;
  const found=await this.connectionsSystem(owner,{operation:'connections.occupant',input:{slot:INTAKE_SLOT}});
  if(found.sever||found.selection!=='exclusive'||found.occupants.length!==1)return null;
  const s=found.occupants[0],{records}=await this.integrationsSystem(owner,{operation:'integrations.records'}),r=records.find(r=>r.id===s.resource&&r.connection===s.connection&&r.clientId===s.clientId&&r.available&&r.assignments.some(a=>a.binding.slot===INTAKE_SLOT&&a.consumer.feature==='email-bridge'&&a.contracts.includes(INTAKE_CONTRACT)));
  return r?{id:`${s.cnx}/${r.id}`,seat:s.seat,cnx:s.cnx,connection:s.connection,clientId:s.clientId,generation:s.generation,record:r.id,resource:r.resource}:null;
 },
 async integrationsIntakeDeliver(owner,{seat,body}={}){
  const live=await this.integrationsIntakeSeat(owner);if(!live||!seat||Object.keys(live).some(k=>live[k]!==seat[k]))down();
  return this.integrationsSystem(owner,{operation:'integrations.intake-deliver',input:{seat:live,body}});
 },
};
export const rpc={emailBridgeEntitled:{},integrationsIntakeSeat:{},integrationsIntakeDeliver:{}};
