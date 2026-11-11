// Record lookups the database answers, so a write path no longer loads a whole
// collection to find a handful of linked records. Evidence for every index below is in
// work/index-audit.md (plans read on SQLite and PostgreSQL at buyer scale).
//
// Two rules keep this from ever disagreeing with the JavaScript it replaced:
//  1. SQL only narrows. It returns a superset of the records whose field is strictly
//     equal (===) to the string asked for, in the same rowid order, and the original
//     strict predicate still decides. A JSON string equal to the value always extracts
//     to that same text on both engines, so no qualifying record can be dropped; a
//     number stored as 5 that PostgreSQL extracts as '5' is removed by the recheck.
//  2. A value that is not a string, or a field without a declared index, falls back to
//     the full scan unchanged.

// The database is the authority for gift source-reference uniqueness. Manual gifts
// store an empty externalRef, so '' (and NULL, and any non-string value) is outside the
// index: only a non-empty JSON string is a source reference. That is exactly the set the
// removed JavaScript scan could ever match, because validated input is always a string.
export const GIFT_SOURCE_REFERENCE_INDEX='records_gift_source_reference';
const reference="json_extract(data,'$.externalRef')";
const referencePredicate=`collection='gifts' AND typeof(${reference})='text' AND ${reference}<>''`;

// collection -> field path -> index name. Partial on the collection and on the field
// being present, so each index holds only the rows it can ever serve.
export const RECORD_LOOKUP_INDEXES=Object.freeze({
 gifts:Object.freeze({pledgeId:'records_gift_pledge',grantId:'records_gift_grant','acknowledgment.communicationId':'records_gift_acknowledgment_communication'}),
 shiftReservations:Object.freeze({shiftId:'records_shift_reservation_shift',constituentId:'records_shift_reservation_constituent'}),
 volunteerTime:Object.freeze({volunteerId:'records_volunteer_time_volunteer'})
});
const extract=path=>`json_extract(data,'$.${path}')`;

export function installRecordIndexes(db){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(GIFT_SOURCE_REFERENCE_INDEX)){
  refuseDuplicateGiftSourceReferences(db);
  try{db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${GIFT_SOURCE_REFERENCE_INDEX} ON records(${reference}) WHERE ${referencePredicate}`);}
  // A duplicate written between the check and the build still refuses, and still names the gifts.
  catch(error){refuseDuplicateGiftSourceReferences(db);throw error;}
 }
 db.exec(Object.entries(RECORD_LOOKUP_INDEXES).flatMap(([collection,fields])=>Object.entries(fields).map(([path,name])=>`CREATE INDEX IF NOT EXISTS ${name} ON records(${extract(path)}) WHERE collection='${collection}' AND ${extract(path)} IS NOT NULL;`)).join('\n'));
}

// Existing duplicates are refused, never resolved: no gift is deleted, merged or re-referenced.
function refuseDuplicateGiftSourceReferences(db){
 const rows=db.prepare(`SELECT ${reference} AS ref,id FROM records WHERE ${referencePredicate} AND ${reference} IN (SELECT ${reference} FROM records WHERE ${referencePredicate} GROUP BY ${reference} HAVING count(*)>1) ORDER BY ref,id`).all();
 if(!rows.length)return;
 const groups=new Map();for(const {ref,id} of rows)groups.set(ref,[...(groups.get(ref)||[]),id]);
 const shown=[...groups].slice(0,20).map(([ref,ids])=>`${JSON.stringify(ref)} on gifts ${ids.join(', ')}`);
 const error=new Error(`Gift source references must be unique before this workspace can open. ${groups.size} reference${groups.size===1?' is':'s are'} shared: ${shown.join('; ')}${groups.size>20?`; and ${groups.size-20} more`:''}. Reconcile these gifts through reviewed financial correction; no gift was changed.`);
 error.code='WIMBLO_DUPLICATE_GIFT_SOURCE_REFERENCE';
 error.duplicateGiftSourceReferences=Object.fromEntries(groups);
 throw error;
}

// SQLite: "UNIQUE constraint failed: index 'records_gift_source_reference'".
// PostgreSQL: 23505 on constraint "records_gift_source_reference".
export const isGiftSourceReferenceConflict=error=>Boolean(error)&&(error.constraint===GIFT_SOURCE_REFERENCE_INDEX||(error.code==='23505'||error.errcode===2067||/UNIQUE constraint failed/.test(String(error.message)))&&String(error.message).includes(GIFT_SOURCE_REFERENCE_INDEX));

// A voided gift keeps its reference, so re-recording it stays refused; the message points
// at the retained correction path instead of inviting a second copy of the revenue.
export function giftSourceReferenceConflictMessage(db,gift){
 const holder=typeof gift?.externalRef==='string'?db.prepare(`SELECT data FROM records WHERE ${referencePredicate} AND ${reference}=? AND id<>?`).get(gift.externalRef,String(gift.id)):null;
 if(holder&&JSON.parse(holder.data).status==='Voided')return 'Duplicate externalRef: a voided gift keeps this source reference, so the same source cannot be recorded again. Correct recorded revenue through financial correction on the posted gift rather than voiding and re-importing it.';
 return 'Duplicate externalRef';
}

const valueAt=(record,path)=>path.split('.').reduce((node,key)=>node?.[key],record);

export function createRecordLookups({db,list,readRecord}){
 return function listWhere(collection,path,value){
  const index=RECORD_LOOKUP_INDEXES[collection]?.[path];
  if(!index||typeof value!=='string')return list(collection).filter(record=>valueAt(record,path)===value);
  return db.prepare(`SELECT data FROM records WHERE collection='${collection}' AND ${extract(path)}=? ORDER BY rowid`).all(value).map(row=>readRecord(collection,row.data)).filter(record=>valueAt(record,path)===value);
 };
}
