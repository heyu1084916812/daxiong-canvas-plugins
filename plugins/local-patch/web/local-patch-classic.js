(function(){
  if(globalThis.LocalPatchPlugin?.mounted) return;
  const lifecycle = {
    mounted:false,
    refreshRequired:false,
    mount(){ if(this.mounted) return; this.mounted=true; mountImplementation(); },
    unmount(){
      this.restoreWrappedFunctions?.();
      document.querySelectorAll('.local-patch-menu-card,.local-patch-compare-modal,.local-patch-image-toolbar,[data-local-patch-preview-compare]').forEach(node=>node.remove());
      this.restoreWrappedFunctions=null; this.mounted=false; this.refreshRequired=true;
    }
  };
  globalThis.LocalPatchPlugin = lifecycle;
  lifecycle.mount();
  function mountImplementation(){
  const Core = globalThis.LocalPatchCore;
  const TYPE_MERGE = 'local-patch-merge';
  const required = [
    typeof nodes !== 'undefined', typeof connections !== 'undefined', typeof selected !== 'undefined',
    typeof render === 'function', typeof renderNode === 'function', typeof renderLinks === 'function',
    typeof startLink === 'function', typeof canConnect === 'function', typeof openImageEditor === 'function',
    typeof applyImageEdit === 'function', typeof closeImageEditor === 'function',
    typeof openOutputLightbox === 'function', typeof setOutputCompareMode === 'function',
    typeof addGeneratedImageNode === 'function', typeof imageRefsFromNode === 'function'
  ];
  if(!Core || required.some(Boolean) === false || required.some(value => !value)){
    console.error('[local-patch] 普通画布接口不兼容，插件已安全禁用');
    return;
  }

  let extractSession = null;
  let editorApplyHtml = '';
  const fingerprintJobs = new Map();
  const original = {
    render, renderNode, renderLinks, refreshSelectionVisuals, startLink, canConnect,
    sanitizeConnections, menuAdd, createNodeByType, openImageEditor, applyImageEdit,
    closeImageEditor, setImageEditMode, imageRefsFromNode, mediaRefsFromNode, generatedImageRefs,
    generatorSources, mergeGeneratedOutputs, appendOutputImages,
    createImageCardFromOutput, setImageNodeFromOutput, addGeneratedImageNode,
    openOutputLightbox
  };
  lifecycle.restoreWrappedFunctions = () => {
    Object.entries(original).forEach(([name, value]) => {
      if(typeof value === 'function') globalThis[name] = value;
    });
  };

  function escape(value){ return escapeHtml(String(value == null ? '' : value)); }
  function isMerge(node){ return node?.type === TYPE_MERGE; }
  function toastError(message){
    if(typeof showErrorModal === 'function') showErrorModal(message, '局部提取与融合');
    else alert(message);
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
    const digest = fingerprint || item.localPatchFingerprint || '';
    const changed = Core.rememberContextMetadata(contextRegistry(), item, digest);
    if(!digest && item?.url) void fingerprintForUrl(item.url).then(value => {
      if(!value) return;
      item.localPatchFingerprint = value;
      if(Core.rememberContextMetadata(contextRegistry(), item, value)) scheduleSave();
    });
    return changed;
  }
  function restoreContextItem(item){ return Core.restoreContextMetadata(item, contextRegistry()); }
  function syncClassicContextRegistry(){
    let changed = false;
    nodes.forEach(node => {
      if(node.type === 'image' && node.url){
        const restored = restoreContextItem({...node, kind:'image'});
        if(!hasContextMetadata(node) && hasContextMetadata(restored)){
          if(restored.cropContext) node.cropContext = restored.cropContext;
          if(restored.cropContextConflict) node.cropContextConflict = true;
          if(Core.isContextBoundary(restored)){
            node.localPatchFullImage = true;
            node.localPatchContextReset = true;
            delete node.cropContext;
            delete node.cropContextConflict;
          }
          changed = true;
        }
        if(rememberContextItem(node)) changed = true;
      }
      if(node.type === 'output' && Array.isArray(node.images)){
        node.images = node.images.map(raw => {
          if(!raw || typeof raw !== 'object') return raw;
          const restored = restoreContextItem(raw);
          if(!hasContextMetadata(raw) && hasContextMetadata(restored)) changed = true;
          if(rememberContextItem(restored)) changed = true;
          return restored;
        });
      }
    });
    if(changed) scheduleSave();
  }
  function outputItemForNode(node, url){
    if(node?.type === 'group'){
      const members = (node.items || []).map(id => nodes.find(item => item.id === id)).filter(Boolean);
      const index = members.findIndex(item => item.url === url);
      return index >= 0 ? {item:members[index], index, sourceNodeId:members[index].id} : null;
    }
    const pools = node?.type === 'output' ? node.images : node?.generatedOutputs;
    const index = (pools || []).findIndex(item => outputUrlValue(item) === url);
    return index >= 0 ? {item:pools[index], index} : null;
  }
  function attachNodeMetadata(ref, node){
    const next = {...ref};
    const match = outputItemForNode(node, next.url);
    const item = match?.item;
    const context = item?.cropContext || node?.cropContext;
    const conflict = item?.cropContextConflict || node?.cropContextConflict;
    if(context) next.cropContext = context;
    if(conflict) next.cropContextConflict = true;
    if(Core.isContextBoundary(item) || Core.isContextBoundary(node)){
      next.localPatchFullImage = true;
      next.localPatchContextReset = true;
      delete next.cropContext;
      delete next.cropContextConflict;
    }
    next.nodeId = next.nodeId || node?.id || '';
    next.imageIndex = match?.index ?? next.imageIndex ?? 0;
    if(match?.sourceNodeId) next.sourceNodeId = match.sourceNodeId;
    return next;
  }
  function refsForNode(node){
    if(!node) return [];
    if(isMerge(node)) return Core.mergeResultRefs(node, nodes, refsForNode);
    if(['image','group','output'].includes(node.type)){
      const refs = Core.classicContainerImageRefs(node, nodes)
        .filter(ref => ref.kind === 'image' && !isVideoUrl(ref.url) && !isAudioUrl(ref.url));
      if(refs.length) return refs.map(ref => attachNodeMetadata(ref, node));
    }
    return (original.imageRefsFromNode(node) || []).map(ref => attachNodeMetadata(ref, node));
  }
  function namedItems(node, port){
    return Core.namedInputItems(node.id, port, nodes, connections, refsForNode);
  }
  function portChoiceKey(port){ return port === 'original' ? 'localPatchOriginalImageIndex' : 'localPatchPatchImageIndex'; }
  function namedChoice(node, port){
    return Core.selectedNamedInputItem(node.id, port, nodes, connections, refsForNode, node?.[portChoiceKey(port)] || 0);
  }
  function namedPatchChoices(node){
    node.localPatchPatchChoices = node.localPatchPatchChoices && typeof node.localPatchPatchChoices === 'object' ? node.localPatchPatchChoices : {};
    const choices = Core.namedInputSelections(node.id, 'patch', nodes, connections, refsForNode, node.localPatchPatchChoices);
    choices.forEach(choice => { node.localPatchPatchChoices[choice.connectionKey] = choice.index; });
    return choices;
  }
  function upstreamContextItems(nodeId){
    const queue = [{id:nodeId, depth:0}];
    const seen = new Set();
    const items = [];
    while(queue.length){
      const current = queue.shift();
      if(!current.id || seen.has(current.id) || current.depth > 16) continue;
      seen.add(current.id);
      const node = nodes.find(item => item.id === current.id);
      const refs = node ? refsForNode(node) : [];
      if(Core.isContextBoundary(node) || refs.some(item => Core.isContextBoundary(item))) continue;
      refs.forEach(item => {
        if(item.cropContext || item.cropContextConflict) items.push(item);
      });
      connections.filter(conn => conn.to === current.id).forEach(conn => queue.push({id:conn.from, depth:current.depth + 1}));
    }
    return items;
  }
  function applyContextToItems(items, inputs){
    return Core.applyInheritedContext((items || []).map(item => {
      if(item && typeof item === 'object') return {...item, url:outputUrlValue(item)};
      return {url:outputUrlValue(item)};
    }).filter(item => item.url), inputs);
  }

  imageRefsFromNode = function(node){ return refsForNode(node); };
  mediaRefsFromNode = function(node){
    return (original.mediaRefsFromNode(node) || []).map(ref => attachNodeMetadata(ref, node));
  };
  generatedImageRefs = function(node){
    return (original.generatedImageRefs(node) || []).map(ref => attachNodeMetadata(ref, node));
  };
  generatorSources = function(gen){
    const sources = Core.appendMergeGeneratorSources(
      original.generatorSources(gen) || [], gen, connections, nodes, refsForNode
    );
    const metadata = new Map();
    connections.filter(conn => conn.to === gen.id).forEach(conn => {
      refsForNode(nodes.find(node => node.id === conn.from)).forEach(ref => metadata.set(ref.url, ref));
    });
    return sources.map(source => ({...source, refs:(source.refs || []).map(ref => ({...ref, ...(metadata.get(ref.url) || {})}))}));
  };
  mergeGeneratedOutputs = function(node, outputs, append=false){
    const value = original.mergeGeneratedOutputs(node, outputs, append);
    const inherited = upstreamContextItems(node?.id);
    if(inherited.length){
      node.generatedOutputs = applyContextToItems(node.generatedOutputs || [], inherited);
      connections.filter(conn => conn.from === node.id).forEach(conn => {
        const out = nodes.find(item => item.id === conn.to && item.type === 'output');
        if(out) out.images = applyContextToItems(out.images || [], inherited);
      });
    }
    return value;
  };
  appendOutputImages = function(out, images, compareRef, metas=[], layout=null){
    const value = original.appendOutputImages(out, images, compareRef, metas, layout);
    const inherited = upstreamContextItems(out?.id);
    if(inherited.length) out.images = applyContextToItems(out.images || [], inherited);
    (out?.images || []).forEach(item => { if(item && typeof item === 'object') rememberContextItem(item); });
    return value;
  };
  addGeneratedImageNode = function(file, sourceNode, suffix, offsetY=0, extra={}){
    const restored = restoreContextItem({...file, ...extra, url:file?.url});
    const node = original.addGeneratedImageNode(file, sourceNode, suffix, offsetY, {...extra, ...restored});
    if(node) rememberContextItem(node);
    return node;
  };
  createImageCardFromOutput = function(url, point){
    const before = new Set(nodes.map(node => node.id));
    const value = original.createImageCardFromOutput(url, point);
    const created = nodes.find(node => !before.has(node.id) && node.type === 'image' && node.url === url);
    if(created){
      const restored = restoreContextItem({...created, kind:'image'});
      if(restored.cropContext) created.cropContext = restored.cropContext;
      if(restored.cropContextConflict) created.cropContextConflict = true;
      if(Core.isContextBoundary(restored)){
        created.localPatchFullImage = true;
        created.localPatchContextReset = true;
        delete created.cropContext;
        delete created.cropContextConflict;
      }
      if(restored.localPatchFingerprint) created.localPatchFingerprint = restored.localPatchFingerprint;
      rememberContextItem(created);
    }
    return value;
  };
  setImageNodeFromOutput = function(nodeId, url){
    const value = original.setImageNodeFromOutput(nodeId, url);
    const node = nodes.find(item => item.id === nodeId);
    if(node?.url){
      const restored = restoreContextItem({...node, url, kind:'image'});
      delete node.cropContext; delete node.cropContextConflict;
      delete node.localPatchFullImage; delete node.localPatchContextReset;
      if(restored.cropContext) node.cropContext = restored.cropContext;
      if(restored.cropContextConflict) node.cropContextConflict = true;
      if(Core.isContextBoundary(restored)){
        node.localPatchFullImage = true;
        node.localPatchContextReset = true;
        delete node.cropContext;
        delete node.cropContextConflict;
      }
      if(restored.localPatchFingerprint) node.localPatchFingerprint = restored.localPatchFingerprint;
      rememberContextItem(node);
    }
    return value;
  };

  function createMergeNode(point){
    const p = point || defaultPoint(120, 0);
    pushUndo();
    const node = {
      id:uid('local_merge'), type:TYPE_MERGE, x:p.x, y:p.y, w:270, h:330,
      colorMatch:true, featherMode:'smoothstep', status:'idle', error:'', created_at:Date.now()
    };
    nodes.push(node);
    selected.clear(); selected.add(node.id);
    render(); scheduleSave();
    return node;
  }
  function installMenuEntry(){
    if(!createMenu || createMenu.querySelector('[data-local-patch-create-merge]')) return;
    const button = document.createElement('button');
    button.className = 'menu-btn';
    button.type = 'button';
    button.dataset.localPatchCreateMerge = '1';
    button.innerHTML = '<i data-lucide="blend" class="w-4 h-4"></i><span>无缝融合</span>';
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); closeCreateMenu(); createMergeNode(menuPoint); };
    createMenu.appendChild(button);
    button.innerHTML = '<i data-lucide="blend" class="w-4 h-4"></i><span>图像融合</span>';
    refreshIcons();
  }
  menuAdd = function(type){
    if(type === TYPE_MERGE){ closeCreateMenu(); return createMergeNode(menuPoint); }
    return original.menuAdd(type);
  };
  createNodeByType = function(type, point){
    if(type === TYPE_MERGE) return createMergeNode(point);
    return original.createNodeByType(type, point);
  };

  function inputHtml(label, port, item){
    const value = item?.url ? (item.name || item.url) : '未连接';
    return `<div class="local-patch-classic-input"><div class="port in local-patch-named-port" data-target-port="${port}" title="${escape(label)}"></div><strong>${escape(label)}</strong><span title="${escape(value)}">${escape(value)}</span></div>`;
  }
  function mergeBody(node){
    const originalItem = namedItems(node, 'original');
    const patchItems = namedItems(node, 'patch');
    const patch = patchItems.length === 1 ? patchItems[0] : null;
    let summary = '请连接完整原图和处理后的局部图';
    if(patch?.cropContextConflict) summary = '局部图包含冲突的裁剪上下文';
    else if(patch?.cropContext?.paddedRect){
      const rect = patch.cropContext.paddedRect;
      summary = `目标区域 ${rect.w}×${rect.h}，输出保持原图尺寸`;
    }
    return `${inputHtml('原图', 'original', originalItem.length === 1 ? originalItem[0] : null)}${inputHtml('处理后的局部图', 'patch', patch)}<div class="local-patch-classic-summary">${escape(summary)}</div>${node.error ? `<div class="local-patch-classic-error">${escape(node.error)}</div>` : ''}<div class="local-patch-classic-actions"><label><input type="checkbox" data-local-patch-color ${node.colorMatch !== false ? 'checked' : ''}>颜色匹配</label><button type="button" data-local-patch-run ${node.status === 'running' ? 'disabled' : ''}>${node.status === 'running' ? '融合中…' : '执行融合'}</button></div>`;
  }
  function choiceButtons(port, choice){
    if(choice.items.length <= 1) return '';
    return `<div class="local-patch-choice" data-local-patch-choice="${port}">
      <button type="button" data-local-patch-pick="-1" data-port="${port}" title="上一张"><i data-lucide="chevron-left"></i></button>
      <span>${choice.index + 1} / ${choice.items.length}</span>
      <button type="button" data-local-patch-pick="1" data-port="${port}" title="下一张"><i data-lucide="chevron-right"></i></button>
    </div>`;
  }
  function previewPane(label, port, choice){
    const item = choice.item;
    return `<div class="local-patch-preview-pane ${item?.url ? '' : 'missing'}">
      ${item?.url ? `<img src="${escape(item.url)}" alt="${escape(label)}">` : '<i data-lucide="image"></i>'}
      <span class="local-patch-preview-label">${escape(label)}</span>
      ${choiceButtons(port, choice)}
    </div>`;
  }
  function mergeChipV2(label, choice, conflict=false){
    const connected = Boolean(choice.item);
    return `<span class="local-patch-merge-chip ${connected ? 'connected' : ''} ${conflict ? 'conflict' : ''}"><i data-lucide="${connected ? (conflict ? 'triangle-alert' : 'check') : 'circle'}"></i>${escape(connected ? label : `未连接${label}`)}</span>`;
  }
  function mergeBodyV2(node){
    const originalChoice = namedChoice(node, 'original');
    const patchChoice = namedChoice(node, 'patch');
    node.localPatchOriginalImageIndex = originalChoice.index;
    node.localPatchPatchImageIndex = patchChoice.index;
    const conflict = Boolean(patchChoice.item?.cropContextConflict);
    return `<div class="local-patch-body local-patch-merge-card">
      <div class="local-patch-merge-preview">${previewPane('原图', 'original', originalChoice)}${previewPane('局部修改', 'patch', patchChoice)}</div>
      <div class="local-patch-merge-chips">${mergeChipV2('原图', originalChoice)}${mergeChipV2('局部修改', patchChoice, conflict)}</div>
      ${node.error ? `<div class="local-patch-error">${escape(node.error)}</div>` : ''}
      <div class="local-patch-merge-options"><label><input type="checkbox" data-local-patch-color ${node.colorMatch !== false ? 'checked' : ''}>颜色匹配</label></div>
      <button class="local-patch-merge-run" type="button" data-local-patch-run ${node.status === 'running' ? 'disabled' : ''}><i data-lucide="blend"></i><span>${node.status === 'running' ? '融合中…' : '开始融合'}</span></button>
    </div>`;
  }
  function patchPreviewPane(choice,index){
    const item=choice.item;
    const controls=choice.items.length>1?`<div class="local-patch-choice" data-connection-key="${escape(choice.connectionKey)}">
      <button type="button" data-local-patch-pick="-1" data-port="patch" data-connection-key="${escape(choice.connectionKey)}"><i data-lucide="chevron-left"></i></button>
      <span>${choice.index+1} / ${choice.items.length}</span>
      <button type="button" data-local-patch-pick="1" data-port="patch" data-connection-key="${escape(choice.connectionKey)}"><i data-lucide="chevron-right"></i></button>
    </div>`:'';
    return `<div class="local-patch-preview-pane ${item?.url?'':'missing'}">${item?.url?`<img src="${escape(item.url)}" alt="局部 ${index+1}">`:'<i data-lucide="image"></i>'}<span class="local-patch-preview-label">局部 ${index+1}</span>${controls}</div>`;
  }
  function mergeBodyMulti(node){
    const originalChoice=namedChoice(node,'original');
    const patchChoices=namedPatchChoices(node);
    node.localPatchOriginalImageIndex=originalChoice.index;
    if(patchChoices.length===1)node.localPatchPatchImageIndex=patchChoices[0].index;
    const invalid=patchChoices.some(choice=>choice.item?.cropContextConflict||!choice.item?.cropContext);
    const patchPanes=patchChoices.length?patchChoices.map(patchPreviewPane).join(''):'<div class="local-patch-preview-pane missing"><i data-lucide="image"></i><span class="local-patch-preview-label">局部修改</span></div>';
    return `<div class="local-patch-body local-patch-merge-card"><div class="local-patch-merge-preview local-patch-multi-preview">${previewPane('原图','original',originalChoice)}<div class="local-patch-patch-list">${patchPanes}</div></div><div class="local-patch-merge-chips">${mergeChipV2('原图',originalChoice)}${mergeChipV2(`局部修改 ${patchChoices.length} 张`,{item:patchChoices[0]?.item},invalid)}</div>${node.error?`<div class="local-patch-error">${escape(node.error)}</div>`:''}<div class="local-patch-merge-options"><label><input type="checkbox" data-local-patch-color ${node.colorMatch!==false?'checked':''}>颜色匹配</label></div><button class="local-patch-merge-run" type="button" data-local-patch-run ${node.status==='running'?'disabled':''}><i data-lucide="blend"></i><span>${node.status==='running'?'融合中…':'开始融合'}</span></button></div>`;
  }
  renderNode = function(node){
    const el = original.renderNode(node);
    if(!isMerge(node)) return el;
    el.classList.add('local-patch-merge-node');
    el.querySelector('.node-title').textContent = '无缝融合';
    el.querySelector('.node-title').textContent = '图像融合';
    const body = el.querySelector('.node-body');
    body.className = 'node-body local-patch-classic-body';
    body.innerHTML = mergeBodyMulti(node);
    el.querySelectorAll(':scope > .port').forEach(port => port.remove());
    el.insertAdjacentHTML('beforeend', `<div class="port in local-patch-named-port local-patch-merge-original-port" data-target-port="original" title="连接原图"></div>
      <div class="port in out local-patch-named-port local-patch-merge-shared-port" data-target-port="patch" title="局部修改输入 / 融合结果输出"></div>`);
    el.querySelector('[data-local-patch-color]')?.addEventListener('change', event => {
      node.colorMatch = event.target.checked; scheduleSave();
    });
    el.querySelector('[data-local-patch-run]')?.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); runMergeMulti(node);
    });
    el.querySelectorAll('[data-local-patch-pick]').forEach(button => button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      const port = button.dataset.port;
      const connectionKey=button.dataset.connectionKey||'';
      if(port==='patch'&&connectionKey){
        const choice=namedPatchChoices(node).find(item=>item.connectionKey===connectionKey);if(!choice)return;
        node.localPatchPatchChoices[connectionKey]=Core.resolveImageChoice(choice.items,choice.index+Number(button.dataset.localPatchPick||0)).index;
      }else{
        const choice = namedChoice(node, port);
        node[portChoiceKey(port)] = Core.resolveImageChoice(choice.items, choice.index + Number(button.dataset.localPatchPick || 0)).index;
      }
      node.status = 'idle'; node.error = '';
      render(); scheduleSave();
    }));
    const shared = el.querySelector('.local-patch-merge-shared-port');
    if(shared) shared.onmousedown = event => { if(event.button === 0 && !event.shiftKey) startLink(event, node.id, 'out'); };
    return el;
  };

  canConnect = function(fromId, toId){
    const source = nodes.find(node => node.id === fromId);
    const target = nodes.find(node => node.id === toId);
    if(isMerge(source)){
      if(target?.type === 'image') return !target.localPatchMergeSourceId || target.localPatchMergeSourceId === source.id;
      const generatorTypes = typeof CANVAS_GENERATOR_TYPES !== 'undefined' ? CANVAS_GENERATOR_TYPES : [];
      return Core.imageLikeTargetAccepts(target, generatorTypes);
    }
    if(isMerge(target)) return fromId !== toId && refsForNode(nodes.find(node => node.id === fromId)).length > 0;
    return original.canConnect(fromId, toId);
  };
  sanitizeConnections = function(){
    connections = (connections || []).filter(conn => canConnect(conn.from, conn.to));
  };
  function connectNamed(fromId, toId, targetPort){
    if(!['original','patch'].includes(targetPort) || !canConnect(fromId, toId)) return false;
    pushUndo();
    const next = {id:uid('c'), from:fromId, to:toId, targetPort};
    connections = Core.setNamedConnection(connections, next, {allowMultiple:targetPort === 'patch'}).filter(conn => !(conn.from === fromId && conn.to === toId && conn.targetPort !== targetPort));
    const target = nodes.find(node => node.id === toId);
    if(target){
      target.error = ''; target.status = 'idle';
      if(targetPort === 'patch'){
        target.localPatchPatchChoices = target.localPatchPatchChoices && typeof target.localPatchPatchChoices === 'object' ? target.localPatchPatchChoices : {};
        target.localPatchPatchChoices[next.id] = 0;
      } else target[portChoiceKey(targetPort)] = 0;
    }
    syncGeneratorInputs(); scheduleSave(); render();
    return true;
  }
  startLink = function(event, originId, originKind){
    const value = original.startLink(event, originId, originKind);
    if((originKind || 'out') !== 'out') return value;
    const finish = window.onmouseup;
    window.onmouseup = release => {
      const port = nearestPort(release.clientX, release.clientY, 'in');
      const target = port?.closest('.node');
      const targetPort = port?.dataset?.targetPort || '';
      if(targetPort && isMerge(nodes.find(node => node.id === target?.dataset?.id))){
        tempLink = null; window.onmousemove = null; window.onmouseup = null;
        if(!connectNamed(originId, target.dataset.id, targetPort)) toastError('该端口只能连接包含单张图片的节点');
        renderLinks();
        return;
      }
      return finish?.(release);
    };
    return value;
  };
  function namedPortPoint(nodeId, targetPort){
    const port = nodesEl.querySelector(`.node[data-id="${CSS.escape(nodeId)}"] .local-patch-named-port[data-target-port="${targetPort}"]`);
    if(!port) return null;
    const rect = port.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  function adjustNamedLinks(){
    const visible = [...linksEl.querySelectorAll('path.link:not(.temp)')];
    const hits = [...linksEl.querySelectorAll('path.link-hit')];
    const controls = [...linkControlsEl.querySelectorAll('.link-delete')];
    connections.forEach((conn, index) => {
      if(!conn.targetPort) return;
      const a = portPoint(conn.from, 'out');
      const b = namedPortPoint(conn.to, conn.targetPort);
      if(!b) return;
      const dx = Math.max(80, Math.abs(b.x - a.x) * .45);
      const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
      visible[index]?.setAttribute('d', d);
      hits[index]?.setAttribute('d', d);
      if(controls[index]){ controls[index].style.left = `${(a.x+b.x)/2}px`; controls[index].style.top = `${(a.y+b.y)/2}px`; }
    });
  }
  renderLinks = function(){ const value = original.renderLinks(); adjustNamedLinks(); return value; };

  function restoreEditorButton(){
    const modal = document.getElementById('imageEditModal');
    modal?.classList.remove('local-patch-extract-session');
    document.querySelector('[data-local-patch-extract-mode]')?.classList.remove('active');
    const apply = document.getElementById('imageEditApplyBtn');
    if(apply && editorApplyHtml) apply.innerHTML = editorApplyHtml;
    editorApplyHtml = '';
  }
  function installClassicEditorExtractMode(){
    const modes = document.querySelector('#imageEditModal .image-edit-mode');
    if(!modes || modes.querySelector('[data-local-patch-extract-mode]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.localPatchExtractMode = '1';
    button.innerHTML = '<i data-lucide="scan" class="w-3.5 h-3.5"></i><span>提取选区</span>';
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      const node = nodes.find(item => item.id === cropState?.nodeId);
      beginExtract(node, true);
    });
    const cropButton = modes.querySelector('[data-image-edit-mode="crop"]');
    cropButton?.insertAdjacentElement('afterend', button);
    if(!cropButton) modes.appendChild(button);
    refreshIcons();
  }
  function updateExtractEditorUi(){
    installClassicEditorExtractMode();
    document.querySelector('[data-local-patch-extract-mode]')?.classList.toggle('active', Boolean(extractSession));
    if(!extractSession) return;
    document.getElementById('imageEditModal')?.classList.add('local-patch-extract-session');
    document.querySelector('[data-image-edit-mode="crop"]')?.classList.remove('active');
    const button = document.getElementById('imageEditApplyBtn');
    if(button) button.innerHTML = '<i data-lucide="crop" class="w-4 h-4"></i><span>提取选区</span>';
    refreshIcons();
  }
  setImageEditMode = function(mode, force=false){
    if(extractSession && mode !== 'crop') extractSession = null;
    const value = original.setImageEditMode(mode, force);
    updateExtractEditorUi();
    return value;
  };
  function beginExtract(node, editorAlreadyOpen=false){
    if(!node?.url || mediaKindForNode(node) !== 'image') return;
    extractSession = {nodeId:node.id};
    const apply = document.getElementById('imageEditApplyBtn');
    editorApplyHtml = apply?.innerHTML || '';
    if(!editorAlreadyOpen || !document.getElementById('imageEditModal')?.classList.contains('open')) original.openImageEditor(node.id, 'crop');
    document.getElementById('imageEditModal')?.classList.add('local-patch-extract-session');
    setTimeout(() => {
      setImageEditMode('crop');
      updateExtractEditorUi();
    }, 0);
  }
  async function extractSelection(){
    const source = nodes.find(node => node.id === extractSession?.nodeId);
    const image = document.getElementById('cropImage');
    const bounds = cropBounds();
    if(!source || !cropState || !image?.naturalWidth || !bounds.w) throw new Error('选区尚未准备好');
    const selection = Core.displaySelectionToNatural(cropState, {
      displayWidth:bounds.w, displayHeight:bounds.h,
      naturalWidth:image.naturalWidth, naturalHeight:image.naturalHeight
    });
    const response = await fetch('/api/plugins/local-patch/crop', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        source_url:source.url,
        selection:{x:selection.x,y:selection.y,w:selection.w,h:selection.h,source_width:selection.sourceWidth,source_height:selection.sourceHeight},
        padding_ratio:0.1
      })
    });
    if(!response.ok) throw new Error(await responseErrorMessage(response, '提取选区失败'));
    const data = await response.json();
    pushUndo();
    addGeneratedImageNode(data.file, source, 'local patch', 0, {
      cropContext:data.file.cropContext, mediaKind:'image',
      natural_w:data.file.natural_w, natural_h:data.file.natural_h
    });
    extractSession = null;
    restoreEditorButton();
    original.closeImageEditor();
    render(); scheduleSave();
  }
  applyImageEdit = function(){
    if(!extractSession) return original.applyImageEdit();
    return extractSelection().catch(error => toastError(String(error?.message || error)));
  };
  closeImageEditor = function(){
    extractSession = null; restoreEditorButton(); return original.closeImageEditor();
  };

  async function runMergeMulti(node){
    try{
      const originalItem=namedChoice(node,'original').item;
      const patchChoices=namedPatchChoices(node);
      if(!originalItem||!patchChoices.length)throw new Error('请连接一张完整原图和至少一张局部修改图');
      const patches=patchChoices.map((choice,index)=>{
        const patch=choice.item;
        if(patch.role==='mask')throw new Error(`第 ${index+1} 张局部图是遮罩图，不能融合`);
        if(patch.cropContextConflict)throw new Error(`第 ${index+1} 张局部图包含冲突的裁剪上下文`);
        if(!patch.cropContext)throw new Error(`第 ${index+1} 张局部图缺少上下文，请重新提取选区`);
        return {patch_url:patch.url,crop_context:patch.cropContext};
      });
      node.status='running';node.error='';render();
      const response=await fetch('/api/plugins/local-patch/merge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({original_url:originalItem.url,patches,color_match:node.colorMatch!==false,feather_mode:node.featherMode||'smoothstep'})});
      if(!response.ok)throw new Error(await responseErrorMessage(response,'图像融合失败'));
      const data=await response.json();pushUndo();
      const fullFile={...data.file,localPatchFullImage:true,localPatchContextReset:true};
      delete fullFile.cropContext;delete fullFile.cropContextConflict;rememberContextItem(fullFile);
      const output=addGeneratedImageNode(fullFile,node,'merged',0,{mediaKind:'image',natural_w:data.file.natural_w,natural_h:data.file.natural_h,localPatchFullImage:true,localPatchContextReset:true,localPatchMergeSourceId:node.id,localPatchComparisonOriginalUrl:originalItem.url,localPatchComparisonResultUrl:data.file.url,imageComparisons:{[data.file.url]:originalItem.url}});
      output.localPatchFullImage=true;output.localPatchContextReset=true;delete output.cropContext;delete output.cropContextConflict;
      connections=connections.filter(conn=>!(conn.from===node.id&&nodes.find(item=>item.id===conn.to)?.localPatchMergeSourceId===node.id));
      connections.push({id:uid('c'),from:node.id,to:output.id,kind:'flow'});
      node.lastOutputNodeId=output.id;node.comparisonOriginalUrl=originalItem.url;node.comparisonResultUrl=data.file.url;node.status='success';node.error='';
      render();scheduleSave();
    }catch(error){node.status='error';node.error=String(error?.message||error||'图像融合失败');render();scheduleSave();}
  }

  async function runMergeV2(node){
    try {
      const originalChoice = namedChoice(node, 'original');
      const patchChoice = namedChoice(node, 'patch');
      const originalItem = originalChoice.item;
      const patch = patchChoice.item;
      if(!originalItem || !patch) throw new Error('请分别连接原图和局部修改图；多图节点可在融合节点内切换选择');
      if(patch.role === 'mask') throw new Error('遮罩图不能作为局部修改图');
      if(patch.cropContextConflict) throw new Error('局部修改图包含多个冲突的裁剪上下文');
      if(!patch.cropContext) throw new Error('局部修改图缺少上下文，请重新提取选区或确认中间处理节点保留了上下文');
      node.status = 'running'; node.error = ''; render();
      const response = await fetch('/api/plugins/local-patch/merge', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          original_url:originalItem.url, patch_url:patch.url, crop_context:patch.cropContext,
          color_match:node.colorMatch !== false, feather_mode:node.featherMode || 'smoothstep'
        })
      });
      if(!response.ok) throw new Error(await responseErrorMessage(response, '图像融合失败'));
      const data = await response.json();
      pushUndo();
      const output = addGeneratedImageNode(data.file, node, 'merged', 0, {
        mediaKind:'image', natural_w:data.file.natural_w, natural_h:data.file.natural_h,
        localPatchMergeSourceId:node.id,
        localPatchComparisonOriginalUrl:originalItem.url,
        localPatchComparisonResultUrl:data.file.url,
        imageComparisons:{[data.file.url]:originalItem.url}
      });
      connections = connections.filter(conn => !(conn.from === node.id && nodes.find(item => item.id === conn.to)?.localPatchMergeSourceId === node.id));
      connections.push({id:uid('c'), from:node.id, to:output.id, kind:'flow'});
      node.lastOutputNodeId = output.id;
      node.comparisonOriginalUrl = originalItem.url;
      node.comparisonResultUrl = data.file.url;
      node.status = 'success'; node.error = '';
      render(); scheduleSave();
    } catch(error){
      node.status = 'error'; node.error = String(error?.message || error || '图像融合失败');
      render(); scheduleSave();
    }
  }
  async function runMerge(node){
    try {
      const originals = namedItems(node, 'original');
      const patches = namedItems(node, 'patch');
      if(originals.length !== 1 || patches.length !== 1) throw new Error('原图和局部图端口都必须各连接一张图片');
      const patch = patches[0];
      if(patch.cropContextConflict) throw new Error('局部图包含多个冲突的裁剪上下文');
      if(!patch.cropContext) throw new Error('局部图缺少 cropContext，请从图片节点重新提取选区，或确认处理中间节点保留了上下文');
      node.status = 'running'; node.error = ''; render();
      const response = await fetch('/api/plugins/local-patch/merge', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          original_url:originals[0].url, patch_url:patch.url, crop_context:patch.cropContext,
          color_match:node.colorMatch !== false, feather_mode:'smoothstep'
        })
      });
      if(!response.ok) throw new Error(await responseErrorMessage(response, '无缝融合失败'));
      const data = await response.json();
      pushUndo();
      addGeneratedImageNode(data.file, node, 'merged', 0, {
        mediaKind:'image', natural_w:data.file.natural_w, natural_h:data.file.natural_h
      });
      node.status = 'success'; node.error = ''; render(); scheduleSave();
    } catch(error){
      node.status = 'error'; node.error = String(error?.message || error || '融合失败');
      render(); scheduleSave();
    }
  }

  function installClassicPreviewCompareButton(){
    const preview = document.getElementById('outputPreview');
    if(!preview || preview.querySelector('[data-local-patch-preview-compare]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preview-text-btn secondary local-patch-preview-compare';
    button.dataset.localPatchPreviewCompare = '1';
    button.title = '对比原图';
    button.innerHTML = '<i data-lucide="columns-2"></i><span>对比原图</span>';
    button.style.display = 'none';
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      const active = !preview.classList.contains('compare-mode');
      setOutputCompareMode(active);
      button.classList.toggle('active', active);
    });
    preview.appendChild(button);
    refreshIcons();
  }
  openOutputLightbox = function(url, out){
    const originalUrl = out?.localPatchComparisonOriginalUrl || out?.imageComparisons?.[url] || '';
    if(originalUrl && out){
      out.imageComparisons = {...(out.imageComparisons || {}), [url]:originalUrl};
    }
    const value = original.openOutputLightbox(url, out);
    installClassicPreviewCompareButton();
    const button = document.querySelector('[data-local-patch-preview-compare]');
    if(button){
      button.style.display = originalUrl ? 'inline-flex' : 'none';
      button.classList.remove('active');
    }
    return value;
  };
  openImageEditor = function(nodeId, initialMode='crop'){
    const node = nodes.find(item => item.id === nodeId);
    if(initialMode === 'preview' && node?.localPatchComparisonOriginalUrl){
      return openOutputLightbox(node.url, node);
    }
    return original.openImageEditor(nodeId, initialMode);
  };

  function runClassicImageAction(node, action){
    if(action === 'extract') return beginExtract(node);
    if(action === 'download') return downloadUrl(node.url, node.name || 'image.png');
    const modes = {preview:'preview',crop:'crop',outpaint:'outpaint',mask:'mask',brush:'brush',grid:'grid'};
    if(modes[action]) openImageEditor(node.id, modes[action]);
  }
  function classicToolbarHtml(){
    return `<button type="button" data-local-patch-classic-action="preview" title="预览"><i data-lucide="eye"></i><span>预览</span></button>
      <button type="button" data-local-patch-classic-action="crop" title="裁剪"><i data-lucide="crop"></i><span>裁剪</span></button>
      <button type="button" data-local-patch-classic-action="outpaint" title="扩图"><i data-lucide="expand"></i><span>扩图</span></button>
      <button type="button" data-local-patch-classic-action="mask" title="遮罩"><i data-lucide="brush"></i><span>遮罩</span></button>
      <button type="button" data-local-patch-classic-action="brush" title="画笔"><i data-lucide="paintbrush"></i><span>画笔</span></button>
      <button type="button" data-local-patch-classic-action="grid" title="宫格"><i data-lucide="grid-3x3"></i><span>宫格</span></button>
      <button type="button" data-local-patch-classic-action="extract" title="提取选区"><i data-lucide="scan"></i><span>提取选区</span></button>
      <button type="button" data-local-patch-classic-action="download" title="下载"><i data-lucide="download"></i><span>下载</span></button>`;
  }
  function decorateImageToolbar(){
    nodesEl.querySelectorAll('.local-patch-image-toolbar').forEach(toolbar => {
      const element = toolbar.closest('.node.image-node');
      const node = nodes.find(item => item.id === element?.dataset.id);
      if(!element?.classList.contains('selected') || !selected.has(node?.id)) toolbar.remove();
    });
    nodesEl.querySelectorAll('.node.image-node.selected').forEach(element => {
      const node = nodes.find(item => item.id === element.dataset.id);
      if(!node?.url || mediaKindForNode(node) !== 'image' || element.querySelector('.local-patch-image-toolbar')) return;
      const toolbar = document.createElement('div');
      toolbar.className = 'local-patch-image-toolbar';
      toolbar.innerHTML = classicToolbarHtml();
      toolbar.querySelectorAll('[data-local-patch-classic-action]').forEach(button => {
        button.addEventListener('mousedown', event => event.stopPropagation());
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          runClassicImageAction(node, button.dataset.localPatchClassicAction);
        });
      });
      element.appendChild(toolbar);
    });
    refreshIcons();
  }
  render = function(){ syncClassicContextRegistry(); const value = original.render(); installMenuEntry(); installClassicEditorExtractMode(); decorateImageToolbar(); adjustNamedLinks(); return value; };
  refreshSelectionVisuals = function(){ const value = original.refreshSelectionVisuals(); decorateImageToolbar(); return value; };

  installMenuEntry(); installClassicEditorExtractMode(); installClassicPreviewCompareButton();
  render();
  console.info('[local-patch] classic canvas plugin 2.7.1 loaded and mounted');
  }
})();
