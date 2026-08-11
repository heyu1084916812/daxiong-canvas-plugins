(function(){
  'use strict';
  if(globalThis.NodeAlignDistributeClassicPlugin?.mounted) return;
  let controller=null,toastTimer=0;
  const lifecycle={
    mounted:false,
    diagnostics:{canvas:'classic',adapter:'core-2026.08.04',status:'starting',missing:[]},
    mount(){if(this.mounted)return;this.mounted=true;mountImplementation();},
    unmount(){controller?.destroy();controller=null;document.querySelectorAll('[data-node-align-distribute-plugin],.nad-toast').forEach(node=>node.remove());this.mounted=false;this.diagnostics.status='disabled';}
  };
  globalThis.NodeAlignDistributeClassicPlugin=lifecycle;
  lifecycle.mount();

  function mountImplementation(){
    const Core=globalThis.NodeAlignDistributeCore;
    const checks={core:Boolean(Core),surface:Boolean(typeof board!=='undefined'&&board),anchor:Boolean(typeof canvasArrangeBtn!=='undefined'&&canvasArrangeBtn),selection:typeof selected!=='undefined',nodes:typeof nodes!=='undefined',atomic:typeof canvasArrangeAtomicIds==='function',bounds:typeof nodeRect==='function',move:typeof moveCanvasNodeAtom==='function',undo:typeof pushUndo==='function',render:typeof render==='function',save:typeof scheduleSave==='function'};
    const missing=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
    if(missing.length){lifecycle.diagnostics={...lifecycle.diagnostics,status:'incompatible',missing};console.error('[node-align-distribute] 普通画布接口不兼容：',missing.join(', '));return;}
    const getIds=()=>canvasArrangeAtomicIds([...selected].filter(id=>nodes.some(node=>node.id===id)));
    const getItems=()=>getIds().map(id=>nodes.find(node=>node.id===id)).filter(Boolean).map(node=>{const rect=nodeRect(node);return{id:node.id,x:rect.x,y:rect.y,width:rect.w,height:rect.h};});
    function notify(message){
      let el=board.querySelector('.nad-toast');if(!el){el=document.createElement('div');el.className='nad-toast';el.dataset.nodeAlignDistributePlugin='1';board.appendChild(el);}el.textContent=String(message||'');el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),1800);
    }
    function watchSelection(handler){
      const observer=new MutationObserver(handler);observer.observe(nodesEl,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
      const events=['pointerup','mouseup','click','keyup'];events.forEach(name=>document.addEventListener(name,handler,true));
      return()=>{observer.disconnect();events.forEach(name=>document.removeEventListener(name,handler,true));};
    }
    function markKey(keyId,ids){
      const candidates=new Set(ids||[]);nodesEl.querySelectorAll('.node[data-id]').forEach(el=>{const selected=candidates.has(el.dataset.id);el.classList.toggle('nad-key-object',selected&&el.dataset.id===keyId);el.classList.remove('nad-key-candidate');});
    }
    function watchKeyClicks(ids,onSelect){
      const allowed=new Set(ids);const click=event=>{const el=event.target.closest?.('.node[data-id]');if(!el||!nodesEl.contains(el)||!allowed.has(el.dataset.id)||event.target.closest?.('button,input,textarea,select,a,[contenteditable="true"]'))return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();onSelect(el.dataset.id);};
      document.addEventListener('click',click,true);return()=>document.removeEventListener('click',click,true);
    }
    const adapter={surface:board,anchor:canvasArrangeBtn,getItems,labelFor:id=>{const node=nodes.find(item=>item.id===id);return node?.title||node?.name||`${node?.type||'节点'} · ${String(id).slice(-6)}`;},
      isBusy:()=>Boolean(document.body.classList.contains('canvas-node-drag')||document.body.classList.contains('canvas-node-resize')||document.body.classList.contains('canvas-selecting')),
      commit(plans){const byId=new Map(nodes.map(node=>[node.id,node]));if(plans.some(plan=>!byId.has(plan.id)))throw new Error('selection changed');pushUndo();plans.forEach(plan=>moveCanvasNodeAtom(byId.get(plan.id),plan.toX,plan.toY));render();const vertical=plans.find(plan=>plan.keyVerticalAction&&plan.referenceKeyId);if(vertical){const keyNode=byId.get(vertical.referenceKeyId);if(keyNode){const keyRect=nodeRect(keyNode);plans.forEach(plan=>{const node=byId.get(plan.id),rect=node&&nodeRect(node);if(!node||!rect)return;const targetY=vertical.keyVerticalAction==='vcenter'?keyRect.y+keyRect.h/2-rect.h/2:keyRect.y+keyRect.h-rect.h;moveCanvasNodeAtom(node,node.x,targetY);});render();}}scheduleSave();},
      toast:notify,watchSelection,watchKeyClicks,markKey,syncSelectionVisuals:()=>refreshSelectionVisuals()};
    controller=Core.createController(adapter);lifecycle.diagnostics={...lifecycle.diagnostics,status:'healthy',missing:[]};console.info('[node-align-distribute] classic adapter mounted');
  }
})();
