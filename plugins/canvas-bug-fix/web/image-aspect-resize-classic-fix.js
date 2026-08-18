(() => {
    'use strict';
    const status = value => { document.documentElement.dataset.canvasBugFixImageAspectClassic = value; };
    if(typeof startNodeResize !== 'function' || typeof onNodeResize !== 'function') { status('incompatible'); return; }

    startNodeResize = function fixedImageAspectStart(event, node){
        event.preventDefault();
        event.stopPropagation();
        const element = nodesEl.querySelector(`.node[data-id="${node.id}"]`);
        const rect = element?.getBoundingClientRect();
        const width = rect?.width ? rect.width / viewport.scale : node.w || defaultNodeSize(node.type).w;
        const height = rect?.height ? rect.height / viewport.scale : node.h || defaultNodeSize(node.type).h || 160;
        const naturalWidth = Number(node.natural_w || node.naturalWidth || 0);
        const naturalHeight = Number(node.natural_h || node.naturalHeight || 0);
        resizeNode = {node, sx:event.clientX, sy:event.clientY, sw:width, sh:height,
            aspect:node.type === 'image' ? (naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : width / height) : 0,
            moved:false};
        document.body.classList.add('canvas-node-resize');
        window.onmousemove = onNodeResize;
        window.onmouseup = endDrag;
    };
    onNodeResize = function fixedImageAspectMove(event){
        if(!resizeNode) return;
        if(!resizeNode.moved){ pushUndo(); resizeNode.moved = true; }
        const min = defaultNodeSize(resizeNode.node.type);
        let width = Math.max(Math.min(min.w, 220), resizeNode.sw + (event.clientX - resizeNode.sx) / viewport.scale);
        let height = Math.max(96, resizeNode.sh + (event.clientY - resizeNode.sy) / viewport.scale);
        if(resizeNode.aspect > 0){
            const scale = Math.max(width / resizeNode.sw, height / resizeNode.sh);
            width = Math.max(Math.min(min.w, 220), resizeNode.sw * scale);
            height = Math.max(96, width / resizeNode.aspect);
        }
        resizeNode.node.w = Math.round(width); resizeNode.node.h = Math.round(height);
        const element = nodesEl.querySelector(`.node[data-id="${resizeNode.node.id}"]`);
        if(element){ element.classList.add('sized'); element.style.width = `${resizeNode.node.w}px`; element.style.height = `${resizeNode.node.h}px`; }
        scheduleLinksRender(); renderSelectionHub(); scheduleMinimapRender();
    };
    status('active');
})();
