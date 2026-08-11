(function installCanvasAgentPlanExecutor(){
    'use strict';
    const clone = v => JSON.parse(JSON.stringify(v));
    const normalizeRefUrl = (u='') => String(u || '').trim().split('#')[0].split('?')[0];
    const findExistingImageNodeId = (host, url='') => {
        const target = normalizeRefUrl(url);
        if(!target) return '';
        const list = (typeof nodes !== 'undefined' && Array.isArray(nodes))
            ? nodes
            : ((typeof host?.listNodes === 'function' ? host.listNodes() : []) || []);
        const match = (n) => {
            if(!n) return false;
            if(n.url && normalizeRefUrl(n.url) === target) return true;
            return (n.images || []).some(img => img?.url && normalizeRefUrl(img.url) === target);
        };
        const preferred = list.find(n => match(n) && !n.agentCreated && !(Number(n.pending) > 0));
        if(preferred?.id) return preferred.id;
        const any = list.find(n => match(n));
        return any?.id || '';
    };
    // workflow-scoped cache: one URL -> one nodeId
    const refNodeCache = new Map();
    const resolveRefNodeId = (host, ref) => {
        if(!ref) return '';
        let nodeId = ref.nodeId || ref.id || '';
        if(nodeId && host.getNode && !host.getNode(nodeId)) nodeId = '';
        const key = normalizeRefUrl(ref.url || ref.src || '');
        if(!nodeId && key && refNodeCache.has(key)) nodeId = refNodeCache.get(key) || '';
        if(!nodeId && ref.url) nodeId = findExistingImageNodeId(host, ref.url);
        if(nodeId && key) refNodeCache.set(key, nodeId);
        if(nodeId) ref.nodeId = nodeId;
        return nodeId || '';
    };
    // 生图请求可能已经计费但响应丢失；执行器不得自动重发。失败项只允许用户手动重试。
    const MAX_STEP_RETRIES = 0;
    const RETRY_BASE_MS = 1200;

    function sourceMeta(step, context){
        return {
            userPrompt: step.user_prompt || context.userPrompt || '',
            professionalPrompt: step.professional_prompt || step.prompt || '',
            promptVersion: step.prompt_version || 'canvas-agent-v1',
            conversationId: context.conversationId || '',
            messageId: context.messageId || '',
            workflowId: context.workflowId || '',
            inputArtifactIds: Array.isArray(step.input_artifact_ids) ? step.input_artifact_ids.slice() : [],
            outputArtifactId: String(step.output_artifact_id || ''),
            dependsOnSteps: Array.isArray(step.depends_on_steps) ? step.depends_on_steps.slice() : []
        };
    }
    function stepDependsOnPrevious(step){
        if(!step) return false;
        if(step.depends_on_previous === true || step.use_previous_results === true) return true;
        if(Array.isArray(step.depends_on_steps) && step.depends_on_steps.length) return true;
        const mode = String(step.dependency_mode || '').toLowerCase();
        return mode === 'fusion' || mode === 'product_reference';
    }
    function stepDependencyMode(step){
        const raw = String(step?.dependency_mode || '').trim().toLowerCase();
        if(raw === 'fusion' || raw === 'product_reference' || raw === 'none') return raw;
        if(stepDependsOnPrevious(step)){
            const prompt = String(step?.professional_prompt || step?.prompt || '');
            if(/融合|组合|结合|合成|拼合|合并/.test(prompt)) return 'fusion';
            return 'product_reference';
        }
        return 'none';
    }
    function stripSharedStylePrefix(text=''){
        return String(text || '')
            .replace(/【统一设定[·・]?不可变更】[^\n]*/g, ' ')
            .replace(/统一设定[·・]?不可变更[：:][^\n]*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function extractSubjectLabel(text='', index=0){
        let t = stripSharedStylePrefix(text);
        t = t
            .replace(/请严格参考[^。\n]*/g, ' ')
            .replace(/用户原意[：:][^。\n]*/g, ' ')
            .replace(/将它们融合为同一张完整画面[^。\n]*/g, ' ')
            .replace(/保持各主体外形与关键特征一致[^。\n]*/g, ' ')
            .replace(/【统一设定[·・]?不可变更】/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if(!t) return `素材${index + 1}`;
        // Prefer complete subject phrases: 一只黑猫 / 一只狗狗 / 产品包装
        // 若描述是“与A...的B/一只与A...的B”，优先取尾部主体 B
        const relative = t.match(/与[^，。；\n]{1,20}?的([\u4e00-\u9fffA-Za-z0-9]{1,12}?(?:猫猫|猫咪|黑猫|橘猫|白猫|猫|狗狗|小狗|犬|狗|包装|产品|场景))/);
        if(relative && relative[1]) return relative[1].slice(0, 12);
        // 再找完整“一只XXX”
        const animal = t.match(/(?:一只|一个|一位)(?!与)([\u4e00-\u9fffA-Za-z0-9]{1,12}?(?:猫猫|猫咪|黑猫|橘猫|白猫|猫|狗狗|小狗|犬|狗|老虎|狮子|小熊|兔子|小鸟|金鱼|女孩|男孩|男人|女人|人物|包装|产品))/);
        if(animal && animal[1]) return animal[1].slice(0, 12);
        const patterns = [
            /([\u4e00-\u9fffA-Za-z0-9]{0,8}?(?:狗狗|小狗|犬|狗|猫猫|猫咪|黑猫|橘猫|白猫|猫|老虎|狮子|小熊|兔子|小鸟|金鱼|女孩|男孩|男人|女人|人物|包装|产品|场景|背景))/,
            /([\u4e00-\u9fff]{1,8}(?:包装|产品|三视图|主图|详情页))/
        ];
        for(const re of patterns){
            const m = t.match(re);
            if(m && m[1] && !/^与/.test(m[1])) return m[1].slice(0, 12);
        }
        // Avoid starting with connective words like 与/和/的
        const first = (t.split(/[，。；;\n]/)[0] || t).replace(/^(?:与|和|的|及)\s*/, '');
        return first.slice(0, 12) || `素材${index + 1}`;
    }
    function cleanFusionActionText(basePrompt='', userText=''){
        let base = stripSharedStylePrefix(basePrompt);
        const user = String(userText || '').trim();
        base = base
            .replace(/请严格参考[\s\S]*?(?=(?:将|把|生成|创作|描绘|一只|一个|场景|画面|$))/g, '')
            .replace(/将(?:图\s*\d+|它们|以上|前面)[^\n。]*融合[^\n。]*/g, '')
            .replace(/保持各主体外形与关键特征一致[^\n。]*/g, '')
            .replace(/统一光影[、,，]?透视与色彩[^\n。]*/g, '')
            .replace(/构图自然协调[^\n。]*/g, '')
            .replace(/高质量成像[^\n。]*/g, '')
            .replace(/用户原意[：:]\s*/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        // Prefer pure action/scene clause from user text
        const actionPatterns = [
            /(?:再|然后)?(?:生成|创作|制作)?(?:一张)?(?:这只|该|这些)?[^\n，。]{0,20}?(?:猫[^，。]{0,12}狗|狗[^，。]{0,12}猫)[^，。]{0,20}?(?:打架|互动|对峙|追逐|奔跑|拥抱|同框|一起)[^，。]{0,20}/,
            /(?:再|然后)?(?:生成|创作|制作)?(?:一张)?[^\n，。]{0,30}?(?:打架|互动|对峙|追逐|奔跑|拥抱|同框|融合|组合)[^，。]{0,30}/
        ];
        for(const re of actionPatterns){
            const um = user.match(re);
            if(um){
                return um[0]
                    .replace(/^(?:先|再|然后)/, '')
                    .replace(/^(?:生成|创作|制作)(?:一张|一幅)?/, '')
                    .trim() || um[0].trim();
            }
        }
        if(base && base.length < 80 && /打架|互动|融合|组合|场景|同框|一起/.test(base)) return base;
        // fallback: last clause of user
        const parts = user.split(/[，。；;\n]/).map(s=>s.trim()).filter(Boolean);
        const last = parts.reverse().find(s => /打架|互动|融合|组合|场景|同框|一起|对峙/.test(s));
        if(last) return last.replace(/^(?:再|然后)?(?:生成|创作|制作)(?:一张|一幅)?/, '').trim() || last;
        return base || user || '将参考图中的主体自然融合到同一完整画面中，动作与场景协调，构图清晰。';
    }
    function buildProductReferencePrompt(productImages, userText, basePrompt){
        const labels = productImages.map((img, i) => {
            const short = extractSubjectLabel(img.prompt || img.name || '', i);
            return `图${i + 1}（${short}）`;
        }).join('、');
        const user = String(userText || '').trim();
        let base = stripSharedStylePrefix(basePrompt);
        base = base
            .replace(/请严格参考[\s\S]*?作为产品一致性参考[。.]?/g, '')
            .replace(/后续页面必须保持同一产品[^\n。]*/g, '')
            .replace(/用户原意[：:][^\n]*/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const head = `请严格参考 ${labels || '图1'}（按参考图数组顺序）作为产品一致性参考。后续页面必须保持同一产品外形、材质、Logo、包装识别完全一致，只更换页面构图与文案，不要把多页融合成一张。`;
        if(base && /产品一致性|严格参考|参考图|图\s*\d+/.test(base) && base.length < 220){
            return base;
        }
        return `${head}${base ? `\n${base}` : ''}${user && !base.includes(user) ? `\n用户原意：${user}` : ''}`;
    }
    function sleep(ms){
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    function isRetryableError(errorOrResult){
        const text = String(errorOrResult?.error || errorOrResult?.message || errorOrResult || '').toLowerCase();
        return /503|service unavailable|service.?bus|queue is full|timeout|temporar|rate limit|429|502|504|econnreset|network|busy|重试|稍后/.test(text);
    }
    function collectEntryImages(entry){
        const fullPrompt = entry.step?.professional_prompt || entry.step?.prompt || entry.meta?.professionalPrompt || '';
        const subject = extractSubjectLabel(fullPrompt || entry.step?.user_prompt || '', Number(entry.index || 0));
        return (entry?.result?.images || []).map(img => ({
            url: img.url,
            name: img.name || subject || 'previous',
            nodeId: img.nodeId || entry.result?.outputNodeId || entry.outputNodeId || entry.runNodeId || '',
            prompt: subject || fullPrompt,
            fullPrompt,
            subject
        })).filter(x => x.url);
    }
    function collectPrevImages(entries){
        return entries.flatMap(collectEntryImages);
    }
    function mergeReferences(existing, prevImages){
        const base = Array.isArray(existing) ? existing.slice() : [];
        const seen = new Set(base.map(r => r?.url).filter(Boolean));
        prevImages.forEach(r => {
            if(!r?.url || seen.has(r.url)) return;
            seen.add(r.url);
            base.push(r);
        });
        return base;
    }
    function buildFusionPrompt(prevImages, userText, basePrompt){
        const labels = prevImages.map((img, i) => {
            const short = extractSubjectLabel(img.subject || img.prompt || img.name || '', i);
            return `图${i + 1}（${short}）`;
        }).join('、');
        const action = cleanFusionActionText(basePrompt, userText);
        let prompt = `请严格参考${labels}（按参考图数组顺序），将参考图中的主体自然融合到同一完整画面：${action}`;
        prompt = prompt.replace(/：请严格参考/g, '：').replace(/\s+/g, ' ').trim();
        if(!/保持各主体外形|外形与关键特征/.test(prompt)){
            prompt += '。保持各主体外形与关键特征与参考图一致，统一光影与透视，构图自然协调。';
        }
        return prompt;
    }
    function pushLog(context, message, level='info', extra={}){
        const logs = context.logs || (context.logs = []);
        const item = {
            id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            ts: Date.now(),
            level,
            message: String(message || ''),
            ...extra
        };
        logs.push(item);
        try { context.onLog?.(item, logs.slice()); } catch(_){}
        return item;
    }
    async function executeClassic(host, step, context, anchor){
        const requested = clone(step.settings || {});
        const resolved = host.resolveGenerationSettings(requested);
        const meta = sourceMeta(step, context);
        const count = Math.max(1, Math.min(8, Number(resolved.count) || 1));
        const prompt = host.createNode('prompt', {
            text: meta.professionalPrompt,
            professionalPrompt: meta.professionalPrompt,
            agentSource: {...meta, requestedSettings: requested, resolvedSettings: resolved}
        }, {x: anchor.x, y: anchor.y});
        const generator = host.createNode('generator', {
            apiProvider: resolved.provider_id,
            model: resolved.model,
            ratio: resolved.ratio,
            resolution: resolved.resolution,
            quality: resolved.quality,
            count,
            customRatio: resolved.custom_ratio,
            customSize: resolved.custom_size,
            agentSource: {...meta, requestedSettings: requested, resolvedSettings: resolved}
        }, {x: anchor.x + 380, y: anchor.y});
        const output = host.createNode('output', {
            images: [],
            agentCreated: true,
            // 不预创建 placeholder pending，防止与 runGenerator 真实读秒叠加成两个
            _pending: []
        }, {x: anchor.x + 760, y: anchor.y});
        host.connectNodes(prompt.id, generator.id);
        host.connectNodes(generator.id, output.id);
        const refNodes = [];
        const finalRefs = [];
        for(const ref of (step.references || [])){
            if(!ref?.url && !ref?.nodeId) continue;
            let nodeId = resolveRefNodeId(host, ref);
            // 已有 nodeId 但可能是空壳：补 url，保证 generatorSources 能识别
            if(nodeId && ref?.url && host.updateNode){
                try{
                    const existing = host.getNode(nodeId);
                    if(existing && !existing.url){
                        host.updateNode(nodeId, {
                            url: ref.url,
                            name: ref.name || existing.name || 'reference',
                            images: Array.isArray(existing.images) && existing.images.length
                                ? existing.images
                                : [{url: ref.url, name: ref.name || 'reference', kind: ref.kind || 'image'}]
                        });
                    }
                }catch(_){ }
            }
            // 仅当整张画布都找不到该 URL 节点时才创建一次
            if(!nodeId && ref?.url && host.createImageNode){
                try{
                    const created = host.createImageNode({url:ref.url, name:ref.name||'reference', kind:ref.kind||'image'}, {x: Number(anchor.x||0) - 420, y: Number(anchor.y||0) + refNodes.length * 320});
                    nodeId = created?.id || '';
                    if(nodeId){
                        ref.nodeId = nodeId;
                        const key = normalizeRefUrl(ref.url);
                        if(key) refNodeCache.set(key, nodeId);
                    }
                }catch(err){
                    console.warn('[canvas-plan-executor] classic createImageNode failed', err);
                }
            }
            if(nodeId){
                refNodes.push(nodeId);
                try { host.connectNodes(nodeId, generator.id, {kind: 'reference'}); } catch(err){
                    console.warn('[canvas-plan-executor] classic connect ref failed', nodeId, generator.id, err);
                }
                finalRefs.push({url: ref.url || '', name: ref.name || 'reference', kind: ref.kind || 'image', nodeId, imageIndex: ref.imageIndex ?? 0});
            } else if(ref?.url){
                finalRefs.push({url: ref.url, name: ref.name || 'reference', kind: ref.kind || 'image', nodeId: '', imageIndex: ref.imageIndex ?? 0});
            }
        }
        // 同步 generator 输入顺序 + 强制写 inputs，确保运行时能读到参考图连线
        if(host.updateNode){
            try{
                const genNode = host.getNode(generator.id);
                const inputIds = finalRefs.map(r => r.nodeId).filter(Boolean);
                host.updateNode(generator.id, {
                    inputs: Array.from(new Set([...(genNode?.inputs || []), ...inputIds, prompt.id])),
                    agentReferences: finalRefs,
                    references: finalRefs
                });
            }catch(_){ }
        }
        // 连线/刷新后再次强制写回 Agent 模型，防止画布渲染把 model 重置为默认
        if(host.updateNode){
            try{
                host.updateNode(generator.id, {
                    apiProvider: resolved.provider_id,
                    model: resolved.model,
                    ratio: resolved.ratio,
                    resolution: resolved.resolution,
                    quality: resolved.quality,
                    count
                });
            }catch(_){}
        }
        try { if(typeof syncGeneratorInputs === 'function') syncGeneratorInputs(); } catch(_){}
        try { if(typeof refreshGeneratorInputViews === 'function') refreshGeneratorInputViews(); } catch(_){}
        return {nodeIds: [...refNodes, prompt.id, generator.id, output.id], runNodeId: generator.id, outputNodeId: output.id, resolvedSettings: resolved, meta, step};
    }
    async function executeSmart(host, step, context, anchor){
        const requested = clone(step.settings || {});
        const resolved = host.resolveGenerationSettings(requested);
        const meta = sourceMeta(step, context);
        const refs = clone(step.references || []);
        const professionalPrompt = String(meta.professionalPrompt || '');
        const promptHtml = professionalPrompt.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const count = Math.max(1, Math.min(8, Number(resolved.count) || 1));
        const engine = (() => {
            const id = String(resolved.provider_id || '').toLowerCase();
            if(id === 'volcengine') return 'volcengine';
            if(id === 'modelscope') return 'modelscope';
            if(id === 'runninghub') return 'runninghub';
            if(id === 'comfy' || id === 'comfyui') return 'comfy';
            return 'api';
        })();
        const runSettings = {
            engine, apiKind: 'image',
            provider_id: resolved.provider_id, model: resolved.model,
            ratio: resolved.ratio, resolution: resolved.resolution, quality: resolved.quality,
            count, customRatio: resolved.custom_ratio || '', customSize: resolved.custom_size || ''
        };
        const node = host.createNode('smart-image', {
            title: String(step.title || step.id || (stepDependencyMode(step) === 'product_reference' ? '产品参考生成中...' : (refs.length ? '融合生成中...' : '生成中...'))),
            professionalPrompt,
            promptDraftText: professionalPrompt,
            promptDraftHtml: promptHtml,
            userPrompt: meta.userPrompt,
            promptVersion: meta.promptVersion,
            conversationId: meta.conversationId,
            messageId: meta.messageId,
            workflowId: meta.workflowId,
            requestedSettings: requested,
            resolvedSettings: resolved,
            runSettings,
            references: refs,
            status: 'running',
            pending: count,
            runStartedAt: Date.now(),
            runTimerHidden: false,
            agentCreated: true,
            agentSource: {...meta, requestedSettings: requested, resolvedSettings: resolved}
        }, {x: anchor.x, y: anchor.y});
        const refNodes = [];
        const finalRefs = [];
        for(const ref of (refs || [])){
            if(!ref?.url && !ref?.nodeId) continue;
            let nodeId = resolveRefNodeId(host, ref);
            if(nodeId && ref?.url && host.updateNode){
                try{
                    const existing = host.getNode(nodeId);
                    if(existing && !(existing.url || (existing.images||[]).some(x=>x?.url))){
                        host.updateNode(nodeId, {
                            url: ref.url,
                            images: [{url: ref.url, name: ref.name || 'reference', kind: ref.kind || 'image'}],
                            title: ref.name || existing.title || 'Reference',
                            status: 'completed',
                            pending: 0
                        });
                    }
                }catch(_){ }
            }
            // 仅当整张画布都找不到该 URL 节点时才创建一次
            if(!nodeId && ref?.url && host.createImageNode){
                try{
                    const created = host.createImageNode({url:ref.url, name:ref.name||'reference', kind:ref.kind||'image'}, {x: Number(anchor.x||0) - 420, y: Number(anchor.y||0) + refNodes.length * 320});
                    nodeId = created?.id || '';
                    if(nodeId){
                        ref.nodeId = nodeId;
                        const key = normalizeRefUrl(ref.url);
                        if(key) refNodeCache.set(key, nodeId);
                    }
                }catch(err){
                    console.warn('[canvas-plan-executor] smart createImageNode failed', err);
                }
            }
            if(nodeId){
                ref.nodeId = nodeId;
                refNodes.push(nodeId);
                try { host.connectNodes(nodeId, node.id, {kind: 'input'}); } catch(err){
                    console.warn('[canvas-plan-executor] smart connect ref failed', nodeId, node.id, err);
                }
            }
            if(ref?.url) finalRefs.push({url:ref.url, name:ref.name||'reference', kind:ref.kind||'image', nodeId: nodeId||'', imageIndex: ref.imageIndex??0});
        }
        // 同步 references（含 nodeId）到节点，供后续运行与 UI 读取；有参考图时强制 references 非空
        if(host.updateNode){
            host.updateNode(node.id, {
                references: finalRefs,
                status: node.status || 'running',
                // 再次锁模型/引擎：防止 create/refresh 后节点显示回落到画布默认模型
                runSettings,
                resolvedSettings: {...resolved, engine: runSettings.engine},
                requestedSettings: {...requested, engine: runSettings.engine},
                professionalPrompt,
                promptDraftText: professionalPrompt,
                promptDraftHtml: promptHtml,
                agentCreated: true
            });
            // 若宿主支持，再强制锁一次，确保底部 composer 读到正确 engine/model
            try{
                const live = host.getNode?.(node.id);
                if(live && typeof host.updateNode === 'function'){
                    // no-op placeholder for clarity; runNode will lock again
                }
            }catch(_){ }
        } else {
            node.references = finalRefs;
            node.runSettings = runSettings;
            node.resolvedSettings = resolved;
        }
        return {nodeIds: [...refNodes, node.id], runNodeId: node.id, outputNodeId: node.id, resolvedSettings: resolved, meta, step};
    }
    async function runOneEntryWithRetry(host, entry, workflowId, context, label){
        let lastError = '';
        for(let attempt = 1; attempt <= MAX_STEP_RETRIES + 1; attempt++){
            if(context.stopRequested?.()){
                entry.result = {status: 'stopped', nodeId: entry.runNodeId, outputNodeId: entry.outputNodeId || entry.runNodeId || '', images: [], error: '已停止'};
                pushLog(context, `${label} 已停止`, 'warn', {stepId: entry.stepId, attempt});
                return entry.result;
            }
            try{
                if(attempt > 1){
                    pushLog(context, `${label} 第 ${attempt} 次重试…`, 'warn', {stepId: entry.stepId, attempt});
                    // 重试前把节点重新置为 pending 读秒
                    if(host.updateNode && entry.runNodeId){
                        const count = Math.max(1, Number(entry.step?.settings?.count) || 1);
                        host.updateNode(entry.runNodeId, {
                            status: 'running',
                            pending: count,
                            runStartedAt: Date.now(),
                            runTimerHidden: false,
                            title: stepDependencyMode(entry.step) === 'product_reference' ? '产品参考重试中...' : ((entry.step?.references || []).length ? '融合重试中...' : '重试生成中...')
                        });
                    }
                    await sleep(RETRY_BASE_MS * attempt);
                }else{
                    pushLog(context, `${label} 开始生成`, 'info', {stepId: entry.stepId, attempt});
                }
                const result = await host.runNode(entry.runNodeId, {workflowId, attempt});
                const images = (result?.images || []).filter(img => img?.url);
                if(images.length){
                    // 二次写回：防止 await 期间 nodes 被合并替换后，结果只进了 Agent 侧、画布节点仍空白
                    const targetId = result?.outputNodeId || entry.outputNodeId || entry.runNodeId || '';
                    if(targetId && host.applyNodeImages){
                        try{ host.applyNodeImages(targetId, images); }catch(applyErr){ console.warn('[canvas-plan-executor] applyNodeImages failed', applyErr); }
                    } else if(targetId && host.updateNode){
                        try{
                            host.updateNode(targetId, {
                                images,
                                status: 'completed',
                                pending: 0,
                                running: false,
                                queued: false,
                                title: images.length > 1 ? 'Group' : 'Image'
                            });
                        }catch(_){}
                    }
                    // 若目标节点已不在画布，尝试用 run 节点写回
                    if(entry.runNodeId && entry.runNodeId !== targetId && host.applyNodeImages){
                        try{
                            const live = host.getNode?.(entry.runNodeId);
                            if(live && !(live.images||[]).some(x=>x?.url)) host.applyNodeImages(entry.runNodeId, images);
                        }catch(_){}
                    }
                    entry.result = {...result, images, status: result?.status === 'stopped' ? 'stopped' : 'completed', outputNodeId: targetId || result?.outputNodeId || entry.outputNodeId || entry.runNodeId || ''};
                    pushLog(context, `${label} 成功（${images.length} 张）`, 'ok', {stepId: entry.stepId, attempt, count: images.length});
                    return entry.result;
                }
                lastError = result?.error || '未返回图片';
                entry.result = {status: 'failed', nodeId: entry.runNodeId, outputNodeId: entry.outputNodeId || entry.runNodeId || '', images: [], error: lastError};
                if(!isRetryableError(lastError) || attempt > MAX_STEP_RETRIES){
                    pushLog(context, `${label} 失败：${lastError}`, 'error', {stepId: entry.stepId, attempt});
                    return entry.result;
                }
                pushLog(context, `${label} 暂时失败，准备重试：${lastError}`, 'warn', {stepId: entry.stepId, attempt});
            }catch(error){
                lastError = String(error.message || error);
                entry.result = {status: 'failed', nodeId: entry.runNodeId, outputNodeId: entry.outputNodeId || entry.runNodeId || '', images: [], error: lastError};
                if(!isRetryableError(lastError) || attempt > MAX_STEP_RETRIES){
                    pushLog(context, `${label} 失败：${lastError}`, 'error', {stepId: entry.stepId, attempt});
                    return entry.result;
                }
                pushLog(context, `${label} 暂时失败，准备重试：${lastError}`, 'warn', {stepId: entry.stepId, attempt});
            }
        }
        return entry.result;
    }
    async function executeCanvasPlan(plan, context = {}){
        try{ refNodeCache.clear(); }catch(_){ }
        const host = window.CanvasAgentHost;
        if(!host || host.schemaVersion < 2) throw new Error('当前画布版本不支持 Agent 节点编排');
        const workflowId = context.workflowId || `awf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const logs = context.logs || (context.logs = []);
        const workflow = {
            id: workflowId,
            conversationId: context.conversationId || '',
            messageId: context.messageId || '',
            status: 'creating_nodes',
            canvasKind: host.canvasKind(),
            plan: clone(plan),
            nodeIds: [],
            activeTaskIds: [],
            steerQueue: [],
            logs,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        const entries = [];
        try{
            const base = host.getViewportAnchor({preferSelection: true});
            const steps = (plan.steps || []).filter(step => ['generate_image', 'edit_image'].includes(step.operation));
            const independent = [];
            const dependent = [];
            steps.forEach((step, index) => {
                const item = {step, index};
                if(stepDependsOnPrevious(step)) dependent.push(item);
                else independent.push(item);
            });
            // 依赖关系以 LLM/上游步骤字段为准，执行器不再根据关键词二次改写计划

            const fusionCount = dependent.filter(item => stepDependencyMode(item.step) === 'fusion').length;
            const productRefCount = dependent.filter(item => stepDependencyMode(item.step) === 'product_reference').length;
            
            // ---- Wave 1: create + run independent ----
            const wave1Tx = host.beginTransaction('AI Agent independent');
            const wave1Entries = [];
            for(const item of independent){
                const {step, index} = item;
                const anchor = {x: base.x, y: base.y + index * 420};
                const entry = host.canvasKind() === 'classic'
                    ? await executeClassic(host, step, {...context, workflowId}, anchor)
                    : await executeSmart(host, step, {...context, workflowId}, anchor);
                const packed = {...entry, stepId: step.id || `step_${index + 1}`, index, phase: 'independent'};
                wave1Entries.push(packed);
                entries.push(packed);
                workflow.nodeIds.push(...entry.nodeIds);
            }
            host.commitTransaction(wave1Tx);
            await host.saveCanvas();
            host.selectNodes(workflow.nodeIds);

            if(plan.auto_run !== false){
                workflow.status = 'running';
                                await Promise.all(wave1Entries.map((entry, i) =>
                    runOneEntryWithRetry(host, entry, workflowId, context, `步骤${entry.index + 1}`)
                ));
                await host.saveCanvas();
            }

            const successIndependent = wave1Entries.filter(e => (e.result?.images || []).some(img => img?.url));
            const failedIndependent = wave1Entries.filter(e => !(e.result?.images || []).some(img => img?.url));
            if(failedIndependent.length){ pushLog(context, `步骤完成：成功 ${successIndependent.length}/${wave1Entries.length}`, 'warn'); }

            // ---- Wave 2: dependent steps only if ALL independent succeeded ----
            if(dependent.length){
                if(failedIndependent.length){
                    pushLog(context, `前置素材未全部成功（失败 ${failedIndependent.length} 个），跳过依赖步骤`, 'error');
                    for(const item of dependent){
                        const {step, index} = item;
                        const mode = stepDependencyMode(step);
                        const packed = {
                            stepId: step.id || `step_${index + 1}`,
                            index,
                            phase: 'dependent',
                            step,
                            runNodeId: '',
                            outputNodeId: '',
                            nodeIds: [],
                            result: {
                                status: 'failed',
                                images: [],
                                error: `前置步骤未全部成功（${successIndependent.length}/${wave1Entries.length}），已跳过${mode === 'product_reference' ? '产品参考' : '融合'}步骤。请先重试失败的素材步骤。`
                            }
                        };
                        entries.push(packed);
                    }
                }else{
                    const prevImages = collectPrevImages(wave1Entries);
                    // 产品参考使用第一张成功的产品定稿；若规划还指定了原参考图，则一起合并
                    const productImages = prevImages.slice(0, 1);
                    // dependent steps mount refs silently
                    const wave2Tx = host.beginTransaction('AI Agent dependent');
                    const wave2Entries = [];
                    for(let di = 0; di < dependent.length; di++){
                        const item = dependent[di];
                        const {step, index} = item;
                        const mode = stepDependencyMode(step);
                        const anchor = {x: base.x + 80, y: base.y + (independent.length + di) * 420};
                        // product_reference：挂「产品定稿」并合并该步骤明确指定的原参考图
                        // fusion：挂全部前序成功图；若步骤本身还有精确附件引用则合并
                        const beforeRefCount = Array.isArray(step.references) ? step.references.filter(r => r?.url).length : 0;
                        let refs = [];
                        if(mode === 'product_reference'){
                            const existingUserRefs = (Array.isArray(step.references) ? step.references : []).filter(r => r?.url);
                            if(existingUserRefs.length && step.depends_on_previous !== true && step.use_previous_results !== true){
                                refs = existingUserRefs.slice();
                                step.references = refs.slice();
                                step.dependency_mode = 'none';
                            }else{
                                refs = mergeReferences((productImages || []).filter(r => r?.url).slice(0, 1), existingUserRefs);
                                step.references = refs.slice();
                                step.dependency_mode = 'product_reference';
                            }
                        }else{
                            refs = (prevImages || []).filter(r => r?.url);
                            step.references = mergeReferences([], refs);
                            step.dependency_mode = 'fusion';
                        }
                        step.operation = 'edit_image';
                        const mountedCount = Array.isArray(step.references) ? step.references.filter(r => r?.url).length : 0;
                        if(mode === 'product_reference'){
                            pushLog(context, `产品参考步骤挂载参考图 ${mountedCount} 张（产品定稿 + 指定原图，保留原提示词）`, 'info', {stepId: step.id || `step_${index + 1}`, mountedCount, beforeRefCount, prevCount: mountedCount});
                        }else{
                            pushLog(context, `融合步骤挂载参考图 ${mountedCount} 张（前序成功图，保留原提示词）`, 'info', {stepId: step.id || `step_${index + 1}`, mountedCount, beforeRefCount, prevCount: mountedCount});
                        }
                        step.prompt = step.professional_prompt || step.prompt;
                        const entry = host.canvasKind() === 'classic'
                            ? await executeClassic(host, step, {...context, workflowId}, anchor)
                            : await executeSmart(host, step, {...context, workflowId}, anchor);
                        // classic: also update prompt node text if possible
                        if(host.canvasKind() === 'classic' && entry.nodeIds?.[0] && host.updateNode){
                            host.updateNode(entry.nodeIds[0], {text: step.professional_prompt, professionalPrompt: step.professional_prompt});
                            // 同步 generator 节点上的模型/参数（避免显示画布默认模型）
                            if(entry.nodeIds?.[1] && entry.resolvedSettings){
                                host.updateNode(entry.nodeIds[1], {
                                    apiProvider: entry.resolvedSettings.provider_id,
                                    model: entry.resolvedSettings.model,
                                    ratio: entry.resolvedSettings.ratio,
                                    resolution: entry.resolvedSettings.resolution,
                                    quality: entry.resolvedSettings.quality,
                                    count: entry.resolvedSettings.count
                                });
                            }
                        } else if(host.canvasKind() === 'smart' && entry.runNodeId && host.updateNode){
                            host.updateNode(entry.runNodeId, {
                                professionalPrompt: step.professional_prompt,
                                promptDraftText: step.professional_prompt,
                                promptDraftHtml: String(step.professional_prompt||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
                            });
                        }
                        const packed = {...entry, stepId: step.id || `step_${index + 1}`, index, phase: 'dependent', step};
                        wave2Entries.push(packed);
                        entries.push(packed);
                        workflow.nodeIds.push(...entry.nodeIds);
                    }
                    host.commitTransaction(wave2Tx);
                    await host.saveCanvas();
                    host.selectNodes(workflow.nodeIds);
                    if(plan.auto_run !== false){
                        await Promise.all(wave2Entries.map(entry =>
                            runOneEntryWithRetry(host, entry, workflowId, context, `${stepDependencyMode(entry.step) === 'product_reference' ? '产品参考' : '融合'}步骤${entry.index + 1}`)
                        ));
                        await host.saveCanvas();
                    }
                }
            }

            const anyFailed = entries.some(e => e.result?.status === 'failed' || e.result?.status === 'stopped' || !(e.result?.images || []).some(img => img?.url));
            const anyDone = entries.some(e => (e.result?.images || []).some(img => img?.url));
            workflow.status = plan.auto_run === false ? 'ready' : (anyFailed && anyDone ? 'completed_with_errors' : anyFailed ? 'failed' : 'completed');
            workflow.updatedAt = Date.now();
            workflow.logs = logs;
            pushLog(context, `工作流结束：${workflow.status}`, anyFailed ? 'warn' : 'ok');
            await host.saveCanvas();
            host.selectNodes(workflow.nodeIds);
            host.focusNodes(workflow.nodeIds);
            return {workflow, entries: entries.sort((a, b) => a.index - b.index), logs};
        }catch(error){
            workflow.status = 'failed';
            workflow.error = String(error.message || error);
            workflow.updatedAt = Date.now();
            workflow.logs = logs;
            pushLog(context, `工作流异常：${workflow.error}`, 'error');
            throw Object.assign(error, {workflow, entries: entries.sort((a, b) => a.index - b.index), logs});
        }
    }
    window.CanvasAgentPlanExecutor = {execute: executeCanvasPlan};
})();
