const OVERRIDE_KEYS=Object.freeze(['host','port']);

export function parsePostgresConnectionUrl(value,{label='Database URL',production=false,requireCredentials=false,invalid=message=>{throw new Error(message);}}={}){
 let url;
 try{url=new URL(value);}
 catch{return invalid(`${label} must be a valid PostgreSQL connection URL.`);}
 if(!['postgres:','postgresql:'].includes(url.protocol))return invalid(`${label} must be a PostgreSQL connection URL.`);
 if(requireCredentials&&(!url.username||!url.hostname||!url.pathname||url.pathname==='/'))return invalid(`${label} must include an authority user, host and database name.`);
 const override=OVERRIDE_KEYS.find(key=>url.searchParams.has(key));
 if(override)return invalid(`${label} cannot override its authority ${override} through query parameters.`);
 if(production){
  const modes=url.searchParams.getAll('sslmode');
  if(modes.length!==1||modes[0]!=='verify-full')return invalid(`Production ${label} must authenticate the database certificate and hostname with sslmode=verify-full.`);
 }
 return url;
}
