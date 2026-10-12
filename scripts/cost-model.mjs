#!/usr/bin/env node
// Planning model, USD, decimal GB; official pricing snapshot 2026-10-12.
// No network, billing calls, or runtime policy changes. See docs/architecture/unit-economics.md.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const rates = Object.freeze({
  r2GB: .015, r2A: 4.5 / 1e6, r2B: .36 / 1e6,
  workerRequests: .3 / 1e6, workerCpuMs: .02 / 1e6,
  doRequests: .15 / 1e6, doGBSeconds: 12.5 / 1e6,
  sqlGB: .2, sqlReads: .001 / 1e6, sqlWrites: 1 / 1e6,
  neurons: .011 / 1000, neuronsPerToken: 1841 / 1e6,
  vectorQueriedDimensions: .01 / 1e6, vectorStoredDimensions: .05 / 1e8,
});
export const included = Object.freeze({
  r2GB: 10, r2A: 1e6, r2B: 10e6, workerRequests: 10e6,
  workerCpuMs: 30e6, doRequests: 1e6, doGBSeconds: 400000,
  sqlGB: 5, sqlReads: 25e9, sqlWrites: 50e6,
  vectorQueriedDimensions: 50e6, vectorStoredDimensions: 10e6,
});
const rounding = { r2GB: 1, r2A: 1e6, r2B: 1e6, doRequests: 1e6,
  doGBSeconds: 1e6, sqlGB: 1, sqlReads: 1e6, sqlWrites: 1e6 };
