(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixClassicLoopConnectedOnly';

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function downstreamIdsFromLoop(loopId) {
        const found = new Set();
        const queue = [loopId];
        while(queue.length) {
            const current = queue.shift();
            connections.filter(conn => conn.from === current).forEach(conn => {
                if(found.has(conn.to)) return;
                found.add(conn.to);
                queue.push(conn.to);
            });
        }
        return found;
    }

    function connectedLoopOrder(targetId, originalOrder) {
        const loop = typeof resolveCascadeLoop === 'function' ? resolveCascadeLoop(targetId) : null;
        if(!loop?.node?.id) return originalOrder;
        const downstream = downstreamIdsFromLoop(loop.node.id);
        return (originalOrder || []).filter(id => downstream.has(id));
    }

    function mount() {
        if(typeof computeCascadeOrder !== 'function') {
            setStatus('incompatible');
            return;
        }
        if(computeCascadeOrder.__canvasBugFixConnectedOnly) {
            setStatus('active');
            return;
        }
        const originalComputeCascadeOrder = computeCascadeOrder;
        const patched = function(targetId) {
            return connectedLoopOrder(targetId, originalComputeCascadeOrder(targetId));
        };
        patched.__canvasBugFixConnectedOnly = true;
        patched.__original = originalComputeCascadeOrder;
        computeCascadeOrder = patched;
        setStatus('active');
    }

    mount();
    window.CanvasBugFixClassicLoopConnectedOnly = {downstreamIdsFromLoop, connectedLoopOrder};
})();
