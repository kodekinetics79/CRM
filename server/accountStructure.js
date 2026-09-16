import {randomUUID} from 'node:crypto';
import {z} from 'zod';

// A8.8 / A8.1. Buyer facts (public Q&A1): locations are unique; one function may
// serve MANY locations; every location/function pair is one unique account, with
// three-digit location and four-digit function codes. The single correctness rule
// here is that a designation links to at most ONE account pair (enforced by the
// link table's primary key), so an allocation posted once in the gift ledger is
// counted exactly once in every location, function and pair rollup even when one
// function spans several locations. Linking never rewrites a designation record,
// so the existing parent/child hierarchy, account codes and every posted
// allocation are preserved untouched. Nothing here grants permission or consent.
const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const stamp=()=>new Date().toISOString();
const uuid=z.uuid(),version=z.number().int().min(1),reason=z.string().trim().min(1).max(500),label=z.string().trim().min(1).max(120);
const locationCode=z.string().trim().regex(/^\d{3}$/,'Use a three-digit location code'),functionCode=z.string().trim().regex(/^\d{4}$/,'Use a four-digit function code');
const lifecycle=z.enum(['Active','Retired']);
export const ACCOUNT_STRUCTURE_LIMITS={locations:999,functions:9999,pairs:10000,groups:2000,page:500,history:200};

// One acquisition of posted allocations. Voided gifts are excluded; a gift that
// carries no allocation array contributes no rows rather than raising.
const ALLOCATION=`WITH allocation AS (SELECT g.id AS gift_id,json_extract(a.value,'$.designationId') AS designation_id,json_extract(a.value,'$.amount') AS amount FROM records g,json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a WHERE g.collection='gifts' AND COALESCE(json_extract(g.data,'$.status'),'Posted')<>'Voided')`;
const grouped=(key,join,group)=>`${ALLOCATION} SELECT ${key} AS key,COUNT(DISTINCT allocation.gift_id) AS gifts,COUNT(*) AS allocations,COUNT(DISTINCT allocation.designation_id) AS designations,SUM(allocation.amount) AS cents FROM allocation JOIN account_designation_links l ON l.designation_id=allocation.designation_id${join} GROUP BY ${group} ORDER BY ${group}`;
const PAIR_JOIN=' JOIN account_pairs p ON p.id=l.pair_id';
// Exported so the representative-scale test can prove each acquisition stays
// indexed rather than scanning the structure tables.
export const ACCOUNT_STRUCTURE_QUERIES={
 allocationIntegrity:`SELECT COUNT(*) AS n FROM records g,json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a WHERE g.collection='gifts' AND (json_type(a.value,'$.amount')<>'integer' OR json_type(a.value,'$.designationId')<>'text' OR json_extract(a.value,'$.amount')<1)`,
 giftReconciliation:`SELECT COUNT(*) AS n FROM (SELECT json_extract(g.data,'$.amount') AS amount,(SELECT SUM(json_extract(a.value,'$.amount')) FROM json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a) AS allocated FROM records g WHERE g.collection='gifts' AND COALESCE(json_extract(g.data,'$.status'),'Posted')<>'Voided') WHERE amount IS NOT allocated`,
 postedGifts:`SELECT COUNT(*) AS gifts,COALESCE(SUM(json_extract(data,'$.amount')),0) AS cents FROM records WHERE collection='gifts' AND COALESCE(json_extract(data,'$.status'),'Posted')<>'Voided'`,
 totals:`${ALLOCATION} SELECT COUNT(DISTINCT allocation.gift_id) AS gifts,COUNT(*) AS allocations,COALESCE(SUM(allocation.amount),0) AS cents,COALESCE(SUM(CASE WHEN l.designation_id IS NULL THEN 0 ELSE allocation.amount END),0) AS linked_cents,COALESCE(SUM(CASE WHEN l.designation_id IS NULL THEN allocation.amount ELSE 0 END),0) AS unlinked_cents,COUNT(DISTINCT CASE WHEN l.designation_id IS NULL THEN allocation.designation_id END) AS unlinked_designations,COUNT(DISTINCT CASE WHEN l.designation_id IS NULL THEN NULL ELSE allocation.designation_id END) AS linked_designations FROM allocation LEFT JOIN account_designation_links l ON l.designation_id=allocation.designation_id`,
 byPair:grouped('l.pair_id','','l.pair_id'),
 byLocation:grouped('p.location_id',PAIR_JOIN,'p.location_id'),
 byFunction:grouped('p.function_id',PAIR_JOIN,'p.function_id'),
 byDesignation:`${ALLOCATION} SELECT allocation.designation_id AS key,COUNT(DISTINCT allocation.gift_id) AS gifts,COUNT(*) AS allocations,SUM(allocation.amount) AS cents FROM allocation GROUP BY allocation.designation_id`,
 pairsByLocation:'SELECT * FROM account_pairs WHERE location_id=? ORDER BY code',
 pairsByFunction:'SELECT * FROM account_pairs WHERE function_id=? ORDER BY code',
 linksByPair:'SELECT designation_id FROM account_designation_links WHERE pair_id=? ORDER BY designation_id',
 designationRecords:"SELECT data FROM records WHERE collection='designations' ORDER BY rowid"
};

