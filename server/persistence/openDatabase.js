import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';

// The single seam through which the application opens a workspace or platform database,
// and the single authority on whether one exists. By default it is embedded SQLite, where
// a database is a file. A deployment bootstrap or a test harness may install a factory
// (for example the synchronous PostgreSQL adapter), where a database is a schema; asking
// the filesystem there would report every workspace missing.
let factory=null,exists=null;

export function setDatabaseFactory(next,{exists:nextExists=null}={}){
 if(next!==null&&typeof next!=='function')throw new TypeError('A database factory must be a function or null');
 if(nextExists!==null&&typeof nextExists!=='function')throw new TypeError('A database existence check must be a function or null');
 if(next&&!nextExists)throw new TypeError('A database factory must supply an existence check; the filesystem cannot answer it for a non-file engine');
 factory=next;exists=next?nextExists:null;
}

export function databaseFactoryInstalled(){return factory!==null;}

export function openDatabase(path,options){
 if(factory)return factory(path,options);
 return options?new DatabaseSync(path,options):new DatabaseSync(path);
}

export function databaseExists(path){
 return exists?Boolean(exists(path)):existsSync(path);
}
