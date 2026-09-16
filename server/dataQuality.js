import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {isPersonConstituent} from '../shared/constituentTypes.js';
import {createAiProvider,detectInjection,sanitizeUntrustedText} from './ai.js';

// Phase 9 differentiation. Everything here PROPOSES and never ACTS.
//
// 1. Duplicate detection returns candidate pairs with the exact evidence that
//    produced them. It never merges, never rewrites a record and never removes a
//    blocker. A person and an organization are never proposed as one identity,
//    and retained protected history blocks a proposal rather than hiding it.
// 2. Stewardship indicators and next-best actions are recomputed from live
//    records on every request. Nothing is cached, and a finding whose cited
//    record version moved is withdrawn rather than shown stale.
// 3. Grant and pledge follow-ups restate recorded deadlines, commitments and
//    exact integer-cent balances. No date or amount is invented; a derived date
//    names the recorded fields it was derived from.
// 4. Report narratives are composed by a deterministic local provider from
//    verified facts, and refused rather than approximated when a cited figure
//    cannot be re-verified against the saved records.
// 5. Constituent-supplied text is untrusted data. It reaches no instruction
//    channel, and text that looks like an instruction is reported by field and
//    pattern name without echoing the text back to any reader.
const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const stamp=()=>new Date().toISOString();
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:null;
const isPostedGift=g=>g.status!=='Voided'&&g.type!=='Fee payment'&&g.type!=='In-kind';
const uuidish=z.string().min(1).max(100);
export const DATA_QUALITY_LIMITS={constituents:20000,bucket:50,comparisons:40000,candidates:200,findings:200,narrativeSources:500,reviewHistory:200,reason:500};
export const DATA_QUALITY_NARRATIVES=['giving-summary','grant-pipeline','pledge-balances'];
const FINDING_KINDS=['duplicate','stewardship','followup','quality'];

