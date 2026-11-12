export async function runBoundedWorkerVerification({run,controller,deadlineMs,handled,expectedHandled}={}){
 if(typeof run!=='function'||!controller||typeof controller.abort!=='function'||typeof handled!=='function')throw new TypeError('Bounded worker verification dependencies are required.');
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>300_000)throw new TypeError('Worker verification deadline must be between 1 and 300000 milliseconds.');
 if(!Number.isSafeInteger(expectedHandled)||expectedHandled<0)throw new TypeError('Expected handled count must be a non-negative integer.');
 let timer;
 const execution=Promise.resolve().then(()=>run(controller.signal));execution.catch(()=>{});
 const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{const error=new Error(`Worker verification exceeded its ${deadlineMs}ms deadline.`);reject(error);controller.abort(error);},deadlineMs);timer.unref?.();});
 try{await Promise.race([execution,deadline]);}finally{clearTimeout(timer);controller.abort();}
 const actual=handled();
 if(actual!==expectedHandled)throw new Error(`Worker verification must handle exactly ${expectedHandled} jobs; handled ${actual}.`);
 return actual;
}
