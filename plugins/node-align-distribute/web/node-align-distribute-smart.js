(function(){
  'use strict';
  if(globalThis.NodeAlignDistributeSmartPlugin?.mounted) return;
  let controller=null;
  const lifecycle={
    mounted:false,
    diagnostics:{canvas:'smart',adapter:'core-2026.08.04',status:'starting',missing:[]},
    mount(){if(this.mounted)return;this.mounted=true;mountImplementation();},
    unmount(){controller?.destroy();controller=null;document.querySelectorAll('[data-node-align-distribute-plugin]').forEach(node=>node.remove());this.mounted=false;this.diagnostics.status='disabled';}
  };
  globalThis.NodeAlignDistributeSmartPlugin=lifecycle;
  lifecycle.mount();

  function mountImplementation(){
    const Core=globalThis.NodeAlignDistributeCore;
    const checks={core:Boolean(Core),surface:Boolean(typeof shell!=='undefined'&&shell),anchor:Boolean(typeof smartArrangeBtn!=='undefined'&&smartArrangeBtn),selection:typeof selectedNodeIds==='function',nodes:typeof nodes!=='undefined',atomic:typeof smartArrangeAtomicIds==='function',bounds:typeof nodeRect==='function',move:typeof moveSmartNodeAtom==='function',undo:typeof pushUndo==='function',render:typeof render==='function',save:typeof scheduleSave==='function'};
    const missing=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
    if(missing.length){lifecycle.diagnostics={...lifecycle.diagnostics,status:'incompatible',missing};console.error('[node-align-distribute] 智能画布接口不兼容：',missing.join(', '));return;}
    const getIds=()=>smartArrangeAtomicIds(selectedNodeIds().filter(id=>nodes.some(node=>node.id===id)));
    const getItems=()=>getIds().map(id=>nodes.find(node=>node.id===id)).filter(Boolean).map(node=>{const rect=nodeRect(node);return{id:node.id,x:rect.x,y:rect.y,width:rect.width,height:rect.height};});
    function watchSelection(handler){
      const observer=new MutationObserver(handler);observer.observe(world,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
      const events=['pointerup','mouseup','click','keyup'];events.forEach(name=>document.addEventListener(name,handler,true));
      return()=>{observer.disconnect();events.forEach(name=>document.removeEventListener(name,handler,true));};
    }
    function markKey(keyId,ids){
      const candidates=new Set(ids||[]);world.querySelectorAll('[data-id]').forEach(el=>{const selected=candidates.has(el.dataset.id);el.classList.toggle('nad-key-object',selected&&el.dataset.id===keyId);el.classList.remove('nad-key-candidate');});
    }
    function watchKeyClicks(ids,onSelect){
      const allowed=new Set(ids);const click=event=>{const el=event.target.closest?.('[data-id]');if(!el||!world.contains(el)||!allowed.has(el.dataset.id)||event.target.closest?.('button,input,textarea,select,a,[contenteditable="true"]'))return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();onSelect(el.dataset.id);};
      document.addEventListener('click',click,true);return()=>document.removeEventListener('click',click,true);
    }
    const adapter={surface:shell,anchor:smartArrangeBtn,getItems,labelFor:id=>{const node=nodes.find(item=>item.id===id);return node?.title||node?.name||`${node?.type||'节点'} · ${String(id).slice(-6)}`;},
      isBusy:()=>Boolean(document.body.classList.contains('smart-node-drag')||document.body.classList.contains('smart-node-resize')||(typeof dragState!=='undefined'&&dragState)||(typeof resizeState!=='undefined'&&resizeState)||(typeof selectionState!=='undefined'&&selectionState)),
      commit(plans){const byId=new Map(nodes.map(node=>[node.id,node]));if(plans.some(plan=>!byId.has(plan.id)))throw new Error('selection changed');pushUndo();plans.forEach(plan=>moveSmartNodeAtom(byId.get(plan.id),plan.toX,plan.toY));render();const vertical=plans.find(plan=>plan.keyVerticalAction&&plan.referenceKeyId);if(vertical){const keyNode=byId.get(vertical.referenceKeyId);if(keyNode){const keyRect=nodeRect(keyNode);plans.forEach(plan=>{const node=byId.get(plan.id),rect=node&&nodeRect(node);if(!node||!rect)return;const targetY=vertical.keyVerticalAction==='vcenter'?keyRect.y+keyRect.height/2-rect.height/2:keyRect.y+keyRect.height-rect.height;moveSmartNodeAtom(node,node.x,targetY);});render();}}scheduleSave();},
      toast:message=>typeof toast==='function'?toast(String(message||'')):void 0,watchSelection,watchKeyClicks,markKey,syncSelectionVisuals:()=>syncSelectionUi()};
    controller=Core.createController(adapter);lifecycle.diagnostics={...lifecycle.diagnostics,status:'healthy',missing:[]};console.info('[node-align-distribute] smart adapter mounted');
  }
})();
