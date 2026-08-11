(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.LongImageCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  const SCHEMA_VERSION = 1;
  const PLUGIN_ID = 'long-image-node';

  function clone(value){ return JSON.parse(JSON.stringify(value)); }
  function uid(prefix='li'){
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-5)}`;
  }
  function asNumber(value, fallback=0){
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  function isManagedImageUrl(value){
    const url = String(value || '').trim();
    return url.startsWith('/assets/') || url.startsWith('/output/');
  }
  function isLongImage(node){ return Boolean(node?.longImage && Number(node.longImage.schemaVersion) === SCHEMA_VERSION); }
  function isReady(node){
    if(!isLongImage(node)) return false;
    const data = node.longImage;
    return data.status === 'ready'
      && Number(data.renderedRevision) === Number(data.revision)
      && Number(data.composite?.revision) === Number(data.revision)
      && Boolean(data.composite?.url);
  }
  function normalizeSource(ref, sourceNode, sourceImageIndex=0){
    const url = String(ref?.url || '').trim();
    if(!isManagedImageUrl(url)) return null;
    return {
      itemId:String(ref?.itemId || uid('li')),
      url,
      name:String(ref?.name || url.split('/').pop() || 'image'),
      naturalW:Math.max(0, Math.round(asNumber(ref?.naturalW ?? ref?.natural_w ?? ref?.width))),
      naturalH:Math.max(0, Math.round(asNumber(ref?.naturalH ?? ref?.natural_h ?? ref?.height))),
      fingerprint:String(ref?.fingerprint || ref?.localPatchFingerprint || ''),
      sourceNodeId:String(ref?.sourceNodeId || ref?.nodeId || sourceNode?.id || ''),
      sourceImageIndex:Math.max(0, Math.round(asNumber(ref?.sourceImageIndex ?? ref?.imageIndex, sourceImageIndex)))
    };
  }
  function collectSources(selectedNodes, refsForNode){
    const ordered = (selectedNodes || []).filter(Boolean).slice().sort((a, b) => {
      const dy = asNumber(a.y) - asNumber(b.y);
      return Math.abs(dy) > 1 ? dy : asNumber(a.x) - asNumber(b.x);
    });
    const items = [];
    ordered.forEach(node => {
      (refsForNode(node) || []).forEach((ref, index) => {
        const item = normalizeSource(ref, node, index);
        if(item) items.push(item);
      });
    });
    return items.slice(0, 100);
  }
  function createData(items, now=Date.now()){
    const normalized = (items || []).map((item, index) => normalizeSource(item, null, index)).filter(Boolean);
    return {
      schemaVersion:SCHEMA_VERSION,
      revision:1,
      renderedRevision:0,
      contentUpdatedAt:now,
      status:normalized.length >= 2 ? 'dirty' : 'incomplete',
      targetWidthMode:'min-source',
      targetWidth:0,
      allowUpscale:false,
      items:normalized,
      composite:null,
      lastGoodComposite:null,
      lastError:''
    };
  }
  function moveItem(items, fromIndex, dropSlot){
    const source = (items || []).slice();
    const from = Math.round(asNumber(fromIndex, -1));
    let slot = Math.round(asNumber(dropSlot, -1));
    if(from < 0 || from >= source.length || slot < 0 || slot > source.length) return source;
    const [item] = source.splice(from, 1);
    if(slot > from) slot -= 1;
    slot = Math.max(0, Math.min(source.length, slot));
    source.splice(slot, 0, item);
    return source;
  }
  function sameOrder(a, b){
    return a.length === b.length && a.every((item, index) => item?.itemId === b[index]?.itemId);
  }
  function markDirty(node, nextItems=null, now=Date.now()){
    if(!isLongImage(node)) return node;
    const data = node.longImage;
    if(data.composite?.url) data.lastGoodComposite = clone(data.composite);
    if(Array.isArray(nextItems)) data.items = nextItems;
    data.revision = Math.max(1, Math.round(asNumber(data.revision, 0)) + 1);
    data.renderedRevision = 0;
    data.contentUpdatedAt = now;
    data.status = (data.items || []).length >= 2 ? 'dirty' : 'incomplete';
    data.composite = null;
    data.lastError = '';
    node.url = '';
    node.images = [];
    delete node.natural_w;
    delete node.natural_h;
    return node;
  }
  function beginBuild(node){
    if(!isLongImage(node)) return null;
    const data = node.longImage;
    if((data.items || []).length < 2){ data.status = 'incomplete'; return null; }
    data.status = 'building';
    data.lastError = '';
    return {revision:Number(data.revision), requestId:uid('req')};
  }
  function applyComposeResult(node, response, canvasKind){
    if(!isLongImage(node) || !response?.file?.url) return false;
    const data = node.longImage;
    if(Number(response.revision) !== Number(data.revision)) return false;
    const byId = new Map((response.items || []).map(item => [String(item.item_id || ''), item]));
    data.items = (data.items || []).map(item => {
      const measured = byId.get(String(item.itemId || ''));
      return measured ? {
        ...item,
        naturalW:Number(measured.natural_w) || item.naturalW || 0,
        naturalH:Number(measured.natural_h) || item.naturalH || 0,
        fingerprint:String(measured.fingerprint || item.fingerprint || '')
      } : item;
    });
    const file = response.file;
    data.renderedRevision = Number(data.revision);
    data.status = 'ready';
    data.targetWidth = Number(file.natural_w) || Number(data.targetWidth) || 0;
    data.composite = {
      revision:Number(data.revision),
      url:String(file.url),
      name:String(file.name || 'long-image.png'),
      naturalW:Number(file.natural_w) || 0,
      naturalH:Number(file.natural_h) || 0,
      size:Number(file.size) || 0,
      format:'png',
      renderKey:String(response.render_key || '')
    };
    data.lastError = '';
    const image = {
      url:String(file.url), name:String(file.name || 'long-image.png'), kind:'image',
      natural_w:Number(file.natural_w) || 0, natural_h:Number(file.natural_h) || 0,
      longImageComposite:true
    };
    node.url = image.url;
    node.name = image.name;
    node.natural_w = image.natural_w;
    node.natural_h = image.natural_h;
    node.images = [image];
    if(canvasKind === 'smart') delete node.url;
    return true;
  }
  function applyComposeError(node, message){
    if(!isLongImage(node)) return;
    node.longImage.status = (node.longImage.items || []).length >= 2 ? 'error' : 'incomplete';
    node.longImage.lastError = String(message || '长图拼接失败').slice(0, 500);
    node.url = '';
    node.images = [];
  }
  function composePayload(node, request){
    const data = node.longImage;
    return {
      node_id:String(node.id || ''),
      request_id:String(request.requestId || ''),
      revision:Number(request.revision),
      target_width_mode:String(data.targetWidthMode || 'min-source'),
      target_width:data.targetWidthMode === 'custom' ? Math.round(asNumber(data.targetWidth)) : null,
      allow_upscale:Boolean(data.allowUpscale),
      items:(data.items || []).map(item => ({
        item_id:String(item.itemId || ''), url:String(item.url || ''),
        expected_fingerprint:String(item.fingerprint || '')
      }))
    };
  }
  async function responseError(response, fallback='操作失败'){
    try {
      const data = await response.json();
      return String(data?.detail || data?.error || fallback);
    } catch(_error){ return fallback; }
  }
  async function pluginEnabled(){
    try {
      const response = await fetch('/api/plugin-manager/plugins', {cache:'no-store'});
      if(!response.ok) return false;
      const data = await response.json();
      const record = (data.plugins || []).find(item => item.id === PLUGIN_ID);
      return Boolean(record?.enabled && record?.compatible && record?.backend_registered);
    } catch(_error){ return false; }
  }
  function html(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }
  function displayCompositeUrl(node, nativeUrl=''){
    if(nativeUrl) return String(nativeUrl);
    const data = node?.longImage || {};
    return String(data.composite?.url || data.lastGoodComposite?.url || '');
  }
  function displayCompositeSize(node){
    const data = node?.longImage || {};
    const composite = data.composite?.naturalW && data.composite?.naturalH
      ? data.composite : data.lastGoodComposite;
    const naturalW = Math.max(0, Number(composite?.naturalW) || 0);
    const naturalH = Math.max(0, Number(composite?.naturalH) || 0);
    return {naturalW, naturalH};
  }
  function displayCompositeName(node){
    const data = node?.longImage || {};
    const composite = data.composite?.url ? data.composite : data.lastGoodComposite;
    return String(composite?.name || 'long-image.png');
  }
  function nodeDisplayHeight(node, width, chromeHeight=0){
    const safeWidth = Math.max(120, Number(width) || 360);
    const {naturalW, naturalH} = displayCompositeSize(node);
    const imageHeight = naturalW > 0 && naturalH > 0
      ? Math.max(120, Math.round(safeWidth * naturalH / naturalW)) : 240;
    return Math.round(imageHeight + Math.max(0, Number(chromeHeight) || 0));
  }
  function longImageCanvasHtml(node, nativeUrl=''){
    const data = node.longImage || {};
    const displayUrl = displayCompositeUrl(node, nativeUrl);
    const statusText = {incomplete:'图片不足', dirty:'正在更新', building:'正在拼接…', ready:'双击编辑', error:'拼接失败'}[data.status] || '双击编辑';
    const visual = displayUrl
      ? `<img src="${html(displayUrl)}" alt="完整长图" draggable="false">`
      : `<div class="long-image-canvas-empty">${data.status === 'building' ? '正在生成长图…' : '双击打开编辑器'}</div>`;
    const download = displayUrl
      ? `<a class="long-image-canvas-download" data-long-image-download href="${html(displayUrl)}" download="${html(displayCompositeName(node))}" title="下载完整长图" aria-label="下载完整长图"><span>↓</span><span>下载</span></a>`
      : '';
    return `<div class="long-image-canvas-card" data-long-image-canvas="1">
      ${visual}${download}<span class="long-image-canvas-status ${html(data.status || '')}">${html(statusText)}</span>
    </div>`;
  }
  function longImageEditorHtml(node, nativeUrl=''){
    const data = node.longImage || {};
    const items = data.items || [];
    const statusText = {incomplete:'图片不足', dirty:'待更新', building:'拼接中…', ready:'已更新', error:'拼接失败'}[data.status] || '待更新';
    const {naturalW, naturalH} = displayCompositeSize(node);
    const size = naturalW && naturalH ? `${naturalW} × ${naturalH}` : '';
    const sourceHtml = items.map((item, index) => `
      <div class="long-image-source" data-long-image-index="${index}">
        <span class="long-image-grip" title="拖动排序">⋮⋮</span>
        <img src="${html(item.url)}" alt="" draggable="false">
        <span class="long-image-source-name" title="${html(item.name)}">${index + 1}. ${html(item.name || '图片')}</span>
        <button type="button" data-long-image-remove="${index}" title="移除">×</button>
      </div>`).join('');
    const displayUrl = displayCompositeUrl(node, nativeUrl);
    const preview = displayUrl
      ? `<div class="long-image-editor-preview"><img src="${html(displayUrl)}" alt="长图预览" draggable="false"></div>`
      : `<div class="long-image-empty"><span>${data.status === 'building' ? '正在生成长图…' : '调整顺序后点击重新生成'}</span></div>`;
    const error = data.lastError ? `<div class="long-image-error" title="${html(data.lastError)}">${html(data.lastError)}</div>` : '';
    const download = displayUrl
      ? `<a class="long-image-editor-download" data-long-image-download href="${html(displayUrl)}" download="${html(displayCompositeName(node))}" title="下载当前完整长图"><span>↓</span><span>下载长图</span></a>`
      : '';
    return `<div class="long-image-editor-dialog" role="dialog" aria-modal="true" aria-label="长图编辑器">
      <div class="long-image-editor-head">
        <div class="long-image-editor-title"><strong>长图编辑器</strong><span>拖动右侧图片调整前后顺序</span></div>
        <div class="long-image-editor-actions">${download}<button type="button" data-long-image-editor-close title="关闭">×</button></div>
      </div>
      <div class="long-image-editor-content">
        <section class="long-image-editor-preview-pane">
          ${preview}
          <div class="long-image-meta"><span>${items.length} 张 · ${statusText}</span><span>${html(size)}</span></div>
        </section>
        <section class="long-image-editor-control-pane">
          <div class="long-image-source-heading"><strong>组成图片</strong><span>拖到上半区插到前面，下半区插到后面 · 本地像素拼接，不调用 AI</span></div>
          <div class="long-image-sources">${sourceHtml}</div>
          <div class="long-image-settings">
            <select data-long-image-width-mode title="统一宽度">
              <option value="min-source" ${data.targetWidthMode !== 'custom' ? 'selected' : ''}>最小图片宽度</option>
              <option value="custom" ${data.targetWidthMode === 'custom' ? 'selected' : ''}>自定义宽度</option>
            </select>
            <input data-long-image-width type="number" min="64" max="8192" step="1" value="${html(data.targetWidth || '')}" placeholder="宽度" ${data.targetWidthMode === 'custom' ? '' : 'disabled'}>
            <label><input data-long-image-upscale type="checkbox" ${data.allowUpscale ? 'checked' : ''}>允许放大</label>
            <button type="button" data-long-image-build ${data.status === 'building' || items.length < 2 ? 'disabled' : ''}>${data.status === 'building' ? '生成中…' : '重新生成'}</button>
          </div>${error}
        </section>
      </div>
    </div>`;
  }
  return {
    SCHEMA_VERSION, PLUGIN_ID, clone, uid, isManagedImageUrl, isLongImage, isReady,
    normalizeSource, collectSources, createData, moveItem, sameOrder, markDirty,
    beginBuild, applyComposeResult, applyComposeError, composePayload, responseError,
    pluginEnabled, displayCompositeUrl, displayCompositeSize, displayCompositeName, nodeDisplayHeight,
    longImageCanvasHtml, longImageEditorHtml
  };
});
