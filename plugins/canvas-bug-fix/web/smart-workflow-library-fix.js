(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixSmartWorkflowLibrary';
    const BUTTON_ID = 'smartWorkflowExportLibraryBtn';
    let capturedPayload = null;

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function clonePayload(payload) {
        return payload ? JSON.parse(JSON.stringify(payload)) : null;
    }

    function capturePayload() {
        capturedPayload = typeof selectedSmartWorkflowPayload === 'function'
            ? clonePayload(selectedSmartWorkflowPayload())
            : null;
        document.documentElement.dataset.canvasBugFixSmartWorkflowNodeCount = String(capturedPayload?.nodes?.length || 0);
        return capturedPayload;
    }

    function defaultWorkflowAssetTarget() {
        const libs = typeof assetLibraries === 'function' ? assetLibraries() : [];
        let library = libs.find(item => item.id === activeAssetLibraryId) || libs[0] || null;
        let category = (library?.categories || []).find(item => String(item.type || '').toLowerCase() === 'workflow');
        if(!category) {
            library = libs.find(item => (item.categories || []).some(cat => String(cat.type || '').toLowerCase() === 'workflow')) || library;
            category = (library?.categories || []).find(item => String(item.type || '').toLowerCase() === 'workflow');
        }
        return {libraryId:library?.id || '', categoryId:category?.id || ''};
    }

    function setButtonState(state='idle', text='\u5bfc\u51fa\u5230\u8d44\u4ea7\u5e93') {
        const button = document.getElementById(BUTTON_ID);
        if(!button) return;
        button.disabled = state === 'busy';
        button.classList.toggle('busy', state === 'busy');
        button.classList.toggle('success', state === 'success');
        const icon = state === 'busy' ? 'loader-2' : state === 'success' ? 'check' : 'library-big';
        button.innerHTML = `<i data-lucide="${icon}"></i><span>${text}</span>`;
        typeof refreshIcons === 'function' && refreshIcons();
    }

    async function exportCapturedWorkflowToLibrary(payload=capturedPayload || capturePayload()) {
        if(!canvas || !payload?.nodes?.length) {
            typeof toast === 'function' && toast('\u672a\u9009\u62e9\u8282\u70b9\uff0c\u8bf7\u5148\u9009\u4e2d\u8981\u5bfc\u51fa\u7684\u7ec4\u4ef6');
            setStatus('selection-empty');
            return false;
        }
        try {
            setButtonState('busy', '\u5bfc\u51fa\u4e2d...');
            if(smartWorkflowExportMeta) {
                smartWorkflowExportMeta.classList.remove('success');
                smartWorkflowExportMeta.classList.add('busy');
                smartWorkflowExportMeta.textContent = '\u6b63\u5728\u5bfc\u51fa\u5230\u8d44\u4ea7\u5e93...';
            }
            if(!assetLibrary?.libraries?.length && typeof loadAssetLibrary === 'function') await loadAssetLibrary();
            const filename = typeof smartWorkflowFilename === 'function' ? smartWorkflowFilename('zip') : `smart-workflow-${Date.now()}.zip`;
            const target = defaultWorkflowAssetTarget();
            const response = await fetch('/api/canvas-workflows/export-to-library', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({...payload, include_resources:true, filename, name:filename.replace(/\.zip$/i, ''), library_id:target.libraryId, category_id:target.categoryId})
            });
            if(!response.ok) {
                const message = typeof responseErrorMessage === 'function'
                    ? await responseErrorMessage(response, '\u5bfc\u51fa\u5230\u8d44\u4ea7\u5e93\u5931\u8d25')
                    : '\u5bfc\u51fa\u5230\u8d44\u4ea7\u5e93\u5931\u8d25';
                throw new Error(message);
            }
            const data = await response.json();
            assetLibrary = data.library || assetLibrary;
            activeAssetLibraryId = target.libraryId || assetLibrary.active_library_id || activeAssetLibraryId;
            if(data.item) {
                for(const library of assetLibraries()) {
                    const category = (library.categories || []).find(cat => (cat.items || []).some(item => item.id === data.item.id));
                    if(category) { activeWorkflowAssetCategoryId = category.id; break; }
                }
            }
            typeof renderAssetLibrary === 'function' && renderAssetLibrary();
            if(smartWorkflowExportMeta) {
                smartWorkflowExportMeta.classList.remove('busy');
                smartWorkflowExportMeta.classList.add('success');
                smartWorkflowExportMeta.textContent = `\u5df2\u5bfc\u51fa\u5230\u8d44\u4ea7\u5e93\uff1a${data.item?.name || '\u5de5\u4f5c\u6d41'}`;
            }
            setButtonState('success', '\u5df2\u5bfc\u51fa');
            typeof toast === 'function' && toast(`\u5df2\u5bfc\u51fa\u5de5\u4f5c\u6d41\u5230\u8d44\u4ea7\u5e93\uff1a${data.item?.name || '\u5de5\u4f5c\u6d41'}`);
            setStatus('exported');
            setTimeout(() => setButtonState(), 1800);
            return true;
        } catch(error) {
            console.error('[canvas-bug-fix] smart workflow library export failed', error);
            smartWorkflowExportMeta?.classList.remove('busy', 'success');
            setButtonState();
            typeof toast === 'function' && toast(error?.message || '\u5bfc\u51fa\u5230\u8d44\u4ea7\u5e93\u5931\u8d25');
            setStatus('error');
            return false;
        }
    }

    function mount() {
        const actions = smartWorkflowExportMeta?.parentElement?.querySelector('.workflow-export-actions');
        if(!actions) { setStatus('target-missing'); return; }
        document.getElementById(BUTTON_ID)?.remove();
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = 'workflow-transfer-btn secondary';
        button.dataset.canvasInteractive = '1';
        button.innerHTML = '<i data-lucide="library-big"></i><span>\u5bfc\u51fa\u5230\u8d44\u4ea7\u5e93</span>';
        button.addEventListener('pointerdown', event => {
            event.stopPropagation();
            capturePayload();
        }, true);
        button.addEventListener('mousedown', event => event.stopPropagation(), true);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            exportCapturedWorkflowToLibrary();
        });
        actions.append(button);
        typeof refreshIcons === 'function' && refreshIcons();
        setStatus('active');
    }

    mount();
    window.CanvasBugFixSmartWorkflowLibrary = {capturePayload, defaultWorkflowAssetTarget, exportCapturedWorkflowToLibrary};
})();
