(function installClassicCanvasAgentHost(){
    'use strict';
    if(window.CanvasAgentHost?.schemaVersion >= 2) return;
    const subscriptions = new Map();
    const transactions = new Map();
    const activeRuns = new Map();
    const query = new URLSearchParams(location.search);
    const canvasId = query.get('id') || '';

    const clone = value => JSON.parse(JSON.stringify(value));
    const allNodes = () => typeof nodes !== 'undefined' ? nodes : [];
    const allConnections = () => typeof connections !== 'undefined' ? connections : [];
    const findNode = id => allNodes().find(node => node?.id === id) || null;
    const notify = (event, payload) => subscriptions.get(event)?.forEach(fn => fn(payload));
    function refresh(save=true){
        if(typeof render === 'function') render();
        if(save && typeof scheduleSave === 'function') scheduleSave();
        queueMicrotask(enhanceAgentNodes);
    }
    function selectionIds(){ return typeof selected !== 'undefined' && selected instanceof Set ? [...selected] : []; }
    function viewportAnchor(options={}){
        const selectedNodes = selectionIds().map(findNode).filter(Boolean);
        if(selectedNodes.length && options.preferSelection !== false){
            const right = Math.max(...selectedNodes.map(n => Number(n.x || 0) + Number(nodeRect?.(n)?.w || 280)));
            const top = Math.min(...selectedNodes.map(n => Number(n.y || 0)));
            return {x:right + 100, y:top, source:'selection'};
        }
        const point = typeof screenToWorld === 'function' ? screenToWorld(innerWidth / 2, innerHeight / 2) : {x:0,y:0};
        return {x:Number(point.x)||0, y:Number(point.y)||0, source:'viewport'};
    }
    function beginTransaction(label='AI Agent workflow'){
        const id = `atx_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        if(typeof pushUndo === 'function') pushUndo();
        transactions.set(id, {label, nodes:clone(allNodes()), connections:clone(allConnections())});
        return id;
    }
    function rollbackTransaction(id){
        const tx = transactions.get(id); if(!tx) return false;
        nodes = clone(tx.nodes); connections = clone(tx.connections);
        transactions.delete(id); refresh(); notify('transaction:rollback',{id}); return true;
    }
    function commitTransaction(id){
        if(!transactions.has(id)) return false;
        transactions.delete(id); refresh(); notify('transaction:commit',{id}); return true;
    }
    function createNode(type, data={}, position={}){
        const p = {x:Number(position.x)||0,y:Number(position.y)||0};
        let node;
        if(type === 'prompt') node = {id:uid('prompt'),type:'prompt',...p,text:'',...clone(data)};
        else if(type === 'generator'){
            const provider = data.apiProvider || data.providerId || data.provider_id || (typeof imageApiProviders === 'function' ? imageApiProviders()[0]?.id : '') || '';
            const requestedModel = data.model || '';
            const models = (typeof allImageModels === 'function' ? allImageModels(provider) : (typeof providerImageModels === 'function' ? providerImageModels(provider) : [])) || [];
            const model = (requestedModel && models.includes(requestedModel)) ? requestedModel : (requestedModel || models[0] || '');
            // 最后强制写回 provider/model，避免 ...clone(data) 把空值或旧值盖掉 Agent 选择
            node = {id:uid('gen'),type:'generator',...p,apiProvider:provider,model,ratio:'square',resolution:'1k',quality:'auto',count:1,customRatio:'',customSize:'',customRatioWidth:'',customRatioHeight:'',customWidth:'',customHeight:'',inputs:[],...clone(data), apiProvider:provider, model};
        } else if(type === 'output') node = {id:uid('out'),type:'output',...p,images:[],_pending:[],...clone(data)};
        else if(type === 'image') node = {id:uid('img'),type:'image',...p,url:'',name:'image',images:[],...clone(data)};
        else throw new Error(`Unsupported classic node type: ${type}`);
        allNodes().push(node); refresh(false); notify('node:created',{nodeId:node.id,type});
        return {schemaVersion:2,...clone(node)};
    }
    function connectNodes(fromId,toId,options={}){
        if(!findNode(fromId)||!findNode(toId)||fromId===toId) throw new Error('Invalid node connection');
        if(!allConnections().some(c=>c.from===fromId&&c.to===toId)) allConnections().push({id:uid('c'),from:fromId,to:toId,...clone(options)});
        if(typeof syncGeneratorInputs === 'function') syncGeneratorInputs();
        refresh(false); return true;
    }
    function updateNode(id,patch){ const node=findNode(id); if(!node)return null; Object.assign(node,clone(patch||{})); refresh(); return {schemaVersion:2,...clone(node)}; }
    function ensureOutputPending(generator, output){
        if(!generator || !output) return output;
        // 不再预塞 agentPlaceholder：避免 runGenerator 再追加真实 pending 时出现“双读秒”
        if(!Array.isArray(output._pending)) output._pending=[];
        output._pending = output._pending.filter(p => !p.agentPlaceholder);
        output.agentRunStatus='running';
        return output;
    }
    async function runNode(id,options={}){
        const node=findNode(id); if(!node) throw new Error('Node not found');
        if(node.type!=='generator') throw new Error(`Node type ${node.type} is not runnable`);
        const token={cancelled:false}; activeRuns.set(id,token);
        node.agentRunStatus='running';
        node.runStatus='running';
        // 允许 Agent 并行触发：清掉可能残留的 running 锁，避免 runGenerator 直接 return
        node.running=false;
        let output=allConnections().filter(c=>c.from===id).map(c=>findNode(c.to)).find(n=>n?.type==='output') || null;
        if(!output){
            const created=createNode('output',{images:[],agentCreated:true},{x:Number(node.x||0)+320,y:Number(node.y||0)});
            output=findNode(created.id);
            connectNodes(id, created.id);
        }
        ensureOutputPending(node, output);
        refresh();
        try{
            // cascade:true 可绕过 gen.running 早退；Agent 编排必须真正执行
            // 运行前再锁一次模型，避免 render 后 model 被画布默认值覆盖
            if(node.agentSource?.resolvedSettings){
                const rs = node.agentSource.resolvedSettings;
                if(rs.provider_id) node.apiProvider = rs.provider_id;
                if(rs.model) node.model = rs.model;
                if(rs.ratio) node.ratio = rs.ratio;
                if(rs.resolution) node.resolution = rs.resolution;
                if(rs.quality) node.quality = rs.quality;
                if(rs.count) node.count = Math.max(1, Math.min(8, Number(rs.count)||1));
            }
            // 单次任务默认 1 张，除非节点显式 >1
            node.count = Math.max(1, Math.min(8, Number(node.count)||1));
            // 开跑前清掉 Agent 占位读秒，只保留 runGenerator 自己的 pending
            if(output && Array.isArray(output._pending)){
                output._pending = output._pending.filter(p => !p.agentPlaceholder);
            }
            await runGenerator(id,{...options, cascade:true, agentDriven:true});
            if(token.cancelled){ node.agentRunStatus='stopped'; node.runStatus='stopped'; return {status:'stopped',nodeId:id,images:[]}; }
            // 等待 output pending 真正结束（runGenerator 可能异步 pending 完成）
            const waitStart=Date.now();
            while(Date.now()-waitStart < 15*60*1000){
                output=allConnections().filter(c=>c.from===id).map(c=>findNode(c.to)).find(n=>n?.type==='output') || output || null;
                const pending=(output?._pending||[]).filter(p=>!p.done && !p.error && !p.agentPlaceholder);
                if(!pending.length) break;
                await new Promise(r=>setTimeout(r, 300));
                if(token.cancelled) break;
            }
            const outputIds=allConnections().filter(c=>c.from===id).map(c=>c.to);
            output=outputIds.map(findNode).find(n=>n?.type==='output') || output || null;
            const images=(output?.images||[]).filter(x=>x?.url).map(x=>({...x}));
            if(output && Array.isArray(output._pending)){
                output._pending=output._pending.filter(p=>!p.agentPlaceholder);
            }
            node.agentRunStatus=node.runStatus==='failed'?'failed':(images.length?'completed':'failed');
            try{ if(typeof renderCanvasLog==='function') renderCanvasLog(); }catch(_){}
            return {status:node.agentRunStatus==='failed'?'failed':'completed',nodeId:id,outputNodeId:output?.id||'',images};
        } finally { activeRuns.delete(id); refresh(); }
    }
    function cancelNodeRun(id){
        const token=activeRuns.get(id); if(token) token.cancelled=true;
        const node=findNode(id); if(node){ node.agentRunStatus='stopped'; node.runStatus='stopped'; }
        const outputIds=allConnections().filter(c=>c.from===id).map(c=>c.to);
        for(const out of outputIds.map(findNode).filter(Boolean)) for(const pending of (out._pending||[])){
            const taskId=pending.canvasTaskId||pending.taskId; if(taskId) fetch(`/api/canvas-image-tasks/${encodeURIComponent(taskId)}/cancel`,{method:'POST'}).catch(()=>{});
        }
        refresh(); return true;
    }
    function getNodeImages(nodeOrId){
        const node=typeof nodeOrId==='string'?findNode(nodeOrId):nodeOrId;
        if(!node) return [];
        if(Array.isArray(node.images)) return node.images.filter(x=>x?.url).map(x=>({...x}));
        if(node.url) return [{url:node.url,name:node.name||'image',kind:'image'}];
        return [];
    }
    function applyNodeImages(nodeOrId,images){
        const id = typeof nodeOrId==='string' ? nodeOrId : (nodeOrId?.id || '');
        const node = id ? (findNode(id) || (typeof nodeOrId==='object' ? nodeOrId : null)) : (typeof nodeOrId==='object' ? nodeOrId : null);
        if(!node) return null;
        const imgs = clone(images||[]).filter(x=>x&&x.url).map(x=>({...x}));
        node.images=imgs;
        node.url=imgs[0]?.url||node.url||'';
        node.agentRunStatus = imgs.length ? 'completed' : (node.agentRunStatus || 'failed');
        if(Array.isArray(node._pending)) node._pending=node._pending.filter(p=>!p.agentPlaceholder && !(p.done || p.error));
        refresh();
        return clone(node);
    }
    function resolveGenerationSettings(requested={}){
        const providers=typeof imageApiProviders==='function'?imageApiProviders():(typeof apiProviders!=='undefined'?apiProviders:[]);
        const allProviders=typeof apiProviders!=='undefined'?apiProviders:providers;
        const reqProvider=String(requested.provider_id||requested.providerId||requested.apiProvider||'').trim();
        const reqModel=String(requested.model||'').trim();
        const modelsOf = (providerId) => {
            if(typeof allImageModels==='function') return allImageModels(providerId||'') || [];
            if(typeof providerImageModels==='function') return providerImageModels(providerId||'') || [];
            const p = (allProviders||[]).find(x => x && x.id === providerId) || {};
            return p.image_models || p.models || [];
        };
        // 同名模型可能挂在多个平台：优先保留 Agent 选中的 provider，只有当前平台没有该模型时才改绑
        let provider = (providers||[]).find(p => p && p.id === reqProvider)
            || (allProviders||[]).find(p => p && p.id === reqProvider)
            || null;
        let model = reqModel;
        if(provider){
            const models = modelsOf(provider.id||'');
            if(model && !(models||[]).includes(model)){
                const owner = (allProviders||[]).find(p => (modelsOf(p.id||'')||[]).includes(model));
                if(owner){
                    provider = owner;
                }else{
                    model = (models&&models[0]) || model || '';
                }
            }
            if(!model) model = (modelsOf(provider.id||'')||[])[0] || '';
        } else {
            if(model){
                const owner = (allProviders||[]).find(p => (modelsOf(p.id||'')||[]).includes(model));
                if(owner) provider = owner;
            }
            if(!provider) provider = (providers||[])[0] || (allProviders||[])[0] || {};
            const models = modelsOf(provider.id||'');
            if(model && !(models||[]).includes(model)) model = (models&&models[0]) || model || '';
            if(!model) model = (models&&models[0]) || '';
        }
        return{
            provider_id:provider.id||reqProvider||'',
            model:model||'',
            ratio:requested.ratio||'square',
            resolution:requested.resolution||'1k',
            quality:requested.quality||'auto',
            count:Math.max(1,Math.min(8,Number(requested.count)||1)),
            custom_ratio:requested.custom_ratio||'',
            custom_size:requested.custom_size||''
        };
    }
    function enhanceAgentNodes(){
        // Agent 来源继续保存在 node.agentSource 中，不在原生节点标题上增加可见标签。
    }
    const host={
        schemaVersion:2,
        canvasKind:()=> 'classic',
        getCanvasId:()=>canvasId,
        getSelection:()=>({schemaVersion:2,nodeIds:selectionIds()}),
        getNode:id=>{const n=findNode(id);return n?{schemaVersion:2,...clone(n)}:null;},
        getNodeImages,
        applyNodeImages,
        createImageNode(file,position){
            const img = !file ? null : (typeof file === 'string' ? {url:file, name:'reference', kind:'image'} : {url:file.url||file.src||'', name:file.name||'reference', kind:file.kind||'image'});
            if(img && !img.url) return null;
            // classic 画布 image 节点依赖顶层 url 才能作为 generator 参考图源
            const node = createNode('image',{
                images: img ? [img] : [],
                url: img?.url || '',
                name: img?.name || 'reference',
                agentReference: true
            }, position);
            // 二次保险：createNode 后强制写回 url
            if(node?.id && img?.url && typeof findNode === 'function'){
                const live = findNode(node.id);
                if(live){
                    live.url = img.url;
                    live.name = img.name || live.name || 'reference';
                    live.images = [{url: img.url, name: img.name || 'reference', kind: img.kind || 'image'}];
                }
            }
            return node;
        },
        getViewportAnchor:viewportAnchor,
        beginTransaction,commitTransaction,rollbackTransaction,
        createNode,updateNode,connectNodes,runNode,cancelNodeRun,
        selectNodes(ids){if(selected instanceof Set){selected.clear();(ids||[]).filter(findNode).forEach(id=>selected.add(id));}refresh(false);return selectionIds();},
        focusNodes(ids){this.selectNodes(ids);return true;},
        saveCanvas:()=>typeof saveCanvas==='function'?saveCanvas():Promise.resolve(),
        registerNodeType:()=>false,
        getProviderCapabilities(id){const p=(typeof apiProviders!=='undefined'?apiProviders:[]).find(x=>x.id===id);return p?clone(p):null;},
        resolveGenerationSettings,
        subscribe(event,fn){if(!subscriptions.has(event))subscriptions.set(event,new Set());subscriptions.get(event).add(fn);return()=>subscriptions.get(event)?.delete(fn);},
        publish:notify
    };
    window.CanvasAgentHost=host;
    enhanceAgentNodes();
})();
