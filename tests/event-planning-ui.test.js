import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as lib from '../src/lib.js';

function harness(){
 let index=0,state=[],effects=[],keys=[],cleanups=[];
 globalThis.window={location:{search:'',pathname:'/'},history:{replaceState(){}}};
 const mock={...React,
  useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},
  useRef(initial){return state[index++]??=({current:initial});},
  useEffect(effect,deps){const i=index++;if(!keys[i]||!deps||deps.some((dep,j)=>dep!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=effect();});}}};
 const module={exports:{}},require=id=>id==='react'?mock:id.includes('lib')?lib:new Proxy({},{get:()=>()=>null});
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/EventPlanning.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 const render=props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(run=>run());return tree;};
 return render;
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
function findAll(tree,predicate,found=[]){if(!tree||typeof tree!=='object')return found;if(predicate(tree))found.push(tree);for(const child of React.Children.toArray(tree.props?.children))findAll(child,predicate,found);return found;}
const text=node=>React.Children.toArray(node.props.children).filter(child=>typeof child==='string').join('');
const button=(tree,label)=>find(tree,node=>node.type==='button'&&text(node).includes(label));
const labelled=(tree,label)=>find(find(tree,node=>node.type==='label'&&text(node).startsWith(label)),node=>['input','select','textarea'].includes(node.type));
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};

const event={id:'e1',name:'Spring benefit',date:'2026-11-14',location:'Hall',capacity:120,version:1};
const users=[{id:'u1',name:'Casey Rivera',role:'staff',version:1},{id:'u2',name:'Alex Morgan',role:'admin',version:1}];
const item=(changes={})=>({id:'i1',checklistId:'cl1',eventId:'e1',title:'Confirm venue contract',detail:'Insurance certificate too',dueDate:'2026-09-30',status:'Open',sequence:1,version:1,createdAt:'',updatedAt:'',assignee:null,assigneeVersion:null,assignmentCurrent:true,overdue:false,unresolved:true,unresolvedReasons:['No one is responsible yet'],...changes});
const overview=(changes={})=>({
 generatedAt:'2026-09-13T12:00:00.000Z',timezone:'UTC',
 events:[event],
 templates:[{key:'fundraising-dinner',name:'Fundraising dinner',itemCount:6}],
 checklists:[{id:'cl1',eventId:'e1',name:'Run of show',templateKey:'fundraising-dinner',status:'Active',version:2,createdAt:'',updatedAt:''}],
 items:[item()],
 unresolved:[item()],
 budgetLines:[{id:'b1',eventId:'e1',kind:'Expense estimate',category:'Catering',description:'Plated dinner estimate',plannedCents:450075,version:1,createdAt:'',updatedAt:'',meaning:'Planning estimates and vendor notes only. No gift, pledge, receipt, purchase order, payment or recorded expense is created here.'}],
 budgetTotals:{expenseEstimate:450075,incomeEstimate:800000,currency:'USD',meaning:'Planning estimates and vendor notes only. No gift, pledge, receipt, purchase order, payment or recorded expense is created here.'},
 vendors:[{id:'v1',eventId:'e1',name:'Synthetic Catering Co',service:'Catering',contactName:'Robin Vendor',contactEmail:'robin@vendor.test',phone:'555-0100',status:'Considering',notes:'',version:1,createdAt:'',updatedAt:''}],
 assignableUsers:users,canWrite:true,
 scope:'Planning estimates and vendor notes only. No gift, pledge, receipt, purchase order, payment or recorded expense is created here.',...changes});

async function screen({api,user={id:'u1',name:'Casey Rivera',role:'staff'}}={}){
 const calls=[],render=harness();
 const props={user,data:{},notify:()=>{},onDirty:()=>{},api:async(path,options)=>{calls.push([path,options]);return api?api(path,options):overview();}};
 render(props);await flush();
 return {calls,render,props,tree:render(props),html:()=>renderToStaticMarkup(render(props))};
}

test('an unavailable register is explicit and a denied account shows no planning records',async()=>{
 const broken=await screen({api:async()=>{throw new Error('Planning storage unavailable');}});
 assert.match(broken.html(),/Planning storage unavailable/);
 assert.doesNotMatch(broken.html(),/Every open responsibility has a current owner/);
 await button(broken.render(broken.props),'Try again').props.onClick();
 assert.equal(broken.calls.length,2);
 const denied=await screen({api:async()=>{throw Object.assign(new Error('Event planning requires workspace access'),{status:403});}});
 assert.match(denied.html(),/Event planning requires workspace access/);
 assert.doesNotMatch(denied.html(),/Run of show|Synthetic Catering Co/);
});

test('unresolved responsibilities are listed first with the reason each is unresolved',async()=>{
 const unassigned=item(),stale=item({id:'i2',title:'Confirm catering',assignee:{id:'u3',name:'Former Staff',role:'staff',version:2,active:false},assignmentCurrent:false,unresolvedReasons:['The assigned account changed or is no longer active staff']});
 const late=item({id:'i3',title:'Brief volunteers',overdue:true,unresolvedReasons:['The agreed date has passed']});
 const view=await screen({api:async()=>overview({items:[unassigned,stale,late],unresolved:[unassigned,stale,late]})});
 const html=view.html();
 assert.match(html,/No one is responsible yet/);
 assert.match(html,/no longer active staff/);
 assert.match(html,/The agreed date has passed/);
 assert.ok(html.indexOf('id="unresolved-heading"')<html.indexOf('id="checklists-heading"'),'unresolved work is stated before the full checklist');
 const clear=await screen({api:async()=>overview({unresolved:[]})});
 assert.match(clear.html(),/Every open responsibility has a current owner/);
});

