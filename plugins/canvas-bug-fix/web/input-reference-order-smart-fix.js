(() => {
    'use strict';
    const status = value => { document.documentElement.dataset.canvasBugFixInputOrderSmart = value; };
    if(typeof reorderInputSourceNodes !== 'function' || typeof reorderInputThumb !== 'function') { status('incompatible'); return; }
    const move = (ids, movedId, targetId, placement='before') => { const list=(ids||[]).filter(Boolean),from=list.indexOf(movedId),target=list.indexOf(targetId);if(from<0||target<0||movedId===targetId)return list;const item=list.splice(from,1)[0];let at=list.indexOf(targetId);if(placement==='after')at+=1;list.splice(at,0,item);return list; };
    reorderInputSourceNodes = function fixedReorderSources(currentNode,movedId,targetId,placement='before'){
        if(!currentNode||!movedId||!targetId||movedId===targetId)return false;
        const sourceNodes=smartImageUsesWorkflowInput(currentNode,smartLoopContext)?workflowInputNodesFor(currentNode):inputNodesFor(currentNode);
        const sourceIds=sourceNodes.map(node=>node.id).filter(Boolean);if(!sourceIds.includes(movedId)||!sourceIds.includes(targetId))return false;
        const next=move(sourceIds,movedId,targetId,placement);if(next.every((id,index)=>id===sourceIds[index]))return false;
        const explicit=Array.isArray(currentNode.inputNodeIds)?currentNode.inputNodeIds.filter(Boolean):[];currentNode.inputNodeIds=[...next,...explicit.filter(id=>!next.includes(id))];
        if(Array.isArray(canvas?.connections)){const order=new Map(next.map((id,index)=>[id,index])),slots=new Set(),relevant=[];canvas.connections.forEach((conn,index)=>{const kind=conn?.kind||'flow';if(conn?.to===currentNode.id&&['input','flow'].includes(kind)&&order.has(conn.from)){slots.add(index);relevant.push({conn,index});}});relevant.sort((a,b)=>(order.get(a.conn.from)-order.get(b.conn.from))||(a.index-b.index));let cursor=0;canvas.connections=canvas.connections.map((conn,index)=>slots.has(index)?relevant[cursor++].conn:conn);}
        return true;
    };
    reorderInputThumb = function fixedReorderThumb(currentNode,items,from,to,placement='before'){
        if(from<0||to<0||from>=items.length||to>=items.length)return;if(inputThumbsRow)delete inputThumbsRow.dataset.thumbsSig;
        const a=items[from],b=items[to];if(!a||!b)return;const aSource=a.inputSourceNodeId||a.nodeId,bSource=b.inputSourceNodeId||b.nodeId;
        if(a.nodeId===b.nodeId&&aSource===bSource){const source=nodes.find(node=>node.id===a.nodeId);if(!source)return;pushUndo();const fi=Number(a.imageIndex),ti=Number(b.imageIndex);if(Number.isFinite(fi)&&Number.isFinite(ti)&&source.images?.[fi]){let at=Math.max(0,Math.min(source.images.length,ti+(placement==='after'?1:0)));const image=source.images.splice(fi,1)[0];if(fi<at)at-=1;source.images.splice(at,0,image);}render();scheduleSave();return;}
        if(isSmartGroupNode(currentNode)&&Array.isArray(currentNode.items)&&a.nodeId!==b.nodeId&&currentNode.items.includes(a.nodeId)&&currentNode.items.includes(b.nodeId)){const next=move(currentNode.items,a.nodeId,b.nodeId,placement);if(next.some((id,index)=>id!==currentNode.items[index])){pushUndo();currentNode.items=next;render();scheduleSave();}return;}
        if(!aSource||!bSource||aSource===bSource)return;pushUndo();if(reorderInputSourceNodes(currentNode,aSource,bSource,placement)){render();scheduleSave();}
    };
    window.CanvasBugFixInputOrderSmart={move}; status('active');
})();
