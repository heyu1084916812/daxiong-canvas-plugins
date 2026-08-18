(() => {
    'use strict';
    const status = value => { document.documentElement.dataset.canvasBugFixUngroupSmart = value; };
    if(typeof groupSelectedNodes !== 'function' || typeof ungroupNode !== 'function') { status('incompatible'); return; }
    const nativeGroup = groupSelectedNodes;
    const nativeUngroup = ungroupNode;
    function snapshot(container, children){
        if(!container) return;
        const source = (children || []).filter(Boolean);
        const restore = container.ungroupRestore?.nodes ? container.ungroupRestore : {version:1,nodes:[],connections:[],inputRefs:[]};
        const known = new Set(restore.nodes.map(node => node.id));
        source.forEach(node => { if(!known.has(node.id)){ restore.nodes.push(serializableSmartNode(node)); known.add(node.id); } });
        const ids = new Set(source.map(node => node.id));
        const key = conn => `${conn.from}|${conn.to}|${conn.kind || 'flow'}`;
        const links = new Set(restore.connections.map(key));
        (canvas?.connections || []).filter(conn => ids.has(conn.from) || ids.has(conn.to)).forEach(conn => { if(!links.has(key(conn))){ restore.connections.push(JSON.parse(JSON.stringify(conn))); links.add(key(conn)); } });
        const refs = new Set(restore.inputRefs.map(item => item.id));
        nodes.filter(node => Array.isArray(node.inputNodeIds) && node.inputNodeIds.some(id => ids.has(id))).forEach(node => { if(!refs.has(node.id)){ restore.inputRefs.push({id:node.id,inputNodeIds:JSON.parse(JSON.stringify(node.inputNodeIds))}); refs.add(node.id); } });
        container.ungroupRestore = restore;
    }
    rememberSmartUngroupState = snapshot;
    groupSelectedNodes = function fixedGroupSelectedNodes(){
        const before = typeof selectedNodeIds === 'function' ? selectedNodeIds().map(id => nodes.find(node => node.id === id)).filter(Boolean) : [];
        const result = nativeGroup.apply(this, arguments);
        const group = typeof selectedNode === 'function' ? selectedNode() : null;
        if(group && before.length && !group.ungroupRestore) snapshot(group, before);
        return result;
    };
    ungroupNode = function fixedUngroupNode(groupId){
        const group = nodes.find(node => node.id === groupId);
        const restore = group?.ungroupRestore;
        if(!group || !restore?.nodes?.length) return nativeUngroup.apply(this, arguments);
        pushUndo();
        const restored = restore.nodes.map(node => JSON.parse(JSON.stringify(node)));
        const ids = new Set(restored.map(node => node.id));
        nodes = nodes.filter(node => node.id !== groupId && !ids.has(node.id)); nodes.push(...restored);
        canvas.connections = (canvas.connections || []).filter(conn => conn.from !== groupId && conn.to !== groupId && !ids.has(conn.from) && !ids.has(conn.to));
        const existing = new Set(nodes.map(node => node.id));
        (restore.connections || []).forEach(raw => { const conn=JSON.parse(JSON.stringify(raw)); if(existing.has(conn.from) && existing.has(conn.to) && !canvas.connections.some(item => item.from===conn.from && item.to===conn.to && (item.kind||'flow')===(conn.kind||'flow'))) canvas.connections.push(conn); });
        nodes.forEach(node => { if(Array.isArray(node.inputNodeIds)) node.inputNodeIds=node.inputNodeIds.filter(id=>id!==groupId); if(isSmartGroupNode(node)&&Array.isArray(node.items)) node.items=node.items.filter(id=>id!==groupId); });
        (restore.inputRefs || []).forEach(item => { const node=nodes.find(entry=>entry.id===item.id); if(node) node.inputNodeIds=JSON.parse(JSON.stringify(item.inputNodeIds||[])); });
        selectedIds=restored.map(node=>node.id); selectedId=selectedIds.length===1?selectedIds[0]:''; selectedImage={nodeId:'',index:-1}; render(); scheduleSave(); return true;
    };
    window.CanvasBugFixUngroupSmart = {snapshot};
    status('active');
})();
