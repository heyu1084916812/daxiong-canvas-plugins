(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixArrangeSelectedClassic';
    let savedSelection = [];

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function captureSelection() {
        savedSelection = typeof selected !== 'undefined' ? [...selected] : [];
        document.documentElement.dataset.canvasBugFixArrangeClassicCapturedCount = String(savedSelection.length);
        return savedSelection.slice();
    }

    function restoreSelection(ids) {
        const existing = (ids || []).filter(id => nodes.some(node => node.id === id));
        selected.clear();
        existing.forEach(id => selected.add(id));
        return existing;
    }

    function arrangePreservedSelection(ids) {
        const explicit = restoreSelection(ids);
        if(!explicit.length) {
            typeof toast === 'function' && toast('\u8bf7\u5148\u9009\u62e9\u9700\u8981\u6574\u7406\u7684\u8282\u70b9');
            setStatus('selection-empty');
            return false;
        }
        const candidates = explicit.length > 1
            ? explicit
            : (typeof connectedClusterIds === 'function' ? connectedClusterIds(explicit[0]) : explicit);
        const atomic = typeof canvasArrangeAtomicIds === 'function' ? canvasArrangeAtomicIds(candidates) : candidates;
        document.documentElement.dataset.canvasBugFixArrangeClassicAtomicCount = String(atomic.length);
        if(atomic.length < 2) {
            typeof toast === 'function' && toast('\u5f53\u524d\u53ea\u6709\u4e00\u4e2a\u53ef\u6574\u7406\u5355\u5143');
            setStatus('single-atomic-unit');
            return false;
        }
        if(typeof arrangeIdsByConnections !== 'function') {
            typeof toast === 'function' && toast('\u6574\u7406\u529f\u80fd\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u753b\u5e03\u540e\u91cd\u8bd5');
            setStatus('unavailable');
            return false;
        }
        if(typeof pushUndo === 'function') pushUndo();
        if(!arrangeIdsByConnections(atomic)) {
            typeof toast === 'function' && toast('\u6ca1\u6709\u627e\u5230\u53ef\u91cd\u6392\u7684\u8282\u70b9');
            setStatus('arrange-rejected');
            return false;
        }
        typeof render === 'function' && render();
        restoreSelection(explicit);
        typeof refreshSelectionVisuals === 'function' && refreshSelectionVisuals();
        typeof scheduleSave === 'function' && scheduleSave();
        typeof toast === 'function' && toast('\u5df2\u6574\u7406\u9009\u4e2d\u8282\u70b9');
        setStatus('arranged');
        return true;
    }

    function isArrangeEvent(event) {
        return Boolean(event.target?.closest?.('#canvasArrangeBtn'));
    }

    function reportFailure(error) {
        const message = String(error?.message || error || '\u672a\u77e5\u9519\u8bef').slice(0, 120);
        console.error('[canvas-bug-fix] classic arrange failed', error);
        document.documentElement.dataset.canvasBugFixArrangeClassicError = message;
        setStatus('error');
        typeof toast === 'function' && toast(`\u6574\u7406\u5931\u8d25\uff1a${message}`);
    }

    function mount() {
        const button = document.getElementById('canvasArrangeBtn');
        if(!button) { setStatus('native-button-missing'); return; }
        button.dataset.canvasInteractive = '1';
        document.addEventListener('pointerdown', event => {
            if(!isArrangeEvent(event)) return;
            captureSelection();
            event.stopPropagation();
        }, true);
        document.addEventListener('mousedown', event => {
            if(!isArrangeEvent(event)) return;
            captureSelection();
            event.stopPropagation();
        }, true);
        document.addEventListener('mouseup', event => {
            if(isArrangeEvent(event)) event.stopPropagation();
        }, true);
        document.addEventListener('click', event => {
            if(!isArrangeEvent(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            try {
                arrangePreservedSelection(savedSelection.length ? savedSelection.slice() : captureSelection());
            } catch(error) {
                reportFailure(error);
            }
        }, true);
        setStatus('active');
    }

    mount();
    window.CanvasBugFixArrangeSelectedClassic = {captureSelection, restoreSelection, arrangePreservedSelection};
})();
