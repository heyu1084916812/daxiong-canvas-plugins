(() => {
    'use strict';
    const status = value => { document.documentElement.dataset.canvasBugFixUngroupClassic = value; };
    if(typeof groupSelectedImages !== 'function' || typeof ungroupCanvasGroup !== 'function') { status('incompatible'); return; }
    const nativeGroup = groupSelectedImages;
    const nativeUngroup = ungroupCanvasGroup;
    const snapshot = children => {
        const ids = new Set(children.map(node => node.id));
        return {version:1, nodes:children.map(node => JSON.parse(JSON.stringify(serializableCanvasNode(node)))),
            connections:(connections || []).filter(conn => ids.has(conn.from) || ids.has(conn.to)).map(conn => JSON.parse(JSON.stringify(conn)))};
    };
    groupSelectedImages = function fixedGroupSelectedImages(){
        const before = [...selected].map(id => nodes.find(node => node.id === id)).filter(Boolean);
        const restore = before.length ? snapshot(before) : null;
        const result = nativeGroup.apply(this, arguments);
        const group = [...selected].map(id => nodes.find(node => node.id === id)).find(node => node?.type === 'group' || node?.type === 'promptGroup');
        if(group && restore && !group.ungroupRestore) group.ungroupRestore = restore;
        return result;
    };
    ungroupCanvasGroup = function fixedUngroupCanvasGroup(groupId, event=null){
        const group = nodes.find(node => node.id === groupId && (node.type === 'group' || node.type === 'promptGroup'));
        const restore = group?.ungroupRestore;
        if(!group || !restore?.nodes?.length) return nativeUngroup.apply(this, arguments);
        event?.preventDefault?.(); event?.stopPropagation?.(); pushUndo();
        const ids = new Set([...(group.items || []), ...restore.nodes.map(node => node.id)]);
        nodes = nodes.filter(node => node.id !== group.id && !ids.has(node.id));
        nodes.push(...restore.nodes.map(node => JSON.parse(JSON.stringify(node))));
        connections = (connections || []).filter(conn => conn.from !== group.id && conn.to !== group.id && !ids.has(conn.from) && !ids.has(conn.to));
        const existing = new Set(nodes.map(node => node.id));
        (restore.connections || []).forEach(raw => {
            const conn = JSON.parse(JSON.stringify(raw));
            if(existing.has(conn.from) && existing.has(conn.to) && !connections.some(item => item.from === conn.from && item.to === conn.to && (item.kind || 'flow') === (conn.kind || 'flow'))) connections.push(conn);
        });
        selected.clear(); [...ids].filter(id => existing.has(id)).forEach(id => selected.add(id));
        sanitizeConnections(); syncGeneratorInputs(); refreshGeneratorInputViews(); render(); scheduleSave();
        return true;
    };
    window.CanvasBugFixUngroupClassic = {snapshot};
    status('active');
})();
