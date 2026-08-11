(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.LocalPatchCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  function stableContextKey(context){
    if(!context || typeof context !== 'object') return '';
    return JSON.stringify({
      version:context.version,
      contextId:context.contextId,
      source:context.source,
      rect:context.rect,
      paddedRect:context.paddedRect,
      paddingRatio:context.paddingRatio
    });
  }

  function setNamedConnection(connections, connection, options={}){
    const current = Array.isArray(connections) ? connections : [];
    if(!connection?.targetPort) return [...current, {...connection}];
    if(options.allowMultiple) return [...current, {...connection}];
    return [
      ...current.filter(item => !(item.to === connection.to && item.targetPort === connection.targetPort)),
      {...connection}
    ];
  }

  function isContextBoundary(item){
    return Boolean(item?.localPatchFullImage || item?.localPatchContextReset);
  }

  function resolveInheritedCropContext(items){
    const usable = (items || []).filter(item => item?.role !== 'mask' && !isContextBoundary(item));
    if(usable.some(item => item?.cropContextConflict)) return {context:null, conflict:true};
    const contexts = usable.map(item => item?.cropContext).filter(Boolean);
    const unique = new Map(contexts.map(context => [stableContextKey(context), context]));
    if(unique.size === 0) return {context:null, conflict:false};
    if(unique.size === 1) return {context:[...unique.values()][0], conflict:false};
    return {context:null, conflict:true};
  }

  function displaySelectionToNatural(selection, dimensions){
    const sx = dimensions.naturalWidth / dimensions.displayWidth;
    const sy = dimensions.naturalHeight / dimensions.displayHeight;
    const x = Math.max(0, Math.round(selection.x * sx));
    const y = Math.max(0, Math.round(selection.y * sy));
    const right = Math.min(dimensions.naturalWidth, Math.round((selection.x + selection.w) * sx));
    const bottom = Math.min(dimensions.naturalHeight, Math.round((selection.y + selection.h) * sy));
    return {x, y, w:right - x, h:bottom - y, sourceWidth:dimensions.naturalWidth, sourceHeight:dimensions.naturalHeight};
  }

  function findNearestCropNode(startNodeId, nodes, connections){
    const byId = new Map((nodes || []).map(node => [node.id, node]));
    const queue = [startNodeId];
    const seen = new Set();
    while(queue.length){
      const current = queue.shift();
      if(!current || seen.has(current)) continue;
      seen.add(current);
      const node = byId.get(current);
      if(node?.type === 'smart-local-crop') return node.id;
      (connections || []).filter(conn => conn.to === current).forEach(conn => queue.push(conn.from));
    }
    return '';
  }

  function namedInputItems(targetNodeId, targetPort, nodes, connections, imageGetter){
    const byId = new Map((nodes || []).map(node => [node.id, node]));
    const matching = (connections || []).filter(conn => conn.to === targetNodeId && conn.targetPort === targetPort);
    return matching.flatMap(conn => {
      const source = byId.get(conn.from);
      return (imageGetter(source) || []).map((item, index) => ({...item, nodeId:item?.nodeId || source?.id || '', imageIndex:item?.imageIndex ?? index}));
    }).filter(item => item?.url);
  }

  function namedInputSelections(targetNodeId, targetPort, nodes, connections, imageGetter, requestedIndexes={}){
    const byId = new Map((nodes || []).map(node => [node.id, node]));
    return (connections || []).filter(conn => conn.to === targetNodeId && conn.targetPort === targetPort).map((conn, connectionIndex) => {
      const source = byId.get(conn.from);
      const items = (imageGetter(source) || []).map((item, index) => ({...item, nodeId:item?.nodeId || source?.id || '', imageIndex:item?.imageIndex ?? index})).filter(item => item?.url);
      const connectionKey = String(conn.id || `${conn.from}:${conn.to}:${targetPort}:${connectionIndex}`);
      const choice = resolveImageChoice(items, requestedIndexes?.[connectionKey] ?? 0);
      return {...choice, connection:conn, connectionKey};
    }).filter(entry => entry.item);
  }

  function resolveImageChoice(items, requestedIndex=0){
    const list = (Array.isArray(items) ? items : []).filter(item => item?.url);
    if(!list.length) return {items:[], index:0, item:null};
    const numeric = Number(requestedIndex);
    const index = Number.isFinite(numeric)
      ? Math.max(0, Math.min(list.length - 1, Math.trunc(numeric)))
      : 0;
    return {items:list, index, item:list[index] || list[0]};
  }

  function selectedNamedInputItem(targetNodeId, targetPort, nodes, connections, imageGetter, requestedIndex=0){
    return resolveImageChoice(namedInputItems(targetNodeId, targetPort, nodes, connections, imageGetter), requestedIndex);
  }

  function applyInheritedContext(outputs, inputItems){
    const inherited = resolveInheritedCropContext(inputItems);
    return (outputs || []).map(output => {
      const next = {...output};
      if(isContextBoundary(next)){
        delete next.cropContext;
        delete next.cropContextConflict;
        return next;
      }
      if(next.role === 'mask'){
        delete next.cropContext;
        delete next.cropContextConflict;
        return next;
      }
      if(inherited.conflict){
        next.cropContextConflict = true;
        delete next.cropContext;
      } else if(next.cropContext){
        delete next.cropContextConflict;
      } else if(inherited.context){
        next.cropContext = inherited.context;
        delete next.cropContextConflict;
      }
      return next;
    });
  }

  function resolveSelectedImageIndex(images, selectedImage, nodeId){
    const list = Array.isArray(images) ? images : [];
    const selectedIndex = Number(selectedImage?.index);
    if(selectedImage?.nodeId === nodeId && Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < list.length && list[selectedIndex]?.url){
      return selectedIndex;
    }
    const first = list.findIndex(item => item?.url);
    return first >= 0 ? first : 0;
  }

  function normalizeContextUrl(url){
    const text = String(url || '').trim();
    if(!text || text.startsWith('data:')) return text;
    try {
      const parsed = new URL(text, 'http://local-patch.invalid');
      if(parsed.pathname.startsWith('/assets/') || parsed.pathname.startsWith('/output/')) return parsed.pathname;
    } catch(_error) {}
    return text.split('#', 1)[0].split('?', 1)[0];
  }

  function createContextRegistry(existing){
    const registry = existing && typeof existing === 'object' ? existing : {};
    registry.version = 1;
    if(!registry.byUrl || typeof registry.byUrl !== 'object') registry.byUrl = {};
    if(!registry.byFingerprint || typeof registry.byFingerprint !== 'object') registry.byFingerprint = {};
    if(!registry.urlFingerprints || typeof registry.urlFingerprints !== 'object') registry.urlFingerprints = {};
    return registry;
  }

  function contextMetadataForItem(item){
    if(!item || item.role === 'mask') return null;
    if(isContextBoundary(item)) return {localPatchFullImage:true, localPatchContextReset:true};
    if(item.cropContextConflict) return {cropContextConflict:true};
    if(item.cropContext) return {cropContext:item.cropContext};
    return null;
  }

  function sameContextMetadata(left, right){
    if(!left || !right) return left === right;
    if(Boolean(left.cropContextConflict) !== Boolean(right.cropContextConflict)) return false;
    if(Boolean(left.localPatchFullImage) !== Boolean(right.localPatchFullImage)) return false;
    if(Boolean(left.localPatchContextReset) !== Boolean(right.localPatchContextReset)) return false;
    return stableContextKey(left.cropContext) === stableContextKey(right.cropContext);
  }

  function rememberContextMetadata(registryValue, item, fingerprint=''){
    const registry = createContextRegistry(registryValue);
    const metadata = contextMetadataForItem(item);
    if(!metadata) return false;
    let changed = false;
    const urlKey = normalizeContextUrl(item?.url);
    if(urlKey && !sameContextMetadata(registry.byUrl[urlKey], metadata)){
      registry.byUrl[urlKey] = metadata;
      changed = true;
    }
    const digest = String(fingerprint || item?.localPatchFingerprint || '').trim().toLowerCase();
    if(digest){
      if(!sameContextMetadata(registry.byFingerprint[digest], metadata)){
        registry.byFingerprint[digest] = metadata;
        changed = true;
      }
      if(urlKey && registry.urlFingerprints[urlKey] !== digest){
        registry.urlFingerprints[urlKey] = digest;
        changed = true;
      }
    }
    return changed;
  }

  function restoreContextMetadata(item, registryValue, fingerprint=''){
    const next = {...(item || {})};
    if(next.role === 'mask'){
      delete next.cropContext;
      delete next.cropContextConflict;
      return next;
    }
    if(isContextBoundary(next)){
      delete next.cropContext;
      delete next.cropContextConflict;
      return next;
    }
    if(next.cropContextConflict || next.cropContext) return next;
    const registry = createContextRegistry(registryValue);
    const urlKey = normalizeContextUrl(next.url);
    const digest = String(fingerprint || next.localPatchFingerprint || registry.urlFingerprints[urlKey] || '').trim().toLowerCase();
    const metadata = registry.byUrl[urlKey] || (digest ? registry.byFingerprint[digest] : null);
    if(metadata?.localPatchFullImage || metadata?.localPatchContextReset){
      next.localPatchFullImage = true;
      next.localPatchContextReset = true;
      delete next.cropContext;
      delete next.cropContextConflict;
    } else if(metadata?.cropContextConflict){
      next.cropContextConflict = true;
      delete next.cropContext;
    } else if(metadata?.cropContext){
      next.cropContext = metadata.cropContext;
      delete next.cropContextConflict;
    }
    return next;
  }

  function shouldClearSmartSelection(state){
    return Number(state?.button) === 0
      && !state?.insideNode
      && !state?.insideUi
      && !state?.editorOpen;
  }

  function openImageComparison(originalUrl, resultUrl, title='对比原图'){
    const doc = typeof document !== 'undefined' ? document : null;
    if(!doc || !originalUrl || !resultUrl) return false;
    let modal = doc.getElementById('localPatchCompareModal');
    if(!modal){
      modal = doc.createElement('div');
      modal.id = 'localPatchCompareModal';
      modal.className = 'local-patch-compare-modal';
      modal.innerHTML = `<div class="local-patch-compare-dialog" role="dialog" aria-modal="true">
        <div class="local-patch-compare-head"><strong data-local-patch-compare-title></strong><button type="button" data-local-patch-compare-close aria-label="关闭">×</button></div>
        <div class="local-patch-compare-stage">
          <img class="local-patch-compare-result" alt="融合结果">
          <div class="local-patch-compare-original-wrap"><img class="local-patch-compare-original" alt="原图"></div>
          <div class="local-patch-compare-divider"><span></span></div>
          <span class="local-patch-compare-tag original">原图</span><span class="local-patch-compare-tag result">融合结果</span>
        </div>
        <input class="local-patch-compare-range" type="range" min="0" max="100" value="50" aria-label="拖动对比">
      </div>`;
      doc.body.appendChild(modal);
      const close = () => modal.classList.remove('open');
      modal.querySelector('[data-local-patch-compare-close]')?.addEventListener('click', close);
      modal.addEventListener('mousedown', event => { if(event.target === modal) close(); });
      modal.querySelector('.local-patch-compare-range')?.addEventListener('input', event => {
        modal.style.setProperty('--local-patch-compare-pos', `${event.target.value}%`);
      });
    }
    modal.querySelector('[data-local-patch-compare-title]').textContent = title;
    modal.querySelector('.local-patch-compare-original').src = originalUrl;
    modal.querySelector('.local-patch-compare-result').src = resultUrl;
    const range = modal.querySelector('.local-patch-compare-range');
    if(range) range.value = '50';
    modal.style.setProperty('--local-patch-compare-pos', '50%');
    modal.classList.add('open');
    return true;
  }

  function rightSidePlacement(sourceRect, targetRect, gap=120){
    const source = sourceRect || {};
    const target = targetRect || {};
    const sourceX = Number(source.x) || 0;
    const sourceY = Number(source.y) || 0;
    const sourceWidth = Math.max(0, Number(source.width) || 0);
    const sourceHeight = Math.max(0, Number(source.height) || 0);
    const targetHeight = Math.max(0, Number(target.height) || 0);
    return {
      x:Math.round(sourceX + sourceWidth + Math.max(0, Number(gap) || 0)),
      y:Math.round(sourceY + (sourceHeight - targetHeight) / 2)
    };
  }

  function classicImageRefs(node){
    if(!node || node.type !== 'image' || !node.url) return [];
    const item = {
      url:node.url,
      name:node.name || 'image',
      role:node.role || '',
      kind:'image',
      nodeId:node.id || '',
      imageIndex:0
    };
    if(node.cropContext) item.cropContext = node.cropContext;
    if(node.cropContextConflict) item.cropContextConflict = true;
    if(isContextBoundary(node)){
      item.localPatchFullImage = true;
      item.localPatchContextReset = true;
      delete item.cropContext;
      delete item.cropContextConflict;
    }
    return [item];
  }

  function classicContainerImageRefs(node, allNodes=[]){
    if(!node) return [];
    if(node.type === 'image') return classicImageRefs(node);
    if(node.type === 'group'){
      const byId = new Map((allNodes || []).map(item => [item?.id, item]));
      return (node.items || []).map(id => byId.get(id)).filter(Boolean).flatMap((member, index) => {
        const ref = classicImageRefs(member)[0];
        return ref ? [{...ref, nodeId:node.id || '', imageIndex:index, sourceNodeId:member.id || ''}] : [];
      });
    }
    if(node.type === 'output'){
      return (node.images || []).flatMap((raw, index) => {
        const item = raw && typeof raw === 'object' ? raw : {url:String(raw || '')};
        if(!item.url) return [];
        const ref = {
          url:item.url,
          name:item.name || `output-${index + 1}.png`,
          role:item.role || '',
          kind:item.kind || 'image',
          nodeId:node.id || '',
          imageIndex:index
        };
        if(item.cropContext) ref.cropContext = item.cropContext;
        if(item.cropContextConflict) ref.cropContextConflict = true;
        if(item.localPatchFingerprint) ref.localPatchFingerprint = item.localPatchFingerprint;
        if(isContextBoundary(item)){
          ref.localPatchFullImage = true;
          ref.localPatchContextReset = true;
          delete ref.cropContext;
          delete ref.cropContextConflict;
        }
        return [ref];
      });
    }
    return [];
  }

  function imageLikeTargetAccepts(target, generatorTypes=[]){
    if(!target) return false;
    if(target.type === 'loop') return Boolean(target.imageInput);
    if(target.type === 'llm') return true;
    return (generatorTypes || []).includes(target.type);
  }

  function mergeResultRefs(mergeNode, allNodes=[], readRefs=()=>[]){
    if(!mergeNode) return [];
    const resultId = String(mergeNode.lastOutputNodeId || '');
    const resultNode = (allNodes || []).find(node => node?.id === resultId && node !== mergeNode);
    if(resultNode){
      const refs = readRefs(resultNode) || [];
      if(refs.length) return refs;
    }
    const url = String(mergeNode.comparisonResultUrl || mergeNode.localPatchComparisonResultUrl || '');
    if(!url) return [];
    const name = url.split(/[\\/]/).pop() || 'merged.png';
    return [{url, name, kind:'image', nodeId:'', imageIndex:0, localPatchFullImage:true, localPatchContextReset:true}];
  }

  function clampNodeSize(node, minWidth, minHeight){
    if(!node || typeof node !== 'object') return false;
    const width = Math.max(Number(minWidth) || 0, Number(node.w) || 0);
    const height = Math.max(Number(minHeight) || 0, Number(node.h) || 0);
    const changed = node.w !== width || node.h !== height;
    node.w = width;
    node.h = height;
    return changed;
  }

  function appendMergeGeneratorSources(existingSources, generator, connections=[], allNodes=[], readRefs=()=>[]){
    const sources = Array.isArray(existingSources) ? [...existingSources] : [];
    if(!generator?.id) return sources;
    const byId = new Map((allNodes || []).map(node => [node?.id, node]));
    const knownIds = new Set(sources.map(source => source?.id).filter(Boolean));
    (connections || []).filter(connection => connection?.to === generator.id).forEach(connection => {
      const merge = byId.get(connection?.from);
      if(merge?.type !== 'local-patch-merge' || knownIds.has(merge.id)) return;
      const refs = (readRefs(merge) || []).filter(ref => ref?.url);
      if(!refs.length) return;
      sources.push({
        id:merge.id,
        type:'localPatchMerge',
        label:'融合结果',
        preview:refs[0].url,
        refs,
        prompt:''
      });
      knownIds.add(merge.id);
    });
    return sources;
  }

  function applyContextToClassicNode(node, inputItems){
    const next = {...(node || {})};
    const inherited = resolveInheritedCropContext(inputItems);
    if(inherited.conflict){
      next.cropContextConflict = true;
      delete next.cropContext;
    } else if(inherited.context){
      next.cropContext = inherited.context;
      delete next.cropContextConflict;
    } else {
      delete next.cropContext;
      delete next.cropContextConflict;
    }
    return next;
  }

  return {
    stableContextKey,
    setNamedConnection,
    isContextBoundary,
    resolveInheritedCropContext,
    displaySelectionToNatural,
    findNearestCropNode,
    namedInputItems,
    namedInputSelections,
    resolveImageChoice,
    selectedNamedInputItem,
    applyInheritedContext,
    classicImageRefs,
    classicContainerImageRefs,
    imageLikeTargetAccepts,
    mergeResultRefs,
    clampNodeSize,
    appendMergeGeneratorSources,
    applyContextToClassicNode,
    resolveSelectedImageIndex,
    normalizeContextUrl,
    createContextRegistry,
    rememberContextMetadata,
    restoreContextMetadata,
    shouldClearSmartSelection,
    openImageComparison,
    rightSidePlacement
  };
});
