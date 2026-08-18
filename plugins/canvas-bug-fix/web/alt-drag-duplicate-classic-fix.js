(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixAltDragClassic';

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function duplicateSelectedForAltDrag(node) {
        const requestedIds = selected.has(node.id) ? [...selected] : [node.id];
        const sourceIds = new Set();
        const sourceNodes = [];
        const collectSource = source => {
            if(!source || sourceIds.has(source.id)) return;
            sourceIds.add(source.id);
            sourceNodes.push(source);
            if(source.type === 'group' || source.type === 'promptGroup'){
                (source.items || []).map(id => nodes.find(item => item.id === id)).forEach(collectSource);
            }
        };
        requestedIds.map(id => nodes.find(item => item.id === id)).forEach(collectSource);
        if(!sourceNodes.length) return {dragCopy:node, selectedCopies:[], copies:[]};

        pushUndo();
        const idMap = new Map();
        const copies = sourceNodes.map(source => {
            const copy = cloneNode(source, 0, 0);
            idMap.set(source.id, copy.id);
            return copy;
        });
        copies.forEach(copy => {
            if((copy.type === 'group' || copy.type === 'promptGroup') && Array.isArray(copy.items)){
                copy.items = copy.items.map(id => idMap.get(id) || id);
            }
        });
        nodes.push(...copies);

        const copiedConnections = (connections || [])
            .filter(connection => sourceIds.has(connection.from) || sourceIds.has(connection.to))
            .map(connection => ({
                ...connection,
                id:uid('c'),
                from:idMap.get(connection.from) || connection.from,
                to:idMap.get(connection.to) || connection.to
            }))
            .filter(connection => connection.from && connection.to && connection.from !== connection.to);
        copiedConnections.forEach(connection => {
            if(canConnect(connection.from, connection.to) && !connections.some(existing => existing.from === connection.from && existing.to === connection.to)){
                connections.push(connection);
            }
        });

        return {
            dragCopy:copies.find(copy => copy.id === idMap.get(node.id)) || copies[0],
            selectedCopies:requestedIds.map(id => idMap.get(id)).filter(Boolean),
            copies
        };
    }

    function fixedStartNodeDrag(event, node) {
        if(event.button !== 0) return;
        if(startKnifeDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        let dragTarget = node;
        const isGroup = dragTarget.type === 'group' || dragTarget.type === 'promptGroup';
        const collected = new Map();
        const collect = current => {
            if(!current || collected.has(current.id) || current.id === dragTarget.id) return;
            collected.set(current.id, {node:current, ox:current.x, oy:current.y});
            if(current.type === 'group' || current.type === 'promptGroup'){
                (current.items || []).map(id => nodes.find(item => item.id === id)).forEach(collect);
            }
        };
        if(isGroup) (dragTarget.items || []).map(id => nodes.find(item => item.id === id)).forEach(collect);
        if(selected.has(dragTarget.id) && selected.size > 1){
            [...selected].forEach(id => collect(nodes.find(item => item.id === id)));
        }
        const children = [...collected.values()];
        dragNode = {node:dragTarget, children, sx:event.clientX, sy:event.clientY, ox:dragTarget.x, oy:dragTarget.y, moved:false, copyOnMove:Boolean(event.altKey), copyPreserveConnections:Boolean(event.shiftKey), copyFactory:duplicateSelectedForAltDrag};
        document.body.classList.add('canvas-node-drag');
        window.onmousemove = onNodeDrag;
        window.onmouseup = endDrag;
    }

    function mount() {
        if(typeof startNodeDrag !== 'function' || typeof cloneNode !== 'function' || typeof selected === 'undefined'){
            setStatus('incompatible');
            return;
        }
        duplicateNodesForAltDrag = duplicateSelectedForAltDrag;
        startNodeDrag = fixedStartNodeDrag;
        window.CanvasBugFixAltDragClassic = {duplicateSelectedForAltDrag, fixedStartNodeDrag};
        document.documentElement.dataset.canvasBugFixAltDragClassicRevision = 'deferred-v2';
        setStatus('active');
    }

    mount();
})();
