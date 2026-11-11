import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRecordLookups,RECORD_LOOKUP_INDEXES} from '../server/recordLookups.js';

// Shared by the SQLite and PostgreSQL equivalence tests. Each replaced scan is restated
// here exactly as it was written in validate(), and compared with the indexed lookup on
// stored shapes that the two engines extract differently: a reference stored as a number
// versus a string, whitespace, case, NULL versus empty versus missing, JSON-looking text,
// objects and arrays whose JSON text equals a probe, and Unicode normalisation forms.
export const ORIGINAL_SCANS=[
 {collection:'gifts',path:'pledgeId',site:"list('gifts').filter(g=>…g.pledgeId===pledge.id…)",original:(g,v)=>g.pledgeId===v},
 {collection:'gifts',path:'grantId',site:"list('gifts').filter(g=>…g.grantId===grant.id…)",original:(g,v)=>g.grantId===v},
 {collection:'gifts',path:'acknowledgment.communicationId',site:"list('gifts').some(g=>g.acknowledgment?.communicationId===old.id)",original:(g,v)=>g.acknowledgment?.communicationId===v},
 {collection:'shiftReservations',path:'shiftId',site:"list('shiftReservations').filter(r=>r.shiftId===…)",original:(r,v)=>r.shiftId===v},
 {collection:'shiftReservations',path:'constituentId',site:"list('shiftReservations').filter/some(r=>r.constituentId===…)",original:(r,v)=>r.constituentId===v},
 {collection:'volunteerTime',path:'volunteerId',site:"list('volunteerTime').some(t=>t.volunteerId===old.id)",original:(t,v)=>t.volunteerId===v}
];

const SHAPES=['p-1','p-1','P-1',' p-1','p-1 ','5',5,5.5,'5.5','1',1,true,false,'true','0',0,null,'','null','{"id":"p-1"}',{id:'p-1'},['p-1'],'["p-1"]','é-ref','e\u0301-ref','🎗️ ref',"quote'ref",'back\\slash','x'.repeat(100),'long-'+'y'.repeat(95),undefined];
export const PROBES=[...new Set(SHAPES.filter(v=>v===null||typeof v!=='object').concat(['missing-anywhere','P-1',' p-1','p-1 ','["p-1"]','{"id":"p-1"}','{"id": "p-1"}','é-ref','e\u0301-ref','5.0','true','1',1,5,true,null,undefined,'']))];

const put=(db,collection,record)=>db.prepare('INSERT INTO records VALUES(?,?,?)').run(collection,record.id,JSON.stringify(record));

// Writes every shape into the field under test, interleaved across collections so rowid
// order is not collection order, plus decoys carrying the same values in other collections.
export function writeEdgeCases(db){
 let n=0;
 for(const value of SHAPES){
  const set=(record,path)=>{if(value===undefined)return record;const keys=path.split('.');let node=record;for(const k of keys.slice(0,-1))node=node[k]={...node[k]};node[keys.at(-1)]=value;return record;};
  const id=()=>`edge-${String(n++).padStart(3,'0')}-${randomUUID()}`;
  put(db,'gifts',set(set({id:id(),amount:100,status:n%3?'Posted':'Voided',acknowledgment:null},'pledgeId'),'grantId'));
  put(db,'shiftReservations',set(set({id:id(),status:'Reserved'},'shiftId'),'constituentId'));
  put(db,'gifts',set({id:id(),amount:200,status:'Posted',acknowledgment:{}},'acknowledgment.communicationId'));
  put(db,'volunteerTime',set({id:id(),hours:1},'volunteerId'));
  // Decoys: identical values in collections the lookup must never return.
  put(db,'pledges',set(set({id:id()},'pledgeId'),'shiftId'));
  put(db,'communications',set({id:id()},'volunteerId'));
 }
 // Acknowledgment shapes that are not an object holding communicationId.
 for(const acknowledgment of ['p-1',['p-1'],{communicationId:null},{communicationId:{id:'p-1'}},{other:'p-1'},null])put(db,'gifts',{id:`edge-ack-${n++}-${randomUUID()}`,amount:1,status:'Posted',acknowledgment});
}

export function assertLookupEquivalence(db){
 const list=c=>db.prepare('SELECT data FROM records WHERE collection=? ORDER BY rowid').all(c).map(r=>JSON.parse(r.data));
 const listWhere=createRecordLookups({db,list,readRecord:(c,value)=>JSON.parse(value)});
 let comparisons=0,nonEmpty=0;
 for(const scan of ORIGINAL_SCANS){
  assert.ok(RECORD_LOOKUP_INDEXES[scan.collection][scan.path],`${scan.collection}.${scan.path} has a declared index`);
  const all=list(scan.collection);
  for(const probe of PROBES){
   const expected=all.filter(r=>scan.original(r,probe));
   const actual=listWhere(scan.collection,scan.path,probe);
   assert.deepEqual(actual,expected,`${scan.site} with ${JSON.stringify(probe)} (${typeof probe})`);
   comparisons++;if(expected.length)nonEmpty++;
  }
 }
 return {comparisons,nonEmpty};
}
