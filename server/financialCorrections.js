import {randomUUID} from 'node:crypto';

// Financial source changes are distinct from note edits and dedicated year assignment.
export const financialGiftFields = ['constituentId','amount','type','method','date','campaignId','allocations','externalRef','softCreditId','pledge','pledgeId','grantId','giftKind'];
const nullable=new Set(['campaignId','softCreditId','pledgeId','grantId']);
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
function fieldValue(record,key){
 if(nullable.has(key))return record[key]??null;
 if(key==='externalRef'||key==='pledge')return record[key]??'';
 if(key==='giftKind')return record[key]??'One-time';
 if(key==='allocations')return [...(record[key]||[])].sort((a,b)=>String(a.designationId).localeCompare(String(b.designationId)));
 return record[key];
}
export const changedGiftFinancialFields=(before,after)=>financialGiftFields.filter(key=>canonical(fieldValue(before,key))!==canonical(fieldValue(after,key)));

export function installFinancialCorrections(app,{db,get,audit}){
 db.exec(`CREATE TABLE IF NOT EXISTS gift_financial_corrections(
 id TEXT PRIMARY KEY,gift_id TEXT NOT NULL,from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,
 before_json TEXT NOT NULL,after_json TEXT NOT NULL,changed_fields TEXT NOT NULL,reason TEXT NOT NULL,
 actor_json TEXT NOT NULL,at TEXT NOT NULL,before_references TEXT NOT NULL,after_references TEXT NOT NULL,UNIQUE(gift_id,from_version));
 CREATE TRIGGER IF NOT EXISTS gift_corrections_no_update BEFORE UPDATE ON gift_financial_corrections BEGIN SELECT RAISE(ABORT,'Financial correction history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS gift_corrections_no_delete BEFORE DELETE ON gift_financial_corrections BEGIN SELECT RAISE(ABORT,'Financial correction history is immutable'); END;`);
 const present=row=>({id:row.id,giftId:row.gift_id,fromVersion:row.from_version,toVersion:row.to_version,before:JSON.parse(row.before_json),after:JSON.parse(row.after_json),changedFields:JSON.parse(row.changed_fields),sourceVersions:{before:JSON.parse(row.before_references),after:JSON.parse(row.after_references)},reason:row.reason,actor:JSON.parse(row.actor_json),at:row.at});
 app.get('/api/gifts/:id/corrections',(req,res)=>{get('gifts',req.params.id);res.json({corrections:db.prepare('SELECT * FROM gift_financial_corrections WHERE gift_id=? ORDER BY from_version,id').all(req.params.id).map(present)});});
 function reasonFor(before,after,reason){
  const changedFields=changedGiftFinancialFields(before,after);
  if(!changedFields.length)return {changedFields,reason:null};
  if(typeof reason!=='string'||!reason.trim()||reason.trim().length>2000){const error=new Error('Financial gift corrections require correctionReason (1–2000 characters).');error.status=400;throw error;}
  return {changedFields,reason:reason.trim()};
 }
 function references(record){
  const refs=[['constituents',record.constituentId],['constituents',record.softCreditId],['campaigns',record.campaignId],['pledges',record.pledgeId],['grants',record.grantId],...(record.allocations||[]).map(a=>['designations',a.designationId])];
  return [...new Map(refs.filter(([,id])=>id).map(([collection,id])=>[collection+':'+id,{collection,id,version:get(collection,id).version}])).values()];
 }
 // Caller encloses source write, retained revision and audit in the same transaction.
 function retain(before,after,actor,change){
  if(!change.changedFields.length)return null;
  const row={id:randomUUID(),gift_id:before.id,from_version:before.version,to_version:after.version,before_json:JSON.stringify(before),after_json:JSON.stringify(after),changed_fields:JSON.stringify(change.changedFields),reason:change.reason,actor_json:JSON.stringify({id:actor.id,name:actor.name,role:actor.role}),at:after.updatedAt,before_references:JSON.stringify(references(before)),after_references:JSON.stringify(references(after))};
  db.prepare('INSERT INTO gift_financial_corrections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.gift_id,row.from_version,row.to_version,row.before_json,row.after_json,row.changed_fields,row.reason,row.actor_json,row.at,row.before_references,row.after_references);
  audit(actor,'correct_gift_financial_facts','gifts',before.id,{correctionId:row.id,fromVersion:before.version,toVersion:after.version,changedFields:change.changedFields,reason:change.reason});
  return present(row);
 }
 return {reasonFor,retain};
}
