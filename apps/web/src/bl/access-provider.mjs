// CX-3 trusted composition seam. Never construct this from app-supplied descriptions.
import {createConsentProvider} from '../../../../packages/consent/model.mjs';
export function createAccessCatalog({registrableDomain,review,transition}={}){
 if(typeof registrableDomain!=='function')throw TypeError('Access views require a public-suffix-aware registrableDomain resolver.');
 return Object.freeze({review,transition,site(clientId){try{const host=new URL(clientId).hostname,site=registrableDomain(host);return typeof site==='string'&&(host===site||host.endsWith('.'+site))?site:null;}catch{return null;}},describe(facts,input){return createConsentProvider({...facts,registrableDomain}).grant(input);}});
}
