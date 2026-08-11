(function(factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else globalThis.NodeAlignDistributeCore=api;
})(function(){
  'use strict';

  const PLUGIN_ID='node-align-distribute';
  const ACTION_LABELS={left:'左对齐',hcenter:'水平居中',right:'右对齐',top:'顶对齐',vcenter:'垂直居中',bottom:'底对齐'};

  function finite(value){return Number.isFinite(Number(value));}
  function round(value){return Math.round(Number(value));}
  function normalizeItem(item){
    if(!item||!item.id||!finite(item.x)||!finite(item.y)||!finite(item.width)||!finite(item.height))return null;
    const x=Number(item.x),y=Number(item.y),width=Number(item.width),height=Number(item.height);
    if(width<=0||height<=0)return null;
    return{...item,id:String(item.id),x,y,width,height,left:x,right:x+width,top:y,bottom:y+height,centerX:x+width/2,centerY:y+height/2};
  }
  function normalizeItems(items){
    const seen=new Set();
    return(Array.isArray(items)?items:[]).map(normalizeItem).filter(item=>item&&!seen.has(item.id)&&seen.add(item.id));
  }
  function selectionBounds(items){
    const list=normalizeItems(items);if(!list.length)return null;
    const left=Math.min(...list.map(item=>item.left)),right=Math.max(...list.map(item=>item.right));
    const top=Math.min(...list.map(item=>item.top)),bottom=Math.max(...list.map(item=>item.bottom));
    return{left,right,top,bottom,width:right-left,height:bottom-top,centerX:(left+right)/2,centerY:(top+bottom)/2};
  }
  function target(item,toX=item.x,toY=item.y){return{id:item.id,fromX:item.x,fromY:item.y,toX:round(toX),toY:round(toY)};}
  function alignPlan(rawItems,action,{referenceMode='selection',keyId=''}={}){
    const items=normalizeItems(rawItems);if(items.length<2||!ACTION_LABELS[action])return[];
    const key=referenceMode==='key'?items.find(item=>item.id===String(keyId)):null;
    if(referenceMode==='key'&&!key)return[];
    const reference=key||selectionBounds(items);
    const plans=items.map(item=>{
      if(key&&item.id===key.id)return target(item);
      if(action==='left')return target(item,reference.left,item.y);
      if(action==='hcenter')return target(item,reference.centerX-item.width/2,item.y);
      if(action==='right')return target(item,reference.right-item.width,item.y);
      if(action==='top')return target(item,item.x,reference.top);
      if(action==='vcenter')return target(item,item.x,reference.centerY-item.height/2);
      return target(item,item.x,reference.bottom-item.height);
    }).filter(plan=>plan.fromX!==plan.toX||plan.fromY!==plan.toY);
    if(key&&['vcenter','bottom'].includes(action))plans.forEach(plan=>{plan.keyVerticalAction=action;plan.referenceKeyId=key.id;});
    return plans;
  }
  function glyph(kind){
    const horizontalAxis=['left','hcenter','right'].includes(kind);
    const guide=kind.includes('center')?12:(['right','bottom'].includes(kind)?20:4);
    const line=horizontalAxis?`<path d="M${guide} 3v18"/>`:`<path d="M3 ${guide}h18"/>`;
    const blocks=horizontalAxis
      ?`<rect x="${kind==='right'?8:kind==='hcenter'?6:4}" y="6" width="13" height="4" rx="1"/><rect x="${kind==='right'?11:kind==='hcenter'?8:4}" y="14" width="10" height="4" rx="1"/>`
      :`<rect x="6" y="${kind==='bottom'?8:kind==='vcenter'?6:4}" width="4" height="13" rx="1"/><rect x="14" y="${kind==='bottom'?11:kind==='vcenter'?8:4}" width="4" height="10" rx="1"/>`;
    return`<svg viewBox="0 0 24 24" aria-hidden="true">${line}${blocks}</svg>`;
  }
  function actionButtons(){
    return['left','hcenter','right','top','vcenter','bottom'].map(action=>`<button type="button" class="nad-icon-btn" data-nad-align="${action}" title="${ACTION_LABELS[action]}" aria-label="${ACTION_LABELS[action]}">${glyph(action)}</button>`).join('');
  }

  function createController(adapter){
    if(!adapter||!adapter.surface||!adapter.getItems)throw new Error('node-align-distribute adapter incomplete');
    let items=[],keyId='',referenceMode='selection',busy=false,frame=0,destroyed=false,keyClickCleanup=null;
    const root=document.createElement('div');
    root.className='nad-root';root.dataset.nodeAlignDistributePlugin='1';root.dataset.canvasInteractive='1';
    root.innerHTML=`<section class="nad-quickbar" aria-label="对齐工具栏"><div class="nad-quick-actions">${actionButtons()}</div></section>`;
    adapter.surface.append(root);

    function position(){
      const rect=adapter.surface.getBoundingClientRect();
      root.style.left=`${Math.round(16-rect.left)}px`;
      root.style.top=`${Math.round(window.innerHeight-16-rect.top-root.offsetHeight)}px`;
    }
    function refresh(){
      if(destroyed)return;
      items=normalizeItems(adapter.getItems());
      if(keyId&&!items.some(item=>item.id===keyId)){keyId='';referenceMode='selection';}
      root.classList.toggle('visible',items.length>0);root.classList.toggle('disabled',items.length<2);
      root.querySelectorAll('[data-nad-align]').forEach(button=>button.disabled=items.length<2||busy);
      adapter.markKey?.(keyId,items.map(item=>item.id));
      keyClickCleanup?.();keyClickCleanup=null;
      if(items.length>=2&&adapter.watchKeyClicks)keyClickCleanup=adapter.watchKeyClicks(items.map(item=>item.id),id=>{keyId=String(id);referenceMode='key';adapter.toast?.(`已设为关键对象：${adapter.labelFor?.(keyId)||keyId.slice(-6)}`);refresh();});
      position();
    }
    function scheduleRefresh(){if(frame||destroyed)return;frame=requestAnimationFrame(()=>{frame=0;refresh();});}
    function execute(action){
      if(busy||adapter.isBusy?.())return;
      const fresh=normalizeItems(adapter.getItems());
      if(fresh.length<2){adapter.toast?.('请至少选择两个可移动单元');refresh();return;}
      const plan=alignPlan(fresh,action,{referenceMode,keyId});
      if(!plan.length){adapter.toast?.('节点已处于该位置');return;}
      busy=true;refresh();
      try{adapter.commit(plan);adapter.toast?.(`已${ACTION_LABELS[action]} ${fresh.length} 个对象`);}
      catch(error){console.error('[node-align-distribute] commit failed',error);adapter.toast?.('对齐失败，未修改节点');}
      finally{busy=false;scheduleRefresh();}
    }

    const protectCanvasSelection=event=>{if(root.contains(event.target))event.stopPropagation();};
    document.addEventListener('pointerdown',protectCanvasSelection,true);document.addEventListener('mousedown',protectCanvasSelection,true);
    root.addEventListener('pointerdown',event=>event.stopPropagation());root.addEventListener('mousedown',event=>event.stopPropagation());
    root.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const button=event.target.closest('[data-nad-align]');if(button)execute(button.dataset.nadAlign);});
    window.addEventListener('resize',position);
    const unwatch=adapter.watchSelection(scheduleRefresh);
    refresh();
    return{refresh,destroy(){destroyed=true;keyClickCleanup?.();keyClickCleanup=null;if(frame)cancelAnimationFrame(frame);unwatch?.();document.removeEventListener('pointerdown',protectCanvasSelection,true);document.removeEventListener('mousedown',protectCanvasSelection,true);window.removeEventListener('resize',position);adapter.markKey?.('',[]);root.remove();}};
  }

  return{PLUGIN_ID,normalizeItems,selectionBounds,alignPlan,createController};
});
