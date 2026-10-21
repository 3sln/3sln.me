// Node egress for client-id-metadata.v1. It reuses the reviewed presentation-metadata adapter
// (packages/apps/node-metadata-fetch.mjs): globally routable IPv4 only, the resolved address pinned to the actual
// HTTPS connection with original-hostname TLS verification, port 443, GET, no compression, no redirects (any
// status other than 200/404/410 is refused) and a bounded body and deadline. Each call scopes that adapter to the one client_id origin;
// fleet budgets, caching and the block list live in ClientDirectory.
import {createNodeMetadataFetch} from '../apps/node-metadata-fetch.mjs';
import {CLIENT_METADATA_LIMITS} from './client-metadata.mjs';
export function createNodeClientMetadataFetch({lookup,request,timeoutMs=1500,maxBytes=CLIENT_METADATA_LIMITS.maxBytes}={}){
 return async function clientMetadataFetch(url,{signal}={}){
  const origin=new URL(url).origin,fetchOne=createNodeMetadataFetch({allowedOrigins:[origin],timeoutMs,maxBytes,maxConcurrent:1,maxRequestsPerMinute:1,maxRequestsPerDay:1,...lookup?{lookup}:{},...request?{request}:{}});
  return fetchOne(url,{method:'GET',headers:{Accept:'application/manifest+json, application/json'},signal});
 };
}
