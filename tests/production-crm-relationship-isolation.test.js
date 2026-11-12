import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const root=new URL('../',import.meta.url),flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function harness(path){
 let index=0,state=[],effects=[],cleanups=[];
 const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);}};
 const module={exports:{}},code=transformSync(readFileSync(new URL(path,root),'utf8'),{loader:'jsx',format:'cjs'}).code;
 new Function('require','module','exports',code)(id=>id==='react'?mock:{__esModule:true,default:()=>null},module,module.exports);
 return {render(props){index=0;effects=[];return module.exports.default(props);},commit(){for(const cleanup of cleanups)cleanup?.();cleanups=effects.map(effect=>effect());}};
}
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const match=find(child,predicate);if(match)return match;}return null;};
const byForm=(tree,label)=>find(tree,node=>node.type==='form'&&node.props['aria-label']===label);
const byName=(tree,name)=>find(tree,node=>node.props?.name===name);
const byButton=(tree,label)=>find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes(label));
const html=tree=>renderToStaticMarkup(tree);
const member={identityId:'10000000-0000-4000-8000-000000000001',displayName:'Owner',role:'owner'};
const partyA={partyId:'20000000-0000-4000-8000-000000000001',partyType:'person',displayName:'Party A',status:'active',version:1};
const partyB={partyId:'20000000-0000-4000-8000-000000000002',partyType:'person',displayName:'Party B',status:'active',version:1};
const subjectFor=party=>({subjectId:party.partyId,subjectType:'party',ownerIdentityId:member.identityId,version:1});
const seeded=(party,client,onSaved=()=>{})=>({client,party,writable:true,initialRecord:party,initialContacts:[],initialSubject:subjectFor(party),initialMembers:[member],signedInIdentityId:member.identityId,onSaved});

test('selected party identity keys the relationship workspace remount',()=>{
 const source=readFileSync(new URL('src/production/CrmWorkspace.jsx',root),'utf8');
 assert.match(source,/<RelationshipWorkspace\s+key=\{selected\.partyId\}/);
});

test('switching parties clears every record-scoped draft, task, note and error state',async()=>{
 const taskId='60000000-0000-4000-8000-000000000001',noteId='70000000-0000-4000-8000-000000000001';
 const client={request:async(path,options={})=>{if(path.endsWith('/tasks'))return {task:{taskId,title:'Party A task',status:'open',ownerIdentityId:member.identityId,version:1}};if(path.endsWith('/notes'))return {note:{noteId,title:'Party A note',version:1}};throw Object.assign(new Error('Party A contact error'),{status:503});}};
 const h=harness('src/production/RelationshipWorkspace.jsx');let tree=h.render(seeded(partyA,client));
 byName(tree,'displayName').props.onChange({target:{value:'Party A draft name'}});
 for(const [name,value] of [['activitySummary','A activity'],['taskTitle','Party A task'],['noteTitle','Party A note'],['noteBody','Party A body'],['attachmentName','a.pdf'],['objectId','party-a-object'],['objectRevision','7']]){tree=h.render(seeded(partyA,client));byName(tree,name).props.onChange({target:{name,value}});}
 tree=h.render(seeded(partyA,client));find(byForm(tree,'Add contact'),node=>node.type==='input'&&node.props.required).props.onChange({target:{value:'a@example.invalid'}});
 tree=h.render(seeded(partyA,client));await byForm(tree,'Create task').props.onSubmit({preventDefault(){}});await flush();tree=h.render(seeded(partyA,client));await byForm(tree,'Write note').props.onSubmit({preventDefault(){}});await flush();
 tree=h.render(seeded(partyA,client));await byForm(tree,'Add contact').props.onSubmit({preventDefault(){}});await flush();
 tree=h.render(seeded(partyB,client));h.commit();tree=h.render(seeded(partyB,client));const markup=html(tree);
 assert.match(markup,/Party B/);assert.doesNotMatch(markup,/Party A task|Party A note|Party A contact error|Party A draft name|A activity|Party A body|a\.pdf|party-a-object/);
 assert.equal(byButton(tree,'Start task'),null);assert.equal(byButton(tree,'Save note revision'),null);
 for(const name of ['activitySummary','taskTitle','noteTitle','noteBody','attachmentName','objectId'])assert.equal(byName(tree,name).props.value,'',name);
 assert.equal(byName(tree,'objectRevision').props.value,'1');
});

