(() => {
    'use strict';
    const editable = target => Boolean(target?.closest?.('input,textarea,[contenteditable="true"]'));
    document.addEventListener('keydown', event => {
        if(!(event.ctrlKey || event.metaKey) || editable(event.target)) return;
        const key = String(event.key || '').toLowerCase();
        if(key === 'c' && typeof copySelectedNodes === 'function'){
            copySelectedNodes();
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    document.documentElement.dataset.canvasBugFixCopyPasteSmart = 'active';
})();
