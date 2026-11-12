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

test('viewer relationship detail contains escaped facts but no mutation workflows',()=>{
 const h=harness('src/production/RelationshipWorkspace.jsx'),tree=h.render({client:{request:async()=>({})},party,writable:false,initialRecord:party,initialContacts:[]});
 assert.match(html(tree),/Avery &amp; Co/);assert.match(html(tree),/read-only/i);assert.doesNotMatch(html(tree),/Edit relationship|Add contact|Record activity|Create task|Write note|Link attachment|Change owner/);
});

test('staff relationship detail exposes complete labelled core and work workflows',()=>{
 const h=harness('src/production/RelationshipWorkspace.jsx'),tree=h.render({client:{request:async()=>({})},party,writable:true,initialRecord:party,initialContacts:[]}),markup=html(tree);
 for(const label of ['Edit relationship','Add contact','Record activity','Create task','Write note','Link attachment','Change owner'])assert.match(markup,new RegExp(label));
 assert.match(markup,/expected saved version 3/i);assert.doesNotMatch(markup,/dangerouslySetInnerHTML/);
});

test('optimistic party conflict preserves the typed input and requires explicit reload',async()=>{
 const calls=[],h=harness('src/production/RelationshipWorkspace.jsx'),props={client:{request:async(path,options)=>{calls.push([path,options]);throw Object.assign(new Error('changed'),{status:409});}},party,writable:true,initialRecord:party,initialContacts:[]};
 let tree=h.render(props),form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Edit relationship'),input=find(form,node=>node.type==='input'&&node.props.name==='displayName');
 input.props.onChange({target:{value:'Avery typed draft'}});tree=h.render(props);form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Edit relationship');await form.props.onSubmit({preventDefault(){}});await flush();tree=h.render(props);
 assert.match(html(tree),/Avery typed draft/);assert.match(html(tree),/Reload current record/);assert.equal(calls.length,1);assert.equal(calls[0][1].body.expectedVersion,3);
});

test('staff party update uses the saved optimistic version and replaces it with the server result',async()=>{
 const calls=[],h=harness('src/production/RelationshipWorkspace.jsx'),props={client:{request:async(path,options)=>{calls.push([path,options]);return {party:{...party,displayName:'Avery saved',version:4}};}},party,writable:true,initialRecord:party,initialContacts:[]};let tree=h.render(props),form=find(tree,node=>node.type==='form'&&node.props['aria-label']==='Edit relationship');await form.props.onSubmit({preventDefault(){}});await flush();tree=h.render(props);assert.match(html(tree),/Avery saved/);assert.match(html(tree),/Relationship updated/);assert.equal(calls[0][1].body.expectedVersion,3);
});

test('relationship workflow source binds every completed work API with explicit task and owner PATCH',()=>{
 const source=readFileSync(new URL('src/production/RelationshipWorkspace.jsx',root),'utf8');for(const endpoint of ['/contacts','/activities','/tasks','/notes','/revisions','/attachments','/owner'])assert.match(source,new RegExp(endpoint.replace('/','\\/')));assert.match(source,/updateTask[\s\S]*'PATCH'/);assert.match(source,/changeOwner[\s\S]*'PATCH'/);
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
