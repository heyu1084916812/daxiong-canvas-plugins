(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixClassicLlmPaneResize';
    const STYLE_ID = 'canvasBugFixClassicLlmPaneResizeStyle';
    const MIN_PANE_HEIGHT = 70;
    const MIN_NODE_HEIGHT = 360;
    let drag = null;

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function numericHeight(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= MIN_PANE_HEIGHT ? Math.round(parsed) : fallback;
    }

    function paneDefinitions(wrap, node) {
        return [
            {
                key:'llmSystemHeight',
                pane:wrap.querySelector('.llm-system'),
                fallback:74,
                label:'System'
            },
            {
                key:'llmInputHeight',
                pane:wrap.querySelector('.llm-input-output'),
                fallback:110,
                label:'Input'
            },
            {
                key:'llmOutputHeight',
                pane:wrap.querySelector('.llm-output-wrap'),
                fallback:150,
                label:'Output'
            }
        ].filter(item => item.pane);
    }

    function setPaneHeight(pane, height) {
        const next = Math.max(MIN_PANE_HEIGHT, Math.round(Number(height) || MIN_PANE_HEIGHT));
        pane.style.setProperty('height', `${next}px`, 'important');
        pane.style.setProperty('min-height', `${next}px`, 'important');
        pane.style.setProperty('flex', `0 0 ${next}px`, 'important');
        return next;
    }

    function viewportScale() {
        const scale = typeof viewport !== 'undefined' ? Number(viewport?.scale) : 1;
        return Number.isFinite(scale) && scale > 0 ? scale : 1;
    }

    function beginResize(event, node, definition) {
        if(event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const nodeElement = definition.pane.closest('.node');
        const startPaneHeight = definition.pane.getBoundingClientRect().height / viewportScale();
        const storedNodeHeight = Number(node.h || 0);
        const measuredNodeHeight = nodeElement ? nodeElement.getBoundingClientRect().height / viewportScale() : 0;
        drag = {
            node,
            definition,
            nodeElement,
            startY:event.clientY,
            startPaneHeight:Math.max(MIN_PANE_HEIGHT, startPaneHeight),
            startNodeHeight:Math.max(MIN_NODE_HEIGHT, storedNodeHeight || measuredNodeHeight || MIN_NODE_HEIGHT)
        };
        document.body.classList.add('canvas-bug-fix-llm-resizing');
        document.addEventListener('pointermove', continueResize, true);
        document.addEventListener('pointerup', finishResize, true);
        document.addEventListener('pointercancel', finishResize, true);
    }

    function continueResize(event) {
        if(!drag) return;
        event.preventDefault();
        event.stopPropagation();
        const delta = (event.clientY - drag.startY) / viewportScale();
        const paneHeight = setPaneHeight(drag.definition.pane, drag.startPaneHeight + delta);
        const actualDelta = paneHeight - drag.startPaneHeight;
        const nodeHeight = Math.max(MIN_NODE_HEIGHT, Math.round(drag.startNodeHeight + actualDelta));
        drag.node[drag.definition.key] = paneHeight;
        drag.node.h = nodeHeight;
        if(drag.nodeElement) drag.nodeElement.style.height = `${nodeHeight}px`;
        document.documentElement.dataset.canvasBugFixClassicLlmLastPane = drag.definition.key;
        document.documentElement.dataset.canvasBugFixClassicLlmLastHeight = String(paneHeight);
    }

    function finishResize(event) {
        if(!drag) return;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        drag = null;
        document.body.classList.remove('canvas-bug-fix-llm-resizing');
        document.removeEventListener('pointermove', continueResize, true);
        document.removeEventListener('pointerup', finishResize, true);
        document.removeEventListener('pointercancel', finishResize, true);
        if(typeof scheduleSave === 'function') scheduleSave();
    }

    function createHandle(node, definition) {
        const handle = document.createElement('div');
        handle.className = 'canvas-bug-fix-llm-pane-handle';
        handle.dataset.pane = definition.key;
        handle.dataset.canvasInteractive = '1';
        handle.title = `拖动调整 ${definition.label} 区域高度`;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'horizontal');
        handle.addEventListener('pointerdown', event => beginResize(event, node, definition), true);
        handle.addEventListener('mousedown', event => event.stopPropagation(), true);
        handle.addEventListener('click', event => event.stopPropagation(), true);
        definition.pane.insertAdjacentElement('afterend', handle);
        return handle;
    }

    function enhanceLLMBody(wrap, node) {
        if(!wrap || !node || wrap.dataset.canvasBugFixLlmResizable === '1') return wrap;
        wrap.dataset.canvasBugFixLlmResizable = '1';
        paneDefinitions(wrap, node).forEach(definition => {
            const height = numericHeight(node[definition.key], definition.fallback);
            setPaneHeight(definition.pane, height);
            createHandle(node, definition);
        });
        return wrap;
    }

    function installStyles() {
        if(document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .llm-node .llm-pane-resizer { display:none !important; }
            .llm-node .canvas-bug-fix-llm-pane-handle {
                box-sizing:border-box;
                width:100%;
                height:12px;
                flex:0 0 12px;
                display:flex;
                align-items:center;
                justify-content:center;
                cursor:ns-resize;
                touch-action:none;
            }
            .llm-node .canvas-bug-fix-llm-pane-handle::before {
                content:"";
                width:52px;
                height:3px;
                border-radius:999px;
                background:#cbd5e1;
                opacity:.72;
                transition:opacity .14s, background .14s;
            }
            .llm-node .canvas-bug-fix-llm-pane-handle:hover::before {
                opacity:1;
                background:#64748b;
            }
            .node.sized.llm-node .llm-output-wrap {
                flex:0 0 auto !important;
                min-height:70px;
            }
            body.canvas-bug-fix-llm-resizing,
            body.canvas-bug-fix-llm-resizing * {
                cursor:ns-resize !important;
                user-select:none !important;
            }
        `;
        document.head.appendChild(style);
    }

    function mount() {
        installStyles();
        if(typeof renderLLMBody !== 'function') {
            setStatus('incompatible');
            return;
        }
        if(renderLLMBody.__canvasBugFixPaneResize) {
            setStatus('active');
            return;
        }
        const originalRenderLLMBody = renderLLMBody;
        const patchedRenderLLMBody = function(node) {
            return enhanceLLMBody(originalRenderLLMBody(node), node);
        };
        patchedRenderLLMBody.__canvasBugFixPaneResize = true;
        patchedRenderLLMBody.__original = originalRenderLLMBody;
        renderLLMBody = patchedRenderLLMBody;
        setStatus('active');
    }

    mount();
    window.CanvasBugFixClassicLLMPaneResize = {
        numericHeight,
        setPaneHeight,
        enhanceLLMBody,
        beginResize,
        continueResize,
        finishResize
    };
})();
