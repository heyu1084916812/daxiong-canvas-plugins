(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixAltDragSmart';

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function duplicateSelectedForAltDrag(node) {
        const requestedIds = isNodeSelected(node.id) ? selectedNodeIds() : [node.id];
        const sourceIds = new Set();
        const sourceNodes = [];
        const collectSource = source => {
            if(!source || sourceIds.has(source.id)) return;
            sourceIds.add(source.id);
            sourceNodes.push(source);
            if(isSmartGroupNode(source)) smartGroupMembers(source).forEach(collectSource);
        };
        requestedIds.map(id => nodes.find(item => item.id === id)).forEach(collectSource);
        if(!sourceNodes.length) return node;

        pushUndo();
        const idMap = new Map();
        const copies = sourceNodes.map(source => {
            const copy = cloneSmartNode(source, 0, 0);
            idMap.set(source.id, copy.id);
            return copy;
        });
        copies.forEach(copy => {
            if(isSmartGroupNode(copy) && Array.isArray(copy.items)){
                copy.items = copy.items.map(id => idMap.get(id) || id);
            }
            if(Array.isArray(copy.inputNodeIds)){
                copy.inputNodeIds = copy.inputNodeIds.map(id => idMap.get(id) || id).filter(Boolean);
            }
            if(copy.sourceNodeId) copy.sourceNodeId = idMap.get(copy.sourceNodeId) || copy.sourceNodeId;
        });

        const newConnections = (canvas.connections || [])
            .filter(connection => sourceIds.has(connection.from) || sourceIds.has(connection.to))
            .map(connection => ({
                ...connection,
                from:idMap.get(connection.from) || connection.from,
                to:idMap.get(connection.to) || connection.to
            }))
            .filter(connection => connection.from && connection.to && connection.from !== connection.to);
        const nextConnections = [...(canvas.connections || [])];
        newConnections.forEach(connection => {
            const kind = connection.kind || 'flow';
            if(nextConnections.some(existing => existing.from === connection.from && existing.to === connection.to && (existing.kind || 'flow') === kind)) return;
            nextConnections.push(connection);
            const toNode = nodes.find(item => item.id === connection.to) || copies.find(item => item.id === connection.to);
            if(toNode && kind === 'input'){
                toNode.inputNodeIds = Array.from(new Set([...(toNode.inputNodeIds || []), connection.from]));
            }
        });
        canvas.connections = nextConnections;
        nodes.push(...copies);

        const selectedCopyIds = requestedIds.map(id => idMap.get(id)).filter(Boolean);
        selectedId = selectedCopyIds.length === 1 ? selectedCopyIds[0] : '';
        selectedIds = selectedCopyIds.length > 1 ? selectedCopyIds : [];
        selectedImage = {nodeId:'', index:-1};
        const dragCopy = copies.find(copy => copy.id === idMap.get(node.id)) || copies[0];
        render();
        scheduleSave();
        return dragCopy;
    }

    function mount() {
        if(typeof duplicateForAltDrag !== 'function' || typeof cloneSmartNode !== 'function' || typeof selectedNodeIds !== 'function'){
            setStatus('incompatible');
            return;
        }
        duplicateForAltDrag = duplicateSelectedForAltDrag;
        window.CanvasBugFixAltDragSmart = {duplicateSelectedForAltDrag};
        setStatus('active');
    }

    mount();
})();
