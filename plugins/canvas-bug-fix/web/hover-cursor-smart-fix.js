(() => {
    'use strict';

    const STYLE_ID = 'canvas-bug-fix-hover-cursor-smart';
    if(document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        /* Smart canvas nodes use the canvas mouse handlers, not native HTML
           dragging. Keep hover on a node out of Chromium's no-drop state. */
        .image-node,
        .image-node > .node-head,
        .image-node > .node-body,
        .image-node .node-img,
        .image-node .thumb-item,
        .image-node .smart-node-floating-menu {
            -webkit-user-drag: none !important;
        }
        .image-node,
        .image-node > .node-head,
        .image-node > .node-body,
        .image-node .node-img,
        .image-node .smart-node-floating-menu {
            cursor: default !important;
        }
        .image-node button,
        .image-node select,
        .image-node label { cursor: pointer !important; }
        .image-node input,
        .image-node textarea,
        .image-node [contenteditable="true"] { cursor: text !important; }
        .image-node .node-port { cursor: crosshair !important; }
        .image-node .node-resize-handle { cursor: nwse-resize !important; }
        .image-node .thumb-item { cursor: pointer !important; }
    `;
    document.head.appendChild(style);
    document.documentElement.dataset.canvasBugFixHoverCursorSmart = 'active';
})();
