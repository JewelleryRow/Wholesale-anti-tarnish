/* =====================================================================
   fast.js (customer app) — makes inventory, settings and categories
   show INSTANTLY.

   WHY IT WAS SLOW: Firebase has a single websocket. When the app asks
   for 'inventory' (and 'orders') on it, heavy product photos clog that
   one pipe and everything else waits behind them.

   WHAT THIS DOES:
   1) Inventory is loaded over plain HTTP (REST), in parallel chunks,
      NOT through the websocket. Products appear on screen as soon as
      each chunk arrives; settings / categories / orders are never
      blocked behind it.
   2) Inventory, settings and categories are saved in IndexedDB. On the
      next visit the saved copy is shown at once, and live data replaces
      it a moment later.
   3) Product gallery (inventoryPhotos/<id>) is also fetched over REST.
   4) Heavy old products (photos stored inside /inventory) are trimmed
      to a single image in memory/cache. Nothing is written to the
      database from this app. (Run the admin app once to move those
      photos out of /inventory for the best speed.)

   Load order in index.html:  firebase init  ->  fast.js  ->  main script
   ===================================================================== */
(function(){
  'use strict';
  if(typeof firebase==='undefined'||typeof db==='undefined')return;

  var BASE=String((firebase.app().options||{}).databaseURL||'').replace(/\/$/,'');

  /* ---------- small status pill (shows progress / errors on the phone) ---------- */
  var pill=null,pillHideTimer=null;
  function showPill(msg,isErr,autohide){
    try{
      if(!pill){
        pill=document.createElement('div');
        pill.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom));z-index:99999;font:700 12px Arial,sans-serif;padding:7px 13px;border-radius:20px;box-shadow:0 2px 10px #0003;max-width:92vw;text-align:center;pointer-events:none';
        document.body.appendChild(pill);
      }
      pill.style.background=isErr?'#c22':'#171717';pill.style.color='#fff';
      pill.textContent=msg;pill.style.display='block';
      clearTimeout(pillHideTimer);
      if(autohide)pillHideTimer=setTimeout(function(){pill.style.display='none'},autohide);
    }catch(e){}
  }
  function hidePill(){if(pill)pill.style.display='none'}
  if(/PASTE_/.test(String((firebase.app().options||{}).databaseURL||''))){
    console.error('[fast] Firebase config is still the PASTE_... placeholder in index.html');
    showPill('Firebase config missing in index.html - products cannot load',true);
    return;
  }
  var CACHE_PATHS={'/settings':1,'/categories':1,'/inventory':1};
  var POLL_MS=120000;

  /* ---------- IndexedDB cache ---------- */
  var DB_NAME='jr-store-cache',STORE='kv',idbPromise=null;
  function idb(){
    if(idbPromise)return idbPromise;
    idbPromise=new Promise(function(res){
      try{
        var r=indexedDB.open(DB_NAME,1);
        r.onupgradeneeded=function(){r.result.createObjectStore(STORE)};
        r.onsuccess=function(){res(r.result)};
        r.onerror=function(){res(null)};
        r.onblocked=function(){res(null)};
      }catch(e){res(null)}
    });
    return idbPromise;
  }
  function cacheGet(key){
    return idb().then(function(d){
      return new Promise(function(res){
        if(!d)return res(undefined);
        try{
          var q=d.transaction(STORE,'readonly').objectStore(STORE).get(key);
          q.onsuccess=function(){res(q.result)};
          q.onerror=function(){res(undefined)};
        }catch(e){res(undefined)}
      });
    });
  }
  function cacheSet(key,val){
    idb().then(function(d){
      if(!d)return;
      try{d.transaction(STORE,'readwrite').objectStore(STORE).put(val,key)}catch(e){}
    });
  }
  var saveTimers={};
  function scheduleSave(key,getVal){
    clearTimeout(saveTimers[key]);
    saveTimers[key]=setTimeout(function(){
      try{cacheSet(key,{v:getVal(),t:Date.now()})}catch(e){}
    },800);
  }

  /* ---------- helpers ---------- */
  function fakeSnap(v,path,partial){
    return {
      val:function(){return v},
      exportVal:function(){return v},
      key:path.split('/').pop()||null,
      exists:function(){return v!==null&&v!==undefined},
      forEach:function(){return false},
      partial:!!partial
    };
  }
  function pathOf(q){return String(q.toString()).replace(/^https?:\/\/[^\/]+/,'')}
  function isHeavy(p){
    return !!p&&((p.photos&&(Array.isArray(p.photos)?p.photos.length:Object.keys(p.photos).length))||p.photo);
  }
  /* keep only one image for heavy products so memory/cache stay small */
  function lighten(p){
    if(!p||typeof p!=='object')return p;
    var out={},k;
    for(k in p)out[k]=p[k];
    if(out.thumb){delete out.photos;delete out.photo;return out}
    var first=null;
    if(Array.isArray(out.photos))first=out.photos.filter(Boolean)[0];
    else if(out.photos&&typeof out.photos==='object'){var ks=Object.keys(out.photos);first=out.photos[ks[0]]}
    first=first||out.photo||null;
    delete out.photos;delete out.photo;
    if(first)out.thumb=first;
    return out;
  }
  function lightenMap(m){
    var o={};
    Object.keys(m||{}).forEach(function(k){o[k]=lighten(m[k])});
    return o;
  }
  function rget(p,q){
    return fetch(BASE+p+'.json'+(q||'')).then(function(r){
      if(!r.ok)throw new Error('HTTP '+r.status);
      return r.json();
    });
  }
  var enc=encodeURIComponent;

  /* ---------- Inventory: parallel REST loader + cache ---------- */
  var origOn=(firebase.database.Query||firebase.database.Reference).prototype.on;
  var reloadHook=null;
  window.__fastReloadInventory=function(){if(reloadHook)reloadHook()};

  function inventoryLoader(ref,cb,errCb,ctx){
    var path='/inventory',key='v1:'+path;
    var gotFull=false,cacheShown=false,running=false,fallback=false;
    var timer=null,latest=null,pollTimer=null,liveStarted=false;

    function emit(map,partial){
      try{cb(fakeSnap(map,path,partial))}catch(e){console.error('inventory render failed:',e)}
    }
    function push(map){
      latest=map;
      if(timer)return;
      timer=setTimeout(function(){timer=null;if(!gotFull)emit(latest,true)},250);
    }

    // 1) show the saved copy immediately
    cacheGet(key).then(function(rec){
      if(gotFull||!rec||!('v' in rec))return;
      cacheShown=true;
      emit(rec.v,false);
    });

    function wrappedLive(snap){
      scheduleSave(key,function(){return lightenMap(snap.val())});
      return cb.apply(this,arguments);
    }
    function useWebsocketFallback(){
      fallback=true;
      clearInterval(pollTimer);
      origOn.call(ref,'value',wrappedLive,errCb,ctx);
    }
    function subscribeLive(){
      if(liveStarted)return;
      liveStarted=true;
      origOn.call(ref,'value',wrappedLive,errCb,ctx);
    }

    var LIGHT_BYTES=200*1024;   // a product bigger than this is "heavy"
    var FIELDS=['title','price','category','rating','ratingCount','subtitle'];
    var heavyThumb={};          // id -> small thumb already known for a heavy product
    var thumbQ=[],thumbRunning=0,curMap=null,curIds=[],dirtyTimer=null;

    function ordered(){
      var o={};
      curIds.forEach(function(id){if(curMap&&id in curMap)o[id]=curMap[id]});
      return o;
    }
    // photos arriving later: refresh the screen at most twice a second + save to cache
    function dirty(){
      if(dirtyTimer)return;
      dirtyTimer=setTimeout(function(){
        dirtyTimer=null;
        var m=ordered();
        emit(m,false);
        scheduleSave(key,function(){return m});
      },500);
    }

    // heavy product: ONLY the small text fields now (photo comes later, in the background)
    async function fieldsOnly(id){
      var base='/inventory/'+enc(id)+'/',o={id:id};
      await Promise.all(FIELDS.map(function(f){
        return rget(base+f).then(function(v){if(v!==null&&v!==undefined)o[f]=v}).catch(function(){});
      }));
      if(heavyThumb[id])o.thumb=heavyThumb[id];
      return o;
    }
    async function fetchThumb(id){
      var base='/inventory/'+enc(id)+'/';
      var t=await rget(base+'thumb').catch(function(){return null});
      if(!t)t=await rget(base+'photos/0').catch(function(){return null});
      if(!t)t=await rget(base+'photo').catch(function(){return null});
      if(!t){
        try{
          var ks=await rget(base+'photos','?shallow=true');
          var k0=Object.keys(ks||{})[0];
          if(k0!==undefined)t=await rget(base+'photos/'+enc(k0));
        }catch(e){}
      }
      if(typeof t==='string'&&t.indexOf('data:')===0&&t.length>60000){
        try{t=await shrink(t,360,0.55)}catch(e){}
      }
      return t||null;
    }
    function shrink(dataUrl,maxDim,quality){
      return new Promise(function(resolve,reject){
        var img=new Image();
        img.onload=function(){
          var w=img.width,h=img.height;
          if(w>h&&w>maxDim){h=Math.round(h*maxDim/w);w=maxDim}
          else if(h>maxDim){w=Math.round(w*maxDim/h);h=maxDim}
          var c=document.createElement('canvas');c.width=w;c.height=h;
          c.getContext('2d').drawImage(img,0,0,w,h);
          resolve(c.toDataURL('image/jpeg',quality));
        };
        img.onerror=function(){reject(new Error('decode fail'))};
        img.src=dataUrl;
      });
    }
    function pumpThumbs(){
      while(thumbRunning<3&&thumbQ.length){
        (function(id){
          thumbRunning++;
          fetchThumb(id).then(function(t){
            if(t){heavyThumb[id]=t;if(curMap&&curMap[id]){curMap[id].thumb=t;dirty()}}
          }).catch(function(){}).then(function(){
            thumbRunning--;
            if(!thumbQ.length&&!thumbRunning){showPill('Photos loaded',false,1500);dirty()}
            else pumpThumbs();
          });
        })(thumbQ.shift());
      }
    }

    // One product. Light ones: a single request. If it turns out big we STOP
    // downloading it and take only its small fields (photo is queued for later).
    async function getProduct(id,flag){
      var ctrl=(typeof AbortController!=='undefined')?new AbortController():null;
      var r=await fetch(BASE+'/inventory/'+enc(id)+'.json',ctrl?{signal:ctrl.signal}:undefined);
      if(!r.ok)throw new Error('HTTP '+r.status);
      if(ctrl&&r.body&&r.body.getReader&&typeof TextDecoder!=='undefined'){
        var rd=r.body.getReader(),dec=new TextDecoder(),txt='',n=0;
        while(true){
          var x=await rd.read();
          if(x.done)break;
          n+=x.value.length;
          txt+=dec.decode(x.value,{stream:true});
          if(n>LIGHT_BYTES){
            try{ctrl.abort()}catch(e){}
            flag.heavy=true;
            var o=await fieldsOnly(id);
            if(!o.thumb)flag.needThumb.push(id);
            return o;
          }
        }
        txt+=dec.decode();
        var p=JSON.parse(txt);
        if(p&&isHeavy(p))flag.heavy=true;
        return p;
      }
      var p2=await r.json();
      if(p2&&isHeavy(p2))flag.heavy=true;
      return p2;
    }

    async function loadAll(){
      if(running||fallback||thumbRunning||thumbQ.length)return;
      running=true;
      var flag={heavy:false,needThumb:[]},map={},ids=[],t0=Date.now();
      curMap=map;
      try{
        // thumbs we already know (saved copy) so heavy photos are not downloaded again
        try{
          var rec=await cacheGet(key);
          if(rec&&rec.v)Object.keys(rec.v).forEach(function(k){if(rec.v[k]&&rec.v[k].thumb&&!heavyThumb[k])heavyThumb[k]=rec.v[k].thumb});
        }catch(e){}
        if(!gotFull&&!cacheShown)showPill('Loading products...',false);
        var keys=await rget('/inventory','?shallow=true');
        ids=Object.keys(keys||{}).sort();
        curIds=ids;
        var ii=0,done=0;
        async function worker(){
          while(ii<ids.length){
            var id=ids[ii++];
            try{
              var p=await getProduct(id,flag);
              if(p){
                map[id]=lighten(p);
                if(Object.keys(map).length===1)console.log('[fast] first product shown after '+(Date.now()-t0)+'ms');
              }
            }catch(e){console.error('item load failed',id,e)}
            done++;
            if(!gotFull&&!cacheShown){showPill('Loading products... '+done+' / '+ids.length,false);push(ordered())}
          }
        }
        var ws=[];
        for(var w=0;w<10;w++)ws.push(worker());
        await Promise.all(ws);
        clearTimeout(timer);timer=null;
        gotFull=true;
        var finalMap=ordered();
        console.log('[fast] all '+ids.length+' products (text) loaded in '+(Date.now()-t0)+'ms'+(flag.heavy?', heavy photos loading in background':''));
        emit(finalMap,false);
        scheduleSave(key,function(){return finalMap});
        if(flag.needThumb.length){
          showPill('Loading photos...',false);
          flag.needThumb.forEach(function(id){thumbQ.push(id)});
          pumpThumbs();
        }else hidePill();
      }catch(err){
        running=false;
        if(!gotFull&&!cacheShown){
          console.error('REST inventory failed, using websocket:',err);
          showPill('Products could not load: '+((err&&err.message)||err),true);
          useWebsocketFallback();
        }
        return;
      }
      running=false;
      if(flag.heavy){
        // old heavy products still exist: never pull them over the websocket;
        // refresh quietly over REST instead (known thumbs are reused).
        if(!pollTimer)pollTimer=setInterval(function(){
          if(typeof document!=='undefined'&&document.hidden)return;
          loadAll();
        },POLL_MS);
      }else{
        clearInterval(pollTimer);pollTimer=null;
        subscribeLive();
      }
    }
    reloadHook=function(){loadAll()};
    loadAll();
  }

  /* ---------- on('value') wrapper ---------- */
  var Proto=(firebase.database.Query||firebase.database.Reference).prototype;
  Proto.on=function(evt,cb,cancelOrCtx,ctx){
    if(evt!=='value'||typeof cb!=='function')return origOn.apply(this,arguments);
    var path=pathOf(this);
    if(!CACHE_PATHS[path])return origOn.apply(this,arguments);

    if(path==='/inventory'&&BASE&&typeof fetch==='function'){
      inventoryLoader(this,cb,cancelOrCtx,ctx);
      return cb;
    }

    // settings / categories: saved copy first, live data right after
    var key='v1:'+path,live=false;
    var wrapped=function(snap){
      live=true;
      scheduleSave(key,function(){return snap.val()});
      return cb.apply(this,arguments);
    };
    cacheGet(key).then(function(rec){
      if(live||!rec||!('v' in rec))return;
      try{cb(fakeSnap(rec.v,path))}catch(e){console.error('cache render failed:',e)}
    });
    return origOn.call(this,evt,wrapped,cancelOrCtx,ctx);
  };

  /* ---------- product gallery: REST, not the busy websocket ---------- */
  var origOnce=Proto.once;
  var galleryMem={};
  Proto.once=function(evt,cb,errCb,ctx){
    if(evt==='value'&&BASE&&typeof fetch==='function'){
      var path=pathOf(this);
      if(/^\/inventoryPhotos\/[^\/]+$/.test(path)){
        var self=this,args=arguments;
        var p=(path in galleryMem)?Promise.resolve(galleryMem[path]):rget(path).then(function(v){galleryMem[path]=v;return v});
        return p.then(function(v){
          var s=fakeSnap(v,path);
          if(typeof cb==='function'){try{cb.call(ctx,s)}catch(e){console.error(e)}}
          return s;
        },function(){return origOnce.apply(self,args)});
      }
    }
    return origOnce.apply(this,arguments);
  };
})();
