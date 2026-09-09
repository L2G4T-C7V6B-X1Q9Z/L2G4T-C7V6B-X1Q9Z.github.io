// Interaction layer for the fresh chart. The visual renderer supplies geometry;
// listeners live on the stable chart host, so SVG redraws never lose a gesture.
(() => {
  'use strict';
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  const boundHosts=new WeakSet();
  const sessions=new WeakMap();
  let active=null,lastTap=null;
  const geometry={width:1000,height:280,left:40,top:15,plotWidth:936,plotHeight:230};

  function svgOf(session){return typeof session.config.svg==='function'?session.config.svg():session.config.svg;}
  function points(session){return [...session.pointers.values()];}
  function rectOf(session){return svgOf(session)?.getBoundingClientRect();}
  function plotRatio(session,x){const rect=rectOf(session);return rect?.width?clamp(((x-rect.left)/rect.width*geometry.width-geometry.left)/geometry.plotWidth):0.5;}
  function inPlot(session,event){const rect=rectOf(session);return rect?.width>0&&rect.height>0&&event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom;}
  function dataOf(session){const data=session.config.getData();return {...data,series:(data.series||[]).filter((series)=>!(series.weightPrivate===true&&!series.own))};}

  function hide(session){
    if(!session)return;
    const svg=svgOf(session),tip=session.host.querySelector('#chart-tooltip');
    svg?.querySelector('#chart-scrub')?.setAttribute('hidden','');
    if(tip)tip.hidden=true;
  }

  function atIndex(series,index,dates){
    const samples=(series.points||[]).map((point)=>({...point,index:dates.indexOf(point.date)})).filter((point)=>point.index>=0&&Number.isFinite(point.value)&&Number.isFinite(point.display)).sort((a,b)=>a.index-b.index);
    if(!samples.length)return null;
    const exact=samples.find((point)=>point.index===index);
    if(exact)return {...exact,interpolated:false};
    const before=samples.filter((point)=>point.index<index).at(-1),after=samples.find((point)=>point.index>index);
    if(!before||!after)return null;
    const fraction=(index-before.index)/(after.index-before.index);
    return {date:dates[index],value:before.value+(after.value-before.value)*fraction,display:before.display+(after.display-before.display)*fraction,interpolated:true};
  }

  function scrub(session,event){
    if(!session.host.isConnected)return;
    const svg=svgOf(session),rect=rectOf(session),data=dataOf(session),dates=data.dates||[];
    if(!svg||!rect?.width||!dates.length){hide(session);return;}
    const index=clamp(Math.round(plotRatio(session,event.clientX)*(dates.length-1)),0,dates.length-1);
    const yClient=(event.clientY-rect.top)/rect.height*geometry.height;
    const range=data.max-data.min||1;
    const candidates=data.series.map((series)=>{
      const point=atIndex(series,index,dates);
      if(!point)return null;
      const y=geometry.top+(data.max-point.display)/range*geometry.plotHeight;
      return {series,point,y,distance:Math.abs(y-yClient)};
    }).filter(Boolean).sort((a,b)=>a.distance-b.distance);
    const nearest=candidates[0];
    if(!nearest){hide(session);return;}
    const x=geometry.left+index/Math.max(1,dates.length-1)*geometry.plotWidth;
    const group=svg.querySelector('#chart-scrub'),line=group?.querySelector('line'),dot=group?.querySelector('circle');
    group?.removeAttribute('hidden');
    line?.setAttribute('x1',x);line?.setAttribute('x2',x);
    dot?.setAttribute('cx',x);dot?.setAttribute('cy',nearest.y);
    const tip=session.host.querySelector('#chart-tooltip');
    if(tip){
      const name=document.createElement('span');name.textContent=nearest.series.name||'Member';
      const value=document.createElement('strong');value.textContent=`${nearest.point.interpolated?'≈ ':''}${nearest.point.value.toFixed(1)} lb`;
      const date=document.createElement('small');date.textContent=new Date(`${dates[index]}T12:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
      tip.replaceChildren(name,value,date);
      tip.dataset.series=String(nearest.series.id||'');
      tip.dataset.date=dates[index];
      tip.hidden=false;
      const width=tip.getBoundingClientRect().width||140;
      tip.style.left=`${clamp(x/geometry.width*rect.width,width/2+4,Math.max(width/2+4,rect.width-width/2-4))}px`;
    }
    session.lastScrub={clientX:event.clientX,clientY:event.clientY};
  }

  function setView(session,view){
    const next={zoom:clamp(Number(view.zoom)||1,1,8),pan:clamp(Number(view.pan)||0)};
    if(next.zoom===1)next.pan=0;
    session.config.setView(next);
    session.host.dataset.zoom=next.zoom.toFixed(4);
    session.host.dataset.pan=next.pan.toFixed(4);
  }

  function zoomAt(session,newZoom,ratio){
    const current=session.config.getView(),oldZoom=clamp(current.zoom||1,1,8),zoom=clamp(newZoom,1,8);
    const anchor=clamp(current.pan||0)*(1-1/oldZoom)+ratio/oldZoom;
    const pan=zoom===1?0:(anchor-ratio/zoom)/(1-1/zoom);
    setView(session,{zoom,pan});
  }

  function reset(session){
    if(!session)return;
    setView(session,{zoom:1,pan:0});
    hide(session);lastTap=null;
  }

  function begin(session,event){
    if(!inPlot(session,event)||event.button!=null&&event.button!==0)return;
    active=session;
    const point={id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,time:Date.now(),type:event.pointerType};
    session.pointers.set(event.pointerId,point);
    try{session.host.setPointerCapture(event.pointerId);}catch(_){}
    const all=points(session),view=session.config.getView();
    if(all.length===1)session.drag={x:event.clientX,y:event.clientY,pan:view.pan||0,zoom:view.zoom||1};
    else if(all.length===2){all.forEach((point)=>point.multi=true);session.pinch={distance:Math.hypot(all[0].x-all[1].x,all[0].y-all[1].y)||1,mid:(all[0].x+all[1].x)/2};session.drag=null;}
    scrub(session,event);
    if(event.cancelable)event.preventDefault();
  }

  function move(session,event){
    const pointer=session.pointers.get(event.pointerId);
    if(!pointer){if(event.pointerType!=='touch'&&inPlot(session,event))scrub(session,event);return;}
    pointer.x=event.clientX;pointer.y=event.clientY;
    const all=points(session);
    if(all.length>=2){
      const distance=Math.hypot(all[0].x-all[1].x,all[0].y-all[1].y)||1,mid=(all[0].x+all[1].x)/2;
      if(session.pinch){
        const view=session.config.getView(),ratio=plotRatio(session,session.pinch.mid),rect=rectOf(session);
        zoomAt(session,(view.zoom||1)*distance/session.pinch.distance,ratio);
        if(rect?.width){const after=session.config.getView(),fraction=(mid-session.pinch.mid)/rect.width*geometry.width/geometry.plotWidth;
          if(after.zoom>1)setView(session,{zoom:after.zoom,pan:after.pan-fraction/(after.zoom-1)});}
      }
      session.pinch={distance,mid};
      scrub(session,{clientX:mid,clientY:(all[0].y+all[1].y)/2});
    }else if(session.drag&&session.drag.zoom>1){
      const rect=rectOf(session),fraction=rect?.width?(event.clientX-session.drag.x)/rect.width*geometry.width/geometry.plotWidth:0;
      setView(session,{zoom:session.drag.zoom,pan:session.drag.pan-fraction/(session.drag.zoom-1)});
      scrub(session,event);
    }else scrub(session,event);
    if(event.cancelable)event.preventDefault();
  }

  function end(session,event){
    const pointer=session.pointers.get(event.pointerId);
    if(!pointer)return;
    session.pointers.delete(event.pointerId);
    try{if(session.host.hasPointerCapture(event.pointerId))session.host.releasePointerCapture(event.pointerId);}catch(_){}
    const all=points(session);
    if(all.length===1){const view=session.config.getView();session.drag={x:all[0].x,y:all[0].y,pan:view.pan||0,zoom:view.zoom||1};session.pinch=null;}
    else if(!all.length){
      session.drag=null;session.pinch=null;
      const tap=pointer.type==='touch'&&!pointer.multi&&event.type!=='pointercancel'&&Date.now()-pointer.time<300&&Math.hypot(pointer.x-pointer.startX,pointer.y-pointer.startY)<10;
      if(tap){const next={time:Date.now(),x:pointer.x,y:pointer.y};
        if(lastTap&&next.time-lastTap.time<350&&Math.hypot(next.x-lastTap.x,next.y-lastTap.y)<28)reset(session);else lastTap=next;
      }
      active=null;
    }
  }

  function bind(config){
    if(!config?.host)return;
    const host=config.host;
    let session=sessions.get(host);
    if(!session){session={host,config,pointers:new Map(),drag:null,pinch:null,lastScrub:null};sessions.set(host,session);}else session.config=config;
    const view=config.getView();host.dataset.zoom=String(view.zoom||1);host.dataset.pan=String(view.pan||0);
    host.style.touchAction='none';
    if(boundHosts.has(host))return;
    boundHosts.add(host);
    host.addEventListener('pointerdown',(event)=>begin(session,event));
    host.addEventListener('pointermove',(event)=>{if(!session.pointers.has(event.pointerId))move(session,event);});
    host.addEventListener('pointerleave',()=>{if(!session.pointers.size)hide(session);});
    host.addEventListener('wheel',(event)=>{
      if(!inPlot(session,event))return;
      event.preventDefault();
      const view=session.config.getView();
      zoomAt(session,(view.zoom||1)*Math.exp(-clamp(event.deltaY,-240,240)*0.003),plotRatio(session,event.clientX));
      scrub(session,event);
    },{passive:false});
    host.addEventListener('dblclick',(event)=>{if(inPlot(session,event)){event.preventDefault();reset(session);}});
    // Keyboard users retain explicit chart controls; arrow keys additionally pan.
    host.tabIndex=0;
    host.setAttribute('aria-label','Weight chart. Plus and minus zoom; arrows pan; zero resets.');
    host.addEventListener('keydown',(event)=>{
      const view=session.config.getView();
      if(event.key==='+'||event.key==='=')zoomAt(session,(view.zoom||1)*1.3,0.5);
      else if(event.key==='-')zoomAt(session,(view.zoom||1)/1.3,0.5);
      else if(event.key==='ArrowLeft')setView(session,{zoom:view.zoom,pan:view.pan-0.1});
      else if(event.key==='ArrowRight')setView(session,{zoom:view.zoom,pan:view.pan+0.1});
      else if(event.key==='0'||event.key==='Escape')reset(session);else return;
      event.preventDefault();
    });
  }

  window.addEventListener('pointermove',(event)=>{if(active?.pointers.has(event.pointerId))move(active,event);},{passive:false});
  window.addEventListener('pointerup',(event)=>{if(active)end(active,event);});
  window.addEventListener('pointercancel',(event)=>{if(active)end(active,event);});
  document.addEventListener('pointerdown',(event)=>{
    if(active&&!active.host.isConnected){active.pointers.clear();active=null;}
    for(const host of document.querySelectorAll('.chart-content'))if(!host.contains(event.target))hide(sessions.get(host));
  },true);
  window.GymBoardChart={bind,reset(){const host=document.querySelector('.chart-content');reset(sessions.get(host));}};
})();