export function install(app,{db,list,get,audit,csrf,admin,transaction,isTenantActive=()=>true,recheckAccess=()=>false}){
 db.exec(`CREATE TABLE IF NOT EXISTS account_locations(id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Active','Retired')),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS account_location_code ON account_locations(code);
 CREATE UNIQUE INDEX IF NOT EXISTS account_location_name ON account_locations(lower(name));
 CREATE TABLE IF NOT EXISTS account_functions(id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Active','Retired')),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS account_function_code ON account_functions(code);
 CREATE UNIQUE INDEX IF NOT EXISTS account_function_name ON account_functions(lower(name));
 CREATE TABLE IF NOT EXISTS account_pairs(id TEXT PRIMARY KEY,location_id TEXT NOT NULL REFERENCES account_locations(id),function_id TEXT NOT NULL REFERENCES account_functions(id),code TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Active','Retired')),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS account_pair_identity ON account_pairs(location_id,function_id);
 CREATE UNIQUE INDEX IF NOT EXISTS account_pair_code ON account_pairs(code);
 CREATE INDEX IF NOT EXISTS account_pair_function ON account_pairs(function_id);
 CREATE TABLE IF NOT EXISTS account_designation_links(designation_id TEXT PRIMARY KEY,pair_id TEXT NOT NULL REFERENCES account_pairs(id),designation_version INTEGER NOT NULL,version INTEGER NOT NULL,linked_at TEXT NOT NULL,updated_at TEXT NOT NULL,actor TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS account_link_pair ON account_designation_links(pair_id);
 CREATE TABLE IF NOT EXISTS account_structure_history(id TEXT PRIMARY KEY,subject TEXT NOT NULL,subject_id TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS account_history_subject ON account_structure_history(subject,subject_id,at);
 CREATE TRIGGER IF NOT EXISTS account_location_no_delete BEFORE DELETE ON account_locations BEGIN SELECT RAISE(ABORT,'Location history is retained; retire the location instead'); END;
 CREATE TRIGGER IF NOT EXISTS account_function_no_delete BEFORE DELETE ON account_functions BEGIN SELECT RAISE(ABORT,'Function history is retained; retire the function instead'); END;
 CREATE TRIGGER IF NOT EXISTS account_pair_no_delete BEFORE DELETE ON account_pairs BEGIN SELECT RAISE(ABORT,'Account pair history is retained; retire the account instead'); END;
 CREATE TRIGGER IF NOT EXISTS account_location_identity BEFORE UPDATE ON account_locations WHEN NEW.code<>OLD.code OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'Location identity and code are retained'); END;
 CREATE TRIGGER IF NOT EXISTS account_function_identity BEFORE UPDATE ON account_functions WHEN NEW.code<>OLD.code OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'Function identity and code are retained'); END;
 CREATE TRIGGER IF NOT EXISTS account_pair_identity_retained BEFORE UPDATE ON account_pairs WHEN NEW.location_id<>OLD.location_id OR NEW.function_id<>OLD.function_id OR NEW.code<>OLD.code OR NEW.id<>OLD.id BEGIN SELECT RAISE(ABORT,'Account pair identity is retained'); END;
 CREATE TRIGGER IF NOT EXISTS account_history_no_update BEFORE UPDATE ON account_structure_history BEGIN SELECT RAISE(ABORT,'Account structure history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS account_history_no_delete BEFORE DELETE ON account_structure_history BEGIN SELECT RAISE(ABORT,'Account structure history is retained'); END;`);

 const current=req=>{if(!req?.user||!['admin','staff','viewer'].includes(req.user.role))fail(403,'Account structure requires workspace access');if(!isTenantActive())fail(403,'Workspace is suspended');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');};
 const manage=req=>{current(req);const live=db.prepare('SELECT role,active FROM users WHERE id=?').get(req.user.id);if(req.user.role!=='admin'||!live?.active||live.role!=='admin')fail(403,'Administrator required');};
 const authorized=(req,res,next)=>{try{current(req);next();}catch(e){next(e);}};
 const action=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 app.use('/api/account-structure',authorized);
 const exact=value=>{const n=value??0;if(!Number.isSafeInteger(n))fail(503,'Stored account allocations exceed safe integer cents.');return n;};
 const record=(subject,subjectId,name,detail,actor)=>db.prepare('INSERT INTO account_structure_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),subject,subjectId,name,JSON.stringify(detail),actor,stamp());
 const locations=()=>db.prepare('SELECT * FROM account_locations ORDER BY code').all();
 const functions=()=>db.prepare('SELECT * FROM account_functions ORDER BY code').all();
 const view=row=>({id:row.id,code:row.code,name:row.name,status:row.status,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at});
 const find=(table,key,missing)=>{const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key);if(!row)fail(404,missing);return row;};
 const pairRow=key=>{const row=db.prepare('SELECT p.*,l.code AS location_code,l.name AS location_name,l.status AS location_status,f.code AS function_code,f.name AS function_name,f.status AS function_status FROM account_pairs p JOIN account_locations l ON l.id=p.location_id JOIN account_functions f ON f.id=p.function_id WHERE p.id=?').get(key);if(!row)fail(404,'Account pair not found');return row;};
 // Counted in one grouped pass rather than once per row, so a long account list
 // stays a bounded number of indexed statements.
 const linkCounts=()=>new Map(db.prepare('SELECT pair_id,COUNT(*) AS n FROM account_designation_links GROUP BY pair_id').all().map(r=>[r.pair_id,r.n]));
 const pairCounts=column=>new Map(db.prepare(`SELECT ${column} AS key,COUNT(*) AS n FROM account_pairs GROUP BY ${column}`).all().map(r=>[r.key,r.n]));
 const pairView=(row,counts)=>({id:row.id,code:row.code,status:row.status,version:row.version,locationId:row.location_id,locationCode:row.location_code,locationName:row.location_name,locationStatus:row.location_status,functionId:row.function_id,functionCode:row.function_code,functionName:row.function_name,functionStatus:row.function_status,linkedDesignations:(counts||linkCounts()).get(row.id)||0,createdAt:row.created_at,updatedAt:row.updated_at,open:row.status==='Active'&&row.location_status==='Active'&&row.function_status==='Active'});
 const pairRows=(where=[],params=[])=>db.prepare('SELECT p.*,l.code AS location_code,l.name AS location_name,l.status AS location_status,f.code AS function_code,f.name AS function_name,f.status AS function_status FROM account_pairs p JOIN account_locations l ON l.id=p.location_id JOIN account_functions f ON f.id=p.function_id'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY p.code').all(...params);
 const counts=()=>({locations:db.prepare('SELECT COUNT(*) AS n FROM account_locations').get().n,activeLocations:db.prepare("SELECT COUNT(*) AS n FROM account_locations WHERE status='Active'").get().n,functions:db.prepare('SELECT COUNT(*) AS n FROM account_functions').get().n,activeFunctions:db.prepare("SELECT COUNT(*) AS n FROM account_functions WHERE status='Active'").get().n,pairs:db.prepare('SELECT COUNT(*) AS n FROM account_pairs').get().n,activePairs:db.prepare("SELECT COUNT(*) AS n FROM account_pairs WHERE status='Active'").get().n,linkedDesignations:db.prepare('SELECT COUNT(*) AS n FROM account_designation_links').get().n});

 // Stored allocation facts must be exact integer cents that already reconcile to
 // their posted gift before any rollup is published.
 function assertLedgerIntegrity(){
  if(db.prepare(ACCOUNT_STRUCTURE_QUERIES.allocationIntegrity).get().n)fail(503,'Stored gift allocations must be exact positive integer cents against a text designation.');
  if(db.prepare(ACCOUNT_STRUCTURE_QUERIES.giftReconciliation).get().n)fail(503,'Stored posted gift allocations do not reconcile to their gift amount.');
 }
 function ledgerTotals(){
  assertLedgerIntegrity();
  const posted=db.prepare(ACCOUNT_STRUCTURE_QUERIES.postedGifts).get(),totals=db.prepare(ACCOUNT_STRUCTURE_QUERIES.totals).get();
  return {postedGifts:posted.gifts,postedGiftCents:exact(posted.cents),allocationGifts:totals.gifts,allocations:totals.allocations,allocationCents:exact(totals.cents),linkedCents:exact(totals.linked_cents),unlinkedCents:exact(totals.unlinked_cents),linkedDesignations:totals.linked_designations,unlinkedDesignations:totals.unlinked_designations};
 }
 const directCents=()=>new Map(db.prepare(ACCOUNT_STRUCTURE_QUERIES.byDesignation).all().map(r=>[r.key,{cents:exact(r.cents),allocations:r.allocations,gifts:r.gifts}]));

 // O(n) depth with explicit cycle containment: corrupt ancestry is reported, never
 // followed. The native designation schema already refuses cycles on write.
 function hierarchy(){
  const rows=list('designations'),byId=new Map(rows.map(r=>[r.id,r])),depth=new Map(),cycles=new Set(),children=new Map();
  for(const row of rows){const parent=byId.has(row.parentId)?row.parentId:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(row.id);}
  for(const start of rows){
   if(depth.has(start.id)||cycles.has(start.id))continue;
   const path=[],onPath=new Set();let node=start.id,base=null;
   for(;;){
    if(depth.has(node)){base=depth.get(node);break;}
    if(cycles.has(node)||onPath.has(node)){base=null;break;}
    onPath.add(node);path.push(node);
    const parent=byId.get(node)?.parentId;
    if(!parent||!byId.has(parent)){base=-1;break;}
    node=parent;
   }
   if(base===null){for(const key of path)cycles.add(key);continue;}
   let level=base+1;for(let i=path.length-1;i>=0;i--){depth.set(path[i],level);level++;}
  }
  return {rows,byId,children,depth,cycles};
 }
 // Subtree totals nest without duplication: every allocation belongs to exactly one
 // designation's direct total, so a parent's subtree total is the sum of its own
 // subtree only. Subtree values overlap ancestors by design and are never summed
 // across levels; only root subtree totals add up to the ledger.
 function tree(){
  const h=hierarchy(),direct=directCents(),links=new Map(db.prepare('SELECT designation_id,pair_id,version,designation_version,linked_at,updated_at FROM account_designation_links').all().map(r=>[r.designation_id,r]));
  const order=[...h.rows].filter(r=>!h.cycles.has(r.id)).sort((a,b)=>(h.depth.get(b.id)??0)-(h.depth.get(a.id)??0));
  const subtree=new Map(),subtreeAllocations=new Map();
  for(const row of h.rows){subtree.set(row.id,direct.get(row.id)?.cents??0);subtreeAllocations.set(row.id,direct.get(row.id)?.allocations??0);}
  for(const row of order){const parent=row.parentId;if(!parent||!h.byId.has(parent)||h.cycles.has(parent))continue;subtree.set(parent,subtree.get(parent)+subtree.get(row.id));subtreeAllocations.set(parent,subtreeAllocations.get(parent)+subtreeAllocations.get(row.id));}
  const roots=h.rows.filter(r=>!h.cycles.has(r.id)&&(!r.parentId||!h.byId.has(r.parentId)));
  const descendants=new Map();for(const row of h.rows)descendants.set(row.id,0);
  for(const row of order){const parent=row.parentId;if(!parent||!h.byId.has(parent)||h.cycles.has(parent))continue;descendants.set(parent,descendants.get(parent)+descendants.get(row.id)+1);}
  return {...h,direct,links,subtree,subtreeAllocations,descendants,roots,rootSubtreeCents:roots.reduce((n,r)=>n+subtree.get(r.id),0),cycleCents:[...h.cycles].reduce((n,key)=>n+(direct.get(key)?.cents??0),0),maxDepth:h.depth.size?Math.max(...h.depth.values()):0};
 }

 // One designation's ancestry, walked by indexed lookup rather than by loading the
 // whole tree: a corrupt chain is refused, never followed.
 function assertAncestry(designation){
  const seen=new Set([designation.id]);let parent=designation.parentId;
  for(let steps=0;parent;steps++){
   if(seen.has(parent)||steps>512)fail(409,'This designation sits in an inconsistent parent and child chain. Correct the hierarchy before linking it to an account');
   seen.add(parent);
   let next;try{next=get('designations',parent).parentId;}catch(e){if(e.status===404)return;throw e;}
   parent=next;
  }
 }
 function rollup(groupBy){
  const totals=ledgerTotals(),query=groupBy==='location'?ACCOUNT_STRUCTURE_QUERIES.byLocation:groupBy==='function'?ACCOUNT_STRUCTURE_QUERIES.byFunction:ACCOUNT_STRUCTURE_QUERIES.byPair;
  const raw=db.prepare(query).all(),groupCount=raw.length;
  const within=groupCount<=ACCOUNT_STRUCTURE_LIMITS.groups;
  const owners=!within?null:new Map((groupBy==='pair'?pairRows():groupBy==='location'?locations():functions()).map(r=>[r.id,r]));
  const spread=!within?null:groupBy==='location'?pairCounts('location_id'):groupBy==='function'?pairCounts('function_id'):null;
  const decorate=row=>{
   const cents=exact(row.cents),base={key:row.key,gifts:row.gifts,allocations:row.allocations,designations:row.designations,cents},owner=owners.get(row.key);
   if(groupBy==='location')return {...base,code:owner.code,name:owner.name,status:owner.status,pairCount:spread.get(row.key)||0};
   if(groupBy==='function')return {...base,code:owner.code,name:owner.name,status:owner.status,locationCount:spread.get(row.key)||0};
   return {...base,code:owner.code,name:owner.location_name+' · '+owner.function_name,status:owner.status,locationId:owner.location_id,locationCode:owner.location_code,locationName:owner.location_name,functionId:owner.function_id,functionCode:owner.function_code,functionName:owner.function_name};
  };
  const groups=within?raw.map(decorate):null;
  const groupCents=raw.reduce((n,row)=>n+exact(row.cents),0),groupAllocations=raw.reduce((n,row)=>n+row.allocations,0);
  const reconciliation={allocationsMatchPostedGifts:totals.allocationCents===totals.postedGiftCents,groupCentsMatchLinkedCents:groupCents===totals.linkedCents,groupAllocationsMatchLinked:groupAllocations===totals.allocations-db.prepare(`${ALLOCATION} SELECT COUNT(*) AS n FROM allocation LEFT JOIN account_designation_links l ON l.designation_id=allocation.designation_id WHERE l.designation_id IS NULL`).get().n,linkedAndUnlinkedMatchLedger:totals.linkedCents+totals.unlinkedCents===totals.allocationCents,duplicatedCents:groupCents-totals.linkedCents};
  reconciliation.reconciled=reconciliation.allocationsMatchPostedGifts&&reconciliation.groupCentsMatchLinkedCents&&reconciliation.groupAllocationsMatchLinked&&reconciliation.linkedAndUnlinkedMatchLedger&&reconciliation.duplicatedCents===0;
  return {groupBy,totals,groups,groupCount,groupCents,groupLimit:ACCOUNT_STRUCTURE_LIMITS.groups,reconciliation,scope:'Posted gift allocations only, in exact integer cents. A function that serves several locations produces one account per location, so each allocation is counted once. Voided gifts are excluded and no revenue is created, moved or duplicated here.'};
 }

 app.get('/api/account-structure',action((req,res)=>{z.object({}).strict().parse(req.query);res.json({locations:locations().map(view),functions:functions().map(view),counts:counts(),limits:ACCOUNT_STRUCTURE_LIMITS,canManage:req.user.role==='admin',scope:'Locations are unique. One function may serve many locations; every location/function pair is one unique account. Account structure grants no permission and no consent.'});}));
 app.get('/api/account-structure/pairs',action((req,res)=>{
  const q=z.object({locationId:uuid.optional(),functionId:uuid.optional(),status:lifecycle.optional(),limit:z.coerce.number().int().min(1).max(ACCOUNT_STRUCTURE_LIMITS.page).default(100),offset:z.coerce.number().int().min(0).max(1e6).default(0)}).strict().parse(req.query);
  const where=[],params=[];if(q.locationId){where.push('p.location_id=?');params.push(q.locationId);}if(q.functionId){where.push('p.function_id=?');params.push(q.functionId);}if(q.status){where.push('p.status=?');params.push(q.status);}
  const rows=pairRows(where,params),counts=linkCounts();res.json({pairs:rows.slice(q.offset,q.offset+q.limit).map(row=>pairView(row,counts)),matched:rows.length,offset:q.offset,limit:q.limit});
 }));
 app.get('/api/account-structure/rollups',action((req,res)=>{const q=z.object({groupBy:z.enum(['location','function','pair']).default('location')}).strict().parse(req.query);res.json(rollup(q.groupBy));}));
 app.get('/api/account-structure/history',action((req,res)=>{
  const q=z.object({subject:z.enum(['location','function','pair','designation']).optional(),subjectId:z.string().min(1).max(100).optional(),limit:z.coerce.number().int().min(1).max(ACCOUNT_STRUCTURE_LIMITS.history).default(50)}).strict().parse(req.query);
  const where=[],params=[];if(q.subject){where.push('subject=?');params.push(q.subject);}if(q.subjectId){where.push('subject_id=?');params.push(q.subjectId);}
  const rows=db.prepare('SELECT * FROM account_structure_history'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY at DESC,rowid DESC LIMIT ?').all(...params,q.limit);
  res.json({history:rows.map(r=>({id:r.id,subject:r.subject,subjectId:r.subject_id,action:r.action,detail:JSON.parse(r.detail),actor:r.actor,at:r.at})),limit:q.limit,retained:'Account structure history is append-only and retained through retirement.'});
 }));
 app.get('/api/account-structure/designations',action((req,res)=>{
  const q=z.object({locationId:uuid.optional(),functionId:uuid.optional(),pairId:uuid.optional(),link:z.enum(['All','Linked','Unlinked']).default('All'),search:z.string().trim().max(120).optional(),limit:z.coerce.number().int().min(1).max(ACCOUNT_STRUCTURE_LIMITS.page).default(100),offset:z.coerce.number().int().min(0).max(1e6).default(0)}).strict().parse(req.query);
  assertLedgerIntegrity();
  const t=tree(),pairs=new Map(pairRows().map(row=>[row.id,row]));
  const allowed=q.locationId||q.functionId||q.pairId?new Set([...pairs.values()].filter(p=>(!q.pairId||p.id===q.pairId)&&(!q.locationId||p.location_id===q.locationId)&&(!q.functionId||p.function_id===q.functionId)).map(p=>p.id)):null;
  const term=q.search?q.search.toLowerCase():'';
  const rows=t.rows.filter(row=>{
   const link=t.links.get(row.id);
   if(q.link==='Linked'&&!link)return false;if(q.link==='Unlinked'&&link)return false;
   if(allowed&&(!link||!allowed.has(link.pair_id)))return false;
   if(term&&!`${row.name} ${row.accountCode||''} ${row.school||''}`.toLowerCase().includes(term))return false;
   return true;
  }).sort((a,b)=>(a.accountCode||'').localeCompare(b.accountCode||'')||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const project=row=>{const link=t.links.get(row.id),pair=link?pairs.get(link.pair_id):null,direct=t.direct.get(row.id);
   return {id:row.id,name:row.name,accountCode:row.accountCode||'',school:row.school||'',parentId:row.parentId||null,parentName:row.parentId&&t.byId.has(row.parentId)?t.byId.get(row.parentId).name:null,version:row.version,depth:t.depth.has(row.id)?t.depth.get(row.id):null,childCount:(t.children.get(row.id)||[]).length,descendantCount:t.descendants.get(row.id)??0,hierarchyIssue:t.cycles.has(row.id),
    directCents:direct?.cents??0,directAllocations:direct?.allocations??0,directGifts:direct?.gifts??0,subtreeCents:t.cycles.has(row.id)?null:t.subtree.get(row.id),subtreeAllocations:t.cycles.has(row.id)?null:t.subtreeAllocations.get(row.id),
    account:pair?{pairId:pair.id,pairCode:pair.code,pairStatus:pair.status,linkVersion:link.version,designationVersionAtLink:link.designation_version,linkedAt:link.linked_at,locationId:pair.location_id,locationCode:pair.location_code,locationName:pair.location_name,locationStatus:pair.location_status,functionId:pair.function_id,functionCode:pair.function_code,functionName:pair.function_name,functionStatus:pair.function_status}:null};};
  const page=rows.slice(q.offset,q.offset+q.limit).map(project);
  res.json({designations:page,matched:rows.length,returned:page.length,offset:q.offset,limit:q.limit,total:t.rows.length,
   matchedTotals:{directCents:rows.reduce((n,row)=>n+(t.direct.get(row.id)?.cents??0),0),directAllocations:rows.reduce((n,row)=>n+(t.direct.get(row.id)?.allocations??0),0)},
   hierarchy:{roots:t.roots.length,maxDepth:t.maxDepth,cycles:t.cycles.size,rootSubtreeCents:t.rootSubtreeCents,cycleCents:t.cycleCents},
   scope:'Direct values are this designation\'s own allocations and add up without overlap. Subtree values include descendants and must never be summed across levels.'});
 }));

 const createEntity=(req,res,{table,subject,code,name,limit,exists,made})=>{
  const result=transaction(()=>{
   manage(req);
   if(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n>=limit)fail(409,`This workspace holds ${limit} ${subject}s. Retire an unused ${subject} before adding another`);
   if(db.prepare(`SELECT 1 FROM ${table} WHERE code=?`).get(code))fail(409,exists.code);
   if(db.prepare(`SELECT 1 FROM ${table} WHERE lower(name)=lower(?)`).get(name))fail(409,exists.name);
   const key=randomUUID(),now=stamp();
   db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?)`).run(key,code,name,'Active',1,now,now);
   record(subject,key,made,{code,name,status:'Active'},req.user.id);
   audit(req.user,'create_account_'+subject,null,key,{subject,code,name,status:'Active'});
   manage(req);return view(find(table,key,'Not found'));
  });
  res.status(201).json({[subject]:result});
 };
 // Retirement never unlinks a designation and never touches a posted gift: retired
 // locations and functions simply stop accepting new accounts and new links, while
 // their historical allocations keep reporting under the same account.
 const changeStatus=(req,res,{table,subject,body})=>{
  const result=transaction(()=>{
   manage(req);const row=find(table,req.params.id,subject[0].toUpperCase()+subject.slice(1)+' not found');
   if(row.version!==body.version)fail(409,'This record changed. Reload its current version');
   if(row.status===body.status)fail(409,'This record already has that status');
   db.prepare(`UPDATE ${table} SET status=?,version=version+1,updated_at=? WHERE id=?`).run(body.status,stamp(),row.id);
   record(subject,row.id,body.status==='Retired'?'retire':'reinstate',{code:row.code,name:row.name,previousStatus:row.status,status:body.status,reason:body.reason},req.user.id);
   audit(req.user,(body.status==='Retired'?'retire':'reinstate')+'_account_'+subject,null,row.id,{subject,code:row.code,previousStatus:row.status,status:body.status,reason:body.reason,historyRetained:true});
   manage(req);return view(find(table,row.id,'Not found'));
  });
  res.json({[subject]:result,retained:'Existing links, posted gifts and rollup history are unchanged.'});
 };

 app.post('/api/account-structure/locations',csrf,admin,action((req,res)=>{const p=z.object({code:locationCode,name:label}).strict().parse(req.body);createEntity(req,res,{table:'account_locations',subject:'location',code:p.code,name:p.name,limit:ACCOUNT_STRUCTURE_LIMITS.locations,exists:{code:'That three-digit location code is already in use',name:'That location name is already in use'},made:'create'});}));
 app.post('/api/account-structure/locations/:id/status',csrf,admin,action((req,res)=>{uuid.parse(req.params.id);const body=z.object({version,status:lifecycle,reason}).strict().parse(req.body);changeStatus(req,res,{table:'account_locations',subject:'location',body});}));
 app.post('/api/account-structure/functions',csrf,admin,action((req,res)=>{const p=z.object({code:functionCode,name:label}).strict().parse(req.body);createEntity(req,res,{table:'account_functions',subject:'function',code:p.code,name:p.name,limit:ACCOUNT_STRUCTURE_LIMITS.functions,exists:{code:'That four-digit function code is already in use',name:'That function name is already in use'},made:'create'});}));
 app.post('/api/account-structure/functions/:id/status',csrf,admin,action((req,res)=>{uuid.parse(req.params.id);const body=z.object({version,status:lifecycle,reason}).strict().parse(req.body);changeStatus(req,res,{table:'account_functions',subject:'function',body});}));
 // One function may be paired with many locations; each pair is one unique account.
 app.post('/api/account-structure/pairs',csrf,admin,action((req,res)=>{
  const p=z.object({locationId:uuid,locationVersion:version,functionId:uuid,functionVersion:version}).strict().parse(req.body);
  const result=transaction(()=>{
   manage(req);
   const location=find('account_locations',p.locationId,'Location not found'),fn=find('account_functions',p.functionId,'Function not found');
   if(location.version!==p.locationVersion||fn.version!==p.functionVersion)fail(409,'The location or function changed. Reload current versions before creating the account');
   if(location.status!=='Active')fail(409,'Retired locations cannot take new accounts. Reinstate the location first');
   if(fn.status!=='Active')fail(409,'Retired functions cannot take new accounts. Reinstate the function first');
   if(db.prepare('SELECT COUNT(*) AS n FROM account_pairs').get().n>=ACCOUNT_STRUCTURE_LIMITS.pairs)fail(409,`This workspace holds ${ACCOUNT_STRUCTURE_LIMITS.pairs} accounts. Retire an unused account before adding another`);
   if(db.prepare('SELECT 1 FROM account_pairs WHERE location_id=? AND function_id=?').get(location.id,fn.id))fail(409,'That location and function already have an account');
   const key=randomUUID(),code=location.code+'-'+fn.code,now=stamp();
   db.prepare('INSERT INTO account_pairs VALUES(?,?,?,?,?,?,?,?)').run(key,location.id,fn.id,code,'Active',1,now,now);
   record('pair',key,'create',{code,locationId:location.id,locationCode:location.code,functionId:fn.id,functionCode:fn.code},req.user.id);
   audit(req.user,'create_account_pair',null,key,{code,locationCode:location.code,functionCode:fn.code,status:'Active'});
   manage(req);return pairView(pairRow(key));
  });
  res.status(201).json({pair:result});
 }));
 app.post('/api/account-structure/pairs/:id/status',csrf,admin,action((req,res)=>{uuid.parse(req.params.id);const body=z.object({version,status:lifecycle,reason}).strict().parse(req.body);
  const result=transaction(()=>{
   manage(req);const row=pairRow(req.params.id);
   if(row.version!==body.version)fail(409,'This account changed. Reload its current version');
   if(row.status===body.status)fail(409,'This account already has that status');
   if(body.status==='Active'&&(row.location_status!=='Active'||row.function_status!=='Active'))fail(409,'Reinstate the location and function before reopening this account');
   db.prepare('UPDATE account_pairs SET status=?,version=version+1,updated_at=? WHERE id=?').run(body.status,stamp(),row.id);
   record('pair',row.id,body.status==='Retired'?'retire':'reinstate',{code:row.code,previousStatus:row.status,status:body.status,reason:body.reason,linkedDesignations:db.prepare('SELECT COUNT(*) AS n FROM account_designation_links WHERE pair_id=?').get(row.id).n},req.user.id);
   audit(req.user,(body.status==='Retired'?'retire':'reinstate')+'_account_pair',null,row.id,{code:row.code,previousStatus:row.status,status:body.status,reason:body.reason,historyRetained:true});
   manage(req);return pairView(pairRow(row.id));
  });
  res.json({pair:result,retained:'Existing links, posted gifts and rollup history are unchanged.'});
 }));
 app.post('/api/account-structure/designations/:id/link',csrf,admin,action((req,res)=>{
  const p=z.object({designationVersion:version,pairId:uuid,pairVersion:version,reason}).strict().parse(req.body);
  const result=transaction(()=>{
   manage(req);
   const designation=get('designations',req.params.id);
   if(designation.version!==p.designationVersion)fail(409,'This designation changed. Reload its current version before linking');
   assertAncestry(designation);
   const pair=pairRow(p.pairId);
   if(pair.version!==p.pairVersion)fail(409,'This account changed. Reload its current version before linking');
   if(pair.status!=='Active'||pair.location_status!=='Active'||pair.function_status!=='Active')fail(409,'This account is retired. Reinstate it or choose an active location and function');
   const existing=db.prepare('SELECT * FROM account_designation_links WHERE designation_id=?').get(designation.id);
   if(existing?.pair_id===pair.id)fail(409,'This designation is already linked to that account');
   const now=stamp();
   if(existing){db.prepare('UPDATE account_designation_links SET pair_id=?,designation_version=?,version=version+1,updated_at=?,actor=? WHERE designation_id=?').run(pair.id,designation.version,now,req.user.id,designation.id);record('designation',designation.id,'relink',{fromPairId:existing.pair_id,pairId:pair.id,pairCode:pair.code,designationVersion:designation.version,reason:p.reason},req.user.id);}
   else {db.prepare('INSERT INTO account_designation_links VALUES(?,?,?,?,?,?,?)').run(designation.id,pair.id,designation.version,1,now,now,req.user.id);record('designation',designation.id,'link',{pairId:pair.id,pairCode:pair.code,designationVersion:designation.version,reason:p.reason},req.user.id);}
   audit(req.user,existing?'relink_account_designation':'link_account_designation','designations',designation.id,{pairId:pair.id,pairCode:pair.code,locationCode:pair.location_code,functionCode:pair.function_code,previousPairId:existing?.pair_id??null,designationVersion:designation.version,reason:p.reason,revenueChanged:false});
   manage(req);
   const saved=db.prepare('SELECT * FROM account_designation_links WHERE designation_id=?').get(designation.id);
   if(!saved||saved.pair_id!==pair.id)fail(409,'The account link changed before it was saved');
   if(get('designations',designation.id).version!==p.designationVersion)fail(409,'This designation changed before the link was saved');
   return {designationId:designation.id,designationName:designation.name,accountCode:designation.accountCode||'',pair:pairView(pairRow(pair.id)),version:saved.version,linkedAt:saved.linked_at,updatedAt:saved.updated_at};
  });
  res.status(201).json({link:result,retained:'Designation fields, hierarchy and posted allocations are unchanged.'});
 }));
 app.post('/api/account-structure/designations/:id/unlink',csrf,admin,action((req,res)=>{
  const p=z.object({version,reason}).strict().parse(req.body);
  const result=transaction(()=>{
   manage(req);
   const link=db.prepare('SELECT * FROM account_designation_links WHERE designation_id=?').get(req.params.id);
   if(!link)fail(404,'This designation is not linked to an account');
   if(link.version!==p.version)fail(409,'This link changed. Reload its current version');
   const pair=pairRow(link.pair_id);
   db.prepare('DELETE FROM account_designation_links WHERE designation_id=?').run(req.params.id);
   record('designation',req.params.id,'unlink',{pairId:pair.id,pairCode:pair.code,previousVersion:link.version,reason:p.reason},req.user.id);
   audit(req.user,'unlink_account_designation','designations',req.params.id,{pairId:pair.id,pairCode:pair.code,reason:p.reason,revenueChanged:false,historyRetained:true});
   manage(req);
   if(db.prepare('SELECT 1 FROM account_designation_links WHERE designation_id=?').get(req.params.id))fail(409,'The account link changed before it was removed');
   return {designationId:req.params.id,previousPairCode:pair.code};
  });
  res.json({unlinked:result,retained:'Posted allocations stay exactly where they were; the removal is retained in account structure history.'});
 }));

 return {
  workspaceData:req=>({accountStructure:{...counts(),canManage:req.user.role==='admin'}}),
  validateDeletion:(collection,record)=>{if(collection!=='designations')return;
   if(db.prepare('SELECT 1 FROM account_designation_links WHERE designation_id=?').get(record.id))fail(409,'This designation is linked to a location/function account. Remove the account link first');
   if(db.prepare("SELECT 1 FROM account_structure_history WHERE subject='designation' AND subject_id=?").get(record.id))fail(409,'Retained account structure history protects this designation from deletion');
  },
  rollup,ledgerTotals
 };
}
