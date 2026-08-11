(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixArrangeSelected';
    let savedSelection = [];

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function setCount(name, value) {
        document.documentElement.dataset[name] = String(value ?? 0);
    }

    function captureSelection() {
        savedSelection = typeof selectedNodeIds === 'function' ? selectedNodeIds() : [];
        setCount('canvasBugFixArrangeCapturedCount', savedSelection.length);
        return savedSelection.slice();
    }

    function restoreSelection(ids) {
        const existing = (ids || []).filter(id => nodes.some(node => node.id === id));
        selectedIds = existing.length > 1 ? existing : [];
        selectedId = existing.length === 1 ? existing[0] : '';
        selectedImage = {nodeId:'', index:-1};
        return existing;
    }

    function selectedGroupForArrange(selected) {
        if(typeof isSmartGroupNode !== 'function') return null;
        const direct = selected?.length === 1 && typeof selectedNode === 'function' ? selectedNode() : null;
        if(isSmartGroupNode(direct)) return direct;
        if(typeof smartGroupContainingNode !== 'function' || !selected?.length) return null;
        const groups = selected.map(id => smartGroupContainingNode(id));
        return groups.length === selected.length && groups.every(group => group && group.id === groups[0]?.id) ? groups[0] : null;
    }

    function arrangePreservedSelection(ids) {
        const selected = restoreSelection(ids);
        setCount('canvasBugFixArrangeExistingCount', selected.length);
        const group = selectedGroupForArrange(selected);
        if(group) {
            const arranged = typeof arrangeSmartGroupMembers === 'function' && arrangeSmartGroupMembers(group);
            if(arranged) {
                typeof render === 'function' && render();
                typeof scheduleSave === 'function' && scheduleSave();
                typeof toast === 'function' && toast('\u5df2\u6574\u7406\u5206\u7ec4\u5185\u8282\u70b9');
                setStatus('group-arranged');
            } else {
                typeof toast === 'function' && toast('\u5206\u7ec4\u5185\u6ca1\u6709\u53ef\u6574\u7406\u7684\u8282\u70b9');
                setStatus('group-empty');
            }
            return arranged;
        }
        if(selected.length < 1) {
            typeof toast === 'function' && toast('\u8bf7\u5148\u9009\u62e9\u9700\u8981\u6574\u7406\u7684\u8282\u70b9');
            setStatus('selection-empty');
            return false;
        }
        const atomic = typeof smartArrangeAtomicIds === 'function' ? smartArrangeAtomicIds(selected) : selected;
        setCount('canvasBugFixArrangeAtomicCount', atomic.length);
        if(atomic.length < 2) {
            typeof toast === 'function' && toast('\u5f53\u524d\u9009\u4e2d\u9879\u5c5e\u4e8e\u540c\u4e00\u4e2a\u6574\u7406\u5355\u5143');
            setStatus('single-atomic-unit');
            return false;
        }
        if(typeof arrangeSmartIdsByConnections !== 'function') {
            typeof toast === 'function' && toast('\u6574\u7406\u529f\u80fd\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u753b\u5e03\u540e\u91cd\u8bd5');
            setStatus('unavailable');
            return false;
        }
        if(typeof pushUndo === 'function') pushUndo();
        const arranged = arrangeSmartIdsByConnections(atomic);
        if(!arranged) {
            typeof toast === 'function' && toast('\u6ca1\u6709\u627e\u5230\u53ef\u91cd\u6392\u7684\u8282\u70b9');
            setStatus('arrange-rejected');
            return false;
        }
        typeof render === 'function' && render();
        restoreSelection(selected);
        typeof syncSelectionUi === 'function' && syncSelectionUi();
        typeof scheduleSave === 'function' && scheduleSave();
        typeof toast === 'function' && toast('\u5df2\u6574\u7406\u9009\u4e2d\u8282\u70b9');
        setStatus('ordinary-arranged');
        return true;
    }

    function stopCanvasClear(event) {
        event.stopPropagation();
    }

    function isArrangeEvent(event) {
        return Boolean(event.target?.closest?.('#smartArrangeBtn'));
    }

    function reportFailure(error) {
        const message = String(error?.message || error || '\u672a\u77e5\u9519\u8bef').slice(0, 120);
        console.error('[canvas-bug-fix] smart arrange failed', error);
        document.documentElement.dataset.canvasBugFixArrangeError = message;
        setStatus('error');
        typeof toast === 'function' && toast(`\u6574\u7406\u5931\u8d25\uff1a${message}`);
    }

    function mount() {
        // 清掉旧版本注入的独立按钮；以后只修复原生“整理选中”。
        document.getElementById('canvasBugFixArrangeSelectedButton')?.remove();
        document.getElementById('canvasBugFixArrangeSelectedStyle')?.remove();

        const button = document.getElementById('smartArrangeBtn');
        if(!button) { setStatus('native-button-missing'); return; }
        button.dataset.canvasInteractive = '1';
        document.addEventListener('pointerdown', event => {
            if(!isArrangeEvent(event)) return;
            captureSelection();
            stopCanvasClear(event);
        }, true);
        document.addEventListener('mousedown', event => {
            if(!isArrangeEvent(event)) return;
            captureSelection();
            stopCanvasClear(event);
        }, true);
        document.addEventListener('mouseup', event => {
            if(isArrangeEvent(event)) stopCanvasClear(event);
        }, true);
        document.addEventListener('click', event => {
            if(!isArrangeEvent(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            try {
                const selection = savedSelection.length ? savedSelection.slice() : captureSelection();
                arrangePreservedSelection(selection);
            } catch(error) {
                reportFailure(error);
            }
        }, true);
        setStatus('active');
    }

    mount();
    window.CanvasBugFixArrangeSelected = {captureSelection, restoreSelection, selectedGroupForArrange, arrangePreservedSelection};
})();