test('late Party A load cannot overwrite loaded Party B',async()=>{
 const calls=[];const client={request(path,options={}){const request={path,signal:options.signal,...deferred()};calls.push(request);return request.promise;}};
 const h=harness('src/production/RelationshipWorkspace.jsx');const props=party=>({client,party,writable:true,signedInIdentityId:member.identityId});
 h.render(props(partyA));h.commit();assert.equal(calls.length,4);
 h.render(props(partyB));h.commit();assert.equal(calls.length,8);
 const resolveGroup=(group,party)=>{for(const request of group){if(request.path.endsWith('/contacts?limit=100'))request.resolve({contacts:[]});else if(request.path==='/crm/members')request.resolve({members:[member]});else if(request.path.startsWith('/crm/subjects/'))request.resolve({subject:subjectFor(party)});else request.resolve({party});}};
 resolveGroup(calls.slice(4),partyB);await flush();let tree=h.render(props(partyB));assert.match(html(tree),/Party B/);
 resolveGroup(calls.slice(0,4),partyA);await flush();tree=h.render(props(partyB));assert.match(html(tree),/Party B/);assert.doesNotMatch(html(tree),/Party A/);
});

test('late Party A mutations and onSaved cannot affect Party B or expose A-ID actions',async()=>{
 const partySave=deferred(),taskSave=deferred(),calls=[],saved=[];
 const taskId='60000000-0000-4000-8000-000000000001';
 const client={request(path,options={}){calls.push([path,options]);if(path===`/crm/parties/${partyA.partyId}`)return partySave.promise;if(path===`/crm/subjects/${partyA.partyId}/tasks`)return taskSave.promise;if(path===`/crm/subjects/${partyB.partyId}/tasks`)return Promise.resolve({task:{taskId:'60000000-0000-4000-8000-000000000002',title:'Party B task',status:'open',ownerIdentityId:member.identityId,version:1}});throw new Error(`unexpected request ${path}`);}};
 const h=harness('src/production/RelationshipWorkspace.jsx'),onSaved=value=>saved.push(value);let tree=h.render(seeded(partyA,client,onSaved));const staleContactSubmit=byForm(tree,'Add contact').props.onSubmit;
 const partyPending=byForm(tree,'Edit relationship').props.onSubmit({preventDefault(){}});tree=h.render(seeded(partyA,client,onSaved));byName(tree,'taskTitle').props.onChange({target:{name:'taskTitle',value:'Late A task'}});tree=h.render(seeded(partyA,client,onSaved));const taskPending=byForm(tree,'Create task').props.onSubmit({preventDefault(){}});
 tree=h.render(seeded(partyB,client,onSaved));h.commit();tree=h.render(seeded(partyB,client,onSaved));assert.doesNotMatch(html(tree),/Saving confirmed changes|Late A task/);
 const postSwitchStart=calls.length;await staleContactSubmit({preventDefault(){}});byName(tree,'taskTitle').props.onChange({target:{name:'taskTitle',value:'Party B task'}});tree=h.render(seeded(partyB,client,onSaved));await byForm(tree,'Create task').props.onSubmit({preventDefault(){}});await flush();
 assert.deepEqual(calls.slice(postSwitchStart).map(([path])=>path),[`/crm/subjects/${partyB.partyId}/tasks`]);
 partySave.resolve({party:{...partyA,displayName:'Late Party A response',version:2}});taskSave.resolve({task:{taskId,title:'Late A task',status:'open',ownerIdentityId:member.identityId,version:1}});await Promise.all([partyPending,taskPending]);await flush();
 tree=h.render(seeded(partyB,client,onSaved));const markup=html(tree);assert.match(markup,/Party B|Party B task/);assert.doesNotMatch(markup,/Late Party A response|Late A task|Relationship updated/);assert.deepEqual(saved,[]);
 assert.equal(byButton(tree,'Save note revision'),null);
 const afterSwitch=calls.slice(postSwitchStart).map(([path])=>path);assert.equal(afterSwitch.some(path=>path.includes(taskId)||path.includes(partyA.partyId)),false);
});
