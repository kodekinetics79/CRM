import HelpHint from './HelpHint';
import React from 'react';
import { Plus, X, CheckCircle2, Circle, MinusCircle } from 'lucide-react';
import {money} from '../lib';
export function Field({field,value,onChange,data,currentId}) {
 const {key,label,type,required,hint}=field;
 const inputId='field-'+key;
 const common={id:inputId,name:key,required,disabled:field.disabled,value:value??'',onChange:e=>onChange(type==='number'?Number(e.target.value):e.target.value), 'aria-describedby':hint?inputId+'-hint':undefined};
 let input;
 if(type==='textarea')input=<textarea {...common} rows={key==='body'?7:3}/>;
 else if(type==='select')input=<select {...common}>{field.options.map(o=><option key={o}>{o}</option>)}</select>;
 else if(type==='reference')input=<select {...common} onChange={e=>onChange(e.target.value||null)}><option value="">{required?'Choose '+label.toLowerCase():'None'}</option>{data[field.collection].filter(r=>r.id!==currentId).map(r=><option key={r.id} value={r.id}>{r.name||r.title}</option>)}</select>;
 else if(type==='money')input=<div className="input-affix"><span aria-hidden="true">$</span><input {...common} type="text" inputMode="decimal" placeholder="0.00"/></div>;
 else input=<input {...common} type={type} min={field.min} max={field.max} step={field.step} maxLength={type==='text'?300:undefined}/>;
 return <div className={'field '+(type==='textarea'?'field-wide':'')}><div className="field-heading"><label htmlFor={inputId}>{label}{required&&<span className="required-mark" aria-hidden="true"> *</span>}</label>{hint&&<HelpHint label={label} text={hint}/>}</div>{input}{hint&&<small className="subtle" id={inputId+'-hint'}>{hint}</small>}</div>;
}
export function ContactsEditor({contacts,onChange}) {
 return <section className="field-wide contacts-editor"><div className="section-title"><h3>Additional contacts</h3><button className="btn btn-secondary btn-small" type="button" onClick={()=>onChange([...contacts,{name:'',email:'',role:''}])}><Plus size={15}/>Add contact</button></div><p className="subtle">Keep the people at an organization together in one constituent record.</p>{contacts.map((c,i)=><div className="contact-fields" key={i}>{[['name','Contact name'],['email','Contact email'],['role','Role']].map(([k,l])=><div className="field" key={k}><label htmlFor={`contact-${i}-${k}`}>{l}</label><input id={`contact-${i}-${k}`} required={k==='name'} type={k==='email'?'email':'text'} value={c[k]} onChange={e=>onChange(contacts.map((v,n)=>n===i?{...v,[k]:e.target.value}:v))}/></div>)}<button type="button" className="icon-btn" aria-label={`Remove additional contact ${i+1}`} onClick={()=>onChange(contacts.filter((_,n)=>n!==i))}><X size={18}/></button></div>)}</section>;
}
export function Status({value}){const positive=['Active','Awarded','Completed','Posted','Logged','Reserved','Passed'].includes(value);const muted=['Voided','Declined','Closed','Do not contact','Cancelled'].includes(value);const Icon=positive?CheckCircle2:muted?MinusCircle:Circle;return <span className="record-status"><Icon size={14} aria-hidden="true"/>{value||'—'}</span>;}
export function Progress({value,label}){const percent=Math.max(0,Math.min(100,value||0));return <div className="progress" role="progressbar" aria-label={label} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{width:percent+'%'}}/></div>;}
