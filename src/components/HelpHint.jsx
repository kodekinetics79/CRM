import {useId,useRef,useState} from 'react';
import {CircleHelp} from 'lucide-react';
export default function HelpHint({label,text}){
 const id=useId();const wrapper=useRef(null);const [open,setOpen]=useState(false);
 return <span ref={wrapper} className="help-hint" onMouseEnter={()=>setOpen(true)} onMouseLeave={()=>{if(!wrapper.current?.contains(document.activeElement))setOpen(false);}} onFocus={()=>setOpen(true)} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(false);}} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.stopPropagation();}}}><button type="button" className="icon-btn help-trigger" aria-label={'Help: '+label} aria-expanded={open} aria-describedby={open?id:undefined} onClick={()=>setOpen(true)}><CircleHelp size={16}/></button>{open&&<span id={id} role="tooltip" className="help-tooltip">{text}</span>}</span>;
}
