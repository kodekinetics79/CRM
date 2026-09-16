// Data residency and custody configuration for the persistence boundary.
//
// Addendum 2 §1(a)(iv) requires collected data to be stored in the United
// States or Canada. That amendment is later than the Q&A56 "North America or
// Europe" answer, so the narrower amendment governs here. Residency is
// configurable — a buyer may narrow it further — but it DEFAULTS to the US/CA
// profile and a configuration outside that profile has to be named explicitly
// and is refused outright under NODE_ENV=production.
//
// Configuration is not proof. Nothing in this module observes where a hosted
// provider actually stores bytes; it constrains what this software will accept
// and records what was asked for. Actual placement evidence is a deployment
// artefact the operator must obtain from the provider.

import {PERSISTENCE_CODES,persistenceFail} from './contract.js';
import {APPROVED_STORAGE_REGIONS} from '../objectStorage.js';

export const RESIDENCY_AUTHORITY='Addendum 2 §1(a)(iv) — collected data stored in the United States or Canada';

export const RESIDENCY_PROFILES=Object.freeze({
 'us-ca':Object.freeze({
  id:'us-ca',
  label:'United States or Canada',
  authority:RESIDENCY_AUTHORITY,
  countries:Object.freeze(['US','CA']),
  storageRegions:Object.freeze([...APPROVED_STORAGE_REGIONS]),
  databaseRegions:Object.freeze(['us-east-1','us-east-2','us-west-1','us-west-2','ca-central-1','ca-west-1'])
 }),
 'us-only':Object.freeze({
  id:'us-only',
  label:'United States only',
  authority:`${RESIDENCY_AUTHORITY} (narrowed by buyer configuration)`,
  countries:Object.freeze(['US']),
  storageRegions:Object.freeze(APPROVED_STORAGE_REGIONS.filter(r=>r.startsWith('us-'))),
  databaseRegions:Object.freeze(['us-east-1','us-east-2','us-west-1','us-west-2'])
 }),
 'ca-only':Object.freeze({
  id:'ca-only',
  label:'Canada only',
  authority:`${RESIDENCY_AUTHORITY} (narrowed by buyer configuration)`,
  countries:Object.freeze(['CA']),
  storageRegions:Object.freeze(APPROVED_STORAGE_REGIONS.filter(r=>r.startsWith('ca-'))),
  databaseRegions:Object.freeze(['ca-central-1','ca-west-1'])
 })
});

export const DEFAULT_RESIDENCY_PROFILE='us-ca';
export const CUSTODY_MODES=Object.freeze(['provider-managed-key','customer-managed-key','application-managed-key']);

const trimmed=value=>typeof value==='string'?value.trim():'';

/**
 * Resolve and validate a residency/custody configuration.
 *
 * @param {object} options
 * @param {string} [options.profile]          one of RESIDENCY_PROFILES; defaults to US/Canada
 * @param {string} options.databaseRegion     the region the database is configured for
 * @param {string} options.storageRegion      the region private object storage is configured for
 * @param {string} [options.custody]          key custody mode
 * @param {string} [options.endpoint]         non-AWS S3-compatible endpoint (local verification only)
 * @param {boolean} [options.residencyConfirmed] operator confirmation that placement was actually checked
 * @param {boolean} [options.production]      NODE_ENV==='production'
 */
export function resolveResidency({profile=DEFAULT_RESIDENCY_PROFILE,databaseRegion,storageRegion,custody='application-managed-key',endpoint=null,residencyConfirmed=false,production=process.env.NODE_ENV==='production'}={}){
 const selected=RESIDENCY_PROFILES[profile];
 if(!selected)persistenceFail(PERSISTENCE_CODES.INVALID,`Unknown data residency profile "${profile}". Configured profiles: ${Object.keys(RESIDENCY_PROFILES).join(', ')}.`);
 const database=trimmed(databaseRegion),storage=trimmed(storageRegion);
 if(!database||!storage)persistenceFail(PERSISTENCE_CODES.INVALID,'Data residency requires explicit database and storage regions; no region is inferred.');
 if(!selected.databaseRegions.includes(database))persistenceFail(PERSISTENCE_CODES.INVALID,`Database region "${database}" is outside the ${selected.label} residency profile required by ${selected.authority}.`);
 if(!selected.storageRegions.includes(storage))persistenceFail(PERSISTENCE_CODES.INVALID,`Storage region "${storage}" is outside the ${selected.label} residency profile required by ${selected.authority}.`);
 if(!CUSTODY_MODES.includes(custody))persistenceFail(PERSISTENCE_CODES.INVALID,`Key custody must be one of ${CUSTODY_MODES.join(', ')}.`);
 if(endpoint!==null&&endpoint!==undefined&&endpoint!==''){
  if(production)persistenceFail(PERSISTENCE_CODES.INVALID,'Production storage cannot use a custom endpoint; residency of a compatible endpoint is unverifiable from configuration.');
  let url;try{url=new URL(endpoint);}catch{persistenceFail(PERSISTENCE_CODES.INVALID,'Storage endpoint is invalid.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)persistenceFail(PERSISTENCE_CODES.INVALID,'Storage endpoint must be a credential-free HTTP(S) origin.');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname))persistenceFail(PERSISTENCE_CODES.INVALID,'A plaintext storage endpoint is only accepted on loopback for local verification.');
 }
 if(production&&residencyConfirmed!==true)persistenceFail(PERSISTENCE_CODES.INVALID,'Production requires an explicit operator confirmation that actual provider placement was checked against the residency profile.');
 return Object.freeze({
  profile:selected.id,
  label:selected.label,
  authority:selected.authority,
  countries:selected.countries,
  databaseRegion:database,
  storageRegion:storage,
  custody,
  endpoint:endpoint||null,
  residencyConfirmed:residencyConfirmed===true,
  // Deliberately explicit: this software constrains configuration. It does not
  // observe a provider's physical placement.
  placementProven:false,
  notice:'Residency configuration constrains what this deployment accepts. Actual provider placement evidence must be obtained separately from the hosting and storage providers.'
 });
}

export function residencyFromEnv(env=process.env){
 return resolveResidency({
  profile:env.DATA_RESIDENCY_PROFILE||DEFAULT_RESIDENCY_PROFILE,
  databaseRegion:env.DATABASE_REGION,
  storageRegion:env.DOCUMENT_STORAGE_REGION||env.AWS_REGION,
  custody:env.STORAGE_KEY_CUSTODY||'application-managed-key',
  endpoint:env.AWS_ENDPOINT_URL_S3||null,
  residencyConfirmed:env.DATA_RESIDENCY_CONFIRMED==='true',
  production:env.NODE_ENV==='production'
 });
}
