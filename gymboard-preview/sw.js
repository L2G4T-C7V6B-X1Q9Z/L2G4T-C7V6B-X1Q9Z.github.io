// Cache only this client's same-origin shell. Firebase/auth requests pass through.
const CACHE='gymboard-fresh-shell-v1';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',(event)=>{
  event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key.startsWith('gymboard-fresh-shell-')&&key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',(event)=>{
  const request=event.request,url=new URL(request.url),scope=new URL(self.registration.scope);
  if(request.method!=='GET'||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
  if(request.mode!=='navigate'&&!/\.(html|css|js|woff2)$/.test(url.pathname))return;
  event.respondWith(caches.open(CACHE).then(async(cache)=>{
    const cached=await cache.match(request);
    const update=fetch(request,{cache:'no-cache'}).then((response)=>{
      if(response.ok)cache.put(request,response.clone());return response;
    }).catch(()=>cached||Response.error());
    event.waitUntil(update.then(()=>{}));
    return cached||update;
  }));
});