// ---- deterministic normalisation (explainable, no fuzzy scoring) -----------
const fold=value=>String(value??'').normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const PERSON_NOISE=new Set(['mr','mrs','ms','miss','mx','dr','prof','rev','sir','jr','sr','ii','iii','iv','md','phd','esq']);
const ORG_NOISE=new Set(['the','inc','incorporated','llc','llp','ltd','limited','co','corp','corporation','company']);
export function normalizeName(value,person=true){
 const words=fold(value).replace(/&/g,' and ').replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(Boolean);
 const kept=words.filter(word=>!(person?PERSON_NOISE:ORG_NOISE).has(word));
 return (kept.length?kept:words).join(' ');
}
export const normalizeNameOrder=(value,person=true)=>normalizeName(value,person).split(' ').filter(Boolean).sort().join(' ');
export function normalizeEmail(value){
 const raw=String(value??'').trim().toLowerCase();
 const match=/^([^@\s]{1,64})@([^@\s]{1,190}\.[a-z0-9-]{2,24})$/.exec(raw);
 if(!match)return '';
 const local=match[1].split('+')[0].replace(/\.+$/,'');
 return local?local+'@'+match[2]:'';
}
export function normalizePhone(value){
 let digits=String(value??'').replace(/\D+/g,'');
 if(digits.length===11&&digits.startsWith('1'))digits=digits.slice(1);
 return digits.length>=10?digits.slice(-10):'';
}
const STREET={st:'street',str:'street',ave:'avenue',av:'avenue',rd:'road',dr:'drive',ln:'lane',blvd:'boulevard',ct:'court',cir:'circle',pl:'place',hwy:'highway',pkwy:'parkway',ste:'suite',apt:'apartment',apartment:'apartment',unit:'apartment',n:'north',s:'south',e:'east',w:'west',ne:'northeast',nw:'northwest',se:'southeast',sw:'southwest'};
export function normalizeAddress(value){
 return fold(value).replace(/#/g,' apartment ').replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(Boolean).map(word=>STREET[word]||word).join(' ');
}

// Untrusted record text shown to a reviewer. Instruction-like text is withheld
// rather than echoed, so a flagged record cannot use this surface as a channel.
const WITHHELD='[withheld: this saved text contains instruction-like content; open the record to review it]';
// The product's own {{mergeField}} placeholders are an approved template form,
// not injected instructions. An external link alone is noted but is not a
// finding. Everything else that reads like an instruction is reported.
const MERGE_FIELD=/\{\{\s*[A-Za-z][A-Za-z0-9]{0,40}\s*\}\}/g;
const scan=value=>detectInjection(String(value??'').replace(MERGE_FIELD,' merge field ')).filter(name=>name!=='external-link');
function untrusted(value,limit=120){
 const patterns=scan(value);
 const display=sanitizeUntrustedText(value,limit).replace(/[^\p{L}\p{N} .,'’&()/@:+-]+/gu,' ').replace(/\s+/g,' ').trim();
 return {value:patterns.length?WITHHELD:display,untrusted:true,withheld:patterns.length>0,patterns};
}
const safeLabel=value=>sanitizeUntrustedText(value,120).replace(/[^\p{L}\p{N} .,'’&()/-]+/gu,' ').replace(/\s+/g,' ').trim();
const ref=(collection,record)=>({collection,id:record.id,version:record.version});
const orderSources=sources=>{
 const seen=new Set(),out=[];
 for(const source of sources){if(!source?.id)continue;const key=source.collection+':'+source.id+':'+source.version;if(seen.has(key))continue;seen.add(key);out.push(source);}
 return out.sort((a,b)=>a.collection.localeCompare(b.collection)||String(a.id).localeCompare(String(b.id)));
};
const sourceDigest=sources=>sha(orderSources(sources).map(s=>[s.collection,s.id,s.version]));
const MONTHS={Monthly:1,Quarterly:3,Annual:12};
const addMonths=(iso,count)=>{const [y,m,d]=iso.split('-').map(Number);const first=Date.UTC(y,m-1+count,1);const date=new Date(first);const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(d,last));return date.toISOString().slice(0,10);};
const shiftDays=(iso,count)=>new Date(Date.parse(iso+'T00:00:00Z')+count*86400000).toISOString().slice(0,10);
const daysBetween=(from,to)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);

const INTEGRITY={
 giftAmounts:"SELECT COUNT(*) AS n FROM records WHERE collection='gifts' AND json_type(data,'$.amount')<>'integer'",
 allocationAmounts:"SELECT COUNT(*) AS n FROM records g,json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a WHERE g.collection='gifts' AND json_type(a.value,'$.amount')<>'integer'",
 grantAmounts:"SELECT COUNT(*) AS n FROM records WHERE collection='grants' AND (json_type(data,'$.amount')<>'integer' OR (json_extract(data,'$.awardedAmount') IS NOT NULL AND json_type(data,'$.awardedAmount')<>'integer'))",
 pledgeAmounts:"SELECT COUNT(*) AS n FROM records WHERE collection='pledges' AND json_type(data,'$.amount')<>'integer'",
 scopedGifts:"SELECT COUNT(*) AS n,COALESCE(SUM(json_extract(data,'$.amount')),0) AS cents FROM records WHERE collection='gifts' AND COALESCE(json_extract(data,'$.status'),'Posted')<>'Voided' AND COALESCE(json_extract(data,'$.type'),'') NOT IN ('Fee payment','In-kind') AND json_extract(data,'$.date')>=? AND json_extract(data,'$.date')<=?"
};

export function install(app,{db,list,get,audit,csrf,write,transaction,isTenantActive=()=>true,recheckAccess=()=>false,config=null,clock=()=>new Date()}={}){
 if(!app||!db)return null;
 const provider=createAiProvider(config?.ai??config?.provider??{});
 db.exec(`CREATE TABLE IF NOT EXISTS data_quality_reviews(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('duplicate','stewardship','followup','quality')),finding_key TEXT NOT NULL,source_digest TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('Accepted for review','Dismissed','Reopened')),reason TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS data_quality_review_finding ON data_quality_reviews(kind,finding_key,at);
 CREATE TRIGGER IF NOT EXISTS data_quality_review_no_update BEFORE UPDATE ON data_quality_reviews BEGIN SELECT RAISE(ABORT,'Data quality review decisions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS data_quality_review_no_delete BEFORE DELETE ON data_quality_reviews BEGIN SELECT RAISE(ABORT,'Data quality review decisions are retained'); END;`);

 const current=req=>{
  if(!req?.user||!['admin','staff'].includes(req.user.role))fail(403,'Data quality review requires an administrator or staff role.');
  if(!isTenantActive())fail(403,'Workspace is suspended.');
  if(!recheckAccess(req))fail(401,'Account access changed. Sign in again.');
 };
 const authorized=(req,res,next)=>{try{current(req);next();}catch(e){next(e);}};
 const action=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 app.use('/api/data-quality',authorized);
 const today=()=>clock().toISOString().slice(0,10);

 // ---- one acquisition per request; nothing is cached between requests -----
 const COLLECTIONS=['constituents','gifts','grants','pledges','communications','volunteers','volunteerTime','shiftReservations','events','designations','tasks'];
 function acquire(){
  const data=Object.fromEntries(COLLECTIONS.map(name=>[name,list(name)]));
  if(data.constituents.length>DATA_QUALITY_LIMITS.constituents)fail(503,'This workspace holds more constituents than the reviewed detection bound. Narrow the workspace before relying on these findings.');
  return data;
 }
 function households(){
  try{return db.prepare('SELECT h.id,h.name,h.address,m.constituent_id AS constituentId FROM households h JOIN household_members m ON m.household_id=h.id').all();}
  catch{return [];}
 }
 const aliasTargets=()=>{try{return new Set(db.prepare('SELECT target_id FROM identity_aliases').all().map(r=>r.target_id));}catch{return new Set();}};

 // Retained history that identity merge treats as protective. Reported as a
 // blocker with its citation, never removed or worked around here.
 function protectedHistory(data){
  const map=new Map(),volunteerOwner=new Map(data.volunteers.map(v=>[v.id,v.constituentId]));
  const add=(id,reason,source)=>{if(!id)return;if(!map.has(id))map.set(id,[]);const entries=map.get(id);if(entries.length<10&&!entries.some(e=>e.reason===reason))entries.push({reason,...source});};
  for(const gift of data.gifts){
   if(gift.status==='Voided')add(gift.constituentId,'A voided gift keeps this identity in the financial record.',ref('gifts',gift));
   if(gift.acknowledgment)add(gift.constituentId,'An acknowledged gift keeps this identity in the stewardship record.',ref('gifts',gift));
  }
  for(const entry of data.volunteerTime)add(entry.constituentId||volunteerOwner.get(entry.volunteerId),'Recorded volunteer time keeps this identity.',ref('volunteerTime',entry));
  for(const volunteer of data.volunteers)if(volunteer.clockIn)add(volunteer.constituentId,'An open volunteer clock keeps this identity until it is closed.',ref('volunteers',volunteer));
  for(const reservation of data.shiftReservations)add(reservation.constituentId,'A recorded shift reservation keeps this identity.',ref('shiftReservations',reservation));
  for(const event of data.events)for(const registration of event.registrations||[])if(registration.checkedIn)add(registration.constituentId,'Checked-in attendance keeps this identity.',ref('events',event));
  return map;
 }

 // ---- 1. duplicate and data-quality detection ----------------------------
 function duplicates(data){
  const rows=households(),homeOf=new Map(rows.map(row=>[row.constituentId,row]));
  const aliases=aliasTargets(),history=protectedHistory(data);
  const active=data.constituents.filter(record=>!record.mergedInto);
  const index=new Map(),buckets=new Map();
  const bucket=(key,id)=>{if(!key)return;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(id);};
  for(const record of active){
   const person=isPersonConstituent(record),home=homeOf.get(record.id)||null;
   const entry={record,person,home,
    email:normalizeEmail(record.email),phone:normalizePhone(record.phone),
    name:normalizeName(record.name,person),order:normalizeNameOrder(record.name,person),
    householdLabel:fold(record.household).replace(/\s+/g,' ').trim(),
    address:normalizeAddress(home?.address)};
   index.set(record.id,entry);
   bucket(entry.email&&'email:'+entry.email,record.id);
   bucket(entry.phone&&'phone:'+entry.phone,record.id);
   bucket(entry.name&&'name:'+entry.name,record.id);
   bucket(entry.order&&entry.order!==entry.name&&'order:'+entry.order,record.id);
  }
  const pairs=new Map();let comparisons=0,oversized=0;
  for(const [key,members] of buckets){
   if(members.length<2)continue;
   if(members.length>DATA_QUALITY_LIMITS.bucket){oversized++;continue;}
   for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++){
    if(++comparisons>DATA_QUALITY_LIMITS.comparisons)break;
    const [a,b]=members[i]<members[j]?[members[i],members[j]]:[members[j],members[i]];
    if(!pairs.has(a+'|'+b))pairs.set(a+'|'+b,new Set());
    pairs.get(a+'|'+b).add(key.split(':')[0]);
   }
  }
  const candidates=[];
  for(const [key,kinds] of pairs){
   const [aId,bId]=key.split('|'),a=index.get(aId),b=index.get(bId);
   if(!a||!b)continue;
   const signals=[];
   const signal=(type,why,value,left,right)=>signals.push({type,why,normalized:value,left:untrusted(left),right:untrusted(right)});
   if(kinds.has('email')&&a.email&&a.email===b.email)signal('email','Both records normalise to the same email address.',a.email,a.record.email,b.record.email);
   if(kinds.has('phone')&&a.phone&&a.phone===b.phone)signal('phone','Both records normalise to the same ten-digit phone number.',a.phone,a.record.phone,b.record.phone);
   if(a.name&&a.name===b.name)signal('name','Both names normalise identically once honorifics and punctuation are removed.',a.name,a.record.name,b.record.name);
   else if(a.order&&a.order===b.order)signal('name-order','The same name words appear in a different order.',a.order,a.record.name,b.record.name);
   if(a.home&&b.home&&a.home.id===b.home.id)signal('household','Both people are recorded in the same managed household.',a.home.id,a.home.name,b.home.name);
   else if(a.householdLabel&&a.householdLabel===b.householdLabel)signal('household-label','Both records carry the same household label.',a.householdLabel,a.record.household,b.record.household);
   if(a.address&&a.address===b.address)signal('address','Both recorded household addresses normalise identically.',a.address,a.home?.address,b.home?.address);
   const types=new Set(signals.map(s=>s.type));
   const identifying=types.has('email')||types.has('phone');
   const sameName=types.has('name');
   const context=types.has('household')||types.has('household-label')||types.has('address');
   // A shared household or address is never sufficient on its own: people who
   // live together are not one identity. A name alone is never sufficient either.
   if(!identifying&&!(sameName&&context))continue;
   const blockers=[];
   if(a.person!==b.person)blockers.push({reason:'A person and an organization can never become one physical identity. Review the relationship instead of merging.',sources:[ref('constituents',a.record),ref('constituents',b.record)]});
   if(a.home&&b.home&&a.home.id!==b.home.id)blockers.push({reason:'These records belong to two different managed households. Reconcile household membership first.',sources:[ref('constituents',a.record),ref('constituents',b.record)]});
   for(const side of [a,b]){
    if(aliases.has(side.record.id))blockers.push({reason:'This record already survives an earlier merge and keeps retained aliases. A history-aware review is required.',sources:[ref('constituents',side.record)]});
    for(const entry of history.get(side.record.id)||[])blockers.push({reason:entry.reason,sources:[ref('constituents',side.record),{collection:entry.collection,id:entry.id,version:entry.version}]});
   }
   const sources=orderSources([ref('constituents',a.record),ref('constituents',b.record),...blockers.flatMap(blocker=>blocker.sources)]);
   candidates.push({
    key,kind:'duplicate',
    left:{id:a.record.id,version:a.record.version,name:untrusted(a.record.name).value,type:safeLabel(a.record.type),person:a.person,household:a.home?safeLabel(a.home.name):null},
    right:{id:b.record.id,version:b.record.version,name:untrusted(b.record.name).value,type:safeLabel(b.record.type),person:b.person,household:b.home?safeLabel(b.home.name):null},
    signals,confidence:identifying&&sameName?'Strong':'Review',
    blocked:blockers.length>0,blockers,
    sources,digest:sourceDigest(sources),
    nextAction:{label:blockers.length?'Review manually; this pair cannot be merged':'Open Identity & households and review the merge',where:'identity',requiresHuman:true,performedByWimblo:false,performed:false},
    statement:'This is a proposal built from the signals shown. Wimblo has not merged, edited or linked these records.'
   });
  }
  candidates.sort((x,y)=>Number(x.blocked)-Number(y.blocked)||(x.confidence===y.confidence?0:x.confidence==='Strong'?-1:1)||x.key.localeCompare(y.key));
  return {candidates:candidates.slice(0,DATA_QUALITY_LIMITS.candidates),matched:candidates.length,comparisons,oversizedGroups:oversized,scanned:active.length,
   method:'Deterministic normalisation of name, email, phone, household and recorded household address. A shared household or address alone never proposes a merge, and a person and an organization are never proposed as one identity.'};
 }

 // Organization contact entries are not constituent records. A person who looks
 // like one is a relationship to review, never a merge candidate.
 function qualityFindings(data){
  const findings=[],add=(key,severity,title,detail,sources,nextAction,extra={})=>{
   const ordered=orderSources(sources);
   findings.push({key,kind:'quality',severity,title,detail,sources:ordered,digest:sourceDigest(ordered),nextAction:{...nextAction,requiresHuman:true,performedByWimblo:false,performed:false},...extra});
  };
  const active=data.constituents.filter(record=>!record.mergedInto);
  const peopleByName=new Map();
  for(const record of active)if(isPersonConstituent(record)){const key=normalizeName(record.name,true);if(key){if(!peopleByName.has(key))peopleByName.set(key,[]);peopleByName.get(key).push(record);}}
  for(const record of active){
   if(record.preference==='Email'&&!normalizeEmail(record.email))add('channel:'+record.id,'attention','Recorded contact preference has no usable channel','The contact preference is Email and no valid email address is saved. Contact preference is not marketing consent and nothing was sent.',[ref('constituents',record)],{label:'Open the constituent and record an email address or change the preference',where:'constituents'},{constituentId:record.id,name:untrusted(record.name).value});
   if(record.preference==='Phone'&&!normalizePhone(record.phone))add('channel:'+record.id,'attention','Recorded contact preference has no usable channel','The contact preference is Phone and no ten-digit phone number is saved.',[ref('constituents',record)],{label:'Open the constituent and record a phone number or change the preference',where:'constituents'},{constituentId:record.id,name:untrusted(record.name).value});
   if(record.email&&!normalizeEmail(record.email))add('email-format:'+record.id,'attention','A saved email address cannot be normalised','The saved address does not parse as one mailbox. Imported values are kept exactly as recorded and are not corrected here.',[ref('constituents',record)],{label:'Open the constituent and correct the saved address',where:'constituents'},{constituentId:record.id,name:untrusted(record.name).value});
   for(const contact of record.contacts||[]){
    const matches=peopleByName.get(normalizeName(contact.name,true))||[];
    for(const person of matches)add('org-contact:'+record.id+':'+person.id,'review','A person record matches a contact recorded on an organization','A contact entry inside an organization is not a separate constituent. Review whether this person should be linked, kept separate, or recorded only once. No record was changed.',[ref('constituents',record),ref('constituents',person)],{label:'Open both records and decide how the relationship is recorded',where:'constituents'},{organizationId:record.id,constituentId:person.id,organization:untrusted(record.name).value,name:untrusted(person.name).value});
   }
  }
  // Instruction-like saved text. Reported by field and pattern, never echoed.
  const SCAN=[['constituents',['name','notes','household','segments']],['communications',['subject','body','notes']],['gifts',['notes','externalRef']],['grants',['name','notes']],['pledges',['name','notes']],['designations',['name','school','description']],['tasks',['title','notes']],['events',['name','location','notes']]];
  for(const [collection,fields] of SCAN)for(const record of data[collection]||[]){
   const hits=[];
   for(const field of fields){const patterns=scan(record[field]);if(patterns.length)hits.push({field,patterns});}
   for(const contact of collection==='constituents'?record.contacts||[]:[])for(const field of ['name','email','role']){const patterns=scan(contact[field]);if(patterns.length)hits.push({field:'contacts.'+field,patterns});}
   if(hits.length)add('injection:'+collection+':'+record.id,'review','Saved text contains instruction-like content','This saved text reads like an instruction to an assistant. It is treated as data only: it never changed any suggestion, narrative or permission, and its contents are not repeated here.',[ref(collection,record)],{label:'Open the record and review the saved text',where:collection},{targetCollection:collection,targetId:record.id,fields:hits,textEchoed:false});
  }
  findings.sort((a,b)=>a.key.localeCompare(b.key));
  return {findings:findings.slice(0,DATA_QUALITY_LIMITS.findings),matched:findings.length,scope:'Saved constituent, communication, gift, grant, pledge, designation, task and event fields in this workspace only.'};
 }

 // ---- 2. stewardship risk and next-best action ---------------------------
 function stewardship(data){
  const now=today(),findings=[];
  const add=(key,severity,title,detail,sources,nextAction,extra={})=>{
   const ordered=orderSources(sources);
   findings.push({key,kind:'stewardship',severity,title,detail,sources:ordered,digest:sourceDigest(ordered),nextAction:{...nextAction,requiresHuman:true,performedByWimblo:false,performed:false},...extra});
  };
  const people=new Map(data.constituents.map(record=>[record.id,record]));
  const posted=data.gifts.filter(gift=>isPostedGift(gift)&&day(gift.date)&&gift.date<=now);
  const byPerson=new Map();
  for(const gift of posted){if(!byPerson.has(gift.constituentId))byPerson.set(gift.constituentId,[]);byPerson.get(gift.constituentId).push(gift);}
  const yearAgo=addMonths(now,-12),twoYearsAgo=addMonths(now,-24);
  for(const [constituentId,gifts] of byPerson){
   const person=people.get(constituentId);
   if(!person||person.mergedInto)continue;
   const sorted=gifts.slice().sort((a,b)=>a.date.localeCompare(b.date)||String(a.id).localeCompare(String(b.id)));
   const last=sorted.at(-1),prior=sorted.filter(gift=>gift.date>twoYearsAgo&&gift.date<=yearAgo);
   if(last.date<=yearAgo&&prior.length)add('lapsing:'+constituentId,'review','Recorded giving stopped after a recorded prior year','The most recent posted monetary gift is recorded on '+last.date+'. '+prior.length+' posted monetary gifts are recorded in the twelve months before that window. This restates saved dates only; it is not a prediction and no likelihood is stated.',[ref('constituents',person),...sorted.slice(-6).map(gift=>ref('gifts',gift))],{label:person.preference==='Do not contact'?'Do not contact is recorded; review the record without preparing an approach':'Open the constituent and decide whether to prepare an approach',where:'constituents'},{constituentId,name:untrusted(person.name).value,lastGiftDate:last.date,priorWindowGifts:prior.length,preference:safeLabel(person.preference),lifetimeCents:sorted.reduce((total,gift)=>total+(Number.isSafeInteger(gift.amount)?gift.amount:0),0)});
  }
  const gap=shiftDays(now,-14);
  for(const gift of posted){
   const person=people.get(gift.constituentId);
   if(!person||person.mergedInto||gift.acknowledgment||gift.date>gap)continue;
   if(!Number.isSafeInteger(gift.amount))continue;
   add('acknowledgment:'+gift.id,'attention','A posted gift has no acknowledgment recorded','A gift of '+gift.amount+' cents is recorded on '+gift.date+' with no acknowledgment. Recording an acknowledgment is a staff action Wimblo neither performs nor sends.',[ref('gifts',gift),ref('constituents',person)],{label:person.preference==='Do not contact'?'Do not contact is recorded; review before any acknowledgment':'Open Stewardship and record the acknowledgment a staff member has completed',where:'stewardship'},{constituentId:person.id,giftId:gift.id,amountCents:gift.amount,giftDate:gift.date,name:untrusted(person.name).value,preference:safeLabel(person.preference)});
  }
  for(const message of data.communications){
   const person=people.get(message.constituentId);
   if(!person||message.status!=='Draft'||person.preference!=='Do not contact')continue;
   add('consent:'+message.id,'review','An unsent draft is held for a Do not contact record','Contact preference is Do not contact and this draft is still saved. Wimblo never sends anything; this is a consent review, not a delivery state.',[ref('communications',message),ref('constituents',person)],{label:'Open Communications and resolve the draft',where:'communications'},{constituentId:person.id,communicationId:message.id,name:untrusted(person.name).value});
  }
  findings.sort((a,b)=>a.key.localeCompare(b.key));
  return {findings:findings.slice(0,DATA_QUALITY_LIMITS.findings),matched:findings.length,computedFor:now,cached:false,
   scope:'Computed from saved records at request time. Posted monetary gifts exclude voided gifts, fee payments and in-kind support. No forecast, score or likelihood is produced.'};
 }

 // ---- 3. grant and pledge follow-up --------------------------------------
 function followUps(data){
  const now=today(),findings=[];
  const add=(key,severity,title,detail,sources,nextAction,extra={})=>{
   const ordered=orderSources(sources);
   findings.push({key,kind:'followup',severity,title,detail,sources:ordered,digest:sourceDigest(ordered),nextAction:{...nextAction,requiresHuman:true,performedByWimblo:false,performed:false},...extra});
  };
  const people=new Map(data.constituents.map(record=>[record.id,record]));
  for(const grant of data.grants){
   const funder=people.get(grant.funderId)||null,name=untrusted(grant.name).value;
   const deadline=day(grant.deadline),reportDue=day(grant.reportDue);
   if(['Prospect','Preparing','Submitted'].includes(grant.stage)&&deadline)add('grant-deadline:'+grant.id,deadline<=now?'attention':'review','A recorded community grant deadline is approaching or passed','Recorded deadline '+deadline+', recorded stage '+safeLabel(grant.stage)+'. The date is the one saved on the grant; no submission, outcome or external confirmation is claimed.',[ref('grants',grant),...(funder?[ref('constituents',funder)]:[])],{label:'Open Grant operations and record the milestone a staff member completed',where:'grant-operations'},{grantId:grant.id,name,stage:safeLabel(grant.stage),deadline,daysFromToday:daysBetween(now,deadline),requestedCents:Number.isSafeInteger(grant.amount)?grant.amount:null,funder:funder?untrusted(funder.name).value:null});
   if(grant.stage==='Awarded'&&reportDue)add('grant-report:'+grant.id,reportDue<=now?'attention':'review','A recorded community grant report date is approaching or passed','Recorded report date '+reportDue+'. This restates the saved date; Wimblo does not submit or deliver a report.',[ref('grants',grant),...(funder?[ref('constituents',funder)]:[])],{label:'Open Grant operations and record the report milestone',where:'grant-operations'},{grantId:grant.id,name,reportDue,daysFromToday:daysBetween(now,reportDue),awardedCents:Number.isSafeInteger(grant.awardedAmount)?grant.awardedAmount:null,funder:funder?untrusted(funder.name).value:null});
   if(grant.stage==='Awarded'&&Number.isSafeInteger(grant.awardedAmount)&&grant.awardedAmount>0){
    const posted=data.gifts.filter(gift=>gift.grantId===grant.id&&isPostedGift(gift)&&Number.isSafeInteger(gift.amount));
    const received=posted.reduce((total,gift)=>total+gift.amount,0);
    if(received!==grant.awardedAmount)add('grant-award-gap:'+grant.id,'review','A recorded award does not match posted grant revenue','Recorded award '+grant.awardedAmount+' cents; posted grant gifts total '+received+' cents across '+posted.length+' records. An award is a commitment, not received income, and nothing was posted here.',[ref('grants',grant),...posted.map(gift=>ref('gifts',gift))],{label:'Open the grant and reconcile the recorded award with posted gifts',where:'grants'},{grantId:grant.id,name,awardedCents:grant.awardedAmount,postedCents:received,postedGifts:posted.length,differenceCents:grant.awardedAmount-received});
   }
  }
  for(const pledge of data.pledges){
   if(pledge.status!=='Active')continue;
   const committed=Number.isSafeInteger(pledge.amount)?pledge.amount:null,start=day(pledge.startDate);
   const step=MONTHS[pledge.frequency],installments=Number.isSafeInteger(pledge.installments)?pledge.installments:null;
   const posted=data.gifts.filter(gift=>gift.pledgeId===pledge.id&&isPostedGift(gift)&&Number.isSafeInteger(gift.amount));
   const received=posted.reduce((total,gift)=>total+gift.amount,0);
   if(committed===null)continue;
   const balance=committed-received;
   const evenInstallment=installments&&committed%installments===0?committed/installments:null;
   const covered=evenInstallment?Math.floor(received/evenInstallment):null;
   const nextDue=start&&step&&installments&&covered!==null&&covered<installments?addMonths(start,step*covered):null;
   const donor=people.get(pledge.constituentId)||null;
   add('pledge:'+pledge.id,balance>0&&nextDue&&nextDue<=now?'attention':'review','A recorded pledge has an outstanding recorded balance','Recorded commitment '+committed+' cents; posted fulfilment gifts total '+received+' cents across '+posted.length+' records; recorded outstanding balance '+balance+' cents. A pledge is a commitment, not received income.',[ref('pledges',pledge),...posted.map(gift=>ref('gifts',gift)),...(donor?[ref('constituents',donor)]:[])],{label:'Open Pledges and review the recorded schedule with the donor',where:'pledges'},
    {pledgeId:pledge.id,name:untrusted(pledge.name).value,donor:donor?untrusted(donor.name).value:null,committedCents:committed,receivedCents:received,balanceCents:balance,postedGifts:posted.length,
     schedule:{startDate:start,frequency:safeLabel(pledge.frequency),installments,installmentCents:evenInstallment,installmentsCovered:covered,nextScheduledDate:nextDue,
      derivedFrom:['pledges.startDate','pledges.frequency','pledges.installments','pledges.amount','gifts.pledgeId','gifts.amount'],
      note:evenInstallment===null?'The recorded commitment does not divide into equal exact cents across the recorded installments, so no per-installment amount and no next scheduled date are stated.':'The next scheduled date is derived from the recorded first installment date, frequency and the number of recorded installments already covered by posted gifts. It is not a promise or a prediction.'}});
  }
  findings.sort((a,b)=>a.key.localeCompare(b.key));
  return {findings:findings.slice(0,DATA_QUALITY_LIMITS.findings),matched:findings.length,computedFor:now,cached:false,
   scope:'Community grants only: the buyer placed government grant workflows out of scope, and this workspace records no government funder category. Every date and amount above is a saved field or an exact integer-cent sum of saved fields.'};
 }

 // ---- reviews: a decision, never an action -------------------------------
 const reviewRow=(kind,key)=>db.prepare('SELECT * FROM data_quality_reviews WHERE kind=? AND finding_key=? ORDER BY at DESC,rowid DESC LIMIT 1').get(kind,key);
 const reviewView=(row,digest)=>row?{id:row.id,decision:row.decision,reason:row.reason,actor:row.actor,at:row.at,sourceDigest:row.source_digest,current:row.source_digest===digest,performed:'none'}:null;
 const withReviews=(kind,findings)=>findings.map(finding=>({...finding,review:reviewView(reviewRow(kind,finding.key),finding.digest)}));

 function findingsFor(kind,data){
  if(kind==='duplicate')return duplicates(data).candidates;
  if(kind==='stewardship')return stewardship(data).findings;
  if(kind==='followup')return followUps(data).findings;
  return qualityFindings(data).findings;
 }

 // ---- 4. report narratives ------------------------------------------------
 function assertLedgerIntegrity(){
  for(const [name,query] of [['gift amounts',INTEGRITY.giftAmounts],['gift allocations',INTEGRITY.allocationAmounts],['grant amounts',INTEGRITY.grantAmounts],['pledge amounts',INTEGRITY.pledgeAmounts]])
   if(db.prepare(query).get().n)fail(503,'Saved '+name+' are not all exact integer cents. The narrative was refused rather than approximated.');
 }
 function verifySources(sources){
  for(const source of sources){
   let record;
   try{record=get(source.collection,source.id);}catch(e){if(e.status===404)fail(409,'A cited record was removed while the narrative was being verified. The narrative was withdrawn rather than shown stale.');throw e;}
   if(record.version!==source.version)fail(409,'A cited record changed while the narrative was being verified. The narrative was withdrawn rather than shown stale.');
  }
 }
 function narrativeFacts(kind,scope,data){
  const facts=[],sentences=[];
  const push=(key,kindName,value,sources)=>{facts.push({key,kind:kindName,[kindName]:value,sources:orderSources(sources).slice(0,DATA_QUALITY_LIMITS.narrativeSources)});return key;};
   const posted=data.gifts.filter(gift=>isPostedGift(gift)&&day(gift.date)&&gift.date>=scope.from&&gift.date<=scope.to);
  for(const gift of posted)if(!Number.isSafeInteger(gift.amount)||gift.amount<0)fail(503,'A posted gift in this period is not stored as exact integer cents. The narrative was refused rather than approximated.');
  const scopeSources=posted.length?posted.map(gift=>ref('gifts',gift)):null;
  if(posted.length>DATA_QUALITY_LIMITS.narrativeSources)fail(409,'This period cites more than '+DATA_QUALITY_LIMITS.narrativeSources+' records. Narrow the period: a narrative cites every record it counts.');
   if(kind==='giving-summary'){
   const total=posted.reduce((sum,gift)=>sum+gift.amount,0);
   const check=db.prepare(INTEGRITY.scopedGifts).get(scope.from,scope.to);
   if(check.n!==posted.length||check.cents!==total)fail(503,'Two independent acquisitions of the same posted gifts disagree. The narrative was refused rather than approximated.');
   const unacknowledged=posted.filter(gift=>!gift.acknowledgment);
   if(!scopeSources)fail(409,'No posted monetary gift is recorded in this period, so there is nothing to cite and no narrative is produced.');
   sentences.push({template:'scope-period',facts:{from:push('from','date',scope.from,scopeSources),to:push('to','date',scope.to,scopeSources)}});
   sentences.push({template:'posted-total',facts:{count:push('posted-count','count',posted.length,scopeSources),cents:push('posted-cents','cents',total,scopeSources)}});
   if(unacknowledged.length)sentences.push({template:'acknowledgment-gap',facts:{count:push('gap-count','count',unacknowledged.length,unacknowledged.map(gift=>ref('gifts',gift))),cents:push('gap-cents','cents',unacknowledged.reduce((sum,gift)=>sum+gift.amount,0),unacknowledged.map(gift=>ref('gifts',gift)))}});
   if(scope.designationId){
    const designation=data.designations.find(record=>record.id===scope.designationId);
    if(!designation)fail(404,'That designation is not saved in this workspace.');
    const rows=posted.flatMap(gift=>(gift.allocations||[]).filter(allocation=>allocation.designationId===scope.designationId).map(allocation=>({gift,allocation})));
    for(const row of rows)if(!Number.isSafeInteger(row.allocation.amount)||row.allocation.amount<0)fail(503,'A saved allocation in this period is not exact integer cents. The narrative was refused rather than approximated.');
    const designationSources=orderSources([ref('designations',designation),...rows.map(row=>ref('gifts',row.gift))]);
    if(rows.length)sentences.push({template:'designation-total',facts:{label:push('designation','label',safeLabel(designation.name)||'The selected designation',designationSources),count:push('designation-count','count',rows.length,designationSources),cents:push('designation-cents','cents',rows.reduce((sum,row)=>sum+row.allocation.amount,0),designationSources)}});
   }
  }else if(kind==='grant-pipeline'){
   const pipeline=data.grants.filter(grant=>['Prospect','Preparing','Submitted'].includes(grant.stage)&&day(grant.deadline)&&grant.deadline>=scope.from&&grant.deadline<=scope.to);
   const awarded=data.grants.filter(grant=>grant.stage==='Awarded'&&day(grant.awardDate)&&grant.awardDate>=scope.from&&grant.awardDate<=scope.to);
   for(const grant of [...pipeline,...awarded])if(!Number.isSafeInteger(grant.amount)||grant.amount<0||(grant.awardedAmount!==undefined&&grant.awardedAmount!==null&&(!Number.isSafeInteger(grant.awardedAmount)||grant.awardedAmount<0)))fail(503,'A saved grant amount in this period is not exact integer cents. The narrative was refused rather than approximated.');
   const sources=orderSources([...pipeline,...awarded].map(grant=>ref('grants',grant)));
   if(!sources.length)fail(409,'No community grant with a saved deadline or award date falls in this period, so there is nothing to cite and no narrative is produced.');
   sentences.push({template:'scope-period',facts:{from:push('from','date',scope.from,sources),to:push('to','date',scope.to,sources)}});
   const pipelineSources=pipeline.length?pipeline.map(grant=>ref('grants',grant)):sources;
   sentences.push({template:'grant-pipeline',facts:{count:push('pipeline-count','count',pipeline.length,pipelineSources),cents:push('pipeline-cents','cents',pipeline.reduce((sum,grant)=>sum+grant.amount,0),pipelineSources)}});
   const awardedSources=awarded.length?awarded.map(grant=>ref('grants',grant)):sources;
   sentences.push({template:'grant-awarded',facts:{count:push('awarded-count','count',awarded.length,awardedSources),cents:push('awarded-cents','cents',awarded.reduce((sum,grant)=>sum+(grant.awardedAmount||0),0),awardedSources)}});
  }else{
   const pledges=data.pledges.filter(pledge=>pledge.status==='Active'&&day(pledge.startDate)&&pledge.startDate>=scope.from&&pledge.startDate<=scope.to);
   for(const pledge of pledges)if(!Number.isSafeInteger(pledge.amount)||pledge.amount<0)fail(503,'A saved pledge commitment in this period is not exact integer cents. The narrative was refused rather than approximated.');
   if(!pledges.length)fail(409,'No active pledge has a saved first installment date in this period, so there is nothing to cite and no narrative is produced.');
   const ids=new Set(pledges.map(pledge=>pledge.id));
   const fulfilment=data.gifts.filter(gift=>ids.has(gift.pledgeId)&&isPostedGift(gift));
   for(const gift of fulfilment)if(!Number.isSafeInteger(gift.amount)||gift.amount<0)fail(503,'A saved pledge fulfilment gift is not exact integer cents. The narrative was refused rather than approximated.');
   const sources=orderSources([...pledges.map(pledge=>ref('pledges',pledge)),...fulfilment.map(gift=>ref('gifts',gift))]);
   const committed=pledges.reduce((sum,pledge)=>sum+pledge.amount,0),received=fulfilment.reduce((sum,gift)=>sum+gift.amount,0);
   if(received>committed)fail(503,'Recorded pledge fulfilment exceeds the recorded commitment in this period. The narrative was refused rather than approximated.');
   sentences.push({template:'scope-period',facts:{from:push('from','date',scope.from,sources),to:push('to','date',scope.to,sources)}});
   sentences.push({template:'pledge-balance',facts:{count:push('pledge-count','count',pledges.length,sources),committed:push('committed-cents','cents',committed,sources),received:push('received-cents','cents',received,sources),balance:push('balance-cents','cents',committed-received,sources)}});
  }
  sentences.push({template:'no-inference'},{template:'review-required'});
  return {facts,sentences};
 }

 // ---- routes --------------------------------------------------------------
 const overview=req=>{
  const data=acquire();
  return {
   provider:provider.describe(),
   assistance:{available:provider.available,narratives:DATA_QUALITY_NARRATIVES,network:false,hosted:false,
    statement:'Assistance here recommends and summarises only. It never posts a gift, sends a communication, changes consent, merges an identity, issues a receipt, changes a permission or deletes a record.',
    neverPerforms:provider.neverPerforms},
   counts:{duplicates:duplicates(data).matched,stewardship:stewardship(data).matched,followups:followUps(data).matched,quality:qualityFindings(data).matched,constituents:data.constituents.length},
   limits:DATA_QUALITY_LIMITS,computedFor:today(),cached:false,canReview:['admin','staff'].includes(req.user.role),
   scope:'Every finding is recomputed from saved records on each request and cites the exact records and versions it used. A detection is not a merge and a suggestion is not a decision.'
  };
 };
 app.get('/api/data-quality',action((req,res)=>{z.object({}).strict().parse(req.query);res.json(overview(req));}));
 app.get('/api/data-quality/duplicates',action((req,res)=>{
  const query=z.object({limit:z.coerce.number().int().min(1).max(DATA_QUALITY_LIMITS.candidates).default(50),offset:z.coerce.number().int().min(0).max(1e6).default(0),include:z.enum(['All','Blocked','Open']).default('All')}).strict().parse(req.query);
  const result=duplicates(acquire());
  const filtered=result.candidates.filter(candidate=>query.include==='All'||(query.include==='Blocked'?candidate.blocked:!candidate.blocked));
  res.json({...result,candidates:withReviews('duplicate',filtered.slice(query.offset,query.offset+query.limit)),returned:Math.min(query.limit,Math.max(0,filtered.length-query.offset)),matchedInView:filtered.length,offset:query.offset,limit:query.limit,computedFor:today(),cached:false,
   statement:'These are proposals. Wimblo has not merged, edited or linked any record here, and a blocked pair cannot be merged at all.'});
 }));
 app.get('/api/data-quality/stewardship',action((req,res)=>{z.object({}).strict().parse(req.query);const result=stewardship(acquire());res.json({...result,findings:withReviews('stewardship',result.findings)});}));
 app.get('/api/data-quality/followups',action((req,res)=>{z.object({}).strict().parse(req.query);const result=followUps(acquire());res.json({...result,findings:withReviews('followup',result.findings)});}));
 app.get('/api/data-quality/quality',action((req,res)=>{z.object({}).strict().parse(req.query);const result=qualityFindings(acquire());res.json({...result,findings:withReviews('quality',result.findings),computedFor:today(),cached:false});}));
 app.get('/api/data-quality/reviews',action((req,res)=>{
  const query=z.object({kind:z.enum(FINDING_KINDS).optional(),findingKey:z.string().min(1).max(200).optional(),limit:z.coerce.number().int().min(1).max(DATA_QUALITY_LIMITS.reviewHistory).default(50)}).strict().parse(req.query);
  const where=[],params=[];
  if(query.kind){where.push('kind=?');params.push(query.kind);}
  if(query.findingKey){where.push('finding_key=?');params.push(query.findingKey);}
  const rows=db.prepare('SELECT * FROM data_quality_reviews'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY at DESC,rowid DESC LIMIT ?').all(...params,query.limit);
  res.json({reviews:rows.map(row=>({id:row.id,kind:row.kind,findingKey:row.finding_key,decision:row.decision,reason:row.reason,actor:row.actor,at:row.at,sourceDigest:row.source_digest,performed:'none'})),limit:query.limit,
   retained:'Review decisions are append-only and retained. A decision records a human judgment and changes no constituent, gift, consent, receipt or permission.'});
 }));
 app.post('/api/data-quality/reviews',csrf,write,action((req,res)=>{
  const body=z.object({kind:z.enum(FINDING_KINDS),findingKey:z.string().min(1).max(200),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['Accepted for review','Dismissed','Reopened']),reason:z.string().trim().min(1).max(DATA_QUALITY_LIMITS.reason)}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);
   const finding=findingsFor(body.kind,acquire()).find(item=>item.key===body.findingKey);
   if(!finding)fail(409,'This suggestion was withdrawn: it is no longer produced by the current saved records.');
   if(finding.digest!==body.sourceDigest)fail(409,'This suggestion was withdrawn: its cited records changed. Review the current finding before deciding.');
   const id=randomUUID(),at=stamp();
   db.prepare('INSERT INTO data_quality_reviews VALUES(?,?,?,?,?,?,?,?)').run(id,body.kind,body.findingKey,body.sourceDigest,body.decision,body.reason,req.user.id,at);
   audit(req.user,'data_quality_review',null,null,{kind:body.kind,findingKey:body.findingKey,decision:body.decision,sourceDigest:body.sourceDigest,performed:'none',note:'Review decision only; no record, consent, receipt or permission changed.'});
   current(req);
   const recheck=findingsFor(body.kind,acquire()).find(item=>item.key===body.findingKey);
   if(!recheck||recheck.digest!==body.sourceDigest)fail(409,'The cited records changed before the decision was saved. Review the current finding and decide again.');
   return {id,kind:body.kind,findingKey:body.findingKey,decision:body.decision,reason:body.reason,actor:req.user.id,at,sourceDigest:body.sourceDigest};
  });
  res.status(201).json({review:{...result,current:true,performed:'none'},performed:'none',
   note:'A review decision is recorded. No constituent was merged, no gift was posted, no communication was sent, no consent was changed, no receipt was issued and no permission was changed.'});
 }));
 app.post('/api/data-quality/narrative',csrf,write,action((req,res)=>{
  const body=z.object({kind:z.enum(DATA_QUALITY_NARRATIVES),from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),designationId:uuidish.optional(),expectedDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(req.body);
  if(body.from>body.to)fail(400,'Choose a period that starts on or before it ends.');
  if(daysBetween(body.from,body.to)>1100)fail(400,'Choose a period of at most three years.');
  if(!provider.available)fail(503,provider.reason);
  current(req);
  assertLedgerIntegrity();
  const data=acquire();
  const {facts,sentences}=narrativeFacts(body.kind,{from:body.from,to:body.to,designationId:body.designationId??null},data);
  const composed=provider.compose({kind:body.kind,facts,sentences});
  // Recomputed against live sources before display: a moved version withdraws it.
  verifySources(composed.sources);
  current(req);
  const digest=sourceDigest(composed.sources);
  if(body.expectedDigest&&body.expectedDigest!==digest)fail(409,'This narrative was withdrawn: the records it cited changed. Request a fresh narrative rather than reading a stale one.');
  audit(req.user,'data_quality_narrative',null,null,{kind:body.kind,from:body.from,to:body.to,status:'composed',sourceCount:composed.sources.length,sourceDigest:digest,provider:composed.provider,network:false,hosted:false,performed:'none'});
  res.json({...composed,from:body.from,to:body.to,sourceDigest:digest,computedFor:today(),cached:false,performed:'none',
   statement:'Every figure is an exact integer-cent value taken from the cited saved records. The narrative is a summary for human review; it posts nothing, sends nothing and approves nothing.'});
 }));

 return {describeProvider:()=>provider.describe(),duplicates:()=>duplicates(acquire()),stewardship:()=>stewardship(acquire()),followUps:()=>followUps(acquire())};
}

export function installPublic(){return null;}
