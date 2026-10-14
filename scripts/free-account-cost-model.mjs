#!/usr/bin/env node
// USD planning sensitivities, decimal GB; verified official prices 2026-10-13.
// No network or provider mutation. Values are assumptions, not measured traces.
import {pathToFileURL} from 'node:url';
const up=(usage,included,unit,price)=>Math.ceil(Number((Math.max(0,usage-included)/unit).toPrecision(14)))*price;
export function estimate({accounts=100000,averageGB,physicalMultiplier=1.1,requestsPerAccount,workerCpuMs=10,doFanout=4,doMs=50,r2Puts,r2Gets,doGB,d1GB,doWrites,d1Writes,doReads=0,d1Reads=0,semanticReserve=13.06}) {
 const inputs={accounts,averageGB,physicalMultiplier,requestsPerAccount,workerCpuMs,doFanout,doMs,r2Puts,r2Gets,doGB,d1GB,doWrites,d1Writes,doReads,d1Reads,semanticReserve};
 if(Object.values(inputs).some(value=>!Number.isFinite(value)||value<0))throw new TypeError('Nonnegative finite assumptions required.');
 const requests=accounts*requestsPerAccount,doRequests=requests*doFanout;
 const monthly={r2Storage:up(accounts*averageGB*physicalMultiplier,10,1,.015),r2Writes:up(r2Puts,1e6,1e6,4.5),r2Reads:up(r2Gets,10e6,1e6,.36),workers:5+Math.max(0,requests-10e6)/1e6*.3+Math.max(0,requests*workerCpuMs-30e6)/1e6*.02,durableRequests:up(doRequests,1e6,1e6,.15),durableDuration:up(doRequests*doMs/1000*.128,400000,1e6,12.5),durableStorage:up(doGB,5,1,.2),durableWrites:up(doWrites,50e6,1e6,1),durableReads:up(doReads,25e9,1e6,.001),d1Storage:up(d1GB,5,1,.75),d1Writes:up(d1Writes,50e6,1e6,1),d1Reads:up(d1Reads,25e9,1e6,.001),semanticPlanningReserve:semanticReserve};
 const total=Object.values(monthly).reduce((a,b)=>a+b,0);return {assumptions:inputs,monthly,totalMonthly:total,totalAnnual:total*12};
}
export function report(accounts=10000){
 const common={accounts},scale=accounts/100000;return {pricingDate:'2026-10-13',currency:'USD',freeSignupCap:10000,overallSignupCap:100000,warning:'Sensitivities, not measured traffic or invoice ceilings. Shared allowances assumed available; deployment has other workloads.',storageOnly:[1000,10000,100000].map(accounts=>({accounts,fullQuotaGB:accounts*.5,monthlyBeforeAllowances:accounts*.5*.015,annualBeforeAllowances:accounts*.5*.015*12})),scenarios:[
 {name:'Low utilization',...estimate({...common,averageGB:.005,requestsPerAccount:100,r2Puts:1e6*scale,r2Gets:10e6*scale,doGB:100*scale,d1GB:10*scale,doWrites:40e6*scale,d1Writes:10e6*scale})},
 {name:'Moderate activity',...estimate({...common,averageGB:.05,requestsPerAccount:1000,r2Puts:5e6*scale,r2Gets:100e6*scale,doGB:200*scale,d1GB:100*scale,doWrites:100e6*scale,d1Writes:20e6*scale})},
 {name:'Full storage and high activity',...estimate({...common,averageGB:.5,requestsPerAccount:10000,r2Puts:10e6*scale,r2Gets:1e9*scale,doGB:500*scale,d1GB:200*scale,doWrites:500e6*scale,d1Writes:100e6*scale})}
 ]};}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(report(),null,2));
