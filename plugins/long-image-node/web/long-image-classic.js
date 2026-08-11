(function(){
  if(globalThis.LongImageClassicPlugin?.mounted) return;
  const lifecycle = {
    mounted:false,
    diagnostics:{canvas:'classic', adapter:'core-2026.08.04', status:'starting', missing:[]},
    mount(){ if(this.mounted) return; this.mounted=true; mountImplementation(); },
    unmount(){
      this.restoreWrappedFunctions?.();
      document.querySelectorAll('.long-image-selection-action').forEach(node => node.remove());
      this.restoreWrappedFunctions=null;
      this.mounted=false;
      this.diagnostics.status='disabled';
    }
  };
  globalThis.LongImageClassicPlugin = lifecycle;
  lifecycle.mount();

  function mountImplementation(){
    const Core = globalThis.LongImageCore;
    const checks = {
      core:Boolean(Core), nodes:typeof nodes !== 'undefined', selected:typeof selected !== 'undefined',
      render:typeof render === 'function', renderNode:typeof renderNode === 'function',
      imageRefsFromNode:typeof imageRefsFromNode === 'function', pushUndo:typeof pushUndo === 'function',
      scheduleSave:typeof scheduleSave === 'function', nodeBounds:typeof nodeBounds === 'function',
      openImageEditor:typeof openImageEditor === 'function', refreshSelectionVisuals:typeof refreshSelectionVisuals === 'function'
    };
    const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if(missing.length){
      lifecycle.diagnostics={...lifecycle.diagnostics, status:'incompatible', missing};
      console.error('[long-image-node] 普通画布接口不兼容：', missing.join(', '));
      return;
    }
    const original = {render, renderNode, imageRefsFromNode, refreshSelectionVisuals};
    const activeRequests = new Map();
    let actionButton = null;
    let editorOverlay = null;
    let editorNodeId = '';
    lifecycle.restoreWrappedFunctions = () => {
      render = original.render;
      renderNode = original.renderNode;
      imageRefsFromNode = original.imageRefsFromNode;
      refreshSelectionVisuals = original.refreshSelectionVisuals;
      activeRequests.forEach(controller => controller.abort?.());
      activeRequests.clear();
      closeEditor();
    };

    function notify(message){
      if(typeof showErrorModal === 'function') showErrorModal(String(message || ''), '长图节点');
      else alert(String(message || ''));
    }
    async function ensureEnabled(){
      const enabled = await Core.pluginEnabled();
      if(!enabled) notify('长图节点插件已停用或不可用，请在插件管理器开启后刷新画布');
      return enabled;
    }
    function refsForNode(node){
      if(Core.isLongImage(node) && !Core.isReady(node)) return [];
      return original.imageRefsFromNode(node) || [];
    }
    function selectedSourceItems(){
      const chosen = [...selected].map(id => nodes.find(node => node.id === id)).filter(Boolean);
      return Core.collectSources(chosen, refsForNode);
    }
    function ensureActionButton(){
      if(actionButton?.isConnected) return actionButton;
      actionButton = document.createElement('button');
      actionButton.type='button';
      actionButton.className='long-image-selection-action';
      actionButton.innerHTML='<span class="long-image-selection-icon">↕</span><span>合成长图</span>';
      actionButton.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
      actionButton.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        if(!(await ensureEnabled())) return;
        createFromSelection();
      });
      document.body.appendChild(actionButton);
      return actionButton;
    }
    function updateActionButton(){
      const button = ensureActionButton();
      const count = selectedSourceItems().length;
      button.classList.toggle('visible', count >= 2);
      button.title = count >= 2 ? `把选中的 ${count} 张图片合成长图` : '至少选择 2 张图片';
    }
    function createFromSelection(){
      const items = selectedSourceItems();
      if(items.length < 2){ notify('至少选择 2 张有效图片'); return; }
      if(items.length > 100){ notify('单个长图最多包含 100 张图片'); return; }
      const ids = [...selected].filter(id => nodes.some(node => node.id === id));
      const box = ids.length ? nodeBounds(ids) : {x:0,y:0,w:260,h:220};
      pushUndo();
      const node = {
        id:Core.uid('long_image'), type:'image', x:Math.round(box.x + box.w + 64), y:Math.round(box.y),
        w:360, h:282, url:'', name:'长图', images:[], created_at:Date.now(),
        longImage:Core.createData(items)
      };
      nodes.push(node);
      selected.clear(); selected.add(node.id);
      render(); scheduleSave();
      void composeNode(node);
    }
    async function composeNode(node){
      if(!Core.isLongImage(node) || (node.longImage.items || []).length < 2) return;
      if(!(await ensureEnabled())) return;
      const request = Core.beginBuild(node);
      if(!request) return;
      const prior = activeRequests.get(node.id);
      prior?.abort?.();
      const controller = new AbortController();
      controller.requestId = request.requestId;
      activeRequests.set(node.id, controller);
      render(); scheduleSave();
      try {
        const response = await fetch('/api/plugins/long-image-node/compose', {
          method:'POST', headers:{'Content-Type':'application/json'}, signal:controller.signal,
          body:JSON.stringify(Core.composePayload(node, request))
        });
        if(!response.ok) throw new Error(await Core.responseError(response, '长图拼接失败'));
        const data = await response.json();
        const live = nodes.find(item => item.id === node.id);
        const active = activeRequests.get(node.id);
        if(!live || active?.requestId !== request.requestId || data.request_id !== request.requestId) return;
        if(!(await Core.pluginEnabled())) return;
        if(Core.applyComposeResult(live, data, 'classic')){
          render(); scheduleSave();
        }
      } catch(error){
        if(error?.name === 'AbortError') return;
        const live = nodes.find(item => item.id === node.id);
        if(live && activeRequests.get(node.id)?.requestId === request.requestId){
          Core.applyComposeError(live, error?.message || '长图拼接失败');
          render(); scheduleSave();
        }
      } finally {
        if(activeRequests.get(node.id)?.requestId === request.requestId) activeRequests.delete(node.id);
      }
    }
    async function mutate(node, callback, rebuild=true){
      if(!(await ensureEnabled())) return;
      pushUndo();
      callback();
      render(); scheduleSave();
      if(rebuild && (node.longImage.items || []).length >= 2) void composeNode(node);
    }
    function closeEditor(){
      editorNodeId='';
      editorOverlay?.remove();
      editorOverlay=null;
      document.removeEventListener('keydown', onEditorKeydown, true);
    }
    function onEditorKeydown(event){
      if(event.key === 'Escape'){
        event.preventDefault(); event.stopPropagation();
        closeEditor();
      }
    }
    function openEditor(nodeId){
      const node=nodes.find(item => item.id === nodeId);
      if(!Core.isLongImage(node)) return;
      editorNodeId=nodeId;
      if(!editorOverlay){
        editorOverlay=document.createElement('div');
        editorOverlay.className='long-image-editor-overlay';
        editorOverlay.addEventListener('pointerdown', event => event.stopPropagation());
        editorOverlay.addEventListener('mousedown', event => {
          if(event.target === editorOverlay){ event.preventDefault(); closeEditor(); }
          event.stopPropagation();
        });
        editorOverlay.addEventListener('click', event => event.stopPropagation());
        editorOverlay.addEventListener('wheel', event => event.stopPropagation(), {passive:true});
        document.body.appendChild(editorOverlay);
        document.addEventListener('keydown', onEditorKeydown, true);
      }
      syncEditor();
    }
    function syncEditor(){
      if(!editorNodeId || !editorOverlay) return;
      const node=nodes.find(item => item.id === editorNodeId);
      if(!Core.isLongImage(node)){ closeEditor(); return; }
      editorOverlay.innerHTML=Core.longImageEditorHtml(node, Core.isReady(node) ? node.url : '');
      editorOverlay.querySelector('[data-long-image-editor-close]')?.addEventListener('click', event => {
        event.preventDefault(); closeEditor();
      });
      bindEditorEvents(editorOverlay, node);
    }
    function bindEditorEvents(card, node){
      let pointerDrag = null;
      card.querySelectorAll('[data-long-image-download]').forEach(link => {
        link.addEventListener('pointerdown', event => event.stopPropagation());
        link.addEventListener('mousedown', event => event.stopPropagation());
        link.addEventListener('click', event => event.stopPropagation());
        link.addEventListener('dblclick', event => event.stopPropagation());
      });
      const clearDragClasses=() => card.querySelectorAll('.drop-before,.drop-after,.dragging').forEach(item => item.classList.remove('drop-before','drop-after','dragging'));
      card.querySelectorAll('[data-long-image-index]').forEach(row => {
        row.addEventListener('pointerdown', event => {
          if(event.button !== 0 || event.target.closest('button')) return;
          pointerDrag={pointerId:event.pointerId,from:Number(row.dataset.longImageIndex),startX:event.clientX,startY:event.clientY,moved:false,dropIndex:null,before:false,row};
          row.setPointerCapture?.(event.pointerId);
        });
        row.addEventListener('pointermove', event => {
          if(!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
          if(!pointerDrag.moved && Math.hypot(event.clientX-pointerDrag.startX,event.clientY-pointerDrag.startY) < 5) return;
          pointerDrag.moved=true;
          event.preventDefault(); event.stopPropagation();
          clearDragClasses(); pointerDrag.row.classList.add('dragging');
          const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-long-image-index]');
          if(!target || !card.contains(target)) { pointerDrag.dropIndex=null; return; }
          const rect=target.getBoundingClientRect();
          pointerDrag.dropIndex=Number(target.dataset.longImageIndex);
          pointerDrag.before=event.clientY < rect.top + rect.height / 2;
          target.classList.add(pointerDrag.before ? 'drop-before' : 'drop-after');
        });
        const finishPointerDrag=async event => {
          if(!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
          const state=pointerDrag; pointerDrag=null;
          state.row.releasePointerCapture?.(event.pointerId); clearDragClasses();
          if(!state.moved || state.dropIndex == null) return;
          const next=Core.moveItem(node.longImage.items || [], state.from, state.dropIndex + (state.before ? 0 : 1));
          if(Core.sameOrder(node.longImage.items || [], next)) return;
          await mutate(node, () => Core.markDirty(node, next));
        };
        row.addEventListener('pointerup', finishPointerDrag);
        row.addEventListener('pointercancel', event => {
          if(pointerDrag?.pointerId !== event.pointerId) return;
          pointerDrag=null; clearDragClasses();
        });
      });
      card.querySelectorAll('[data-long-image-remove]').forEach(button => {
        button.addEventListener('click', async event => {
          event.preventDefault(); event.stopPropagation();
          const index = Number(button.dataset.longImageRemove);
          const next = (node.longImage.items || []).filter((_, itemIndex) => itemIndex !== index);
          await mutate(node, () => Core.markDirty(node, next), next.length >= 2);
        });
      });
      const mode = card.querySelector('[data-long-image-width-mode]');
      const width = card.querySelector('[data-long-image-width]');
      const upscale = card.querySelector('[data-long-image-upscale]');
      const commitSettings=() => {
        const nextMode=mode?.value === 'custom' ? 'custom' : 'min-source';
        const nextWidth=Math.max(64, Math.min(8192, Math.round(Number(width?.value) || Number(node.longImage.targetWidth) || 1024)));
        const nextUpscale=Boolean(upscale?.checked);
        const changed=nextMode !== node.longImage.targetWidthMode
          || (nextMode === 'custom' && nextWidth !== Number(node.longImage.targetWidth))
          || nextUpscale !== Boolean(node.longImage.allowUpscale);
        if(!changed) return false;
        pushUndo();
        node.longImage.targetWidthMode=nextMode;
        node.longImage.targetWidth=nextWidth;
        node.longImage.allowUpscale=nextUpscale;
        Core.markDirty(node);
        if(width) width.disabled=nextMode !== 'custom';
        const status=card.querySelector('.long-image-meta span');
        if(status) status.textContent=`${(node.longImage.items || []).length} 张 · 待更新`;
        scheduleSave();
        return true;
      };
      mode?.addEventListener('change', commitSettings);
      width?.addEventListener('change', commitSettings);
      upscale?.addEventListener('change', commitSettings);
      card.querySelector('[data-long-image-build]')?.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        const settingsChanged=commitSettings();
        if(!(await ensureEnabled())) return;
        if(!settingsChanged && node.longImage.status === 'ready'){
          pushUndo(); Core.markDirty(node); render(); scheduleSave();
        }
        void composeNode(node);
      });
    }
    function bindLongImageEvents(el, node){
      const surface=el.querySelector('[data-long-image-canvas]');
      if(!surface) return;
      surface.querySelectorAll('[data-long-image-download]').forEach(link => {
        link.addEventListener('pointerdown', event => event.stopPropagation());
        link.addEventListener('mousedown', event => event.stopPropagation());
        link.addEventListener('click', event => event.stopPropagation());
        link.addEventListener('dblclick', event => event.stopPropagation());
      });
      const openFromEvent=event => {
        if(!surface.contains(event.target) || event.target.closest('[data-long-image-download]')) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        openEditor(node.id);
      };
      el.addEventListener('mousedown', event => {
        if(event.button === 0 && event.detail >= 2) openFromEvent(event);
      }, true);
      el.addEventListener('dblclick', openFromEvent, true);
    }
    function fitLongImageNode(node){
      const width=Math.max(320, Number(node.w) || 360);
      const desired=Core.nodeDisplayHeight(node, width, 42);
      if(Number(node.h) === desired) return false;
      node.h=desired;
      return true;
    }

    imageRefsFromNode = function(node){ return refsForNode(node); };
    renderNode = function(node){
      const el = original.renderNode(node);
      if(!Core.isLongImage(node)) return el;
      fitLongImageNode(node);
      el.classList.add('long-image-node');
      el.style.width=`${Number(node.w) || 360}px`;
      el.style.height=`${Number(node.h)}px`;
      const title = el.querySelector('.node-title');
      if(title) title.textContent = node.longImageTitle || '长图';
      const body = el.querySelector('.node-body');
      if(body){
        body.className='node-body long-image-node-body';
        body.innerHTML=Core.longImageCanvasHtml(node, Core.isReady(node) ? node.url : '');
      }
      bindLongImageEvents(el, node);
      return el;
    };
    render = function(){ const result = original.render(); updateActionButton(); syncEditor(); return result; };
    refreshSelectionVisuals = function(){ const result = original.refreshSelectionVisuals(); updateActionButton(); return result; };

    let recovered=false;
    let resized=false;
    nodes.forEach(node => {
      if(Core.isLongImage(node) && node.longImage.status === 'building'){
        node.longImage.status=(node.longImage.items || []).length >= 2 ? 'dirty' : 'incomplete';
        node.url=''; node.images=[]; recovered=true;
      }
      if(Core.isLongImage(node) && fitLongImageNode(node)) resized=true;
    });
    if(recovered || resized) scheduleSave();
    lifecycle.diagnostics={...lifecycle.diagnostics, status:'healthy', missing:[]};
    render();
    console.info('[long-image-node] classic adapter mounted');
  }
})();
