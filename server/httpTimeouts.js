// Behind a reverse proxy that keeps idle upstream connections open, Node's default
// keepAliveTimeout (5 s) lets the server close an idle socket just as the proxy reuses it,
// which the proxy reports to users as a 502. Synchronous database work makes this likely:
// a request that blocks the event loop for longer than the timeout lets every idle socket's
// timer expire during the block, and they are all closed the moment the loop frees up.
// Measured locally: a 500-row migration commit blocked the loop for ~7 s. The keep-alive
// timeout must exceed the proxy's upstream idle timeout, and headersTimeout must exceed
// keepAliveTimeout, or Node can still cut a reused connection while it reads headers.
export const HTTP_TIMEOUT_DEFAULTS=Object.freeze({keepAliveTimeout:65_000,headersTimeout:66_000});

export function configureHttpTimeouts(server,{keepAliveTimeout=HTTP_TIMEOUT_DEFAULTS.keepAliveTimeout,headersTimeout=HTTP_TIMEOUT_DEFAULTS.headersTimeout}={}){
 if(!server||typeof server!=='object')throw new TypeError('An HTTP server is required');
 for(const [name,value] of [['keepAliveTimeout',keepAliveTimeout],['headersTimeout',headersTimeout]])
  if(!Number.isSafeInteger(value)||value<=0)throw new RangeError(`${name} must be a positive integer number of milliseconds`);
 if(headersTimeout<=keepAliveTimeout)throw new RangeError('headersTimeout must exceed keepAliveTimeout, or a reused connection can be cut while its headers are read');
 server.keepAliveTimeout=keepAliveTimeout;
 server.headersTimeout=headersTimeout;
 return {keepAliveTimeout,headersTimeout};
}