export const plans = { free: { gb: .5, annual: 0 }, plus: { gb: 5, annual: 5 }, pro: { gb: 100, annual: 30 } };
const profiles = {
  idle: { occupancy: 1, physicalMultiplier: 1.05, requests: [0,0,0], mutations: [0,0,0], sqlGB: [.002,.02,.2], vectors: [0,0,0], queries: [0,0,0], cpuMs: 0, doMs: 0 },
  typical: { occupancy: .2, physicalMultiplier: 1.1, requests: [1000,5000,20000], mutations: [100,500,2000], sqlGB: [.005,.03,.15], vectors: [1000,10000,50000], queries: [100,300,1000], cpuMs: 5, doMs: 20 },
  heavy: { occupancy: 1, physicalMultiplier: 1.1, requests: [10000,50000,200000], mutations: [1000,5000,20000], sqlGB: [.03,.15,1], vectors: [5000,25000,100000], queries: [1000,3000,10000], cpuMs: 10, doMs: 50 },
  abusive: { occupancy: 1, physicalMultiplier: 2, requests: [1e7,1e7,1e7], mutations: [1e7,1e7,1e7], sqlGB: [1,1,1], vectors: [1e6,1e6,1e6], queries: [1e6,1e6,1e6], cpuMs: 20, doMs: 0, alwaysActive: true },
};
export function usage(plan, profile, override = {}) {
  if (!plans[plan] || !profiles[profile]) throw new Error('Unknown plan or profile');
  const i = Object.keys(plans).indexOf(plan), p = profiles[profile];
  const s = { ...p, requests: p.requests[i], mutations: p.mutations[i], sqlGB: p.sqlGB[i], vectors: p.vectors[i], queries: p.queries[i], ...override };
  const u = {
    r2GB: plans[plan].gb * s.occupancy * s.physicalMultiplier,
    r2A: s.mutations * 2, r2B: s.requests * .4,
    workerRequests: s.requests, workerCpuMs: s.requests * s.cpuMs,
    doRequests: s.requests, doGBSeconds: s.alwaysActive ? 30 * 86400 * .128 : s.requests * s.doMs / 1000 * .128,
    sqlGB: s.sqlGB, sqlReads: s.requests * 100, sqlWrites: s.mutations * 12,
    neurons: ((s.embeddingDocuments ?? s.mutations) * (s.documentTokens ?? 256) + s.queries * (s.queryTokens ?? 32)) * rates.neuronsPerToken,
    vectorQueriedDimensions: (s.queries > 0 ? s.vectors + s.queries : 0) * 384,
    vectorStoredDimensions: s.vectors * 384,
  };
  for (const [key, value] of Object.entries(u)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid usage: ${key}`);
  return { assumptions: s, monthly: u };
}
const sum = values => values.reduce((a,b) => a+b, 0);
const positive = n => Math.max(0,n);
export function cost(u, allowances = false, aiActiveDays = 1) {
  if (!(aiActiveDays >= 1 && aiActiveDays <= 31)) throw new Error('aiActiveDays must be 1..31');
  const lineItems = Object.fromEntries(Object.entries(u).map(([key, value]) => {
    // AI total is concentrated evenly into aiActiveDays; unused daily allowance never rolls over.
    let billed = positive(value - (allowances ? key === 'neurons' ? 10000 * aiActiveDays : included[key] || 0 : 0));
    if (allowances && rounding[key]) billed = Math.ceil(Number((billed / rounding[key]).toPrecision(14))) * rounding[key];
    return [key, billed * rates[key]];
  }));
  return { monthly: sum(Object.values(lineItems)), lineItems };
}
export function netPayment(price, { internationalShare = 0, taxRate = 0 } = {}) {
  // Tax added above displayed price; merchant never treats collected tax as revenue.
  if (!price) return 0;
  return price - (price * (1 + taxRate) * (.05 + .015 * internationalShare) + .5);
}
export function account(plan, profile, override = {}) {
  const u = usage(plan, profile, override), c = cost(u.monthly);
  return { plan, profile, ...u, annualInfra: c.monthly * 12,
    annualLineItems: Object.fromEntries(Object.entries(c.lineItems).map(([k,v])=>[k,v*12])),
    annualNetReceipts: netPayment(plans[plan].annual),
    annualContribution: netPayment(plans[plan].annual) - c.monthly * 12 };
}
export function fleet(cohorts, options = {}) {
  const { aiActiveDays = 1, payoutsPerYear = 12, payoutActiveMonths = 12,
    internationalShare = 0, taxRate = 0, supportPerAccountYear = 0, otherAnnual = 0 } = options;
  for (const [key,value] of Object.entries({ payoutsPerYear,payoutActiveMonths,internationalShare,taxRate,supportPerAccountYear,otherAnnual })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid option: ${key}`);
  }
  if (internationalShare > 1 || payoutActiveMonths > 12) throw new Error('Invalid share/month count');
  const aggregate = Object.fromEntries(Object.keys(rates).filter(k=>k !== 'neuronsPerToken').map(k=>[k,0]));
  let net = 0, count = 0;
  for (const c of cohorts) {
    if (!Number.isSafeInteger(c.count) || c.count < 0) throw new Error('count must be a nonnegative integer');
    const u = usage(c.plan,c.profile,c.override);
    for (const [k,v] of Object.entries(u.monthly)) aggregate[k] += v*c.count;
    net += netPayment(plans[c.plan].annual,{internationalShare,taxRate})*c.count;
    count += c.count;
  }
  const invoice = cost(aggregate,true,aiActiveDays);
  const payout = net > 0 ? 2*payoutActiveMonths + .25*payoutsPerYear + .0025*net : 0;
  const annualInfra = 12*(5+invoice.monthly), support = count*supportPerAccountYear;
  return { cohorts, options, count, aggregateMonthlyUsage: aggregate, monthlyInfraLineItems: invoice.lineItems,
    annualNetReceipts: net, annualInfra, annualPayoutFees: payout, annualSupport: support,
    annualOther: otherAnnual, annualContribution: net-annualInfra-payout-support-otherAnnual };
}
export function launchPolicy() {
  const override = { occupancy: 1, vectors: 1000, queries: 500, embeddingDocuments: 1000, documentTokens: 512, queryTokens: 512 };
  const accounts = Object.keys(plans).map(plan => account(plan, 'typical', override));
  const semantic = a => ['neurons','vectorQueriedDimensions','vectorStoredDimensions'].reduce((n,k)=>n+a.annualLineItems[k],0);
  const previousPro = account('pro','typical',{occupancy:1});
  return { assumptions: 'Typical base activity at full storage; semantic meters at per-owner launch maxima; monthly document attempts remain conservatively saturated even after lifetime upsert reservations exhaust. Extra budget-authority SQL/DO overhead must be measured.',
    limits: { ownerLifetimeUpsertAttempts: 1000, ownerMonthlyDocumentEmbeddingAttempts: 1000, ownerMonthlyQueries: 500, excerptBytes: 480, reservedTokensPerEmbedding: 512, globalOwners: 1000, globalLifetimeUpserts: 2000000, globalMonthlyEstimatedUSD: 5, globalDailyEstimatedUSD: .5 },
    accounts, annualDirectSemanticPerOwner: semantic(accounts[0]),
    annualDirectSemanticPreviousPro: semantic(previousPro),
    annualDirectSemanticProSavings: semantic(previousPro)-semantic(accounts[2]),
    // Existing stock costs recur even with admission paused; do not confuse $5 work admissions with an invoice cap.
    globalMonthlyMarginalSemanticEstimateAtOneMillionStored: 5 + 1000000*384*rates.vectorQueriedDimensions + 1000000*384*rates.vectorStoredDimensions,
    globalMonthlyMarginalSemanticEstimateAtTwoMillionStored: 5 + 2000000*384*rates.vectorQueriedDimensions + 2000000*384*rates.vectorStoredDimensions };
}
export function report() {
  const accounts = Object.keys(plans).flatMap(p=>Object.keys(profiles).map(s=>account(p,s)));
  const ratios = ['typical','heavy'].map(profile=>{
    const free = account('free',profile).annualInfra;
    return { profile, freeAnnualCost:free, plusFreeAccountsAtZeroMargin:positive(account('plus',profile).annualContribution)/free,
      proFreeAccountsAtZeroMargin:positive(account('pro',profile).annualContribution)/free,
      plusFreeAccountsAtHalfContribution:positive(account('plus',profile).annualContribution)/free/2,
      proFreeAccountsAtHalfContribution:positive(account('pro',profile).annualContribution)/free/2 };
  });
  const cohorts = [{plan:'free',profile:'typical',count:1000},{plan:'plus',profile:'typical',count:100},{plan:'pro',profile:'typical',count:20}];
  return { pricingDate:'2026-10-12', currency:'USD', launchPolicy: launchPolicy(), rates, included, rounding, accounts, fullOccupancyTypical: Object.keys(plans).map(p=>account(p,'typical',{occupancy:1})), ratios,
    fleets: [fleet(cohorts),fleet(cohorts,{supportPerAccountYear:.25,otherAnnual:120}),
      fleet(cohorts.map(c=>({...c,profile:'heavy'}))), fleet([{plan:'free',profile:'heavy',count:10000}])] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arg = process.argv[2];
    const out = !arg ? report() : (()=>{const input=JSON.parse(readFileSync(arg,'utf8'));return fleet(input.cohorts,input.options);})();
    console.log(JSON.stringify(out,null,2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
