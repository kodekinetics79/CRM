import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const root=new URL('../',import.meta.url),flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function harness(path){let index=0,state=[],effects=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);},useMemo(fn){index++;return fn();}};const module={exports:{}},code=transformSync(readFileSync(new URL(path,root),'utf8'),{loader:'jsx',format:'cjs'}).code,require=id=>id==='react'?mock:{__esModule:true,default:()=>null};new Function('require','module','exports',code)(require,module,module.exports);return {render(props){index=0;effects=[];return module.exports.default(props);},effects:()=>effects,exports:module.exports};}
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const match=find(child,predicate);if(match)return match;}return null;};
const html=tree=>renderToStaticMarkup(tree);
const party={partyId:'20000000-0000-4000-8000-000000000001',partyType:'person',displayName:'Avery & Co',status:'active',version:3,firstName:'Avery',lastName:'Chen'};
const signedInId='10000000-0000-4000-8000-000000000001',secondId='10000000-0000-4000-8000-000000000002',members=[{identityId:signedInId,displayName:'Avery Staff',role:'staff'},{identityId:secondId,displayName:'Morgan Owner',role:'owner'}],subject={subjectId:party.partyId,subjectType:'party',ownerIdentityId:signedInId,version:4};
const ready=extra=>({party,initialRecord:party,initialContacts:[],initialSubject:subject,initialMembers:members,signedInIdentityId:signedInId,...extra});

test('viewer relationship detail contains escaped facts but no mutation workflows',()=>{
 const h=harness('src/production/RelationshipWorkspace.jsx'),tree=h.render(ready({client:{request:async()=>({})},writable:false}));
 assert.match(html(tree),/Avery &amp; Co/);assert.match(html(tree),/read-only/i);assert.doesNotMatch(html(tree),/Edit relationship|Add contact|Record activity|Create task|Write note|Link attachment|Change owner/);
});

test('staff relationship detail exposes complete labelled core and work workflows',()=>{
 const h=harness('src/production/RelationshipWorkspace.jsx'),tree=h.render(ready({client:{request:async()=>({})},writable:true})),markup=html(tree);
 for(const label of ['Edit relationship','Add contact','Record activity','Create task','Write note','Link attachment','Change owner'])assert.match(markup,new RegExp(label));
 assert.match(markup,/expected saved version 3/i);assert.doesNotMatch(markup,/dangerouslySetInnerHTML/);
 assert.equal(find(tree,node=>node.props?.name==='taskOwner').props.value,signedInId);assert.equal(find(tree,node=>node.props?.name==='ownerId').props.value,signedInId);
});

test('optimistic party conflict preserves the typed input and requires explicit reload',async()=>{
 const calls=[],h=harness('src/production/RelationshipWorkspace.jsx'),props=ready({client:{request:async(path,options)=>{calls.push([path,options]);throw Object.assign(new Error('changed'),{status:409});}},writable:true});
 let tree=h.render(props),form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Edit relationship'),input=find(form,node=>node.type==='input'&&node.props.name==='displayName');
 input.props.onChange({target:{value:'Avery typed draft'}});tree=h.render(props);form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Edit relationship');await form.props.onSubmit({preventDefault(){}});await flush();tree=h.render(props);
 assert.match(html(tree),/Avery typed draft/);assert.match(html(tree),/Reload current record/);assert.equal(calls.length,1);assert.equal(calls[0][1].body.expectedVersion,3);
});

test('staff party update uses the saved optimistic version and replaces it with the server result',async()=>{
 const calls=[],h=harness('src/production/RelationshipWorkspace.jsx'),props=ready({client:{request:async(path,options)=>{calls.push([path,options]);return {party:{...party,displayName:'Avery saved',version:4}};}},writable:true});let tree=h.render(props),form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Edit relationship');await form.props.onSubmit({preventDefault(){}});await flush();tree=h.render(props);assert.match(html(tree),/Avery saved/);assert.match(html(tree),/Relationship updated/);assert.equal(calls[0][1].body.expectedVersion,3);
});

test('task owner select sends the chosen member and lifecycle uses each returned optimistic version',async()=>{
 const calls=[],taskId='60000000-0000-4000-8000-000000000001',h=harness('src/production/RelationshipWorkspace.jsx'),client={request:async(path,options)=>{calls.push([path,options]);if(path.endsWith('/tasks')&&options.method==='POST')return {task:{taskId,title:options.body.title,status:'open',ownerIdentityId:options.body.ownerIdentityId,version:1}};const previous=options.body.expectedVersion;return {task:{taskId,title:'Call back',status:options.body.status,ownerIdentityId:secondId,version:previous+1}};}},props=ready({client,writable:true});let tree=h.render(props),form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Create task');find(form,node=>node.props?.name==='taskTitle').props.onChange({target:{name:'taskTitle',value:'Call back'}});tree=h.render(props);form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Create task');find(form,node=>node.props?.name==='taskOwner').props.onChange({target:{name:'taskOwner',value:secondId}});tree=h.render(props);await find(tree,node=>node.type==='form'&&node.props['aria-label']==='Create task').props.onSubmit({preventDefault(){}});await flush();tree=h.render(props);await find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Start task')).props.onClick();await flush();tree=h.render(props);await find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Complete task')).props.onClick();
 assert.deepEqual(calls.map(([,options])=>options.body),[{title:'Call back',ownerIdentityId:secondId},{status:'in_progress',expectedVersion:1},{status:'completed',expectedVersion:2}]);
});

