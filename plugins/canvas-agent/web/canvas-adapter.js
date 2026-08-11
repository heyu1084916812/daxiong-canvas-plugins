(function installSmartCanvasAgentHost(){
    'use strict';
    if(window.CanvasAgentHost?.schemaVersion>=2)return;
    const subscriptions=new Map(), transactions=new Map(), nodeTypes=new Map(), activeRuns=new Map();
    const clone=v=>JSON.parse(JSON.stringify(v));
    const list=()=>typeof nodes!=='undefined'?nodes:[];
    const find=id=>list().find(n=>n?.id===id)||null;
    const refresh=(save=true)=>{if(typeof render==='function')render();if(save&&typeof scheduleSave==='function')scheduleSave();queueMicrotask(enhanceRegisteredNodes);};
    const notify=(e,p)=>subscriptions.get(e)?.forEach(fn=>fn(p));
    const now=()=>typeof nowMs==='function'?nowMs():Date.now();
    function selection(){return typeof selectedNodeIds==='function'?selectedNodeIds():[];}
    function viewportAnchor(options={}){
        const chosen=selection().map(find).filter(Boolean);
        if(chosen.length&&options.preferSelection!==false){const right=Math.max(...chosen.map(n=>Number(n.x||0)+Number(n.w||316)));return{x:right+100,y:Math.min(...chosen.map(n=>Number(n.y||0))),source:'selection'};}
        const rect=typeof board!=='undefined'&&board?.getBoundingClientRect?board.getBoundingClientRect():{left:0,top:0,width:innerWidth,height:innerHeight};
        const scale=Number(viewport?.scale)||1;return{x:(rect.width/2-(Number(viewport?.x)||0))/scale,y:(rect.height/2-(Number(viewport?.y)||0))/scale,source:'viewport'};
    }
    function beginTransaction(label='AI Agent workflow'){const id=`atx_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;if(typeof pushUndo==='function')pushUndo();transactions.set(id,{label,nodes:clone(list()),connections:clone(canvas?.connections||[])});return id;}
    function commitTransaction(id){if(!transactions.has(id))return false;transactions.delete(id);refresh();return true;}
    function rollbackTransaction(id){const tx=transactions.get(id);if(!tx)return false;nodes=clone(tx.nodes);if(canvas)canvas.connections=clone(tx.connections);transactions.delete(id);refresh();return true;}
    function engineForProvider(providerId=''){
        const id = String(providerId || '').trim().toLowerCase();
        if(id === 'volcengine') return 'volcengine';
        if(id === 'modelscope') return 'modelscope';
        if(id === 'runninghub') return 'runninghub';
        if(id === 'comfy' || id === 'comfyui') return 'comfy';
        return 'api';
    }
    function settingsFor(node){
        const s=node.resolvedSettings||node.runSettings||node.settings||{};
        const agent=node.agentSource?.resolvedSettings||node.requestedSettings||node.agentSource?.requestedSettings||{};
        const base=(typeof cloneSmartSettings==='function'?cloneSmartSettings(settings):{});
        // Agent 节点：provider/model/engine 以节点快照为准，绝不回落到画布底部默认模型
        const provider_id=s.provider_id||s.providerId||agent.provider_id||agent.providerId||(node.agentCreated?'':base.provider_id)||'';
        const model=s.model||agent.model||(node.agentCreated?'':base.model)||'';
        const engine=s.engine||agent.engine||engineForProvider(provider_id)||'api';
        return{
            ...base,
            engine,
            apiKind:'image',
            provider_id,
            model,
            ratio:s.ratio||agent.ratio||'square',
            resolution:s.resolution||agent.resolution||'1k',
            quality:s.quality||agent.quality||'auto',
            count:Math.max(1,Math.min(8,Number(s.count||agent.count)||1)),
            customRatio:s.custom_ratio||s.customRatio||'',
            customSize:s.custom_size||s.customSize||''
        };
    }
    function lockAgentNodeSettings(node, preferred){
        if(!node) return null;
        const src=preferred||settingsFor(node);
        const provider_id=src.provider_id||'';
        const model=src.model||'';
        const engine=src.engine||engineForProvider(provider_id)||'api';
        const locked={
            engine,
            apiKind:'image',
            provider_id,
            model,
            ratio:src.ratio||'square',
            resolution:src.resolution||'1k',
            quality:src.quality||'auto',
            count:Math.max(1,Math.min(8,Number(src.count)||1)),
            customRatio:src.customRatio||src.custom_ratio||'',
            customSize:src.customSize||src.custom_size||''
        };
        // 火山引擎在智能画布 UI 依赖 engine=volcengine + provider_id=volcengine
        if(engine === 'volcengine'){
            locked.provider_id = 'volcengine';
        }
        // 不要把画布默认引擎字段污染进来：先清关键冲突字段，再写锁定值
        const base = (typeof cloneSmartSettings==='function')
            ? cloneSmartSettings(locked)
            : {...locked};
        node.runSettings = {
            ...base,
            ...locked,
            engine: locked.engine,
            apiKind: 'image',
            provider_id: locked.provider_id,
            model: locked.model
        };
        node.resolvedSettings={
            provider_id:locked.provider_id,
            model:locked.model,
            engine:locked.engine,
            ratio:locked.ratio,
            resolution:locked.resolution,
            quality:locked.quality,
            count:locked.count,
            custom_ratio:locked.customRatio||'',
            custom_size:locked.customSize||''
        };
        if(!node.agentSource || typeof node.agentSource !== 'object') node.agentSource = {};
        node.agentSource.resolvedSettings={...node.resolvedSettings};
        node.agentSource.requestedSettings = node.agentSource.requestedSettings || {...node.resolvedSettings};
        node.agentCreated = true;
        return locked;
    }
    function pendingCountFor(node, settings){
        const fromSettings=Math.max(1,Math.min(8,Number(settings?.count)||1));
        return Math.max(1, Number(node?.pending)||fromSettings);
    }
    function applyPendingVisual(node, settings, refs=[]){
        if(!node) return node;
        const count=pendingCountFor(node, settings);
        node.pending=count;
        node.queued=false;
        node.running=true;
        node.status='running';
        node.runStartedAt=node.runStartedAt||now();
        delete node.runFinishedAt;
        delete node.runElapsedMs;
        node.runTimerHidden=false;
        if(typeof pendingBoxSize==='function'){
            const box=pendingBoxSize(count,{sourceNode:node,refs:refs||node.references||[]});
            node.w=box.w; node.h=box.h;
        }else{
            node.w=node.w||260; node.h=node.h||180;
        }
        if(!node.title||node.title==='上传节点'||node.title==='图片结果'||node.title==='AI Agent 生成'){
            node.title='生成中...';
        }
        if(typeof coolNodeRunningState==='function') coolNodeRunningState(node, 2000);
        return node;
    }
    function createNode(type,data={},position={}){
        const def=nodeTypes.get(type); if(type!=='smart-image'&&!def)throw new Error(`Unregistered smart node type: ${type}`);
        let node;
        if(type==='smart-image'){node=createNodeAtImage(position,data);}
        else {node={id:uid(type==='agent-generation'?'agentgen':'plugin'),type,x:Number(position.x)||0,y:Number(position.y)||0,w:Number(data.w||def?.width)||360,h:Number(data.h||def?.height)||430,title:def?.title||type,created_at:Date.now(),...clone(data)};list().push(node);refresh(false);}
        notify('node:created',{nodeId:node.id,type});return{schemaVersion:2,...clone(node)};
    }
    function createNodeAtImage(position,data){
        const p={x:Number(position.x)||0,y:Number(position.y)||0};
        const imgs=clone(data.images||[]);
        const count=Math.max(1,Math.min(8,Number(data.count||data.resolvedSettings?.count||data.runSettings?.count||1)));
        const wantsPending=Boolean(data.pending||data.agentCreated||data.status==='running'||!imgs.length);
        const node={
            id:uid('smart'),
            type:'smart-image',
            x:p.x,y:p.y,
            title:imgs.length>1?'Group':imgs.length?'Image':(data.title||'生成中...'),
            images:imgs,
            created_at:Date.now(),
            scale:1,
            ...clone(data)
        };
        // Agent 创建节点时立刻锁 engine/provider/model，避免一点开就被画布默认设置覆盖
        if(node.agentCreated || node.runSettings || node.resolvedSettings || node.agentSource){
            lockAgentNodeSettings(node, node.runSettings || node.resolvedSettings || null);
        }
        if(wantsPending && !imgs.length){
            applyPendingVisual(node, settingsFor(node), node.references||[]);
            if(Number(data.pending)>0) node.pending=Math.max(1,Number(data.pending));
            else node.pending=count;
        }
        list().push(node);refresh(false);return node;
    }
    function updateNode(id,patch){
        const n=find(id);if(!n)return null;
        Object.assign(n,clone(patch||{}));
        if(n.agentCreated || n.agentSource || (patch&&(patch.runSettings||patch.resolvedSettings||patch.agentSource))){
            lockAgentNodeSettings(n, n.runSettings || n.resolvedSettings || null);
        }
        refresh();
        return{schemaVersion:2,...clone(n)};
    }
    function connectNodes(from,to,options={}){if(!find(from)||!find(to)||from===to)throw new Error('Invalid node connection');if(typeof addConnection==='function')addConnection(from,to,options.kind||'flow');else{canvas.connections=canvas.connections||[];canvas.connections.push({from,to,kind:options.kind||'flow'});}refresh(false);return true;}
    function writeSmartAgentLog({node, prompt, refs=[], runSettings, outputs=[], runMs=0, error=''}){
        try{
            if(typeof addSmartGenerationLog !== 'function') return;
            const settingsSnapshot = typeof cloneSmartSettings==='function'
                ? cloneSmartSettings(runSettings || {})
                : {...(runSettings||{})};
            settingsSnapshot.engine = settingsSnapshot.engine || 'api';
            settingsSnapshot.apiKind = settingsSnapshot.apiKind || 'image';
            settingsSnapshot.provider_id = settingsSnapshot.provider_id || runSettings?.provider_id || '';
            settingsSnapshot.model = settingsSnapshot.model || runSettings?.model || '';
            settingsSnapshot.ratio = settingsSnapshot.ratio || runSettings?.ratio || 'square';
            settingsSnapshot.resolution = settingsSnapshot.resolution || runSettings?.resolution || '1k';
            settingsSnapshot.quality = settingsSnapshot.quality || runSettings?.quality || 'auto';
            settingsSnapshot.count = settingsSnapshot.count || runSettings?.count || 1;
            const run = {
                nodeId: node?.id || '',
                nodeType: node?.type || 'smart-image',
                kind: 'image',
                settings: settingsSnapshot,
                prompt: prompt || '',
                refs: (refs || []).map(ref => ({url:ref?.url || '', name:ref?.name || 'image', kind:ref?.kind || ''})).filter(ref => ref.url),
                size: (typeof sizeForRun === 'function') ? sizeForRun(settingsSnapshot) : ''
            };
            addSmartGenerationLog({run, outputs, runMs, error});
            if(typeof renderCanvasLog === 'function'){
                try{ renderCanvasLog(); }catch(_){}
            }
        }catch(err){
            console.warn('[canvas-agent] writeSmartAgentLog failed', err);
        }
    }
    function normalizeAgentResultImages(urls){
        return (urls || []).map((item, i) => {
            if(typeof item === 'string'){
                return {url:item, name:`agent-${Date.now()}-${i + 1}.png`, kind:'image', generatedResult:true};
            }
            if(!item || typeof item !== 'object') return null;
            const url = item.url || item.path || item.src || item.uri || '';
            if(!url) return null;
            const out = {
                ...item,
                url,
                name: item.name || item.filename || `agent-${Date.now()}-${i + 1}.png`,
                kind: item.kind || item.type || item.mediaKind || 'image',
                generatedResult: true
            };
            if(typeof copyMediaSizeFields === 'function') copyMediaSizeFields(item, out);
            return out;
        }).filter(Boolean);
    }
    function liveNodeById(id, fallback=null){
        return find(id) || fallback || null;
    }
    function finishAgentNodeImages(node, images, runSettings){
        if(!node) return null;
        const imgs = clone(images || []);
        node.images = imgs;
        node.title = imgs.length > 1 ? 'Group' : (imgs.length ? 'Image' : '生成失败');
        node.pending = 0;
        node.queued = false;
        node.running = false;
        node.status = imgs.length ? 'completed' : 'failed';
        node.runFinishedAt = now();
        if(!node.runStartedAt) node.runStartedAt = node.runFinishedAt;
        node.runElapsedMs = Math.max(0, node.runFinishedAt - Number(node.runStartedAt || node.runFinishedAt));
        node.runTimerHidden = false;
        if(typeof mediaNodeDefaultScale === 'function') node.scale = mediaNodeDefaultScale(node);
        delete node.w;
        delete node.h;
        node.resultNodeId = node.id;
        if(typeof markSmartNodeComplete === 'function'){
            try{ markSmartNodeComplete(node); }catch(_){}
        }
        if(typeof clearSmartNodeBusyState === 'function'){
            try{ clearSmartNodeBusyState(node); }catch(_){}
        }
        lockAgentNodeSettings(node, runSettings);
        return node;
    }
    async function runNode(id){
        let n=find(id);if(!n)throw new Error('Node not found');if(n.type!=='smart-image'&&!n.agentCreated)throw new Error(`Node type ${n.type} is not runnable`);
        const token={cancelled:false};activeRuns.set(id,token);
        // 锁定 Agent 模型快照，避免底部默认模型覆盖节点显示/请求
        const runSettings=lockAgentNodeSettings(n) || settingsFor(n);
        const refs=(n.references||[]).filter(x=>x?.url);
        applyPendingVisual(n, runSettings, refs);
        refresh();
        // 每次读取都用 live 节点，防止 await 期间 nodes 被 409 合并替换导致写到悬空对象
        n = liveNodeById(id, n) || n;
        const promptText=n.professionalPrompt||n.prompt||n.promptDraftText||'';
        const logStart=now();
        try{
            const result=await generateUrlsForCurrentSettings(n,promptText,refs,runSettings);
            // 关键：await 后必须重新查找当前 nodes 中的节点
            n = liveNodeById(id, n);
            if(!n){
                // 节点在生成过程中被合并/重建：尽量用结果新建一个节点，避免“右侧有图、画布空白”
                const images=normalizeAgentResultImages(result.urls||[]);
                if(images.length && typeof createNodeAtImage==='function'){
                    try{
                        const recreated=createNode('smart-image',{
                            images,
                            title:images.length>1?'Group':'Image',
                            professionalPrompt:promptText,
                            promptDraftText:promptText,
                            runSettings,
                            resolvedSettings:runSettings,
                            status:'completed',
                            pending:0,
                            agentCreated:true
                        }, {x:40,y:40});
                        const live=liveNodeById(recreated?.id);
                        if(live) finishAgentNodeImages(live, images, runSettings);
                        refresh();
                        return{status:'completed',nodeId:recreated?.id||'',outputNodeId:recreated?.id||'',images};
                    }catch(recreateErr){
                        console.warn('[canvas-agent] recreate missing node failed', recreateErr);
                    }
                }
                return{status:images.length?'completed':'failed',nodeId:id,outputNodeId:'',images};
            }
            if(token.cancelled){
                n.status='stopped';n.pending=0;n.running=false;refresh();
                return{status:'stopped',nodeId:id,images:[]};
            }
            const images=normalizeAgentResultImages(result.urls||[]);
            finishAgentNodeImages(n, images, runSettings);
            // 再写一次 live 引用，防止 finish 后立刻又发生 merge
            const liveAfter=liveNodeById(id);
            if(liveAfter && liveAfter !== n){
                finishAgentNodeImages(liveAfter, images, runSettings);
                n = liveAfter;
            }
            writeSmartAgentLog({node:n, prompt:promptText, refs, runSettings, outputs:images, runMs:Math.max(0, now()-logStart), error: images.length ? '' : '生成失败'});
            refresh();
            return{status:images.length?'completed':'failed',nodeId:id,outputNodeId:n.id,images};
        }catch(error){
            n = liveNodeById(id, n);
            if(n){
                n.status='failed';
                n.pending=0;
                n.running=false;
                n.runFinishedAt=now();
                writeSmartAgentLog({node:n, prompt:promptText, refs, runSettings, outputs:[], runMs:Math.max(0, now()-logStart), error:String(error?.message||error||'生成失败')});
            }
            refresh();
            throw error;
        }finally{
            activeRuns.delete(id);
        }
    }
    function cancelNodeRun(id){const t=activeRuns.get(id);if(t)t.cancelled=true;const n=find(id);if(n){n.status='stopped';n.running=false;n.pending=0;}refresh();return true;}
    function getNodeImages(nodeOrId){const n=typeof nodeOrId==='string'?find(nodeOrId):nodeOrId;return (n?.images||[]).filter(x=>x?.url).map(x=>({...x}));}
    function applyNodeImages(nodeOrId,images){
        const id = typeof nodeOrId==='string' ? nodeOrId : (nodeOrId?.id || '');
        const n = id ? (find(id) || (typeof nodeOrId==='object' ? nodeOrId : null)) : (typeof nodeOrId==='object' ? nodeOrId : null);
        if(!n) return null;
        const imgs = normalizeAgentResultImages(images || []);
        n.images = clone(imgs);
        n.pending = 0;
        n.running = false;
        n.queued = false;
        n.status = imgs.length ? 'completed' : (n.status || 'failed');
        n.title = imgs.length > 1 ? 'Group' : (imgs.length ? 'Image' : n.title);
        if(typeof markSmartNodeComplete === 'function'){ try{ markSmartNodeComplete(n); }catch(_){ } }
        if(typeof mediaNodeDefaultScale === 'function') n.scale = mediaNodeDefaultScale(n);
        delete n.w; delete n.h;
        refresh();
        return clone(n);
    }
    function enhanceRegisteredNodes(){
        let changed=false;for(const node of list()){if(node?.type!=='agent-generation')continue;node.type='smart-image';node.title=node.title||'AI Agent 生成';node.promptDraftText=node.promptDraftText||node.professionalPrompt||node.prompt||'';node.promptDraftHtml=node.promptDraftHtml||String(node.promptDraftText).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));node.runSettings=settingsFor(node);node.agentCreated=true;changed=true;}if(changed)refresh();
    }
    function resolveGenerationSettings(requested={}){
        const providers=typeof apiProviders!=='undefined'?apiProviders:[];
        const reqProvider=String(requested.provider_id||requested.providerId||requested.apiProvider||'').trim();
        const reqModel=String(requested.model||'').trim();
        const modelsOf = (providerId) => {
            if(typeof providerImageModels==='function') return providerImageModels(providerId||'') || [];
            const p = (providers||[]).find(x => x && x.id === providerId) || {};
            return p.image_models || p.models || [];
        };
        // 同名模型可能存在于多个平台（如 默认/特价 都有 gpt-image-2）
        // 必须以用户在 Agent 里选中的 provider 为准，绝不能因为模型重名就改绑到别的平台
        let provider = (providers||[]).find(p => p && p.id === reqProvider) || null;
        let model = reqModel;
        if(provider){
            const models = modelsOf(provider.id);
            if(model && !(models||[]).includes(model)){
                // 当前平台没有该模型时，才允许按模型找回所属平台
                const owner = (providers||[]).find(p => (modelsOf(p.id||'')||[]).includes(model));
                if(owner) provider = owner;
                else model = (models&&models[0]) || model || '';
            }
            if(!model) model = (modelsOf(provider.id)||[])[0] || '';
        } else {
            if(model){
                const owner = (providers||[]).find(p => (modelsOf(p.id||'')||[]).includes(model));
                if(owner) provider = owner;
            }
            if(!provider) provider = (providers||[])[0] || {};
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
    const host={
        schemaVersion:2,
        canvasKind:()=> 'smart',
        getCanvasId:()=>typeof canvasId!=='undefined'?canvasId:'',
        getSelection:()=>({schemaVersion:2,nodeIds:selection()}),
        getNode:id=>{const n=find(id);return n?{schemaVersion:2,...clone(n)}:null;},
        getNodeImages,
        applyNodeImages,
        createImageNode(file,position){
            const img = !file ? null : (typeof file === 'string' ? {url:file, name:'reference', kind:'image'} : {url:file.url||file.src||'', name:file.name||'reference', kind:file.kind||'image'});
            if(img && !img.url) return null;
            return createNode('smart-image',{images:img?[img]:[], title:img?'Reference':'Image', agentCreated:false, pending:0, status:'completed'}, position);
        },
        getViewportAnchor:viewportAnchor,
        beginTransaction,commitTransaction,rollbackTransaction,
        createNode,updateNode,connectNodes,runNode,cancelNodeRun,
        selectNodes(ids){if(typeof selectedId!=='undefined')selectedId=(ids||[])[0]||'';if(typeof selectedIds!=='undefined'&&selectedIds instanceof Set){selectedIds.clear();(ids||[]).forEach(id=>selectedIds.add(id));}refresh(false);return selection();},
        focusNodes(ids){this.selectNodes(ids);return true;},
        saveCanvas:()=>typeof saveCanvas==='function'?saveCanvas():Promise.resolve(),
        registerNodeType:(type,def)=>{nodeTypes.set(type,def||{});return true;},
        getProviderCapabilities(id){const p=(typeof apiProviders!=='undefined'?apiProviders:[]).find(x=>x.id===id);return p?clone(p):null;},
        resolveGenerationSettings,
        subscribe(event,fn){if(!subscriptions.has(event))subscriptions.set(event,new Set());subscriptions.get(event).add(fn);return()=>subscriptions.get(event)?.delete(fn);},
        publish:notify
    };
    window.CanvasAgentHost=host;
    enhanceRegisteredNodes();
})();
