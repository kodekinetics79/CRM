import {readdir,readFile} from 'node:fs/promises';
import {relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const isTestFile=file=>file.endsWith('.test.js');

async function discover(root){
 const found=[];
 async function visit(directory){
  const entries=await readdir(directory,{withFileTypes:true});
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   const path=resolve(directory,entry.name);
   if(entry.isDirectory())await visit(path);
   else if(entry.isFile()&&isTestFile(entry.name))found.push(path);
  }
 }
 await visit(root);
 return found;
}

function canStartRegex(output){
 const prior=output.trimEnd();
 if(!prior)return true;
 if('([{:;,=!?&|+-*%^~<>'.includes(prior.at(-1)))return true;
 return /\b(?:return|throw|case|yield|await|else|do)$/.test(prior);
}

function stripNonCode(source,label){
 let output='',state='code',quote='',escaped=false,regexClass=false;
 for(let index=0;index<source.length;index++){
  const char=source[index],next=source[index+1];
  if(state==='line-comment'){
   if(char==='\n'){state='code';output+='\n';}else output+=' ';
   continue;
  }
  if(state==='block-comment'){
   if(char==='*'&&next==='/'){output+='  ';index++;state='code';}
   else output+=char==='\n'?'\n':' ';
   continue;
  }
  if(state==='string'||state==='template'){
   if(escaped){escaped=false;output+=char==='\n'?'\n':' ';continue;}
   if(char==='\\'){escaped=true;output+=' ';continue;}
   if((state==='string'&&char===quote)||(state==='template'&&char==='`')){state='code';output+=' ';continue;}
   output+=char==='\n'?'\n':' ';
   continue;
  }
  if(state==='regex'){
   if(escaped){escaped=false;output+=char==='\n'?'\n':' ';continue;}
   if(char==='\\'){escaped=true;output+=' ';continue;}
   if(char==='['){regexClass=true;output+=' ';continue;}
   if(char===']'&&regexClass){regexClass=false;output+=' ';continue;}
   if(char==='/'&&!regexClass){
    output+=' ';state='code';
    while(/[A-Za-z]/.test(source[index+1]||'')){index++;output+=' ';}
    continue;
   }
   if(char==='\n')throw new Error(`${label}: unclosed regular expression`);
   output+=' ';
   continue;
  }
  if(char==='/'&&next==='/'){state='line-comment';output+='  ';index++;continue;}
  if(char==='/'&&next==='*'){state='block-comment';output+='  ';index++;continue;}
  if(char==='/'&&canStartRegex(output)){state='regex';regexClass=false;output+=' ';continue;}
  if(char==='\''||char==='"'){state='string';quote=char;output+=' ';continue;}
  if(char==='`'){state='template';output+=' ';continue;}
  output+=char;
 }
 if(state==='regex')throw new Error(`${label}: unclosed regular expression`);
 if(state==='string'||state==='template'||state==='block-comment'||escaped)throw new Error(`${label}: unclosed ${state.replace('-',' ')}`);
 return output;
}

function lineAt(source,index){return source.slice(0,index).split('\n').length;}

function locations(source,pattern,label){
 const result=[];
 for(const match of source.matchAll(pattern))result.push(`${label}:${lineAt(source,match.index)}`);
 return result;
}

export async function findTestDisciplineViolations({root,files}={}){
 const base=resolve(root||process.cwd());
 const paths=(files?.length?files.map(file=>resolve(base,file)):await discover(base)).sort();
 const focused=[],skipped=[];
 for(const path of paths){
  const label=relative(base,path).replaceAll('\\','/');
  const code=stripNonCode(await readFile(path,'utf8'),label);
  focused.push(...locations(code,/\b(?:test|it|describe)\s*\.\s*only\s*\(/g,label));
  skipped.push(...locations(code,/\b(?:test|it|describe)\s*\.\s*skip\s*\(/g,label));
  skipped.push(...locations(code,/\bskip\s*:\s*true\b/g,label));
 }
 return {focused,skipped};
}

async function main(){
 const root=resolve(process.cwd(),'tests');
 const result=await findTestDisciplineViolations({root});
 console.log(`TDD discipline: ${result.focused.length} focused, ${result.skipped.length} skipped`);
 for(const item of result.focused)console.error(`focused: ${item}`);
 for(const item of result.skipped)console.error(`skipped: ${item}`);
 if(result.focused.length||result.skipped.length)process.exitCode=1;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(`TDD discipline check failed: ${error.message}`);process.exitCode=1;});
