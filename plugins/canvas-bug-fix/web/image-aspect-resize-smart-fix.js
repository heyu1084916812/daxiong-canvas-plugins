(() => {
    'use strict';
    const status = value => { document.documentElement.dataset.canvasBugFixImageAspectSmart = value; };
    if(typeof nodes === 'undefined' || typeof nodeRect !== 'function') { status('incompatible'); return; }

    // The native handler owns undo/save. This independent layer adds the image
    // ratio to its resize transaction and corrects each rendered frame.
    document.addEventListener('mousedown', event => {
        const handle = event.target?.closest?.('.image-node .node-resize-handle');
        if(!handle || event.button !== 0) return;
        const element = handle.closest('.image-node');
        const node = nodes.find(item => item.id === element?.dataset?.id);
        const image = node && typeof isSmartImageNode === 'function' && isSmartImageNode(node)
            ? (node.images || []).find(item => item?.url) : null;
        if(!node || !image) return;
        const rect = nodeRect(node);
        const naturalWidth = Number(image.natural_w || image.width || 0);
        const naturalHeight = Number(image.natural_h || image.height || 0);
        const aspect = naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : rect.width / rect.height;
        queueMicrotask(() => { if(resizeState?.id === node.id) resizeState.aspect = aspect; });
    }, true);
    window.addEventListener('mousemove', () => queueMicrotask(() => {
        if(!(resizeState?.aspect > 0)) return;
        const node = nodes.find(item => item.id === resizeState.id);
        if(!node || !(typeof isSmartImageNode === 'function' && isSmartImageNode(node))) return;
        node.h = Math.max(96, Math.round(Number(node.w || resizeState.startW) / resizeState.aspect));
        typeof updateNodeElementDuringResize === 'function' && updateNodeElementDuringResize(node);
    }), true);
    status('active');
})();
