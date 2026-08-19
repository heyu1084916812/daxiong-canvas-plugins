(function(){
  if(globalThis.LocalPatchPlugin?.mounted) return;
  const lifecycle = {
    mounted:false,
    refreshRequired:false,
    mount(){ if(this.mounted) return; this.mounted=true; mountImplementation(); },
    unmount(){
      this.restoreWrappedFunctions?.();
      document.querySelectorAll('.local-patch-menu-card,.local-patch-compare-modal,.local-patch-image-toolbar').forEach(node=>node.remove());
      this.restoreWrappedFunctions=null; this.mounted=false; this.refreshRequired=true;
    }
  };
  globalThis.LocalPatchPlugin = lifecycle;
  lifecycle.mount();
  function mountImplementation(){
  const Core = globalThis.LocalPatchCore;
  const TYPE_MERGE = 'smart-seamless-merge';
  const MERGE_MIN_WIDTH = 230;
  const MERGE_MIN_HEIGHT = 280;
  const required = [
    typeof nodes !== 'undefined', typeof canvas !== 'undefined', typeof render === 'function',
    typeof createNodeFromMenu === 'function', typeof nodeBodyHtml === 'function',
    typeof imageLayout === 'function', typeof bindNodeEvents === 'function',
    typeof handlePortDrop === 'function', typeof createImageNodeAt === 'function',
    typeof imagesForNode === 'function', typeof smartNodeToolbarHtml === 'function',
    typeof runSmartNodeToolbarAction === 'function', typeof openImageEditor === 'function',
    typeof setImageEditMode === 'function', typeof applyImageEdit === 'function',
    typeof closeImageEditor === 'function', typeof finalizePendingNode === 'function',
    typeof finalizeSmartPendingTask === 'function', typeof appendImagesToSmartNode === 'function',
    typeof assetNodeImageFromItem === 'function', typeof uploadFiles === 'function',
    typeof importSmartLocalImages === 'function', typeof clearSelection === 'function',
    typeof syncSelectionUi === 'function', typeof updateComposer === 'function',
    typeof clearImageClickTimer === 'function'
  ];
  if(!Core || required.some(value => !value)){
    console.error('[local-patch] 智能画布接口不兼容，插件已安全禁用');
    return;
  }

  let smartExtractSession = null;
  const fingerprintJobs = new Map();
  const original = {
    createNodeFromMenu, imageLayout, nodeBodyHtml, render, bindNodeEvents,
    handlePortDrop, connectInputNode, refreshConnectionLayer,
    createImageNodeAt, createPendingOutputFromSource, replaceOutputsToNodeWithHistory, appendOutputsToNode,
    finalizePendingNode, finalizeSmartPendingTask, appendImagesToSmartNode,
    assetNodeImageFromItem, uploadFiles, importSmartLocalImages,
    smartNodeToolbarHtml, runSmartNodeToolbarAction, openImageEditor,
    setImageEditMode, applyImageEdit, closeImageEditor,
    previewCompareSources: typeof previewCompareSources === 'function' ? previewCompareSources : null,
    currentEditImage: typeof currentEditImage === 'function' ? currentEditImage : null
  };
  lifecycle.restoreWrappedFunctions = () => {
    Object.entries(original).forEach(([name, value]) => {
      if(typeof value === 'function') globalThis[name] = value;
    });
  };

  if(original.previewCompareSources && original.currentEditImage){
    previewCompareSources = function(){
      const coreSources = original.previewCompareSources();
      if(coreSources.length) return coreSources;
      const editing = original.currentEditImage();
      const refs = Array.isArray(editing.image?.runInputRefs) ? editing.image.runInputRefs : [];
      const originalUrl = editing.image?.localPatchComparisonOriginalUrl
        || editing.node?.localPatchComparisonOriginalUrl
        || '';
      const candidates = refs.length ? refs : (originalUrl ? [{url:originalUrl, kind:'image'}] : []);
      const resultUrl = editing.image?.url || '';
      const seen = new Set();
      return candidates.filter(item => {
        const url = String(item?.url || '');
        if(!url || url === resultUrl || seen.has(url)) return false;
        seen.add(url);
        return true;
      });
    };
  }

  function html(value){ return escapeHtml(String(value == null ? '' : value)); }
  function attr(value){ return escapeAttr(String(value == null ? '' : value)); }
  function isMerge(node){ return node?.type === TYPE_MERGE; }
  function pluginToast(message){ if(typeof toast === 'function') toast(message); else console.warn('[local-patch]', message); }
  async function parseError(response, fallback){
    try { const data = await response.json(); return data.detail || data.error || fallback; }
    catch(_error){ return fallback; }
  }
  function hasContextMetadata(item){ return Boolean(item?.cropContext || item?.cropContextConflict || Core.isContextBoundary(item)); }
  function contextRegistry(){
    canvas.localPatchContextRegistry = Core.createContextRegistry(canvas.localPatchContextRegistry);
    return canvas.localPatchContextRegistry;
  }
  function isFingerprintableUrl(url){
    const key = Core.normalizeContextUrl(url);
    return key.startsWith('/assets/') || key.startsWith('/output/');
  }
  async function fingerprintForUrl(url){
    const key = Core.normalizeContextUrl(url);
    if(!isFingerprintableUrl(key)) return '';
    const registry = contextRegistry();
    if(registry.urlFingerprints[key]) return registry.urlFingerprints[key];
    if(fingerprintJobs.has(key)) return fingerprintJobs.get(key);
    const job = fetch('/api/plugins/local-patch/fingerprint', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({source_url:key})
    }).then(async response => {
      if(!response.ok) return '';
      const data = await response.json();
      const digest = String(data.fingerprint || '').toLowerCase();
      if(digest) registry.urlFingerprints[key] = digest;
      return digest;
    }).catch(() => '').finally(() => fingerprintJobs.delete(key));
    fingerprintJobs.set(key, job);
    return job;
  }
  function rememberContextItem(item, fingerprint=''){
    if(!hasContextMetadata(item) || item?.role === 'mask') return false;
    const knownFingerprint = fingerprint || item.localPatchFingerprint || '';
    const changed = Core.rememberContextMetadata(contextRegistry(), item, knownFingerprint);
    if(!knownFingerprint) void fingerprintForUrl(item.url).then(digest => {
      if(!digest) return;
      item.localPatchFingerprint = digest;
      if(Core.rememberContextMetadata(contextRegistry(), item, digest)) scheduleSave();
    });
    return changed;
  }
  function rememberContextItems(items){
    let changed = false;
    (items || []).forEach(item => { if(rememberContextItem(item)) changed = true; });
    return changed;
  }
  function restoreContextItems(items){
    const registry = contextRegistry();
    return (items || []).map(item => Core.restoreContextMetadata(item, registry));
  }
  async function restoreContextItemsByFingerprint(items){
    const registry = contextRegistry();
    return Promise.all((items || []).map(async item => {
      let restored = Core.restoreContextMetadata(item, registry);
      if(hasContextMetadata(restored) || !isFingerprintableUrl(restored?.url)) return restored;
      const digest = await fingerprintForUrl(restored.url);
      if(digest) restored = Core.restoreContextMetadata(restored, registry, digest);
      if(hasContextMetadata(restored)){
        if(digest) restored.localPatchFingerprint = digest;
        rememberContextItem(restored, digest);
      }
      return restored;
    }));
  }
  function syncCanvasContextRegistry(){
    let changed = false;
    (nodes || []).forEach(node => {
      if(!Array.isArray(node?.images)) return;
      node.images = node.images.map(item => {
        const restored = Core.restoreContextMetadata(item, contextRegistry());
        if(!hasContextMetadata(item) && hasContextMetadata(restored)) changed = true;
        if(rememberContextItem(restored)) changed = true;
        if(!hasContextMetadata(restored) && isFingerprintableUrl(restored.url)) void fingerprintForUrl(restored.url).then(digest => {
          if(!digest || hasContextMetadata(restored)) return;
          const recovered = Core.restoreContextMetadata(restored, contextRegistry(), digest);
          if(!hasContextMetadata(recovered)) return;
          Object.assign(restored, recovered, {localPatchFingerprint:digest});
          rememberContextItem(restored, digest);
          scheduleSave();
          render();
        });
        return restored;
      });
    });
    if(changed) scheduleSave();
    return changed;
  }
  function selectedIndexForNode(node){
    return Core.resolveSelectedImageIndex(node?.images || [], selectedImage, node?.id || '');
  }
  function namedItems(node, port){
    return Core.namedInputItems(node.id, port, nodes, canvas?.connections || [], source => imagesForNode(source));
  }
  function portChoiceKey(port){ return port === 'original' ? 'localPatchOriginalImageIndex' : 'localPatchPatchImageIndex'; }
  function namedChoice(node, port){
    return Core.selectedNamedInputItem(node.id, port, nodes, canvas?.connections || [], source => imagesForNode(source), node?.[portChoiceKey(port)] || 0);
  }
  function namedPatchChoices(node){
    node.localPatchPatchChoices = node.localPatchPatchChoices && typeof node.localPatchPatchChoices === 'object' ? node.localPatchPatchChoices : {};
    const choices = Core.namedInputSelections(node.id, 'patch', nodes, canvas?.connections || [], source => imagesForNode(source), node.localPatchPatchChoices);
    choices.forEach(choice => { node.localPatchPatchChoices[choice.connectionKey] = choice.index; });
    return choices;
  }

  function installEditorExtractMode(){
    const modes = document.querySelector('#imageEditModal .image-edit-mode');
    if(!modes || modes.querySelector('[data-local-patch-extract-mode]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.localPatchExtractMode = '1';
    button.innerHTML = '<i data-lucide="scan" class="w-3.5 h-3.5"></i><span>提取选区</span>';
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      const nodeId = cropState?.nodeId || selectedImage?.nodeId || '';
      const imageIndex = Number(cropState?.imageIndex ?? selectedImage?.index ?? 0);
      beginSmartExtract(nodeId, imageIndex, true);
    });
    const cropButton = modes.querySelector('[data-image-edit-mode="crop"]');
    cropButton?.insertAdjacentElement('afterend', button);
    if(!cropButton) modes.appendChild(button);
    refreshIcons();
  }
  function updateSmartExtractEditorUi(){
    installEditorExtractMode();
    const button = document.querySelector('[data-local-patch-extract-mode]');
    button?.classList.toggle('active', Boolean(smartExtractSession));
    if(!smartExtractSession) return;
    document.querySelector('[data-image-edit-mode="crop"]')?.classList.remove('active');
    const apply = document.getElementById('imageEditApplyBtn');
    if(apply) apply.innerHTML = '<i data-lucide="scan" class="w-4 h-4"></i><span>提取选区</span>';
    const title = document.getElementById('imageEditTitle');
    const sub = document.getElementById('imageEditSub');
    if(title) title.textContent = '提取选区';
    if(sub) sub.textContent = '框选需要处理的区域，插件会自动保留周围上下文';
    refreshIcons();
  }
  function clearSmartExtractSession(){
    smartExtractSession = null;
    document.querySelector('[data-local-patch-extract-mode]')?.classList.remove('active');
  }
  function beginSmartExtract(nodeId, imageIndex=0, editorAlreadyOpen=false){
    const node = nodes.find(item => item.id === nodeId);
    const raw = node?.images?.[imageIndex];
    const item = imageForDisplay(raw);
    if(!node || !item?.url || mediaKindForItem(item) !== 'image'){
      pluginToast('请选择一张可编辑的图片');
      return;
    }
    if(!editorAlreadyOpen || !imageEditModal.classList.contains('open')) original.openImageEditor(node.id, Number(imageIndex) || 0);
    smartExtractSession = {nodeId:node.id, imageIndex:Number(imageIndex) || 0};
    selectedId = node.id; selectedIds = []; selectedImage = {nodeId:node.id, index:Number(imageIndex) || 0};
    setImageEditMode('crop', true);
    updateSmartExtractEditorUi();
  }
  async function applySmartExtract(){
    const session = smartExtractSession;
    const node = nodes.find(item => item.id === session?.nodeId);
    const source = node?.images?.[session?.imageIndex];
    const image = document.getElementById('cropImage');
    const bounds = cropBounds();
    if(!node || !source?.url || !cropState || !image?.naturalWidth || !bounds.w) throw new Error('选区尚未准备好');
    const naturalWidth = Number(source.natural_w || source.width || image.naturalWidth);
    const naturalHeight = Number(source.natural_h || source.height || image.naturalHeight);
    const selection = Core.displaySelectionToNatural(cropState, {
      displayWidth:bounds.w, displayHeight:bounds.h,
      naturalWidth, naturalHeight
    });
    const response = await fetch('/api/plugins/local-patch/crop', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        source_url:source.url,
        selection:{x:selection.x,y:selection.y,w:selection.w,h:selection.h,source_width:selection.sourceWidth,source_height:selection.sourceHeight},
        padding_ratio:0.1
      })
    });
    if(!response.ok) throw new Error(await parseError(response, '提取选区失败'));
    const data = await response.json();
    const rect = nodeRect(node);
    pushUndo();
    const output = createImageNodeAt({x:rect.x + rect.width + 210, y:rect.y + rect.height / 2}, [{
      ...data.file,
      cropContext:data.file.cropContext,
      cropContextConflict:false,
      kind:'image'
    }], {select:true, skipUndo:true});
    addConnection(node.id, output.id, 'flow');
    selectedIds = []; selectedImage = {nodeId:output.id, index:0};
    clearSmartExtractSession();
    original.closeImageEditor();
    render(); scheduleSave(); pluginToast('已提取选区并保留上下文');
  }

  smartNodeToolbarHtml = function(node){
    const base = original.smartNodeToolbarHtml(node);
    if(!base || !imagesForNode(node).some(item => item?.url && mediaKindForItem(item) === 'image')) return base;
    if(base.includes('data-smart-node-action="extract"')) return base;
    const button = `<button type="button" data-smart-node-action="extract" data-node-id="${attr(node.id)}" title="提取选区"><i data-lucide="scan"></i><span>提取选区</span></button>`;
    const marker = '<button type="button" data-smart-node-action="download"';
    return base.includes(marker) ? base.replace(marker, `${button}${marker}`) : base.replace('</div>', `${button}</div>`);
  };
  runSmartNodeToolbarAction = function(nodeId, action){
    if(action === 'extract'){
      const node = nodes.find(item => item.id === nodeId);
      return beginSmartExtract(nodeId, selectedIndexForNode(node));
    }
    return original.runSmartNodeToolbarAction(nodeId, action);
  };
  function installBlankSelectionClear(){
    if(shell.dataset.localPatchBlankSelectionClear === '1') return;
    shell.dataset.localPatchBlankSelectionClear = '1';
    const uiSelector = '.composer,.smart-back,.asset-panel,.asset-toggle,.smart-log-toggle,.smart-shortcut-toggle,.smart-workflow-toggle,.log-modal,.shortcut-modal,.image-edit-modal,.create-menu,.smart-minimap';
    shell.addEventListener('mousedown', event => {
      const target = event.target;
      const editorOpen = Boolean(document.getElementById('imageEditModal')?.classList.contains('open') || (typeof zoomPreviewState !== 'undefined' && zoomPreviewState));
      const blankState = {
        button:event.button,
        insideNode:Boolean(target?.closest?.('.image-node')),
        insideUi:Boolean(target?.closest?.(uiSelector)),
        editorOpen
      };
      if(!Core.shouldClearSmartSelection(blankState)) return;
      clearImageClickTimer();
      const staleSelected = [...world.querySelectorAll('.image-node.selected')];
      if(!selectedId && !(selectedIds || []).length && !staleSelected.length) return;
      clearSelection();
      syncSelectionUi();
      staleSelected.forEach(element => element.classList.remove('selected'));
      world.querySelectorAll('.image-selected').forEach(element => element.classList.remove('image-selected'));
      world.classList.remove('smart-multi-selected');
      updateComposer();
    }, true);
  }
  setImageEditMode = function(mode, userTouched=false){
    if(smartExtractSession && mode !== 'crop') clearSmartExtractSession();
    const value = original.setImageEditMode(mode, userTouched);
    updateSmartExtractEditorUi();
    return value;
  };
  applyImageEdit = function(){
    if(!smartExtractSession) return original.applyImageEdit();
    return applySmartExtract().catch(error => pluginToast(String(error?.message || error || '提取选区失败')));
  };
  closeImageEditor = function(){
    clearSmartExtractSession();
    return original.closeImageEditor();
  };

  function createMergeNode(point){
    const node = {
      id:uid('seamless_merge'), type:TYPE_MERGE, title:'图像融合',
      x:Math.round(point.x - 135), y:Math.round(point.y - 165), w:270, h:330,
      colorMatch:true, featherMode:'smoothstep', status:'idle', error:'',
      lastOutputNodeId:'', images:[], created_at:Date.now()
    };
    pushUndo(); nodes.push(node); selectedId = node.id; selectedIds = [];
    selectedImage = {nodeId:'', index:-1}; render(); scheduleSave();
    return node;
  }
  function installMenuCard(){
    const grid = createMenu?.querySelector('.create-menu-grid');
    if(!grid || grid.querySelector('[data-create-type="seamless-merge"]')) return;
    grid.insertAdjacentHTML('beforeend', `
      <button class="create-card" type="button" data-create-type="seamless-merge">
        <span class="create-card-icon"><i data-lucide="blend"></i></span>
        <span><div class="create-card-title">图像融合</div><div class="create-card-sub">将处理后的局部图融合回原图</div></span>
      </button>`);
    refreshIcons();
  }
  createNodeFromMenu = function(type){
    if(type === 'seamless-merge'){
      const point = createMenuPoint || viewportCenter(); closeCreateMenu(); return createMergeNode(point);
    }
    return original.createNodeFromMenu(type);
  };
  imageLayout = function(images, scale=1, node=null){
    if(isMerge(node)) return {cols:1,rows:1,width:Number(node.w)||270,height:Number(node.h)||330,thumb:96,single:true};
    return original.imageLayout(images, scale, node);
  };

  function previewUrl(item){ return item?.url ? smartMediaPreviewUrl(item, 512) : ''; }
  function mergePreview(originalItem, patchItem){
    if(!originalItem?.url && !patchItem?.url){
      return '<div class="local-patch-merge-empty"><i data-lucide="image"></i><span>连接原图 + 局部生成结果</span></div>';
    }
    return `<div class="local-patch-merge-images">${originalItem?.url ? `<div><img src="${attr(previewUrl(originalItem))}" alt="原图"><span>原图</span></div>` : '<div class="missing"><i data-lucide="image"></i><span>原图</span></div>'}${patchItem?.url ? `<div><img src="${attr(previewUrl(patchItem))}" alt="局部修改"><span>局部</span></div>` : '<div class="missing"><i data-lucide="image"></i><span>局部</span></div>'}</div>`;
  }
  function mergeChip(label, connected, conflict=false){
    return `<span class="local-patch-merge-chip ${connected ? 'connected' : ''} ${conflict ? 'conflict' : ''}"><i data-lucide="${connected ? (conflict ? 'triangle-alert' : 'check') : 'circle'}"></i>${html(connected ? label : `未连接${label}`)}</span>`;
  }
  function mergeBody(node){
    const originals = namedItems(node, 'original');
    const patches = namedItems(node, 'patch');
    const originalItem = originals.length === 1 ? originals[0] : null;
    const patchItem = patches.length === 1 ? patches[0] : null;
    const conflict = Boolean(patchItem?.cropContextConflict);
    return `<div class="local-patch-body local-patch-merge-card">
      <div class="local-patch-merge-preview">${mergePreview(originalItem, patchItem)}</div>
      <div class="local-patch-merge-chips">${mergeChip('原图',Boolean(originalItem))}${mergeChip('局部修改',Boolean(patchItem),conflict)}</div>
      ${node.error ? `<div class="local-patch-error">${html(node.error)}</div>` : ''}
      <button class="local-patch-merge-run" type="button" data-local-patch-action="merge" data-node-id="${attr(node.id)}" ${node.status === 'running' ? 'disabled' : ''}><i data-lucide="blend"></i><span>${node.status === 'running' ? '融合中…' : '开始融合'}</span></button>
    </div>`;
  }
  function mergeChoiceButtons(port, choice){
    if(choice.items.length <= 1) return '';
    return `<div class="local-patch-choice" data-local-patch-choice="${port}">
      <button type="button" data-local-patch-pick="-1" data-port="${port}" title="上一张"><i data-lucide="chevron-left"></i></button>
      <span>${choice.index + 1} / ${choice.items.length}</span>
      <button type="button" data-local-patch-pick="1" data-port="${port}" title="下一张"><i data-lucide="chevron-right"></i></button>
    </div>`;
  }
  function mergePreviewPane(label, port, choice){
    const item = choice.item;
    return `<div class="local-patch-preview-pane ${item?.url ? '' : 'missing'}">
      ${item?.url ? `<img src="${attr(previewUrl(item))}" alt="${attr(label)}">` : '<i data-lucide="image"></i>'}
      <span class="local-patch-preview-label">${html(label)}</span>
      ${mergeChoiceButtons(port, choice)}
    </div>`;
  }
  function mergeBodyV2(node){
    const originalChoice = namedChoice(node, 'original');
    const patchChoice = namedChoice(node, 'patch');
    node.localPatchOriginalImageIndex = originalChoice.index;
    node.localPatchPatchImageIndex = patchChoice.index;
    const conflict = Boolean(patchChoice.item?.cropContextConflict);
    return `<div class="local-patch-body local-patch-merge-card">
      <div class="local-patch-merge-preview">${mergePreviewPane('原图', 'original', originalChoice)}${mergePreviewPane('局部修改', 'patch', patchChoice)}</div>
      <div class="local-patch-merge-chips">${mergeChip('原图',Boolean(originalChoice.item))}${mergeChip('局部修改',Boolean(patchChoice.item),conflict)}</div>
      ${node.error ? `<div class="local-patch-error">${html(node.error)}</div>` : ''}
      <div class="local-patch-merge-options"><label><input type="checkbox" data-local-patch-color ${node.colorMatch !== false ? 'checked' : ''}>颜色匹配</label></div>
      <button class="local-patch-merge-run" type="button" data-local-patch-action="merge" data-node-id="${attr(node.id)}" ${node.status === 'running' ? 'disabled' : ''}><i data-lucide="blend"></i><span>${node.status === 'running' ? '融合中…' : '开始融合'}</span></button>
    </div>`;
  }
  function mergePatchPane(choice, index){
    const item = choice.item;
    const controls = choice.items.length > 1 ? `<div class="local-patch-choice" data-local-patch-choice="patch" data-connection-key="${attr(choice.connectionKey)}">
      <button type="button" data-local-patch-pick="-1" data-port="patch" data-connection-key="${attr(choice.connectionKey)}"><i data-lucide="chevron-left"></i></button>
      <span>${choice.index + 1} / ${choice.items.length}</span>
      <button type="button" data-local-patch-pick="1" data-port="patch" data-connection-key="${attr(choice.connectionKey)}"><i data-lucide="chevron-right"></i></button>
    </div>` : '';
    return `<div class="local-patch-preview-pane ${item?.url ? '' : 'missing'}">
      ${item?.url ? `<img src="${attr(previewUrl(item))}" alt="局部 ${index + 1}">` : '<i data-lucide="image"></i>'}
      <span class="local-patch-preview-label">局部 ${index + 1}</span>${controls}
    </div>`;
  }
  function mergeBodyMulti(node){
    const originalChoice = namedChoice(node, 'original');
    const patchChoices = namedPatchChoices(node);
    node.localPatchOriginalImageIndex = originalChoice.index;
    if(patchChoices.length === 1) node.localPatchPatchImageIndex = patchChoices[0].index;
    const invalid = patchChoices.some(choice => choice.item?.cropContextConflict || !choice.item?.cropContext);
    const patchPanes = patchChoices.length ? patchChoices.map(mergePatchPane).join('') : '<div class="local-patch-preview-pane missing"><i data-lucide="image"></i><span class="local-patch-preview-label">局部修改</span></div>';
    return `<div class="local-patch-body local-patch-merge-card">
      <div class="local-patch-merge-preview local-patch-multi-preview">${mergePreviewPane('原图','original',originalChoice)}<div class="local-patch-patch-list">${patchPanes}</div></div>
      <div class="local-patch-merge-chips">${mergeChip('原图',Boolean(originalChoice.item))}${mergeChip(`局部修改 ${patchChoices.length} 张`,Boolean(patchChoices.length),invalid)}</div>
      ${node.error ? `<div class="local-patch-error">${html(node.error)}</div>` : ''}
      <div class="local-patch-merge-options"><label><input type="checkbox" data-local-patch-color ${node.colorMatch !== false ? 'checked' : ''}>颜色匹配</label></div>
      <button class="local-patch-merge-run" type="button" data-local-patch-action="merge" data-node-id="${attr(node.id)}" ${node.status === 'running' ? 'disabled' : ''}><i data-lucide="blend"></i><span>${node.status === 'running' ? '融合中…' : '开始融合'}</span></button>
    </div>`;
  }
  nodeBodyHtml = function(node, layout){ return isMerge(node) ? mergeBodyMulti(node) : original.nodeBodyHtml(node, layout); };

  function namedPortWorldPoint(node, port){
    const element = world.querySelector(`.image-node[data-id="${CSS.escape(node.id)}"]`);
    const selector = port === 'patch'
      ? ':scope > .local-patch-merge-patch-port'
      : ':scope > .local-patch-merge-original-port';
    const edgePort = element?.querySelector(selector);
    if(edgePort){
      const portRect = edgePort.getBoundingClientRect();
      return screenToWorld({
        clientX:portRect.left + portRect.width / 2,
        clientY:portRect.top + portRect.height / 2
      });
    }
    const rect = nodeRect(node);
    return port === 'patch'
      ? {x:rect.x + rect.width, y:rect.y + rect.height / 2}
      : {x:rect.x, y:rect.y + rect.height / 2};
  }
  function adjustNamedConnectionPaths(){
    const svg = world.querySelector('svg.connection-layer');
    if(!svg) return;
    (canvas?.connections || []).forEach((conn,index) => {
      if(!conn.targetPort) return;
      const from = nodes.find(node => node.id === conn.from);
      const to = nodes.find(node => node.id === conn.to);
      if(!from || !isMerge(to)) return;
      const fromRect = nodeRect(from);
      const start = {x:fromRect.x + fromRect.width, y:fromRect.y + fromRect.height/2};
      const end = namedPortWorldPoint(to, conn.targetPort);
      const direction = end.x >= start.x ? 1 : -1;
      const dx = Math.max(50, Math.abs(end.x-start.x)*.45);
      const curve = `M${start.x} ${start.y} C ${start.x+dx*direction} ${start.y}, ${end.x-dx*direction} ${end.y}, ${end.x} ${end.y}`;
      const hit = svg.querySelector(`.conn-hit[data-conn-index="${index}"]`);
      const visible = hit?.previousElementSibling;
      visible?.setAttribute('d',curve); hit?.setAttribute('d',curve);
      const endpoint = svg.querySelector(`.conn-end[data-conn-index="${index}"]`);
      endpoint?.setAttribute('cx', String(end.x)); endpoint?.setAttribute('cy', String(end.y));
      const cut = svg.querySelector(`.conn-cut[data-conn-index="${index}"]`);
      cut?.setAttribute('transform', `translate(${(start.x + end.x) / 2} ${(start.y + end.y) / 2})`);
    });
  }
  function normalizeMergeNodeSizes(){
    return nodes.filter(isMerge).some(node => Core.clampNodeSize(node, MERGE_MIN_WIDTH, MERGE_MIN_HEIGHT));
  }
  function ensureMergeResizeHandle(element, node){
    let handle = element.querySelector('.node-resize-handle');
    if(!handle){
      handle = document.createElement('div');
      handle.className = 'node-resize-handle';
      handle.dataset.resize = '1';
      element.appendChild(handle);
    }
    if(handle.dataset.localPatchBound === '1') return;
    handle.dataset.localPatchBound = '1';
    handle.addEventListener('mousedown', event => {
      if(event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const rect = nodeRect(node);
      resizeState = {id:node.id, startX:event.clientX, startY:event.clientY, startW:rect.width, startH:rect.height};
      document.body.classList.add('smart-node-resize');
      capturePendingUndo();
    });
  }
  function ensureMergeEdgePorts(element){
    element.querySelectorAll('.local-patch-port').forEach(port => port.remove());
    element.insertAdjacentHTML('beforeend', `<div class="local-patch-port node-port port-in local-patch-merge-original-port" data-port="in" data-target-port="original" title="连接原图"></div>
      <div class="local-patch-port node-port port-in local-patch-merge-patch-port" data-port="in" data-target-port="patch" title="连接局部修改"></div>`);
  }
  function decorateMergeNodes(){
    nodes.filter(isMerge).forEach(node => {
      const element = world.querySelector(`.image-node[data-id="${CSS.escape(node.id)}"]`);
      if(!element) return;
      element.classList.add('local-patch-node','seamless-merge-node');
      ensureMergeEdgePorts(element);
      bindCustomPortStart(element,node);
      ensureMergeResizeHandle(element, node);
      const title = element.querySelector('.node-title'); if(title) title.textContent = '图像融合';
    });
    adjustNamedConnectionPaths();
  }
  render = function(){
    syncCanvasContextRegistry();
    const sizeChanged = normalizeMergeNodeSizes();
    const value = original.render();
    installMenuCard(); installEditorExtractMode(); decorateMergeNodes();
    if(sizeChanged) scheduleSave();
    return value;
  };
  refreshConnectionLayer = function(){ const value=original.refreshConnectionLayer();adjustNamedConnectionPaths();return value; };

  function connectNamedInput(fromId,toId,targetPort){
    const source=nodes.find(node=>node.id===fromId),target=nodes.find(node=>node.id===toId);
    if(!source||!isMerge(target)||!['original','patch'].includes(targetPort)||!imagesForNode(source).some(item=>item?.url))return false;
    const connection={id:`lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,from:fromId,to:toId,kind:'input',targetPort};
    canvas.connections=Core.setNamedConnection(canvas.connections||[],connection,{allowMultiple:targetPort==='patch'});
    target.inputNodeIds=Array.from(new Set((canvas.connections||[]).filter(conn=>conn.to===toId&&conn.targetPort).map(conn=>conn.from)));
    target.error='';
    if(targetPort==='patch'){
      target.localPatchPatchChoices=target.localPatchPatchChoices&&typeof target.localPatchPatchChoices==='object'?target.localPatchPatchChoices:{};
      target.localPatchPatchChoices[connection.id]=0;
    }else target[portChoiceKey(targetPort)]=0;
    return true;
  }
  connectInputNode=function(fromId,toId){return isMerge(nodes.find(node=>node.id===toId))?false:original.connectInputNode(fromId,toId);};
  handlePortDrop=function(drag,event){
    const hit=document.elementFromPoint(event.clientX,event.clientY),port=hit?.closest?.('.node-port'),targetElement=port?.closest?.('.image-node');
    const targetId=targetElement?.dataset?.id||'',namedTargetPort=port?.dataset?.targetPort||'';
    let fromId='',toId='',targetPort='';
    if(drag.fromPort==='out'&&targetId&&namedTargetPort){fromId=drag.fromId;toId=targetId;targetPort=namedTargetPort;}
    else if(drag.fromPort==='in'&&drag.targetPort&&targetId){fromId=targetId;toId=drag.fromId;targetPort=drag.targetPort;}
    if(targetPort){
      if(connectNamedInput(fromId,toId,targetPort)){commitPendingUndo();render();scheduleSave();}
      else{discardPendingUndo();render();pluginToast('该端口仅接受单张图片节点');}
      return;
    }
    return original.handlePortDrop(drag,event);
  };
  function bindCustomPortStart(element,node){
    element.querySelectorAll('.local-patch-port').forEach(port=>port.addEventListener('mousedown',event=>{
      if(event.button!==0)return;event.preventDefault();event.stopImmediatePropagation();
      portDragState={fromId:node.id,fromPort:'in',targetPort:port.dataset.targetPort,currentWorld:screenToWorld(event),hoverTargetId:'',hoverPort:'',moved:false};
      shell.classList.add('port-dragging');capturePendingUndo();ensurePortDragPathElement();updatePortDragVisual();
    },true));
  }
  function resultPosition(node, output=null){
    const sourceRect = nodeRect(node);
    if(output) return Core.rightSidePlacement(sourceRect, nodeRect(output), 120);
    return {x:sourceRect.x+sourceRect.width+120,y:sourceRect.y+sourceRect.height/2};
  }
  async function runMergeV2(node){
    const originalChoice=namedChoice(node,'original'),patchChoice=namedChoice(node,'patch');
    const originalItem=originalChoice.item,patch=patchChoice.item;
    if(!originalItem||!patch)throw new Error('请分别连接原图和局部修改图；多图节点可在融合节点内切换选择');
    if(patch.role==='mask')throw new Error('遮罩图不能作为局部修改图');
    if(patch.cropContextConflict)throw new Error('局部修改图包含多个冲突的裁剪上下文');
    if(!patch.cropContext)throw new Error('局部修改图缺少上下文，请重新提取选区或确认中间处理节点保留了上下文');
    node.status='running';node.error='';render();
    const response=await fetch('/api/plugins/local-patch/merge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({original_url:originalItem.url,patch_url:patch.url,crop_context:patch.cropContext,color_match:node.colorMatch!==false,feather_mode:node.featherMode||'smoothstep'})});
    if(!response.ok)throw new Error(await parseError(response,'图像融合失败'));
    const data=await response.json();pushUndo();
    const output=createImageNodeAt(resultPosition(node),[{
      ...data.file,kind:'image',runInputRefs:[originalItem],
      localPatchComparisonOriginalUrl:originalItem.url,
      localPatchComparisonResultUrl:data.file.url
    }],{skipUndo:true,select:false});
    Object.assign(output, resultPosition(node, output));
    output.runInputRefs=[originalItem];
    output.localPatchComparisonOriginalUrl=originalItem.url;
    output.localPatchComparisonResultUrl=data.file.url;
    addConnection(node.id,output.id,'flow');
    node.lastOutputNodeId=output.id;node.comparisonOriginalUrl=originalItem.url;node.comparisonResultUrl=data.file.url;
    node.status='success';node.error='';render();scheduleSave();
  }
  async function runMergeMulti(node){
    const originalItem = namedChoice(node,'original').item;
    const patchChoices = namedPatchChoices(node);
    if(!originalItem || !patchChoices.length) throw new Error('请连接一张完整原图和至少一张局部修改图');
    const patches = patchChoices.map((choice,index) => {
      const patch = choice.item;
      if(patch.role === 'mask') throw new Error(`第 ${index + 1} 张局部图是遮罩图，不能融合`);
      if(patch.cropContextConflict) throw new Error(`第 ${index + 1} 张局部图包含冲突的裁剪上下文`);
      if(!patch.cropContext) throw new Error(`第 ${index + 1} 张局部图缺少上下文，请重新提取选区`);
      return {patch_url:patch.url,crop_context:patch.cropContext};
    });
    node.status='running';node.error='';render();
    const response=await fetch('/api/plugins/local-patch/merge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      original_url:originalItem.url,patches,color_match:node.colorMatch!==false,feather_mode:node.featherMode||'smoothstep'
    })});
    if(!response.ok)throw new Error(await parseError(response,'图像融合失败'));
    const data=await response.json();pushUndo();
    const fullImage={...data.file,kind:'image',localPatchFullImage:true,localPatchContextReset:true,runInputRefs:[originalItem],localPatchComparisonOriginalUrl:originalItem.url,localPatchComparisonResultUrl:data.file.url};
    delete fullImage.cropContext;delete fullImage.cropContextConflict;
    rememberContextItem(fullImage);
    const output=createImageNodeAt(resultPosition(node),[fullImage],{skipUndo:true,select:false});
    Object.assign(output,resultPosition(node,output),{localPatchFullImage:true,localPatchContextReset:true,runInputRefs:[originalItem],localPatchComparisonOriginalUrl:originalItem.url,localPatchComparisonResultUrl:data.file.url});
    delete output.cropContext;delete output.cropContextConflict;
    addConnection(node.id,output.id,'flow');
    node.lastOutputNodeId=output.id;node.comparisonOriginalUrl=originalItem.url;node.comparisonResultUrl=data.file.url;
    node.status='success';node.error='';render();scheduleSave();
  }
  const runMerge = runMergeMulti;
  async function runMergeLegacy(node){
    const originals=namedItems(node,'original'),patches=namedItems(node,'patch');
    if(originals.length!==1||patches.length!==1)throw new Error('请分别连接一张原图和一张局部修改图');
    const patch=patches[0];
    if(patch.role==='mask')throw new Error('遮罩图片不能作为局部修改图');
    if(patch.cropContextConflict)throw new Error('局部修改图包含多个冲突的裁剪上下文');
    if(!patch.cropContext)throw new Error('局部修改图缺少上下文，请重新提取选区或确认中间处理节点保留了上下文');
    node.status='running';node.error='';render();
    const response=await fetch('/api/plugins/local-patch/merge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({original_url:originals[0].url,patch_url:patch.url,crop_context:patch.cropContext,color_match:node.colorMatch!==false,feather_mode:node.featherMode||'smoothstep'})});
    if(!response.ok)throw new Error(await parseError(response,'无缝融合失败'));
    const data=await response.json();pushUndo();
    const output=createImageNodeAt(resultPosition(node),[{...data.file,kind:'image'}],{skipUndo:true,select:false});
    addConnection(node.id,output.id,'flow');node.lastOutputNodeId=output.id;node.status='success';node.error='';render();scheduleSave();
  }
  bindNodeEvents=function(){
    const value=original.bindNodeEvents();
    world.querySelectorAll('.image-node').forEach(element=>{
      const node=nodes.find(candidate=>candidate.id===element.dataset.id);if(!isMerge(node))return;
      ensureMergeEdgePorts(element);
      bindCustomPortStart(element,node);
      element.querySelector('[data-local-patch-color]')?.addEventListener('change',event=>{node.colorMatch=event.target.checked;scheduleSave();});
      element.querySelectorAll('[data-local-patch-pick]').forEach(button=>button.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        const port=button.dataset.port,connectionKey=button.dataset.connectionKey||'';
        if(port==='patch'&&connectionKey){
          const choice=namedPatchChoices(node).find(item=>item.connectionKey===connectionKey);if(!choice)return;
          node.localPatchPatchChoices[connectionKey]=Core.resolveImageChoice(choice.items,choice.index+Number(button.dataset.localPatchPick||0)).index;
        }else{
          const choice=namedChoice(node,port);
          node[portChoiceKey(port)]=Core.resolveImageChoice(choice.items,choice.index+Number(button.dataset.localPatchPick||0)).index;
        }
        node.status='idle';node.error='';render();scheduleSave();
      }));
      element.querySelectorAll('[data-local-patch-action="merge"]').forEach(button=>button.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        runMerge(node).catch(error=>{node.status='error';node.error=String(error?.message||error||'融合失败');render();scheduleSave();});
      }));
    });
    return value;
  };

  function upstreamContextItems(nodeId){
    const queue=[{id:nodeId,depth:0}],seen=new Set(),items=[];
    while(queue.length){
      const current=queue.shift();if(!current.id||seen.has(current.id)||current.depth>12)continue;seen.add(current.id);
      const node=nodes.find(candidate=>candidate.id===current.id);
      const refs=node?imagesForNode(node):[];
      if(refs.some(item=>Core.isContextBoundary(item))||Core.isContextBoundary(node))continue;
      refs.forEach(item=>{if(item?.cropContext||item?.cropContextConflict)items.push(item);});
      (canvas?.connections||[]).filter(conn=>conn.to===current.id).forEach(conn=>queue.push({id:conn.from,depth:current.depth+1}));
    }
    return items;
  }
  function nodeContextInputs(node){
    const inputs=upstreamContextItems(node?.id);
    if(node?.localPatchPendingContextConflict)inputs.push({cropContextConflict:true});
    else if(node?.localPatchPendingContext)inputs.push({cropContext:node.localPatchPendingContext});
    if(!inputs.length&&node?.localPatchSourceNodeId)inputs.push(...upstreamContextItems(node.localPatchSourceNodeId));
    return inputs;
  }
  function inheritOutputs(node,additions){
    const restored=restoreContextItems(additions);
    const inputs=nodeContextInputs(node);
    const inherited=inputs.length?Core.applyInheritedContext(restored,inputs):restored;
    rememberContextItems(inherited);
    return inherited;
  }
  function applyInheritedContextToNode(node){
    if(!node||!Array.isArray(node.images))return [];
    node.images=inheritOutputs(node,node.images);
    delete node.localPatchPendingContext;
    delete node.localPatchPendingContextConflict;
    delete node.localPatchSourceNodeId;
    rememberContextItems(node.images);
    return node.images;
  }
  createImageNodeAt = function(point,images=[],options={}){
    const node=original.createImageNodeAt(point,restoreContextItems(images),options);
    if(node)rememberContextItems(node.images||[]);
    return node;
  };
  appendImagesToSmartNode = function(uploaded,targetId='',options={}){
    const node=original.appendImagesToSmartNode(restoreContextItems(uploaded),targetId,options);
    if(node)rememberContextItems(node.images||[]);
    return node;
  };
  assetNodeImageFromItem = function(item,fallbackName='asset'){
    return Core.restoreContextMetadata(original.assetNodeImageFromItem(item,fallbackName),contextRegistry());
  };
  uploadFiles = async function(files){
    return restoreContextItemsByFingerprint(await original.uploadFiles(files));
  };
  importSmartLocalImages = async function(paths){
    return restoreContextItemsByFingerprint(await original.importSmartLocalImages(paths));
  };
  createPendingOutputFromSource = function(sourceNode,expectedCount,meta,options={}){
    const output=original.createPendingOutputFromSource(sourceNode,expectedCount,meta,options);
    if(!output)return output;
    output.localPatchSourceNodeId=sourceNode?.id||'';
    const inherited=Core.resolveInheritedCropContext(upstreamContextItems(sourceNode?.id));
    if(inherited.conflict)output.localPatchPendingContextConflict=true;
    else if(inherited.context)output.localPatchPendingContext=inherited.context;
    return output;
  };
  finalizePendingNode = function(pendingNode,urls,meta,kind='image'){
    const value=original.finalizePendingNode(pendingNode,urls,meta,kind);
    applyInheritedContextToNode(pendingNode);
    return value;
  };
  finalizeSmartPendingTask = function(node,taskId,images,kind='image'){
    const value=original.finalizeSmartPendingTask(node,taskId,images,kind);
    applyInheritedContextToNode(node);
    return value;
  };
  replaceOutputsToNodeWithHistory = function(node,additions,kind='image',meta=null,options={}){
    const value=original.replaceOutputsToNodeWithHistory(node,inheritOutputs(node,additions),kind,meta,options);
    if(node)rememberContextItems(node.images||[]);
    return value;
  };
  appendOutputsToNode = function(node,additions,kind='image',options={}){
    const value=original.appendOutputsToNode(node,inheritOutputs(node,additions),kind,options);
    if(node)rememberContextItems(node.images||[]);
    return value;
  };

  installMenuCard();installEditorExtractMode();installBlankSelectionClear();render();console.info('[local-patch] smart canvas plugin 2.7.2 loaded and mounted');
  }
})();
