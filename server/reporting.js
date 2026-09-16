import {randomUUID,createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {buildReportCatalog,validateReportDefinition,runCustomReport,ReportError,REPORT_LIMITS,inspectReportSourceFields,isReportSourceEntity} from '../src/reportEngine.js';

// --- Typed native export encoders -------------------------------------------
// No new dependency is introduced: the workbook below is an Office Open XML
// package written byte by byte (zip container + SpreadsheetML), the PDF is a
// minimal PDF 1.4 document and the RTF a plain table. Automated tests assert the
// STRUCTURE of these bytes. Rendering fidelity in Microsoft Excel, Adobe Acrobat
// or Microsoft Word is not verified in this repository and is never claimed.
export const TYPED_EXPORT_FORMATS={
 xlsx:{extension:'xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',label:'workbook',standard:'Office Open XML (ECMA-376) SpreadsheetML',typedCells:true,formulaProtected:true,encoding:'UTF-8'},
 pdf:{extension:'pdf',mime:'application/pdf',label:'PDF',standard:'PDF 1.4',typedCells:false,formulaProtected:false,encoding:'WinAnsi'},
 rtf:{extension:'rtf',mime:'application/rtf',label:'RTF document',standard:'RTF 1.x',typedCells:false,formulaProtected:false,encoding:'ANSI with Unicode escapes'}
};
const PROCESSING_REFUSAL='Complete typed export exceeds its bounded processing size. Narrow the report; no partial export was generated.';
// Every encoder writes through this budget, so an oversized report is refused
// while it is being assembled and no partial file is ever returned or retained.
const budget=()=>{let bytes=0;return {add(part){bytes+=Buffer.isBuffer(part)?part.length:Buffer.byteLength(part);if(bytes>REPORT_LIMITS.exportOutputBytes)throw new ReportError(PROCESSING_REFUSAL,413);return part;},get bytes(){return bytes;}};};
export const moneyDecimal=value=>{if(!Number.isSafeInteger(value))throw new ReportError('Export money must be exact safe integer cents.',503);const cents=BigInt(value),absolute=cents<0n?-cents:cents;return (cents<0n?'-':'')+String(absolute/100n)+'.'+String(absolute%100n).padStart(2,'0');};
// Spreadsheet targets keep the existing formula guard. A PDF and an RTF are not
// formula hosts, so they render the original text instead of inventing a quote.
const spreadsheetText=text=>/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)||/^[\u0000-\u001f\u007f]/u.test(text)?"'"+text:text;
const sourceText=value=>{const text=typeof value==='string'?value:JSON.stringify(value);if(typeof text!=='string')throw new ReportError('Export contains unsupported source text. Review the source record.',503);return text;};
const EXCEL_EPOCH=Date.UTC(1899,11,30);
// Serial 61 is 1900-03-01. Below it every spreadsheet keeps the 1900 leap-year
// defect, so earlier dates stay text rather than silently shifting by a day.
const excelSerial=value=>{
 if(typeof value!=='string')return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
 if(!match)return null;
 const ms=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]||0),Number(match[5]||0),Number(match[6]||0));
 if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==value.slice(0,10))return null;
 const serial=(ms-EXCEL_EPOCH)/86400000;
 if(serial<61||serial>2958465)return null;
 return {serial:match[4]===undefined?String(Math.round(serial)):String(Number(serial.toFixed(8))),timed:match[4]!==undefined};
};
// One typing decision shared by every format: money stays exact decimal USD
// derived from saved integer cents, real calendar values become date cells and
// everything else stays text. No value is re-rounded for presentation.
export const typedCell=(value,column)=>{
 if(value==null||value==='')return {kind:'blank',text:''};
 if(column?.type==='money'){const text=moneyDecimal(value);return {kind:'number',money:true,number:text,text};}
 if(typeof value==='number'){if(!Number.isFinite(value))throw new ReportError('Export contains an invalid numeric source. Review the source record.',503);return {kind:'number',number:String(value),text:String(value)};}
 if(column?.type==='date'){const serial=excelSerial(value);if(serial)return {kind:'date',serial:serial.serial,timed:serial.timed,text:value};}
 return {kind:'text',text:sourceText(value)};
};
export const exportHeader=column=>String(column?.label??'')+(column?.type==='money'?' (USD)':'');

const CRC_TABLE=(()=>{const table=new Int32Array(256);for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;table[i]=c;}return table;})();
const crc32=buffer=>{let c=-1;for(let i=0;i<buffer.length;i++)c=CRC_TABLE[(c^buffer[i])&0xff]^(c>>>8);return (c^-1)>>>0;};
// Deterministic zip container: fixed 1980-01-01 stamps, deflate, no data
// descriptors and no zip64, so identical facts produce identical bytes.
function zipArchive(entries,b){
 const chunks=[],central=[];let position=0;
 const push=part=>{const buffer=Buffer.isBuffer(part)?part:Buffer.from(part,'utf8');b.add(buffer);chunks.push(buffer);position+=buffer.length;};
 for(const entry of entries){
  const name=Buffer.from(entry.name,'utf8'),data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data,'utf8'),compressed=deflateRawSync(data,{level:9}),crc=crc32(data),start=position;
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(0,10);local.writeUInt16LE(0x0021,12);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(0,28);
  push(local);push(name);push(compressed);
  const directory=Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x0800,8);directory.writeUInt16LE(8,10);directory.writeUInt16LE(0,12);directory.writeUInt16LE(0x0021,14);
  directory.writeUInt32LE(crc,16);directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(start,42);
  central.push(directory,name);
 }
 const directory=Buffer.concat(central),offset=position;
 push(directory);
 const end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 push(end);
 return Buffer.concat(chunks);
}

const xmlAttribute=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Characters XML 1.0 cannot carry use the spreadsheet _xHHHH_ convention; the
// escape prefix is itself escaped so saved text cannot invent a control code.
const xmlText=value=>{let out='';for(const ch of String(value).replace(/_(x[0-9A-Fa-f]{4}_)/g,'_x005F_$1')){const code=ch.codePointAt(0);out+=ch==='&'?'&amp;':ch==='<'?'&lt;':ch==='>'?'&gt;':ch==='\t'||ch==='\n'?ch:code<0x20||code===0x7f?'_x'+code.toString(16).toUpperCase().padStart(4,'0')+'_':ch;}return out;};
const columnLetter=index=>{let n=index+1,name='';while(n>0){name=String.fromCharCode(65+(n-1)%26)+name;n=Math.floor((n-1)/26);}return name;};
const worksheetName=(name,used)=>{const base=String(name??'').replace(/[\\/?*[\]:]/g,' ').trim().slice(0,31)||'Sheet';let candidate=base;for(let n=2;used.has(candidate);n++)candidate=base.slice(0,27)+' ('+n+')';used.add(candidate);return candidate;};
const STYLES='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
 '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>'+
 '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'+
 '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'+
 '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
 '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
 '<cellXfs count="5">'+
 '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
 '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'+
 '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'+
 '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'+
 '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'+
 '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