test('board viewers read the plan but are offered no change controls',async()=>{
 const view=await screen({api:async()=>overview({canWrite:false}),user:{id:'b1',name:'Jordan Lee',role:'viewer'}});
 const html=view.html();
 assert.match(html,/read-only access/);
 assert.match(html,/Run of show/);
 assert.equal(button(view.tree,'Create checklist'),null);
 assert.equal(button(view.tree,'Add vendor'),null);
 assert.equal(button(view.tree,'Add estimate'),null);
});

test('a checklist can be created from a template with the event version pinned',async()=>{
 let created=null;
 const view=await screen({api:async(path,options)=>{
  if(options?.method==='POST'){created=options.body;return {checklist:{id:'cl2',eventId:'e1',name:'Dinner plan',templateKey:'fundraising-dinner',status:'Active',version:1},items:[]};}
  return overview();
 }});
 labelled(view.render(view.props),'Event').props.onChange({target:{value:'e1'}});
 await flush();
 labelled(view.render(view.props),'Checklist name').props.onChange({target:{value:'Dinner plan'}});
 labelled(view.render(view.props),'Start from a template').props.onChange({target:{value:'fundraising-dinner'}});
 const tree=view.render(view.props);
 assert.equal(button(tree,'Create checklist').props.disabled,false);
 await find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});
 await flush();
 assert.deepEqual(created,{eventId:'e1',eventVersion:1,name:'Dinner plan',templateKey:'fundraising-dinner'});
 assert.match(view.html(),/Checklist created/);
});

test('assignment and state changes pin both the responsibility and the account version',async()=>{
 const posts=[];
 const view=await screen({api:async(path,options)=>{if(options)posts.push([path,options.body]);return overview();}});
 labelled(view.render(view.props),'Open a checklist').props.onChange({target:{value:'cl1'}});
 let tree=view.render(view.props);
 const assign=find(tree,node=>node.type==='select'&&node.props.id==='assign-i1');
 assert.ok(assign);
 await assign.props.onChange({target:{value:'u1'}});
 await flush();
 assert.deepEqual(posts[0],['/event-planning/items/i1/assign',{version:1,assigneeId:'u1',assigneeVersion:1,reason:'Responsibility set from the event planning screen'}]);
 tree=view.render(view.props);
 await find(tree,node=>node.type==='select'&&node.props.id==='status-i1').props.onChange({target:{value:'In progress'}});
 await flush();
 assert.deepEqual(posts[1],['/event-planning/items/i1/status',{version:1,status:'In progress',reason:'State changed from the event planning screen'}]);
 assert.ok(find(view.render(view.props),node=>node.type==='label'&&node.props.className==='sr-only'&&node.props.htmlFor==='assign-i1'),'each row control is named for screen readers');
});

test('a stale change is reported as a conflict and reloaded, never as success',async()=>{
 let reads=0;
 const view=await screen({api:async(path,options)=>{
  if(options)throw Object.assign(new Error('This responsibility changed. Reload its current version before continuing'),{status:409});
  reads++;return overview();
 }});
 labelled(view.render(view.props),'Open a checklist').props.onChange({target:{value:'cl1'}});
 const before=reads;
 await find(view.render(view.props),node=>node.type==='select'&&node.props.id==='assign-i1').props.onChange({target:{value:'u1'}});
 await flush();
 assert.match(view.html(),/This responsibility changed/);
 assert.match(view.html(),/latest planning records have been reloaded/);
 assert.ok(reads>before);
 assert.doesNotMatch(view.html(),/Responsibility assigned\./);
});

test('planning estimates show exact amounts and say plainly that no revenue is created',async()=>{
 const view=await screen();
 const html=view.html();
 assert.match(html,/\$4,500\.75/);
 assert.match(html,/\$8,000\.00/);
 assert.match(html,/No gift, pledge, receipt, purchase order, payment or recorded expense is created here/);
 assert.match(html,/never a constituent identity, an agreement or a payment/);
 assert.ok(findAll(view.tree,node=>node.type==='td').every(node=>typeof node.props['data-label']==='string'),'dense cells carry the label used by the mobile stacked layout');
 assert.ok(findAll(view.tree,node=>node.type==='table').every(node=>find(node,child=>child.type==='caption')));
 assert.ok(findAll(view.tree,node=>node.type==='th').every(node=>node.props.scope==='col'));
});

test('an amount with too many decimals is refused locally and nothing is sent',async()=>{
 const posts=[];
 const view=await screen({api:async(path,options)=>{if(options)posts.push(options.body);return overview();}});
 labelled(view.render(view.props),'Event').props.onChange({target:{value:'e1'}});
 await flush();
 labelled(view.render(view.props),'Category').props.onChange({target:{value:'Catering'}});
 labelled(view.render(view.props),'Estimated amount').props.onChange({target:{value:'10.005'}});
 const form=find(view.render(view.props),node=>node.type==='form'&&find(node,child=>child.type==='legend'&&text(child)==='Add a planning estimate'));
 await form.props.onSubmit({preventDefault(){}});
 await flush();
 assert.equal(posts.length,0);
 assert.match(view.html(),/no more than two decimal places/);
 labelled(view.render(view.props),'Estimated amount').props.onChange({target:{value:'10.05'}});
 await find(view.render(view.props),node=>node.type==='form'&&find(node,child=>child.type==='legend'&&text(child)==='Add a planning estimate')).props.onSubmit({preventDefault(){}});
 await flush();
 assert.equal(posts.length,1);
 assert.equal(posts[0].plannedCents,1005);
});
