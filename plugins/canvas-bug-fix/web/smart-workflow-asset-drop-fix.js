(() => {
    'use strict';

    const MIME = 'application/x-smart-workflow-asset';
    const STATUS_KEY = 'canvasBugFixSmartWorkflowAssetDrop';
    let importing = false;
    let dragFallback = null;

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function workflowAssetPayload(card) {
        return {
            id:card?.dataset?.assetId || '',
            url:card?.dataset?.url || '',
            name:card?.dataset?.name || 'workflow',
            kind:'workflow'
        };
    }

    function dragTypes(dataTransfer) {
        return Array.from(dataTransfer?.types || []).map(value => String(value).toLowerCase());
    }

    function hasWorkflowAssetDrag(dataTransfer) {
        return dragTypes(dataTransfer).includes(MIME);
    }

    function workflowFilename(payload, blob) {
        const urlName = String(payload?.url || '').split('/').pop()?.split('?')[0] || '';
        let decoded = urlName;
        try { decoded = decodeURIComponent(urlName); } catch(_) {}
        const extension = /\.json$/i.test(decoded) ? '.json' : '.zip';
        const requested = String(payload?.name || '').trim() || decoded || `workflow${extension}`;
        return /\.(json|zip)$/i.test(requested) ? requested : `${requested}${extension}`;
    }

    function smartWorkflowOnly(imported) {
        const importedNodes = Array.isArray(imported?.nodes) ? imported.nodes.filter(Boolean) : [];
        if(!importedNodes.length) throw new Error('工作流中没有可导入的节点');
        const incompatible = importedNodes.some(node => !String(node?.type || '').startsWith('smart-'));
        if(incompatible) throw new Error('这个工作流属于普通画布，不能拖入智能画布');
        return imported;
    }

    function moveImportedNodesToPoint(existingIds, point) {
        if(typeof nodes === 'undefined') return [];
        const added = nodes.filter(node => !existingIds.has(node.id));
        if(!added.length) return [];
        if(!point) return added;
        const minX = Math.min(...added.map(node => Number(node.x || 0)));
        const minY = Math.min(...added.map(node => Number(node.y || 0)));
        const dx = Number(point.x || 0) - minX;
        const dy = Number(point.y || 0) - minY;
        added.forEach(node => {
            node.x = Number(node.x || 0) + dx;
            node.y = Number(node.y || 0) + dy;
        });
        if(typeof render === 'function') render();
        if(typeof scheduleSave === 'function') scheduleSave();
        return added;
    }

    async function importWorkflowAsset(payload, point=null) {
        if(importing || !payload?.url) return false;
        if(typeof canvas === 'undefined' || !canvas) {
            typeof toast === 'function' && toast('请先打开智能画布');
            return false;
        }
        importing = true;
        setStatus('importing');
        const existingIds = new Set((typeof nodes !== 'undefined' ? nodes : []).map(node => node.id));
        try {
            const assetResponse = await fetch(payload.url, {cache:'no-store'});
            if(!assetResponse.ok) throw new Error('读取工作流资产失败');
            const blob = await assetResponse.blob();
            const file = new File([blob], workflowFilename(payload, blob), {type:blob.type || 'application/octet-stream'});
            const form = new FormData();
            form.append('file', file);
            const response = await fetch('/api/canvas-workflows/import', {method:'POST', body:form});
            if(!response.ok) {
                const message = typeof responseErrorMessage === 'function'
                    ? await responseErrorMessage(response, '导入工作流失败')
                    : '导入工作流失败';
                throw new Error(message);
            }
            const data = await response.json();
            const imported = typeof normalizeImportedSmartWorkflow === 'function'
                ? normalizeImportedSmartWorkflow(data)
                : {nodes:data?.nodes || data?.workflow?.nodes || [], connections:data?.connections || data?.workflow?.connections || []};
            smartWorkflowOnly(imported);
            if(typeof insertSmartWorkflowIntoCanvas !== 'function') throw new Error('智能画布导入功能不可用');
            insertSmartWorkflowIntoCanvas(imported);
            const added = moveImportedNodesToPoint(existingIds, point);
            document.documentElement.dataset.canvasBugFixSmartWorkflowAssetImportedCount = String(added.length);
            setStatus('imported');
            return true;
        } catch(error) {
            console.error('[canvas-bug-fix] smart workflow asset import failed', error);
            typeof toast === 'function' && toast(error?.message || '导入工作流资产失败');
            document.documentElement.dataset.canvasBugFixSmartWorkflowAssetError = String(error?.message || error || '').slice(0, 160);
            setStatus('error');
            return false;
        } finally {
            importing = false;
        }
    }

    function bindCard(card) {
        if(!card || card.dataset.canvasBugFixWorkflowDrag === '1') return;
        card.dataset.canvasBugFixWorkflowDrag = '1';
        card.draggable = true;
        card.setAttribute('draggable', 'true');
        card.title = card.title || '拖入画布，或双击导入';
        card.addEventListener('dragstart', event => {
            const payload = workflowAssetPayload(card);
            if(!payload.url) { event.preventDefault(); return; }
            dragFallback = {payload, point:null, valid:false, handled:false};
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData(MIME, JSON.stringify(payload));
            event.dataTransfer.setData('text/plain', payload.url);
            const count = Number(document.documentElement.dataset.canvasBugFixSmartWorkflowAssetDragStartCount || 0) + 1;
            document.documentElement.dataset.canvasBugFixSmartWorkflowAssetDragStartCount = String(count);
            setStatus('dragging');
        });
        card.addEventListener('dragend', async () => {
            const fallback = dragFallback;
            dragFallback = null;
            if(fallback?.valid && !fallback.handled) {
                return importWorkflowAsset(fallback.payload, fallback.point);
            }
            if(!importing) setStatus('active');
        });
        card.addEventListener('dblclick', event => {
            if(event.target?.closest?.('button,input,textarea,select')) return;
            event.preventDefault();
            event.stopPropagation();
            importWorkflowAsset(workflowAssetPayload(card), null);
        });
    }

    function enhanceWorkflowCards(root=document) {
        root.querySelectorAll?.('.workflow-asset-item').forEach(bindCard);
    }

    function validCanvasDropTarget(target) {
        return Boolean(target?.closest?.('#shell')) && !target.closest('#assetPanel, #smartWorkflowTransferModal, #assetDialogBackdrop');
    }

    function onDragOver(event) {
        if(dragFallback) {
            dragFallback.valid = validCanvasDropTarget(event.target);
            dragFallback.point = dragFallback.valid && typeof screenToWorld === 'function' ? screenToWorld(event) : null;
            const count = Number(document.documentElement.dataset.canvasBugFixSmartWorkflowAssetDragOverCount || 0) + 1;
            document.documentElement.dataset.canvasBugFixSmartWorkflowAssetDragOverCount = String(count);
        }
        if(!hasWorkflowAssetDrag(event.dataTransfer) || !validCanvasDropTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        event.dataTransfer.dropEffect = 'copy';
    }

    async function onDrop(event) {
        if(!hasWorkflowAssetDrag(event.dataTransfer) || !validCanvasDropTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if(dragFallback) dragFallback.handled = true;
        const dropCount = Number(document.documentElement.dataset.canvasBugFixSmartWorkflowAssetDropCount || 0) + 1;
        document.documentElement.dataset.canvasBugFixSmartWorkflowAssetDropCount = String(dropCount);
        let payload = null;
        try { payload = JSON.parse(event.dataTransfer.getData(MIME) || '{}'); } catch(_) {}
        const point = typeof screenToWorld === 'function' ? screenToWorld(event) : null;
        await importWorkflowAsset(payload, point);
    }

    function mount() {
        const grid = document.getElementById('assetGrid');
        if(!grid) { setStatus('target-missing'); return; }
        enhanceWorkflowCards(grid);
        const observer = new MutationObserver(() => enhanceWorkflowCards(grid));
        observer.observe(grid, {childList:true, subtree:true});
        document.addEventListener('dragover', onDragOver, true);
        document.addEventListener('drop', onDrop, true);
        setStatus('active');
        window.CanvasBugFixSmartWorkflowAssetDropObserver = observer;
    }

    mount();
    window.CanvasBugFixSmartWorkflowAssetDrop = {
        workflowAssetPayload,
        hasWorkflowAssetDrag,
        smartWorkflowOnly,
        moveImportedNodesToPoint,
        importWorkflowAsset,
        enhanceWorkflowCards,
        onDragOver,
        onDrop
    };
})();