function workbookBuffer(document,b){
 const used=new Set(),names=document.sheets.map(sheet=>worksheetName(sheet.name,used)),entries=[];
 let clipped=false,substituted=false;
 document.sheets.forEach((sheet,index)=>{
  const columns=sheet.columns,parts=['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  if(columns.length)parts.push('<cols>'+columns.map((column,j)=>'<col min="'+(j+1)+'" max="'+(j+1)+'" width="'+Math.min(60,Math.max(11,exportHeader(column).length+4))+'" customWidth="1"/>').join('')+'</cols>');
  parts.push('<sheetData>');
  parts.push(b.add('<row r="1">'+columns.map((column,j)=>'<c r="'+columnLetter(j)+'1" s="1" t="inlineStr"><is><t xml:space="preserve">'+xmlText(spreadsheetText(exportHeader(column)))+'</t></is></c>').join('')+'</row>'));
  let r=1;
  for(const row of sheet.rows){
   r++;
   const cells=row.map((value,j)=>{
    const cell=typedCell(value,columns[j]),reference=columnLetter(j)+r;
    if(cell.kind==='blank')return '';
    if(cell.kind==='number')return '<c r="'+reference+'"'+(cell.money?' s="2"':'')+'><v>'+cell.number+'</v></c>';
    if(cell.kind==='date')return '<c r="'+reference+'" s="'+(cell.timed?4:3)+'"><v>'+cell.serial+'</v></c>';
    return '<c r="'+reference+'" t="inlineStr"><is><t xml:space="preserve">'+xmlText(spreadsheetText(cell.text))+'</t></is></c>';
   }).join('');
   parts.push(b.add('<row r="'+r+'">'+cells+'</row>'));
  }
  parts.push('</sheetData></worksheet>');
  entries.push({name:'xl/worksheets/sheet'+(index+1)+'.xml',data:Buffer.from(parts.join(''),'utf8')});
 });
 const relationships=names.map((name,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+
  '<Relationship Id="rId'+(names.length+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
 const contentTypes='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
  names.map((name,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
 const workbook='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+
  names.map((name,i)=>'<sheet name="'+xmlAttribute(name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>';
 return {buffer:zipArchive([
  {name:'[Content_Types].xml',data:contentTypes},
  {name:'_rels/.rels',data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
  {name:'xl/workbook.xml',data:workbook},
  {name:'xl/_rels/workbook.xml.rels',data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+relationships+'</Relationships>'},
  {name:'xl/styles.xml',data:STYLES},
  ...entries
 ],b),notes:{clipped,substituted,sheetNames:names}};
}

const PAGE={width:792,height:612,margin:36,title:15,heading:10,body:8,leading:11};
const WINANSI={'\u20ac':0x80,'\u201a':0x82,'\u0192':0x83,'\u201e':0x84,'\u2026':0x85,'\u2020':0x86,'\u2021':0x87,'\u02c6':0x88,'\u2030':0x89,'\u0160':0x8a,'\u2039':0x8b,'\u0152':0x8c,'\u017d':0x8e,'\u2018':0x91,'\u2019':0x92,'\u201c':0x93,'\u201d':0x94,'\u2022':0x95,'\u2013':0x96,'\u2014':0x97,'\u02dc':0x98,'\u2122':0x99,'\u0161':0x9a,'\u203a':0x9b,'\u0153':0x9c,'\u017e':0x9e,'\u0178':0x9f};
// The base-14 Helvetica font is WinAnsi encoded. Characters outside that
// repertoire are replaced with '?' and the substitution is reported, never
// hidden: the workbook and the CSV remain the complete-text artifacts.
const pdfString=value=>{
 let out='',substituted=false;
 for(const ch of String(value)){
  const code=ch.codePointAt(0),byte=code>=32&&code<=126?code:code>=0xa0&&code<=0xff?code:Object.hasOwn(WINANSI,ch)?WINANSI[ch]:null;
  if(byte===null){substituted=true;out+='?';continue;}
  const character=String.fromCharCode(byte);
  out+=character==='('||character===')'||character==='\\'?'\\'+character:character;
 }
 return {text:out,substituted};
};
const wrapText=(value,width,size)=>{
 const maximum=Math.max(8,Math.floor(width/(size*0.52))),lines=[];let line='';
 for(const word of String(value).split(/\s+/).filter(Boolean)){
  if(!line)line=word.slice(0,maximum);
  else if(line.length+1+word.length<=maximum)line+=' '+word;
  else{lines.push(line);line=word.slice(0,maximum);}
  if(lines.length>=6)break;
 }
 if(line&&lines.length<6)lines.push(line);
 return lines;
};
const fitText=(value,width,size)=>{const maximum=Math.max(1,Math.floor(width/(size*0.52)));return value.length<=maximum?{text:value,clipped:false}:{text:value.slice(0,Math.max(1,maximum-1))+'\u2026',clipped:true};};
function pdfDocument(document,b){
 let clipped=false,substituted=false;
 const pages=[];let ops=[],y=PAGE.height-PAGE.margin;
 const flush=()=>{if(ops.length)pages.push(ops.join(''));ops=[];y=PAGE.height-PAGE.margin;};
 const show=(x,size,font,value)=>{const rendered=pdfString(value);if(rendered.substituted)substituted=true;ops.push(b.add('BT /F'+font+' '+size+' Tf 1 0 0 1 '+x.toFixed(2)+' '+y.toFixed(2)+' Tm ('+rendered.text+') Tj ET\n'));};
 const rule=()=>{y-=4;ops.push('0.6 w 0.72 0.72 0.72 RG '+PAGE.margin+' '+y.toFixed(2)+' m '+(PAGE.width-PAGE.margin)+' '+y.toFixed(2)+' l S\n');};
 const room=height=>y-height<PAGE.margin;
 const usable=PAGE.width-PAGE.margin*2;
 y-=PAGE.title;show(PAGE.margin,PAGE.title,2,document.title);
 if(document.subtitle){y-=PAGE.leading+2;show(PAGE.margin,PAGE.body+1,1,document.subtitle);}
 rule();
 y-=PAGE.leading+2;show(PAGE.margin,PAGE.heading,2,'Export provenance');
 for(const [label,value] of document.provenance){
  if(room(PAGE.leading)){flush();}
  y-=PAGE.leading;show(PAGE.margin,PAGE.body,2,label);show(PAGE.margin+150,PAGE.body,1,value);
 }
 for(const sheet of document.sheets){
  flush();
  y-=PAGE.heading+2;show(PAGE.margin,PAGE.heading,2,sheet.title||sheet.name);
  for(const line of sheet.note?wrapText(sheet.note,usable,PAGE.body):[]){if(room(PAGE.leading))flush();y-=PAGE.leading;show(PAGE.margin,PAGE.body,1,line);}
  const columns=sheet.columns,sample=sheet.rows.slice(0,200);
  const weights=columns.map((column,j)=>Math.min(46,Math.max(9,Math.max(exportHeader(column).length,...sample.map(row=>typedCell(row[j],column).text.length),0)+2)));
  const total=weights.reduce((sum,value)=>sum+value,0)||1,widths=weights.map(value=>usable*value/total),x=[];
  let cursor=PAGE.margin;for(const width of widths){x.push(cursor);cursor+=width;}
  const header=()=>{y-=PAGE.leading+2;columns.forEach((column,j)=>{const fitted=fitText(exportHeader(column),widths[j]-4,PAGE.body);if(fitted.clipped)clipped=true;show(x[j],PAGE.body,2,fitted.text);});rule();};
  header();
  if(!sheet.rows.length){y-=PAGE.leading;show(PAGE.margin,PAGE.body,1,'No matching rows.');}
  for(const row of sheet.rows){
   if(room(PAGE.leading+2)){flush();header();}
   y-=PAGE.leading;
   columns.forEach((column,j)=>{const fitted=fitText(typedCell(row[j],column).text,widths[j]-4,PAGE.body);if(fitted.clipped)clipped=true;show(x[j],PAGE.body,1,fitted.text);});
  }
 }
 flush();
 const objects=['<</Type/Catalog/Pages 2 0 R>>','','<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>','<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>'];
 const kids=[];
 for(const content of pages){
  objects.push('<</Length '+Buffer.byteLength(content,'latin1')+'>>\nstream\n'+content+'endstream');
  const stream=objects.length;
  objects.push('<</Type/Page/Parent 2 0 R/MediaBox[0 0 '+PAGE.width+' '+PAGE.height+']/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>/Contents '+stream+' 0 R>>');
  kids.push(objects.length+' 0 R');
 }
 objects[1]='<</Type/Pages/Count '+kids.length+'/Kids['+kids.join(' ')+']>>';
 const header='%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n',chunks=[header],offsets=[];
 let offset=Buffer.byteLength(header,'latin1');
 objects.forEach((body,index)=>{const encoded=(index+1)+' 0 obj\n'+body+'\nendobj\n';offsets.push(offset);offset+=Buffer.byteLength(encoded,'latin1');chunks.push(b.add(encoded));});
 let xref='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
 for(const value of offsets)xref+=String(value).padStart(10,'0')+' 00000 n \n';
 chunks.push(b.add(xref),b.add('trailer\n<</Size '+(objects.length+1)+'/Root 1 0 R>>\nstartxref\n'+offset+'\n%%EOF\n'));
 return {buffer:Buffer.from(chunks.join(''),'latin1'),notes:{clipped,substituted,pageCount:pages.length}};
}

// RTF carries every character: ASCII directly and anything else as a signed
// \uN escape (surrogate pairs for astral planes), so no text is substituted.
const rtfString=value=>{
 let out='';
 for(const ch of String(value)){
  const code=ch.codePointAt(0);
  if(ch==='\\'||ch==='{'||ch==='}')out+='\\'+ch;
  else if(ch==='\n')out+='\\line ';
  else if(ch==='\r')continue;
  else if(code<128)out+=ch;
  else if(code>0xffff){const point=code-0x10000;out+='\\u'+(0xd800+(point>>10)-65536)+'?\\u'+(0xdc00+(point&0x3ff)-65536)+'?';}
  else out+='\\u'+(code>32767?code-65536:code)+'?';
 }
 return out;
};
function rtfDocument(document,b){
 const parts=['{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}}\\landscape\\paperw15840\\paperh12240\\margl720\\margr720\\margt720\\margb720\n'];
 parts.push('\\pard\\sa120\\b\\fs30 '+rtfString(document.title)+'\\b0\\fs20\\par\n');
 if(document.subtitle)parts.push('\\pard\\sa120\\fs18 '+rtfString(document.subtitle)+'\\par\n');
 parts.push('\\pard\\sa60\\b\\fs20 Export provenance\\b0\\par\n');
 for(const [label,value] of document.provenance)parts.push(b.add('\\pard\\fs16\\b '+rtfString(label)+': \\b0 '+rtfString(value)+'\\par\n'));
 for(const sheet of document.sheets){
  parts.push('\\pard\\page\\sa60\\b\\fs22 '+rtfString(sheet.title||sheet.name)+'\\b0\\par\n');
  if(sheet.note)parts.push('\\pard\\sa60\\fs16 '+rtfString(sheet.note)+'\\par\n');
  const columns=sheet.columns,width=Math.floor(14400/Math.max(1,columns.length)),boundaries=columns.map((column,j)=>'\\cellx'+width*(j+1)).join('');
  const row=(cells,bold)=>'\\trowd\\trgaph60\\trleft0'+boundaries+cells.map(cell=>'\\pard\\intbl\\fs16'+(bold?'\\b ':' ')+rtfString(cell)+(bold?'\\b0':'')+'\\cell').join('')+'\\row\n';
  parts.push(b.add(row(columns.map(exportHeader),true)));
  if(!sheet.rows.length)parts.push(row(columns.map((column,j)=>j?'':'No matching rows.'),false));
  for(const values of sheet.rows)parts.push(b.add(row(values.map((value,j)=>typedCell(value,columns[j]).text),false)));
 }
 parts.push('}\n');
 return {buffer:Buffer.from(parts.join(''),'utf8'),notes:{clipped:false,substituted:false}};
}

// A typed file is produced whole or not at all: the bounded budget refuses an
// oversized report during assembly and the caller receives an error, never a
// truncated workbook, PDF or RTF.
export function buildTypedReportFile(format,document){
 const specification=TYPED_EXPORT_FORMATS[format];
 if(!specification)throw new ReportError('Choose xlsx, pdf or rtf for a typed export.',400);
 if(!document||typeof document.title!=='string'||!Array.isArray(document.provenance)||!Array.isArray(document.sheets)||!document.sheets.length)throw new ReportError('A typed export needs a titled document with at least one section.',503);
 const b=budget(),built=format==='xlsx'?workbookBuffer(document,b):format==='pdf'?pdfDocument(document,b):rtfDocument(document,b);
 if(built.buffer.length>REPORT_LIMITS.exportCsvBytes)throw new ReportError('Complete '+specification.label+' exceeds the 8 MB export limit. Narrow the report; no partial export was generated.',413);
 return {...specification,format,buffer:built.buffer,notes:built.notes};
}


// Definitions live beside each workspace's records; the extra scope key also
// prevents accidental sharing when a host uses one connection for several tenants.
export function installReportingRoutes(app,{list,audit,csrf,write,transaction,db,collections,documentMigrationTenantId=null,communicationWorkflows=null,peerFundraising=null,hostedGiving=null,marketingResponses=null}){
 db.exec(`CREATE TABLE IF NOT EXISTS custom_reports(id TEXT NOT NULL, scope TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope,id))`);
 const adminEntities=new Set(['marketingBindings','marketingResponseEvents','marketingCampaignObservations','hostedGivingIntents','hostedGivingEvents','hostedGivingHistory','peerFundraisers','peerFundraiserVersions','peerGiftAttributions','peerGiftAttributionHistory','communicationWorkflows','communicationWorkflowMemberships','communicationWorkflowEntries','communicationWorkflowExecutions','communicationWorkflowOutcomes','documentMigrationMappings','documentMigrationReconciliations','taskReminderSchedules','taskReminderOutcomes','taskReminderInbox','eventHelperAssignments','eventHelperAccessHistory','identityAliases','migrationBatches','migrationMappings','receiptProfiles','receiptProfileRevisions','accountStructureHistory','workspaceUsers','workspaceSettings','auditHistory','tributes','tributeVersions','tributeNotifications','tributeNotificationFinalizations','tributeNotificationWithdrawals']);
 const enforceSourceRole=(entity,user)=>{if(adminEntities.has(entity)&&user.role!=='admin')throw new ReportError('This report source requires administrator access.',403);};
 const requiredRole=(entity,user)=>adminEntities.has(entity)||['documents','documentRevisions','reportDeliveries','customReportDefinitions','grantMilestones','grantMilestoneVersions','grantMilestoneEvidence'].includes(entity)&&user.role==='admin'?'admin':'authenticated';
 const scope=req=>String(req?.tenantId??req?.tenant?.id??'workspace');
 const authorized=user=>{if(!user)throw new ReportError('Sign in to use reports.',401);if(!['admin','staff','viewer'].includes(user.role))throw new ReportError('Your role cannot access reports.',403);};
 const data=req=>{
  const entity=req.reportEntity,deps=new Set(!entity||['documents','documentRevisions','migrationMappings','documentMigrationMappings','documentMigrationReconciliations'].includes(entity)?collections:['constituents','events',entity]);
  if(['gifts','giftAllocations'].includes(entity))for(const c of ['gifts','designations','campaigns','grants','pledges'])deps.add(c);
  if(['hostedGivingIntents','hostedGivingHistory','peerGiftAttributions','peerGiftAttributionHistory','giftFinancialCorrections','correspondenceFulfillments'].includes(entity))deps.add('gifts');
  if(entity==='taskAssignmentHistory')deps.add('tasks');
  if(['communicationWorkflowExecutions','correspondenceFulfillments'].includes(entity))deps.add('communications');
  return Object.fromEntries(collections.filter(c=>deps.has(c)).map(c=>[c,c==='communications'&&communicationWorkflows&&(!entity||entity==='communications')?list(c,req).map(r=>{const origin=communicationWorkflows.getDraftOrigin(r.id,req.user);return {...r,...(origin?{workflowOrigin:origin}:{})};}):list(c,req)]));
 };
 const json=value=>{try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{throw new ReportError('Stored report metadata is invalid. Ask an administrator to reconcile it.',503);}};
 const hasTable=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
 // A8.8 account structure, joined for reporting only. A designation carries at
 // most ONE account (the link table's primary key), so an allocation posted once
 // is counted exactly once in every location and function view even when one
 // function serves many locations. Whether a designation may ever report under
 // several accounts at once is an open buyer question and no apportionment rule
 // is invented here. Reading these tables never links, unlinks or rewrites
 // anything, and a workspace without the tables is unchanged.
 const ACCOUNT_TABLES=['account_designation_links','account_pairs','account_locations','account_functions'];
 const ACCOUNT_LINK_SQL='SELECT l.designation_id,l.pair_id,l.designation_version,l.version,l.linked_at,l.updated_at,l.actor,p.code AS pair_code,p.status AS pair_status,p.location_id,p.function_id,loc.code AS location_code,loc.name AS location_name,loc.status AS location_status,fn.code AS function_code,fn.name AS function_name,fn.status AS function_status FROM account_designation_links l JOIN account_pairs p ON p.id=l.pair_id JOIN account_locations loc ON loc.id=p.location_id JOIN account_functions fn ON fn.id=p.function_id ORDER BY l.designation_id';
 const ACCOUNT_SOURCE_SQL={
  locations:'SELECT id,code,name,status,version,created_at,updated_at FROM account_locations ORDER BY code',
  functions:'SELECT id,code,name,status,version,created_at,updated_at FROM account_functions ORDER BY code',
  pairs:'SELECT p.id,p.code,p.status,p.version,p.created_at,p.updated_at,p.location_id,p.function_id,loc.code AS location_code,loc.name AS location_name,fn.code AS function_code,fn.name AS function_name,(SELECT COUNT(*) FROM account_designation_links l WHERE l.pair_id=p.id) AS linked_count FROM account_pairs p JOIN account_locations loc ON loc.id=p.location_id JOIN account_functions fn ON fn.id=p.function_id ORDER BY p.code',
  links:ACCOUNT_LINK_SQL,
  history:'SELECT id,subject,subject_id,action,detail,actor,at FROM account_structure_history ORDER BY rowid'
 };
 const designationAccounts=()=>{
  if(!ACCOUNT_TABLES.every(hasTable))return null;
  const rows=db.prepare(ACCOUNT_LINK_SQL+' LIMIT '+(REPORT_LIMITS.sourceRows+1)).all();
  if(rows.length>REPORT_LIMITS.sourceRows)throw new ReportError('Account structure links exceed 100,000 rows. No complete result was generated.',413);
  const hash=createHash('sha256'),accounts=new Map();
  for(const row of rows){
   if(typeof row.designation_id!=='string'||typeof row.pair_code!=='string'||!/^\d{3}$/.test(String(row.location_code))||!/^\d{4}$/.test(String(row.function_code)))throw new ReportError('Stored account structure codes are inconsistent.',503);
   const account={pairId:row.pair_id,pairCode:row.pair_code,pairStatus:row.pair_status,locationId:row.location_id,locationCode:row.location_code,locationName:row.location_name,locationStatus:row.location_status,functionId:row.function_id,functionCode:row.function_code,functionName:row.function_name,functionStatus:row.function_status,linkRevision:row.version,designationRevision:row.designation_version,linkedAt:row.linked_at,updatedAt:row.updated_at};
   accounts.set(row.designation_id,account);hash.update(JSON.stringify([row.designation_id,account]));hash.update('\n');
  }
  return {accounts,digest:hash.digest('hex'),linkCount:rows.length};
 };
 // Designations stay the saved record they always were; the account facts are
 // added beside them so every account view is reportable and exportable.
 const withAccountStructure=designations=>{
  const structure=designationAccounts();
  if(!structure)return designations;
  return designations.map(record=>{
   const account=structure.accounts.get(record.id);
   return {...record,accountLinkStatus:account?'Linked to an account':'Not linked to an account',...(account?{accountPairCode:account.pairCode,accountPairStatus:account.pairStatus,accountLocationCode:account.locationCode,accountLocationName:account.locationName,accountLocationStatus:account.locationStatus,accountFunctionCode:account.functionCode,accountFunctionName:account.functionName,accountFunctionStatus:account.functionStatus,accountLinkedAt:account.linkedAt,accountLinkRevision:account.linkRevision,accountLinkedDesignationRevision:account.designationRevision}:{})};
  });
 };
 const readRows=(sql,catalogOnly=false)=>{const limit=catalogOnly?REPORT_LIMITS.catalogSampleRows:REPORT_LIMITS.sourceRows;const result=db.prepare(sql+' LIMIT '+(limit+1)).all();if(!catalogOnly&&result.length>limit)throw new ReportError('Selected report source acquisition exceeds 100,000 rows. No complete result was generated. Use a dedicated reporting service for this source.',413);return catalogOnly?result.slice(0,limit):result;};
 const centsValue=value=>{if(value==null)return null;if(typeof value==='string'&&!/^\d+$/.test(value)||typeof value!=='string'&&!Number.isSafeInteger(value))throw new ReportError('Stored metadata money must be exact integer cents.',503);const n=BigInt(value);if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new ReportError('Stored metadata money exceeds safe integer cents.',503);return Number(n);};
 const templateMeta=value=>{const p=json(value);return Object.fromEntries(['name','kind','subject','body'].filter(k=>typeof p[k]==='string').map(k=>[k,p[k]]));};
 const safeDefinition=value=>{const p=json(value);return {name:typeof p.name==='string'?p.name:null,entity:typeof p.entity==='string'?p.entity:null,columns:Array.isArray(p.columns)?p.columns.filter(v=>typeof v==='string').slice(0,20):[],filters:Array.isArray(p.filters)?p.filters.slice(0,12).map(f=>Object.fromEntries(['field','op','value'].filter(k=>Object.hasOwn(f||{},k)&&(['field','op'].includes(k)?typeof f[k]==='string':['string','number'].includes(typeof f[k])||Array.isArray(f[k])&&f[k].every(v=>['string','number'].includes(typeof v)))).map(k=>[k,f[k]]))):[],groupBy:Array.isArray(p.groupBy)?p.groupBy.filter(v=>typeof v==='string').slice(0,3):[],aggregates:Array.isArray(p.aggregates)?p.aggregates.slice(0,8).map(a=>Object.fromEntries(['op','field','label'].filter(k=>typeof a?.[k]==='string').map(k=>[k,a[k]]))):[],includeVoided:p.includeVoided===true};};
 function metadata(req,selected=null,catalogOnly=false){
  const wants=(...entities)=>!selected||entities.includes(selected),rows=sql=>readRows(sql,catalogOnly);
  const lookup=collection=>{let index;const current=()=>index??=new Map(list(collection,req).map(r=>[r.id,r]));return {get:id=>current().get(id),has:id=>current().has(id)};};
  authorized(req.user);const result={},admin=req.user.role==='admin',people=lookup('constituents');
  if(admin&&peerFundraising&&wants('peerFundraisers','peerFundraiserVersions','peerGiftAttributions','peerGiftAttributionHistory'))Object.assign(result,peerFundraising.reportSources(req.user));
  if(admin&&hostedGiving&&wants('hostedGivingIntents','hostedGivingEvents','hostedGivingHistory'))Object.assign(result,hostedGiving.reportSources(req.user));
  if(admin&&marketingResponses&&wants('marketingBindings','marketingResponseEvents','marketingCampaignObservations'))Object.assign(result,marketingResponses.reportSources(req.user));
  const add=(entity,table,sql,project)=>{if(wants(entity)&&hasTable(table))result[entity]=rows(sql).map(project);};
  if(wants('documents','documentRevisions')&&hasTable('documents')&&hasTable('document_revisions')){
   const where=admin?'':" WHERE d.visibility<>'Administrators'";
   const external=hasTable('document_revision_storage'),storageJoin=external?' LEFT JOIN document_revision_storage s ON s.document_id=r.document_id AND s.revision=r.revision':'',storedSize=external?'CASE WHEN length(r.bytes)>0 THEN length(r.bytes) ELSE COALESCE(s.size,0) END':'length(r.bytes)';
   if(wants('documents'))result.documents=rows('SELECT d.*, (SELECT COUNT(*) FROM document_revisions r WHERE r.document_id=d.id) AS revision_count, r.filename,r.mime,'+storedSize+' AS latest_size FROM documents d LEFT JOIN document_revisions r ON r.document_id=d.id AND r.revision=(SELECT MAX(x.revision) FROM document_revisions x WHERE x.document_id=d.id)'+storageJoin+where+' ORDER BY d.id').map(r=>({id:r.id,collection:r.collection,recordId:r.record_id,title:r.title,category:r.category,visibility:r.visibility,status:r.status,evidenceDate:r.evidence_date,archived:Boolean(r.archived),createdAt:r.created_at,updatedAt:r.updated_at,retentionUntil:r.retention_until,revisionCount:r.revision_count,latestFilename:r.filename,latestMime:r.mime,latestSize:r.latest_size}));
   if(wants('documentRevisions'))result.documentRevisions=rows('SELECT r.document_id,r.revision,r.filename,r.mime,'+storedSize+' AS size,r.sha256,r.actor,r.at,r.metadata,d.collection,d.record_id,d.title,d.visibility FROM document_revisions r JOIN documents d ON d.id=r.document_id'+storageJoin+where+' ORDER BY r.document_id,r.revision').map(r=>{const m=json(r.metadata);return {id:r.document_id+':'+r.revision,documentId:r.document_id,collection:r.collection,recordId:r.record_id,title:r.title,visibility:r.visibility,revision:r.revision,filename:r.filename,mime:r.mime,size:r.size,sha256:r.sha256,actor:r.actor,at:r.at,metadata:Object.fromEntries(['title','category','visibility','status','evidenceDate'].filter(k=>typeof m[k]==='string'||m[k]===null).map(k=>[k,m[k]]))};}).filter(r=>admin||r.metadata.visibility==='Workspace');
  }
  // A8.8 account structure. Locations, functions, the unique location/function
  // accounts and their designation links are ordinary business data and stay
  // readable by every reporting role (Q&A54): account structure grants no
  // permission and carries no consent. The append-only change history carries
  // actor identity, so it follows the retained-audit precedent and stays
  // administrator-only. A workspace without these tables acquires nothing.
  const accountCode=(value,digits)=>{if(typeof value!=='string'||!new RegExp('^\\d{'+digits+'}$').test(value))throw new ReportError('Stored account structure codes are inconsistent.',503);return value;};
  add('accountLocations','account_locations',ACCOUNT_SOURCE_SQL.locations,r=>({id:r.id,code:accountCode(r.code,3),name:r.name,status:r.status,revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));
  add('accountFunctions','account_functions',ACCOUNT_SOURCE_SQL.functions,r=>({id:r.id,code:accountCode(r.code,4),name:r.name,status:r.status,revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));
  if(hasTable('account_locations')&&hasTable('account_functions')&&hasTable('account_designation_links')){
   // One account per location/function pair, and the linked-designation count is
   // one indexed grouped read rather than a query per account.
   add('accountPairs','account_pairs',ACCOUNT_SOURCE_SQL.pairs,r=>({id:r.id,code:r.code,status:r.status,locationId:r.location_id,locationCode:accountCode(r.location_code,3),locationName:r.location_name,functionId:r.function_id,functionCode:accountCode(r.function_code,4),functionName:r.function_name,linkedDesignationCount:r.linked_count,revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));
   if(wants('accountDesignationLinks')&&hasTable('account_pairs')){
    // A designation carries at most one account, so this source has one row per
    // linked designation and can never multiply an allocation. Links are shown
    // only for designations this request can already read.
    const funds=lookup('designations');
    result.accountDesignationLinks=rows(ACCOUNT_LINK_SQL).filter(r=>funds.has(r.designation_id)).map(r=>({id:r.designation_id,designationId:r.designation_id,designationName:funds.get(r.designation_id)?.name??null,pairId:r.pair_id,pairCode:r.pair_code,locationCode:accountCode(r.location_code,3),locationName:r.location_name,functionCode:accountCode(r.function_code,4),functionName:r.function_name,designationRevision:r.designation_version,revision:r.version,linkedAt:r.linked_at,updatedAt:r.updated_at,actor:r.actor}));
   }
  }
  add('households','households','SELECT * FROM households ORDER BY id',r=>{const memberIds=hasTable('household_members')?db.prepare('SELECT constituent_id FROM household_members WHERE household_id=? ORDER BY constituent_id').all(r.id).map(m=>m.constituent_id):[];return {id:r.id,name:r.name,address:r.address,memberIds,memberCount:memberIds.length,createdAt:r.created_at,updatedAt:r.updated_at};});
  if(hasTable('households'))add('householdMemberships','household_members','SELECT m.household_id,m.constituent_id,h.name FROM household_members m JOIN households h ON h.id=m.household_id ORDER BY m.household_id,m.constituent_id',r=>({id:r.household_id+':'+r.constituent_id,householdId:r.household_id,householdName:r.name,constituentId:r.constituent_id}));
  if(admin){
   if(wants('communicationWorkflows','communicationWorkflowMemberships','communicationWorkflowEntries','communicationWorkflowExecutions','communicationWorkflowOutcomes')&&hasTable('communication_workflows')){
    const workflowSource=r=>{if(typeof r.workflow_id!=='string'||typeof r.owner_id!=='string'||typeof r.audience_id!=='string'||typeof r.template_id!=='string'||!Number.isSafeInteger(r.audience_version)||r.audience_version<1||!Number.isSafeInteger(r.template_version)||r.template_version<1)throw new ReportError('Stored workflow activation provenance is unavailable.',503);return {workflowId:r.workflow_id,ownerId:r.owner_id,audienceId:r.audience_id,audienceRevision:r.audience_version,templateId:r.template_id,templateRevision:r.template_version,channel:r.channel};};
    const workflowJoin=' LEFT JOIN communication_workflows w ON w.id=h.workflow_id';
    add('communicationWorkflows','communication_workflows','SELECT * FROM communication_workflows ORDER BY id',r=>({id:r.id,name:r.name,status:r.status,revision:r.version,ownerId:r.owner_id,ownerRevision:r.owner_version,audienceId:r.audience_id,audienceRevision:r.audience_version,templateId:r.template_id,templateRevision:r.template_version,channel:r.channel,baselineCount:r.baseline_count,createdAt:r.created_at,updatedAt:r.updated_at,nextAttempt:r.status==='Active'?r.next_attempt:null,failureCount:r.failure_count,delivery:'Not sent'}));
    add('communicationWorkflowMemberships','communication_workflow_memberships','SELECT h.*,w.owner_id,w.audience_id,w.audience_version,w.template_id,w.template_version,w.channel FROM communication_workflow_memberships h'+workflowJoin+' ORDER BY h.workflow_id,h.constituent_id',r=>({id:r.workflow_id+':'+r.constituent_id,...workflowSource(r),constituentId:r.constituent_id,eligible:Boolean(r.eligible),episode:r.episode,sourceRevision:r.record_version,lastSeenAt:r.last_seen_at}));
    add('communicationWorkflowEntries','communication_workflow_entries','SELECT h.*,w.owner_id,w.audience_id,w.audience_version,w.template_id,w.template_version,w.channel FROM communication_workflow_entries h'+workflowJoin+' ORDER BY h.id',r=>({id:r.id,...workflowSource(r),constituentId:r.constituent_id,episode:r.episode,sourceRevision:r.source_version,status:r.status,revision:r.version,attemptCount:r.attempt_count,nextAttempt:r.status==='Pending'?r.next_attempt:null,createdAt:r.created_at,updatedAt:r.updated_at,delivery:'Not sent'}));
    add('communicationWorkflowExecutions','communication_workflow_executions','SELECT h.*,w.owner_id,w.audience_id,w.template_id,w.channel,w.audience_version AS activation_audience_version,w.template_version AS activation_template_version,e.constituent_id AS entry_constituent_id,e.workflow_id AS entry_workflow_id,e.episode AS entry_episode,e.source_version AS entry_source_version FROM communication_workflow_executions h'+workflowJoin+' LEFT JOIN communication_workflow_entries e ON e.id=h.entry_id ORDER BY h.id',r=>{
     if(r.entry_workflow_id!==r.workflow_id||r.entry_constituent_id!==r.constituent_id||r.entry_episode!==r.episode||r.entry_source_version!==r.source_version||r.activation_audience_version!==r.audience_version||r.activation_template_version!==r.template_version||r.delivery!=='Not sent')throw new ReportError('Stored workflow draft provenance is inconsistent.',503);
     const origin=communicationWorkflows?.getDraftOrigin(r.communication_id,req.user);
     if(origin&&(origin.workflowId!==r.workflow_id||origin.episode!==r.episode||origin.producedAt!==r.at))throw new ReportError('Stored workflow draft linkage is inconsistent.',503);
     return {id:r.id,...workflowSource(r),entryId:r.entry_id,constituentId:r.constituent_id,episode:r.episode,sourceRevision:r.source_version,communicationId:r.communication_id,communicationRevision:r.communication_version,actorId:r.actor,at:r.at,delivery:'Not sent',sourceCurrent:origin?.sourceCurrent===true,reviewRequired:true};
    });
    add('communicationWorkflowOutcomes','communication_workflow_outcomes','SELECT * FROM communication_workflow_outcomes ORDER BY id',r=>({id:r.id,workflowId:r.workflow_id,workflowRevision:r.workflow_version,entryId:r.entry_id,entryRevision:r.entry_version,status:r.status,reason:r.reason,at:r.at,retryAt:r.retry_at,delivery:'Not sent'}));
   }
   if(wants('documentMigrationMappings','documentMigrationReconciliations')&&hasTable('document_migration_reconciliations')){
    const importedRevision=r=>{if(documentMigrationTenantId&&r.tenant_id!==documentMigrationTenantId||!Number.isSafeInteger(r.revision)||r.revision<1||!Number.isSafeInteger(r.record_version)||r.record_version<1||!Number.isSafeInteger(r.size)||r.size<1)throw new ReportError('Stored contract conversion provenance is inconsistent.',503);const p=json(r.metadata);return {reconciliationId:r.id,sourceNamespace:r.source_namespace,sourceDocumentId:r.source_document_id,sourceRevisionId:r.source_revision_id,sourceVisibility:r.source_visibility,originalDate:r.original_date,documentId:r.document_id,documentRevision:r.revision,collection:r.collection,recordId:r.record_id,recordRevision:r.record_version,requestedDocumentRevision:r.requested_document_version,operation:r.requested_document_version===null?'Create':'Append',importedCategory:typeof p.category==='string'?p.category:null,importedStatus:typeof p.status==='string'?p.status:null,importedVisibility:typeof p.visibility==='string'?p.visibility:null,importedEvidenceDate:typeof p.evidenceDate==='string'?p.evidenceDate:null,mime:r.mime,sha256:r.sha256,size:r.size,sourceRevisionCount:1,nativeRevisionCount:1,sourceBytes:r.size,nativeBytes:r.size,actor:r.actor,importedAt:r.at};};
    add('documentMigrationReconciliations','document_migration_reconciliations','SELECT * FROM document_migration_reconciliations ORDER BY id',r=>({id:r.id,...importedRevision(r)}));
    add('documentMigrationMappings','document_migration_mappings','SELECT m.source_namespace AS mapped_namespace,m.source_document_id AS mapped_source_document_id,m.source_revision_id AS mapped_source_revision_id,m.document_id AS mapped_document_id,m.revision AS mapped_revision,m.source_hash AS mapped_source_hash,m.native_hash AS mapped_native_hash,r.* FROM document_migration_mappings m LEFT JOIN document_migration_reconciliations r ON r.id=m.reconciliation_id ORDER BY m.source_namespace,m.source_document_id,m.source_revision_id',r=>{if(!r.id||r.mapped_namespace!==r.source_namespace||r.mapped_source_document_id!==r.source_document_id||r.mapped_source_revision_id!==r.source_revision_id||r.mapped_document_id!==r.document_id||r.mapped_revision!==r.revision||r.mapped_source_hash!==r.source_hash||r.mapped_native_hash!==r.native_hash)throw new ReportError('Stored contract source mapping is inconsistent.',503);const p=importedRevision(r);return {id:JSON.stringify([p.sourceNamespace,p.sourceDocumentId,p.sourceRevisionId]),...p};});
   }
   add('taskReminderSchedules','task_reminders','SELECT * FROM task_reminders ORDER BY id',r=>({id:r.id,taskId:r.task_id,ownerId:r.owner_id,taskRevision:r.task_version,ownerRevision:r.owner_version,remindAt:r.remind_at,status:r.status,revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at,nextAttempt:r.status==='Active'?r.next_attempt:null,attemptCount:r.attempt_count}));
   add('taskReminderOutcomes','task_reminder_outcomes','SELECT * FROM task_reminder_outcomes ORDER BY reminder_id,at,id',r=>({id:r.id,reminderId:r.reminder_id,reminderRevision:r.reminder_version,status:r.status,reason:r.reason,at:r.at,retryAt:r.retry_at}));
   add('taskReminderInbox','task_reminder_inbox','SELECT * FROM task_reminder_inbox ORDER BY delivered_at,id',r=>({id:r.id,reminderId:r.reminder_id,ownerId:r.owner_id,taskId:r.task_id,taskRevision:r.task_version,deliveredAt:r.delivered_at,delivery:'Internal only'}));

   add('eventHelperAssignments','event_helper_assignments','SELECT * FROM event_helper_assignments ORDER BY user_id,event_id',r=>({id:r.user_id+':'+r.event_id,userId:r.user_id,eventId:r.event_id,active:Boolean(r.active),revision:r.version,updatedAt:r.updated_at}));
   add('eventHelperAccessHistory','event_helper_access_changes','SELECT * FROM event_helper_access_changes ORDER BY user_id,to_version',r=>{const actor=json(r.actor_json),before=JSON.parse(r.before_json),after=JSON.parse(r.after_json);return {id:r.id,userId:r.user_id,fromRevision:r.from_version,toRevision:r.to_version,beforeEventIds:Array.isArray(before)?before.filter(v=>typeof v==='string'):[],afterEventIds:Array.isArray(after)?after.filter(v=>typeof v==='string'):[],reason:r.reason,actorId:typeof actor.id==='string'?actor.id:null,actorName:typeof actor.name==='string'?actor.name:null,at:r.at};});
   add('identityAliases','identity_aliases','SELECT source_id,target_id,reason,actor,at FROM identity_aliases ORDER BY source_id',r=>({id:r.source_id,sourceId:r.source_id,targetId:r.target_id,sourceName:people.get(r.source_id)?.name||null,targetName:people.get(r.target_id)?.name||null,reason:r.reason,actor:r.actor,at:r.at}));
   add('migrationMappings','migration_mapping','SELECT source,collection,external_id,record_id,batch_id FROM migration_mapping ORDER BY source,collection,external_id',r=>({id:JSON.stringify([r.source,r.collection,r.external_id]),source:r.source,collection:r.collection,externalId:r.external_id,recordId:r.record_id,batchId:r.batch_id}));
   add('migrationBatches','import_batches','SELECT id,source,file_key,committed_at,actor,result FROM import_batches ORDER BY id',r=>{const p=json(r.result),s=p.summary||{},c=p.reconciliation||{};return {id:r.id,source:r.source,fileKey:r.file_key,committedAt:r.committed_at,actor:r.actor,valid:p.valid===true,totalRows:s.rowCount??null,createCount:s.createCounts?Object.values(s.createCounts).reduce((n,v)=>n+(Number.isSafeInteger(v)?v:0),0):null,mappedCount:s.reusedRows??null,errorRows:s.errorRows??null,giftCount:s.gifts??null,allocationCount:s.allocationCount??null,...Object.fromEntries(['newGiftTotalCents','allocationTotalCents','monetaryContributionCents','noncashValueCents','feePaymentCents'].map(k=>[k,centsValue(s[k])])),actualNewGiftCents:centsValue(c.actualNewGiftCents)};});
  }
  if(wants('customReportDefinitions'))result.customReportDefinitions=db.prepare('SELECT id,definition,created_at,updated_at FROM custom_reports WHERE scope=? ORDER BY id LIMIT '+(catalogOnly?REPORT_LIMITS.catalogSampleRows:REPORT_LIMITS.sourceRows+1)).all(scope(req)).map(r=>{const d=safeDefinition(r.definition);return {id:r.id,...d,columnCount:d.columns.length,filterCount:d.filters.length,groupCount:d.groupBy.length,calculationCount:d.aggregates.length,createdAt:r.created_at,updatedAt:r.updated_at};}).filter(r=>admin||!adminEntities.has(r.entity));
  add('reportSchedules','report_schedules','SELECT id,report_id,name,owner_id,cadence,next_run,status,created_at,updated_at FROM report_schedules ORDER BY id',r=>({id:r.id,reportId:r.report_id,name:r.name,ownerId:r.owner_id,cadence:r.cadence,nextRun:r.next_run,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at}));
  if(hasTable('report_schedules'))add('reportDeliveries','report_deliveries','SELECT d.id,d.schedule_id,d.scheduled_at,d.executed_at,d.status,d.report_version,d.result,d.error,s.report_id,s.name FROM report_deliveries d JOIN report_schedules s ON s.id=d.schedule_id ORDER BY d.id',r=>{const p=r.result?json(r.result):null;let sourceDenied=false;try{assertStoredReportAccess(p,req.user,req);}catch(e){if(e.status!==403)throw e;sourceDenied=true;}const restricted=sourceDenied||p&&(p.requiredRole==='admin'||!p.requiredRole&&(adminEntities.has(p.definition?.entity)||['documents','documentRevisions','reportDeliveries','customReportDefinitions'].includes(p.definition?.entity)));return {id:r.id,scheduleId:r.schedule_id,reportId:r.report_id,name:r.name,scheduledAt:r.scheduled_at,executedAt:r.executed_at,status:r.status,reportVersion:r.report_version,error:r.error,resultSummary:!p||!admin&&restricted?null:{matchedRows:Number.isSafeInteger(p.matchedRows)?p.matchedRows:null,totalResultRows:Number.isSafeInteger(p.totalResultRows)?p.totalResultRows:null,returnedRows:Array.isArray(p.rows)?p.rows.length:null,columnCount:Array.isArray(p.columns)?p.columns.length:null,truncated:p.truncated===true,textTruncated:p.textTruncated===true}};});
  const audienceMeta=value=>{const p=json(value),f=p.filters||{};return {name:typeof p.name==='string'?p.name:null,segmentLabels:Array.isArray(f.segmentTokens)?f.segmentTokens.filter(v=>typeof v==='string'):[],segmentMatch:typeof f.segmentMatch==='string'?f.segmentMatch:null,types:Array.isArray(f.types)?f.types.filter(v=>typeof v==='string'):[],preferences:Array.isArray(f.preferences)?f.preferences.filter(v=>typeof v==='string'):[]};};
  add('savedAudiences','audience_definitions','SELECT * FROM audience_definitions ORDER BY id',r=>({id:r.id,revision:r.version,status:r.status,...audienceMeta(r.definition),createdAt:r.created_at,updatedAt:r.updated_at}));
  add('audienceRevisions','audience_revisions','SELECT * FROM audience_revisions ORDER BY audience_id,version',r=>({id:r.audience_id+':'+r.version,audienceId:r.audience_id,revision:r.version,status:r.status,...audienceMeta(r.definition),reason:r.reason,actor:r.actor,at:r.at}));
  add('correspondenceTemplates','correspondence_templates','SELECT id,definition,created_at,updated_at FROM correspondence_templates ORDER BY id',r=>({id:r.id,...templateMeta(r.definition),createdAt:r.created_at,updatedAt:r.updated_at}));
  add('correspondenceTemplateRevisions','correspondence_template_revisions','SELECT template_id,version,definition,actor,at FROM correspondence_template_revisions ORDER BY template_id,version',r=>({id:r.template_id+':'+r.version,templateId:r.template_id,revision:r.version,...templateMeta(r.definition),actor:r.actor,at:r.at}));
  add('correspondencePreparations','correspondence_preparations','SELECT id,snapshot,actor,at FROM correspondence_preparations ORDER BY id',r=>{const p=json(r.snapshot),items=Array.isArray(p.items)?p.items:[];let monetary=0n,noncash=0n;const gifts=new Set();for(const item of items){monetary+=BigInt(centsValue(item.semantics?.monetaryCents)??0);noncash+=BigInt(centsValue(item.semantics?.noncashCents)??0);for(const ref of item.references||[])if(ref.collection==='gifts'&&typeof ref.id==='string')gifts.add(ref.id);}return {id:r.id,templateId:p.template?.id??null,templateName:p.template?.name??null,templateKind:p.template?.kind??null,templateRevision:p.template?.version??null,channel:p.channel??null,audienceId:typeof p.audience?.id==='string'?p.audience.id:null,audienceName:typeof p.audience?.name==='string'?p.audience.name:null,audienceRevision:Number.isSafeInteger(p.audience?.version)?p.audience.version:null,audienceSelectedCount:Array.isArray(p.audience?.selectedConstituentIds)?p.audience.selectedConstituentIds.length:0,organizationName:p.organizationName??null,recipientCount:items.length,giftCount:gifts.size,monetaryCents:centsValue(monetary.toString()),noncashCents:centsValue(noncash.toString()),delivery:'Not sent',status:hasTable('correspondence_finalizations')&&db.prepare('SELECT 1 FROM correspondence_finalizations WHERE preparation_id=?').get(r.id)?'Finalized':'Prepared',actor:r.actor,at:r.at};});
  add('correspondenceFinalizations','correspondence_finalizations','SELECT preparation_id,actor,at FROM correspondence_finalizations ORDER BY preparation_id',r=>({id:r.preparation_id,preparationId:r.preparation_id,actor:r.actor,at:r.at,humanReviewed:true,delivery:'Not sent'}));
  const gifts=lookup('gifts'),events=lookup('events'),campaigns=lookup('campaigns'),asOf=new Date().toISOString().slice(0,10);
  const pick=(p,keys)=>Object.fromEntries(keys.filter(k=>typeof p[k]==='string'||typeof p[k]==='number'||typeof p[k]==='boolean'||p[k]===null).map(k=>[k,p[k]]));
  const correctionReferences=value=>{let refs;try{refs=JSON.parse(value);}catch{throw new ReportError('Stored financial correction references are invalid.',503);}if(!Array.isArray(refs)||refs.some(ref=>!ref||!['constituents','campaigns','pledges','grants','designations'].includes(ref.collection)||typeof ref.id!=='string'||!Number.isSafeInteger(ref.version)||ref.version<1))throw new ReportError('Stored financial correction references are invalid.',503);return refs.map(ref=>({collection:ref.collection,id:ref.id,revision:ref.version}));};
  const correctionFacts=(value,prefix)=>{const p=json(value),facts=Object.fromEntries(['Date','ConstituentId','Type','Method','CampaignId','Pledge','PledgeId','GrantId','SoftCreditId','ExternalRef','GiftKind'].map(key=>[prefix+key,typeof p[key[0].toLowerCase()+key.slice(1)]==='string'?p[key[0].toLowerCase()+key.slice(1)]:null]));if(!Array.isArray(p.allocations))throw new ReportError('Stored financial correction allocations are invalid.',503);const allocations=p.allocations.map(a=>{if(typeof a?.designationId!=='string')throw new ReportError('Stored financial correction allocation source is invalid.',503);return {designationId:a.designationId,amount:centsValue(a.amount)};});const amount=centsValue(p.amount);if(amount===null||allocations.some(a=>a.amount===null)||allocations.reduce((sum,a)=>sum+BigInt(a.amount),0n)!==BigInt(amount))throw new ReportError('Stored financial correction allocations do not reconcile.',503);return {...facts,[prefix+'AmountCents']:amount,[prefix+'Allocations']:allocations};};
  if(wants('giftFinancialCorrections')&&hasTable('gift_financial_corrections'))result.giftFinancialCorrections=rows('SELECT * FROM gift_financial_corrections ORDER BY gift_id,from_version,id').filter(r=>gifts.has(r.gift_id)).map(r=>{const actor=json(r.actor_json);let changed;try{changed=JSON.parse(r.changed_fields);}catch{throw new ReportError('Stored financial correction fields are invalid.',503);}const allowed=new Set(['constituentId','amount','type','method','date','campaignId','allocations','externalRef','softCreditId','pledge','pledgeId','grantId','giftKind']);if(!Array.isArray(changed)||changed.some(field=>!allowed.has(field)))throw new ReportError('Stored financial correction fields are invalid.',503);return {id:r.id,giftId:r.gift_id,fromRevision:r.from_version,toRevision:r.to_version,changedFields:changed,reason:r.reason,actorId:typeof actor.id==='string'?actor.id:null,actorName:typeof actor.name==='string'?actor.name:null,actorRole:typeof actor.role==='string'?actor.role:null,at:r.at,...correctionFacts(r.before_json,'before'),...correctionFacts(r.after_json,'after'),sourceVersions:{before:correctionReferences(r.before_references),after:correctionReferences(r.after_references)}};});

  const fundraisingMeta=value=>{const p=json(value),original=p.originalSnapshot||{};return {...(p.latestFollowup&&typeof p.latestFollowup==='object'&&!Array.isArray(p.latestFollowup)?{latestFollowup:pick(p.latestFollowup,['date','outcome','previousDueDate','nextActionDate','actor'])}:{}),...pick(p,['nextActionStatus','kind','name','donorId','ownerId','stage','nextActionDate','instrument','status','campaignId','originalGiftId','matchingOrganizationId','ratioNumerator','ratioDenominator','notes']),...Object.fromEntries(['expectedAmount','commitmentAmount','capAmount'].map(k=>[k,centsValue(p[k])])),donorName:people.get(p.donorId)?.name??null,campaignName:campaigns.get(p.campaignId)?.name??null,matchingOrganizationName:people.get(p.matchingOrganizationId)?.name??null,originalGiftRevision:Number.isSafeInteger(original.version)?original.version:Number.isSafeInteger(p.originalGiftVersion)?p.originalGiftVersion:null,originalGiftAmountCents:centsValue(original.amount)};};
  add('fundraisingRecords','fundraising_records','SELECT id,version,data,created_at,updated_at FROM fundraising_records ORDER BY id',r=>({id:r.id,...fundraisingMeta(r.data),revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));
  add('fundraisingVersions','fundraising_versions','SELECT record_id,version,data,actor,at FROM fundraising_versions ORDER BY record_id,version',r=>({id:r.record_id+':'+r.version,recordId:r.record_id,revision:r.version,...fundraisingMeta(r.data),actor:r.actor,at:r.at}));
  add('fundraisingAssociations','fundraising_associations','SELECT id,record_id,gift_id,version,status,gift_version,snapshot,created_at,unlinked_at,unlink_reason FROM fundraising_associations ORDER BY id',r=>{const p=json(r.snapshot),g=gifts.get(r.gift_id),received=r.status==='active'&&g?.status==='Posted'&&g.date<=asOf;return {id:r.id,recordId:r.record_id,giftId:r.gift_id,revision:r.version,status:r.status,giftRevision:r.gift_version,associatedDonorId:typeof p.constituentId==='string'?p.constituentId:null,associatedAmountCents:centsValue(p.amount),associatedType:typeof p.type==='string'?p.type:null,associatedGiftKind:typeof p.giftKind==='string'?p.giftKind:null,associatedCampaignId:typeof p.campaignId==='string'?p.campaignId:null,associatedDate:typeof p.date==='string'?p.date:null,currentGiftAmountCents:centsValue(g?.amount),currentGiftStatus:g?.status??null,receivedAmountCents:received?centsValue(g.amount):0,asOf,createdAt:r.created_at,unlinkedAt:r.unlinked_at,unlinkReason:r.unlink_reason};});
  add('fundraisingActivity','fundraising_activity','SELECT id,record_id,actor,date,note,action,at FROM fundraising_activity ORDER BY id',r=>({id:r.id,recordId:r.record_id,actor:r.actor,date:r.date,note:r.note,action:r.action,at:r.at}));
  if(wants('taskAssignmentHistory')&&hasTable('task_assignments')){const visibleTasks=new Set(list('tasks',req).map(task=>task.id));result.taskAssignmentHistory=rows('SELECT * FROM task_assignments ORDER BY task_id,to_version,id').filter(r=>visibleTasks.has(r.task_id)).map(r=>{const before=json(r.before_owner),after=json(r.after_owner),actor=json(r.actor);return {id:r.id,taskId:r.task_id,fromRevision:r.from_version,toRevision:r.to_version,beforeOwnerId:typeof before.id==='string'?before.id:null,beforeOwnerName:typeof before.name==='string'?before.name:null,afterOwnerId:typeof after.id==='string'?after.id:null,afterOwnerName:typeof after.name==='string'?after.name:null,reason:r.reason,actorId:typeof actor.id==='string'?actor.id:null,actorName:typeof actor.name==='string'?actor.name:null,at:r.at};});}
  if(wants('correspondenceFulfillments')&&hasTable('correspondence_fulfillments')){const visibleCommunications=new Set(list('communications',req).map(c=>c.id));result.correspondenceFulfillments=rows('SELECT * FROM correspondence_fulfillments ORDER BY preparation_id,gift_id,id').filter(r=>gifts.has(r.gift_id)&&visibleCommunications.has(r.communication_id)).map(r=>{const source=json(r.source_json);return {id:r.id,preparationId:r.preparation_id,giftId:r.gift_id,sourceGiftRevision:r.source_gift_version,acknowledgmentGiftRevision:r.acknowledgment_gift_version,communicationId:r.communication_id,date:r.date,channel:r.channel,actorId:r.actor,reason:r.reason,at:r.at,templateId:typeof source.templateId==='string'?source.templateId:null,templateRevision:Number.isSafeInteger(source.templateVersion)?source.templateVersion:null,recipientId:typeof source.recipientId==='string'?source.recipientId:null,finalizedBy:typeof source.finalizedBy==='string'?source.finalizedBy:null,finalizedAt:typeof source.finalizedAt==='string'?source.finalizedAt:null,manualConfirmation:true,applicationSent:false};});}
  const receiptProfile=value=>pick(json(value),['organizationName','address','taxIdentifier','signatureLabel','customFooter','approved']);
  if(admin){
   add('taskReminderSchedules','task_reminders','SELECT * FROM task_reminders ORDER BY id',r=>({id:r.id,taskId:r.task_id,ownerId:r.owner_id,taskRevision:r.task_version,ownerRevision:r.owner_version,remindAt:r.remind_at,status:r.status,revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at,nextAttempt:r.status==='Active'?r.next_attempt:null,attemptCount:r.attempt_count}));
   add('taskReminderOutcomes','task_reminder_outcomes','SELECT * FROM task_reminder_outcomes ORDER BY reminder_id,at,id',r=>({id:r.id,reminderId:r.reminder_id,reminderRevision:r.reminder_version,status:r.status,reason:r.reason,at:r.at,retryAt:r.retry_at}));
   add('taskReminderInbox','task_reminder_inbox','SELECT * FROM task_reminder_inbox ORDER BY delivered_at,id',r=>({id:r.id,reminderId:r.reminder_id,ownerId:r.owner_id,taskId:r.task_id,taskRevision:r.task_version,deliveredAt:r.delivered_at,delivery:'Internal only'}));

   add('eventHelperAssignments','event_helper_assignments','SELECT * FROM event_helper_assignments ORDER BY user_id,event_id',r=>({id:r.user_id+':'+r.event_id,userId:r.user_id,eventId:r.event_id,active:Boolean(r.active),revision:r.version,updatedAt:r.updated_at}));
   add('eventHelperAccessHistory','event_helper_access_changes','SELECT * FROM event_helper_access_changes ORDER BY user_id,to_version',r=>{const actor=json(r.actor_json),before=JSON.parse(r.before_json),after=JSON.parse(r.after_json);return {id:r.id,userId:r.user_id,fromRevision:r.from_version,toRevision:r.to_version,beforeEventIds:Array.isArray(before)?before.filter(v=>typeof v==='string'):[],afterEventIds:Array.isArray(after)?after.filter(v=>typeof v==='string'):[],reason:r.reason,actorId:typeof actor.id==='string'?actor.id:null,actorName:typeof actor.name==='string'?actor.name:null,at:r.at};});
   add('accountStructureHistory','account_structure_history',ACCOUNT_SOURCE_SQL.history,r=>({id:r.id,subject:r.subject,subjectId:r.subject_id,action:r.action,detail:json(r.detail),actor:r.actor,at:r.at}));
   add('receiptProfiles','receipt_profiles','SELECT id,version,profile,actor,at FROM receipt_profiles ORDER BY id',r=>({id:String(r.id),revision:r.version,...receiptProfile(r.profile),actor:r.actor,at:r.at}));
   add('receiptProfileRevisions','receipt_profile_revisions','SELECT version,profile,actor,at FROM receipt_profile_revisions ORDER BY version',r=>({id:String(r.version),revision:r.version,...receiptProfile(r.profile),actor:r.actor,at:r.at}));
   add('workspaceUsers','users','SELECT id,name,email,role,active,version FROM users ORDER BY id',r=>({id:r.id,name:r.name,email:r.email,role:r.role,active:Boolean(r.active),revision:r.version}));
   add('workspaceSettings','settings','SELECT id,data FROM settings ORDER BY id',r=>({id:String(r.id),...pick(json(r.data),['organizationName','fiscalStartMonth'])}));
   add('auditHistory','audit','SELECT id,actor,action,collection,record_id,at,details FROM audit ORDER BY id',r=>({id:String(r.id),actor:r.actor,actorName:hasTable('users')?db.prepare('SELECT name FROM users WHERE id=?').get(r.actor)?.name??null:null,action:r.action,collection:r.collection,recordId:r.record_id,at:r.at,detailCount:Object.keys(json(r.details)).length}));
  }
  if(wants('receiptHistory','receiptGiftReferences')&&hasTable('receipt_preparations')&&hasTable('receipt_issues')&&hasTable('receipt_voids')){
   const receipts=rows('SELECT p.id,p.snapshot,p.actor,p.at,p.prior_receipt_id,p.reissue_reason,i.number,i.issue_date,i.confirmation,v.reason AS void_reason,v.at AS voided_at FROM receipt_preparations p LEFT JOIN receipt_issues i ON i.receipt_id=p.id LEFT JOIN receipt_voids v ON v.receipt_id=p.id ORDER BY p.id');
   result.receiptHistory=receipts.map(r=>{const p=json(r.snapshot),confirmation=r.confirmation?json(r.confirmation):{};return {id:r.id,kind:p.kind??null,recipientId:p.recipient?.id??null,recipientName:p.recipient?.name??null,calendarYear:p.calendarYear??null,monetaryCents:centsValue(p.monetaryCents),benefitValueCents:centsValue(p.benefits?.valueCents),benefitDescription:typeof p.benefits?.description==='string'?p.benefits.description:null,noncashDescription:typeof p.noncashDescription==='string'?p.noncashDescription:null,giftCount:Number.isSafeInteger(p.giftCount)?p.giftCount:null,profileRevision:Number.isSafeInteger(p.profile?.version)?p.profile.version:null,organizationName:typeof p.profile?.organizationName==='string'?p.profile.organizationName:null,taxDeductibility:p.taxDeductibility==='Not determined'?'Not determined':null,semantics:typeof p.semantics==='string'?p.semantics:null,status:r.voided_at?'Voided':r.number?'Issued':'Prepared',number:r.number,issueDate:r.issue_date,staffConfirmedPrint:confirmation.printed===true,staffConfirmedHandSign:confirmation.handSigned===true,createdAt:r.at,actor:r.actor,priorReceiptId:r.prior_receipt_id,reissueReason:r.reissue_reason,voidReason:r.void_reason,voidedAt:r.voided_at};});
   result.receiptGiftReferences=[];
   for(const r of receipts){const p=json(r.snapshot);for(const g of Array.isArray(p.gifts)?p.gifts:[]){if(result.receiptGiftReferences.length>REPORT_LIMITS.sourceRows)break;result.receiptGiftReferences.push({id:r.id+':'+g.id,receiptId:r.id,giftId:typeof g.id==='string'?g.id:null,date:typeof g.date==='string'?g.date:null,type:typeof g.type==='string'?g.type:null,monetaryCents:centsValue(g.monetaryCents),reference:typeof g.reference==='string'?g.reference:null,receiptStatus:r.voided_at?'Voided':r.number?'Issued':'Prepared'});}}
  }
  const eventMeta=r=>({eventId:r.event_id,eventName:events.get(r.event_id)?.name??null});
  add('eventTables','event_seating','SELECT * FROM event_seating ORDER BY id',r=>({id:r.id,...eventMeta(r),name:r.name,seats:r.seats,revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));
  add('eventSeatAssignments','event_seat_assignments','SELECT * FROM event_seat_assignments ORDER BY id',r=>({id:r.id,...eventMeta(r),tableId:r.table_id,constituentId:r.constituent_id,constituentName:people.get(r.constituent_id)?.name??null,seatNumber:r.seat_number,status:r.status,revision:r.version,assignedAt:r.assigned_at,cancelledAt:r.cancelled_at,cancelReason:r.cancel_reason}));
  add('eventTickets','event_tickets','SELECT * FROM event_tickets ORDER BY id',r=>({id:r.id,...eventMeta(r),constituentId:r.constituent_id,constituentName:people.get(r.constituent_id)?.name??null,priceCents:centsValue(r.price),status:r.status,revision:r.version,issuedAt:r.issued_at,checkedInAt:r.checked_in_at,cancelledAt:r.cancelled_at,cancelReason:r.cancel_reason}));
  add('eventSponsors','event_sponsorships','SELECT * FROM event_sponsorships ORDER BY id',r=>{let benefits;try{benefits=JSON.parse(r.benefits);}catch{throw new ReportError('Stored event benefits are invalid.',503);}return {id:r.id,...eventMeta(r),sponsorId:r.sponsor_id,sponsorName:people.get(r.sponsor_id)?.name??null,name:r.name,status:r.status||'Active',everFulfilled:Boolean(r.fulfilled_once),commitmentAmountCents:centsValue(r.amount),activeCommitmentAmountCents:r.status==='Cancelled'?0:centsValue(r.amount),benefits:Array.isArray(benefits)?benefits.map(b=>({name:typeof b.name==='string'?b.name:null,completed:b.completed===true})):[],revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at};});
  if(result.eventSponsors)result.eventSponsors=result.eventSponsors.filter(r=>events.has(r.eventId)&&people.has(r.sponsorId));
  add('eventAuctionItems','event_auction_items','SELECT * FROM event_auction_items ORDER BY id',r=>({id:r.id,...eventMeta(r),name:r.name,startingBidCents:centsValue(r.starting_bid),minIncrementCents:centsValue(r.min_increment),description:r.description,status:r.status,winningBidId:r.winning_bid_id,revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));
  add('eventAuctionBids','event_auction_bids','SELECT * FROM event_auction_bids ORDER BY id',r=>({id:r.id,itemId:r.item_id,bidderId:r.bidder_id,bidderName:people.get(r.bidder_id)?.name??null,amountCents:centsValue(r.amount),actor:r.actor,at:r.at}));
  if(hasTable('event_ticket_transitions')&&hasTable('event_tickets'))result.eventTicketTransitions=rows('SELECT h.*,t.event_id FROM event_ticket_transitions h JOIN event_tickets t ON t.id=h.ticket_id ORDER BY h.ticket_id,h.to_version,h.id').filter(r=>events.has(r.event_id)).map(r=>{const before=r.before_json?json(r.before_json):{},after=json(r.after_json),actor=json(r.actor_json);return {id:r.id,ticketId:r.ticket_id,eventId:r.event_id,action:r.action,fromRevision:r.from_version,toRevision:r.to_version,eventRevision:r.event_version,reason:r.reason,actorId:typeof actor.id==='string'?actor.id:null,actorName:typeof actor.name==='string'?actor.name:null,at:r.at,beforeStatus:typeof before.status==='string'?before.status:null,afterStatus:typeof after.status==='string'?after.status:null,beforeCheckedIn:Boolean(before.checked_in_at),afterCheckedIn:Boolean(after.checked_in_at),beforeCheckedInAt:typeof before.checked_in_at==='string'?before.checked_in_at:null,afterCheckedInAt:typeof after.checked_in_at==='string'?after.checked_in_at:null};});
  if(wants('eventCommitmentTransitions')&&hasTable('event_commitment_transitions')){
   const owners={sponsorship:'event_sponsorships',auction:'event_auction_items'};
   result.eventCommitmentTransitions=rows('SELECT * FROM event_commitment_transitions ORDER BY owner_type,owner_id,to_version,id').filter(r=>{const table=owners[r.owner_type],owner=table&&hasTable(table)?db.prepare('SELECT event_id FROM '+table+' WHERE id=?').get(r.owner_id):null;return owner&&events.has(owner.event_id);}).map(r=>{
    const before=r.before_json?json(r.before_json):null,after=json(r.after_json),source=json(r.source_json),actor=json(r.actor_json),eventId=source.event?.id;
    const owner=db.prepare('SELECT event_id FROM '+owners[r.owner_type]+' WHERE id=?').get(r.owner_id);
    if(eventId!==owner.event_id||source.event?.version!==r.event_version||after.id!==r.owner_id||after.event_id!==eventId||before&&(before.id!==r.owner_id||before.event_id!==eventId))throw new ReportError('Stored event commitment source links are inconsistent.',503);
    const retainedBids=[source.winningBid,source.highestBid].filter(Boolean).map(bid=>{const current=hasTable('event_auction_bids')?db.prepare('SELECT item_id,amount FROM event_auction_bids WHERE id=?').get(bid.id):null;if(r.owner_type!=='auction'||typeof bid.id!=='string'||bid.itemId!==r.owner_id||!current||current.item_id!==r.owner_id||current.amount!==centsValue(bid.amount))throw new ReportError('Stored event commitment bid sources are inconsistent.',503);return {id:bid.id,itemId:bid.itemId,amountCents:centsValue(bid.amount)};});
    if(!Array.isArray(source.receiptLinks)||source.receiptLinks.length>REPORT_LIMITS.sourceRows)throw new ReportError('Stored event commitment receipt sources are invalid.',503);
    const receiptLinks=source.receiptLinks.map(link=>{const current=hasTable('event_payment_links')?db.prepare('SELECT owner_type,owner_id,gift_id,revenue_case FROM event_payment_links WHERE id=?').get(link.id):null;if(typeof link.id!=='string'||typeof link.giftId!=='string'||!Number.isSafeInteger(link.giftVersion)||link.giftVersion<1||!gifts.has(link.giftId)||!current||current.owner_type!==r.owner_type||current.owner_id!==r.owner_id||current.gift_id!==link.giftId||current.revenue_case!==link.revenueCase||centsValue(link.amount)===null||gifts.get(link.giftId).amount!==centsValue(link.amount))throw new ReportError('Stored event commitment receipt sources are inconsistent or unavailable.',503);return {id:link.id,giftId:link.giftId,giftRevision:link.giftVersion,status:typeof link.status==='string'?link.status:null,date:typeof link.date==='string'?link.date:null,amountCents:centsValue(link.amount),revenueCase:link.revenueCase};});
    const amount=record=>{if(!record)return null;if(r.owner_type==='sponsorship')return centsValue(record.amount);if(!record.winning_bid_id)return 0;const bid=retainedBids.find(b=>b.id===record.winning_bid_id);if(!bid)throw new ReportError('Stored event commitment winning bid is unavailable.',503);return bid.amountCents;};
    const originalBefore=amount(before),originalAfter=amount(after),active=(record,value)=>!record?null:record.status===(r.owner_type==='sponsorship'?'Active':'Closed')?value:0;
    const referencedTotal=receiptLinks.reduce((n,link)=>n+BigInt(link.amountCents??0),0n);
    return {id:r.id,eventId,ownerType:r.owner_type,ownerId:r.owner_id,action:r.action,fromRevision:r.from_version,toRevision:r.to_version,eventRevision:r.event_version,reason:r.reason,actorId:typeof actor.id==='string'?actor.id:null,actorName:typeof actor.name==='string'?actor.name:null,at:r.at,beforeStatus:before?.status??null,afterStatus:after.status??null,beforeName:before?.name??null,afterName:after.name??null,beforeCommitmentAmountCents:originalBefore,afterCommitmentAmountCents:originalAfter,beforeActiveCommitmentAmountCents:active(before,originalBefore),afterActiveCommitmentAmountCents:active(after,originalAfter),beforeWinningBidId:before?.winning_bid_id??null,afterWinningBidId:after.winning_bid_id??null,winningBidId:source.winningBid?.id??null,winningBidAmountCents:source.winningBid?centsValue(source.winningBid.amount):null,highestBidId:source.highestBid?.id??null,highestBidAmountCents:source.highestBid?centsValue(source.highestBid.amount):null,receiptLinkCount:receiptLinks.length,referencedReceiptAmountCents:centsValue(referencedTotal.toString()),sourceReferences:{event:{id:eventId,revision:r.event_version},bids:[...new Map(retainedBids.map(b=>[b.id,b])).values()],receiptLinks}};
   });
  }
  const eventOwner=(type,key)=>{const table={ticket:'event_tickets',sponsorship:'event_sponsorships',auction:'event_auction_items'}[type];return table&&hasTable(table)?db.prepare('SELECT event_id FROM '+table+' WHERE id=?').get(key)?.event_id??null:null;};
  add('eventPayments','event_payment_links','SELECT * FROM event_payment_links ORDER BY id',r=>{const g=gifts.get(r.gift_id),eventId=eventOwner(r.owner_type,r.owner_id);return {id:r.id,ownerType:r.owner_type,ownerId:r.owner_id,eventId,eventName:events.get(eventId)?.name??null,giftId:r.gift_id,revenueCase:r.revenue_case,constituentId:g?.constituentId??null,constituentName:people.get(g?.constituentId)?.name??null,amountCents:centsValue(g?.amount),date:g?.date??null,type:g?.type??null,status:g?.status??null,receivedAmountCents:g?.status==='Posted'&&g.date<=asOf?centsValue(g.amount):0,asOf,actor:r.actor,at:r.at};});
  if(wants('grantMilestones','grantMilestoneVersions','grantMilestoneEvidence')&&hasTable('grant_milestones')&&hasTable('grant_milestone_history')){
   const grantRows=rows('SELECT * FROM grant_milestones ORDER BY id');
   let historyRows=0;
   const histories=new Map(grantRows.map(r=>[r.id,(()=>{if(admin&&selected==='grantMilestones')return [];const history=db.prepare('SELECT milestone_id,version,snapshot,action,reason,actor,at FROM grant_milestone_history WHERE milestone_id=? ORDER BY version LIMIT '+((catalogOnly?REPORT_LIMITS.catalogSampleRows:REPORT_LIMITS.sourceRows)+1)).all(r.id);historyRows+=history.length;if(!catalogOnly&&historyRows>REPORT_LIMITS.sourceRows)throw new ReportError('Selected grant history exceeds 100,000 acquisition rows. No complete result was generated.',413);return history;})()]));
   const grantData=value=>{const p=json(value),source=p.source||{},owner=p.owner||{};return {...pick(p,['name','kind','dueDate','status','requiredRole']),grantId:typeof source.id==='string'?source.id:null,grantName:typeof source.name==='string'?source.name:null,grantRevision:Number.isSafeInteger(source.version)?source.version:null,funderId:typeof source.funderId==='string'?source.funderId:null,requestedAmountCents:centsValue(source.requestedCents),awardedAmountCents:centsValue(source.awardedCents),awardDate:typeof source.awardDate==='string'?source.awardDate:null,sourceStage:typeof source.stage==='string'?source.stage:null,ownerId:typeof owner.id==='string'?owner.id:null,ownerName:typeof owner.name==='string'?owner.name:null,ownerRole:typeof owner.role==='string'?owner.role:null,ownerRevision:Number.isSafeInteger(owner.version)?owner.version:null};};
   const publicGrantSnapshot=p=>{if(p.requiredRole==='admin')return false;if(!p.completion)return true;const d=p.completion.document;if(!d||d.visibility==='Administrators'||d.revisionVisibility==='Administrators'||!hasTable('documents'))return false;const current=db.prepare('SELECT visibility FROM documents WHERE id=?').get(d.id);return Boolean(current)&&current.visibility!=='Administrators';};
   // An oversized history cannot establish that all retained evidence is public.
   const visibleGrant=r=>admin||publicGrantSnapshot(json(r.data))&&histories.get(r.id).length<=(catalogOnly?REPORT_LIMITS.catalogSampleRows:REPORT_LIMITS.sourceRows)&&histories.get(r.id).every(h=>publicGrantSnapshot(json(h.snapshot)));
   const visible=grantRows.filter(visibleGrant);result.grantMilestones=visible.map(r=>({id:r.id,...grantData(r.data),revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));result.grantMilestoneVersions=[];result.grantMilestoneEvidence=[];
   for(const r of visible)for(const h of histories.get(r.id)){
    if(result.grantMilestoneVersions.length<=REPORT_LIMITS.sourceRows)result.grantMilestoneVersions.push({id:r.id+':'+h.version,milestoneId:r.id,...grantData(h.snapshot),revision:h.version,action:h.action,reason:h.reason,actor:h.actor,at:h.at});
    const p=json(h.snapshot),completion=p.completion,d=completion?.document;if(!d)continue;
    if(result.grantMilestoneEvidence.length<=REPORT_LIMITS.sourceRows){const current=hasTable('documents')?db.prepare('SELECT archived FROM documents WHERE id=?').get(d.id):null;result.grantMilestoneEvidence.push({id:r.id+':'+h.version,milestoneId:r.id,milestoneRevision:h.version,grantId:r.grant_id,grantName:p.source?.name??null,documentId:typeof d.id==='string'?d.id:null,documentVersion:Number.isSafeInteger(d.version)?d.version:null,documentRevision:Number.isSafeInteger(d.revision)?d.revision:null,documentTitle:typeof d.title==='string'?d.title:null,documentCategory:typeof d.category==='string'?d.category:null,documentStatus:typeof d.status==='string'?d.status:null,documentEvidenceDate:typeof d.evidenceDate==='string'?d.evidenceDate:null,documentVisibility:typeof d.visibility==='string'?d.visibility:null,revisionVisibility:typeof d.revisionVisibility==='string'?d.revisionVisibility:null,documentFilename:typeof d.filename==='string'?d.filename:null,documentSize:Number.isSafeInteger(d.size)?d.size:null,documentArchived:current?Boolean(current.archived):null,completedDate:typeof completion.completedDate==='string'?completion.completedDate:null,completionReference:typeof completion.reference==='string'?completion.reference:null,staffConfirmed:completion.staffConfirmed===true,actor:h.actor,at:h.at});}
   }
  }
  if(wants('tributes','tributeVersions','tributeNotifications','tributeNotificationFinalizations','tributeNotificationWithdrawals')&&admin&&hasTable('tributes')){
   const tributeData=(p,source)=>{const g=source?.gift||gifts.get(p.giftId),recipient=source?.recipient||people.get(p.notificationRecipientId),honoree=source?.honoree||people.get(p.honoreeId);return {...pick(p,['giftId','type','honoreeId','notificationRecipientId','visibility','donorDisclosureApproved','notes']),honoreeName:typeof p.honoreeName==='string'&&p.honoreeName?p.honoreeName:honoree?.name??null,notificationRecipientName:typeof recipient?.name==='string'?recipient.name:null,messagePresent:typeof p.message==='string'&&p.message.length>0,sourceGiftAmountCents:centsValue(g?.amount),sourceGiftType:g?.type??null,sourceGiftStatus:g?.status??null,sourceGiftDate:g?.date??null};};
   add('tributes','tributes','SELECT id,version,data,created_at,updated_at FROM tributes ORDER BY id',r=>({id:r.id,...tributeData(json(r.data)),revision:r.version,createdAt:r.created_at,updatedAt:r.updated_at}));
   add('tributeVersions','tribute_versions','SELECT tribute_id,version,snapshot,actor,at FROM tribute_versions ORDER BY tribute_id,version',r=>{const p=json(r.snapshot);return {id:r.tribute_id+':'+r.version,tributeId:r.tribute_id,...tributeData(p.definition||{},p.source),revision:r.version,actor:r.actor,at:r.at};});
   if(hasTable('tribute_notification_finalizations')){
    add('tributeNotifications','tribute_notifications','SELECT n.id,n.tribute_id,n.snapshot,n.actor,n.at,f.actor AS finalized_by,f.at AS finalized_at,w.at AS withdrawn_at FROM tribute_notifications n LEFT JOIN tribute_notification_finalizations f ON f.notification_id=n.id LEFT JOIN tribute_notification_withdrawals w ON w.notification_id=n.id ORDER BY n.id',r=>{const p=json(r.snapshot);return {id:r.id,tributeId:r.tribute_id,tributeRevision:Number.isSafeInteger(p.tributeVersion)?p.tributeVersion:null,...pick(p,['type','honoreeName','honoreeId','visibility','channel','subject']),recipientId:typeof p.recipient?.id==='string'?p.recipient.id:null,recipientName:typeof p.recipient?.name==='string'?p.recipient.name:null,giftId:typeof p.source?.giftId==='string'?p.source.giftId:null,giftDate:typeof p.source?.giftDate==='string'?p.source.giftDate:null,status:r.withdrawn_at?'Withdrawn':r.finalized_at?'Finalized':'Draft',delivery:'Not sent',actor:r.actor,createdAt:r.at,finalizedBy:r.finalized_by,finalizedAt:r.finalized_at};});
    if(hasTable('tribute_notifications'))add('tributeNotificationWithdrawals','tribute_notification_withdrawals','SELECT w.notification_id,w.version,w.reason,w.actor,w.at,w.confirmed_not_sent,n.tribute_id FROM tribute_notification_withdrawals w JOIN tribute_notifications n ON n.id=w.notification_id ORDER BY w.notification_id',r=>({id:r.notification_id,notificationId:r.notification_id,tributeId:r.tribute_id,revision:r.version,reason:r.reason,actorId:r.actor,at:r.at,confirmedNotSent:r.confirmed_not_sent===1,delivery:'Not sent'}));
    if(hasTable('tribute_notifications'))add('tributeNotificationFinalizations','tribute_notification_finalizations','SELECT f.notification_id,f.actor,f.at,n.tribute_id FROM tribute_notification_finalizations f JOIN tribute_notifications n ON n.id=f.notification_id ORDER BY f.notification_id',r=>({id:r.notification_id,notificationId:r.notification_id,tributeId:r.tribute_id,actor:r.actor,at:r.at,humanReviewed:true,delivery:'Not sent'}));
   }
  }
  const projected=selected?Object.fromEntries(Object.entries(result).filter(([entity])=>entity===selected)):result;
  if(!catalogOnly)for(const values of Object.values(projected))if(values.length>REPORT_LIMITS.sourceRows)throw new ReportError('Selected report source exceeds 100,000 rows. No complete result was generated.',413);
  return projected;
 }
 const snapshot=(req,selected=null,catalogOnly=false,inspect=false)=>{const capture=()=>{const records={...data({...req,reportEntity:selected}),...metadata(req,selected,catalogOnly)};if(Array.isArray(records.designations))records.designations=withAccountStructure(records.designations);return inspect?inspectReportSourceFields(records,selected):{records,catalog:buildReportCatalog(records,Object.keys(records))};};return db.isTransaction?capture():transaction(capture);};
 const present=row=>row?{id:row.id,version:row.version,...JSON.parse(row.definition),createdAt:row.created_at,updatedAt:row.updated_at}:null;
 const getReport=(id,user,req={})=>{authorized(user);if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new ReportError('Use a valid report ID.');const report=present(db.prepare('SELECT * FROM custom_reports WHERE scope=? AND id=?').get(scope(req),id));if(!report)throw new ReportError('Report not found.',404);if(adminEntities.has(report.entity)&&user.role!=='admin')throw new ReportError('This report source requires administrator access.',403);return report;};
 const assertStoredReportAccess=(snapshot,user,req={})=>{
  authorized(user);if(!snapshot||user.role==='admin')return;
  if(snapshot.requiredRole==='admin'||adminEntities.has(snapshot.definition?.entity))throw new ReportError('This retained report requires administrator access.',403);
  if(snapshot.definition?.entity==='giftFinancialCorrections'){
   if(snapshot.giftCorrectionPrivacy!==1||!Array.isArray(snapshot.giftCorrectionSources)||snapshot.giftCorrectionSources.length>REPORT_LIMITS.sourceRows)throw new ReportError('This older retained financial correction report requires administrator review. Run a current report with your own permissions.',403);
   const visibleGifts=new Set(list('gifts',{...req,user}).map(g=>g.id));
   for(const ref of snapshot.giftCorrectionSources){
    if(typeof ref?.correctionId!=='string'||typeof ref?.giftId!=='string'||!hasTable('gift_financial_corrections')||!visibleGifts.has(ref.giftId)||!db.prepare('SELECT 1 FROM gift_financial_corrections WHERE id=? AND gift_id=?').get(ref.correctionId,ref.giftId))throw new ReportError('Current financial correction source access is unavailable. Run a current report with your own permissions.',403);
   }
  }
  if(snapshot.definition?.entity==='taskAssignmentHistory'){
   if(snapshot.taskAssignmentPrivacy!==1||!Array.isArray(snapshot.taskAssignmentSources)||snapshot.taskAssignmentSources.length>REPORT_LIMITS.sourceRows)throw new ReportError('This older retained assignment report requires administrator review. Run a current report with your own permissions.',403);
   const visibleTasks=new Set(list('tasks',{...req,user}).map(task=>task.id));
   for(const ref of snapshot.taskAssignmentSources)if(typeof ref?.assignmentId!=='string'||typeof ref?.taskId!=='string'||!hasTable('task_assignments')||!visibleTasks.has(ref.taskId)||!db.prepare('SELECT 1 FROM task_assignments WHERE id=? AND task_id=?').get(ref.assignmentId,ref.taskId))throw new ReportError('Current task assignment source access is unavailable. Run a current report with your own permissions.',403);
  }
  if(snapshot.definition?.entity==='eventTicketTransitions'){
   if(snapshot.eventTicketTransitionPrivacy!==1||!Array.isArray(snapshot.eventTicketTransitionSources)||snapshot.eventTicketTransitionSources.length>REPORT_LIMITS.sourceRows)throw new ReportError('This older retained ticket transition report requires administrator review. Run a current report with your own permissions.',403);
   const visibleEvents=new Set(list('events',{...req,user}).map(event=>event.id));
   for(const ref of snapshot.eventTicketTransitionSources)if(typeof ref?.transitionId!=='string'||typeof ref?.ticketId!=='string'||typeof ref?.eventId!=='string'||!hasTable('event_tickets')||!hasTable('event_ticket_transitions')||!visibleEvents.has(ref.eventId)||!db.prepare('SELECT 1 FROM event_tickets t JOIN event_ticket_transitions h ON h.ticket_id=t.id WHERE t.id=? AND t.event_id=? AND h.id=?').get(ref.ticketId,ref.eventId,ref.transitionId))throw new ReportError('Current event ticket source access is unavailable. Run a current report with your own permissions.',403);
  }
  if(snapshot.definition?.entity==='correspondenceFulfillments'){
   if(snapshot.correspondenceFulfillmentPrivacy!==1||!Array.isArray(snapshot.correspondenceFulfillmentSources)||snapshot.correspondenceFulfillmentSources.length>REPORT_LIMITS.sourceRows)throw new ReportError('This older retained correspondence fulfillment report requires administrator review. Run a current report with your own permissions.',403);
   const visibleGifts=new Set(list('gifts',{...req,user}).map(g=>g.id)),visibleCommunications=new Set(list('communications',{...req,user}).map(c=>c.id));
   for(const ref of snapshot.correspondenceFulfillmentSources)if(typeof ref?.fulfillmentId!=='string'||typeof ref?.giftId!=='string'||typeof ref?.communicationId!=='string'||typeof ref?.preparationId!=='string'||!hasTable('correspondence_fulfillments')||!visibleGifts.has(ref.giftId)||!visibleCommunications.has(ref.communicationId)||!db.prepare('SELECT 1 FROM correspondence_fulfillments WHERE id=? AND gift_id=? AND communication_id=? AND preparation_id=?').get(ref.fulfillmentId,ref.giftId,ref.communicationId,ref.preparationId))throw new ReportError('Current correspondence fulfillment source access is unavailable. Run a current report with your own permissions.',403);
  }
  if(snapshot.definition?.entity==='eventCommitmentTransitions'){
   if(snapshot.eventCommitmentPrivacy!==1||!Array.isArray(snapshot.eventCommitmentSources)||snapshot.eventCommitmentSources.length>REPORT_LIMITS.sourceRows)throw new ReportError('This older retained commitment transition report requires administrator review. Run a current report with your own permissions.',403);
   const visibleEvents=new Set(list('events',{...req,user}).map(event=>event.id)),visibleGifts=new Set(list('gifts',{...req,user}).map(gift=>gift.id)),owners={sponsorship:'event_sponsorships',auction:'event_auction_items'};
   for(const ref of snapshot.eventCommitmentSources){
    const table=owners[ref?.ownerType];if(!table||typeof ref.transitionId!=='string'||typeof ref.ownerId!=='string'||typeof ref.eventId!=='string'||!visibleEvents.has(ref.eventId)||!hasTable(table)||!hasTable('event_commitment_transitions')||!Array.isArray(ref.bidIds)||!Array.isArray(ref.receiptLinks)||ref.bidIds.length>REPORT_LIMITS.sourceRows||ref.receiptLinks.length>REPORT_LIMITS.sourceRows||!db.prepare('SELECT 1 FROM '+table+' o JOIN event_commitment_transitions h ON h.owner_id=o.id AND h.owner_type=? WHERE o.id=? AND o.event_id=? AND h.id=?').get(ref.ownerType,ref.ownerId,ref.eventId,ref.transitionId))throw new ReportError('Current event commitment source access is unavailable. Run a current report with your own permissions.',403);
    for(const bidId of ref.bidIds)if(ref.ownerType!=='auction'||typeof bidId!=='string'||!hasTable('event_auction_bids')||!db.prepare('SELECT 1 FROM event_auction_bids WHERE id=? AND item_id=?').get(bidId,ref.ownerId))throw new ReportError('Retained event bid source access is unavailable.',403);
    for(const link of ref.receiptLinks)if(typeof link?.id!=='string'||typeof link?.giftId!=='string'||!visibleGifts.has(link.giftId)||!hasTable('event_payment_links')||!db.prepare('SELECT 1 FROM event_payment_links WHERE id=? AND gift_id=? AND owner_type=? AND owner_id=?').get(link.id,link.giftId,ref.ownerType,ref.ownerId))throw new ReportError('Retained event receipt source access is unavailable.',403);
   }
  }
  if(snapshot.definition?.entity==='documentRevisions'){
   if(snapshot.documentRevisionPrivacy!==1||!Array.isArray(snapshot.documentRevisionSources)||snapshot.documentRevisionSources.length>REPORT_LIMITS.sourceRows)throw new ReportError('This older retained revision report requires administrator review. Run a current report with your own permissions.',403);
   for(const ref of snapshot.documentRevisionSources){
    if(typeof ref?.documentId!=='string'||!Number.isSafeInteger(ref.revision)||ref.revision<1||!hasTable('documents')||!hasTable('document_revisions'))throw new ReportError('This retained revision report cannot establish current source access.',403);
    const document=db.prepare('SELECT visibility FROM documents WHERE id=?').get(ref.documentId),revision=db.prepare('SELECT metadata FROM document_revisions WHERE document_id=? AND revision=?').get(ref.documentId,ref.revision);
    if(document?.visibility!=='Workspace'||!revision||json(revision.metadata).visibility!=='Workspace')throw new ReportError('Current or retained document evidence is private. Run a current report with your own permissions.',403);
   }
  }
 };
 const privacyMarker=definition=>definition.entity==='documentRevisions'?{documentRevisionPrivacy:1}:definition.entity==='giftFinancialCorrections'?{giftCorrectionPrivacy:1}:definition.entity==='taskAssignmentHistory'?{taskAssignmentPrivacy:1}:definition.entity==='eventTicketTransitions'?{eventTicketTransitionPrivacy:1}:definition.entity==='correspondenceFulfillments'?{correspondenceFulfillmentPrivacy:1}:definition.entity==='eventCommitmentTransitions'?{eventCommitmentPrivacy:1}:{};
 const boundedOutput=result=>{if(Buffer.byteLength(JSON.stringify(result))>REPORT_LIMITS.outputBytes)throw new ReportError('Complete report and privacy provenance exceed the output limit. Narrow the report; no partial provenance is returned.',413);return result;};
 // One hashed complete-source run. Every caller - page, CSV export, typed
 // export and board pack section - pins the same source/definition/user/role/
 // tenant proof, so no format can quietly read a different set of facts.
 const hashedRun=(records,definition,catalog,req,{offset=0,limit=REPORT_LIMITS.resultRows,completeExport=false})=>{
  const hash=createHash('sha256');hash.update(JSON.stringify({scope:scope(req),userId:req.user?.id,role:req.user?.role}));let sourceBytes=0;
  const result=runCustomReport(records,definition,catalog,{offset,limit,completeExport,onSource:value=>{const encoded=JSON.stringify(value);sourceBytes+=Buffer.byteLength(encoded);if(sourceBytes>REPORT_LIMITS.sourceBytes)throw new ReportError('Selected report source exceeds the 64 MB processing limit. No complete result was generated.',413);hash.update(encoded);hash.update('\n');}});
  return {result,fingerprint:hash.digest('hex')};
 };
 const execute=(records,definition,catalog,req={},completeExport=false)=>{
  const query=req.query||{},offset=query.offset===undefined?0:Number(query.offset),limit=query.limit===undefined?REPORT_LIMITS.resultRows:Number(query.limit);
  if(completeExport&&(Object.keys(query).some(key=>key!=='fingerprint')||typeof query.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(query.fingerprint)))throw new ReportError('Complete export requires the source fingerprint from the reviewed report. Rerun the report before exporting.',400);
  if(Object.keys(query).some(key=>!['offset','limit','fingerprint'].includes(key))||['offset','limit','fingerprint'].some(key=>query[key]!==undefined&&typeof query[key]!=='string')||query.offset!==undefined&&!/^\d+$/.test(query.offset)||query.limit!==undefined&&!/^\d+$/.test(query.limit))throw new ReportError('Use valid report page parameters.');
  if(offset>0&&(typeof query.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(query.fingerprint)))throw new ReportError('Later report pages require the previous source fingerprint. Rerun the report from its first page.',409);
  if(query.fingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(query.fingerprint))throw new ReportError('Use a valid report source fingerprint.');
  const {result,fingerprint}=hashedRun(records,definition,catalog,req,{offset,limit,completeExport});
  if(query.fingerprint&&query.fingerprint!==fingerprint)throw new ReportError('Report sources or definition changed since the reviewed report. Rerun from the first page before continuing or exporting.',409);
  const complete={...result,page:{...result.page,fingerprint},sourceFingerprint:fingerprint};
  return completeExport?complete:boundedOutput(complete);
 };
 const runReport=(id,user,req={})=>{const report=getReport(id,user,req),{id:reportId,version,createdAt,updatedAt,...definition}=report;const {records,catalog}=snapshot({...req,user},definition.entity);return boundedOutput({...execute(records,definition,catalog,{...req,user,query:req.query}),...privacyMarker(definition),requiredRole:requiredRole(definition.entity,user),reportId,version,executedAt:new Date().toISOString()});};
 // Complete exports serialize exact saved cents, not display rounding, and protect
 // spreadsheet text (including labels) without converting signed numeric values.
 const exportCell=(value,column)=>{
  let text;
  if(value==null)text='';
  else if(column?.type==='money'){
   text=moneyDecimal(value);
  }else if(typeof value==='number'){
   if(!Number.isFinite(value))throw new ReportError('Export contains an invalid numeric source. Review the source record.',503);
   text=String(value);
  }else{
   text=spreadsheetText(sourceText(value));
  }
  return '"'+text.replaceAll('"','""')+'"';
 };
 // One complete, source-pinned, privacy-rechecked result feeds every export
 // format. CSV, workbook, PDF and RTF never re-query or re-filter the source.
 const assertRetainedComplete=(result,req)=>{
  assertStoredReportAccess(result,req.user,req);
  if(result.textTruncated||result.rows.length!==result.totalResultRows||result.page.nextOffset!==null||!result.totalsComplete)throw new ReportError('Complete export could not retain every result row. Narrow the report; no partial export was generated.',413);
  return result;
 };
 const completeResult=(records,definition,catalog,req)=>assertRetainedComplete({...execute(records,definition,catalog,req,true),...privacyMarker(definition),requiredRole:requiredRole(definition.entity,req.user)},req);
 const completeExport=(records,definition,catalog,req)=>{
  const result=completeResult(records,definition,catalog,req);
  const parts=['\uFEFF'+result.columns.map(column=>exportCell(column.label+(column.type==='money'?' (USD)':''))).join(',')];let bytes=Buffer.byteLength(parts[0]);
  for(const row of result.rows){const encoded='\r\n'+row.map((value,index)=>exportCell(value,result.columns[index])).join(',');bytes+=Buffer.byteLength(encoded);if(bytes>REPORT_LIMITS.exportCsvBytes)throw new ReportError('Complete CSV exceeds the 8 MB export limit. Narrow the report; no partial export was generated.',413);parts.push(encoded);}
  const {rows,page,truncated,sourcePreview,...metadata}=result;
  const output={...metadata,filename:'wimblo-'+result.definition.name.replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)+'.csv',csv:parts.join(''),rowCount:rows.length,complete:true,textTruncated:false,format:{mime:'text/csv;charset=utf-8',encoding:'UTF-8',lineEnding:'CRLF',money:'Exact decimal USD from integer cents',formulaProtected:true},exportLimits:{csvBytes:REPORT_LIMITS.exportCsvBytes,responseBytes:REPORT_LIMITS.exportOutputBytes}};
  if(Buffer.byteLength(JSON.stringify(output))>REPORT_LIMITS.exportOutputBytes)throw new ReportError('Complete CSV and privacy provenance exceed the 12 MB response limit. Narrow the report; no partial export was generated.',413);
  return output;
 };
 // Typed native outputs reuse the same complete, reviewed, source-pinned and
 // privacy-rechecked result as the CSV export. They never re-read the source.
 const exportFileName=(name,extension)=>'wimblo-'+String(name).replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)+'.'+extension;
 const provenanceLines=(req,entries)=>[...entries,['Workspace scope',scope(req)],['Exported by',String(req.user?.id??'')+' ('+String(req.user?.role??'')+')'],['Exported at',new Date().toISOString()],['Money','Exact decimal USD derived from saved integer cents'],['Evidence','Engineering evidence from current saved records. Not a buyer acceptance and not a claim of native-application rendering fidelity.']];
 const typedOutput=(format,document,envelope,documentName)=>{
  const file=buildTypedReportFile(format,document);
  const output={...envelope,filename:exportFileName(documentName,file.extension),file:file.buffer.toString('base64'),fileEncoding:'base64',fileBytes:file.buffer.length,sha256:createHash('sha256').update(file.buffer).digest('hex'),complete:true,textTruncated:false,
   format:{mime:file.mime,extension:file.extension,standard:file.standard,encoding:file.encoding,typedCells:file.typedCells,formulaProtected:file.formulaProtected,money:'Exact decimal USD from integer cents',dates:'Real calendar values are written as date cells; values a spreadsheet cannot represent stay text',textSubstituted:file.notes.substituted===true,textClipped:file.notes.clipped===true,verified:'Structure generated and asserted by this application. Rendering in Microsoft Excel, Adobe Acrobat or Microsoft Word is not verified here.'},
   exportLimits:{fileBytes:REPORT_LIMITS.exportCsvBytes,responseBytes:REPORT_LIMITS.exportOutputBytes}};
  if(Buffer.byteLength(JSON.stringify(output))>REPORT_LIMITS.exportOutputBytes)throw new ReportError('Complete typed export and privacy provenance exceed the 12 MB response limit. Narrow the report; no partial export was generated.',413);
  return output;
 };
 const reportDocument=(result,req)=>({
  title:result.definition.name,
  subtitle:'Complete report export',
  provenance:provenanceLines(req,[['Report',result.definition.name],['Source',result.definition.entity],['Required role',String(result.requiredRole)],['Filters',String(result.definition.filters.length)],['Grouped by',result.definition.groupBy.join(', ')||'None'],['Calculations',String(result.definition.aggregates.length)],['Includes voided gifts',result.definition.includeVoided?'Yes':'No'],['Matched source rows',String(result.matchedRows)],['Result rows',String(result.totalResultRows)],['Source fingerprint',result.sourceFingerprint]]),
  sheets:[{name:'Report',title:result.definition.name,note:result.scope,columns:result.columns,rows:result.rows}]
 });
 // A saved-report section for an assembled pack. Same complete-result guarantees
 // without an HTTP page query; the caller pins the returned fingerprint.
 const completeSection=(definition,req)=>{
  authorized(req.user);enforceSourceRole(definition?.entity,req.user);
  const {records,catalog}=snapshot(req,definition?.entity);
  const {result,fingerprint}=hashedRun(records,definition,catalog,req,{completeExport:true});
  return assertRetainedComplete({...result,page:{...result.page,fingerprint},sourceFingerprint:fingerprint,...privacyMarker(result.definition),requiredRole:requiredRole(result.definition.entity,req.user)},req);
 };
 const handler=fn=>(req,res,next)=>{try{authorized(req.user);fn(req,res);}catch(error){next(error);}};
 app.post('/api/custom-reports/export/:format',csrf,handler((req,res)=>{
  if(!Object.hasOwn(TYPED_EXPORT_FORMATS,req.params.format))throw new ReportError('Choose xlsx, pdf or rtf for a typed export.',400);
  enforceSourceRole(req.body?.entity,req.user);
  const {records,catalog}=snapshot(req,req.body?.entity),result=completeResult(records,req.body,catalog,req);
  const {rows,page,truncated,sourcePreview,columns,...metadata}=result;
  res.set('Cache-Control','no-store');
  res.json(typedOutput(req.params.format,reportDocument(result,req),{...metadata,rowCount:rows.length},result.definition.name));
 }));
 app.get('/api/custom-reports/catalog',handler((req,res)=>{
  const query=req.query||{};
  if(Object.keys(query).length===0){res.json({...snapshot(req,null,true).catalog,metadataSchemaSampleRows:REPORT_LIMITS.catalogSampleRows});return;}
  if(Object.keys(query).some(key=>key!=='entity')||typeof query.entity!=='string'||!isReportSourceEntity(query.entity))throw new ReportError('Choose one available source with the entity query parameter.');
  enforceSourceRole(query.entity,req.user);
  const inspected=snapshot(req,query.entity,false,true),entity=inspected.catalog.entities[0];
  const output={...inspected.catalog,inspection:{entity:query.entity,sourceRowsInspected:inspected.sourceRowsInspected,fieldCount:entity.fields.length,includesVoidedGiftRows:['gifts','giftAllocations'].includes(query.entity),sourceFactsBytes:inspected.sourceFactsBytes,sourceRowsLimit:REPORT_LIMITS.sourceRows,sourceFactsBytesLimit:REPORT_LIMITS.sourceBytes,catalogResponseBytesLimit:REPORT_LIMITS.outputBytes,depthLimit:4,arrayItemLimit:100,inspectedAt:new Date().toISOString(),scope:'Current authorized saved source facts, including authorized voided gift rows for schema discovery only. Report filters and financial totals are unchanged. Projection, joined-source and current/historical privacy rules apply; nested discovery is limited to depth 4 and the first 100 items per array.'}};
  if(Buffer.byteLength(JSON.stringify(output))>REPORT_LIMITS.outputBytes)throw new ReportError('Selected source field catalog exceeds the 1 MB response limit. No partial catalog was generated. Use a dedicated reporting service for this source.',413);
  res.set('Cache-Control','no-store');res.json(output);
 }));
 app.get('/api/custom-reports',handler((req,res)=>res.json({reports:db.prepare('SELECT * FROM custom_reports WHERE scope=? ORDER BY updated_at DESC,id LIMIT 201').all(scope(req)).map(present).filter(r=>req.user.role==='admin'||!adminEntities.has(r.entity))})));
 app.post('/api/custom-reports/run',csrf,handler((req,res)=>{enforceSourceRole(req.body?.entity,req.user);const {records,catalog}=snapshot(req,req.body?.entity);res.json(boundedOutput({...execute(records,req.body,catalog,req),...privacyMarker(req.body),requiredRole:requiredRole(req.body.entity,req.user),executedAt:new Date().toISOString()}));}));
 app.post('/api/custom-reports/export',csrf,handler((req,res)=>{enforceSourceRole(req.body?.entity,req.user);const {records,catalog}=snapshot(req,req.body?.entity),output=completeExport(records,req.body,catalog,req);res.set('Cache-Control','no-store');res.json(output);}));
 app.get('/api/custom-reports/:id/run',handler((req,res)=>res.json(runReport(req.params.id,req.user,req))));
 app.post('/api/custom-reports',csrf,write,handler((req,res)=>{
  const report=transaction(()=>{enforceSourceRole(req.body?.entity,req.user);const {catalog}=snapshot(req,req.body?.entity),definition=validateReportDefinition(req.body,catalog);if(db.prepare('SELECT count(*) AS n FROM custom_reports WHERE scope=?').get(scope(req)).n>=200)throw new ReportError('This workspace has 200 saved reports. Edit an existing definition.',409);const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO custom_reports(id,scope,version,definition,created_at,updated_at) VALUES(?,?,1,?,?,?)').run(id,scope(req),JSON.stringify(definition),now,now);audit(req.user,'create','customReports',id,{version:1,entity:definition.entity});return getReport(id,req.user,req);});res.status(201).json({report});
 }));
 app.patch('/api/custom-reports/:id',csrf,write,handler((req,res)=>{
  const report=transaction(()=>{const previous=getReport(req.params.id,req.user,req);if(!req.body||typeof req.body!=='object'||!Number.isSafeInteger(req.body.version)||req.body.version<1)throw new ReportError('Include the saved report version.');if(req.body.version!==previous.version)throw new ReportError('This report changed. Reload its latest definition before saving.',409);enforceSourceRole(req.body.entity,req.user);const {version,...body}=req.body,{catalog}=snapshot(req,body.entity),definition=validateReportDefinition(body,catalog);const now=new Date().toISOString();const changed=db.prepare('UPDATE custom_reports SET version=version+1,definition=?,updated_at=? WHERE scope=? AND id=? AND version=?').run(JSON.stringify(definition),now,scope(req),req.params.id,version);if(changed.changes!==1)throw new ReportError('This report changed. Reload before saving.',409);audit(req.user,'update','customReports',previous.id,{version:version+1,entity:definition.entity});return getReport(previous.id,req.user,req);});res.json({report});
 }));
 return {getReport,runReport,executeSavedReport:runReport,assertStoredReportAccess,completeSection,typedOutput,provenanceLines,boundedOutput,reportScope:scope,authorizedReportUser:authorized,designationAccounts,accountLinkQuery:ACCOUNT_LINK_SQL,accountSourceQueries:ACCOUNT_SOURCE_SQL};
}
