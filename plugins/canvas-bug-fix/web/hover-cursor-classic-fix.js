(() => {
    'use strict';

    const STYLE_ID = 'canvas-bug-fix-hover-cursor-classic';
    if(document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        /* Classic canvas dragging is implemented with mouse events. Do not let
           Chromium expose a native drag/no-drop cursor over ordinary nodes. */
        .node,
        .node > .node-head,
        .node > .node-body,
        .node .image-preview-wrap,
        .node .image-preview-wrap img,
        .node .local-patch-image-toolbar {
            -webkit-user-drag: none !important;
        }
        .node,
        .node > .node-head,
        .node > .node-body,
        .node .image-preview-wrap,
        .node .image-preview-wrap img,
        .node .local-patch-image-toolbar {
            cursor: default !important;
        }
        .node button,
        .node select,
        .node label,
        .node .local-patch-image-toolbar button { cursor: pointer !important; }
        .node input,
        .node textarea,
        .node [contenteditable="true"] { cursor: text !important; }
        .node .port { cursor: crosshair !important; }
        .node .resize-handle { cursor: nwse-resize !important; }
    `;
    document.head.appendChild(style);
    document.documentElement.dataset.canvasBugFixHoverCursorClassic = 'active';
})();