test('two sequential owner changes send selected member IDs and returned subject versions',async()=>{
 const calls=[],h=harness('src/production/RelationshipWorkspace.jsx'),client={request:async(path,options)=>{calls.push([path,options]);return {subject:{...subject,ownerIdentityId:options.body.newOwnerIdentityId,version:options.body.expectedVersion+1}};}},props=ready({client,writable:true});let tree=h.render(props),form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner'),select=find(form,node=>node.props?.name==='ownerId');select.props.onChange({target:{name:'ownerId',value:secondId}});tree=h.render(props);await find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner').props.onSubmit({preventDefault(){}});await flush();tree=h.render(props);select=find(find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner'),node=>node.props?.name==='ownerId');select.props.onChange({target:{name:'ownerId',value:signedInId}});tree=h.render(props);await find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner').props.onSubmit({preventDefault(){}});
 assert.deepEqual(calls.map(([,options])=>options.body),[{newOwnerIdentityId:secondId,expectedVersion:4},{newOwnerIdentityId:signedInId,expectedVersion:5}]);
});

test('owner conflict reloads authoritative subject version before explicit successful retry',async()=>{
 let ownerAttempts=0;const calls=[],h=harness('src/production/RelationshipWorkspace.jsx'),client={request:async(path,options={})=>{calls.push([path,options]);if(path.endsWith('/owner')){ownerAttempts++;if(ownerAttempts===1)throw Object.assign(new Error('changed'),{status:409});return {subject:{...subject,ownerIdentityId:secondId,version:10}};}if(path===`/crm/parties/${party.partyId}`)return {party};if(path.includes('/contacts'))return {contacts:[]};if(path===`/crm/subjects/${party.partyId}`)return {subject:{...subject,version:9}};if(path==='/crm/members')return {members};if(path.endsWith('/tasks?limit=50'))return {tasks:[]};if(path.endsWith('/notes?limit=50'))return {notes:[]};throw Error(path);}},props=ready({client,writable:true});let tree=h.render(props),form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner');find(form,node=>node.props?.name==='ownerId').props.onChange({target:{name:'ownerId',value:secondId}});tree=h.render(props);await find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner').props.onSubmit({preventDefault(){}});await flush();tree=h.render(props);assert.match(html(tree),/Reload current record/);await find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Reload current record')).props.onClick();await flush();tree=h.render(props);find(find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner'),node=>node.props?.name==='ownerId').props.onChange({target:{name:'ownerId',value:secondId}});tree=h.render(props);await find(tree,node=>node.type==='form'&&node.props['aria-label']==='Change owner').props.onSubmit({preventDefault(){}});
 const changes=calls.filter(([path])=>path.endsWith('/owner'));assert.equal(changes.length,2);assert.equal(changes[1][1].body.expectedVersion,9);
});

test('empty active-member catalog disables assignment workflows with an explicit state',()=>{
 const h=harness('src/production/RelationshipWorkspace.jsx'),tree=h.render(ready({client:{request:async()=>({})},writable:true,initialMembers:[]})),markup=html(tree);assert.match(markup,/No active members are available for assignment/);const taskOwner=find(tree,node=>node.props?.name==='taskOwner'),owner=find(tree,node=>node.props?.name==='ownerId');assert.equal(taskOwner.props.disabled,true);assert.equal(owner.props.disabled,true);
});

test('relationship creation sends the correct person or organization contract and reports errors',async()=>{
 const calls=[],h=harness('src/production/RelationshipCreate.jsx'),props={client:{request:async(path,options)=>{calls.push([path,options]);return {party:{...party,version:1}};}},writable:true,onCreated:()=>{},initialDraft:{displayName:'New Person',firstName:'New',lastName:'Person',legalName:''}};
 const tree=h.render(props);await find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(calls[0][0],'/crm/people');assert.deepEqual(calls[0][1].body,{displayName:'New Person',firstName:'New',lastName:'Person'});
});

test('report access chooses core data and keeps suspended export separate from write',()=>{
 const h=harness('src/production/ReportsWorkspace.jsx'),access=h.exports.reportAccessForModules([{code:'core',state:'enabled',capabilities:{read:true,write:true,export:true}},{code:'sales',state:'suspended',capabilities:{read:true,write:false,export:true}}],'staff');
 assert.deepEqual(access,{dataset:'opportunities',canImport:true,canSave:false,canExport:true});
 assert.deepEqual(h.exports.reportAccessForModules([{code:'core',state:'enabled',capabilities:{read:true,write:false,export:true}}],'staff'),{dataset:'parties',canImport:false,canSave:false,canExport:true});
});

test('core-only reports render relationship data and suspended write keeps export enabled',()=>{
 const h=harness('src/production/ReportsWorkspace.jsx'),modules=[{code:'core',state:'suspended',capabilities:{read:true,write:false,export:true}}],tree=h.render({client:{request:async()=>({})},modules,role:'staff',initialDashboard:{total:2}}),markup=html(tree);assert.match(markup,/Relationship pulse/);const exportButton=find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Export complete CSV')),file=find(tree,node=>node.type==='input'&&node.props.type==='file'),save=find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Save report'));assert.equal(exportButton.props.disabled,false);assert.equal(file.props.disabled,true);assert.equal(save.props.disabled,true);
});

test('sales report definition uses only server-catalogued opportunity fields',()=>{
 const source=readFileSync(new URL('src/production/ReportsWorkspace.jsx',root),'utf8');assert.match(source,/\['name','status','amountCents','currency'\]/);assert.doesNotMatch(source,/stageName/);
});
