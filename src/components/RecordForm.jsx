import React,{useState} from 'react';
import {Save,ArrowLeft} from 'lucide-react';
import {MODULES} from '../schema';
import {cents} from '../lib';
import {Field,ContactsEditor} from './Fields';
export default function RecordForm({collection,record,data,onSave,onCancel,onDirty}) {
 const schema=MODULES[collection];
 const activeFields=schema.fields.filter(f=>!record||!f.createOnly);
 const [values,setValues]=useState(()=>Object.fromEntries(activeFields.map(f=>[f.key,f.type==='money'?((record?.[f.key]??schema.defaults[f.key])/100).toFixed(2):record?.[f.key]??schema.defaults[f.key]??''])));
 const [contacts,setContacts]=useState(record?.contacts||[]);
 const [error,setError]=useState('');const [saving,setSaving]=useState(false);
 const change=(key,v)=>{setValues(old=>({...old,[key]:v}));onDirty(true);};
 async function submit(e){e.preventDefault();setError('');setSaving(true);try{const payload={...values};for(const f of activeFields){if(f.type==='money')payload[f.key]=cents(values[f.key]);if(f.type==='date'&&!values[f.key])payload[f.key]=null;if(f.type==='reference'&&!values[f.key])payload[f.key]=null;}if(collection==='constituents')payload.contacts=contacts;await onSave(payload);}catch(err){setError(err.message);}finally{setSaving(false);}}
 return <section className="panel inline-editor"><div className="section-title"><div><h2>{record?'Edit':'New'} {schema.singular}</h2><p className="subtle">Fields marked with * are required.</p></div><button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}><ArrowLeft size={16}/>Back</button></div><form onSubmit={submit}>{error&&<div className="error-banner" role="alert">{error} Your changes have not been saved.</div>}<div className="form-grid">{activeFields.map(f=><Field key={f.key} field={f} value={values[f.key]} onChange={v=>change(f.key,v)} data={data} currentId={record?.id}/>)}{collection==='constituents'&&<ContactsEditor contacts={contacts} onChange={v=>{setContacts(v);onDirty(true);}}/>}</div><div className="form-actions"><button className="btn btn-secondary" type="button" onClick={onCancel} disabled={saving}>Cancel</button><button className="btn btn-primary" disabled={saving}><Save size={16}/>{saving?'Saving…':'Save '+schema.singular}<kbd>⌘ / Ctrl ↵</kbd></button></div></form></section>;
}
