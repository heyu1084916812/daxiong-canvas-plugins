(async function canvasAgentBootstrap() {
'use strict';
const currentScriptUrl = document.currentScript?.src || '';
const existingRoot = document.getElementById('canvas-agent-plugin-root');
// 防止脚本被注入两次导致双面板/双事件/双工作流
if(window.__canvasAgentBooting || window.CanvasAgentPlugin?.mounted) return;
window.__canvasAgentBooting = true;
if(existingRoot){
    // 上次可能只注入了面板 HTML 就中断了：清掉半成品后继续完整挂载
    try{
        existingRoot.remove();
        document.getElementById('agentPanel')?.remove();
        document.getElementById('agentToggle')?.remove();
        document.getElementById('smartSendAgentBtn')?.remove();
    }catch(_){ }
}
const pluginRoot = currentScriptUrl ? new URL('.', currentScriptUrl) : new URL('/plugins/canvas-agent/web/', location.origin);
const panelUrl = new URL('agent-panel.html', pluginRoot);
try{
    const scriptQuery = currentScriptUrl ? new URL(currentScriptUrl).search : '';
    if(scriptQuery) panelUrl.search = scriptQuery;
    else panelUrl.searchParams.set('v', String(Date.now()));
}catch(_){
    panelUrl.searchParams.set('v', String(Date.now()));
}
const fragment = await fetch(panelUrl, {cache:'no-store'}).then(async response => {
    if(!response.ok) throw new Error(`Canvas Agent panel load failed: ${response.status}`);
    return response.text();
});
const mountPoint = document.getElementById('shell') || document.body;
const marker = document.createElement('div');
marker.id = 'canvas-agent-plugin-root';
marker.hidden = true;
mountPoint.appendChild(marker);
marker.insertAdjacentHTML('afterend', fragment);

const agentToggle = document.getElementById('agentToggle');
const agentPanel = document.getElementById('agentPanel');
const agentCloseBtn = document.getElementById('agentCloseBtn');
const agentChatProvider = document.getElementById('agentChatProvider');
const agentChatModel = document.getElementById('agentChatModel');
const agentGenProvider = document.getElementById('agentGenProvider');
const agentGenModel = document.getElementById('agentGenModel');
const agentGenRatio = document.getElementById('agentGenRatio');
const agentGenResolution = document.getElementById('agentGenResolution');
const agentGenCount = document.getElementById('agentGenCount');
const agentMessages = document.getElementById('agentMessages');
const agentAttachRow = document.getElementById('agentAttachRow');
const agentAttachBtn = document.getElementById('agentAttachBtn');
const agentImageInput = document.getElementById('agentImageInput');
const agentInput = document.getElementById('agentInput');
const agentSendBtn = document.getElementById('agentSendBtn');
const agentInputModeSwitch = document.getElementById('agentInputModeSwitch');
const smartSendAgentBtn = document.getElementById('smartSendAgentBtn');
const agentHost = window.CanvasAgentHost || null;

// ==================== Lovart-style composer (inline image tokens) ====================
let agentGhostAttachments = [];
let agentComposerSyncing = false;
let agentLastSelectionSig = '';
// 生成任务会让宿主自动选中新输出节点；这种程序化选中不能被当成
// 用户主动选图，否则任务完成后会把上一轮结果偷偷塞回输入框。
let agentSuppressSelectionGhostSyncUntil = 0;
// 轮询只服务于 Ctrl/Shift 框选这类“先变选区、后没有节点 click”的手势。
// 普通的节点点击由 agentSelectionGhostClickHandler 立即处理；没有用户手势
// 的选区变化一律视为宿主程序行为，不得自动插入参考图。
let agentSelectionGestureUntil = 0;
// 刚确认过的选区签名：避免确认后轮询立刻又把同一选区刷回灰态；
// 但再次点击同一张图时会主动清掉，允许同图重复插入。
let agentGhostConfirmedSig = '';
let agentComposerCaret = null;
// 灰态预选插入锚点：点画布选图时固定，确认时仍插在“选图前的光标”，不跟 focus/click 跑到末尾
let agentGhostInsertCaret = null;
// 同一次 Output 图片点击会经过 pointerdown / pointerup / click；只允许其中一个阶段写入灰态芯片。
let agentClassicOutputCaptureUntil = 0;
// 鼠标一次选图会依次触发 pointerup 与 click；后者不能覆盖前者已合并的 Shift/Ctrl 多选结果。
let agentLastSelectionPointerUp = {nodeId:'', until:0};

function agentIsComposerEl(el=agentInput){
    return !!(el && el.getAttribute && el.getAttribute('contenteditable') === 'true');
}
function agentCloneCaretRange(range){
    if(!range) return null;
    try{ return range.cloneRange(); }catch(_){ return null; }
}
function agentCaretStillInComposer(range){
    if(!range || !agentIsComposerEl()) return false;
    try{
        return agentInput.contains(range.startContainer) && agentInput.contains(range.endContainer);
    }catch(_){ return false; }
}
function agentEscapeAttr(value){
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function agentAttachmentLimit(){
    try{
        const providers = typeof agentGenProviders === 'function' ? agentGenProviders() : [];
        const providerId = providers.some(item => item.id === agentState?.genProvider) ? agentState.genProvider : (providers[0]?.id || '');
        return providerId && typeof providerMaxReferenceImages === 'function'
            ? providerMaxReferenceImages(providerId)
            : AGENT_LLM_IMAGE_MAX;
    }catch(_){
        return AGENT_LLM_IMAGE_MAX;
    }
}
function agentRestoreComposerCaret(preferred=null){
    if(!agentIsComposerEl()) return false;
    const src = preferred || agentComposerCaret;
    if(!agentCaretStillInComposer(src)) return false;
    try{
        const sel = window.getSelection();
        if(!sel) return false;
        const range = src.cloneRange();
        sel.removeAllRanges();
        sel.addRange(range);
        agentComposerCaret = range.cloneRange();
        return true;
    }catch(_){ return false; }
}
function agentSaveComposerCaret({allowEmpty=false}={}){
    if(!agentIsComposerEl()) return agentComposerCaret;
    const sel = window.getSelection?.();
    if(!sel || !sel.rangeCount) return agentComposerCaret;
    const range = sel.getRangeAt(0);
    // 焦点已不在输入框时，保留上一次有效光标，避免点画布后 caret 被清空/跑偏
    if(!agentInput.contains(range.commonAncestorContainer)) return agentComposerCaret;
    // 点在灰态芯片上时不覆盖“真实输入光标”
    try{
        const n = range.commonAncestorContainer;
        const el = n.nodeType === 1 ? n : n.parentElement;
        if(el && el.closest && el.closest('.agent-inline-chip[data-agent-chip="ghost"]')){
            return agentComposerCaret;
        }
    }catch(_){}
    agentComposerCaret = range.cloneRange();
    return agentComposerCaret;
}
function agentChipLabel(name, index=1){
    const raw = String(name || '').trim();
    if(!raw) return `参考图${index}`;
    // 去掉扩展名，截断为适合芯片宽度的短名
    const base = raw.replace(/\.(png|jpe?g|webp|gif|bmp|svg)$/i, '');
    if(/^(?:image|img|图片|screenshot|clipboard)(?:[-_ ]?\d+)?$/i.test(base)) return `参考图${index}`;
    if(base.length <= 10) return base;
    return base.slice(0, 8) + '...';
}
function agentFocusCanvasAttachment(att){
    if(!att) return;
    try{
        if(att.nodeId){
            const node = (typeof nodes !== 'undefined' ? nodes : []).find(n => n?.id === att.nodeId);
            if(node){
                if(typeof selectedId !== 'undefined') selectedId = node.id;
                if(typeof selectedIds !== 'undefined'){
                    if(Array.isArray(selectedIds)) selectedIds = [];
                    else if(selectedIds instanceof Set) selectedIds.clear();
                }
                if(typeof agentHost?.selectNodes === 'function') agentHost.selectNodes([node.id]);
                agentCenterOnNode(node);
                if(typeof render === 'function') render();
                return;
            }
        }
        if(att.x || att.y){
            agentCenterOnPoint(Number(att.x) || 0, Number(att.y) || 0);
        }
    }catch(err){
        console.warn('[canvas-agent] focus canvas attachment failed', err);
    }
}
function agentMakeChipEl(att, {ghost=false, index=1}={}){
    const chip = document.createElement('span');
    chip.className = 'agent-inline-chip' + (ghost ? ' is-ghost' : '');
    chip.contentEditable = 'false';
    chip.dataset.agentChip = ghost ? 'ghost' : 'ref';
    if(att?.url) chip.dataset.url = att.url;
    if(att?.name) chip.dataset.name = att.name;
    if(att?.nodeId) chip.dataset.nodeId = att.nodeId;
    if(att?.x != null) chip.dataset.x = String(att.x);
    if(att?.y != null) chip.dataset.y = String(att.y);
    const label = agentChipLabel(att?.name, index);
    chip.title = att?.name || label;
    chip.innerHTML = `<img src="${agentEscapeAttr(att?.url || '')}" alt=""><span class="agent-inline-label">${agentEscapeAttr(label)}</span><button type="button" class="agent-inline-x" tabindex="-1" aria-label="移除">×</button>`;
    // 点击芯片跳转到画布对应图片（删除按钮除外）
    chip.addEventListener('mousedown', e => {
        if(e.target.closest('.agent-inline-x')) return;
        // 防止抢输入框 caret，但仍允许 click
        e.stopPropagation();
    });
    chip.addEventListener('click', e => {
        if(e.target.closest('.agent-inline-x')) return;
        e.preventDefault();
        e.stopPropagation();
        if(ghost) return;
        agentFocusCanvasAttachment({
            url: chip.dataset.url || '',
            name: chip.dataset.name || '',
            nodeId: chip.dataset.nodeId || '',
            x: Number(chip.dataset.x) || 0,
            y: Number(chip.dataset.y) || 0
        });
    });
    const xbtn = chip.querySelector('.agent-inline-x');
    if(xbtn){
        xbtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
        xbtn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            if(ghost){
                clearAgentGhostAttachment({rerender:true});
            }else{
                chip.remove();
                agentSyncAttachmentsFromComposer();
                agentRenumberInlineChips();
                renderAgentAttachments();
                saveAgentState();
                updateAgentPrimaryAction();
                agentAutoResizeInput();
            }
        });
    }
    return chip;
}
function agentGetComposerText(){
    if(!agentInput) return '';
    if(!agentIsComposerEl()) return String(agentInput.value || '');
    let out = '';
    const walk = (node) => {
        if(!node) return;
        if(node.nodeType === Node.TEXT_NODE){
            out += node.nodeValue || '';
            return;
        }
        if(node.nodeType !== Node.ELEMENT_NODE) return;
        if(node.classList?.contains('agent-inline-chip')) return;
        const tag = node.tagName;
        if(tag === 'BR'){ out += '\n'; return; }
        const block = /^(DIV|P|LI|SECTION|ARTICLE)$/i.test(tag);
        if(block && out && !out.endsWith('\n')) out += '\n';
        for(const child of node.childNodes) walk(child);
        if(block && out && !out.endsWith('\n')) out += '\n';
    };
    walk(agentInput);
    return out
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n+$/,'')
        .trimEnd();
}
function agentGetComposerParts(){
    // 保留输入框“文字 + 图片字符”混排结构，供发送气泡原样回显
    if(!agentInput) return [];
    if(!agentIsComposerEl()){
        const text = String(agentInput.value || '');
        const atts = Array.isArray(agentState?.attachments) ? agentState.attachments : [];
        const parts = [];
        if(text) parts.push({type:'text', text});
        atts.forEach((att, i) => {
            if(att?.url) parts.push({type:'image', url:att.url, name:att.name||`Image${i+1}`, nodeId:att.nodeId||'', x:Number(att.x)||0, y:Number(att.y)||0, refIndex:i+1});
        });
        return parts;
    }
    const parts = [];
    const pushText = (raw) => {
        const text = String(raw || '')
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .replace(/\u00a0/g, ' ');
        if(!text || !text.replace(/\s+/g,'').length && !text.includes('\n')){
            // 纯隐藏/纯空格不入 parts，避免点空白取消灰态后把空字符发给 agent
            if(!text || !/[\S\n]/.test(text)) return;
        }
        if(!String(text).replace(/\s+/g,'').length && text !== '\n') return;
        const last = parts[parts.length - 1];
        if(last && last.type === 'text') last.text += text;
        else parts.push({type:'text', text});
    };
    const walk = (node) => {
        if(!node) return;
        if(node.nodeType === 3){
            pushText(node.nodeValue || '');
            return;
        }
        if(node.nodeType !== 1) return;
        const el = node;
        if(el.classList && el.classList.contains('agent-inline-chip')){
            if(el.dataset.agentChip === 'ghost') return;
            const att = {
                type: 'image',
                url: el.dataset.url || '',
                name: el.dataset.name || 'image',
                nodeId: el.dataset.nodeId || '',
                x: Number(el.dataset.x) || 0,
                y: Number(el.dataset.y) || 0,
                refIndex: Number(el.dataset.refIndex) || (parts.filter(p => p.type==='image').length + 1)
            };
            if(att.url) parts.push(att);
            return;
        }
        const tag = el.tagName || '';
        if(tag === 'BR'){ pushText('\n'); return; }
        const block = /^(DIV|P|LI|SECTION|ARTICLE)$/i.test(tag);
        if(block && parts.length){
            const last = parts[parts.length - 1];
            if(last?.type === 'text' && !String(last.text).endsWith('\n')) pushText('\n');
        }
        for(const child of el.childNodes) walk(child);
        if(block){
            const last = parts[parts.length - 1];
            if(last?.type === 'text' && !String(last.text).endsWith('\n')) pushText('\n');
        }
    };
    walk(agentInput);
    while(parts.length && parts[0].type === 'text' && !String(parts[0].text).trim()) parts.shift();
    while(parts.length && parts[parts.length-1].type === 'text' && !String(parts[parts.length-1].text).trim()) parts.pop();
    return parts;
}
function agentRenderInlineChipHtml(att, index=1){
    const name = att?.name || att?.label || `Image${index}`;
    const short = agentChipLabel(name, index);
    const title = `参考图${index}: ${name}`;
    return `<span class="agent-inline-chip is-readonly" contenteditable="false" data-agent-chip="ref" data-url="${escapeHtml(att?.url||'')}" data-name="${escapeHtml(name)}" data-node-id="${escapeHtml(att?.nodeId||'')}" data-x="${Number(att?.x)||0}" data-y="${Number(att?.y)||0}" data-ref-index="${index}" title="${escapeHtml(title)}"><img src="${escapeHtml(att?.url||'')}" alt=""><span class="agent-inline-label">${escapeHtml(short)}</span></span>`;
}
function agentCollectComposerAttachments(){
    if(!agentInput || !agentIsComposerEl()){
        return Array.isArray(agentState?.attachments) ? agentState.attachments.slice() : [];
    }
    return [...agentInput.querySelectorAll('.agent-inline-chip[data-agent-chip="ref"]')].map(chip => ({
        url: chip.dataset.url || '',
        name: chip.dataset.name || 'image',
        nodeId: chip.dataset.nodeId || '',
        x: Number(chip.dataset.x) || 0,
        y: Number(chip.dataset.y) || 0
    })).filter(a => a.url);
}
function agentSyncAttachmentsFromComposer(){
    if(!agentState) return;
    agentState.attachments = agentCollectComposerAttachments();
}
function agentRenumberInlineChips(){
    if(!agentInput || !agentIsComposerEl()) return;
    [...agentInput.querySelectorAll('.agent-inline-chip[data-agent-chip="ref"]')].forEach((chip, i) => {
        const idx = i + 1;
        const labelEl = chip.querySelector('.agent-inline-label');
        const name = chip.dataset.name || `Image${idx}`;
        // 稳定展示：优先短名，同时 title 带参考图序号，便于用户/模型对齐
        const short = agentChipLabel(name, idx);
        if(labelEl) labelEl.textContent = short;
        chip.title = `参考图${idx}: ${name}`;
        chip.dataset.refIndex = String(idx);
    });
}
function agentInsertChipAtCaret(att, {ghost=false, forceCaret=false, preferredRange=null}={}){
    if(!agentIsComposerEl()) return null;
    // 优先插入到“用户当前/上次光标位置”，不要总是贴到输入框末尾
    const sel = window.getSelection();
    let range = null;
    if(preferredRange && agentCaretStillInComposer(preferredRange)){
        try{ range = preferredRange.cloneRange(); }catch(_){ range = null; }
    }
    if(!range && forceCaret && agentCaretStillInComposer(agentComposerCaret)){
        try{ range = agentComposerCaret.cloneRange(); }catch(_){ range = null; }
    }
    if(!range && sel && sel.rangeCount && agentInput.contains(sel.anchorNode)){
        // 当前选区若落在灰态芯片上，改用上次有效光标
        let useSel = true;
        try{
            const n = sel.anchorNode;
            const el = n && (n.nodeType === 1 ? n : n.parentElement);
            if(el && el.closest && el.closest('.agent-inline-chip[data-agent-chip="ghost"]')) useSel = false;
        }catch(_){}
        if(useSel) range = sel.getRangeAt(0).cloneRange();
    }
    if(!range && agentCaretStillInComposer(agentComposerCaret)){
        try{ range = agentComposerCaret.cloneRange(); }catch(_){ range = null; }
    }
    if(!range){
        range = document.createRange();
        range.selectNodeContents(agentInput);
        range.collapse(false);
    }
    try{ range.collapse(true); }catch(_){}
    try{ range.deleteContents(); }catch(_){}
    const index = agentCollectComposerAttachments().length + (ghost ? 0 : 1);
    const chip = agentMakeChipEl(att, {ghost, index: Math.max(1, index)});
    range.insertNode(chip);
    // 正式图片字符后只插入零宽光标锚点；不再插入可见空格，避免发送气泡出现空白符号
    let caretNode = chip;
    if(!ghost){
        const caretAnchor = document.createTextNode('\u200b');
        if(chip.nextSibling) chip.parentNode.insertBefore(caretAnchor, chip.nextSibling);
        else chip.parentNode.appendChild(caretAnchor);
        caretNode = caretAnchor;
    }
    const after = document.createRange();
    after.setStartAfter(caretNode);
    after.collapse(true);
    try{
        if(!ghost){
            sel?.removeAllRanges();
            sel?.addRange(after);
        }
    }catch(_){}
    // 灰态预览不覆盖真实输入光标；正式确认才推进 caret
    if(!ghost) agentComposerCaret = after.cloneRange();
    if(!ghost){
        agentSyncAttachmentsFromComposer();
        agentRenumberInlineChips();
    }
    return chip;
}
function agentFindGhostChips(){
    return agentInput ? [...agentInput.querySelectorAll('.agent-inline-chip[data-agent-chip="ghost"]')] : [];
}
function agentFindGhostChip(){
    return agentFindGhostChips()[0] || null;
}

function agentSyncGhostPendingUi(){
    try{
        const box = document.querySelector('.agent-onebox');
        if(!box) return;
        const pending = Array.isArray(agentGhostAttachments) && agentGhostAttachments.length > 0;
        box.classList.toggle('is-ghost-pending', pending);
        if(agentInput){
            agentInput.classList.toggle('is-ghost-pending', pending);
            // 灰态阶段：输入框未激活、无光标
            if(pending){
                try{ agentInput.setAttribute('aria-readonly', 'true'); }catch(_){ }
                if(document.activeElement === agentInput){
                    try{ agentInput.blur(); }catch(_){}
                }
            }else{
                try{ agentInput.removeAttribute('aria-readonly'); }catch(_){ }
            }
        }
    }catch(_){ }
}

function agentIsInvisibleComposerText(text=''){
    return !String(text || '').replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]/g, '').length;
}
function agentSanitizeComposerResidue(){
    if(!agentIsComposerEl() || !agentInput) return;
    // 去掉灰态残留的空文本节点 / 纯空白 BR / 零宽字符
    const walkRemove = [];
    const nodes = [...agentInput.childNodes];
    nodes.forEach(node => {
        if(node.nodeType === Node.TEXT_NODE){
            const raw = String(node.nodeValue || '');
            if(agentIsInvisibleComposerText(raw)) walkRemove.push(node);
            else if(/[\u00a0\u200b\u200c\u200d\ufeff]/.test(raw)){
                node.nodeValue = raw.replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ');
                if(agentIsInvisibleComposerText(node.nodeValue)) walkRemove.push(node);
            }
            return;
        }
        if(node.nodeType === Node.ELEMENT_NODE){
            const el = node;
            if(el.classList?.contains('agent-inline-chip') && el.dataset.agentChip === 'ghost'){
                walkRemove.push(el);
                return;
            }
            if(el.tagName === 'BR'){
                // 单独残留 BR 且前后无有效内容时清掉
                const prev = el.previousSibling;
                const next = el.nextSibling;
                const prevEmpty = !prev || (prev.nodeType===3 && agentIsInvisibleComposerText(prev.nodeValue));
                const nextEmpty = !next || (next.nodeType===3 && agentIsInvisibleComposerText(next.nodeValue));
                if(prevEmpty && nextEmpty) walkRemove.push(el);
            }
        }
    });
    walkRemove.forEach(n => { try{ n.remove(); }catch(_){ } });
    // 若输入框只剩不可见内容，彻底清空，避免“背后还带着空字符发给 agent”
    const text = agentGetComposerText();
    const hasChip = !!agentInput.querySelector('.agent-inline-chip[data-agent-chip="ref"]');
    if(!hasChip && agentIsInvisibleComposerText(text)){
        agentInput.innerHTML = '';
        if(agentState) agentState.attachments = [];
    }
    agentSyncAttachmentsFromComposer();
}
function clearAgentGhostAttachment({rerender=false}={}){
    agentGhostAttachments = [];
    agentGhostInsertCaret = null;
    // 同时清掉灰态芯片及其紧邻的隐藏空格/零宽字符
    agentFindGhostChips().forEach(el => {
        try{
            const next = el.nextSibling;
            if(next && next.nodeType === Node.TEXT_NODE && agentIsInvisibleComposerText(next.nodeValue || '')){
                next.remove();
            }
            const prev = el.previousSibling;
            if(prev && prev.nodeType === Node.TEXT_NODE && agentIsInvisibleComposerText(prev.nodeValue || '')){
                // 仅清纯隐藏残留，不误删用户正常空格词边界；这里只删全不可见文本
                prev.remove();
            }
        }catch(_){ }
        try{ el.remove(); }catch(_){ }
    });
    agentSanitizeComposerResidue();
    agentSyncGhostPendingUi();
    if(rerender){
        updateAgentPrimaryAction();
        agentAutoResizeInput();
    }
}
function agentAttachmentKey(att){
    if(!att) return '';
    return String(att.nodeId || '') + '|' + String(att.url || '');
}
function setAgentGhostAttachments(atts){
    const list = (Array.isArray(atts) ? atts : [atts]).filter(a => a?.url);
    if(!list.length){
        clearAgentGhostAttachment({rerender:true});
        agentGhostInsertCaret = null;
        return;
    }
    // 选图前先记住输入框光标，并固定为灰态插入锚点（确认时也用它）
    try{ agentSaveComposerCaret(); }catch(_){}
    if(agentCaretStillInComposer(agentComposerCaret)){
        agentGhostInsertCaret = agentCloneCaretRange(agentComposerCaret);
    } else if(!agentCaretStillInComposer(agentGhostInsertCaret)){
        agentGhostInsertCaret = null;
    }
    if(!agentOpen){
        // 打开 Agent 是灰态选图前提，不自动弹开
        return;
    }
    // 灰态预选：单选/多选都进灰态；同一张图允许反复插入
    agentGhostAttachments = [];
    for(const att of list){
        const item = {
            url: att.url,
            name: att.name || 'canvas-image',
            nodeId: att.nodeId || '',
            x: Number(att.x) || 0,
            y: Number(att.y) || 0
        };
        if(!item.url) continue;
        agentGhostAttachments.push(item);
    }
    // 灰态预览插在选图前光标位置（不是永远贴到末尾）
    agentFindGhostChips().forEach(el => el.remove());
    if(agentIsComposerEl()){
        // 多张灰态：第一张用选图前锚点，后续接在上一张后面，避免都插同一点导致乱序
        let anchor = agentGhostInsertCaret || agentComposerCaret;
        agentGhostAttachments.forEach((att) => {
            const chip = agentInsertChipAtCaret(att, {ghost:true, forceCaret:true, preferredRange:anchor});
            if(chip){
                try{
                    const after = document.createRange();
                    after.setStartAfter(chip.nextSibling && chip.nextSibling.nodeType === 3 ? chip.nextSibling : chip);
                    after.collapse(true);
                    anchor = after;
                }catch(_){ }
            }
        });
        // 恢复真实输入光标，灰态只是预览
        try{ /* 灰态阶段不激活输入框，不恢复光标 */ }catch(_){ }
    }
    agentSyncGhostPendingUi();
    updateAgentPrimaryAction();
    agentAutoResizeInput();
}
function setAgentGhostAttachment(att){
    // 兼容旧单图接口
    setAgentGhostAttachments(att ? [att] : []);
}
function confirmAgentGhostAttachment(){
    if(!Array.isArray(agentGhostAttachments) || !agentGhostAttachments.length) return false;
    const pending = agentGhostAttachments.slice();
    // 确认后锁住当前选区，防止 400ms 轮询立刻重刷灰态；同图再点会清锁
    agentGhostConfirmedSig = pending.map(a => `${a.nodeId||''}:${a.url||''}`).join('|');
    agentLastSelectionSig = agentGhostConfirmedSig;
    agentGhostAttachments = [];
    // 确认锚点优先用“选图前保存的光标”，不要用 focus/click 后落到末尾的 caret
    const insertAt = (agentCaretStillInComposer(agentGhostInsertCaret) ? agentGhostInsertCaret : null)
        || (agentCaretStillInComposer(agentComposerCaret) ? agentComposerCaret : null);
    agentGhostInsertCaret = null;
    agentFindGhostChips().forEach(el => el.remove());
    if(insertAt){
        try{ agentRestoreComposerCaret(insertAt); }catch(_){}
        agentComposerCaret = agentCloneCaretRange(insertAt);
    }
    if(!Array.isArray(agentState.attachments)) agentState.attachments = [];
    let added = 0;
    for(const att of pending){
        if(!att?.url) continue;
        // 同一张图允许重复插入；仅受数量上限限制
        if(agentState.attachments.length >= agentAttachmentLimit()){
            if(typeof toast === 'function') toast('参考图数量已达上限');
            break;
        }
        if(agentIsComposerEl()){
            // 关键：正式芯片插入选图前光标处，而不是末尾
            agentInsertChipAtCaret(att, {ghost:false, forceCaret:true, preferredRange: agentComposerCaret});
            agentSyncAttachmentsFromComposer();
        }else{
            agentState.attachments.push({...att});
        }
        added += 1;
    }
    agentRenumberInlineChips();
    renderAgentAttachments();
    saveAgentState();
    agentSyncGhostPendingUi();
    updateAgentPrimaryAction();
    agentAutoResizeInput();
    // 确认后真正激活输入框并恢复光标
    try{
        agentInput?.focus({preventScroll:true});
        if(agentComposerCaret) agentRestoreComposerCaret(agentComposerCaret);
    }catch(_){}
    return added > 0;
}
function agentRebuildComposerFromState(text=''){
    if(!agentIsComposerEl()){
        if(agentInput) agentInput.value = text || '';
        return;
    }
    agentComposerSyncing = true;
    try{
        agentInput.innerHTML = '';
        const value = agentSanitizeComposerDraft(text);
        if(value){
            const parts = value.split('\n');
            parts.forEach((line, i) => {
                agentInput.appendChild(document.createTextNode(line));
                if(i < parts.length - 1) agentInput.appendChild(document.createElement('br'));
            });
        }
        const atts = Array.isArray(agentState?.attachments) ? agentState.attachments : [];
        atts.forEach((att, i) => {
            if(att?.url) agentInput.appendChild(agentMakeChipEl(att, {index:i+1}));
        });
        if(Array.isArray(agentGhostAttachments) && agentGhostAttachments.length){
            agentGhostAttachments.forEach((att, i) => agentInput.appendChild(agentMakeChipEl(att, {ghost:true, index:i+1})));
        }
    }finally{
        agentComposerSyncing = false;
    }
    agentAutoResizeInput();
}
function agentFocusComposer(){
    if(!agentInput) return;
    agentInput.focus({preventScroll:true});
    setTimeout(() => agentInput.focus({preventScroll:true}), 0);
}
function agentClearComposer({keepGhost=false}={}){
    if(agentState) agentState.attachments = [];
    if(!keepGhost) agentGhostAttachments = [];
    if(agentIsComposerEl()){
        agentInput.innerHTML = '';
        if(keepGhost && agentGhostAttachments.length){
            agentGhostAttachments.forEach((att, i) => agentInput.appendChild(agentMakeChipEl(att, {ghost:true, index:i+1})));
        }
    }else if(agentInput){
        agentInput.value = '';
    }
}
function agentGetInputValue(){ return agentGetComposerText(); }
function agentSetInputValue(text){ agentRebuildComposerFromState(text); }
function agentSanitizeComposerDraft(value=''){
    // 旧版曾在保存时把图片字符的可见文案（例如“参考图1×”）当作普通草稿。
    // 它既不是用户输入，也不携带 url/nodeId；恢复后会成为隐藏的伪参考并污染下一次发送。
    const text = String(value || '')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/^[ \t]+|[ \t]+$/g, '');
    return /^(?:参考图\s*\d+\s*×?\s*)+$/.test(text) ? '' : text;
}
function agentComposerBeforeCaretText(){
    if(!agentIsComposerEl()){
        const val = agentInput?.value || '';
        const cursorPos = agentInput?.selectionStart || 0;
        return {val, cursorPos, before: val.slice(0, cursorPos)};
    }
    try{
        const sel = window.getSelection();
        if(sel && sel.rangeCount && agentInput.contains(sel.anchorNode)){
            const endRange = sel.getRangeAt(0);
            const preRange = document.createRange();
            preRange.selectNodeContents(agentInput);
            preRange.setEnd(endRange.endContainer, endRange.endOffset);
            const frag = preRange.cloneContents();
            const holder = document.createElement('div');
            holder.appendChild(frag);
            holder.querySelectorAll('.agent-inline-chip').forEach(n => n.remove());
            const before = (holder.innerText || holder.textContent || '').replace(/\u00a0/g, ' ');
            return {val: agentGetComposerText(), cursorPos: before.length, before};
        }
    }catch(_){}
    const val = agentGetComposerText();
    return {val, cursorPos: val.length, before: val};
}


function agentNodeImages(node){
    if(agentHost?.getNodeImages) return agentHost.getNodeImages(node) || [];
    return Array.isArray(node?.images) ? node.images.filter(item => item?.url) : [];
}
function agentApplyNodeImages(node, images){
    if(agentHost?.applyNodeImages) return agentHost.applyNodeImages(node, images);
    if(node) node.images = (images || []).map(item => ({...item}));
    return node;
}

function providerMaxReferenceImages(providerId){
    const provider = typeof apiProviderById === 'function' ? apiProviderById(providerId) : null;
    return Number(provider?.max_reference_images) > 0 ? Number(provider.max_reference_images) : 10;
}

// 每个对话各自持有 LLM stream。旧的两个全局变量只作为当前活动对话的 UI 兼容镜像，
// 不能再作为并发任务的所有权真相。
let _agentStreamTaskId = null;
let _agentStreamText = '';
const _agentStreamsByConversation = new Map();
function agentStreamOwnerId(conversationId=''){
    return String(conversationId || agentState?.activeConversationId || '').trim();
}
function agentGetStreamForConversation(conversationId=''){
    const ownerConversationId = agentStreamOwnerId(conversationId);
    return ownerConversationId ? (_agentStreamsByConversation.get(ownerConversationId) || null) : null;
}
function agentSyncLegacyStream(conversationId=''){
    const stream = agentGetStreamForConversation(conversationId);
    _agentStreamTaskId = stream?.taskId || null;
    _agentStreamText = stream?.text || '';
    return stream;
}
function startAgentStream(taskId, conversationId=''){
    const ownerConversationId = agentStreamOwnerId(conversationId);
    const stream = {taskId:String(taskId || ''), text:'', conversationId:ownerConversationId};
    if(ownerConversationId) _agentStreamsByConversation.set(ownerConversationId, stream);
    if(!ownerConversationId || agentState?.activeConversationId === ownerConversationId){
        _agentStreamTaskId = stream.taskId || null;
        _agentStreamText = '';
    }
    return stream;
}
function endAgentStream(taskId='', conversationId=''){
    const expectedTaskId = String(taskId || '');
    const ownerConversationId = agentStreamOwnerId(conversationId);
    // 无参数仅用于插件卸载：一次性清掉全部 runtime stream。
    if(!expectedTaskId && !conversationId){
        _agentStreamsByConversation.clear();
        agentMessages?.querySelector('.agent-stream-bubble')?.closest('.agent-msg')?.remove();
        _agentStreamTaskId = null;
        _agentStreamText = '';
        return true;
    }
    const stream = ownerConversationId ? _agentStreamsByConversation.get(ownerConversationId) : null;
    if(stream && expectedTaskId && stream.taskId !== expectedTaskId) return false;
    if(stream && ownerConversationId) _agentStreamsByConversation.delete(ownerConversationId);
    // A 完成时若用户正在 B，或当前兼容镜像已属于 B，绝不能移除/清空 B 的流式 UI。
    if((!ownerConversationId || agentState?.activeConversationId === ownerConversationId)
        && (!expectedTaskId || _agentStreamTaskId === expectedTaskId)){
        agentMessages?.querySelector('.agent-stream-bubble')?.closest('.agent-msg')?.remove();
        _agentStreamTaskId = null;
        _agentStreamText = '';
    }
    return true;
}
async function pollAgentLlmTask(taskId){
    if(!taskId) throw new Error('Invalid task ID');
    const startedAt = Date.now();
    while(Date.now() - startedAt < 5 * 60 * 1000){
        const response = await fetch(`/api/plugins/canvas-agent/llm-tasks/${encodeURIComponent(taskId)}`);
        if(!response.ok) throw new Error(await response.text());
        const task = await response.json();
        if(task.status === 'succeeded') return task.result || {};
        if(task.status === 'failed' || task.status === 'cancelled') throw new Error(task.error || 'LLM task failed');
        await new Promise(resolve => setTimeout(resolve, task.status === 'queued' ? 700 : 1500));
    }
    throw new Error('LLM task timeout (5min)');
}

// ==================== AI Agent 侧边面板 ====================
const AGENT_STORAGE_PREFIX = 'smart_agent_v1:';
const AGENT_STATE_API = '/api/plugins/canvas-agent/state';
// 跨画布记住理解/生图模型默认值，避免每次打开都重新选择
const AGENT_MODEL_DEFAULTS_KEY = 'smart_agent_v1:__model_defaults__';
const AGENT_SKILL_MAX_BYTES = 512 * 1024;
const AGENT_SKILL_API = '/api/plugins/canvas-agent/skills';
const AGENT_HISTORY_MAX = 20;
const AGENT_HISTORY_CHAR_MAX = 10000;
const AGENT_LLM_IMAGE_MAX = 8;
const AGENT_GEN_MAX_PER_MSG = 24; // B0+: 支持 5主图+8详情 等真实大批量套图，不再静默截断到 8
const AGENT_MSG_MAX = 60;
const AGENT_NL = String.fromCharCode(10);
// 阶段1：给用户看的策划正文 + 给程序用的紧凑任务单；两者分离，避免执行层再次猜语义。
const AGENT_UNDERSTAND_INSTRUCTION = `阶段1是 Skill 驱动的完整策划阶段。

当本轮启用了 Skill：
1) Skill 的角色定位、工作方法、页面结构、文案规则和合规规则是本轮不可覆盖的约束；不要把 Skill 当成风格参考，也不要用“画布生图 Agent”替换 Skill 的专业身份。
2) 画布 Agent 只负责阶段调度和后续节点执行；不得把 Skill 内容压缩成普通的“需求理解/参考图理解/提示词方案”摘要。
3) 按 Skill 自己规定的输出格式完成策划，但不要把任何通用模板硬套到 Skill 上。Skill 是风格预设、单图规则、套图模板或电商页面规范时，分别按其实际内容输出；只有 Skill 明确声明的字段才需要保留，不能因为没有“页面作用”等固定标题就判定失败。策划正文必须真正落到本轮用户任务：列出要交付的成果/步骤、每项的独立目标和最终画面/提示词方向；不能只复述 Skill 的角色、规则或约束。
4) 单独写出能够执行本轮任务的角色/约束、用户参数、参考图角色、产品依据和执行依赖（能从 Skill 或用户要求确定的才写）。若用户是在还原既有产品而当前缺少产品图/三视图，必须明确标记并停止正式生图；若用户明确要求从 Logo、色卡等创建一个全新产品，则必须标记为“概念产品设计”，先生成产品定稿，后续只以该定稿为产品依据。
5) 用户明确指定的数量、比例、画质、模型和语言覆盖 Skill 默认值；角色、产品一致性、转化逻辑和输出字段不能被覆盖。
6) 若 Skill 明确要求全局视觉约束，尽量在正文和 AGENT_TASK_SPEC.global_contract 中保留；标题可以使用 Skill 自己的命名，不要求固定中文标题。只有任务单显式提供 required_fields 时，才按这些字段做结构检查。

当本轮没有 Skill：按用户要求输出简洁但完整的自然语言策划。无论是否有 Skill，正文末尾都必须附加唯一的 AGENT_TASK_SPEC 任务单；deliverables 只描述已确认的成果类型、数量、比例和画质，global_contract 仅逐字镜像正文的三项全局约束，供完整性校验和后续无损绑定使用，不能替代正文。不要输出 generations，不要假装已经拉节点或生图。

任务单规则：每个有独立页面用途、提示词或依赖关系的成果应单独列为一个 deliverable（count=1）；只有用户明确要求同一提示词的同主题多张图时才使用 count>1。顺序必须是实际执行顺序，后续步骤必须显式依赖前置产物。

文末必须使用以下标记（把示例值替换成真实值）：
<!-- AGENT_TASK_SPEC
{"schema_version":2,"global_contract":{"visual_positioning":"视觉整体定位原文","unified_style_prompt":"统一风格提示词原文","unified_negative_prompt":"统一负面提示词原文"},"deliverables":[{"id":"step_1","type":"three_view|main|detail|variant|edit|fusion|other","title":"成果名称","count":1,"ratio":"1:1","resolution":"2k"}]}
AGENT_TASK_SPEC -->
`;
// 阶段2：只把已经确认的阶段1策划绑定成可执行步骤，不重新解释或改写需求。
const AGENT_DIRECT_PLAN_INSTRUCTION = `阶段2是已确认策划到执行任务表的无损绑定阶段，不是重新策划阶段。

你会收到：用户原始要求、已经确认的阶段1策划、用户本轮参考图、用户启用的 Skill（若有）。
当前只完成阶段2：
1. 以已经确认的阶段1策划和其中采用的 Skill 契约为唯一语义来源，不删减、不改写、不新增用户未确认的目标；Skill 的角色和页面字段必须落实到每个 generation.prompt/notes；
2. 把阶段1的每个成果逐项绑定为可执行步骤；
3. 为每一步明确参考图、前序依赖、模型参数和完整提示词；
4. 返回执行层所需 JSON。确认后画布将原样执行，不会再有另一个 LLM 改写提示词。

只返回原始 JSON，不要 markdown，不要 JSON 以外的文字：
{"reply":"整合后的需求理解与执行规划摘要","options":[],"prompts":[],"shared_style":"整套共用且必须出现在每张图中的视觉设定；没有则为空","plan":{"goal":"本轮最终目标","steps_summary":["步骤1","步骤2"],"constraints":["来自用户和Skill的关键约束"],"artifacts":[{"id":"artifact_1","type":"text|image|palette|product|plan","title":"阶段成果名称","description":"成果内容摘要"}]},"generations":[{"id":"step_1","title":"本张用途","role":"main","prompt":"本张最终、完整、纯净、可直接生图的提示词","count":1,"ratio":"square","resolution":"2k","use_attachments":true,"attachment_indices":[0],"input_artifact_ids":["artifact_1"],"output_artifact_id":"artifact_2","depends_on_previous":false,"dependency_mode":"none","notes":"本步参考图角色和执行说明"}]}

结构要求：
- generations 是执行唯一真相：最终要生成多少张，就输出多少个 generation；每张默认 count=1。
- 每个 generation 必须填写 role、ratio、resolution。用户同时要求主图和详情页使用不同参数时，必须逐步分别填写，禁止留空后交给工具栏兜底。
- ratio、resolution 必须与已确认的阶段1策划逐项一致，只做格式映射（如 1:1→square、9:16→story、4K→4k），禁止重新选择或使用工具栏默认值覆盖。
- 跨阶段成果必须显式写入 plan.artifacts，并在 generation.input_artifact_ids / output_artifact_id 中绑定；不能只在 prompt 里口头提及“上一阶段成果”。
- 每个 generation.prompt 必须在本次响应中直接定稿，完整包含该页应遵守的 Skill 约束、用户要求、画面内容、构图、光线、材质、配色、短文案和版式位置；禁止只写提纲或“按 Skill 执行”。
- 若 Skill 规定逐页字段，必须把阶段1对应页面的完整策划内容原样写入本步 generation.prompt（包括页面作用、画面内容、版式结构、文案层级、AI提示词和排版说明）；执行层只允许绑定参数、参考图和依赖，不得摘要、改写或只保留画面描述。
- Skill 可能是风格预设，也可能是完整任务模板、页数结构、文案规范或修改指令。必须按 Skill 原本含义使用，禁止一律解释成“单张图样式”。
- 用户明确指定的任务范围、数量、比例、画质或语言优先于 Skill 中的默认值；用户未指定时才使用 Skill 默认值。
- Skill 要求 5 主图、8 详情等结构而用户只明确要求 5 张主图时，只输出 5 张主图，但每张仍完整遵守 Skill 对主图的全部约束。
- 多页套图必须逐页写不同的完整 prompt；不能复制同一个 prompt，也不能把页面提纲当成 prompt。
- 有参考图时，按输入顺序编号为参考图1、参考图2……；attachment_indices 使用 0-based 索引精确绑定。prompt 中用执行节点顺序的“图一/图二”说明产品与风格关系。
- artifact_* 以及其它内部产物 ID 仅允许出现在 plan.artifacts、input_artifact_ids、output_artifact_id 等结构字段中；严禁写入 generation.prompt、professionalPrompt、plannedPrompt、notes、reply 或任何用户可见文本。提示词中需要指代这些产物时，只能按本步实际输入顺序写“参考图一/参考图二……”或自然语言描述，不能输出 artifact_1、artifact_step_1_output 等内部标识。
- 用户没有明确要求依赖前序生成图时，各步骤保持并行：depends_on_previous=false、dependency_mode="none"。
- 只有用户明确要求“先生成 A，再用 A 生成 B”或融合时才设置前序依赖。
- 信息不足但仍能依据 Skill 和参考图合理完成时直接规划，不要询问；只有缺少不可推断的关键输入时才返回 options，且 generations=[]。
- 明确的串行任务必须设置 output_artifact_id、后续 input_artifact_ids、depends_on_previous=true 和 dependency_mode=product_reference/fusion；执行器不得依赖 prompt 中的口头描述猜依赖。
`;
let agentOpen = false;
let agentSending = false;
let agentThinking = false;
let agentThinkingStage = ''; // understand | plan | ''

let agentBypassThinkingNext = false;
let agentSaveTimer = null;
let agentState = null;
let agentLocalStateCacheDisabled = false;
let agentStateBackendHydrated = false;
let agentStateBackendHydrating = false;
let agentStateBackendSyncing = false;
let agentStateBackendQueued = null;
let agentMentionIdx = -1;
let agentSkillSlashIdx = -1;
let agentSkillPresets = [];
let agentSkillEditingId = '';
let agentSkillPresetsLoaded = false;
let agentActiveWorkflow = null;
let agentStopRequested = false;
// 画布执行器是单实例资源：同一时刻只允许一个对话驱动画布。
// 锁只保存在当前页面运行时；每个对话自己的 workflow/pending 仍独立持久化。
let agentGlobalTaskOwnerConversationId = '';
function agentGlobalTaskOwner(){
    return String(agentGlobalTaskOwnerConversationId || '').trim();
}
function agentGlobalTaskOwnedBy(conversationId=''){
    const cid = String(conversationId || '').trim();
    return !!cid && agentGlobalTaskOwner() === cid;
}
function agentGlobalTaskOwnedByOther(conversationId=''){
    const owner = agentGlobalTaskOwner();
    const cid = String(conversationId || agentState?.activeConversationId || '').trim();
    return !!owner && (!cid || owner !== cid);
}
function agentTryAcquireGlobalTask(conversationId=''){
    const cid = String(conversationId || agentState?.activeConversationId || '').trim();
    if(!cid) return false;
    const owner = agentGlobalTaskOwner();
    // 入口必须取得一把全新的锁；同一对话的重复点击也不能重入。
    if(owner) return false;
    agentGlobalTaskOwnerConversationId = cid;
    return true;
}
function agentReleaseGlobalTask(conversationId=''){
    const cid = String(conversationId || '').trim();
    if(!cid || !agentGlobalTaskOwnedBy(cid)) return false;
    agentGlobalTaskOwnerConversationId = '';
    return true;
}
function agentNotifyGlobalTaskBlocked(){
    if(typeof toast === 'function') toast('另一个对话正在执行任务，请等待完成后再发送');
}
let agentCompositionActive = false;
const agentInputStateMachine = window.CanvasAgentInputStateMachine ? new window.CanvasAgentInputStateMachine() : null;
function agentPendingStore(){
    if(!agentState) return {};
    if(!agentState._pendingByConversation || typeof agentState._pendingByConversation !== 'object' || Array.isArray(agentState._pendingByConversation)){
        agentState._pendingByConversation = {};
    }
    const store = agentState._pendingByConversation;
    // 新格式 conversations[].pending 先并入运行时 map。
    (Array.isArray(agentState.conversations) ? agentState.conversations : []).forEach(conv => {
        if(conv?.id && conv.pending?.conversationId === conv.id && !store[conv.id]) store[conv.id] = {...conv.pending};
    });
    // 兼容旧持久化的全局单槽字段：新版按其声明的所属对话迁移；更老版本没有
    // _pendingConversationId，只能在首次加载时归入当时的活动对话。
    const legacyConversationId = String(agentState._pendingConversationId || agentState.activeConversationId || '').trim();
    const hasLegacyPending = agentState._pendingMessage !== undefined
        || agentState._pendingLlmTaskId !== undefined
        || agentState._pendingUserMsg !== undefined;
    if(legacyConversationId && hasLegacyPending && !store[legacyConversationId]){
        store[legacyConversationId] = {
            conversationId:legacyConversationId,
            _pendingRequestId:String(agentState._pendingRequestId || ''),
            _pendingMessage:agentState._pendingMessage || '',
            _pendingAttachments:Array.isArray(agentState._pendingAttachments) ? agentState._pendingAttachments.slice() : [],
            _pendingUserMsg:agentState._pendingUserMsg || null,
            _pendingLlmTaskId:agentState._pendingLlmTaskId || '',
            _pendingLlmTaskTs:agentState._pendingLlmTaskTs || 0
        };
    }
    return store;
}
function agentGetConversationPending(conversationId=''){
    const cid = String(conversationId || agentState?.activeConversationId || '').trim();
    if(!cid) return null;
    return agentPendingStore()[cid] || null;
}
function agentMirrorLegacyPending(conversationId='', pending=null){
    if(!agentState) return;
    const cid = String(conversationId || '').trim();
    ['_pendingRequestId','_pendingMessage','_pendingAttachments','_pendingUserMsg','_pendingLlmTaskId','_pendingLlmTaskTs','_pendingConversationId']
        .forEach(key => { delete agentState[key]; });
    if(!pending || !cid) return;
    agentState._pendingConversationId = cid;
    agentState._pendingRequestId = String(pending._pendingRequestId || '');
    agentState._pendingMessage = pending._pendingMessage || '';
    agentState._pendingAttachments = Array.isArray(pending._pendingAttachments) ? pending._pendingAttachments.slice() : [];
    agentState._pendingUserMsg = pending._pendingUserMsg || null;
    agentState._pendingLlmTaskId = pending._pendingLlmTaskId || '';
    agentState._pendingLlmTaskTs = pending._pendingLlmTaskTs || 0;
}
function agentSetConversationPending(conversationId='', patch={}, {replace=false, expectedRequestId=''}={}){
    if(!agentState) return null;
    const cid = String(conversationId || agentState.activeConversationId || '').trim();
    if(!cid) return null;
    const store = agentPendingStore();
    const current = store[cid] || null;
    if(expectedRequestId && current?._pendingRequestId && current._pendingRequestId !== expectedRequestId) return null;
    const next = replace ? {...patch} : {...(current || {}), ...patch};
    next.conversationId = cid;
    store[cid] = next;
    const conv = Array.isArray(agentState.conversations) ? agentState.conversations.find(item => item?.id === cid) : null;
    if(conv) conv.pending = {...next};
    if(agentState.activeConversationId === cid) agentMirrorLegacyPending(cid, next);
    return next;
}
function agentClearConversationLlmTask(conversationId='', taskId='', requestId=''){
    const cid = String(conversationId || '').trim();
    const current = agentGetConversationPending(cid);
    if(!current) return false;
    if(taskId && current._pendingLlmTaskId !== taskId) return false;
    if(requestId && current._pendingRequestId && current._pendingRequestId !== requestId) return false;
    const next = {...current};
    delete next._pendingLlmTaskId;
    delete next._pendingLlmTaskTs;
    agentSetConversationPending(cid, next, {replace:true, expectedRequestId:requestId});
    return true;
}
function agentClearConversationPending(conversationId='', {requestId='', taskId=''}={}){
    if(!agentState) return false;
    const cid = String(conversationId || '').trim();
    const store = agentPendingStore();
    const current = store[cid] || null;
    if(!current) return false;
    if(requestId && current._pendingRequestId && current._pendingRequestId !== requestId) return false;
    if(taskId && current._pendingLlmTaskId && current._pendingLlmTaskId !== taskId) return false;
    delete store[cid];
    const conv = Array.isArray(agentState.conversations) ? agentState.conversations.find(item => item?.id === cid) : null;
    if(conv) conv.pending = null;
    if(agentState._pendingConversationId === cid) agentMirrorLegacyPending('', null);
    return true;
}
function agentRevisePlanningStore(){
    if(!agentState) return {};
    if(!agentState._pendingRevisePlanningByConversation || typeof agentState._pendingRevisePlanningByConversation !== 'object' || Array.isArray(agentState._pendingRevisePlanningByConversation)){
        agentState._pendingRevisePlanningByConversation = {};
    }
    const store = agentState._pendingRevisePlanningByConversation;
    const legacy = agentState._pendingRevisePlanning;
    const legacyCid = legacy && typeof legacy === 'object'
        ? String(legacy.conversationId || agentState.activeConversationId || '').trim()
        : '';
    if(legacyCid && !store[legacyCid]) store[legacyCid] = {...legacy};
    return store;
}
function agentGetPendingRevisePlanning(conversationId=''){
    const cid = String(conversationId || agentState?.activeConversationId || '').trim();
    return cid ? (agentRevisePlanningStore()[cid] || null) : null;
}
function agentSetPendingRevisePlanning(conversationId='', value=null){
    if(!agentState) return null;
    const cid = String(conversationId || agentState.activeConversationId || '').trim();
    if(!cid) return null;
    const store = agentRevisePlanningStore();
    if(value) store[cid] = {...value, conversationId:cid};
    else delete store[cid];
    if(agentState.activeConversationId === cid){
        if(value) agentState._pendingRevisePlanning = store[cid];
        else delete agentState._pendingRevisePlanning;
    }
    return store[cid] || null;
}
function agentClearPendingRevisePlanning(conversationId='', expectedMeta=null){
    const cid = String(conversationId || '').trim();
    const current = agentGetPendingRevisePlanning(cid);
    if(!current) return false;
    if(expectedMeta?.gateMsgId && current.gateMsgId !== expectedMeta.gateMsgId) return false;
    agentSetPendingRevisePlanning(cid, null);
    return true;
}
function agentMirrorLegacyRevisePlanning(conversationId=''){
    if(!agentState) return;
    const pending = agentGetPendingRevisePlanning(conversationId);
    if(pending) agentState._pendingRevisePlanning = pending;
    else delete agentState._pendingRevisePlanning;
}
async function agentCreateAndWaitLlmTask(payload, {stream=true, conversationId='', requestId=''}={}){
    const ownerConversationId = String(conversationId || agentState?.activeConversationId || '').trim();
    const ownerRequestId = String(requestId || agentGetConversationPending(ownerConversationId)?._pendingRequestId || uid('llmreq'));
    const url = stream ? '/api/plugins/canvas-agent/llm-tasks?stream=true' : '/api/plugins/canvas-agent/llm-tasks';
    const taskRes = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload || {})
    }).then(async r => {
        if(!r.ok) throw new Error(await responseErrorMessage(r, tr('smart.promptLlmFailed')));
        return r.json();
    });
    const llmTaskId = taskRes.task_id;
    if(!llmTaskId) throw new Error('Failed to create LLM task');
    const ownedPending = agentSetConversationPending(ownerConversationId, {
        _pendingRequestId:ownerRequestId,
        _pendingLlmTaskId:llmTaskId,
        _pendingLlmTaskTs:Date.now()
    }, {expectedRequestId:ownerRequestId});
    // POST 返回前同一对话若已换成更新 request，旧响应不得覆盖新 stream。
    if(stream && ownedPending) startAgentStream(llmTaskId, ownerConversationId);
    saveAgentState();
    try{
        const result = await pollAgentLlmTask(llmTaskId);
        return result;
    } finally {
        if(stream) endAgentStream(llmTaskId, ownerConversationId);
        // await 返回时只能清理由自己 task/request 占有的槽；不能删掉同一时刻 B 对话的新任务。
        agentClearConversationLlmTask(ownerConversationId, llmTaskId, ownerRequestId);
        saveAgentState();
    }
}
function agentNormalizeUnderstandingText(raw=''){
    let t = String(raw || '').trim();
    if(!t) return '';
    // 若模型误返回 JSON，尽量抽出 reply/text 当理解内容
    try{
        const blocks = (typeof extractJsonBlocks === 'function') ? extractJsonBlocks(t) : [];
        for(const b of blocks){
            try{
                const data = JSON.parse(b);
                if(data && typeof data === 'object'){
                    const reply = String(data.reply || data.text || data.understanding || '').trim();
                    if(reply) return reply;
                }
            }catch(_){ }
        }
    }catch(_){ }
    // 去掉 markdown 代码围栏外壳
    if(t.startsWith('```')){
        t = t.replace(/^```[a-zA-Z0-9_-]*\s*/,'').replace(/\s*```$/,'').trim();
    }
    return t;
}


function agentDefaultState(){
    return {skills:[], attachments:[], messages:[], conversations:[], activeConversationId:'', chatProvider:'', chatModel:'', genProvider:'', genModel:'', genRatio:'square', genResolution:'1k', genCount:1, genQuality:'', autoContext:true, inputHeight:0, inputMode:'agent'};
}
function agentCurrentInputMode(){
    return agentState?.inputMode === 'image' ? 'image' : 'agent';
}
function agentSetInputMode(mode, {persist=true}={}){
    if(!agentState) return;
    const next = mode === 'image' ? 'image' : 'agent';
    agentState.inputMode = next;
    const imageMode = next === 'image';
    agentPanel?.classList.toggle('is-image-mode', imageMode);
    agentInputModeSwitch?.querySelectorAll('[data-agent-input-mode]').forEach(btn => {
        const active = btn.dataset.agentInputMode === next;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const chatRow = document.querySelector('[data-agent-chat-model-row]');
    if(chatRow) chatRow.hidden = imageMode;
    if(agentInput){
        agentInput.dataset.placeholder = imageMode
            ? '输入最终生图提示词；可上传参考图，发送后直接生图，不经过 LLM...'
            : '输入需求，/ 调用 Skill；点画布图片可插入图片字符...';
    }
    if(agentAttachBtn) agentAttachBtn.title = imageMode ? '上传参考图' : '添加图片或 Skill';
    if(agentImageInput) agentImageInput.accept = imageMode ? 'image/*' : 'image/*,.md,.markdown,.txt';
    hideAgentSkillSlash();
    if(persist) saveAgentState();
    renderAgentMessages();
    updateAgentPrimaryAction();
}
// 将 prompts 规范化为对象数组（兼容旧格式 string[]）
// 每个 prompt 对象：{prompt, count, use_last_outputs, use_attachments, status}
// status 取值：pending / current / confirmed / skipped / editing
function normalizePrompts(prompts){
    if(!Array.isArray(prompts)) return [];
    return prompts.map(p => {
        if(typeof p === 'string'){
            const t = p.trim();
            return t ? {prompt:t, count:1, use_last_outputs:false, use_attachments:false, status:'pending'} : null;
        }
        if(p && typeof p === 'object' && typeof p.prompt === 'string' && p.prompt.trim()){
            const modeRaw = String(p.dependency_mode || p.dependencyMode || '').trim().toLowerCase();
            const dependsOnPrevious = !!(p.depends_on_previous || p.use_previous_results)
                || modeRaw === 'product_reference' || modeRaw === 'fusion';
            const normalized = {
                id:String(p.id || '').trim(),
                title:String(p.title || p.name || '').trim(),
                type:agentNormalizeTaskType(p.type || p.kind || p.role || 'other'),
                role:String(p.role || '').trim(),
                prompt:p.prompt.trim(),
                count:Math.max(1, Math.min(8, Number(p.count) || 1)),
                ratio:p.ratio || p.aspect_ratio || '',
                resolution:p.resolution || p.size || '',
                use_last_outputs:!!p.use_last_outputs,
                use_attachments:!!p.use_attachments,
                depends_on_previous: dependsOnPrevious,
                dependency_mode: dependsOnPrevious
                    ? agentNormalizeDependencyMode(modeRaw, p.prompt)
                    : 'none',
                status:p.status || 'pending'
            };
            // attachment_indices: 指定该 prompt 只使用哪些附件作为参考图（0-based 索引数组）
            // LLM 可用此字段实现"每条 prompt 只带特定参考图"的精细控制
            if(Array.isArray(p.attachment_indices)){
                normalized.attachment_indices = p.attachment_indices
                    .filter(i => Number.isFinite(Number(i)) && Number(i) >= 0)
                    .map(i => Math.floor(Number(i)));
                if(normalized.attachment_indices.length) normalized.use_attachments = true;
            }
            if(Array.isArray(p.depends_on_steps)) normalized.depends_on_steps = p.depends_on_steps.slice();
            if(Array.isArray(p.input_artifact_ids)) normalized.input_artifact_ids = p.input_artifact_ids.slice();
            if(p.output_artifact_id) normalized.output_artifact_id = String(p.output_artifact_id);
            return normalized;
        }
        return null;
    }).filter(p => p);
}

// 兼容早期规划协议：旧模型有时只返回 prompts，而当前节点执行器只接收
// generations。这个桥只搬运字段，不扩写提示词、不改变步骤顺序或参考图编号。
// 因而全自动可继续执行，半自动仍保留原 prompts 确认卡。
function agentPromptsToGenerations(prompts){
    return normalizePrompts(prompts).map((prompt, index) => {
        const dependsOnPrevious = !!prompt.depends_on_previous
            || String(prompt.dependency_mode || '').toLowerCase() === 'product_reference'
            || String(prompt.dependency_mode || '').toLowerCase() === 'fusion';
        const generation = {
            id: String(prompt.id || '').trim(),
            title: String(prompt.title || prompt.name || '').trim(),
            type: agentNormalizeTaskType(prompt.type || prompt.kind || prompt.role || 'other'),
            role: String(prompt.role || '').trim(),
            prompt: String(prompt.prompt || '').trim(),
            count: Math.max(1, Math.min(8, Number(prompt.count) || 1)),
            ratio: prompt.ratio || prompt.aspect_ratio || '',
            resolution: prompt.resolution || prompt.size || '',
            use_last_outputs: !!prompt.use_last_outputs,
            use_attachments: !!prompt.use_attachments,
            depends_on_previous: dependsOnPrevious,
            dependency_mode: dependsOnPrevious
                ? agentNormalizeDependencyMode(prompt.dependency_mode || prompt.dependencyMode, prompt.prompt)
                : 'none',
            results: [],
            status: 'running',
            _legacy_prompt_bridge: true
        };
        if(Array.isArray(prompt.attachment_indices)) generation.attachment_indices = prompt.attachment_indices.slice();
        if(Array.isArray(prompt.depends_on_steps)) generation.depends_on_steps = prompt.depends_on_steps.slice();
        if(Array.isArray(prompt.input_artifact_ids)) generation.input_artifact_ids = prompt.input_artifact_ids.slice();
        if(prompt.output_artifact_id) generation.output_artifact_id = String(prompt.output_artifact_id);
        if(!generation.id) generation.id = `legacy_prompt_${index + 1}`;
        return generation;
    }).filter(generation => generation.prompt);
}

function agentShouldBridgeLegacyPrompts({thinkingModeOn=false, stage='', runMode='auto', options=[], generations=[], prompts=[]}={}){
    return !thinkingModeOn
        && String(stage || '').toLowerCase() === 'plan'
        && String(runMode || 'auto').toLowerCase() === 'auto'
        && Array.isArray(options) && options.length === 0
        && Array.isArray(generations) && generations.length === 0
        && Array.isArray(prompts) && prompts.length > 0;
}
// 确保消息有 current prompt（如果没有 current/editing，找第一个 pending 标记为 current）
function ensureCurrentPrompt(msg){
    if(!msg || msg.role !== 'assistant' || !Array.isArray(msg.prompts) || msg.prompts.length === 0) return;
    if(!msg.prompts.some(p => p.status === 'current' || p.status === 'editing')){
        const firstPending = msg.prompts.findIndex(p => !p.status || p.status === 'pending');
        if(firstPending >= 0){
            msg.prompts[firstPending].status = 'current';
            msg.promptIdx = firstPending;
        }
    }
}
function agentResolveCanvasId(){
    // 智能画布有全局 canvasId；普通画布没有，必须从 URL 取，避免 ReferenceError 导致保存全失败
    try{
        if(typeof canvasId !== 'undefined' && canvasId) return String(canvasId);
    }catch(_){}
    try{
        const id = new URLSearchParams(location.search || '').get('id');
        if(id) return String(id);
    }catch(_){}
    try{
        if(window.CanvasAgentHost && typeof window.CanvasAgentHost.getCanvasId === 'function'){
            const id = window.CanvasAgentHost.getCanvasId();
            if(id) return String(id);
        }
    }catch(_){}
    return 'default';
}
function agentStorageKey(){ return AGENT_STORAGE_PREFIX + agentResolveCanvasId(); }
function agentStateApiUrl(canvasId=agentResolveCanvasId()){
    return `${AGENT_STATE_API}/${encodeURIComponent(String(canvasId || 'default'))}`;
}
function agentCloneForPersistence(value){
    try{ return JSON.parse(JSON.stringify(value)); }catch(_){ return null; }
}
function agentBuildPersistedState(){
    try{ agentEnsureActiveConversation(); }catch(_){ }
    try{ agentCaptureActiveConversation(); }catch(_){ }
    const data = {
        ...agentState,
        // 标记这是后端完整快照，不能沿用 localStorage 离线摘要的 cache 标记。
        _storageMode:'full',
        messages: (agentState.messages || []).slice(-AGENT_MSG_MAX),
        // skills 仅作当前活动对话镜像；真正隔离数据在 conversations[].skills
        skills: Array.isArray(agentState.skills) ? agentState.skills : [],
        conversations: Array.isArray(agentState.conversations)
            ? agentState.conversations.map(c => agentNormalizeConversation({...c, messages:(c.messages||[]).slice(-AGENT_MSG_MAX)}))
            : [],
        _storageCanvasId: agentResolveCanvasId(),
        _savedAt: Date.now()
    };
    return agentCloneForPersistence(data);
}
function agentBuildLocalStateCache(data){
    if(!data || typeof data !== 'object') return null;
    // localStorage 只作离线/旧版回退，绝不再复制完整 Skill 原文、长策划和全部
    // 多轮输出；完整且可恢复的状态由插件后端按画布保存。
    const compactMessage = msg => {
        if(!msg || typeof msg !== 'object') return msg;
        const next = {...msg};
        if(typeof next.text === 'string') next.text = next.text.slice(0, 1800);
        if(typeof next.understanding === 'string') next.understanding = next.understanding.slice(0, 2400);
        if(Array.isArray(next.skills)) next.skills = next.skills.map(skill => ({
            id:skill?.id || '', presetId:skill?.presetId || '', name:String(skill?.name || '').slice(0, 120)
        }));
        if(Array.isArray(next.generations)) next.generations = next.generations.slice(-8).map(gen => ({
            ...gen,
            prompt:String(gen?.prompt || '').slice(0, 1600),
            results:Array.isArray(gen?.results) ? gen.results.slice(-8) : []
        }));
        return next;
    };
    const compactSkill = skill => ({
        id:skill?.id || '', presetId:skill?.presetId || '', name:String(skill?.name || '').slice(0, 120),
        description:String(skill?.description || '').slice(0, 300)
    });
    const compactAttachment = item => ({
        url:String(item?.url || ''), name:String(item?.name || '').slice(0, 160), kind:item?.kind || 'image',
        nodeId:item?.nodeId || '', imageIndex:Number(item?.imageIndex || 0)
    });
    const compactWorkflow = workflow => workflow ? {
        id:workflow.id || '', conversationId:workflow.conversationId || '', messageId:workflow.messageId || '',
        status:workflow.status || 'completed', error:String(workflow.error || '').slice(0, 600),
        canvasKind:workflow.canvasKind || '', nodeIds:Array.isArray(workflow.nodeIds) ? workflow.nodeIds.slice(-40) : [],
        createdAt:workflow.createdAt || 0, updatedAt:workflow.updatedAt || 0
    } : null;
    const compactConversation = conv => ({
        id:conv?.id || '', title:String(conv?.title || '对话').slice(0, 120), ts:conv?.ts || 0, updatedAt:conv?.updatedAt || 0,
        draft:String(conv?.draft || '').slice(0, 1800), messages:(conv?.messages || []).slice(-6).map(compactMessage),
        attachments:(conv?.attachments || []).map(compactAttachment), skills:(conv?.skills || []).map(compactSkill),
        workflow:compactWorkflow(conv?.workflow), memory:conv?.memory || null, pending:null
    });
    return {
        _storageMode:'cache', _storageCanvasId:data._storageCanvasId || agentResolveCanvasId(), _savedAt:data._savedAt || Date.now(),
        activeConversationId:data.activeConversationId || '', chatProvider:data.chatProvider || '', chatModel:data.chatModel || '',
        genProvider:data.genProvider || '', genModel:data.genModel || '', genRatio:data.genRatio || 'square',
        genResolution:data.genResolution || '1k', genCount:1, genQuality:data.genQuality || '', autoContext:data.autoContext !== false,
        inputHeight:data.inputHeight || 0, inputMode:data.inputMode || 'agent', runMode:data.runMode || 'auto',
        messages:(data.messages || []).slice(-6).map(compactMessage), skills:(data.skills || []).map(compactSkill),
        conversations:(data.conversations || []).slice(0, AGENT_HISTORY_MAX).map(compactConversation)
    };
}
function agentPersistStateToBackend(data){
    if(!data || typeof data !== 'object' || !window.fetch) return;
    agentStateBackendQueued = data;
    // 首屏先读取完整后端快照。此时不能把 localStorage 摘要或初始化状态
    // 抢先 PUT 回去，否则会覆盖此前已经完成的策划、规划和执行记录。
    if(!agentStateBackendHydrated || agentStateBackendHydrating) return;
    if(agentStateBackendSyncing) return;
    agentStateBackendSyncing = true;
    const flush = async () => {
        while(agentStateBackendQueued){
            const next = agentStateBackendQueued;
            agentStateBackendQueued = null;
            try{
                const response = await fetch(agentStateApiUrl(next._storageCanvasId), {
                    method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({state:next})
                });
                if(!response.ok) throw new Error(`HTTP ${response.status}`);
            }catch(error){
                // 浏览器离线时本地轻量缓存仍可恢复最近记录；下一次保存会自动重试。
                try{ console.warn('[canvas-agent] backend state save failed', error); }catch(_){ }
            }
        }
        agentStateBackendSyncing = false;
    };
    flush();
}
function agentApplyPersistedState(data){
    if(!data || typeof data !== 'object') return false;
    const incoming = agentCloneForPersistence(data);
    if(!incoming) return false;
    agentState = {...agentDefaultState(), ...incoming, messages:Array.isArray(incoming.messages) ? incoming.messages : []};
    if(!Array.isArray(agentState.skills)) agentState.skills = [];
    agentState.skills = agentNormalizeSkillList(agentState.skills);
    if(!Array.isArray(agentState.conversations)) agentState.conversations = [];
    if(agentState.messages.length && !agentState.conversations.length){
        const first = agentState.messages[0];
        agentState.conversations = [{id:uid('ac'), title:String(first?.text || '对话').slice(0, 30), messages:agentState.messages, ts:Date.now()}];
    }
    agentState.conversations = agentState.conversations.map(c => agentNormalizeConversation(c)).filter(Boolean);
    if(!agentState.activeConversationId && agentState.conversations.length) agentState.activeConversationId = agentState.conversations[0].id;
    const active = agentState.conversations.find(c => c.id === agentState.activeConversationId);
    if(active) agentApplyConversation(active);
    else { try{ agentEnsureActiveConversation(); }catch(_){ } }
    return true;
}
async function agentHydrateStateFromBackend(){
    if(agentStateBackendHydrated || agentStateBackendHydrating || !window.fetch) return;
    agentStateBackendHydrating = true;
    let appliedRemote = false;
    try{
        const response = await fetch(agentStateApiUrl(), {cache:'no-store'});
        if(!response.ok) return;
        const payload = await response.json();
        const remote = payload?.state;
        if(!remote || typeof remote !== 'object') return;
        const localTs = Number(agentState?._savedAt || 0);
        const remoteTs = Number(remote._savedAt || 0);
        // localStorage 现在只是离线摘要，不能用它的保存时间阻止后端完整
        // 快照回填；否则摘要恰好较新时会把策划/规划/执行结果伪装成“已恢复”。
        // 仅在本地本身也是完整状态（旧兼容路径）时才保留时间戳防倒灌。
        const localIsFallbackCache = agentState?._storageMode === 'cache';
        if(!localIsFallbackCache && remoteTs < localTs) return;
        if(!agentApplyPersistedState(remote)) return;
        appliedRemote = true;
        // 远端画布状态会在首屏模型默认值已经套用后异步回填。若不再次
        // 套用用户明确“设为默认”的平台+模型，新画布的空状态会把它回退
        // 为提供商列表中的第一个同名模型（例如默认通道而非特价通道）。
        // 默认模型的语义就是“下次打开生效”，因此回填后必须以它为准。
        try{ agentApplyModelDefaults(true); }catch(_){ }
        try{ agentResetPersistedRuntimeOnStartup(); }catch(_){ }
        try{ renderAgentModelSelectors(true); }catch(_){ }
        try{ renderAgentAttachments(); renderAgentMessages(); updateAgentPrimaryAction(); }catch(_){ }
    }catch(error){
        try{ console.warn('[canvas-agent] backend state load failed', error); }catch(_){ }
    }finally{
        agentStateBackendHydrating = false;
        agentStateBackendHydrated = true;
        // 已有完整远端状态时，丢弃 hydration 之前积压的本地摘要，随后把
        // 远端状态（若清理了瞬时运行态则含清理结果）作为新的权威快照保存。
        if(appliedRemote){
            agentStateBackendQueued = null;
            try{ saveAgentState(true); }catch(_){ }
        }else if(agentStateBackendQueued){
            agentPersistStateToBackend(agentStateBackendQueued);
        }
    }
}
function agentStorageKeyCandidates(){
    const keys = [];
    const primary = agentStorageKey();
    keys.push(primary);
    // 兼容历史：普通画布曾因 canvasId 未定义写不进去；也可能误写到 default
    const fallbacks = ['default'];
    try{
        const urlId = new URLSearchParams(location.search || '').get('id');
        if(urlId) fallbacks.unshift(String(urlId));
    }catch(_){}
    for(const fb of fallbacks){
        const k = AGENT_STORAGE_PREFIX + fb;
        if(!keys.includes(k)) keys.push(k);
    }
    return keys;
}
// 生图 provider 列表：与主画布的 imageProviders() 不同，这里不排除 modelscope/volcengine，
// 因为后端 /api/canvas-image-tasks 统一支持它们（主画布排除它们仅因专用引擎 UI）。

function agentLoadModelDefaults(){
    try{
        const raw = localStorage.getItem(AGENT_MODEL_DEFAULTS_KEY);
        if(!raw) return null;
        const data = JSON.parse(raw);
        return (data && typeof data === 'object') ? data : null;
    }catch(_){
        return null;
    }
}
function agentSaveModelDefaults(partial={}){
    try{
        const next = {
            chatProvider: String(partial.chatProvider ?? ''),
            chatModel: String(partial.chatModel ?? ''),
            genProvider: String(partial.genProvider ?? ''),
            genModel: String(partial.genModel ?? ''),
            genRatio: String(partial.genRatio ?? ''),
            genResolution: String(partial.genResolution ?? ''),
            updatedAt: Date.now()
        };
        // 允许清空某一项：传入 partial 时以 partial 为准，不再和旧默认混成“改了界面却存不上”
        localStorage.setItem(AGENT_MODEL_DEFAULTS_KEY, JSON.stringify(next));
        return next;
    }catch(e){
        try{ console.warn('[canvas-agent] save model defaults failed', e); }catch(_){ }
        return null;
    }
}
function agentFindChatProviderForModel(model=''){
    const want = String(model || '').trim();
    if(!want) return '';
    try{
        const providers = (typeof chatApiProviders === 'function') ? chatApiProviders() : [];
        const hit = providers.find(p => Array.isArray(p?.chat_models) && p.chat_models.includes(want));
        return hit?.id || '';
    }catch(_){ return ''; }
}
function agentFindGenProviderForModel(model=''){
    const want = String(model || '').trim();
    if(!want) return '';
    try{
        const providers = agentGenProviders();
        for(const p of providers){
            const models = (typeof providerImageModels === 'function') ? providerImageModels(p.id) : (p.image_models || []);
            if(Array.isArray(models) && models.includes(want)) return p.id;
        }
    }catch(_){ }
    return '';
}
function agentSyncModelsFromSelectors(){
    if(!agentState) return;
    if(agentChatProvider) agentState.chatProvider = agentChatProvider.value || agentState.chatProvider || '';
    if(agentChatModel) agentState.chatModel = agentChatModel.value || agentState.chatModel || '';
    if(agentGenProvider) agentState.genProvider = agentGenProvider.value || agentState.genProvider || '';
    if(agentGenModel) agentState.genModel = agentGenModel.value || agentState.genModel || '';
}
function agentRememberCurrentModelsAsDefaults(){
    if(!agentState) return null;
    // 以界面当前选择为准：平台 + 模型都按用户当下选项原样保存
    try{ agentSyncModelsFromSelectors(); }catch(_){ }
    const chatModel = String(agentState.chatModel || '').trim();
    const genModel = String(agentState.genModel || '').trim();
    let chatProvider = String(agentState.chatProvider || agentChatProvider?.value || '').trim();
    let genProvider = String(agentState.genProvider || agentGenProvider?.value || '').trim();
    // 只有平台空了才用模型补平台；绝不能用“模型反查”覆盖用户已选平台
    if(!chatProvider && chatModel){
        chatProvider = agentFindChatProviderForModel(chatModel) || '';
    }
    if(!genProvider && genModel){
        genProvider = agentFindGenProviderForModel(genModel) || '';
    }
    agentState.chatProvider = chatProvider;
    agentState.genProvider = genProvider;
    agentState.chatModel = chatModel;
    agentState.genModel = genModel;
    return agentSaveModelDefaults({
        chatProvider,
        chatModel,
        genProvider,
        genModel,
        genRatio: agentState.genRatio || '',
        genResolution: agentState.genResolution || ''
    });
}
function agentApplyModelDefaults(force=true){
    if(!agentState) return false;
    const defaults = agentLoadModelDefaults();
    if(!defaults) return false;
    let changed = false;
    const assign = (key, val) => {
        const next = String(val || '').trim();
        if(!next) return false;
        if(String(agentState[key] || '') !== next){
            agentState[key] = next;
            changed = true;
            return true;
        }
        return false;
    };

    let chatModel = String(defaults.chatModel || '').trim();
    let chatProvider = String(defaults.chatProvider || '').trim();
    let genModel = String(defaults.genModel || '').trim();
    let genProvider = String(defaults.genProvider || '').trim();

    // 1) 平台优先：先用保存的平台；只有平台失效/为空时，才按模型反查
    try{
        const chatProviders = (typeof chatApiProviders === 'function') ? chatApiProviders() : [];
        const chatProviderOk = !!(chatProvider && chatProviders.some(p => p.id === chatProvider));
        // 提供商列表尚未异步加载时，不能把用户保存的平台清成空，
        // 否则稍后只能退回列表第一个同名模型。
        if(chatProviders.length && !chatProviderOk){
            chatProvider = agentFindChatProviderForModel(chatModel) || '';
        }
        // 平台有效时，即使模型暂不在列表也保留平台+模型（避免同名模型跳到别的平台）
    }catch(_){ }

    try{
        const genProviders = agentGenProviders();
        const genProviderOk = !!(genProvider && genProviders.some(p => p.id === genProvider));
        // 生图提供商通常比理解模型晚到；保留已保存的特价/指定通道，
        // 待列表就绪后再校验，而非过早回退到默认通道。
        if(genProviders.length && !genProviderOk){
            genProvider = agentFindGenProviderForModel(genModel) || '';
        }
    }catch(_){ }

    // 3) 仅在 force，或当前值为空时写入；且只写校验通过的值
    const canWrite = (key) => force || !String(agentState[key] || '').trim();
    if(canWrite('chatProvider') && chatProvider) assign('chatProvider', chatProvider);
    if(canWrite('chatModel') && chatModel) assign('chatModel', chatModel);
    if(canWrite('genProvider') && genProvider) assign('genProvider', genProvider);
    if(canWrite('genModel') && genModel) assign('genModel', genModel);
    if(canWrite('genRatio') && defaults.genRatio) assign('genRatio', defaults.genRatio);
    if(canWrite('genResolution') && defaults.genResolution) assign('genResolution', defaults.genResolution);
    return changed;
}
function agentFormatDefaultPair(provider='', model=''){
    const p = String(provider || '').trim();
    const m = String(model || '').trim();
    if(p && m) return `${p} / ${m}`;
    return m || p || '未设';
}
function agentUpdateModelDefaultHint(){
    const hint = document.getElementById('agentModelDefaultHint');
    if(!hint) return;
    const defaults = agentLoadModelDefaults() || {};
    const has = !!(defaults.chatModel || defaults.genModel || defaults.chatProvider || defaults.genProvider);
    if(!has){
        hint.textContent = '把当前“平台 + 模型”设为下次打开默认';
        return;
    }
    const chat = agentFormatDefaultPair(defaults.chatProvider, defaults.chatModel);
    const gen = agentFormatDefaultPair(defaults.genProvider, defaults.genModel);
    const curChatProvider = String(agentState?.chatProvider || agentChatProvider?.value || '').trim();
    const curGenProvider = String(agentState?.genProvider || agentGenProvider?.value || '').trim();
    const curChat = String(agentState?.chatModel || agentChatModel?.value || '').trim();
    const curGen = String(agentState?.genModel || agentGenModel?.value || '').trim();
    // 平台和模型都要一致，才算“当前就是默认”
    const sameAsCurrent = (!defaults.chatProvider || defaults.chatProvider === curChatProvider)
        && (!defaults.chatModel || defaults.chatModel === curChat)
        && (!defaults.genProvider || defaults.genProvider === curGenProvider)
        && (!defaults.genModel || defaults.genModel === curGen);
    hint.textContent = sameAsCurrent
        ? `下次默认：理解 ${chat} · 生图 ${gen}`
        : `下次默认：理解 ${chat} · 生图 ${gen}（当前已手动更换）`;
    hint.title = '“设为默认”会同时记住平台和模型，只影响下次打开';
}
function agentGenProviders(){
    return (apiProviders || []).filter(p => p.enabled !== false && (p.image_models || []).length);
}
function loadAgentState(){
    agentState = agentDefaultState();
    try {
        let loaded = null;
        const primaryKey = agentStorageKey();
        const currentCanvasId = agentResolveCanvasId();
        // 严格优先当前画布自己的存储。旧版“挑消息最多的 key”会把 default
        // 或其他画布的旧对话带进来，造成打开后突然出现前面对话内容。
        for(const key of agentStorageKeyCandidates()){
            const raw = localStorage.getItem(key);
            if(!raw) continue;
            try{
                const data = JSON.parse(raw);
                if(data && typeof data === 'object'){
                    const isPrimary = key === primaryKey;
                    const savedCanvasId = String(data._storageCanvasId || '');
                    // 兼容 key 只有明确声明属于当前画布才允许迁移；无归属的 default 不再兜底。
                    if(!isPrimary && (!savedCanvasId || savedCanvasId !== currentCanvasId)) continue;
                    loaded = {data, key};
                    break;
                }
            }catch(_){}
        }
        if(loaded?.data){
            const data = loaded.data;
            agentState = {...agentState, ...data, messages:Array.isArray(data.messages) ? data.messages : []};
            // 若从兼容 key 读到数据，立刻回写到当前正确 key
            try{ if(loaded.key !== agentStorageKey()) localStorage.setItem(agentStorageKey(), JSON.stringify(data)); }catch(_){}
        }
    } catch(e) { agentState = agentDefaultState(); }
    // 旧数据迁移：单个 skill 对象 → skills 数组
    if(agentState.skill && !Array.isArray(agentState.skills)){
        agentState.skills = [agentState.skill];
    } else if(agentState.skill && Array.isArray(agentState.skills) && !agentState.skills.length){
        agentState.skills = [agentState.skill];
    }
    delete agentState.skill;
    if(!Array.isArray(agentState.skills)) agentState.skills = [];
    agentState.skills = agentNormalizeSkillList(agentState.skills);
    if(Array.isArray(agentState.conversations)){
        agentState.conversations = agentState.conversations.map(c => agentNormalizeConversation({...c}) || c);
    }
    if(Array.isArray(agentState.messages)){
        agentState.messages = agentState.messages.map(msg => {
            if(!msg || typeof msg !== 'object') return msg;
            if(Array.isArray(msg.skills)) msg.skills = agentNormalizeSkillList(msg.skills);
            return msg;
        });
    }
    // params UI removed: always default genCount=1
    agentState.genCount = 1;
    // 仅在加载状态时套用“设为默认”的模型（下次打开生效），会话中手动改模型不会被回退
    try{ agentApplyModelDefaults(true); }catch(_){ }
    // 每次重新加载状态后，允许在供应商就绪时再套用一次默认模型
    _agentModelProvidersReadyApplied = false;
    _agentModelSelectorSig = '';
    try{ agentWatchProvidersForModelRestore(); }catch(_){ }

    // 若还没有全局默认，用当前画布模型初始化一份，方便后续“设为默认”
    try{
        if(!agentLoadModelDefaults() && (agentState.chatModel || agentState.genModel || agentState.chatProvider || agentState.genProvider)){
            agentRememberCurrentModelsAsDefaults();
        }
    }catch(_){ }
    if(!Array.isArray(agentState.attachments)) agentState.attachments = [];
    // 旧数据迁移：messages → conversations
    if(!Array.isArray(agentState.conversations)) agentState.conversations = [];
    if(agentState.messages && agentState.messages.length && !agentState.conversations.length){
        const firstMsg = agentState.messages[0];
        const title = firstMsg?.text ? String(firstMsg.text).slice(0, 30) : '对话';
        agentState.conversations = [{id:uid('ac'), title, messages:agentState.messages, ts:Date.now()}];
        agentState.activeConversationId = agentState.conversations[0].id;
    }
    if(!agentState.activeConversationId && agentState.conversations.length){
        agentState.activeConversationId = agentState.conversations[0].id;
    }
    // 加载当前对话的 messages
    // 规范化所有对话，保证结构完整（记忆/Skill/附件隔离字段）
    agentState.conversations = (agentState.conversations || []).map(c => agentNormalizeConversation(c));
    // 运行态只在当前页面内有效；重启后不可把旧任务恢复成“正在执行”。
    // 对话正文、策划、结果和失败信息仍完整保留，用户可从节点或失败项手动重试。
    const startupRuntimeReset = agentResetPersistedRuntimeOnStartup();
    const activeConv = agentState.conversations.find(c => c.id === agentState.activeConversationId);
    if(activeConv){
        // 旧数据：若对话尚无 skills 字段，把全局 skills 迁移进当前活动对话一次
        if(!Array.isArray(activeConv.skills) || !activeConv.skills.length){
            if(Array.isArray(agentState.skills) && agentState.skills.length){
                activeConv.skills = agentState.skills.map(s => ({...s}));
            }
        }
        agentApplyConversation(activeConv);
        queueMicrotask(() => {
            const queued=!agentSending&&Array.isArray(agentActiveWorkflow?.steerQueue)?agentActiveWorkflow.steerQueue.shift():null;
            if(queued){
                if(agentInput) agentSetInputValue(String(queued?.text || activeConv.draft || ''));
                if(queued?.attachments?.length) agentState.attachments=queued.attachments.slice();
                renderAgentAttachments();
            }
            updateAgentPrimaryAction();
        });
    } else {
        agentState.messages = Array.isArray(agentState.messages) ? agentState.messages : [];
        agentState.attachments = [];
        agentState.skills = Array.isArray(agentState.skills) ? agentState.skills : [];
        agentActiveWorkflow = null;
        // 确保至少有一个可持久化的对话容器
        try{ agentEnsureActiveConversation(); }catch(_){}
    }
    try{ agentEnsureActiveConversation(); }catch(_){}
    // 旧数据迁移：prompts string[] → object[]
    (agentState.messages || []).forEach(m => {
        if(m.role === 'assistant' && Array.isArray(m.prompts) && m.prompts.length > 0){
            const hasObjectPrompts = m.prompts.some(p => typeof p === 'object');
            if(!hasObjectPrompts){
                // 旧格式 string[]
                if(m.generations && m.generations.length > 0){
                    // 已经生成过了，标记为已确认
                    m.prompts = m.prompts.map(p => ({prompt:String(p).trim(), count:1, use_last_outputs:false, use_attachments:false, status:'confirmed'}));
                } else {
                    // 还在确认阶段
                    m.prompts = normalizePrompts(m.prompts);
                    ensureCurrentPrompt(m);
                }
            } else {
                // 新格式但可能缺少 current 指针
                ensureCurrentPrompt(m);
            }
        }
    });
    // 恢复中断的操作
    // 旧版会在这里自动恢复持久化 taskId，导致重启后面板初始处于停止态。
    // 本版本启动时已清理瞬时运行态，因此不再自动触发恢复。
    if(startupRuntimeReset) saveAgentState(true);
}
// 恢复中断的 Agent 操作（页面刷新后调用）
let _agentRecoveryInProgress = false;
function _setupAgentRecovery(){
    if(!agentState) return;
    const recCid = String(agentState.activeConversationId || agentState._pendingConversationId || '').trim();
    let ownedPending = agentGetConversationPending(recCid);
    const recoveryRequestId = String(ownedPending?._pendingRequestId || '');
    // 超时保护：如果 pending 任务超过 5 分钟，直接清除，不恢复
    const pendingTs = ownedPending?._pendingLlmTaskTs || 0;
    if(pendingTs && (Date.now() - pendingTs > 5 * 60 * 1000)){
        agentClearConversationPending(recCid, {requestId:recoveryRequestId});
        saveAgentState();
        ownedPending = null;
    }
    // 对话隔离：恢复数据已在加载时从旧全局字段迁移到当前 conversation 槽。
    const pendingLlmTaskId = ownedPending?._pendingLlmTaskId || '';
    const pendingText = String(ownedPending?._pendingMessage || '');
    const pendingAttachments = Array.isArray(ownedPending?._pendingAttachments) ? ownedPending._pendingAttachments.slice() : [];
    const pendingUserMsg = ownedPending?._pendingUserMsg || null;
    // 情况1：LLM task 还在后端跑 → 恢复等待
    if(pendingLlmTaskId && pendingText && pendingUserMsg){
        const recMsgs = agentEnsureConversationMessages(recCid) || agentState.messages || [];
        const lastMsg = recMsgs[recMsgs.length - 1];
        if(lastMsg && lastMsg.role === 'user' && lastMsg.text === pendingText){
            // 在所属对话插入"恢复中"占位，不污染其他对话
            agentPushMessageToConversation(recCid, {
                id: uid('am'),
                role: 'assistant',
                text: '⏳ ' + (tr('smart.agentRecovering') || '正在恢复上次操作...'),
                generations: [],
                ts: Date.now(),
                conversationId: recCid
            });
            agentThinking = true;
            agentThinkingConversationId = recCid;
            agentSending = true;
            agentRenderConversation(recCid, {save:false});
            _agentRecoveryInProgress = true;
            // 异步恢复 LLM task
            (async () => {
                try {
                    const result = await pollAgentLlmTask(pendingLlmTaskId);
                    // 移除占位的"恢复中"消息
                    const currentMessages = agentEnsureConversationMessages(recCid) || [];
                    const filtered = currentMessages.filter(m => m.text !== '⏳ ' + (tr('smart.agentRecovering') || '正在恢复上次操作...'));
                    const recConv = agentGetConversationById(recCid);
                    if(recConv) recConv.messages = filtered;
                    if(agentState.activeConversationId === recCid) agentState.messages = filtered;
                    await processAgentLlmResult(result, pendingText, pendingAttachments, pendingUserMsg, {conversationId:recCid});
                } catch(e) {
                    {
                        const cid = recCid;
                        const msgs = agentEnsureConversationMessages(cid) || agentState.messages || [];
                        const filtered = msgs.filter(m => !m.text?.startsWith('⏳'));
                        if(cid === agentState.activeConversationId) agentState.messages = filtered;
                        else {
                            const conv = agentGetConversationById(cid);
                            if(conv) conv.messages = filtered;
                        }
                        agentPushMessageToConversation(cid, {id:uid('am'), role:'assistant', text:`⚠️ ${String(e.message || e).slice(0, 300)}`, generations:[], ts:Date.now(), conversationId:cid});
                        agentRenderConversation(cid);
                    }
                } finally {
                    if(agentThinkingConversationId === recCid){
                        agentThinking = false;
                        agentSending = false;
                        agentThinkingConversationId = '';
                    }
                    _agentRecoveryInProgress = false;
                    agentClearConversationPending(recCid, {requestId:recoveryRequestId, taskId:pendingLlmTaskId});
                    if(agentState.activeConversationId === recCid) renderAgentMessages();
                    saveAgentState();
                }
            })();
            return;
        }
    }
    // 情况2：生图 task 还在后端跑（LLM 已完成但生图未完成）
    const msgs = agentState.messages || [];
    let hasRunningGen = false;
    for(let i = msgs.length - 1; i >= 0; i--){
        if(msgs[i].role !== 'assistant') continue;
        const gens = msgs[i].generations || [];
        for(const gen of gens){
            if(gen.status === 'running' && gen.taskIds && gen.taskIds.length){
                hasRunningGen = true;
                break;
            }
        }
        break;
    }
    if(hasRunningGen){
        renderAgentMessages();
        _agentRecoveryInProgress = true;
        (async () => {
            try {
                await recoverAgentGenerations();
            } finally {
                _agentRecoveryInProgress = false;
            }
        })();
        return;
    }
    // P1-10: 情况2.5 —— 有未完成的 prompts（确认阶段中断）→ 只恢复确认卡片，不触发生图
    {
        let hasPendingPrompts = false;
        for(let i = msgs.length - 1; i >= 0; i--){
            if(msgs[i].role !== 'assistant') continue;
            const ps = msgs[i].prompts;
            if(Array.isArray(ps) && ps.length > 0 && ps.some(p => p.status === 'pending' || p.status === 'current' || p.status === 'editing')){
                hasPendingPrompts = true;
            }
            break;
        }
        if(hasPendingPrompts){
            // 确保当前消息有 current 指针（loadAgentState 已做，这里兜底）
            ensureCurrentPrompt(msgs[msgs.length - 1]);
            renderAgentMessages();
            return;
        }
    }
    // 情况3：只有 pendingMessage 但没有 LLM task（LLM 还没创建就断了）→ 提示重新发送
    if(pendingText && msgs.length){
        const lastMsg = msgs[msgs.length - 1];
        if(lastMsg && lastMsg.role === 'user'){
            agentPushMessageToConversation(recCid, {
                id: uid('am'),
                role: 'assistant',
                text: '⚠️ ' + (tr('smart.agentInterrupted') || '上次操作被中断，请重新发送'),
                options: [{label: tr('smart.agentRetry') || '重新发送', value: pendingText}],
                generations: [],
                ts: Date.now(),
                conversationId: recCid
            });
        }
    }
    agentClearConversationPending(recCid, {requestId:recoveryRequestId});
}
function agentNormalizeRunModeState(){
    if(!agentState) return;
    agentState.runMode = (String(agentState.runMode || 'auto').toLowerCase() === 'semi') ? 'semi' : 'auto';
}
function saveAgentState(immediate=false){
    try{ agentNormalizeRunModeState(); }catch(_){}

    clearTimeout(agentSaveTimer);
    const flush = () => {
        try {
            const data = agentBuildPersistedState();
            if(!data) return;
            agentPersistStateToBackend(data);
            // localStorage 只保留离线回退摘要；完整对话写入插件后端，避免容量溢出。
            if(!agentLocalStateCacheDisabled) try{
                const cache = agentBuildLocalStateCache(data);
                if(cache) localStorage.setItem(agentStorageKey(), JSON.stringify(cache));
            }catch(cacheError){
                // 完整历史由后端快照保存。旧版本遗留在同一 key 的完整状态可能
                // 已经占满配额；仅移除本插件当前画布的离线回退缓存，再写入裁剪
                // 后的摘要，不触碰画布、节点、图片或其他插件的数据。
                try{
                    const key = agentStorageKey();
                    localStorage.removeItem(key);
                    const cache = agentBuildLocalStateCache(data);
                    if(cache) localStorage.setItem(key, JSON.stringify(cache));
                }catch(retryError){
                    // localStorage 可能已被宿主或其他旧缓存占满。完整状态已在本插件
                    // 后端落盘，因此本页静默禁用离线摘要，避免每次阶段更新都刷警告。
                    agentLocalStateCacheDisabled = true;
                }
            }
        } catch(e) {
            try{ console.warn('[canvas-agent] saveAgentState failed', e); }catch(_){}
        }
    };
    // 立即保存：发送消息/刷新前，避免 200ms 防抖被 F5 打断导致普通画布丢记录
    if(immediate){ flush(); return; }
    agentSaveTimer = setTimeout(flush, 200);
}
function agentFlushStateForUnload(){
    try{ saveAgentState(true); }catch(_){}
}

function agentDockWidthStorageKey(){
    return 'smart_agent_v1:__dock_width__';
}
function agentClampDockWidth(px){
    const minW = 300;
    const maxW = Math.max(minW, Math.min(720, Math.floor((window.innerWidth || 1200) * 0.55)));
    const n = Math.round(Number(px) || 0);
    if(!n) return 380;
    return Math.max(minW, Math.min(maxW, n));
}
function agentLoadDockWidth(){
    try{
        const raw = localStorage.getItem(agentDockWidthStorageKey());
        if(raw) return agentClampDockWidth(raw);
    }catch(_){ }
    return 380;
}
function agentSaveDockWidth(px){
    const w = agentClampDockWidth(px);
    try{ localStorage.setItem(agentDockWidthStorageKey(), String(w)); }catch(_){ }
    return w;
}
function agentDockWidthPx(){
    try{
        if(window.__canvasAgentDockWidthPref) return agentClampDockWidth(window.__canvasAgentDockWidthPref);
    }catch(_){ }
    return agentLoadDockWidth();
}
function agentSetDockWidth(px, {persist=true}={}){
    const w = agentClampDockWidth(px);
    try{ window.__canvasAgentDockWidthPref = w; }catch(_){ }
    if(persist) agentSaveDockWidth(w);
    try{
        document.documentElement.style.setProperty('--canvas-agent-dock-width', w + 'px');
        if(agentPanel){
            agentPanel.style.width = w + 'px';
            agentPanel.style.maxWidth = w + 'px';
        }
    }catch(_){ }
    return w;
}
function agentSyncDockLayout(){
    const open = !!agentOpen;
    const width = agentSetDockWidth(agentDockWidthPx(), {persist:false});
    const compactOverlay = !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches);
    try{
        document.body.classList.toggle('canvas-agent-dock-open', open);
        document.documentElement.classList.toggle('canvas-agent-dock-open', open);
    }catch(_){ }
    // 打开时隐藏顶栏 AI Agent 开关，避免和「工作流/日志」重叠；关闭用面板 X
    try{
        if(agentToggle && !agentToggle.classList.contains('canvas-agent-classic-toggle')){
            agentToggle.classList.toggle('is-dock-hidden', open);
            agentToggle.setAttribute('aria-hidden', open ? 'true' : 'false');
        }
    }catch(_){ }
    // 面板挂到 body + fixed 贴右，不参与 shell 布局，避免再被挤到左上角
    try{
        if(agentPanel && agentPanel.parentElement !== document.body){
            document.body.appendChild(agentPanel);
        }
        if(agentPanel){
            agentPanel.style.position = 'fixed';
            agentPanel.style.top = '0';
            agentPanel.style.right = '0';
            agentPanel.style.bottom = '0';
            agentPanel.style.left = 'auto';
            agentPanel.style.zIndex = '68';
        }
    }catch(_){ }
    // 关键：绝对定位顶栏按钮的 right 是相对 shell 右边缘。
    // padding-right 不会让它们左移，必须收缩 shell 实际宽度，画布与顶栏才会整体让开侧栏。
    try{
        const shellEl = document.getElementById('shell');
        if(shellEl){
            shellEl.classList.toggle('canvas-agent-dock-open', open);
            shellEl.style.removeProperty('padding-right');
            shellEl.style.setProperty('box-sizing', 'border-box', 'important');
            shellEl.style.setProperty('margin-left', '0', 'important');
            shellEl.style.setProperty('margin-right', '0', 'important');
            shellEl.style.setProperty('left', '0', 'important');
            if(open){
                const shellWidth = compactOverlay ? '100vw' : `calc(100vw - ${width}px)`;
                shellEl.style.setProperty('width', shellWidth, 'important');
                shellEl.style.setProperty('max-width', shellWidth, 'important');
                shellEl.style.setProperty('right', compactOverlay ? '0' : 'auto', 'important');
            }else{
                shellEl.style.removeProperty('width');
                shellEl.style.removeProperty('max-width');
                shellEl.style.removeProperty('right');
                shellEl.style.removeProperty('left');
                shellEl.style.removeProperty('margin-left');
                shellEl.style.removeProperty('margin-right');
            }
        }
    }catch(_){ }
    // 同步顶栏宿主按钮：若仍被盖住，再整体左移 dock 宽度（双保险，不改原项目文件）
    try{ agentShiftHostTopChrome(open, width); }catch(_){ }
    try{
        if(typeof window !== 'undefined') window.__canvasAgentDockWidth = open && !compactOverlay ? width : 0;
    }catch(_){ }
}
function agentShiftHostTopChrome(open, width){
    // 顶栏位置改由插件 CSS 的 right 偏移处理；这里只清理历史 transform，避免叠加位移
    const ids = [
        'smartWorkflowToggle','smartShortcutToggle','smartLogToggle','assetToggle',
        'workflowTransferToggle','canvasAssetToggle','canvasLogToggle'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if(!el) return;
        try{
            if(el.dataset.agentDockShift === '1'){
                el.style.removeProperty('transform');
                delete el.dataset.agentDockShift;
            }
        }catch(_){ }
    });
}

function agentInitDockResizer(){
    const handle = document.getElementById('agentDockResizer') || agentPanel?.querySelector?.('.agent-dock-resizer');
    if(!handle || handle.dataset.boundDockResize === '1') return;
    handle.dataset.boundDockResize = '1';
    let dragging = false;
    let startX = 0;
    let startW = 0;
    const syncAria = (width=agentDockWidthPx()) => {
        const maxW = agentClampDockWidth(Number.MAX_SAFE_INTEGER);
        handle.setAttribute('aria-valuemax', String(maxW));
        handle.setAttribute('aria-valuenow', String(agentClampDockWidth(width)));
        handle.setAttribute('aria-valuetext', `${agentClampDockWidth(width)} 像素`);
    };
    const onMove = (e) => {
        if(!dragging) return;
        const clientX = e.touches?.[0]?.clientX ?? e.clientX;
        // 向左拖 = 变宽
        const delta = startX - clientX;
        const width = agentSetDockWidth(startW + delta, {persist:false});
        syncAria(width);
        agentSyncDockLayout();
        e.preventDefault?.();
    };
    const onUp = () => {
        if(!dragging) return;
        dragging = false;
        try{
            document.body.classList.remove('canvas-agent-dock-resizing');
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerup', onUp, true);
            document.removeEventListener('pointercancel', onUp, true);
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            document.removeEventListener('touchmove', onMove, true);
            document.removeEventListener('touchend', onUp, true);
        }catch(_){ }
        agentSaveDockWidth(agentDockWidthPx());
        syncAria();
        agentSyncDockLayout();
    };
    const onDown = (e) => {
        if(!agentOpen) return;
        if(dragging) return;
        dragging = true;
        startX = e.touches?.[0]?.clientX ?? e.clientX;
        startW = agentDockWidthPx();
        try{ document.body.classList.add('canvas-agent-dock-resizing'); }catch(_){ }
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onUp, true);
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        document.addEventListener('touchmove', onMove, {capture:true, passive:false});
        document.addEventListener('touchend', onUp, true);
        e.preventDefault?.();
        e.stopPropagation?.();
    };
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, {passive:false});
    handle.addEventListener('keydown', e => {
        if(!agentOpen) return;
        const step = e.shiftKey ? 32 : 16;
        let next = agentDockWidthPx();
        if(e.key === 'ArrowLeft') next += step;
        else if(e.key === 'ArrowRight') next -= step;
        else if(e.key === 'Home') next = 300;
        else if(e.key === 'End') next = Number.MAX_SAFE_INTEGER;
        else return;
        e.preventDefault();
        const width = agentSetDockWidth(next, {persist:true});
        syncAria(width);
        agentSyncDockLayout();
    });
    syncAria();
}
function toggleAgentPanel(open=!agentOpen){
    if(!agentPanel || !agentToggle) return;
    agentOpen = !!open;
    if(agentOpen && typeof toggleAssetLibrary === 'function'){
        try{ toggleAssetLibrary(false); }catch(_){ }
    }
    // 先立刻切换可见性与布局，避免“点了半天才出来”
    agentPanel.classList.toggle('open', agentOpen);
    agentToggle.classList.toggle('active', agentOpen);
    try{ agentSyncDockLayout(); }catch(_){ }
    if(agentOpen){
        const light = () => {
            try{
                if(agentProvidersReady() && !_agentModelProvidersReadyApplied){
                    agentRestoreDefaultModelsWhenProvidersReady(false);
                    renderAgentModelSelectors(true);
                }else{
                    renderAgentModelSelectors(false);
                }
            }catch(_){ }
            try{ agentUpdateModelDefaultHint(); }catch(_){ }
            try{
                const needMsg = !agentMessages || agentMessages.dataset.agentRendered !== '1' || agentMessages.dataset.agentDirty === '1';
                if(needMsg){
                    renderAgentMessages();
                }
            }catch(_){ }
            try{
                agentLastSelectionSig = '';
                syncAgentSelectionButton();
                agentAutoResizeInput();
            }catch(_){ }
        };
        if(typeof requestAnimationFrame === 'function'){
            requestAnimationFrame(() => {
                if(typeof requestAnimationFrame === 'function'){
                    requestAnimationFrame(() => { try{ light(); }catch(_){ } });
                }else{
                    try{ light(); }catch(_){ }
                }
            });
        }else{
            setTimeout(() => { try{ light(); }catch(_){ } }, 0);
        }
    }else{
        try{ clearAgentGhostAttachment({rerender:true}); }catch(_){ }
    }
}
function chatRequestedImageCount(text){
    const raw = String(text || '');
    // 页数/套数/“这两个参考”不是出图张数
    let t = raw
        .replace(/(?<!\d)[1-8一二两三俩四五六七八]\s*页/g, ' ')
        .replace(/(?<!\d)[1-8一二两三俩四五六七八]\s*套(?!图)/g, ' ')
        // “这两个/这三张参考图/两张参考”是输入对象数量，不是要生成几张
        .replace(/这\s*[1-8一二两三俩四五六七八]\s*(?:个|张|幅)?/g, ' ')
        .replace(/[1-8一二两三俩四五六七八]\s*(?:个|张|幅)?\s*(?:参考图|附件|素材|原图)/g, ' ')
        .replace(/参考图\s*[1-8一二两三俩四五六七八]/g, ' ');
    const counts = [];
    // 优先：明确“生成/出/做 N 张”
    const explicit = [];
    const reExplicit = /(?:生成|出|做|画|制作|创作|来)\s*([1-8一二两三俩四五六七八])\s*(?:张|幅)/g;
    let m;
    while((m = reExplicit.exec(t)) !== null){
        const n = /^\d+$/.test(m[1]) ? parseInt(m[1],10) : ({一:1,二:2,两:2,俩:2,三:3,四:4,五:5,六:6,七:7,八:8}[m[1]]||0);
        if(n>=1 && n<=8) explicit.push(n);
    }
    // 不要在这里提前返回：例如“来一张主图和两张详情页”同时包含
    // 带动词数量与后续简写数量，最终应取所有明确“张/幅”中的最大值。
    counts.push(...explicit);
    // 次优：N张/N幅（不要用“个/只”这类，易误伤“这两个/一只猫”）
    const re = /(?<!\d)([1-8])\s*(?:张|幅)(?!\d)/g;
    while((m = re.exec(t)) !== null){
        counts.push(parseInt(m[1], 10));
    }
    const cnMap = {一:1, 二:2, 两:2, 俩:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8};
    for(const [k, v] of Object.entries(cnMap)){
        if(t.includes(k + '张') || t.includes(k + '幅') || t.includes(k + '套图')){
            counts.push(v);
        }
    }
    if(!counts.length) return 0;
    return Math.max(...counts);
}
// 从用户原文提取明确分辨率。B0：文案里的 2K/4K 必须能进节点参数，不能只看工具栏。
function chatRequestedResolution(text){
    const t = String(text || '');
    // 优先匹配更具体的写法
    if(/(?:^|[^a-z0-9])(?:4\s*[kK]|4K|4k|四\s*[kK]|四K)(?:$|[^a-z0-9])/.test(t) || /分辨率\s*[:：]?\s*4\s*[kK]/i.test(t)) return '4k';
    if(/(?:^|[^a-z0-9])(?:2\s*[kK]|2K|2k|两\s*[kK]|二\s*[kK]|两K|二K)(?:$|[^a-z0-9])/.test(t) || /分辨率\s*[:：]?\s*2\s*[kK]/i.test(t)) return '2k';
    if(/(?:^|[^a-z0-9])(?:1\s*[kK]|1K|1k)(?:$|[^a-z0-9])/.test(t) || /分辨率\s*[:：]?\s*1\s*[kK]/i.test(t)) return '1k';
    return '';
}
function chatRequestedRatio(text){
    const t = String(text || '').toLowerCase().replace(/\s+/g, '');
    // 显式比例优先
    if(/9(?:[:：\/]|比)16|竖版9|竖屏9|竖图9/.test(t) || /story/.test(t)) return 'story';
    if(/16(?:[:：\/]|比)9|横版16|横屏16|横图16/.test(t)) return 'wide';
    if(/1(?:[:：\/]|比)1|正方形|方图/.test(t)) return 'square';
    if(/2(?:[:：\/]|比)3/.test(t)) return 'portrait';
    if(/3(?:[:：\/]|比)4/.test(t)) return 'portrait43';
    if(/4(?:[:：\/]|比)5/.test(t)) return 'portrait45';
    if(/4(?:[:：\/]|比)3/.test(t)) return 'landscape43';
    if(/3(?:[:：\/]|比)2/.test(t)) return 'landscape';
    if(/21(?:[:：\/]|比)9/.test(t)) return 'ultrawide';
    if(/9(?:[:：\/]|比)21/.test(t)) return 'ultratall';
    return '';
}
function chatRequestedRatioForGeneration(text, generation={}){
    const t = String(text || '');
    // 先信任结构化的 role/title；不要让提示词里“后续详情页/主图”等依赖说明
    // 抢走当前步骤的类型，否则三视图/主图会被误判成详情页，反之亦然。
    const role = String(generation?.role || '').trim().toLowerCase();
    const titleIdentity = [generation?.title, generation?.name]
        .map(value => String(value || '').toLowerCase()).join(' ');
    const promptIdentity = String(generation?.prompt || '').toLowerCase();
    const ratioPattern = '(1\\s*[:：/]\\s*1|2\\s*[:：/]\\s*3|3\\s*[:：/]\\s*4|4\\s*[:：/]\\s*5|4\\s*[:：/]\\s*3|3\\s*[:：/]\\s*2|9\\s*[:：/]\\s*16|16\\s*[:：/]\\s*9|21\\s*[:：/]\\s*9|9\\s*[:：/]\\s*21)';
    const findScoped = (labelPattern) => {
        const labels = [...t.matchAll(new RegExp(labelPattern, 'gi'))];
        const ratios = [...t.matchAll(new RegExp(ratioPattern, 'gi'))];
        let best = null;
        labels.forEach(label => {
            ratios.forEach(ratio => {
                const labelStart = Number(label.index) || 0;
                const labelEnd = labelStart + String(label[0] || '').length;
                const ratioStart = Number(ratio.index) || 0;
                const ratioEnd = ratioStart + String(ratio[0] || '').length;
                const betweenStart = Math.min(labelEnd, ratioEnd);
                const betweenEnd = Math.max(labelStart, ratioStart);
                const between = t.slice(betweenStart, betweenEnd);
                if(/[。；;\\n]/.test(between)) return;
                const distance = ratioEnd <= labelStart
                    ? labelStart - ratioEnd
                    : (labelEnd <= ratioStart ? ratioStart - labelEnd : 0);
                if(distance > 32) return;
                if(!best || distance < best.distance){
                    best = {distance, value:String(ratio[1] || ratio[0] || '')};
                }
            });
        });
        return best?.value
            ? agentNormalizeRatioValue(best.value.replace(/\\s+/g, '').replace(/[：/]/g, ':'))
            : '';
    };
    const titleIsDetail = /detail|详情/.test(titleIdentity);
    const titleIsMain = !titleIsDetail && /main|主图|三视图|product.?hero|产品(?:定稿|资产|设计)/.test(titleIdentity);
    const roleIsDetail = role === 'detail' || role === 'variant_detail';
    const roleIsMain = role === 'main' || role === 'product_hero' || role === 'hero';
    // title 是逐步的具体名称，role 只是模型给出的宽泛分类；两者冲突时必须以 title 为准。
    let isDetail = titleIsDetail || (!titleIsMain && roleIsDetail);
    let isMain = !isDetail && (titleIsMain || roleIsMain);
    // 只有缺少结构化类型时，才从提示词推断；提示词同时提到主图和详情页时放弃猜测。
    if(!isDetail && !isMain){
        const promptDetail = /detail|详情/.test(promptIdentity);
        const promptMain = /main|主图|三视图|product.?hero|产品(?:定稿|资产|设计)/.test(promptIdentity);
        if(promptDetail !== promptMain){
            isDetail = promptDetail;
            isMain = promptMain;
        }
    }
    if(isDetail){
        const scoped = findScoped('详情(?:页|图)?');
        if(scoped) return scoped;
    }
    if(isMain){
        const scoped = findScoped('(?:主图|三视图|产品(?:定稿|资产|设计图)?)');
        if(scoped) return scoped;
    }
    const tokens = t.match(new RegExp(ratioPattern, 'gi')) || [];
    const unique = [...new Set(tokens.map(value => agentNormalizeRatioValue(value.replace(/\\s+/g, '').replace(/[：/]/g, ':'))).filter(Boolean))];
    // 多种比例同时出现但没有匹配到当前步骤时，不把其中任意一个当成整套全局比例。
    return unique.length === 1 ? unique[0] : '';
}
function chatRequestedQuality(text){
    const t = String(text || '');
    if(/最高画质|高画质|超清|高清|画质\s*[:：]?\s*高|质量\s*[:：]?\s*高|high\s*quality|quality\s*[:：]?\s*high/i.test(t)) return 'high';
    if(/中等画质|中画质|画质\s*[:：]?\s*中|质量\s*[:：]?\s*中|medium\s*quality|quality\s*[:：]?\s*(?:medium|mid)/i.test(t)) return 'medium';
    if(/低画质|画质\s*[:：]?\s*低|质量\s*[:：]?\s*低|low\s*quality|quality\s*[:：]?\s*low/i.test(t)) return 'low';
    if(/标准画质|普通画质|自动画质|画质\s*[:：]?\s*(?:标准|普通|自动)|quality\s*[:：]?\s*(?:standard|auto)/i.test(t)) return 'auto';
    return '';
}
// 统一的数量决策函数：输入框显式要求 > 工具栏设置
// 返回 {count, source}，count 始终 >=1
function resolveFinalGenCount(text){
    const t = String(text || '');
    // 套图/多角色规划：主图N + 详情M / 先A再B 不是“单步一次出N张”
    // 这类数量只表示步骤数，不能冻进单个 generation.count
    // 注意：不要因为单独出现“主图/白底/详情”就把“三张海报/两张写真”误判成多步
    const hasSequence = /先.{0,30}(?:再|然后)|然后|接着|之后再|分步|单独生成|各自/.test(t);
    const hasSuiteRoles = (/(?:主图|详情(?:页|图)?|三视图|定稿|包装)/.test(t) && /(?:再|然后|和|及|、|，).{0,20}(?:主图|详情(?:页|图)?|三视图|定稿|包装)/.test(t))
        || (/(?:[1-9一二两三四五六七八]|两)\s*张?主图/.test(t) && /(?:[1-9一二两三四五六七八]|两)\s*张?详情/.test(t))
        || /套图|系列|详情页海报|整套/.test(t);
    const hasVariantKinds = /([1-9]\d?|[一二三四五六七八九十两])\s*种/.test(t)
        || /(?:表情|姿势|角度|变体|风格方向).{0,12}(?:各异|不同|多种|几种)/.test(t)
        || /(?:不同|分别|几种|多种).{0,12}(?:表情|姿势|角度|变体|风格)/.test(t);
    const multiCountRoles = /([1-9一二两三四五六七八两])\s*张[^，。；;]{0,8}(?:主图|详情|海报)/.test(t)
        && /([1-9一二两三四五六七八两])\s*张/.test(t.replace(/([1-9一二两三四五六七八两])\s*张[^，。；;]{0,8}(?:主图|详情|海报)/, ''));
    const looksLikeMultiStepPlan = hasSequence || hasSuiteRoles || hasVariantKinds || multiCountRoles;
    if(looksLikeMultiStepPlan){
        const toolbar = Math.max(1, Math.min(8, Number(agentState?.genCount) || 1));
        return {count: 1, source: 'multistep_plan'};
    }
    const fromInput = chatRequestedImageCount(text);
    // 参数面板已移除：默认只出 1 张。只有用户原文明确写了张数才覆盖。
    // 避免历史 agentState.genCount=2 导致“一句话出两张/两套工作流”。
    if(fromInput > 1) return {count: Math.min(8, fromInput), source:'input'};
    if(fromInput === 1) return {count: 1, source:'input'};
    return {count: 1, source:'default'};
}
// B0 参数冻结：把本轮明确约束冻结成节点/API 共用设置
// - 数量：输入明确 >1 时优先生效
// - 分辨率：输入明确 1k/2k/4k 时优先生效；否则工具栏
// - 画质：输入明确时优先生效；否则工具栏

function agentNormalizeRatioValue(v){
    const s = String(v || '').trim().toLowerCase().replace(/\s+/g,'');
    if(!s) return '';
    const map = {
        '1:1':'square', 'square':'square',
        '2:3':'portrait', 'portrait':'portrait',
        '3:4':'portrait43', 'portrait43':'portrait43',
        '4:5':'portrait45', 'portrait45':'portrait45',
        '4:3':'landscape43', 'landscape43':'landscape43',
        '3:2':'landscape', 'landscape':'landscape',
        '9:16':'story', 'story':'story',
        '16:9':'wide', 'wide':'wide',
        '21:9':'ultrawide', 'ultrawide':'ultrawide',
        '9:21':'ultratall', 'ultratall':'ultratall'
    };
    return map[s] || '';
}
// 当前 Agent 生图比例能力，始终来自画布 /api/image-params；无能力数据时只允许安全的 1:1。
let agentImageParamCapabilities = {
    key:'',
    provider:'',
    model:'',
    ratios:['square','portrait','portrait43','portrait45','landscape43','landscape','story','wide','ultrawide','ultratall'],
    loaded:false
};
// 能力结果和进行中的请求都必须按 provider + model 隔离。
// agentImageParamCapabilities 只保留“当前 UI 选择”的兼容镜像，任务执行不得把它当作真相。
const agentImageParamCapabilitiesByKey = new Map();
const agentImageParamRequestsByKey = new Map();
let agentImageParamsRequestSequence = 0;
const AGENT_RATIO_DIMENSIONS = {
    square:[1,1], portrait:[2,3], portrait43:[3,4], portrait45:[4,5],
    landscape43:[4,3], landscape:[3,2], story:[9,16], wide:[16,9],
    ultrawide:[21,9], ultratall:[9,21]
};
function agentSupportedRatioValues(raw){
    const values = Array.isArray(raw) ? raw : [];
    const out = [];
    values.forEach(item => {
        const value = agentNormalizeRatioValue(item?.value ?? item);
        if(value && !out.includes(value)) out.push(value);
    });
    return out.length ? out : ['square'];
}
function agentRatioNearestSupported(value, supported){
    const requested = agentNormalizeRatioValue(value) || 'square';
    const list = Array.isArray(supported) && supported.length ? supported : ['square'];
    if(list.includes(requested)) return requested;
    const target = AGENT_RATIO_DIMENSIONS[requested] || AGENT_RATIO_DIMENSIONS.square;
    const targetRatio = target[0] / target[1];
    return list.reduce((best, candidate) => {
        const dims = AGENT_RATIO_DIMENSIONS[candidate] || AGENT_RATIO_DIMENSIONS.square;
        const distance = Math.abs(Math.log(targetRatio / (dims[0] / dims[1])));
        if(!best || distance < best.distance) return {value:candidate, distance};
        return best;
    }, null)?.value || 'square';
}
function agentConstrainRatio(value){
    const normalized = agentNormalizeRatioValue(value) || 'square';
    const ratio = agentRatioNearestSupported(normalized, agentImageParamCapabilities.ratios);
    return {ratio, adjusted: ratio !== normalized ? normalized : ''};
}
function agentImageParamsKey(provider='', model=''){
    const providerId = String(provider || '').trim();
    const modelId = String(model || '').trim();
    return providerId && modelId ? `${providerId}\u0000${modelId}` : '';
}
function agentSafeImageParamCapabilities(provider='', model=''){
    return {
        key:agentImageParamsKey(provider, model),
        provider:String(provider || '').trim(),
        model:String(model || '').trim(),
        ratios:['square'],
        loaded:false
    };
}
function agentApplyImageParamCapabilitiesToCurrentUi(capabilities){
    if(!capabilities || !agentState) return false;
    const currentKey = agentImageParamsKey(agentState.genProvider, agentState.genModel);
    if(!currentKey || capabilities.key !== currentKey) return false;
    agentImageParamCapabilities = {
        ...capabilities,
        ratios:Array.isArray(capabilities.ratios) ? capabilities.ratios.slice() : ['square']
    };
    const constrained = agentConstrainRatio(agentState.genRatio || 'square');
    if(agentState.genRatio !== constrained.ratio) agentState.genRatio = constrained.ratio;
    renderAgentRatioOptions();
    agentSyncParamsPanel();
    return true;
}
async function agentRefreshImageParamCapabilities(provider='', model='', options={}){
    const key = agentImageParamsKey(provider, model);
    const safeCapabilities = agentSafeImageParamCapabilities(provider, model);
    if(!key || typeof fetch !== 'function'){
        if(key) agentImageParamCapabilitiesByKey.set(key, safeCapabilities);
        agentApplyImageParamCapabilitiesToCurrentUi(safeCapabilities);
        return safeCapabilities;
    }
    const cached = agentImageParamCapabilitiesByKey.get(key);
    if(!options.force && cached?.loaded){
        agentApplyImageParamCapabilitiesToCurrentUi(cached);
        return cached;
    }
    const inFlight = agentImageParamRequestsByKey.get(key);
    // 同一 provider/model 的 UI 同步和任务预检共享同一个在途请求；不同键完全并行。
    if(inFlight?.promise) return inFlight.promise;

    // 切换模型后先把 UI 收紧到安全比例，旧模型能力不能在等待期间继续可选。
    if(agentImageParamsKey(agentState?.genProvider, agentState?.genModel) === key
        && agentImageParamCapabilities.key !== key){
        agentApplyImageParamCapabilitiesToCurrentUi(safeCapabilities);
    }

    const requestId = ++agentImageParamsRequestSequence;
    const requestRecord = {key, requestId, promise:null};
    const requestPromise = (async () => {
        let resolved = safeCapabilities;
        try{
            const qs = new URLSearchParams({provider_id:String(provider || ''), model:String(model || '')});
            const response = await fetch(`/api/image-params?${qs.toString()}`, {cache:'no-store'});
            if(!response.ok) throw new Error(`image params ${response.status}`);
            const payload = await response.json();
            const size = (payload.fields || []).find(field => field?.key === 'size' && field?.type === 'size');
            resolved = {
                key,
                provider:String(provider || '').trim(),
                model:String(model || '').trim(),
                ratios:agentSupportedRatioValues(size?.ratios),
                loaded:true
            };
        }catch(_){
            // 能力接口不可用时保持最保守值，绝不把旧模型的比例带到新模型。
            resolved = safeCapabilities;
        }

        // 同一模型若被 force 发起了更新请求，旧响应也不能覆盖较新的同键请求。
        const latest = agentImageParamRequestsByKey.get(key);
        if(latest?.requestId === requestId){
            agentImageParamCapabilitiesByKey.set(key, resolved);
            agentApplyImageParamCapabilitiesToCurrentUi(resolved);
        }
        // 无论 UI 当前选择什么，调用方只能拿到自己请求键对应的能力对象。
        return resolved;
    })().finally(() => {
        if(agentImageParamRequestsByKey.get(key)?.requestId === requestId){
            agentImageParamRequestsByKey.delete(key);
        }
    });
    requestRecord.promise = requestPromise;
    agentImageParamRequestsByKey.set(key, requestRecord);
    return requestPromise;
}
function renderAgentRatioOptions(){
    const values = agentImageParamCapabilities.ratios || ['square'];
    const html = values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(agentRatioLabel(value))}</option>`).join('');
    if(agentGenRatio) agentGenRatio.innerHTML = html;
    document.querySelectorAll('.agent-ratio-btn').forEach(btn => { btn.hidden = !values.includes(btn.dataset.ratio); });
}
function agentNormalizeResolutionValue(v){
    const s = String(v || '').trim().toLowerCase();
    if(['1k','2k','4k'].includes(s)) return s;
    if(/4\s*k/.test(s)) return '4k';
    if(/2\s*k/.test(s)) return '2k';
    if(/1\s*k/.test(s)) return '1k';
    return '';
}
function agentNormalizeQualityValue(v){
    const s = String(v || '').trim().toLowerCase();
    if(['auto','low','medium','high'].includes(s)) return s;
    if(s === 'mid' || s === 'standard' || s === 'normal') return s === 'mid' ? 'medium' : 'auto';
    return chatRequestedQuality(s);
}
function agentResolveStepGenerationSettings(userText='', generation={}, fallback={}){
    const userRatio = chatRequestedRatioForGeneration(userText, generation);
    const userResolution = chatRequestedResolution(userText);
    const userQuality = chatRequestedQuality(userText);
    // A task freezes the Agent toolbar settings when the user sends it. If
    // the user did not state a parameter in text, that snapshot is authoritative.
    const preferTaskSettings = fallback?.prefer_task_settings === true;
    const fallbackRatio = agentNormalizeRatioValue(fallback?.ratio);
    const generationRatio = agentNormalizeRatioValue(generation?.ratio);
    const fallbackResolution = agentNormalizeResolutionValue(fallback?.resolution);
    const generationResolution = agentNormalizeResolutionValue(generation?.resolution);
    const fallbackQuality = agentNormalizeQualityValue(fallback?.quality);
    const generationQuality = agentNormalizeQualityValue(generation?.quality);
    const requestedRatio = userRatio || (preferTaskSettings ? fallbackRatio : generationRatio) || (preferTaskSettings ? generationRatio : fallbackRatio) || 'square';
    const constrainedRatio = agentConstrainRatio(requestedRatio);
    return {
        ratio: constrainedRatio.ratio,
        resolution: userResolution || (preferTaskSettings ? fallbackResolution : generationResolution) || (preferTaskSettings ? generationResolution : fallbackResolution) || '1k',
        quality: userQuality || (preferTaskSettings ? fallbackQuality : generationQuality) || (preferTaskSettings ? generationQuality : fallbackQuality) || 'auto',
        sources: {
            ratio: constrainedRatio.adjusted ? 'adjusted' : (userRatio ? 'user' : (preferTaskSettings && fallbackRatio ? 'task_settings' : (generationRatio ? 'generation' : 'fallback'))),
            requestedRatio,
            adjustedFrom: constrainedRatio.adjusted,
            resolution: userResolution ? 'user' : (preferTaskSettings && fallbackResolution ? 'task_settings' : (generationResolution ? 'generation' : 'fallback')),
            quality: userQuality ? 'user' : (preferTaskSettings && fallbackQuality ? 'task_settings' : (generationQuality ? 'generation' : 'fallback'))
        }
    };
}
function resolveAgentGenerationSettings(text='', overrides={}){
    const countInfo = resolveFinalGenCount(text);
    const textRes = chatRequestedResolution(text);
    const textQuality = chatRequestedQuality(text);
    const textRatio = chatRequestedRatio(text);
    // 优先级：generation 显式字段 > 用户/回复/提示词原文 > 工具栏
    const toolbarRes = String(agentState?.genResolution || '1k').toLowerCase();
    const toolbarQuality = String(agentState?.genQuality || 'auto') || 'auto';
    const toolbarRatio = String(agentState?.genRatio || 'square') || 'square';
    const overrideRes = overrides.resolution != null && overrides.resolution !== '' ? String(overrides.resolution).toLowerCase() : '';
    const overrideQuality = overrides.quality != null && overrides.quality !== '' ? agentNormalizeQualityValue(overrides.quality) : '';
    const overrideRatioRaw = overrides.ratio != null && overrides.ratio !== '' ? String(overrides.ratio) : '';
    const overrideRatioNorm = agentNormalizeRatioValue(overrideRatioRaw) || '';
    const overrideResolutionNorm = agentNormalizeResolutionValue(overrideRes) || agentNormalizeResolutionValue(String(overrides.resolution || '')) || '';
    // 原文 2K/1:1 必须压过工具栏 1k/9:16
    const resolution = overrideResolutionNorm || textRes || toolbarRes || '1k';
    const quality = overrideQuality || textQuality || agentNormalizeQualityValue(toolbarQuality) || 'auto';
    const requestedRatio = overrideRatioNorm || textRatio || toolbarRatio || 'square';
    const constrainedRatio = agentConstrainRatio(requestedRatio);
    const ratio = constrainedRatio.ratio;
    // count：若 generation 自带 count>1 则保留；否则用统一数量决策
    let count = countInfo.count;
    let countSource = countInfo.source;
    if(overrides.count != null){
        const oc = Math.max(1, Math.min(8, Number(overrides.count) || 1));
        if(oc > 1 || countInfo.source !== 'input'){
            count = oc;
            countSource = oc > 1 ? 'generation' : countInfo.source;
        }
    }
    return {
        ratio,
        resolution: ['1k','2k','4k'].includes(String(resolution).toLowerCase()) ? String(resolution).toLowerCase() : '1k',
        quality,
        count: Math.max(1, Math.min(8, Number(count) || 1)),
        sources: {
            count: countSource,
            resolution: (overrideRes && overrideRes !== toolbarRes) ? 'override' : (textRes ? 'input' : 'toolbar'),
            quality: (overrideQuality && overrideQuality !== toolbarQuality) ? 'override' : (textQuality ? 'input' : 'toolbar'),
            ratio: constrainedRatio.adjusted ? 'adjusted' : (overrideRatioNorm ? 'override' : (textRatio ? 'input' : 'toolbar')),
            requestedRatio,
            adjustedFrom: constrainedRatio.adjusted
        }
    };
}
// 判断输入是否"模糊"（缺风格维度），用于思维模式前端兜底
// 判断标准：字数少 + 不含风格/艺术流派关键词
// 返回 true 表示需要先走阶段一（返回 options 让用户选风格）
function isVagueImageRequest(text){
    const t = String(text || '').trim();
    if(!t) return false;
    // 修改请求不算模糊（有明确的修改方向）
    if(/改成|换成|转换成|修改为|变成|转为|改为|转成|调整|重新画|重画/i.test(t)) return false;
    // B0：明确生图约束已足够时，不因缺少风格词而强制确认
    // 例如“生成一只侧身橘猫，2K，两张”
    const hasGenVerb = /生成|画|做|出|设计|创作|来一|帮我/.test(t);
    const hasSubject = /猫|狗|犬|金毛|拉布拉多|柯基|哈士奇|人|女|男|产品|包装|海报|场景|角色|风景|花|车|房|食物|鞋|包|数码|家具|宠物|橘猫|黑猫|白猫|茶叶|茶|猫粮|狗粮|猫砂|拉面|主图|详情页|套装|三视图|白底/.test(t) || /一只|一个|一张|一位|一条|两张|三张|四张/.test(t);
    const hasConstraint = /\d\s*[kK]|[124]\s*[kK]|两张|二张|三张|四张|1:1|16:9|9:16|3:4|4:3|侧身|正面|背面|特写|全景|白底|详情页|主图|融合|参考/.test(t);
    if(hasGenVerb && hasSubject && hasConstraint) return false;
    if(hasGenVerb && hasSubject && t.length >= 12) return false;
    // 风格/艺术流派关键词
    const styleKeywords = ['风','风格','主义','流派','艺术','画法','画风','渲染','摄影','插画','海报','logo','标志','图标','3d','3D','写实','动漫','水墨','油画','水彩','素描','速写','像素','赛博','蒸汽波','极简','极繁','扁平','卡通','可爱','复古','复古风','霓虹','蒸汽','lowpoly','low poly','波普','波普艺术','印象派','抽象','超现实','涂鸦','手绘','国风','中国风','日式','和风','美式','欧式','赛博朋克','蒸汽朋克','未来主义','装饰艺术','artdeco','art deco','bauhaus','包豪斯','印象','点彩','浮世绘','赛璐珞','吉卜力','新海诚','皮克斯','迪士尼','漫威','dc','chibi','q版','q版','q版','q版','q版'];
    const hasStyle = styleKeywords.some(k => t.toLowerCase().includes(k.toLowerCase()));
    // 字数少且无风格 → 模糊
    if(t.length < 25 && !hasStyle) return true;
    return false;
}
// ★ 纯文字引导解析器：从用户输入中识别图N引用，判断拆分/组合模式
// 返回 { mode, tasks } 或 null（无图引用时）
// mode: 'split'（每张独立出图） | 'single'（单任务，全发）
// tasks: [{ prompt, attachment_indices(0-based) }]
// 核心原则：默认不拆分（全发给模型理解），只有明确的批量独立操作才拆分
function parseImageRefTasks(text, attachCount){
    if(!text || !attachCount || attachCount === 0) return null;
    // 0. 中文数字转阿拉伯（图一→图1，图十→图10）
    const cnNumMap = {'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10'};
    let t = text.replace(/图\s*([一二三四五六七八九十])/g, (match, cn) => `图${cnNumMap[cn] || cn}`);

    const uniqueRefs = new Set();
    const refOccurrences = {}; // 每张图被引用的次数
    const consumedRanges = [];
    function addRef(num){ if(num >= 1 && num <= attachCount){ uniqueRefs.add(num); refOccurrences[num] = (refOccurrences[num] || 0) + 1; } }

    // 1. 范围：图1到图7, 图1至7, 图1-4, 图1~4
    const rangeRe = /图\s*(\d+)\s*[到至\-~]\s*图?\s*(\d+)/g;
    let m;
    while((m = rangeRe.exec(t)) !== null){
        const lo = Math.min(parseInt(m[1]), parseInt(m[2]));
        const hi = Math.max(parseInt(m[1]), parseInt(m[2]));
        for(let i = lo; i <= hi; i++) addRef(i);
        consumedRanges.push({start:m.index, end:m.index + m[0].length});
    }
    // 2. 列表和单个：图1、2、3 或 图1
    const listRe = /图\s*(\d+)((?:\s*[、,，和与]\s*\d+)*)/g;
    while((m = listRe.exec(t)) !== null){
        const ms = m.index, me = m.index + m[0].length;
        if(consumedRanges.some(r => ms >= r.start && me <= r.end)) continue;
        addRef(parseInt(m[1]));
        if(m[2]){ const restNums = m[2].match(/\d+/g); if(restNums) restNums.forEach(n => addRef(parseInt(n))); }
    }
    // 3. "前面N张" / "前N张"
    const frontMatch = t.match(/前(?:面)?\s*(\d+)\s*张/);
    if(frontMatch){ const n = parseInt(frontMatch[1]); for(let i = 1; i <= Math.min(n, attachCount); i++) addRef(i); }

    if(uniqueRefs.size === 0) return null;
    const allRefs = Array.from(uniqueRefs).sort((a, b) => a - b);

    // 4. 底图检测：仅靠位置/结构模式判断（不靠引用次数，避免公共参考图被误判）
    const baseImages = new Set();
    // "图N中/里/的XX位置" 或 "保持图N的XX不变" → 底图
    const baseRe1 = /图\s*(\d+)\s*(?:中|里)\s*(?:的)?(?:左|右|上|下|中间|旁边)/g;
    while((m = baseRe1.exec(t)) !== null){ const num = parseInt(m[1]); if(num >= 1 && num <= attachCount) baseImages.add(num); }
    const baseRe2 = /保持\s*图\s*(\d+)\s*的/g;
    while((m = baseRe2.exec(t)) !== null){ const num = parseInt(m[1]); if(num >= 1 && num <= attachCount) baseImages.add(num); }
    const baseRe3 = /图\s*(\d+)\s*的(?:背景|构图|版式|布局|场景|底色)/g;
    while((m = baseRe3.exec(t)) !== null){ const num = parseInt(m[1]); if(num >= 1 && num <= attachCount) baseImages.add(num); }

    // 5. 模式判断（默认不拆分，交给模型理解）
    const hasCombineHint = /合成一张|合并|拼在一起|组合成|拼接|融合/.test(t);
    const hasSplitKeyword = /各出一张|各出|分别|各一张|每张|逐一|逐个|全部重新/.test(t);

    // 规则 1：有底图 → 不拆分（单任务编辑）
    if(baseImages.size > 0){
        return { mode:'single', tasks:[{ prompt:text, attachment_indices:allRefs.map(r => r - 1) }] };
    }
    // 规则 2：合成关键词 → 不拆分
    if(hasCombineHint){
        return { mode:'single', tasks:[{ prompt:text, attachment_indices:allRefs.map(r => r - 1) }] };
    }
    // 规则 3：只有 1 张引用 → 不拆分
    if(allRefs.length <= 1){
        return { mode:'single', tasks:[{ prompt:text, attachment_indices:allRefs.map(r => r - 1) }] };
    }
    // 规则 4：多张独立引用 + (有拆分关键词 或 范围引用) → 拆分
    // 识别公共参考图：不在范围引用内的单独编号 = 公共图
    const rangeRefs = new Set();
    const rangeRe2 = /图\s*(\d+)\s*[到至\-~]\s*图?\s*(\d+)/g;
    while((m = rangeRe2.exec(t)) !== null){
        const lo = Math.min(parseInt(m[1]), parseInt(m[2]));
        const hi = Math.max(parseInt(m[1]), parseInt(m[2]));
        for(let i = lo; i <= hi; i++){ if(i >= 1 && i <= attachCount) rangeRefs.add(i); }
    }
    // 独立图 = 范围引用内的图；公共图 = 不在范围内的单独引用
    const independentRefs = allRefs.filter(r => rangeRefs.has(r));
    const commonRefs = allRefs.filter(r => !rangeRefs.has(r));

    const shouldSplit = (hasSplitKeyword || rangeRefs.size > 1) && independentRefs.length > 1;
    if(shouldSplit){
        const commonArr = commonRefs.map(r => r - 1);
        const tasks = independentRefs.map(ref => ({ prompt:text, attachment_indices:[ref - 1, ...commonArr] }));
        return { mode:'split', tasks };
    }
    // 默认：不拆分，全发（让模型理解意图）
    return { mode:'single', tasks:[{ prompt:text, attachment_indices:allRefs.map(r => r - 1) }] };
}


// ===== B0+ 真实复杂需求加固 =====
function agentCnNumToInt(token){
    const t = String(token || '').trim();
    if(!t) return 0;
    if(/^\d+$/.test(t)) return parseInt(t, 10);
    const map = {一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
    if(map[t]) return map[t];
    if(t === '十') return 10;
    if(t.startsWith('十') && map[t.slice(1)]) return 10 + map[t.slice(1)];
    if(t.endsWith('十') && map[t[0]]) return map[t[0]] * 10;
    return 0;
}
function agentExtractAttachmentIndicesFromText(text, attachCount){
    const n = Math.max(0, Number(attachCount) || 0);
    if(!text || n <= 0) return [];
    let t = String(text);
    t = t.replace(/参考\s*图\s*([一二三四五六七八九十两\d]+)/g, (m, x) => '图' + (agentCnNumToInt(x) || x));
    t = t.replace(/图\s*([一二三四五六七八九十两])/g, (m, cn) => '图' + agentCnNumToInt(cn));
    const out = [];
    const seen = new Set();
    const push = (num) => {
        const idx = Number(num) - 1;
        if(idx >= 0 && idx < n && !seen.has(idx)){
            seen.add(idx);
            out.push(idx);
        }
    };
    const rangeRe = /图\s*(\d+)\s*[到至\-~]\s*图?\s*(\d+)/g;
    let m;
    while((m = rangeRe.exec(t)) !== null){
        const lo = Math.min(parseInt(m[1],10), parseInt(m[2],10));
        const hi = Math.max(parseInt(m[1],10), parseInt(m[2],10));
        for(let i = lo; i <= hi; i++) push(i);
    }
    const listRe = /图\s*(\d+)((?:\s*[、,，和与及\/]\s*\d+)*)/g;
    while((m = listRe.exec(t)) !== null){
        push(parseInt(m[1],10));
        if(m[2]){
            const rest = m[2].match(/\d+/g) || [];
            rest.forEach(x => push(parseInt(x,10)));
        }
    }
    return out;
}
function agentLooksLikeStyleChoiceRequest(text){
    const t = String(text || '');
    // 仅“让我选/多种/几个”这类选择意图才拦截成 options；单一风格直出不拦
    return /多种风格|几个风格|不同风格|各种风格|风格让我选|给我.{0,12}风格.{0,8}选|先.{0,8}风格.{0,8}选|自动出.{0,8}风格|出点风格|风格选项|换几种风格|做[成出].{0,6}多种风格|做[成出].{0,6}几个风格/.test(t);
}
function agentDefaultStyleOptions(userText){
    const base = String(userText || '').replace(/多种风格|几个风格|不同风格|各种风格|风格让我选|自动出风格|风格选项/g, '').trim() || '按参考图生成';
    return [
        {label:'极简白底商业摄影', value: base + '；风格：极简白底商业摄影，干净光影，产品居中'},
        {label:'日系清新生活方式', value: base + '；风格：日系清新生活方式，柔光，生活场景'},
        {label:'国潮红金高级感', value: base + '；风格：国潮红金高级感，质感包装，节日氛围'},
        {label:'赛博霓虹科技感', value: base + '；风格：赛博霓虹科技感，暗色背景，硬核光效'}
    ];
}
function agentParseMultiAttachmentClauses(text, attachCount){
    const n = Math.max(0, Number(attachCount) || 0);
    if(!text || n <= 0) return [];
    const raw = String(text);
    const parts = raw
        .split(/(?:然后|再(?:用|把|将|做|生成|制作)?|接着|并且|同时|另外|之后)/)
        .map(s => s.trim())
        .filter(Boolean);
    const clauses = [];
    for(const part of parts){
        const idxs = agentExtractAttachmentIndicesFromText(part, n);
        if(!idxs.length) continue;
        clauses.push({
            prompt: part,
            attachment_indices: idxs,
            use_attachments: true,
            count: 1
        });
    }
    if(clauses.length < 2) return [];
    const uniq = new Set(clauses.map(c => c.attachment_indices.join(',')));
    if(uniq.size < 2) return [];
    return clauses;
}

function agentLooksLikePerReferenceEdit(text, attachCount){
    const t = String(text || '');
    const n = Math.max(0, Number(attachCount) || 0);
    if(n < 2) return false;
    // 分别/各自/每张/两张都... / 多个“变成X”
    if(/(分别|各自|逐一|逐个|每张|各出|各改|各变成|分别改成|分别变成|分别做成)/.test(t)) return true;
    if(/(这两|这两张|这两个|这几张|这几个|全部|两只|两张|两个|几只|几张).{0,16}(分别|都|各自|改成|变成|换成)/.test(t)) return true;
    if(/(都改成|都变成|都换成|全部改成|全部变成)/.test(t)) return true;
    // 句式：变成白猫，变成蓝猫（多个改图目标）
    const targets = t.match(/变成[^，,。；;\n]{1,12}/g) || [];
    if(targets.length >= 2) return true;
    const targets2 = t.match(/改成[^，,。；;\n]{1,12}/g) || [];
    if(targets2.length >= 2) return true;
    // 多个独立改图目标用逗号/顿号并列：白猫，蓝猫 / 白色、蓝色
    if(/(变成|改成|换成).{0,20}[，,、].{0,12}(变成|改成|换成)?/.test(t) && /(变成|改成|换成)/.test(t)){
        const goals = agentSplitTransformTargets(t);
        if(goals.length >= 2) return true;
    }
    return false;
}
function agentSplitTransformTargets(text){
    const t = String(text || '').trim();
    if(!t) return [];
    // 提取多个“变成X/改成X”
    const parts = [];
    const re = /(变成|改成|换成|转为|变成了|修改为|调整为)\s*([^，,。；;\n]+)/g;
    let m;
    while((m = re.exec(t)) !== null){
        const goal = String(m[2] || '').trim().replace(/[。！!？?]+$/, '');
        if(goal) parts.push({verb:m[1], goal, raw:m[0]});
    }
    return parts;
}
function agentBuildPerReferenceEditPrompt(userText, attIndex, attachCount, targetGoal=''){
    // 独立生图任务：每一步只连自己那一张参考图（attachment_indices 由执行层处理）
    // 提示词必须是纯净视觉描述，不要写“严格参考第2张/全局图序”这类执行层话术
    const base = String(userText || '').trim();
    const goal = String(targetGoal || '').trim()
        .replace(/[。！!？?]+$/, '')
        .trim();
    if(goal){
        // 目标若只是颜色词，补成自然描述
        const goalText = /猫|狗|人|产品|主体|包装|角色/.test(goal) ? goal : `${goal}主体`;
        return `保持参考主体的姿态、构图、表情与插画风格不变，仅将主体改为${goalText}。干净背景，高质量，细节清晰。`;
    }
    let shared = base
        .replace(/这两只|这两张|这两个|这几张|这几个|全部|分别|各自|逐一|逐个|每张/g, '')
        .replace(/严格参考[^，。；;\n]*/g, '')
        .replace(/参考图\s*[一二三四五六七八九十两\d]+/g, '')
        .replace(/第\s*[一二三四五六七八九十两\d]+\s*张参考图/g, '')
        .replace(/图\s*[一二三四五六七八九十两\d]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    shared = shared || '按要求修改主体';
    return `保持参考主体的姿态、构图、表情与插画风格不变。按以下要求修改：${shared}。干净背景，高质量，细节清晰。`;
}
function agentNormalizeIndependentStepPrompt(prompt=''){
    // 独立单参考图步骤：去掉全局图序话术，统一成“本步参考主体”
    let p = String(prompt || '');
    if(!p) return p;
    p = p
        .replace(/请?严格参考第\s*[1-9]\d*\s*张参考图(?:中的主体)?[，,、]*/g, '保持参考主体')
        .replace(/严格参考第\s*[1-9]\d*\s*张参考图(?:中的主体)?/g, '保持参考主体')
        .replace(/参考第\s*[1-9]\d*\s*张参考图(?:中的主体)?/g, '参考主体')
        .replace(/第\s*[1-9]\d*\s*张参考图(?:中的主体)?/g, '参考主体')
        .replace(/参考图\s*#?\s*[1-9]\d*/g, '参考主体')
        .replace(/参考图#?1\s*[,，]\s*2(?:\s*[,，]\s*\d+)*/g, '参考主体')
        .replace(/严格参考第二张参考图[^\n。；;]*/g, '保持参考主体')
        .replace(/严格参考第[二三四五六七八九十两\d]+张参考图[^\n。；;]*/g, '保持参考主体')
        .replace(/保持参考主体中的主体/g, '保持参考主体')
        .replace(/保持参考主体，保持其/g, '保持参考主体的')
        .replace(/\s+/g, ' ')
        .trim();
    return p;
}
function agentExpandPerReferenceGenerations(gens, userText, attachCount){
    const n = Math.max(0, Number(attachCount) || 0);
    if(!Array.isArray(gens) || n < 2) return gens;
    if(!agentLooksLikePerReferenceEdit(userText, n)) return gens;

    const targets = agentSplitTransformTargets(userText);
    // 情况 A：多个不同目标（变成白猫，变成蓝猫）且数量与参考图匹配或接近
    if(targets.length >= 2){
        const count = Math.min(n, targets.length);
        // 若当前 gens 已是 count 且每步已有单索引，则只校正
        const alreadySplit = gens.length === count && gens.every((g, i) => Array.isArray(g.attachment_indices) && g.attachment_indices.length === 1);
        if(alreadySplit){
            gens.forEach((g, i) => {
                g.use_attachments = true;
                g.attachment_indices = [i];
                g.count = 1;
                g.depends_on_previous = false;
                g.dependency_mode = 'none';
                // 独立任务：始终按本步目标重写为“第1张参考图”视角
                g.prompt = agentBuildPerReferenceEditPrompt(userText, i, n, targets[i].goal);
                g.title = g.title || targets[i].goal;
            });
            return gens;
        }
        const base = gens[0] || {};
        const expanded = [];
        for(let i=0;i<count;i++){
            expanded.push({
                ...base,
                id: base.id ? `${base.id}_ref${i+1}` : `edit_ref_${i+1}`,
                title: targets[i].goal || `参考图${i+1}`,
                role: 'edit',
                prompt: agentBuildPerReferenceEditPrompt(userText, i, n, targets[i].goal),
                count: 1,
                use_attachments: true,
                attachment_indices: [i],
                depends_on_previous: false,
                dependency_mode: 'none',
                use_last_outputs: false,
                results: [],
                status: 'running'
            });
        }
        gens.splice(0, gens.length, ...expanded);
        return gens;
    }

    // 情况 B：同一目标分别应用到每张参考图（两只黑猫分别改成白色）
    // 即使 LLM 只返回 1 步并挂全部参考图，也强制拆成 N 步
    const needExpand = gens.length === 1 || gens.some(g => Array.isArray(g.attachment_indices) && g.attachment_indices.length > 1) || gens.length < n;
    if(!needExpand && gens.length === n){
        gens.forEach((g, i) => {
            g.use_attachments = true;
            g.attachment_indices = [i];
            g.count = 1;
            g.depends_on_previous = false;
            g.dependency_mode = 'none';
        });
        return gens;
    }
    const base = gens[0] || {};
    const sharedGoal = targets[0]?.goal || '';
    const expanded = [];
    for(let i=0;i<n;i++){
        expanded.push({
            ...base,
            id: base.id ? `${base.id}_ref${i+1}` : `edit_ref_${i+1}`,
            title: sharedGoal ? `${sharedGoal}·参考图${i+1}` : `参考图${i+1}`,
            role: 'edit',
            prompt: agentBuildPerReferenceEditPrompt(userText, i, n, sharedGoal),
            count: 1,
            use_attachments: true,
            attachment_indices: [i],
            depends_on_previous: false,
            dependency_mode: 'none',
            use_last_outputs: false,
            results: [],
            status: 'running'
        });
    }
    gens.splice(0, gens.length, ...expanded);
    return gens;
}

function agentEnsureGenerationAttachmentIndices(gens, userText, attachCount){
    if(!Array.isArray(gens) || !gens.length) return gens;
    const n = Math.max(0, Number(attachCount) || 0);
    if(n <= 0) return gens;
    // 分别/各自/多目标改图：先按参考图拆步，避免“多张参考图并成一步”
    agentExpandPerReferenceGenerations(gens, userText, n);
    const clauseTasks = agentParseMultiAttachmentClauses(userText, n);
    if(clauseTasks.length >= 2){
        if(gens.length === clauseTasks.length){
            gens.forEach((g, i) => {
                const task = clauseTasks[i];
                g.use_attachments = true;
                g.attachment_indices = task.attachment_indices.slice();
                if(!String(g.prompt||'').trim()) g.prompt = task.prompt;
            });
        } else if(gens.length === 1 && clauseTasks.length > 1){
            const base = gens[0];
            const expanded = clauseTasks.map((task) => ({
                ...base,
                prompt: String(base.prompt || task.prompt || userText),
                count: 1,
                use_attachments: true,
                attachment_indices: task.attachment_indices.slice(),
                depends_on_previous: false,
                dependency_mode: 'none',
                results: [],
                status: 'running'
            }));
            gens.splice(0, gens.length, ...expanded);
        } else {
            gens.forEach((g, i) => {
                if(Array.isArray(g.attachment_indices) && g.attachment_indices.length) return;
                const fromPrompt = agentExtractAttachmentIndicesFromText(g.prompt, n);
                if(fromPrompt.length){
                    g.use_attachments = true;
                    g.attachment_indices = fromPrompt;
                    return;
                }
                if(clauseTasks[i]){
                    g.use_attachments = true;
                    g.attachment_indices = clauseTasks[i].attachment_indices.slice();
                }
            });
        }
        return gens;
    }
    gens.forEach(g => {
        if(Array.isArray(g.attachment_indices) && g.attachment_indices.length){
            g.use_attachments = true;
            return;
        }
        const fromPrompt = agentExtractAttachmentIndicesFromText(g.prompt, n);
        const fromUser = agentExtractAttachmentIndicesFromText(userText, n);
        let idxs = fromPrompt.length ? fromPrompt : fromUser;
        // 改图/锚定类需求但未写编号时：
        // - 分别/各自：不要挂全部，留给拆步逻辑（每步单图）
        // - 普通改图：默认挂全部参考图
        if(!idxs.length && n > 0){
            const t = `${userText || ''}
${g.prompt || ''}`;
            if(agentLooksLikePerReferenceEdit(userText, n)){
                // 若仍未拆开且只有一步，至少不要误把全部图塞进单步融合；交给 expand
            }else if(/(变成|改为|改成|换成|替换|参考|保持|这个|这些|那只|这只|主体|产品|人物|猫|狗)/.test(t) || g.role === 'edit' || g.use_last_outputs){
                idxs = Array.from({length:n}, (_, i) => i);
            }
        }
        if(idxs.length){
            g.use_attachments = true;
            g.attachment_indices = idxs;
        }
    });
    return gens;
}
function agentLooksLikeLargeSeriesRequest(text){
    const t = String(text || '');
    return /(主图|详情页|详情|套图|包装|三视图).{0,12}(主图|详情页|详情|套图)/.test(t)
        || /(五张|5张|八张|8张|多张).{0,8}(主图|详情)/.test(t)
        || /(主图).{0,12}(详情)/.test(t);
}
function agentApplyComplexRequestGuards(parsed, userText, attachments){
    if(!parsed || typeof parsed !== 'object') return parsed;
    if(!Array.isArray(parsed.options)) parsed.options = [];
    if(!Array.isArray(parsed.generations)) parsed.generations = [];
    if(!Array.isArray(parsed.prompts)) parsed.prompts = [];
    const attachCount = Array.isArray(attachments) ? attachments.filter(x => x?.url).length : Number(attachments) || 0;

    if(agentLooksLikeStyleChoiceRequest(userText)){
        if(parsed.options.length){
            parsed.generations = [];
        } else if(!parsed.generations.length){
            parsed.options = agentDefaultStyleOptions(userText);
            parsed.reply = parsed.reply || '我先给你几种风格方向，选一个我再按参考图出图。';
        }
    }

    if(parsed.generations.length){
        agentEnsureGenerationAttachmentIndices(parsed.generations, userText, attachCount);
    } else if(attachCount >= 2 && agentLooksLikePerReferenceEdit(userText, attachCount)){
        // LLM 没给 generations 时，也按“分别改图”兜底拆步
        parsed.generations = [{}];
        agentExpandPerReferenceGenerations(parsed.generations, userText, attachCount);
        agentEnsureGenerationAttachmentIndices(parsed.generations, userText, attachCount);
        if(!parsed.reply) parsed.reply = `将按 ${attachCount} 张参考图分别生成对应结果。`;
    }

    // 执行前再兜底一次分别改图拆步（防止 LLM 只返回 1 步挂多图）
    if(parsed.generations.length){
        agentExpandPerReferenceGenerations(parsed.generations, userText, attachCount);
    }
    agentCollapseSimpleSingleShot(parsed, userText);
    return parsed;
}

// 从用户口语中提取“期望步骤结构”（通用解析，不是某个品类工作流）
function agentIsImageOnlyUserInput(text='', attachments=[]){
    const hasImg = Array.isArray(attachments) && attachments.some(a => a?.url);
    if(!hasImg) return false;
    const t = String(text || '')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/\u00a0/g, ' ')
        .trim();
    // 只要有明确生图/改图意图，就不算“只发图”
    if(agentLooksLikeClearGenRequest(t)) return false;
    if(!t) return true;
    if(/^(请帮我编辑这些图片|please help me edit these images|\.+|。+|！+|!+|？+|\?+|啊+|嗯+|哈+)$/i.test(t)) return true;
    const stripped = t
        .replace(/参考图\s*[#]?\s*\d+/g, ' ')
        .replace(/图\s*[一二三四五六七八九十\d]+/g, ' ')
        .replace(/[\[\]【】()（）:,：，。.\s]+/g, '')
        .trim();
    if(!stripped) return true;
    if(/(生成|改|换|做|画|转|变|融合|合成|详情|主图|表情|风格|背景|姿势|白底|三视图|套图|系列|请|帮|要|希望|变成|改成|换成|故事|分镜)/.test(t)) return false;
    if(stripped.length <= 2) return true;
    return false;
}
function agentLooksLikeClearGenRequest(text=''){
    const t = String(text || '').trim();
    if(!t) return false;
    // 明确生图/改图/融合/故事指令
    if(/(生成|画|做|制作|创作|出|来)\s*(?:一|两|二|三|四|五|六|七|八|[1-8])?\s*(?:只|张|个|幅|条|名)?/.test(t)) return true;
    if(/(改成|变成|换成|修改|融合|合成|组合|拼|故事|分镜|表情包|主图|详情|套图|换背景|改风格)/.test(t)) return true;
    // “一只猫/一条狗”这类主体+量词，也视为可直接执行
    if(/(?:一|两|二|三|[1-3])\s*(?:只|张|个|条|名|位)\s*[\u4e00-\u9fffA-Za-z]{1,12}/.test(t)) return true;
    return false;
}
function agentHasSkillTaskContent(skills=[]){
    return Array.isArray(skills) && skills.some(skill => String(skill?.content || '').trim());
}
function agentShouldAskForImageOnly(text='', attachments=[], skills=[]){
    // Skill 就是用户预设好的任务要求；图片 + Skill 不属于“只发图片”。
    return agentIsImageOnlyUserInput(text, attachments) && !agentHasSkillTaskContent(skills);
}
function agentPromptLooksLikeQuestion(prompt=''){
    const p = String(prompt || '').trim();
    if(!p) return true;
    if(/您想|你想|可以提供|选择以下|请问|还需要|补充|具体特征|告诉我|怎么处理|想对/.test(p)) return true;
    if(/[？?]\s*$/.test(p) && p.length < 80) return true;
    return false;
}
function agentBuildDirectGenPromptFromUser(userText=''){
    const t = String(userText || '').trim();
    if(!t) return '一只可爱的猫咪，居中构图，干净背景，高质量，细节清晰。';
    // 去掉口语指令壳，保留主体
    let core = t
        .replace(/^(?:请|帮我|给我|麻烦)?(?:生成|画|做|制作|创作|出|来)\s*/,'')
        .replace(/^(?:一|两|二|三|[1-8])\s*(?:张|幅)\s*/,'')
        .trim() || t;
    if(core.length < 4) core = t;
    return `${core}，画面完整，主体清晰居中，干净背景，光影自然，高质量，细节清晰。`;
}

function agentDefaultImageOnlyAsk(attachCount=1){
    const n = Math.max(1, Number(attachCount) || 1);
    const reply = n > 1
        ? `已收到你上传的 ${n} 张参考图。你还没有说明具体要求，想让我怎么处理它们？`
        : '已收到你上传的参考图。你还没有说明具体要求，想让我怎么处理这张图？';
    const options = [
        {label:'改风格', value:'基于参考图改成另一种风格，保持主体可识别'},
        {label:'改表情/姿势', value:'基于参考图修改表情或姿势，保持人物一致'},
        {label:'做表情包', value:'基于参考图生成一组表情包'},
        {label:'电商主图', value:'基于参考图制作电商主图'},
        {label:'换背景', value:'保持主体不变，替换背景'},
        {label:'自定义说明', value:'CUSTOM_INPUT'}
    ];
    return {reply, options, prompts:[], generations:[], shared_style:''};
}

function agentLooksLikeSimpleSingleShot(userText=''){
    const t = String(userText || '').trim();
    if(!t) return false;
    if(agentLooksLikePerReferenceEdit(t, 99)) return false;
    if(agentLooksLikeLargeSeriesRequest(t) || agentLooksLikeSeriesPrompt(t)) return false;
    if(/先.{0,30}(?:再|然后)|然后|接着|之后再|分步|单独生成|各自|分别|融合|组合|套图|系列|主图|详情|变体|几种|多种|不同/.test(t)) return false;
    const n = chatRequestedImageCount(t);
    if(n > 1) return false;
    return true;
}
// 简单单图需求：压成 1 步 1 张，避免 LLM 误拆成两套并行工作流
function agentCollapseSimpleSingleShot(parsed, userText){
    if(!parsed || !Array.isArray(parsed.generations) || parsed.generations.length <= 1) return parsed;
    if(!agentLooksLikeSimpleSingleShot(userText)) return parsed;
    const first = {...parsed.generations[0]};
    first.count = 1;
    first.depends_on_previous = false;
    first.use_previous_results = false;
    first.use_last_outputs = false;
    first.dependency_mode = 'none';
    parsed.generations = [first];
    return parsed;
}

function agentExpectedSeriesSteps(userText=''){
    const t = String(userText || '');
    const toNum = (raw) => {
        if(raw == null) return 0;
        const s = String(raw);
        if(/^\d+$/.test(s)) return parseInt(s, 10);
        return agentCnNumToInt(s);
    };
    const mainMatch = t.match(/([1-9]\d?|[一二三四五六七八九十两])\s*张?主图/);
    const detailMatch = t.match(/([1-9]\d?|[一二三四五六七八九十两])\s*张?详情(?:页|图)?/);
    const whiteMatch = /(白底|三视图|产品定稿|包装定稿|先生成[^，。]{0,20}?(?:白底|三视图|包装))/.test(t);
    const mainCount = mainMatch ? toNum(mainMatch[1]) : 0;
    const detailCount = detailMatch ? toNum(detailMatch[1]) : 0;
    let productCount = whiteMatch ? 1 : 0;
    // “先生成一个X，再...” 也算产品锚点
    if(!productCount && /先(?:生成|做|出).{0,20}?(?:再|然后)/.test(t) && (mainCount || detailCount)) productCount = 1;
    const total = productCount + mainCount + detailCount;
    let mainRatio = '';
    let detailRatio = '';
    if(/主图[^。；;]{0,12}?1\s*:\s*1|1\s*:\s*1[^。；;]{0,12}?主图/.test(t)) mainRatio = '1:1';
    if(/详情[^。；;]{0,12}?9\s*:\s*16|9\s*:\s*16[^。；;]{0,12}?详情/.test(t)) detailRatio = '9:16';
    let resolution = '';
    if(/4\s*[kK]|4K/.test(t)) resolution = '4k';
    else if(/2\s*[kK]|2K/.test(t)) resolution = '2k';
    else if(/1\s*[kK]|1K/.test(t)) resolution = '1k';
    return {productCount, mainCount, detailCount, total, mainRatio, detailRatio, resolution};
}

// 通用计划补齐：当用户口语明确了多步结构，但 LLM 只返回 1 步时，展开成多步计划再交给执行层
// 注意：这里不做“猫粮详情页专用工作流”，只根据口语数量/顺序补 steps。

function agentLooksLikeEditLastResult(userText=''){
    const t = String(userText || '').trim();
    if(!t) return false;
    // 明确指向上一轮结果/原图
    if(/(上一张|上图|刚才(?:那|的)?|刚刚(?:那|的)?|这张图|那张图|原图|继续改|在此基础上|基于上|参考上|沿用上|保持上)/.test(t)) return true;
    // 明确修改动词（不含过宽的“变成/转为”，避免“生成变成…/表情变成…”误伤）
    if(/(改成|换成|转换成|修改为|改为|转成|调整为|修改成|变回|调成|重新画|重画|修改一下|改一下|调整一下|重新生成)/.test(t)) return true;
    // “变成/转为”只有在不是全新文生图套装时才视为改图
    if(/(变成|转为)/.test(t) && !/(生成|画一|做一|制作|出一|表情包|主图|详情|套图|系列|分镜)/.test(t)) return true;
    return false;
}
// 图片分析/提示词反推是独立意图：只分析本轮明确提供的图片，不进入生图规划。
function agentLooksLikeImageAnalysisRequest(userText=''){
    const t = String(userText || '').trim().toLowerCase();
    if(!t) return false;
    return /(?:\u53cd\u63a8|\u63d0\u53d6|\u5206\u6790|\u89e3\u6790|\u603b\u7ed3)[^\n]{0,24}(?:\u56fe\u7247|\u56fe|\u63d0\u793a\u8bcd|\u6784\u56fe|\u8272\u8c03|\u98ce\u683c)|(?:reverse|extract|analy[sz]e|describe)[^\n]{0,40}(?:prompt|image|composition|color|style)/i.test(t);
}
async function agentRunImageAnalysisStage({conversationId='', userMsg=null, text='', attachments=[]}={}){
    const ownerConversationId = String(conversationId || userMsg?.conversationId || agentState?.activeConversationId || '').trim();
    const imageUrls = (attachments || []).map(item => item?.url).filter(Boolean).slice(0, AGENT_LLM_IMAGE_MAX);
    if(!imageUrls.length) return false;
    const requestedSettings = userMsg?.requestedSettings || {};
    const provider = resolveChatProviderId(requestedSettings.chatProvider || agentState.chatProvider);
    const model = resolveChatModel(requestedSettings.chatModel || agentState.chatModel, provider);
    agentPatchConversationWorkflow(ownerConversationId, workflow => { workflow.status = 'analyzing'; workflow.updatedAt = Date.now(); });
    const systemPrompt = [
        '你是图片分析与提示词反推助手，不是生图规划器。',
        '只分析用户本轮明确提供的图片，不读取历史消息、画布节点或历史生成结果。',
        '用户要求反推提示词时，请输出：主体与细节、构图与镜头、光线、色调、材质、风格，以及一条纯净可直接使用的提示词。',
        '不要生成图片，不要规划张数，不要输出 generations、plan、attachment_indices，不要虚构第二张或更多参考图。',
        '使用中文自然语言回答。'
    ].join('\\n');
    const result = await agentCreateAndWaitLlmTask({
        message: String(text || userMsg?.text || '').trim(),
        messages: [],
        images: imageUrls,
        videos: [],
        model,
        provider,
        ms_model: provider === 'modelscope' ? model : '',
        system_prompt: systemPrompt
    }, {stream:true, conversationId:ownerConversationId, requestId:userMsg?._pendingRequestId || ''});
    const answer = String(result?.text || result?.content || '').trim();
    if(!answer) throw new Error('图片分析未返回内容');
    const assistantMsg = {
        id:uid('am'), role:'assistant', text:answer, analysis:answer, stage:'analyze_image',
        generations:[], prompts:[], options:[], contextSources:{conversationId:ownerConversationId, historyCount:0, canvasSnapshotId:'', imageCount:imageUrls.length},
        inputRefs:(attachments || []).filter(item => item?.url).map(item => ({url:item.url, name:item.name || 'image', kind:item.kind || 'image'})),
        ts:Date.now(), conversationId:ownerConversationId
    };
    agentPushMessageToConversation(ownerConversationId, assistantMsg);
    agentPatchConversationWorkflow(ownerConversationId, workflow => { workflow.status = 'completed'; workflow.error = ''; workflow.updatedAt = Date.now(); });
    if(agentIsActiveConversation(ownerConversationId)){ agentSending=false; agentThinking=false; agentThinkingStage=''; renderAgentMessages(); }
    saveAgentState(true);
    return true;
}
function agentHasActiveSkills(skills){
    // 显式传入数组时（含空数组）以参数为准，避免空 skill 被 agentState 旧值污染
    if(Array.isArray(skills)) return skills.length > 0;
    try{
        return !!(typeof agentState !== 'undefined' && Array.isArray(agentState?.skills) && agentState.skills.length);
    }catch(_){
        return false;
    }
}
function agentLooksLikeExplicitFusion(userText=''){
    return agentHasPositiveFusionIntent(userText);
}
function agentLooksLikeExplicitSeriesOrFusion(userText=''){
    const t = String(userText || '');
    const explicitSeries = /详情页|主图|套图|系列|整套|多页|电商详情|产品页|包装|三视图|定稿|一致性|统一文字|统一配色|品牌设定|产品一致性|连续|分镜/.test(t);
    return explicitSeries || agentLooksLikeExplicitFusion(t);
}
// 只有用户明确说“先产品定稿/白底/三视图，再主图详情”时，才允许把前序生成图当垫图
function agentLooksLikeExplicitProductDraftChain(userText=''){
    const t = String(userText || '');
    if(!t) return false;
    // 先出产品定稿/三视图，再替换/重做主图详情
    if(/(先.{0,16}(三视图|白底图|包装图|定稿|产品图).{0,40}(再|然后|之后|并).{0,40}(替换|重做|修改|更新|套用))/.test(t)) return true;
    if(/(生成|先出|先做|再生成).{0,16}(三视图|白底图|包装图|定稿).{0,40}(再|然后|之后|并|把).{0,40}(替换|重做|主图|详情)/.test(t)) return true;
    if(/(把|用|以).{0,12}(三视图|产品定稿|定稿|白底图).{0,20}(替换|重做|作为参考|作为垫图).{0,24}(主图|详情|产品|刚刚|之前|五张|几张)/.test(t)) return true;
    if(/(三视图|白底图).{0,24}(替换).{0,24}(主图|产品)/.test(t)) return true;
    return false;
}
function agentInferAttachmentRoles(attachments=[], userText='', skills=[]){
    const list = Array.isArray(attachments) ? attachments.filter(a => a && a.url) : [];
    const n = list.length;
    const roles = Array.from({length:n}, () => 'reference');
    if(!n) return roles;
    const utext = String(userText || '');
    const hasSkill = agentHasActiveSkills(skills);
    const cnList = ['一','二','三','四','五','六','七','八','九','十'];
    const mapNum = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
    const toIdx = (tok) => (mapNum[tok] || Number(tok) || 0) - 1;
    const localPhrase = (idx) => {
        const n1 = idx + 1;
        const cn = cnList[idx] || String(n1);
        const re = new RegExp('(?:参考图|图)\\s*(?:' + n1 + '|' + cn + ')([^。；;\\n]{0,30})', 'g');
        let m, parts = [];
        while((m = re.exec(utext))){
            let seg = String(m[1] || '');
            seg = seg.split(/(?:参考图|图)\s*[0-9一二三四五六七八九十]+/)[0] || seg;
            // 避免“参考图1...风格看参考图2”把图1吞进风格词
            seg = seg.split(/风格\s*(?:看|参考|是|为)/)[0] || seg;
            seg = seg.split(/，\s*(?:再|然后|之后)/)[0] || seg;
            parts.push(seg);
        }
        return parts.join(' ');
    };
    for(let i=0;i<n;i++){
        const seg = localPhrase(i);
        const prodScore = /(?:产品图|产品实拍|实拍图|包装图|正面|侧面|背面|细节|产品|包装|白底|三视图|实物)/.test(seg) ? 2 : 0;
        const styleScore = /(?:风格参考图|参考风格|风格图|风格|版式|排版|色调)/.test(seg) ? 3 : 0;
        if(prodScore || styleScore){
            if(styleScore > prodScore) roles[i] = 'style';
            else if(prodScore > styleScore) roles[i] = 'product';
            else roles[i] = styleScore ? 'style' : 'product';
        }
    }
    const bindBefore = (roleRe, roleName) => {
        const re = new RegExp(roleRe.source + '\\s*(?:是|为|用|看)?\\s*(?:参考图|图)\\s*([0-9一二三四五六七八九十]+)', 'g');
        let m;
        while((m = re.exec(utext))){
            const idx = toIdx(m[1]);
            if(idx >= 0 && idx < n){
                if(roleName === 'product') roles[idx] = 'product';
                else if(roles[idx] !== 'product') roles[idx] = 'style';
            }
        }
    };
    bindBefore(/(?:产品图|产品实拍|实拍图|包装图|产品|包装|白底|三视图|实物)/, 'product');
    bindBefore(/(?:风格参考图|参考风格|风格图|风格)/, 'style');
    const multiProduct = utext.match(/参考图\s*([0-9一二三四五六七八九十]+)(?:\s*和\s*|、|,|，)\s*参考图\s*([0-9一二三四五六七八九十]+)[^。；;\n]{0,10}(?:产品|实拍|产品实拍|产品图)/);
    if(multiProduct){
        [multiProduct[1], multiProduct[2]].forEach(tok => {
            const idx = toIdx(tok);
            if(idx >= 0 && idx < n) roles[idx] = 'product';
        });
    }
    const multiStyle = utext.match(/(?:参考图|图)\s*([0-9一二三四五六七八九十]+)(?:\s*和\s*|、|,|，)\s*(?:参考图|图)?\s*([0-9一二三四五六七八九十]+)[^。；;\n]{0,20}(?:都是)?\s*(?:风格参考|参考风格|风格图|风格)/);
    if(multiStyle){
        [multiStyle[1], multiStyle[2]].forEach(tok => {
            const idx = toIdx(tok);
            if(idx >= 0 && idx < n && roles[idx] !== 'product') roles[idx] = 'style';
        });
    }
    if(/(?:参考图|图).{0,24}都是(?:风格参考|参考风格|风格)/.test(utext) && !/(产品|实拍|包装|白底|三视图)/.test(utext)){
        for(let i=0;i<n;i++){ if(roles[i] !== 'product') roles[i] = 'style'; }
    }
    const styleAssign = utext.matchAll(/(?:参考图|图)\s*([0-9一二三四五六七八九十]+)(?:的|是|为)?[^。；;\n参考图]{0,6}风格/g);
    for(const m of styleAssign){
        const idx = toIdx(m[1]);
        if(idx >= 0 && idx < n && roles[idx] !== 'product') roles[idx] = 'style';
    }
    if(!roles.includes('product') && /(?:这是一款|这是我的|这是|本品是|产品是).{0,20}产品|(?:产品图|产品实拍|三视图|白底图)/.test(utext)){
        if(roles[0] === 'reference' || roles[0] === 'product') roles[0] = 'product';
        else {
            const j = roles.findIndex(r => r === 'reference');
            if(j >= 0) roles[j] = 'product';
        }
    }
    const allProduct = /(?:这两张|这几张|全部|所有|都)\s*(?:都是)?\s*(?:产品|实拍|产品实拍|产品图)|两张产品|多张产品/.test(utext)
        && !/(风格|版式|参考风格)/.test(utext);
    if(allProduct){
        for(let i=0;i<n;i++) roles[i] = 'product';
    }
    for(let i=0;i<n;i++){
        const seg = localPhrase(i);
        if(/(?:不要用|别用|忽略|竞品)/.test(seg)) roles[i] = 'reference';
    }
    // 显式“参考图N...产品/白底/定稿”优先于误伤的风格标记
    for(let i=0;i<n;i++){
        const seg = localPhrase(i);
        if(/(?:产品|白底|三视图|定稿|实拍|包装)/.test(seg)) roles[i] = 'product';
    }
    // “风格看/参考 参考图N”
    {
        const m = utext.match(/风格\s*(?:看|参考|是|为)\s*(?:参考图|图)\s*([0-9一二三四五六七八九十]+)/);
        if(m){
            const idx = toIdx(m[1]);
            if(idx >= 0 && idx < n && roles[idx] !== 'product') roles[idx] = 'style';
        }
    }
    const hasProduct = roles.some(r => r === 'product');
    const hasStyle = roles.some(r => r === 'style');
    if(hasSkill && n === 2 && !allProduct){
        if(!hasProduct && !hasStyle){
            if(/(产品|包装|白底|三视图)/.test(utext) && /(风格|版式|参考风格)/.test(utext)){
                roles[0] = 'product';
                roles[1] = 'style';
            }else if(!/(产品|风格|实拍|包装|白底)/.test(utext)){
                roles[0] = 'product';
                roles[1] = 'style';
            }else if(/(都是产品|两张都是产品|全部是产品|都是实拍|两张产品|多张产品|产品实拍)/.test(utext) && !/(风格|版式|参考风格)/.test(utext)){
                roles[0] = 'product';
                roles[1] = 'product';
            }else{
                roles[0] = roles[0] === 'style' ? 'style' : 'product';
                roles[1] = roles[1] === 'product' ? 'product' : 'style';
            }
        }else if(hasProduct && !hasStyle && /(风格|版式|参考风格)/.test(utext)){
            for(let i=0;i<n;i++){
                if(roles[i] === 'reference'){ roles[i] = 'style'; break; }
            }
            if(!roles.includes('style') && roles[0] === 'product') roles[1] = 'style';
        }else if(!hasProduct && hasStyle){
            for(let i=0;i<n;i++){
                if(roles[i] === 'reference'){ roles[i] = 'product'; break; }
            }
            if(!roles.includes('product')) roles[0] = 'product';
        }
    }else if(hasSkill && n === 1 && !hasProduct){
        roles[0] = 'product';
    }else if(hasSkill && n > 2 && !hasProduct && !hasStyle){
        roles[0] = 'product';
    }else if(!hasProduct && !hasStyle && n >= 2){
        if(/(产品图|产品|包装|白底|三视图)/.test(utext) && /(风格|版式|参考风格)/.test(utext)){
            roles[0] = 'product';
            roles[1] = 'style';
        }else if(/(风格|版式|参考风格)/.test(utext) && !/(产品|实拍|包装|白底|三视图)/.test(utext)){
            for(let i=0;i<n;i++) roles[i] = 'style';
        }
    }
    return roles;
}
function agentAttachmentRoleLabel(role='', index=0){
    const r = String(role || '').toLowerCase();
    if(r === 'product') return '产品图';
    if(r === 'style') return '风格参考图';
    return '参考图';
}
// Skill 多页/主图详情：用户已给产品图/风格图时，默认每步都挂用户参考图，禁止把第1张生成图当垫图
function agentShouldKeepUserAttachmentsForSeries(userText='', attachments=[], skills=[]){
    const attachCount = Array.isArray(attachments) ? attachments.filter(a => a && a.url).length : 0;
    if(attachCount <= 0) return false;
    if(agentLooksLikeExplicitProductDraftChain(userText)) return false;
    if(agentLooksLikeExplicitFusion(userText)) return false;
    if(agentHasActiveSkills(skills)) return true;
    if(attachCount >= 2 && /主图|详情|套图|系列|整套|多页|电商/.test(String(userText||''))) return true;
    return false;
}
function agentAnnotatePromptWithAttachmentRoles(prompt='', attachments=[], userText='', skills=[], attachmentIndices=null){
    // 生图环节提示词：只认当前步骤连线顺序的 图一/图二...
    // 不写“上传的产品图/上传的参考图/参考图1=产品图”这类规划层用语
    let p = String(prompt || '').trim();
    if(!p) return p;
    const list = (attachments || []).filter(a => a && a.url);
    const idxs = Array.isArray(attachmentIndices) && attachmentIndices.length
        ? attachmentIndices.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n < list.length)
        : list.map((_, i) => i);
    if(!idxs.length) return p;

    const mapCn = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
    const toCn = {1:'一',2:'二',3:'三',4:'四',5:'五',6:'六',7:'七',8:'八',9:'九',10:'十'};
    const parseNum = (raw) => {
        const s = String(raw || '');
        if(/^\d+$/.test(s)) return Number(s);
        return mapCn[s] || 0;
    };
    const globalToLocal = new Map();
    idxs.forEach((globalIdx, localPos) => {
        globalToLocal.set(globalIdx + 1, localPos + 1);
    });
    const localLabel = (n) => '图' + (toCn[n] || String(n));

    // 1) 先把全局“参考图N”映射为本步连线序号“图一/图二”
    p = p.replace(/参考图\s*([0-9一二三四五六七八九十]+)/g, (m, raw) => {
        const n = parseNum(raw);
        if(!n) return m;
        const local = globalToLocal.get(n);
        return local ? localLabel(local) : m;
    });

    // 2) 清理规划层脏词（上传的/产品三视图/风格参考图等）
    p = p
        .replace(/严格保持上传产品三视图中的/g, '严格保持图一中的')
        .replace(/上传的产品三视图/g, '图一')
        .replace(/上传产品三视图/g, '图一')
        .replace(/上传的产品图/g, '图一')
        .replace(/上传产品图/g, '图一')
        .replace(/上传的参考图/g, '参考图')
        .replace(/上传参考图/g, '参考图')
        .replace(/产品三视图中的/g, '图一中的')
        .replace(/产品三视图/g, '图一')
        .replace(/深度参考参考风格图/g, '深度参考图二')
        .replace(/深度参考风格参考图/g, '深度参考图二')
        .replace(/深度参考风格图/g, '深度参考图二')
        .replace(/参考风格图/g, '图二')
        .replace(/风格参考图/g, '图二');

    // 3) 若仍残留“图N”且 N 是全局编号，再映射到本步局部序号
    p = p.replace(/(^|[^参])图\s*([0-9一二三四五六七八九十]+)/g, (m, pre, raw) => {
        const n = parseNum(raw);
        if(!n) return m;
        const local = globalToLocal.get(n);
        if(!local || local === n) return pre + localLabel(n);
        return pre + localLabel(local);
    });

    // 4) 阿拉伯数字图序转中文
    p = p.replace(/图([1-9]|10)(?!\d)/g, (m, num) => localLabel(Number(num)));

    // 5) 清理“图一（产品图）”这类括号角色说明
    p = p.replace(/图([一二三四五六七八九十0-9]+)\s*[（(][^）)]*[）)]/g, '图$1');

    // 6) 修复“深度图二”被误伤成缺“参考”的情况
    p = p.replace(/深度图([一二三四五六七八九十0-9]+)/g, '深度参考图$1');
    p = p.replace(/严格图([一二三四五六七八九十0-9]+)/g, '严格参考图$1');

    // 7) 若提示词完全没提图序，补一句纯净连线说明
    if(!/图[一二三四五六七八九十0-9]/.test(p)){
        const labels = idxs.map((_, i) => localLabel(i + 1));
        p = `${p}${p ? '。' : ''}严格参考${labels.join('、')}。`.replace(/。。+/g, '。');
    }
    return p.replace(/\s{2,}/g, ' ').trim();
}
function agentSanitizeSkillIndependence(gens, userText='', skills=[], attachments=[]){
    if(!Array.isArray(gens) || !gens.length) return gens;
    const keepUserRefs = agentShouldKeepUserAttachmentsForSeries(userText, attachments, skills);
    const allowPrev = agentLooksLikeExplicitProductDraftChain(userText) || agentLooksLikeExplicitFusion(userText);
    if(!agentHasActiveSkills(skills) && !keepUserRefs) return gens;
    if(allowPrev && !keepUserRefs) return gens;
    gens.forEach(g => {
        if(!g) return;
        const mode = String(g.dependency_mode || '').toLowerCase();
        const prompt = String(g.prompt || '');
        const isFusion = mode === 'fusion' || agentLooksLikeExplicitFusion(prompt);
        if(isFusion && agentLooksLikeExplicitFusion(userText)) return;
        g.depends_on_previous = false;
        g.use_previous_results = false;
        g.use_last_outputs = false;
        if(Array.isArray(g.direct_refs)) g.direct_refs = [];
        if(mode === 'product_reference' || mode === 'fusion' || !mode){
            g.dependency_mode = 'none';
        }
        if(keepUserRefs){
            g.use_attachments = true;
        }
    });
    return gens;
}
// Skill 默认是“风格文档”，不是前序依赖；除非用户明确要求套图一致性/融合
function agentForceNoStaleLastOutputs(gens, userText='', attachments=[]){
    if(!Array.isArray(gens) || !gens.length) return gens;
    const hasAttach = Array.isArray(attachments) && attachments.some(a => a?.url);
    // 产品决策：彻底关闭“默认参考上一轮图”。
    // 只有本轮用户明确提供参考图时才允许参考；同计划内 depends_on_previous 仍由 plan executor 注入前序结果。
    gens.forEach(g => {
        if(!g) return;
        // 同计划内依赖前序成功结果：不走跨轮 lastResults
        if(g.depends_on_previous || g.use_previous_results){
            g.use_last_outputs = false;
            return;
        }
        // 独立步骤：永远不挂历史结果
        g.use_last_outputs = false;
        if(Array.isArray(g.direct_refs)) g.direct_refs = [];
        // 没提供参考图时，强制关掉附件引用，避免 residual 状态误连
        if(!hasAttach){
            g.use_attachments = false;
            if(Array.isArray(g.attachment_indices)) g.attachment_indices = [];
        }
    });
    return gens;
}

function agentEnsurePlanStepsFromUserIntent(assistantMsg, userMsg){
    if(!assistantMsg || !Array.isArray(assistantMsg.generations)) return assistantMsg;
    const userText = String(userMsg?.text || assistantMsg?.userPrompt || '').trim();
    const expected = agentExpectedSeriesSteps(userText);
    let gens = assistantMsg.generations.slice();
    if(!gens.length) return assistantMsg;

    // 多步口语规划：强制每步 count=1
    const multiHint = expected.total > 1 || agentLooksLikeSeriesPrompt(userText) || agentLooksLikeLargeSeriesRequest(userText) || /先.+再|然后|每张|单独生成|分别|不同|几种|多种|变体/.test(userText);
    if(multiHint){
        gens.forEach(g => { g.count = 1; });
    }
    // 分别改图：执行前按参考图拆步（直接改 assistantMsg.generations 原数组）
    try{
        const attachN = Array.isArray(userMsg?.images) ? userMsg.images.filter(x=>x?.url).length : 0;
        if(attachN >= 2){
            agentExpandPerReferenceGenerations(assistantMsg.generations, userText, attachN);
            agentEnsureGenerationAttachmentIndices(assistantMsg.generations, userText, attachN);
            gens = assistantMsg.generations.slice();
        }
    }catch(_){}

    // A) 套图结构：1 步被说成 1+5+8 时展开
    if(gens.length === 1 && expected.total > 1){
        const base = gens[0];
        const basePrompt = String(base.prompt || userText || '').trim();
        const style = String(assistantMsg.shared_style || base.shared_style || '').trim();
        const expanded = [];
        if(expected.productCount){
            expanded.push({
                ...base,
                title: '产品定稿',
                role: 'product_hero',
                prompt: basePrompt,
                count: 1,
                depends_on_previous: false,
                use_previous_results: false,
                use_last_outputs: false,
                use_attachments: true,
                dependency_mode: 'none',
                ratio: expected.mainRatio || base.ratio || '',
                resolution: expected.resolution || base.resolution || '',
                shared_style: style,
                results: [],
                status: 'running'
            });
        }
        for(let i=0;i<expected.mainCount;i++){
            expanded.push({
                ...base,
                title: `主图${i+1}`,
                role: 'main',
                prompt: `${style ? `【统一设定·不可变更】${style}\n` : ''}基于产品定稿与参考模特制作电商主图，突出产品卖点与品牌质感，构图完整，文字清晰可读。保持产品外形、材质、Logo 完全一致。${expected.mainRatio ? `比例${expected.mainRatio}。` : ''}${expected.resolution ? `${expected.resolution.toUpperCase()}画质。` : ''}`,
                count: 1,
                depends_on_previous: true,
                use_previous_results: true,
                use_last_outputs: false,
                use_attachments: true,
                dependency_mode: 'product_reference',
                ratio: expected.mainRatio || '1:1',
                resolution: expected.resolution || base.resolution || '2k',
                shared_style: style,
                results: [],
                status: 'running'
            });
        }
        for(let i=0;i<expected.detailCount;i++){
            expanded.push({
                ...base,
                title: `详情页${i+1}`,
                role: 'detail',
                prompt: `${style ? `【统一设定·不可变更】${style}\n` : ''}基于产品定稿与参考模特制作电商详情页，信息层级清晰，版式自然，文字可读。保持产品外形、材质、Logo 完全一致。${expected.detailRatio ? `比例${expected.detailRatio}。` : ''}${expected.resolution ? `${expected.resolution.toUpperCase()}画质。` : ''}`,
                count: 1,
                depends_on_previous: true,
                use_previous_results: true,
                use_last_outputs: false,
                use_attachments: true,
                dependency_mode: 'product_reference',
                ratio: expected.detailRatio || '9:16',
                resolution: expected.resolution || base.resolution || '2k',
                shared_style: style,
                results: [],
                status: 'running'
            });
        }
        if(expanded.length){
            gens = expanded;
            assistantMsg.plan_incomplete = false;
            assistantMsg.series_expanded = true;
        }
    }

    // B) 通用变体：LLM 只回 1 步但 count>1，且用户要的是“多种不同图/表情/姿势/风格”
    // 这类不应变成一个节点一次出 N 张，而应拆成 N 个独立步骤（count=1）
    if(gens.length === 1){
        const g0 = gens[0];
        const c = Math.max(1, Math.min(8, Number(g0.count) || 1));
        const variantN = agentExtractVariantCount(userText);
        const wantVariants = variantN > 1 || (c > 1 && /不同|分别|几种|多种|变体|表情|姿势|角度|风格/.test(userText));
        const n = Math.max(c, variantN || 0);
        if(wantVariants && n > 1){
            const labels = agentExtractVariantLabels(userText, n);
            const basePrompt = String(g0.prompt || userText || '').trim();
            const style = String(assistantMsg.shared_style || g0.shared_style || '').trim();
            const editLast = agentLooksLikeEditLastResult(userText);
            const hasAttach = Array.isArray(userMsg?.images) && userMsg.images.some(x => x?.url);
            gens = labels.map((label, i) => ({
                ...g0,
                title: label || agentSanitizeStepLabel('', i),
                role: 'variant',
                prompt: agentBuildVariantPrompt(basePrompt, label, i, n, style),
                count: 1,
                depends_on_previous: false,
                use_previous_results: false,
                // 独立变体默认文生图；只有明确“改上一张”才挂历史结果
                use_last_outputs: false /* no stale last outputs */,
                use_attachments: hasAttach ? true : (g0.use_attachments === true),
                dependency_mode: 'none',
                shared_style: style,
                results: [],
                status: 'running'
            }));
            assistantMsg.variant_expanded = true;
            assistantMsg.plan_incomplete = false;
        }
    }

    // 多步时再统一清理 count
    if(gens.length > 1){
        gens.forEach(g => { g.count = 1; });
    }
    // 多步提示词：仅在“几乎相同/含脏词”时重写；且每步用自己的 base，避免猫狗串味
    try{
        const labels = agentExtractVariantLabels(userText + '\n' + String(assistantMsg.text||''), gens.length);
        const wantVariants = agentExtractVariantCount(userText) > 1
            || /不同|分别|几种|多种|变体|表情|姿势|角度|风格|一个表情|一个是|连续|分镜|故事/.test(userText);
        if(wantVariants && gens.length >= 2){
            const norms = gens.map(g => String(g.prompt||'').replace(/\s+/g,' ').trim());
            const subjects = norms.map(s => {
                const m = s.match(/(猫|狗|猪|人|女|男|角色|产品)[^，。；;\s]{0,8}/);
                return m ? m[0] : s.slice(0, 12);
            });
            const subjectDiverse = new Set(subjects.filter(Boolean)).size >= Math.min(2, gens.length);
            const dirty = gens.some(g => /变体\s*\d+|表情为\s*变体|本张差异\s*[：:]|表情为第一张|步骤\s*\d+|独立变体/.test(String(g.prompt||'')) || agentPromptLooksLikeQuestion(g.prompt));
            // 前48字相同可能只是共享风格前缀；若主体/后半段已不同则保留
            const headSame = norms.filter(Boolean).length >= 2 && (new Set(norms.map(s => s.slice(0, 48))).size <= Math.max(1, Math.floor(gens.length/2)));
            const tailDiverse = norms.filter(Boolean).length >= 2 && (new Set(norms.map(s => s.slice(-36))).size >= Math.min(2, gens.length));
            const sameish = headSame && !tailDiverse && !subjectDiverse;
            if((sameish || dirty) && !(!dirty && subjectDiverse)){
                const style = String(assistantMsg.shared_style || gens[0]?.shared_style || '').trim();
                const hasAttach = Array.isArray(userMsg?.images) && userMsg.images.some(x => x?.url);
                const storyLike = /连续|分镜|故事|连环|三格|四格/.test(userText);
                gens = gens.map((g, i) => {
                    const ownBase = String(g.prompt || gens[0]?.prompt || userText || '').trim();
                    const lab = labels[i] || g.title || (storyLike ? `第${i+1}格剧情` : '');
                    let prompt;
                    if(!dirty && !sameish && ownBase && !agentPromptLooksLikeQuestion(ownBase)){
                        prompt = ownBase;
                    }else if(storyLike){
                        prompt = agentBuildStoryFramePrompt(ownBase || userText, lab, i, gens.length, style);
                    }else{
                        // 关键：base 用本步 prompt，不要全用 gens[0]，避免第二步狗被写成猫
                        prompt = agentBuildVariantPrompt(ownBase || userText, lab, i, gens.length, style);
                    }
                    prompt = ensureAgentProfessionalPrompt(prompt, userText);
                    return {
                        ...g,
                        title: lab || agentSanitizeStepLabel(g.title, i),
                        role: g.role || (storyLike ? 'story' : 'variant'),
                        prompt,
                        count: 1,
                        depends_on_previous: false,
                        use_previous_results: false,
                        use_last_outputs: false,
                        use_attachments: hasAttach ? true : (g.use_attachments === true),
                        dependency_mode: 'none',
                        shared_style: style,
                        status: g.status || 'running'
                    };
                });
                assistantMsg.variant_expanded = true;
            }
        }
        // 多步且仍几乎同词：强制差异化（最后兜底）
        if(gens.length >= 2){
            const norms2 = gens.map(g => ensureAgentProfessionalPrompt(g.prompt||'', userText).replace(/\s+/g,' ').trim());
            const tooSame = norms2.filter(Boolean).length >= 2 && new Set(norms2).size === 1;
            if(tooSame){
                const style = String(assistantMsg.shared_style || '').trim();
                const labels2 = agentExtractVariantLabels(userText + '\n' + String(assistantMsg.text||''), gens.length);
                const storyLike = /连续|分镜|故事|连环/.test(userText);
                gens = gens.map((g,i) => {
                    const lab = labels2[i] || g.title || `差异${i+1}`;
                    const p = storyLike
                        ? agentBuildStoryFramePrompt(userText, lab, i, gens.length, style)
                        : agentBuildVariantPrompt(String(g.prompt||userText), lab, i, gens.length, style);
                    return {...g, title: lab, prompt: ensureAgentProfessionalPrompt(p, userText), count:1};
                });
            }
        }
    }catch(_){ }
    try{ agentForceNoStaleLastOutputs(gens, userText, userMsg?.images || []); }catch(_){}
    assistantMsg.generations = gens;
    if((assistantMsg.series_expanded || assistantMsg.variant_expanded) && !String(assistantMsg.text||'').includes('独立步骤后执行') && !String(assistantMsg.text||'').includes('完整规划展开')){
        assistantMsg.text = `${String(assistantMsg.text||'').trim()}\n\n已将口语规划展开为 ${gens.length} 个独立步骤后执行。`.trim();
    }
    return assistantMsg;
}

function agentExtractVariantCount(userText=''){
    const t = String(userText || '');
    const m1 = t.match(/([1-9]\d?|[一二三四五六七八九十两])\s*种/);
    const m2 = t.match(/([1-9]\d?|[一二三四五六七八九十两])\s*个(?:不同|表情|姿势|角度|变体|风格)/);
    const m3 = t.match(/([1-9]\d?|[一二三四五六七八九十两])\s*张(?:不同|分别)?/);
    const toNum = (raw) => {
        if(raw == null) return 0;
        const s = String(raw);
        if(/^\d+$/.test(s)) return parseInt(s, 10);
        return agentCnNumToInt(s);
    };
    return Math.max(toNum(m1 && m1[1]), toNum(m2 && m2[1]), toNum(m3 && m3[1]), 0);
}

function agentExtractVariantLabels(userText='', n=0){
    const t = String(userText || '');
    let labels = [];
    // 1) 一个表情是开心大笑，一个表情是困惑 / 一个是X，一个是Y
    const oneRe = /一个(?:表情|姿势|角度|风格|情绪)?(?:是|为)?\s*([^，,。；;\n]{1,16})/g;
    let mm;
    while((mm = oneRe.exec(t)) !== null){
        const s = String(mm[1] || '').replace(/^(?:是|为)\s*/, '').trim();
        if(s) labels.push(s);
    }
    // 2) 括号/顿号列举：开心、大笑、疑惑、喜悦、害羞
    if(labels.length < 2){
        let m = t.match(/[（(]([^）)]{2,80})[）)]/);
        let body = m ? m[1] : '';
        if(!body){
            m = t.match(/(?:表情|姿势|角度|风格|方向|变体|情绪)\s*[:：]?\s*([^\n。；;]{2,80})/);
            body = m ? m[1] : '';
        }
        if(body){
            labels = body.split(/[、,，/|]/).map(s => s.replace(/^(?:和|与|及)\s*/, '').trim()).filter(Boolean);
        }
    }
    // 3) A和B / A与B
    if(labels.length < 2){
        const andm = t.match(/(?:分别|两种|两个|两张)?[^。\n]{0,12}?(?:表情|姿势|角度|风格)?[^。\n]{0,8}?(?:是|为|:|：)?\s*([^，,。；;\n]{1,16})\s*(?:和|与|及)\s*([^，,。；;\n]{1,16})/);
        if(andm){
            labels = [andm[1], andm[2]].map(s => String(s||'').trim()).filter(Boolean);
        }
    }
    // 清洗噪声：不要把“变体2/第2张/1:1”当标签
    labels = labels
        .map(s => s.replace(/等$/, '').replace(/^(?:是|为)\s*/, '').trim())
        .filter(s => s && s.length <= 16)
        .filter(s => !/^变体\s*\d+$/i.test(s))
        .filter(s => !/^(?:第?\d+[张个种]?|比例|\d+\s*[:：]\s*\d+|1k|2k|4k)$/i.test(s));
    // 去重保序
    const seen = new Set();
    labels = labels.filter(s => {
        const k = s.toLowerCase();
        if(seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    if(labels.length >= 2){
        if(n > 0) return labels.slice(0, n);
        return labels;
    }
    const count = Math.max(2, Math.min(8, n || 2));
    // 默认给可执行的视觉差异，禁止输出“变体1/变体2”
    const emotionDefaults = ['开心大笑','疑惑困惑','惊讶震惊','害羞腼腆','生气愤怒','平静自然','流泪难过','得意挑眉'];
    const poseDefaults = ['正面站姿','侧面回眸','俯视特写','动态行走','坐姿休闲','奔跑瞬间','半身特写','全身构图'];
    const styleDefaults = ['清新明亮','暗调电影感','赛博霓虹','柔和日系','极简白底','复古胶片','高对比时尚','温暖午后'];
    const defaults = /表情|情绪|表情包/.test(t) ? emotionDefaults
        : /姿势|动作|角度|构图/.test(t) ? poseDefaults
        : /风格|画风/.test(t) ? styleDefaults
        : poseDefaults;
    return Array.from({length: count}, (_, i) => defaults[i % defaults.length]);
}

function agentBuildStoryFramePrompt(basePrompt, label, index=0, total=3, style=''){
    const tag = String(label || '').trim() || `第${index+1}幕`;
    const styleLine = String(style || '').trim();
    let common = String(basePrompt || '')
        .replace(/本张差异[：:][^\n。]*/g, ' ')
        .replace(/步骤\s*\d+/g, ' ')
        .replace(/变体\s*\d+/g, ' ')
        .replace(/独立变体/g, ' ')
        .replace(/第\s*\d+\s*\/\s*\d+\s*张/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if(common.length < 10) common = '卡通绘本风格，角色形象稳定，画面温暖，构图清晰';
    if(styleLine && !common.includes(styleLine)) common = `${styleLine}。${common}`;
    // 默认三幕故事节奏
    const beats = [
        '开场：角色独处，情绪铺垫，环境交代清楚',
        '发展：关键转折出现，角色产生互动或情绪变化',
        '收束：情绪缓和或达成温暖结局，画面完整'
    ];
    const beat = beats[Math.min(index, beats.length-1)];
    return `${common}。这是连续故事第${index+1}/${Math.max(total,1)}格（${tag}）：${beat}。保持角色外形、服装、配色与前序一致，构图清晰，高质量。`;
}
function agentBuildVariantPrompt(basePrompt, label, index, total, style=''){
    let tag = agentSanitizeStepLabel(label, index);
    if(/^变体\s*\d+$/i.test(tag) || !tag){
        tag = agentSanitizeStepLabel('', index);
    }
    const styleLine = String(style || '').trim();
    // 纯净视觉提示词：去掉步骤编号/系统话术，只保留角色底稿 + 本张差异
    let common = String(basePrompt || '')
        .replace(/【统一设定[·・]?不可变更】/g, ' ')
        .replace(/本张为第\s*\d+\s*\/\s*\d+\s*张[^\n。]*/g, ' ')
        .replace(/本张专属表情[：:][^\n。]*/g, ' ')
        .replace(/重点表现[：:][^\n。]*/g, ' ')
        .replace(/清晰表现[“"][^”"]+[”"]这一情绪[^\n。]*/g, ' ')
        .replace(/第\s*\d+\s*\/\s*\d+\s*张/g, ' ')
        .replace(/步骤\s*\d+/g, ' ')
        .replace(/不要和其他步骤重复[^\n。]*/g, ' ')
        .replace(/不要与其他变体重复[^\n。]*/g, ' ')
        .replace(/只表现这一种表情[^\n。]*/g, ' ')
        .replace(/表情为\s*变体\s*\d+\s*[：:]?[^\n。]*/g, ' ')
        .replace(/表情包为\s*[：:]?\s*/g, ' ')
        .replace(/表情为\s*[：:]\s*/g, ' ')
        .replace(/变体\s*\d+/g, ' ')
        .replace(/(开心|大笑|高兴|震惊|吃惊|惊讶|流泪|难过|伤心|疑惑|困惑|害羞|腼腆|愤怒|生气|平静|冷静)[^，。；;\n]{0,30}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if(common.length < 12){
        common = '角色表情包插画，主体清晰居中，干净背景，五官夸张可读，线条干净，高质量成像。';
    }
    if(styleLine && !common.includes(styleLine)){
        common = `${styleLine}。${common}`;
    }
    const action = agentEmotionActionLine(tag);
    if(/表情|开心|大笑|震惊|吃惊|流泪|疑惑|害羞|愤怒|平静|困惑|表情包/.test(tag) || /表情|情绪|表情包/.test(String(basePrompt||'') + String(tag||''))){
        return `${common} 表情为${tag}：${action} 构图清晰，角色特征稳定，画面干净。`;
    }
    return `${common} 本张差异：${tag}。构图清晰，角色/产品特征稳定，画面干净。`;
}

function hideImageRefConfirmPanel(result){
    const panel = document.getElementById('agentRefConfirmPanel');
    if(panel) panel.hidden = true;
    if(_agentRefConfirmResolver){ _agentRefConfirmResolver(result); _agentRefConfirmResolver = null; }
}
function agentRatioLabel(key){
    const map = {square:'1:1', portrait:'2:3', portrait43:'3:4', portrait45:'4:5', landscape43:'4:3', landscape:'3:2', story:'9:16', wide:'16:9', ultrawide:'21:9', ultratall:'9:21'};
    return map[key] || key || '1:1';
}
function agentQualityLabel(q){
    const map = {'':'自动', high:'高', medium:'中', low:'低'};
    return map[q] || '自动';
}
function agentUpdateToolbarLabels(){
    // 模型按钮仅显示图标，名称放到 title 悬浮提示，避免挤占输入框宽度
    const modelLabel = document.getElementById('agentModelLabel');
    const btn = document.getElementById('agentModelBtn');
    if(!agentState) return;
    const genProviders = agentGenProviders();
    const genProvider = genProviders.find(p => p.id === agentState.genProvider);
    const genName = genProvider ? (genProvider.name || genProvider.id) : '';
    const genModel = String(agentState.genModel || '').trim();
    const chatModel = String(agentState.chatModel || '').trim();
    const tip = [
        chatModel ? `理解: ${chatModel}` : '',
        (genModel || genName) ? `生图: ${genModel || genName}` : ''
    ].filter(Boolean).join(' | ') || '模型选择';
    if(modelLabel){
        modelLabel.textContent = '模型';
        modelLabel.title = tip;
    }
    if(btn) btn.title = tip;
}
function agentMoveSelectsToDropdown(){
    const chatModelSelects = document.getElementById('agentChatModelSelects');
    const genSelects = document.getElementById('agentGenSelects');
    // 将 LLM 模型选择器放到思维模式面板中
    if(chatModelSelects && agentChatProvider && agentChatModel){
        agentChatProvider.setAttribute('aria-label', '理解模型平台');
        agentChatModel.setAttribute('aria-label', '理解模型');
        chatModelSelects.appendChild(agentChatProvider);
        chatModelSelects.appendChild(agentChatModel);
    }
    if(genSelects && agentGenProvider && agentGenModel){
        agentGenProvider.setAttribute('aria-label', '生图模型平台');
        agentGenModel.setAttribute('aria-label', '生图模型');
        genSelects.appendChild(agentGenProvider);
        genSelects.appendChild(agentGenModel);
    }
    // 确保下拉面板初始隐藏
    const modelPanel = document.getElementById('agentModelPanel');
    const paramsPanel = document.getElementById('agentParamsPanel');
    const chatModelPanel = document.getElementById('agentChatModelPanel');
    if(modelPanel) modelPanel.hidden = true;
    if(paramsPanel) paramsPanel.hidden = true;
    if(chatModelPanel) chatModelPanel.hidden = true;
    // 参数面板已移除，隐藏残留节点
    const paramsBtn = document.getElementById('agentParamsBtn');
    if(paramsBtn) paramsBtn.hidden = true;
}
let _agentModelProvidersReadyApplied = false;
let _agentModelSelectorSig = '';
let _agentProviderWatchTimer = 0;
let _agentProviderWatchTries = 0;

function agentProvidersReady(){
    try{
        const chatReady = (typeof chatApiProviders === 'function') && chatApiProviders().length > 0;
        const genReady = agentGenProviders().length > 0;
        return !!(chatReady || genReady);
    }catch(_){
        return false;
    }
}

function agentBuildSelectOptions(values, selected){
    const list = [];
    const seen = new Set();
    const push = (value) => {
        const v = String(value || '').trim();
        if(!v || seen.has(v)) return;
        seen.add(v);
        list.push(v);
    };
    push(selected);
    (values || []).forEach(push);
    if(!list.length) return '<option value="">-</option>';
    return list.map(v => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

function agentPickChatProvider(preferredProvider='', preferredModel=''){
    const providers = (typeof chatApiProviders === 'function') ? chatApiProviders() : [];
    if(!providers.length) return String(preferredProvider || '').trim();
    const want = String(preferredProvider || '').trim();
    // 平台优先：用户设为默认时选的平台必须保留
    if(want && providers.some(p => p.id === want)) return want;
    // 平台失效后，才按模型名兜底反查
    const byModel = agentFindChatProviderForModel(preferredModel);
    if(byModel) return byModel;
    return providers[0]?.id || '';
}

function agentPickGenProvider(preferredProvider='', preferredModel=''){
    const providers = agentGenProviders();
    if(!providers.length) return String(preferredProvider || '').trim();
    const want = String(preferredProvider || '').trim();
    if(want && providers.some(p => p.id === want)) return want;
    const byModel = agentFindGenProviderForModel(preferredModel);
    if(byModel) return byModel;
    return providers[0]?.id || '';
}

function agentModelSelectorSignature(){
    if(!agentState) return '';
    let chatIds = '';
    let genIds = '';
    try{ chatIds = ((typeof chatApiProviders === 'function') ? chatApiProviders() : []).map(p => p.id).join(','); }catch(_){ }
    try{ genIds = agentGenProviders().map(p => p.id).join(','); }catch(_){ }
    return [
        agentState.chatProvider || '',
        agentState.chatModel || '',
        agentState.genProvider || '',
        agentState.genModel || '',
        agentState.genRatio || '',
        agentState.genResolution || '',
        chatIds,
        genIds
    ].join('|');
}

function agentRestoreDefaultModelsWhenProvidersReady(force=false){
    if(!agentState) return false;
    if(!agentProvidersReady()) return false;
    if(_agentModelProvidersReadyApplied && !force) return false;
    _agentModelProvidersReadyApplied = true;
    let changed = false;
    try{ changed = !!agentApplyModelDefaults(true); }catch(_){ changed = false; }
    return changed;
}

function agentWatchProvidersForModelRestore(){
    if(_agentProviderWatchTimer){
        try{ clearTimeout(_agentProviderWatchTimer); }catch(_){ }
        _agentProviderWatchTimer = 0;
    }
    _agentProviderWatchTries = 0;
    const tick = () => {
        _agentProviderWatchTimer = 0;
        _agentProviderWatchTries += 1;
        if(!agentState){
            if(_agentProviderWatchTries < 50) _agentProviderWatchTimer = setTimeout(tick, 100);
            return;
        }
        if(agentProvidersReady()){
            const changed = agentRestoreDefaultModelsWhenProvidersReady(false);
            try{ renderAgentModelSelectors(true); }catch(_){ }
            if(changed){
                try{ saveAgentState(true); }catch(_){ }
            }
            return;
        }
        if(_agentProviderWatchTries < 50){
            _agentProviderWatchTimer = setTimeout(tick, 100);
        }
    };
    _agentProviderWatchTimer = setTimeout(tick, 0);
}

function renderAgentModelSelectors(force=false){
    if(!agentState) return;

    try{ agentRestoreDefaultModelsWhenProvidersReady(false); }catch(_){ }

    const preferredChatModel = String(agentState.chatModel || '').trim();
    const preferredGenModel = String(agentState.genModel || '').trim();
    const preferredChatProvider = String(agentState.chatProvider || '').trim();
    const preferredGenProvider = String(agentState.genProvider || '').trim();

    const chatProviders = (typeof chatApiProviders === 'function') ? chatApiProviders() : [];
    const genProviders = agentGenProviders();
    const chatReady = chatProviders.length > 0;
    const genReady = genProviders.length > 0;

    // 先解析出目标值，再决定要不要动 DOM
    let nextChatProvider = preferredChatProvider;
    let nextChatModel = preferredChatModel;
    let nextGenProvider = preferredGenProvider;
    let nextGenModel = preferredGenModel;
    let chatModels = [];
    let genModels = [];

    if(chatReady){
        nextChatProvider = agentPickChatProvider(preferredChatProvider, preferredChatModel);
        chatModels = (nextChatProvider && typeof providerChatModels === 'function')
            ? (providerChatModels(nextChatProvider) || [])
            : [];
        nextChatModel = preferredChatModel || chatModels[0] || '';
    }
    if(genReady){
        nextGenProvider = agentPickGenProvider(preferredGenProvider, preferredGenModel);
        genModels = (nextGenProvider && typeof providerImageModels === 'function')
            ? (providerImageModels(nextGenProvider) || [])
            : [];
        nextGenModel = preferredGenModel || genModels[0] || '';
    }

    agentState.chatProvider = nextChatProvider;
    agentState.chatModel = nextChatModel;
    agentState.genProvider = nextGenProvider;
    agentState.genModel = nextGenModel;

    // 选择平台或模型后立即同步画布返回的比例能力；执行前还会再次确认。
    if(nextGenProvider && nextGenModel){
        agentRefreshImageParamCapabilities(nextGenProvider, nextGenModel).catch(()=>{});
    }
    renderAgentRatioOptions();

    const sig = agentModelSelectorSignature();
    const domMatches = !!(
        agentChatProvider && agentChatProvider.value === String(nextChatProvider || '') &&
        agentChatModel && agentChatModel.value === String(nextChatModel || '') &&
        agentGenProvider && agentGenProvider.value === String(nextGenProvider || '') &&
        agentGenModel && agentGenModel.value === String(nextGenModel || '') &&
        agentChatProvider.options.length > 0 &&
        agentGenProvider.options.length > 0
    );
    if(!force && sig && sig === _agentModelSelectorSig && domMatches){
        try{ agentUpdateModelDefaultHint(); }catch(_){ }
        return;
    }

    if(!chatReady && !genReady){
        if(agentChatProvider){
            agentChatProvider.innerHTML = nextChatProvider
                ? `<option value="${escapeHtml(nextChatProvider)}" selected>${escapeHtml(nextChatProvider)}</option>`
                : `<option value="">${escapeHtml(tr('smart.agentNoProviders'))}</option>`;
        }
        if(agentChatModel){
            agentChatModel.innerHTML = nextChatModel
                ? `<option value="${escapeHtml(nextChatModel)}" selected>${escapeHtml(nextChatModel)}</option>`
                : '<option value="">-</option>';
        }
        if(agentGenProvider){
            agentGenProvider.innerHTML = nextGenProvider
                ? `<option value="${escapeHtml(nextGenProvider)}" selected>${escapeHtml(nextGenProvider)}</option>`
                : `<option value="">${escapeHtml(tr('smart.agentNoProviders'))}</option>`;
        }
        if(agentGenModel){
            agentGenModel.innerHTML = nextGenModel
                ? `<option value="${escapeHtml(nextGenModel)}" selected>${escapeHtml(nextGenModel)}</option>`
                : '<option value="">-</option>';
        }
    } else {
        if(chatReady){
            if(agentChatProvider){
                agentChatProvider.innerHTML = chatProviders.map(p =>
                    `<option value="${escapeHtml(p.id)}" ${p.id === nextChatProvider ? 'selected' : ''}>${escapeHtml(p.name || p.id)}</option>`
                ).join('');
            }
            if(agentChatModel){
                agentChatModel.innerHTML = agentBuildSelectOptions(chatModels, nextChatModel);
            }
        } else {
            if(agentChatProvider){
                agentChatProvider.innerHTML = nextChatProvider
                    ? `<option value="${escapeHtml(nextChatProvider)}" selected>${escapeHtml(nextChatProvider)}</option>`
                    : `<option value="">${escapeHtml(tr('smart.agentNoProviders'))}</option>`;
            }
            if(agentChatModel){
                agentChatModel.innerHTML = nextChatModel
                    ? `<option value="${escapeHtml(nextChatModel)}" selected>${escapeHtml(nextChatModel)}</option>`
                    : '<option value="">-</option>';
            }
        }

        if(genReady){
            if(agentGenProvider){
                agentGenProvider.innerHTML = genProviders.map(p =>
                    `<option value="${escapeHtml(p.id)}" ${p.id === nextGenProvider ? 'selected' : ''}>${escapeHtml(p.name || p.id)}</option>`
                ).join('');
            }
            if(agentGenModel){
                agentGenModel.innerHTML = agentBuildSelectOptions(genModels, nextGenModel);
            }
        } else {
            if(agentGenProvider){
                agentGenProvider.innerHTML = nextGenProvider
                    ? `<option value="${escapeHtml(nextGenProvider)}" selected>${escapeHtml(nextGenProvider)}</option>`
                    : `<option value="">${escapeHtml(tr('smart.agentNoProviders'))}</option>`;
            }
            if(agentGenModel){
                agentGenModel.innerHTML = nextGenModel
                    ? `<option value="${escapeHtml(nextGenModel)}" selected>${escapeHtml(nextGenModel)}</option>`
                    : '<option value="">-</option>';
            }
        }
    }

    _agentModelSelectorSig = sig;
    agentSyncParamsPanel();
    agentUpdateToolbarLabels();
    try{ agentUpdateModelDefaultHint(); }catch(_){ }
}

function agentSyncParamsPanel(){
    if(!agentState) return;
    const ratio = agentState.genRatio || 'square';
    const res = agentState.genResolution || '1k';
    const count = agentState.genCount || 1;
    const quality = agentState.genQuality || '';
    // 同步比例网格
    document.querySelectorAll('.agent-ratio-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.ratio === ratio);
    });
    // 同步分辨率网格
    document.querySelectorAll('.agent-res-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.res === res);
    });
    // 同步数量网格
    document.querySelectorAll('.agent-count-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.count) === count);
    });
    // 同步质量
    document.querySelectorAll('.agent-quality-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.quality || '') === quality);
    });
    // 同步隐藏 select（保持后端兼容）
    if(agentGenRatio) agentGenRatio.value = agentRatioNearestSupported(ratio, agentImageParamCapabilities.ratios);
    if(agentGenResolution) agentGenResolution.value = res;
    if(agentGenCount) agentGenCount.value = String(count);
}
function renderAgentSkill(){ /* Skill 已合并到附件系统，不再需要单独渲染 */ }
function setAgentSkillFile(file){
    if(!file || !agentState) return;
    if(file.size > AGENT_SKILL_MAX_BYTES){ toast(tr('smart.agentSkillTooBig')); return; }
    const reader = new FileReader();
    reader.onload = () => {
        if(!Array.isArray(agentState.skills)) agentState.skills = [];
    // params UI removed: always default genCount=1
    agentState.genCount = 1;
        agentState.skills.push({name:file.name || 'skill.md', content:String(reader.result || '')});
        renderAgentAttachments();
        saveAgentState();
        toast(`${tr('smart.agentSkillLoaded')}: ${file.name}`);
    };
    reader.readAsText(file);
}
function renderAgentAttachments(){
    if(!agentAttachRow || !agentState) return;
    // 图片附件改为输入框内联芯片，不再渲染上方缩略图。
    // 这里只保留 Skill 条。
    updateAgentPrimaryAction();
    agentState.skills = agentNormalizeSkillList(Array.isArray(agentState.skills) ? agentState.skills : []);
    const skills = agentState.skills;
    let html = '';
    skills.forEach((skill, i) => {
        const isPreset = !!(skill.presetId || skill.id);
        const saveBtn = isPreset ? '' : `<button type="button" data-agent-skill-save-preset="${i}" title="保存为预设"><i data-lucide="bookmark-plus"></i></button>`;
        const skillName = agentRepairMojibakeText(skill.name || 'skill.md');
        html += `<div class="agent-attach-skill${isPreset ? ' is-preset' : ''}"><i data-lucide="${isPreset ? 'book-open' : 'file-text'}"></i><span class="agent-attach-skill-name" title="${escapeHtml(skillName)}">${escapeHtml(skillName)}</span>${saveBtn}<button type="button" data-agent-skill-remove="${i}"><i data-lucide="x"></i></button></div>`;
    });
    agentAttachRow.innerHTML = html;
    if(window.lucide) lucide.createIcons();
    agentAttachRow.querySelectorAll('[data-agent-skill-remove]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            agentState.skills.splice(Number(btn.dataset.agentSkillRemove) || 0, 1);
            renderAgentAttachments();
            saveAgentState();
        };
    });
    agentAttachRow.querySelectorAll('[data-agent-skill-save-preset]').forEach(btn => {
        btn.onclick = async e => {
            e.stopPropagation();
            const skill = agentState.skills[Number(btn.dataset.agentSkillSavePreset) || 0];
            if(!skill) return;
            openAgentSkillManager({
                name: String(skill.name || '').replace(/\.md$/i, ''),
                description: '',
                content: skill.content || ''
            });
        };
    });
}
async function agentAttachFiles(files){
    if(!agentState) return;
    const allFiles = [...(files || [])];
    const skillFiles = allFiles.filter(f => {
        const name = String(f.name || '').toLowerCase();
        return name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt');
    });
    const imageFiles = allFiles.filter(f => String(f.type || '').startsWith('image/')).slice(0, AGENT_LLM_IMAGE_MAX);
    skillFiles.forEach(f => setAgentSkillFile(f));
    if(!imageFiles.length) return;
    if(!Array.isArray(agentState.attachments)) agentState.attachments = [];
    // 检查生图 provider 的参考图上限
    const _genProvider = agentGenProviders().some(p => p.id === agentState.genProvider) ? agentState.genProvider : (agentGenProviders()[0]?.id || '');
    const _refMax = _genProvider ? providerMaxReferenceImages(_genProvider) : AGENT_LLM_IMAGE_MAX;
    const _currentCount = agentState.attachments.length;
    const _available = Math.max(0, _refMax - _currentCount);
    if(_available <= 0){
        const _pName = apiProviderById(_genProvider)?.name || _genProvider;
        toast(`当前生图平台 ${_pName} 最多支持 ${_refMax} 张参考图，已达上限`);
        return;
    }
    if(imageFiles.length > _available){
        const _pName = apiProviderById(_genProvider)?.name || _genProvider;
        toast(`当前生图平台 ${_pName} 最多支持 ${_refMax} 张参考图，仅添加前 ${_available} 张`);
    }
    try {
        const uploaded = await uploadFiles(imageFiles);
        (uploaded || []).filter(f => f?.url).forEach(f => {
            if(agentState.attachments.length < _refMax) agentState.attachments.push({url:f.url, name:f.name || 'image'});
        });
        if(agentIsComposerEl()){
            const draft = agentGetInputValue();
            agentRebuildComposerFromState(draft);
        }
        renderAgentAttachments();
        saveAgentState();
    } catch(e) {
        toast(String(e.message || e).slice(0, 120));
    }
}

function agentWorkflowLogHtml(logs){
    if(!Array.isArray(logs) || !logs.length) return '';
    // 执行阶段默认只保留结果、警告和错误；逐步创建/挂载/开始信息仍保存在消息状态中。
    // 这样一套多图任务不会在对话里连续刷出几十行内部编排过程。
    const terminal = logs.filter(item => ['ok', 'warn', 'error'].includes(String(item?.level || '').toLowerCase()));
    const lastInfo = [...logs].reverse().find(item => String(item?.level || '').toLowerCase() === 'info');
    const keep = new Set(terminal);
    if(lastInfo) keep.add(lastInfo);
    const visible = logs.filter(item => keep.has(item));
    if(!visible.length) return '';
    const ok = visible.filter(i => i.level === 'ok').length;
    const warn = visible.filter(i => i.level === 'warn').length;
    const err = visible.filter(i => i.level === 'error').length;
    const info = visible.length - ok - warn - err;
    const last = visible[visible.length - 1];
    const lastMsg = String(last?.message || '').slice(0, 48);
    const summaryParts = [];
    if(ok) summaryParts.push(`成功 ${ok}`);
    if(warn) summaryParts.push(`警告 ${warn}`);
    if(err) summaryParts.push(`失败 ${err}`);
    if(!summaryParts.length) summaryParts.push(`共 ${visible.length} 条`);
    else summaryParts.unshift(`共 ${visible.length} 条`);
    const summary = `${summaryParts.join(' · ')}${lastMsg ? ` · ${lastMsg}` : ''}`;
    const rows = visible.slice(-80).map(item => {
        const level = item.level || 'info';
        const time = item.ts ? new Date(item.ts).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '';
        return `<div class="agent-workflow-log-item level-${escapeHtml(level)}"><span class="agent-workflow-log-time">${escapeHtml(time)}</span><span class="agent-workflow-log-msg">${escapeHtml(item.message || '')}</span></div>`;
    }).join('');
    // 默认折叠：只显示摘要行，点击展开明细
    return `<div class="agent-workflow-log is-collapsed" data-agent-workflow-log="1">
        <button type="button" class="agent-workflow-log-head" data-agent-log-toggle="1" aria-expanded="false">
            <span class="agent-workflow-log-title">执行摘要</span>
            <span class="agent-workflow-log-summary">${escapeHtml(summary)}</span>
            <span class="agent-workflow-log-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="agent-workflow-log-body">${rows}</div>
    </div>`;
}
function agentGenCardHtml(gen, numOffset, messageId='', genIndex=-1){
    const status = gen.status || 'running';
    const statusText = status === 'done' ? tr('smart.agentGenDone') : status === 'error' ? tr('smart.agentGenFail') : status === 'stopped' ? '已停止，可在节点中重试' : (status === 'planned' ? '提示词已就绪，待确认执行' : (status === 'waiting' ? '等待前置步骤…' : tr('smart.agentGenerating')));
    const depModeTag = String(gen.dependency_mode || '').toLowerCase();
    const realPrevDep = !!(gen.depends_on_previous || gen.use_previous_results) && depModeTag !== 'none';
    const depTag = realPrevDep
        ? (depModeTag === 'product_reference' ? '产品参考(依赖前序)' : (depModeTag === 'fusion' ? '融合(依赖前序)' : '依赖前序'))
        : '';
    const refTags = [
        depTag,
        gen.use_last_outputs ? tr('smart.agentRefLast') : '',
        gen.use_attachments ? tr('smart.agentRefAttach') : ''
    ].filter(Boolean).join(' · ');
    // 显示参考图索引指示器（当指定了 attachment_indices 时）
    const attachIdxTag = (Array.isArray(gen.attachment_indices) && gen.attachment_indices.length > 0)
        ? `参考图#${gen.attachment_indices.map(i => i + 1).join(',')}` : '';
    const fullRefTags = [refTags, attachIdxTag].filter(Boolean).join(' · ');
    const thumbs = (gen.results || []).filter(r => r?.url).map((r, i) => {
        const imageNumber = (numOffset || 0) + i + 1;
        return `<button class="agent-gen-thumb-wrap" type="button" aria-label="跳转到画布中的生成结果图${imageNumber}" title="图${imageNumber} - 点击跳转" data-agent-gen-jump="${escapeHtml(r.nodeId || '')}" data-agent-gen-x="${r.nodeX || 0}" data-agent-gen-y="${r.nodeY || 0}"><span class="agent-gen-img-num" aria-hidden="true">${imageNumber}</span><img src="${escapeHtml(r.url)}" alt="生成结果图${imageNumber}" loading="lazy"></button>`;
    }).join('');
    const retryFailed = status === 'error' || status === 'stopped' ? `<div class="agent-gen-retry-row"><button class="agent-quick-btn primary" type="button" data-agent-gen-retry="${escapeHtml(messageId)}" data-agent-gen-index="${genIndex}"><i data-lucide="refresh-cw"></i><span>${status === 'error' ? '重试失败项' : '重新运行此项'}</span></button></div>` : '';
    const statusClass = status === 'error' ? 'error' : status === 'done' ? 'done' : status === 'stopped' ? 'stopped' : status === 'waiting' ? 'waiting' : '';
    const spinner = (status === 'running' || status === 'waiting') ? '<span class="agent-gen-spinner"></span>' : '';
    return `<div class="agent-gen-card"><div class="agent-gen-status ${statusClass}">${spinner}<span>${escapeHtml(statusText)}${fullRefTags ? ' · ' + escapeHtml(fullRefTags) : ''}${gen.refCount ? ` · 引用${gen.refCount}张` : ''}</span></div>${status === 'error' && gen.error ? `<div class="agent-gen-error">${escapeHtml(String(gen.error).slice(0, 200))}${gen.retryCount ? ` · 已重试${gen.retryCount}次` : ''}</div>` : ''}${thumbs ? `<div class="agent-msg-thumbs">${thumbs}</div>` : ''}${retryFailed}</div>`;
}

// Keep conversational/inspection requests out of the generation planner.  This
// classifier is deliberately conservative: only explicit generation verbs enter
// the planning pipeline; ordinary questions remain a normal chat turn.
function agentClassifyIntent({text='', attachments=[], skills=[]}={}){
    const t = String(text || '').trim();
    const hasImages = Array.isArray(attachments) && attachments.some(a => a && a.url);
    const hasSkills = agentHasActiveSkills(skills);
    if (hasImages && agentLooksLikeImageAnalysisRequest(t)) {
        return {intent:'analyze_image', confidence:0.98, reasons:['explicit image analysis/reverse-prompt request']};
    }
    const edit = /(?:\u4fee\u6539|\u6539\u6210|\u66ff\u6362|\u8c03\u6574|\u91cd\u65b0\u751f\u6210|\u91cd\u505a|\u4fee\u56fe|\u6539\u56fe|\u628a.*(?:\u53d8\u6210|\u6539\u4e3a))/.test(t)
        || /\b(?:edit|modify|replace|retouch|recreate)\b/i.test(t);
    const generate = /(?:\u751f\u6210|\u5236\u4f5c|\u753b\u4e00|\u753b\u51fa|\u521b\u4f5c|\u51fa\u56fe|\u505a\u4e00\u5f20|\u505a\u4e00\u5957|\u8bbe\u8ba1\u4e00)/.test(t)
        || /\b(?:generate|create|draw|make|design)\b/i.test(t);
    const complex = agentLooksLikeExplicitSeriesOrFusion(t) || /(?:\u5206\u955c|\u6545\u4e8b|\u8be6\u60c5\u9875|\u4e3b\u56fe|\u5957\u56fe)/.test(t);
    if (edit && hasImages) return {intent:'edit_image', confidence:0.95, reasons:['explicit edit verb with current-turn image']};
    if (generate || hasSkills) return {intent:complex ? 'plan_design' : 'generate_image', confidence:0.9, reasons:[generate?'explicit generation verb':'active skill task']};
    if (/(?:\u753b\u5e03|\u8282\u70b9|\u5f53\u524d\u56fe|\u5de6\u8fb9\u90a3\u5f20|\u770b\u4e00\u4e0b)/.test(t)) return {intent:'inspect_canvas', confidence:0.75, reasons:['canvas inspection wording']};
    return {intent:'chat', confidence:0.8, reasons:['no explicit generation/edit instruction']};
}

async function agentRunChatStage({conversationId='', userMsg=null, text='', attachments=[], history=[], canvasSnapshot=null, intent='chat'}={}){
    const cid = conversationId || agentState.activeConversationId || '';
    const provider = agentState.chatProvider || agentState.genProvider || '';
    const model = agentState.chatModel || agentState.genModel || '';
    const snapshot = intent === 'inspect_canvas' ? agentSanitizeCanvasSnapshot(canvasSnapshot) : null;
    const snapshotBlock = snapshot ? `\n当前用户明确要求查看的画布快照（仅用于回答，绝不能当作参考图或附件）：\n${JSON.stringify(snapshot)}` : '';
    const prompt = `你是画布助手。只回答用户当前问题，不规划生图、不创建节点、不输出 generations。若用户没有明确提出生图或改图，请保持对话即可。${snapshotBlock}`;
    const result = await agentCreateAndWaitLlmTask({message:String(text||'').trim(), messages:Array.isArray(history)?history:[], images:attachments.filter(a=>a?.url).map(a=>a.url), videos:[], model, provider, ms_model:provider==='modelscope'?model:'', system_prompt:prompt}, {stream:true, conversationId:cid, requestId:userMsg?._pendingRequestId||''});
    const answer = String(result?.text || result?.content || '').trim() || '我已收到。请告诉我你希望对画布或图片做什么。';
    agentPushMessageToConversation(cid, {id:uid('am'), role:'assistant', text:answer, stage:intent === 'inspect_canvas' ? 'inspect_canvas' : 'chat', generations:[], prompts:[], contextSources:{conversationId:cid, historyCount:Array.isArray(history)?history.length:0, canvasSnapshotId:snapshot?.snapshotId||'', canvasNodeCount:Array.isArray(snapshot?.nodes)?snapshot.nodes.length:0}, ts:Date.now(), conversationId:cid});
    agentPatchConversationWorkflow(cid, workflow=>{workflow.status='completed'; workflow.error=''; workflow.updatedAt=Date.now();});
    if(agentIsActiveConversation(cid)){ agentSending=false; agentThinking=false; agentThinkingStage=''; renderAgentMessages(); }
    saveAgentState(true);
    return true;
}
function agentExecutionPromptsHtml(generations=[]){
    const prompts = generations.map((gen, index) => ({
        title: String(gen?.title || gen?.role || `步骤 ${index + 1}`).trim(),
        prompt: String(gen?.professionalPrompt || gen?.prompt || gen?.plannedPrompt || '').trim()
    })).filter(item => item.prompt);
    if(!prompts.length) return '';
    const items = prompts.map((item, index) => `<div class="agent-execution-prompt-item"><div class="agent-execution-prompt-title">${index + 1}. ${escapeHtml(item.title)}</div><div class="agent-execution-prompt-text">${escapeHtml(item.prompt)}</div></div>`).join('');
    return `<details class="agent-execution-prompts"><summary><span><i data-lucide="file-text"></i>执行提示词</span><small>${prompts.length} 条</small></summary><div class="agent-execution-prompts-body">${items}</div></details>`;
}
function agentMessageHtml(msg){
    let _genNumOffset = 0;
    const hasGenerations = Array.isArray(msg.generations) && msg.generations.length > 0;
    const gens = (msg.generations || []).map((g,index) => { const html = agentGenCardHtml(g, _genNumOffset, msg.id, index); _genNumOffset += (g.results || []).filter(r => r?.url).length; return html; }).join('');
    const executionPromptsHtml = typeof agentExecutionPromptsHtml === 'function' ? agentExecutionPromptsHtml(msg.generations || []) : '';
    const workflowLogHtml = agentWorkflowLogHtml(msg.workflowLogs || msg.logs || []);
    const contextSourceLabel = msg?.role === 'assistant' ? String(msg?.contextSources?.label || '').trim() : '';
    const contextSourceHtml = contextSourceLabel
        ? `<div class="agent-context-source" title="本次请求锁定的上下文来源">${escapeHtml(contextSourceLabel)}</div>`
        : '';
    const canCopyMsg = !!(msg.text || msg.understanding || (Array.isArray(msg.parts) && msg.parts.length) || (Array.isArray(msg.images) && msg.images.some(x => x?.url)) || (Array.isArray(msg.generations) && msg.generations.some(g => g?.prompt || g?.professionalPrompt)));
    // 门禁卡片只负责确认/继续，不允许把整条任务再次重跑；否则会再次写入同一用户需求并重复执行。
    const canRetryWholeReply = msg.role === 'assistant'
        && !hasGenerations
        && !msg.stageGate
        && !msg.pendingPlan;
    const actions = canCopyMsg ? `<div class="agent-msg-actions"><button class="agent-msg-action-btn" type="button" data-agent-copy="${escapeHtml(msg.id)}" title="复制"><i data-lucide="copy"></i></button>${canRetryWholeReply ? `<button class="agent-msg-action-btn" type="button" data-agent-retry="${escapeHtml(msg.id)}" title="重试整条回复"><i data-lucide="refresh-cw"></i></button>` : ''}</div>` : '';
    // 结构化 options 字段（仅 assistant 消息，且 generations 为空时显示）
    const options = (!hasGenerations && Array.isArray(msg.options)) ? msg.options : [];
    const optionsHtml = options.length ? `<div class="agent-msg-options">${options.map(opt => `<button class="agent-msg-option-btn" type="button" data-agent-option="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</button>`).join('')}</div>` : '';
    // 思维模式提示词确认卡片（有未确认的 prompts 时显示）
    let promptCardHtml = '';
    if(msg.role === 'assistant' && Array.isArray(msg.prompts) && msg.prompts.length > 0){
        const prompts = msg.prompts;
        const currentIdx = prompts.findIndex(p => p.status === 'current' || p.status === 'editing');
        const hasUnresolved = prompts.some(p => p.status === 'pending' || p.status === 'current' || p.status === 'editing');
        // P2-12: 数量校验显示
        const requestedCount = msg.requestedCount || 0;
        const countHint = (requestedCount > 0 && requestedCount !== prompts.length) ? ` · 请求${requestedCount}张/返回${prompts.length}条` : '';
        const confirmedCount = prompts.filter(p => p.status === 'confirmed').length;
        const skippedCount = prompts.filter(p => p.status === 'skipped').length;
        const progressParts = [];
        if(confirmedCount > 0) progressParts.push(`${confirmedCount}已确认`);
        if(skippedCount > 0) progressParts.push(`${skippedCount}已跳过`);
        const progress = progressParts.length ? ` · ${progressParts.join(' · ')}` : '';
        // 构建 prompt 列表（已确认/已跳过的折叠，当前展开，pending 灰色）
        const listHtml = prompts.map((p, i) => {
            const statusIcon = p.status === 'confirmed' ? '✓' : p.status === 'skipped' ? '×' : p.status === 'current' || p.status === 'editing' ? '▶' : '○';
            const itemClass = p.status === 'confirmed' ? 'confirmed' : p.status === 'skipped' ? 'skipped' : p.status === 'current' || p.status === 'editing' ? 'current' : 'pending';
            const shortText = (p.prompt || '').length > 40 ? (p.prompt || '').slice(0, 40) + '…' : (p.prompt || '');
            // 已确认/已跳过的项可点击展开反悔
            const canReopen = p.status === 'confirmed' || p.status === 'skipped';
            const reopenAttr = canReopen ? `data-agent-prompt-reopen="${escapeHtml(msg.id)}" data-agent-prompt-index="${i}"` : '';
            // 当前项展开操作按钮
            let itemActionsHtml = '';
            if(p.status === 'current'){
                itemActionsHtml = `<div class="agent-prompt-item-actions"><button class="agent-prompt-btn primary" type="button" data-agent-prompt-action="confirm" data-agent-prompt-id="${escapeHtml(msg.id)}">确认</button><button class="agent-prompt-btn" type="button" data-agent-prompt-action="edit" data-agent-prompt-id="${escapeHtml(msg.id)}">修改</button><button class="agent-prompt-btn" type="button" data-agent-prompt-action="regenerate" data-agent-prompt-id="${escapeHtml(msg.id)}">重新生成</button></div>`;
            } else if(p.status === 'editing'){
                itemActionsHtml = `<div class="agent-prompt-item-actions"><button class="agent-prompt-btn primary" type="button" data-agent-prompt-action="save-edit" data-agent-prompt-id="${escapeHtml(msg.id)}">保存并确认</button><button class="agent-prompt-btn" type="button" data-agent-prompt-action="cancel-edit" data-agent-prompt-id="${escapeHtml(msg.id)}">取消</button></div>`;
            }
            const itemBodyHtml = p.status === 'editing'
                ? `<textarea class="agent-prompt-edit-area" data-agent-prompt-edit="${escapeHtml(msg.id)}" rows="3">${escapeHtml(p.prompt || '')}</textarea>`
                : (p.status === 'current' ? `<div class="agent-prompt-card-body">${escapeHtml(p.prompt || '')}</div>` : '');
            return `<div class="agent-prompt-list-item ${itemClass}" ${reopenAttr}><div class="agent-prompt-list-header"><span class="agent-prompt-list-icon">${statusIcon}</span><span class="agent-prompt-list-index">#${i + 1}</span><span class="agent-prompt-list-text">${escapeHtml(shortText)}</span></div>${itemBodyHtml}${itemActionsHtml}</div>`;
        }).join('');
        // P1-7: 全部确认快捷按钮（prompts≥2 且有未处理项时显示）
        const showConfirmAll = prompts.length >= 2 && hasUnresolved;
        const confirmAllHtml = showConfirmAll ? `<button class="agent-prompt-btn primary agent-prompt-confirm-all" type="button" data-agent-prompt-action="confirm-all" data-agent-prompt-id="${escapeHtml(msg.id)}">全部确认并生成</button>` : '';
        // P2-15: 全部取消按钮（有未处理项时显示）
        const showCancelAll = hasUnresolved;
        const cancelAllHtml = showCancelAll ? `<button class="agent-prompt-btn agent-prompt-cancel-all" type="button" data-agent-prompt-action="cancel-all" data-agent-prompt-id="${escapeHtml(msg.id)}">全部取消</button>` : '';
        const footerHtml = (confirmAllHtml || cancelAllHtml) ? `<div class="agent-prompt-card-footer">${confirmAllHtml}${cancelAllHtml}</div>` : '';
        promptCardHtml = `<div class="agent-prompt-card"><div class="agent-prompt-card-header">📝 提示词确认${countHint}${progress}</div><div class="agent-prompt-list">${listHtml}</div>${footerHtml}</div>`;
    }
    // 分析/提示词建议卡片（非思维模式 text_only 回复）
    let cardHtml = '';
    if(msg.role === 'assistant' && msg.cardType === 'analysis' && msg.text){
        cardHtml = `<div class="agent-analysis-card"><div class="agent-analysis-body">${escapeHtml(msg.text)}</div><div class="agent-analysis-actions"><button class="agent-quick-btn primary" type="button" data-agent-card-gen="1"><i data-lucide="palette"></i><span>用这个Prompt生图</span></button><button class="agent-quick-btn" type="button" data-agent-copy="${escapeHtml(msg.id)}"><i data-lucide="copy"></i><span>复制</span></button></div></div>`;
    } else if(msg.role === 'assistant' && msg.cardType === 'prompt_suggestion' && msg.text){
        cardHtml = `<div class="agent-prompt-suggest-card"><div class="agent-prompt-suggest-body">${escapeHtml(msg.text)}</div><div class="agent-analysis-actions"><button class="agent-quick-btn primary" type="button" data-agent-card-gen="1"><i data-lucide="palette"></i><span>直接生图</span></button><button class="agent-quick-btn" type="button" data-agent-copy="${escapeHtml(msg.id)}"><i data-lucide="copy"></i><span>复制</span></button></div></div>`;
    }
    // 用户消息：按输入框混排回显图片字符；旧消息才退回缩略图
    let bubbleHtml = '';
    let imgsHtml = '';
    let skillsHtml = '';
    if(msg.role === 'user'){
        const skillNames = agentNormalizeSkillList(Array.isArray(msg.skills) ? msg.skills : [])
            .map(s => String(s?.name || s?.presetId || s?.id || '').trim())
            .filter(Boolean);
        // 顺手修复历史消息里已缓存的乱码 skill 名
        if(Array.isArray(msg.skills)) msg.skills = agentNormalizeSkillList(msg.skills);
        if(skillNames.length){
            skillsHtml = `<div class="agent-msg-skills" title="本轮使用的 Skill"><span class="agent-msg-skills-label">已使用 Skill</span>${skillNames.map(n => `<span class="agent-msg-skill-tag"><i data-lucide="sparkles"></i><span>${escapeHtml(n)}</span></span>`).join('')}</div>`;
        } else if(Array.isArray(msg.skills) && msg.skills.length){
            skillsHtml = `<div class="agent-msg-skills" title="本轮使用的 Skill"><span class="agent-msg-skills-label">已使用 Skill</span><span class="agent-msg-skill-tag"><i data-lucide="sparkles"></i><span>Skill x${msg.skills.length}</span></span></div>`;
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : null;
        const hasParts = !!(parts && parts.some(p => p && ((p.type==='image' && p.url) || (p.type==='text' && String(p.text||'').trim()))));
        if(hasParts){
            let imgN = 0;
            const rich = parts.map((part, partIndex) => {
                if(part?.type === 'image' && part.url){
                    imgN += 1;
                    return agentRenderInlineChipHtml(part, part.refIndex || imgN);
                }
                let richText = String(part?.text || '')
                    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
                    .replace(/\u00a0/g, ' ');
                if(parts[partIndex - 1]?.type === 'image') richText = richText.replace(/^\s+/, '');
                if(parts[partIndex + 1]?.type === 'image') richText = richText.replace(/\s+$/, '');
                if(!richText) return '';
                return `<span class="agent-msg-rich-text">${escapeHtml(richText).replace(/\n/g, '<br>')}</span>`;
            }).join('');
            bubbleHtml = `<div class="agent-msg-bubble agent-msg-bubble-rich">${rich}${msg.statusLabel ? `<span class="agent-steer-status">${escapeHtml(msg.statusLabel)}</span>` : ''}</div>`;
        } else {
            bubbleHtml = msg.text ? `<div class="agent-msg-bubble">${escapeHtml(msg.text)}${msg.statusLabel ? `<span class="agent-steer-status">${escapeHtml(msg.statusLabel)}</span>` : ''}</div>` : '';
            const imgs = (msg.images || []).filter(i => i?.url).map((i, idx) => agentRenderInlineChipHtml(i, i.refIndex || (idx+1))).join(' ');
            if(imgs) imgsHtml = `<div class="agent-msg-inline-refs">${imgs}</div>`;
        }
    } else {
        let understandingText = String(msg.understanding || '').trim();
        const hasGenCards = Array.isArray(msg.generations) && msg.generations.length > 0;
        const isPlanMsg = msg.stage === 'plan' || !!msg.pendingPlan || hasGenCards || !!msg.plan || !!msg.awaitingExecuteConfirm || !!msg.fromStageContinue;
        // 历史脏数据：规划/执行消息若误挂了策划正文，渲染前清掉
        if(understandingText && (hasGenCards || msg.stage === 'plan' || msg.awaitingExecuteConfirm || msg.fromStageContinue || msg.pendingPlan)){
            understandingText = '';
            try{ msg.understanding = ''; if(!msg.stage) msg.stage = 'plan'; }catch(_){ }
        }
        let understandingHtml = '';
        // 仅阶段1策划/策划门禁展示“策划”折叠；阶段2有步骤卡片时不重复折叠
        if(understandingText && !hasGenCards){
            const shortU = understandingText.length > 120 ? (understandingText.slice(0, 120) + '…') : understandingText;
            const kicker = isPlanMsg ? '规划' : '策划';
            const foldKind = kicker === '规划' ? 'plan' : 'understand';
            understandingHtml = `<details class="agent-understanding" data-agent-plan-fold="1" data-fold-kind="${foldKind}" data-agent-plan-message-id="${escapeHtml(msg.id || '')}"><summary class="agent-understanding-summary"><span class="agent-understanding-kicker">${kicker}</span><span class="agent-understanding-preview">${escapeHtml(shortU)}</span></summary><div class="agent-understanding-body">${escapeHtml(understandingText)}</div></details>`;
        }
        
const mainText = (msg.text && !cardHtml) ? String(msg.text) : '';
        const mainTrim = String(mainText || '').trim();
        const showMain = !!mainTrim && mainTrim !== understandingText && !(understandingText && mainTrim.startsWith(understandingText.slice(0, Math.min(48, understandingText.length))));
        bubbleHtml = `${understandingHtml}${showMain ? `<div class="agent-msg-bubble">${escapeHtml(mainText)}${msg.statusLabel ? `<span class="agent-steer-status">${escapeHtml(msg.statusLabel)}</span>` : ''}</div>` : (!understandingHtml && mainText ? `<div class="agent-msg-bubble">${escapeHtml(mainText)}${msg.statusLabel ? `<span class="agent-steer-status">${escapeHtml(msg.statusLabel)}</span>` : ''}</div>` : '')}`;
        const imgs = (msg.images || []).filter(i => i?.url).map(i => `<img src="${escapeHtml(i.url)}" alt="" loading="lazy">`).join('');
        if(imgs) imgsHtml = `<div class="agent-msg-thumbs">${imgs}</div>`;
    }
    return `<div class="agent-msg ${msg.role === 'user' ? 'user' : 'assistant'}">${skillsHtml}${bubbleHtml}${cardHtml}${imgsHtml}${executionPromptsHtml}${gens}${workflowLogHtml}${promptCardHtml}${optionsHtml}${contextSourceHtml}${actions}</div>`;
}
function agentEmptyStateHtml(){
    if(agentCurrentInputMode() === 'image'){
        return `<div class="agent-empty agent-empty-image"><i data-lucide="image"></i><strong>图像模式</strong><span>上传参考图并输入最终提示词，发送后将直接生图，不经过 LLM。</span></div>`;
    }
    const skills = agentNormalizeSkillList(agentSkillPresets || []).slice(0, 8);
    if(!skills.length) return `<div class="agent-empty"><i data-lucide="bot"></i>${escapeHtml(tr('smart.agentEmpty'))}</div>`;
    const chips = skills.map(skill => `<button type="button" class="agent-empty-skill" data-agent-empty-skill="${escapeHtml(skill.id || skill.presetId || '')}" title="引用 ${escapeHtml(skill.name || 'Skill')}"><i data-lucide="sparkles"></i><span>${escapeHtml(skill.name || '未命名 Skill')}</span></button>`).join('');
    return `<div class="agent-empty agent-empty-skills"><strong>试试这些 Skills</strong><div class="agent-empty-skill-grid">${chips}<button type="button" class="agent-empty-skill all" data-agent-empty-all-skills="1"><i data-lucide="book-open"></i><span>所有 Skills</span></button></div></div>`;
}
function agentHasComposerContent(){
    const text = String(agentGetInputValue() || '').replace(/[\u200b\u200c\u200d\ufeff]/g,'').trim();
    const atts = (agentState?.attachments || []).filter(a => a?.url);
    return Boolean(text || atts.length);
}
function updateAgentPrimaryAction(){
    if(!agentSendBtn) return;
    // 只有两种形态：发送 / 停止
    const hasContent = agentHasComposerContent();
    const currentConversationId = agentState?.activeConversationId || '';
    const blockedByOther = agentGlobalTaskOwnedByOther(currentConversationId);
    const stopping = !blockedByOther && agentActiveWorkflow?.status === 'stopping';
    const running = !blockedByOther && ((typeof agentIsTaskBusy === 'function')
        ? agentIsTaskBusy()
        : (agentSending || ['planning','creating_nodes','ready','running','stopping'].includes(agentActiveWorkflow?.status)));
    const action = stopping ? 'stopping' : running ? 'stop' : (hasContent ? 'send' : 'idle');
    agentSendBtn.dataset.agentAction = action;
    agentSendBtn.dataset.agentBlockedByOther = blockedByOther ? '1' : '0';
    agentSendBtn.disabled = action === 'idle' || action === 'stopping';
    agentSendBtn.classList.toggle('is-stop', action === 'stop' || action === 'stopping');
    agentSendBtn.classList.remove('is-steer');
    const live = document.getElementById('agentStatusLive');
    if(live){
        const nextStatus = action === 'stopping'
            ? '正在停止当前任务'
            : (action === 'stop'
                ? '当前任务正在执行，可按停止按钮中止'
                : (blockedByOther ? '另一个对话正在执行，当前对话暂不可发送' : ''));
        if(live.textContent !== nextStatus) live.textContent = nextStatus;
    }
    const actionLabel = action === 'stop' ? '停止当前任务'
        : action === 'stopping' ? '正在停止'
        : blockedByOther ? '另一个对话正在执行，暂不可发送'
        : '发送';
    agentSendBtn.title = actionLabel;
    agentSendBtn.setAttribute('aria-label', actionLabel);
    agentSendBtn.setAttribute('aria-busy', action === 'stopping' ? 'true' : 'false');
    agentSendBtn.setAttribute('aria-disabled', agentSendBtn.disabled ? 'true' : 'false');
    agentSendBtn.innerHTML = (action === 'stop' || action === 'stopping')
        ? '<i data-lucide="square" aria-hidden="true"></i>'
        : '<i data-lucide="send" aria-hidden="true"></i>';
    if(window.lucide) lucide.createIcons({ nodes: [agentSendBtn] });
}
function renderAgentMessages(){
    try{ if(agentMessages){ agentMessages.dataset.agentRendered = '1'; agentMessages.dataset.agentDirty = '0'; } }catch(_){ }

    if(!agentMessages || !agentState) return;
    const previousScrollTop = agentMessages.scrollTop;
    const wasNearBottom = agentMessages.scrollHeight - agentMessages.scrollTop - agentMessages.clientHeight <= 72;
    const msgs = agentState.messages || [];
    // 确保 prompts 状态一致（兼容旧数据、恢复 current 指针）
    msgs.forEach(m => {
        if(m.role === 'assistant' && Array.isArray(m.prompts) && m.prompts.length > 0){
            ensureCurrentPrompt(m);
        }
    });
    if(!msgs.length && !agentThinking){
        agentMessages.innerHTML = agentEmptyStateHtml();
    } else {
        const showThinking = agentThinking && (!agentThinkingConversationId || agentThinkingConversationId === (agentState.activeConversationId || ''));
        const thinkingLabel = agentThinkingStage === 'understand'
            ? '正在策划…'
            : (agentThinkingStage === 'plan' ? '正在根据策划规划执行…' : tr('smart.agentThinking'));
        const thinking = showThinking ? `<div class="agent-msg assistant"><div class="agent-msg-bubble"><span class="agent-gen-spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>${escapeHtml(thinkingLabel)}</div></div>` : '';
        agentMessages.innerHTML = msgs.map(agentMessageHtml).join('') + thinking;
    }
    if(window.lucide) lucide.createIcons();
    agentMessages.querySelectorAll('[data-agent-empty-skill]').forEach(btn => {
        btn.onclick = () => {
            const skill = agentSkillPresets.find(item => String(item.id || item.presetId || '') === btn.dataset.agentEmptySkill);
            if(skill){
                agentSetInputMode('agent');
                applyAgentSkillPreset(skill, {stripSlash:false, closeManager:true});
                agentFocusComposer();
            }
        };
    });
    agentMessages.querySelector('[data-agent-empty-all-skills]')?.addEventListener('click', () => openAgentSkillManager());
    try{ agentBindPlanFoldInteractions(agentMessages); }catch(_){ }
    // 用户在读旧消息时保持当前位置；只有原本接近底部才跟随新消息。
    requestAnimationFrame(() => {
        if(!agentMessages) return;
        agentMessages.scrollTop = wasNearBottom ? agentMessages.scrollHeight : previousScrollTop;
    });
    updateAgentPrimaryAction();
    // 绑定消息操作按钮
    agentMessages.querySelectorAll('[data-agent-copy]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const msg = (agentState?.messages || []).find(m => m.id === btn.dataset.agentCopy);
            if(!msg) return;
            // 用户消息：复制“文字 + 图片符号”；助手：优先 prompt，其次正文
            agentCopyMessageRich(msg);
        };
    });
    agentMessages.querySelectorAll('[data-agent-retry]').forEach(btn => {
        btn.disabled = agentSending;
        btn.onclick = e => {
            e.stopPropagation();
            if(!agentSending) agentRetryMessage(btn.dataset.agentRetry);
        };
    });
    agentMessages.querySelectorAll('[data-agent-gen-retry]').forEach(btn => {
        const hardBusy = !!(window.__canvasAgentGenRunning)
            || ['planning','creating_nodes','ready','running','stopping'].includes(String(agentActiveWorkflow?.status || '').toLowerCase());
        btn.disabled = !!(agentSending && hardBusy);
        btn.onclick = event => {
            event.stopPropagation();
            event.preventDefault?.();
            retryAgentGeneration(btn.dataset.agentGenRetry, Number(btn.dataset.agentGenIndex));
        };
    });
    // 分析/提示词卡片的"用这个生图"按钮
    agentMessages.querySelectorAll('[data-agent-card-gen]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            if(agentSending) return;
            const cardEl = btn.closest('.agent-analysis-card, .agent-prompt-suggest-card');
            if(!cardEl) return;
            const bodyEl = cardEl.querySelector('.agent-analysis-body, .agent-prompt-suggest-body');
            const text = bodyEl?.textContent || '';
            // 提取"完整Prompt："后的内容，或用全文
            const promptMatch = text.match(/完整Prompt[：:]\s*([\s\S]+)/i);
            const prompt = promptMatch ? promptMatch[1].trim() : text.trim();
            if(prompt) agentSendWithText(prompt);
        };
    });
    // 任务运行时输入框与会话切换保持可用；只锁定会重复修改当前回复的消息内操作。
    // 绑定选项按钮事件
    agentMessages.querySelectorAll('[data-agent-option]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            if(agentSending) return;
            const value = btn.dataset.agentOption;
            if(value === 'AGENT_CONTINUE_PLAN' || value === 'AGENT_SWITCH_AUTO_PLAN' || value === 'AGENT_CONTINUE_EXECUTE' || value === 'AGENT_SWITCH_AUTO_EXECUTE' || value === 'AGENT_REVISE_PLANNING'){
                const gateMsg = (agentState?.messages || []).slice().reverse().find(m => m?.stageGate && Array.isArray(m.options) && m.options.some(o => o?.value === value));
                if(!gateMsg){
                    if(typeof toast === 'function') toast('未找到对应的确认步骤');
                    return;
                }
                if(value === 'AGENT_REVISE_PLANNING'){
                    agentStartRevisePlanning(gateMsg);
                    return;
                }
                if(value === 'AGENT_CONTINUE_PLAN' || value === 'AGENT_SWITCH_AUTO_PLAN'){
                    agentContinueFromUnderstanding(gateMsg, {forceAuto: value === 'AGENT_SWITCH_AUTO_PLAN'});
                    return;
                }
                if(value === 'AGENT_CONTINUE_EXECUTE' || value === 'AGENT_SWITCH_AUTO_EXECUTE'){
                    agentContinueFromPlanGate(gateMsg, {forceAuto: value === 'AGENT_SWITCH_AUTO_EXECUTE'});
                    return;
                }
            }

            if(value === '确认'){
                // 选项"确认"=全部确认并生成：将所有未跳过的 prompts 标记为 confirmed 并构建 generations
                const lastAssistantMsg = [...(agentState.messages || [])].reverse().find(m => m.role === 'assistant' && (m.prompts?.length || m.generations?.length));
                if(lastAssistantMsg){
                    const lastUserMsg = [...(agentState.messages || [])].reverse().find(m => m.role === 'user');
                    if(lastAssistantMsg.prompts?.length && !lastAssistantMsg.generations?.length){
                        // 将所有未跳过的 prompts 标记为 confirmed
                        lastAssistantMsg.prompts.forEach(p => {
                            if(p && typeof p === 'object' && p.status !== 'skipped'){
                                p.status = 'confirmed';
                            }
                        });
                        const confirmedPrompts = lastAssistantMsg.prompts.filter(p => p && typeof p === 'object' && p.status === 'confirmed');
                        // 构建 generations（透传属性）
                        lastAssistantMsg.generations = confirmedPrompts.map(p => {
                            const g = {
                                prompt:p.prompt,
                                count:p.count || 1,
                                use_last_outputs:!!p.use_last_outputs,
                                use_attachments:!!p.use_attachments,
                                results:[],
                                status:'running'
                            };
                            if(Array.isArray(p.attachment_indices)) g.attachment_indices = p.attachment_indices;
                            return g;
                        });
                    }
                    if(lastAssistantMsg.generations?.length){
                        runAgentGenerations(lastAssistantMsg, lastUserMsg);
                    }
                }
            } else {
                // 发送文本给 LLM，补全原始请求上下文（带数量信息）
                const lastUserMsg = [...(agentState.messages || [])].reverse().find(m => m.role === 'user');
                const originalRequest = lastUserMsg ? String(lastUserMsg.text || '').trim() : '';
                // 检测"自定义输入"类选项 → 只focus输入框，不发送
                const isCustomInput = /自定义|其他|custom|other|手动/i.test(value) || /自定义|其他|custom|other|手动/i.test(btn.textContent || '');
                if(isCustomInput){
                    if(agentInput){ agentClearComposer(); agentFocusComposer(); }
                    return;
                }
                const sendText = originalRequest && originalRequest !== value ? `${originalRequest}，选择：${value}` : value;
                if(agentInput){
                    agentSetInputValue(sendText);
                    agentInput.focus();
                }
                sendAgentMessage();
            }
        };
    });
    // 绑定提示词确认卡片按钮事件
    agentMessages.querySelectorAll('[data-agent-prompt-action]').forEach(btn => {
        btn.disabled = agentSending;
        btn.onclick = e => {
            e.stopPropagation();
            if(agentSending && btn.dataset.agentPromptAction !== 'cancel-edit') return;
            const action = btn.dataset.agentPromptAction;
            const msgId = btn.dataset.agentPromptId;
            const msg = (agentState.messages || []).find(m => m.id === msgId);
            if(!msg) return;
            if(action === 'confirm') confirmAgentPrompt(msg);
            else if(action === 'regenerate') regenerateAgentPrompts(msg);
            else if(action === 'edit') editAgentPrompt(msg);
            else if(action === 'save-edit') saveAgentPromptEdit(msg);
            else if(action === 'cancel-edit') cancelAgentPromptEdit(msg);
            else if(action === 'confirm-all') confirmAllAgentPrompts(msg);
            else if(action === 'cancel-all') cancelAllAgentPrompts(msg);
        };
    });
    // 绑定已确认/已跳过项的点击反悔事件
    agentMessages.querySelectorAll('[data-agent-prompt-reopen]').forEach(item => {
        item.onclick = e => {
            e.stopPropagation();
            if(agentSending) return;
            const msgId = item.dataset.agentPromptReopen;
            const idx = Number(item.dataset.agentPromptIndex);
            const msg = (agentState.messages || []).find(m => m.id === msgId);
            if(!msg) return;
            reopenAgentPrompt(msg, idx);
        };
    });
    // 绑定生成图片点击跳转事件
    agentMessages.querySelectorAll('[data-agent-gen-jump]').forEach(jumpButton => {
        jumpButton.onclick = e => {
            e.stopPropagation();
            const nodeId = jumpButton.dataset.agentGenJump;
            const x = Number(jumpButton.dataset.agentGenX) || 0;
            const y = Number(jumpButton.dataset.agentGenY) || 0;
            const url = jumpButton.querySelector('img')?.src || '';
            // 优先通过 nodeId 查找
            if(nodeId){
                const node = (nodes || []).find(n => n.id === nodeId);
                if(node){
                    selectedId = node.id;
                    selectedIds = [];
                    agentCenterOnNode(node);
                    render();
                    return;
                }
            }
            // 没有 nodeId 时通过 url 查找节点
            if(url){
                const node = (nodes || []).find(n => isSmartImageNode(n) && agentNodeImages(n).some(img => img?.url && url.includes(img.url)));
                if(node){
                    selectedId = node.id;
                    selectedIds = [];
                    agentCenterOnNode(node);
                    render();
                    return;
                }
            }
            // 最后通过坐标跳转
            if(x || y) agentCenterOnPoint(x, y);
        };
    });
    // 绑定提示词展开/收起事件
    agentMessages.querySelectorAll('[data-agent-prompt-toggle]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const promptDiv = btn.closest('[data-agent-gen-prompt]');
            if(!promptDiv) return;
            const isCollapsed = promptDiv.classList.contains('agent-gen-prompt-collapsed');
            if(isCollapsed){
                promptDiv.classList.remove('agent-gen-prompt-collapsed');
                promptDiv.classList.add('agent-gen-prompt-expanded');
                btn.textContent = tr('smart.agentCollapse') || '收起';
            } else {
                promptDiv.classList.remove('agent-gen-prompt-expanded');
                promptDiv.classList.add('agent-gen-prompt-collapsed');
                btn.textContent = tr('smart.agentExpand') || '展开';
            }
        };
    });
    // 执行日志折叠/展开
    agentMessages.querySelectorAll('[data-agent-log-toggle]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const box = btn.closest('[data-agent-workflow-log]');
            if(!box) return;
            const collapsed = box.classList.contains('is-collapsed');
            if(collapsed){
                box.classList.remove('is-collapsed');
                box.classList.add('is-expanded');
                btn.setAttribute('aria-expanded', 'true');
            } else {
                box.classList.remove('is-expanded');
                box.classList.add('is-collapsed');
                btn.setAttribute('aria-expanded', 'false');
            }
        };
    });
    // 点击提示词区域也可展开/收起
    agentMessages.querySelectorAll('[data-agent-gen-prompt]').forEach(div => {
        div.onclick = e => {
            if(e.target.closest('[data-agent-prompt-toggle]')) return;
            const btn = div.querySelector('[data-agent-prompt-toggle]');
            if(btn) btn.click();
        };
    });
}
function agentLastResults(){
    const msgs = agentState?.messages || [];
    for(let i = msgs.length - 1; i >= 0; i--){
        const results = (msgs[i].generations || []).flatMap(g => (g.results || []).filter(r => r?.url));
        if(results.length) return results;
    }
    return [];
}
function agentLastUserAttachments(){
    const msgs = agentState?.messages || [];
    for(let i = msgs.length - 1; i >= 0; i--){
        if(msgs[i].role === 'user' && (msgs[i].images || []).some(img => img?.url)) return msgs[i].images.filter(img => img?.url);
    }
    return [];
}
function agentCurrentImageMap(){
    // 统一编号映射：上一轮生成图(图1~图M) + 当前附件(图M+1~图M+N)
    const genResults = agentLastResults();
    const attachments = (agentState?.attachments || []).filter(a => a?.url);
    const map = [];
    genResults.forEach((r, i) => map.push({num: i + 1, url: r.url, name: r.name || `图${i + 1}`, source: 'gen'}));
    const offset = genResults.length;
    attachments.forEach((a, i) => map.push({num: offset + i + 1, url: a.url, name: a.name || `图${offset + i + 1}`, source: 'att'}));
    return map;
}
function agentGetConversationById(id){
    if(!agentState || !id || !Array.isArray(agentState.conversations)) return null;
    return agentState.conversations.find(c => c.id === id) || null;
}
function agentEnsureConversationMessages(conversationId){
    if(!conversationId) return null;
    // 当前活动对话：以 agentState.messages 为准，并镜像回 conversations
    if(conversationId === agentState.activeConversationId){
        if(!Array.isArray(agentState.messages)) agentState.messages = [];
        const conv = agentGetConversationById(conversationId);
        if(conv) conv.messages = agentState.messages;
        return agentState.messages;
    }
    const conv = agentGetConversationById(conversationId);
    if(!conv) return null;
    if(!Array.isArray(conv.messages)) conv.messages = [];
    return conv.messages;
}
function agentPushMessageToConversation(conversationId, msg){
    try{ if(agentMessages) agentMessages.dataset.agentDirty = '1'; }catch(_){ }

    if(!msg) return false;
    const cid = conversationId || agentState?.activeConversationId || '';
    if(!cid){
        if(!Array.isArray(agentState.messages)) agentState.messages = [];
        if(!agentState.messages.includes(msg)) agentState.messages.push(msg);
        agentState.messages = agentState.messages.slice(-AGENT_MSG_MAX);
        return true;
    }
    msg.conversationId = cid;
    const msgs = agentEnsureConversationMessages(cid);
    if(!msgs) return false;
    if(!msgs.includes(msg)) msgs.push(msg);
    // 截断并写回
    const sliced = msgs.slice(-AGENT_MSG_MAX);
    if(cid === agentState.activeConversationId){
        agentState.messages = sliced;
        const conv = agentGetConversationById(cid);
        if(conv) conv.messages = agentState.messages;
    }else{
        const conv = agentGetConversationById(cid);
        if(conv) conv.messages = sliced;
    }
    try{ agentRefreshConversationMemory(cid); }catch(_){ }
    return true;
}
function agentIsActiveConversation(conversationId){
    if(!conversationId) return true;
    return conversationId === (agentState?.activeConversationId || '');
}
function agentConversationWorkflow(conversationId=''){
    const cid = conversationId || agentState?.activeConversationId || '';
    if(!cid || agentIsActiveConversation(cid)) return agentActiveWorkflow || null;
    return agentGetConversationById(cid)?.workflow || null;
}
function agentSetConversationWorkflow(conversationId='', workflow=null){
    const cid = conversationId || agentState?.activeConversationId || '';
    if(cid){
        const conv = agentGetConversationById(cid);
        if(conv) conv.workflow = workflow || null;
    }
    // agentActiveWorkflow 始终只代表当前正在查看的对话。
    if(!cid || agentIsActiveConversation(cid)) agentActiveWorkflow = workflow || null;
    return workflow || null;
}
function agentPatchConversationWorkflow(conversationId='', mutator=null){
    const workflow = agentConversationWorkflow(conversationId);
    if(!workflow) return null;
    if(typeof mutator === 'function') mutator(workflow);
    else if(mutator && typeof mutator === 'object') Object.assign(workflow, mutator);
    return agentSetConversationWorkflow(conversationId, workflow);
}
function agentRenderConversation(conversationId, opts={}){
    // 只刷新当前正在看的对话，避免后台任务把结果画到新对话上
    if(agentIsActiveConversation(conversationId)){
        if(opts.thinking === true) agentThinking = true;
        if(opts.thinking === false) agentThinking = false;
        renderAgentMessages();
        if(opts.save !== false) saveAgentState();
    }else{
        // 后台对话：只持久化，不碰当前 UI
        try{
            const conv = agentGetConversationById(conversationId);
            if(conv){
                // 确保 memory 快照更新
                agentNormalizeConversation(conv);
            }
            saveAgentState();
        }catch(_){}
    }
}
let agentThinkingConversationId = '';

function agentEmptyConversationMemory(){
    return {summary:'', facts:[], lastPlan:null, lastSharedStyle:'', notes:[]};
}
function agentSanitizePlanMemory(plan){
    if(!plan || typeof plan !== 'object') return null;
    const out = {};
    const goal = agentContextRedactText(plan.goal || '', 320);
    if(goal) out.goal = goal;
    ['steps_summary', 'constraints'].forEach(key => {
        if(!Array.isArray(plan[key])) return;
        const values = plan[key].slice(0, 12).map(value => agentContextRedactText(value, 220)).filter(Boolean);
        if(values.length) out[key] = values;
    });
    if(Array.isArray(plan.artifacts)){
        const artifacts = plan.artifacts.slice(0, 12).map(item => ({
            id:agentContextRedactText(item?.id || '', 80),
            type:agentContextRedactText(item?.type || '', 48),
            title:agentContextRedactText(item?.title || '', 160),
            description:agentContextRedactText(item?.description || '', 260)
        })).filter(item => item.id || item.title || item.description);
        if(artifacts.length) out.artifacts = artifacts;
    }
    return Object.keys(out).length ? out : null;
}
function agentSanitizeConversationMemory(memory){
    const source = memory && typeof memory === 'object' ? memory : {};
    return {
        summary:agentContextRedactText(source.summary || '', 1000),
        facts:Array.isArray(source.facts) ? source.facts.slice(-12).map(item => ({
            k:agentContextRedactText(item?.k || '', 80),
            v:agentContextRedactText(item?.v || '', 260),
            ts:Number(item?.ts) || 0
        })).filter(item => item.k || item.v) : [],
        lastPlan:agentSanitizePlanMemory(source.lastPlan),
        lastSharedStyle:agentContextRedactText(source.lastSharedStyle || '', 1200),
        notes:Array.isArray(source.notes) ? source.notes.slice(-8).map(note => agentContextRedactText(note, 260)).filter(Boolean) : []
    };
}
function agentNormalizeConversation(conv){
    if(!conv || typeof conv !== 'object') return null;
    if(!Array.isArray(conv.messages)) conv.messages = [];
    if(!Array.isArray(conv.attachments)) conv.attachments = [];
    if(!Array.isArray(conv.skills)) conv.skills = [];
    conv.skills = agentNormalizeSkillList(conv.skills);
    conv.messages = conv.messages.map(msg => {
        if(!msg || typeof msg !== 'object') return msg;
        if(Array.isArray(msg.skills)) msg.skills = agentNormalizeSkillList(msg.skills);
        return msg;
    });
    conv.memory = agentSanitizeConversationMemory(conv.memory);
    conv.draft = agentSanitizeComposerDraft(conv.draft);
    if(conv.workflow === undefined) conv.workflow = null;
    if(conv.pending === undefined) conv.pending = null;
    return conv;
}
function agentRefreshConversationMemory(conversationId){
    const conv = agentGetConversationById(conversationId);
    if(!conv) return null;
    agentNormalizeConversation(conv);
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const reversed = messages.slice().reverse();
    const lastUser = reversed.find(message => message?.role === 'user' && String(message?.text || '').trim());
    const lastPlanMessage = reversed.find(message => message?.plan && typeof message.plan === 'object');
    const lastStyleMessage = reversed.find(message => String(message?.shared_style || '').trim());
    const lastFactsMessage = reversed.find(message => message?.collected && typeof message.collected === 'object' && Object.keys(message.collected).length);
    const lastExecutionMessage = reversed.find(message => Array.isArray(message?.generations) && message.generations.length);
    if(lastPlanMessage?.plan) conv.memory.lastPlan = agentSanitizePlanMemory(lastPlanMessage.plan);
    if(lastStyleMessage?.shared_style) conv.memory.lastSharedStyle = agentContextRedactText(lastStyleMessage.shared_style, 1200);
    if(lastFactsMessage?.collected){
        conv.memory.facts = Object.entries(lastFactsMessage.collected)
            .slice(-12)
            .map(([k, v]) => ({k:agentContextRedactText(k, 80), v:agentContextRedactText(v, 260), ts:Date.now()}));
    }
    const summaryParts = [];
    if(lastUser?.text) summaryParts.push(`最近要求：${agentContextRedactText(lastUser.text, 320)}`);
    const planGoal = agentContextRedactText(lastPlanMessage?.plan?.goal || '', 240);
    if(planGoal) summaryParts.push(`最近规划目标：${planGoal}`);
    if(lastExecutionMessage){
        const generations = lastExecutionMessage.generations || [];
        const completed = generations.filter(gen => ['done','completed','success','succeeded'].includes(String(gen?.status || '').toLowerCase())).length;
        const failed = generations.filter(gen => ['error','failed','stopped','cancelled'].includes(String(gen?.status || '').toLowerCase())).length;
        const images = generations.reduce((sum, gen) => sum + (Array.isArray(gen?.results) ? gen.results.filter(item => item?.url).length : 0), 0);
        summaryParts.push(`最近执行：${completed}/${generations.length} 步完成，${failed} 步失败，得到 ${images} 张图`);
    }
    if(summaryParts.length) conv.memory.summary = agentContextRedactText(summaryParts.join('；'), 1000);
    conv.memory = agentSanitizeConversationMemory(conv.memory);
    return conv.memory;
}
function agentClearTransientComposerUi(){
    try{ clearAgentGhostAttachment({rerender:false}); }catch(_){}
    try{ hideAgentSkillSlash(); }catch(_){}
    try{ hideAgentMention?.(); }catch(_){}
    try{
        const slash = document.getElementById('agentSkillSlashPanel');
        if(slash) slash.hidden = true;
        const mention = document.getElementById('agentMentionPanel');
        if(mention) mention.hidden = true;
        const chatList = document.getElementById('agentChatListPanel');
        if(chatList) chatList.hidden = true;
        const more = document.getElementById('agentMorePanel');
        if(more) more.hidden = true;
        const modelPanel = document.getElementById('agentModelPanel');
        if(modelPanel) modelPanel.hidden = true;
    }catch(_){}
}
function agentEnsureActiveConversation(){
    if(!agentState) return null;
    if(!Array.isArray(agentState.conversations)) agentState.conversations = [];
    let conv = null;
    if(agentState.activeConversationId){
        conv = agentState.conversations.find(c => c.id === agentState.activeConversationId) || null;
    }
    if(!conv && agentState.conversations.length){
        conv = agentNormalizeConversation(agentState.conversations[0]);
        agentState.activeConversationId = conv.id;
        agentState.conversations[0] = conv;
        return conv;
    }
    if(!conv){
        const seedMessages = Array.isArray(agentState.messages) ? agentState.messages.slice(-AGENT_MSG_MAX) : [];
        conv = agentNormalizeConversation({
            id: uid('ac'),
            title: seedMessages.find(m => m?.role==='user' && m?.text)?.text?.slice?.(0,30) || '对话',
            messages: seedMessages,
            attachments: Array.isArray(agentState.attachments) ? agentState.attachments.slice() : [],
            skills: Array.isArray(agentState.skills) ? agentState.skills.map(s => ({...s})) : [],
            draft: '',
            workflow: agentActiveWorkflow || null,
            pending: null,
            memory: agentEmptyConversationMemory(),
            ts: Date.now(),
            updatedAt: Date.now()
        });
        agentState.conversations.unshift(conv);
        agentState.activeConversationId = conv.id;
        if(!Array.isArray(agentState.messages) || !agentState.messages.length){
            agentState.messages = conv.messages.slice();
        }
    }
    return conv;
}
function agentCaptureActiveConversation(){
    if(!agentState) return null;
    try{ agentEnsureActiveConversation(); }catch(_){}
    if(!agentState.activeConversationId) return null;
    if(!Array.isArray(agentState.conversations)) agentState.conversations = [];
    let conv = agentState.conversations.find(c => c.id === agentState.activeConversationId);
    if(!conv){
        conv = {id:agentState.activeConversationId, title:'对话', messages:[], ts:Date.now()};
        agentState.conversations.unshift(conv);
    }
    agentNormalizeConversation(conv);
    conv.messages = (agentState.messages || []).slice(-AGENT_MSG_MAX);
    try{
        // agentGetInputValue 已经会跳过图片字符；空字符串是合法结果，不能再回退到
        // textContent，否则会把芯片的“参考图1×”误存为下一次待发送草稿。
        conv.draft = agentSanitizeComposerDraft(typeof agentGetInputValue === 'function' ? agentGetInputValue() : '');
    }catch(_){ conv.draft = agentSanitizeComposerDraft(conv.draft); }
    conv.attachments = (agentState.attachments || []).slice();
    conv.skills = (Array.isArray(agentState.skills) ? agentState.skills : []).map(s => ({...s}));
    conv.workflow = agentActiveWorkflow || null;
    conv.memory = agentNormalizeConversation(conv).memory;
    // 从当前对话消息提炼轻量记忆；后台任务写回同一 conversation 时也走同一逻辑。
    try{ agentRefreshConversationMemory(conv.id); }catch(_){}
    // pending 的运行时真相是 conversation map；旧全局字段只是当前对话镜像。
    const pending = agentGetConversationPending(conv.id);
    conv.pending = pending ? {...pending} : null;
    // 标题：首条用户消息
    if(!conv.title || conv.title === '新对话' || conv.title === '对话'){
        const firstUser = (conv.messages || []).find(m => m.role === 'user' && m.text);
        if(firstUser?.text) conv.title = String(firstUser.text).slice(0, 30);
    }
    conv.ts = conv.ts || Date.now();
    conv.updatedAt = Date.now();
    return conv;
}
function agentApplyConversation(conv){
    agentNormalizeConversation(conv);
    agentState.activeConversationId = conv.id;
    agentState.messages = (conv.messages || []).slice(-AGENT_MSG_MAX);
    agentState.attachments = Array.isArray(conv.attachments) ? conv.attachments.slice() : [];
    agentState.skills = Array.isArray(conv.skills) ? conv.skills.map(s => ({...s})) : [];
    agentActiveWorkflow = conv.workflow || null;
    agentSending = ['planning','creating_nodes','ready','running','stopping'].includes(agentActiveWorkflow?.status);
    // 仅当 thinking 属于当前对话时才显示；其他对话后台任务不占用当前 UI
    agentThinking = (agentThinkingConversationId && agentThinkingConversationId === conv.id) ? true : false;
    // 切换对话时只切换兼容镜像，不移动或删除其他对话的 pending/revise/stream。
    const pending = agentGetConversationPending(conv.id)
        || (conv.pending && conv.pending.conversationId === conv.id ? agentSetConversationPending(conv.id, conv.pending, {replace:true}) : null);
    agentMirrorLegacyPending(conv.id, pending);
    agentMirrorLegacyRevisePlanning(conv.id);
    agentSyncLegacyStream(conv.id);
    agentClearTransientComposerUi();
    if(agentInput) agentSetInputValue(String(conv.draft || ''));
    renderAgentAttachments();
    renderAgentMessages();
    updateAgentPrimaryAction();
}

// 画布/插件重启后，持久化的运行态不能继续充当“当前正在执行”的事实。
// 后端的内存任务表会随服务重启清空；如果原样恢复 workflow/generations，
// 面板会一打开就显示“停止/执行中”，并尝试轮询已经不存在的旧 taskId。
// 保留对话、策划和已完成结果，只清理真正的瞬时运行字段，等待用户手动重试。
function agentResetPersistedRuntimeOnStartup(){
    if(!agentState) return false;
    const activeStatuses = new Set(['planning','analyzing','creating_nodes','ready','running','stopping']);
    let changed = false;
    const conversations = Array.isArray(agentState.conversations) ? agentState.conversations : [];
    conversations.forEach(conv => {
        if(!conv || typeof conv !== 'object') return;
        const workflow = conv.workflow;
        if(workflow && activeStatuses.has(String(workflow.status || '').toLowerCase())){
            conv.workflow = {
                ...workflow,
                status:'interrupted',
                error:'画布重启后未自动恢复上次任务，请按需手动重试',
                activeTaskIds:[],
                updatedAt:Date.now()
            };
            changed = true;
        }
        const messages = Array.isArray(conv.messages) ? conv.messages : [];
        messages.forEach(msg => {
            if(!msg || msg.role !== 'assistant' || !Array.isArray(msg.generations)) return;
            msg.generations.forEach(gen => {
                if(!gen || !activeStatuses.has(String(gen.status || '').toLowerCase())) return;
                gen.status = 'stopped';
                gen.error = '画布重启后任务已中断，可在节点中手动重试';
                gen.taskIds = [];
                gen.pending = 0;
                changed = true;
                // 占位节点属于本轮瞬时 UI 状态，不能在重启后继续显示读秒。
                const placeholderId = String(gen.placeholderNodeId || '');
                if(placeholderId && typeof nodes !== 'undefined' && Array.isArray(nodes)){
                    const node = nodes.find(item => item?.id === placeholderId);
                    if(node){
                        node.pending = 0;
                        node.running = false;
                        node.runTimerHidden = false;
                        delete node.pendingTasks;
                    }
                }
            });
        });
        // pending LLM/image 任务只用于跨刷新恢复；服务重启后必须释放。
        // 旧版本可能只留下 _pendingRequestId（没有 message/taskId），也必须
        // 清掉，否则 agentPendingStore() 会在保存时把它重新合并回运行态。
        if(conv.pending && typeof conv.pending === 'object'){
            conv.pending = null;
            changed = true;
        }
    });
    const pendingStore = agentState._pendingByConversation;
    if(pendingStore && typeof pendingStore === 'object'){
        if(Object.keys(pendingStore).length){
            agentState._pendingByConversation = {};
            changed = true;
        }
    }
    ['_pendingRequestId','_pendingMessage','_pendingAttachments','_pendingUserMsg','_pendingLlmTaskId','_pendingLlmTaskTs','_pendingConversationId']
        .forEach(key => { if(agentState[key] !== undefined){ delete agentState[key]; changed = true; } });
    if(changed){
        const active = conversations.find(conv => conv?.id === agentState.activeConversationId);
        agentActiveWorkflow = active?.workflow || null;
        agentSending = false;
        agentThinking = false;
        agentThinkingStage = '';
        agentThinkingConversationId = '';
        agentGlobalTaskOwnerConversationId = '';
    }
    return changed;
}

function agentNewChat(){
    if(!agentState) return;
    // 保存并隔离当前对话（消息/附件/Skill/工作流/记忆/待恢复任务）
    agentCaptureActiveConversation();
    // 选图发送快照属于"当前对话 + 当前一次画布选图"的瞬态状态，不能随新对话
    // 继承。否则上一轮任务结束后宿主仍选中的输出节点，会在新对话点击发送时被
    // sendAgentMessage 的兜底逻辑重新注入，造成用户没有选择参考图却带上旧图。
    agentSendSelectionSnapshot = [];
    agentSelectionGestureUntil = 0;
    agentLastSelectionSig = '';
    agentGhostConfirmedSig = '';
    clearAgentGhostAttachment();
    const newConv = agentNormalizeConversation({
        id: uid('ac'),
        title: '新对话',
        messages: [],
        attachments: [],
        skills: [],
        runMode: 'auto',
        draft: '',
        workflow: null,
        pending: null,
        memory: agentEmptyConversationMemory(),
        ts: Date.now(),
        updatedAt: Date.now()
    });
    if(!Array.isArray(agentState.conversations)) agentState.conversations = [];
    agentState.conversations.unshift(newConv);
    agentApplyConversation(newConv);
    if(agentInput) agentClearComposer();
    renderAgentChatList();
    saveAgentState();
}
function agentDeleteChat(){
    if(!agentState || !agentState.activeConversationId) return;
    if(!Array.isArray(agentState.conversations)) agentState.conversations = [];
    const deletingId = agentState.activeConversationId;
    agentState.conversations = agentState.conversations.filter(c => c.id !== deletingId);
    if(agentState.conversations.length){
        agentApplyConversation(agentNormalizeConversation(agentState.conversations[0]));
    } else {
        const blank = agentNormalizeConversation({
            id: uid('ac'),
            title: '新对话',
            messages: [],
            attachments: [],
            skills: [],
            draft: '',
            workflow: null,
            pending: null,
            memory: agentEmptyConversationMemory(),
            ts: Date.now()
        });
        agentState.conversations = [blank];
        agentApplyConversation(blank);
        if(agentInput) agentClearComposer();
    }
    renderAgentChatList();
    saveAgentState();
}
function agentSwitchChat(id){
    if(!agentState || !id || id === agentState.activeConversationId) return;
    // 离开前完整快照当前对话，确保记忆与上下文不串
    agentCaptureActiveConversation();
    const target = (agentState.conversations || []).find(c => c.id === id);
    if(!target) return;
    agentApplyConversation(agentNormalizeConversation(target));
    renderAgentChatList();
    saveAgentState();
}
function formatAgentConversationDate(timestamp){
    const date = new Date(Number(timestamp) || 0);
    if(!Number.isFinite(date.getTime()) || date.getTime() <= 0) return {label:'', title:''};
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.round((today - day) / 86400000);
    let label = '';
    if(dayDiff === 0) label = '今天';
    else if(dayDiff === 1) label = '昨天';
    else if(date.getFullYear() === now.getFullYear()) label = `${date.getMonth() + 1}月${date.getDate()}日`;
    else label = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    const title = `创建于${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    return {label, title};
}
function renderAgentChatList(){
    const panel = document.getElementById('agentChatListPanel');
    if(!panel || !agentState) return;
    const convs = Array.isArray(agentState.conversations) ? agentState.conversations : [];
    if(!convs.length){
        panel.innerHTML = '<div class="agent-chat-empty">暂无对话</div>';
        return;
    }
    panel.innerHTML = convs.map(conv => {
        const isActive = conv.id === agentState.activeConversationId;
        const firstMsg = (conv.messages || []).find(m => m.role === 'user' && m.text);
        const title = firstMsg ? String(firstMsg.text).slice(0, 30) : (conv.title || '对话');
        const time = formatAgentConversationDate(conv.ts);
        return `<div class="agent-chat-item${isActive ? ' active' : ''}"><button class="agent-chat-item-select" type="button" data-chat-id="${escapeHtml(conv.id)}"${isActive ? ' aria-current="true"' : ''}><span class="agent-chat-item-title">${escapeHtml(title)}</span><span class="agent-chat-item-time" title="${escapeHtml(time.title)}">${escapeHtml(time.label)}</span></button><button class="agent-chat-item-delete" type="button" data-chat-delete="${escapeHtml(conv.id)}" aria-label="删除对话：${escapeHtml(title)}"><i data-lucide="x" aria-hidden="true"></i></button></div>`;
    }).join('');
    if(window.lucide) lucide.createIcons();
    panel.querySelectorAll('[data-chat-id]').forEach(btn => {
        btn.onclick = e => {
            if(e.target.closest('[data-chat-delete]')) return;
            agentSwitchChat(btn.dataset.chatId);
            panel.hidden = true;
        };
    });
    panel.querySelectorAll('[data-chat-delete]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const id = btn.dataset.chatDelete;
            if(id === agentState.activeConversationId) agentDeleteChat();
            else {
                agentState.conversations = agentState.conversations.filter(c => c.id !== id);
                renderAgentChatList();
                saveAgentState();
            }
        };
    });
}
function agentCopyMessage(text){
    if(!text) return;
    navigator.clipboard?.writeText(text).then(() => toast('已复制')).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('已复制');
    });
}
function agentBuildMessageCopyPayload(msg){
    if(!msg) return {text:'', html:''};
    // 助手：优先复制专业提示词
    if(msg.role === 'assistant'){
        const gens = msg.generations || [];
        const prompts = gens.map(g => String(g.professionalPrompt || g.prompt || '').trim()).filter(Boolean);
        if(prompts.length === 1){
            return {text: prompts[0], html: escapeHtml(prompts[0]).replace(/\n/g,'<br>')};
        }
        if(prompts.length > 1){
            const text = prompts.map((p,i) => `#${i+1}\n${p}`).join('\n\n');
            const html = prompts.map((p,i) => `<div><strong>#${i+1}</strong><br>${escapeHtml(p).replace(/\n/g,'<br>')}</div>`).join('');
            return {text, html};
        }
        const t = String(msg.text || '');
        return {text: t, html: escapeHtml(t).replace(/\n/g,'<br>')};
    }
    // 用户：保留图片符号（纯文本也嵌入可还原 token，避免粘贴只剩 [参考图1:image]）
    const parts = Array.isArray(msg.parts) ? msg.parts : null;
    const hasParts = !!(parts && parts.some(p => p && ((p.type==='image' && p.url) || (p.type==='text' && String(p.text||'').trim()))));
    if(hasParts){
        let text = '';
        let html = '';
        let imgN = 0;
        parts.forEach(part => {
            if(part?.type === 'image' && part.url){
                imgN += 1;
                const idx = part.refIndex || imgN;
                const name = part.name || part.label || (`Image${idx}`);
                text += agentEncodeRefToken({...part, name, refIndex: idx});
                html += agentRenderInlineChipHtml(part, idx);
            }else{
                const t = String(part?.text || '');
                text += t;
                html += escapeHtml(t).replace(/\n/g, '<br>');
            }
        });
        return {text, html, parts};
    }
    let outText = String(msg.text || '');
    let html = escapeHtml(outText).replace(/\n/g, '<br>');
    const imgs = (msg.images || []).filter(i => i?.url);
    if(imgs.length){
        let prefixText = '';
        let prefixHtml = '';
        imgs.forEach((img, i) => {
            const idx = img.refIndex || (i+1);
            const name = img.name || img.label || (`Image${idx}`);
            prefixText += agentEncodeRefToken({...img, name, refIndex: idx});
            prefixHtml += agentRenderInlineChipHtml(img, idx);
        });
        outText = prefixText + (outText ? (' ' + outText) : '');
        html = prefixHtml + html;
    }
    return {text: outText, html, parts: null};
}
function agentEncodeRefToken(att={}){
    const url = String(att.url || '').trim();
    if(!url) return '';
    const name = String(att.name || att.label || 'image').trim() || 'image';
    const nodeId = String(att.nodeId || '');
    const x = Number(att.x) || 0;
    const y = Number(att.y) || 0;
    const idx = Number(att.refIndex) || 0;
    // 人类可读 + 机器可还原；粘贴时优先解析 token
    const enc = (s) => encodeURIComponent(String(s ?? ''));
    return `[参考图${idx || 1}:${name}]{{agent-ref url="${enc(url)}" name="${enc(name)}" node="${enc(nodeId)}" x="${x}" y="${y}"}}`;
}
function agentParseRefTokensFromText(text=''){
    const raw = String(text || '');
    if(!raw) return [];
    const nodes = [];
    // 1) 新格式： [参考图1:name]{{agent-ref url="..." name="..." ...}}
    const re = /\[参考图\s*(\d+)\s*:\s*([^\]]*)\]\{\{agent-ref\s+url="([^"]*)"\s+name="([^"]*)"\s+node="([^"]*)"\s+x="([^"]*)"\s+y="([^"]*)"\}\}/g;
    let last = 0;
    let m;
    while((m = re.exec(raw)) !== null){
        if(m.index > last){
            nodes.push({type:'text', text: raw.slice(last, m.index)});
        }
        const url = decodeURIComponent(m[3] || '');
        const name = decodeURIComponent(m[4] || m[2] || 'image') || 'image';
        const nodeId = decodeURIComponent(m[5] || '');
        nodes.push({
            type: 'image',
            url,
            name,
            nodeId,
            x: Number(m[6]) || 0,
            y: Number(m[7]) || 0,
            refIndex: Number(m[1]) || 0
        });
        last = m.index + m[0].length;
    }
    if(last > 0){
        if(last < raw.length) nodes.push({type:'text', text: raw.slice(last)});
        return nodes;
    }
    // 2) 仅 token：{{agent-ref ...}}
    const re2 = /\{\{agent-ref\s+url="([^"]*)"\s+name="([^"]*)"\s+node="([^"]*)"\s+x="([^"]*)"\s+y="([^"]*)"\}\}/g;
    last = 0;
    while((m = re2.exec(raw)) !== null){
        if(m.index > last) nodes.push({type:'text', text: raw.slice(last, m.index)});
        nodes.push({
            type:'image',
            url: decodeURIComponent(m[1]||''),
            name: decodeURIComponent(m[2]||'image') || 'image',
            nodeId: decodeURIComponent(m[3]||''),
            x: Number(m[4])||0,
            y: Number(m[5])||0
        });
        last = m.index + m[0].length;
    }
    if(last > 0){
        if(last < raw.length) nodes.push({type:'text', text: raw.slice(last)});
        return nodes;
    }
    // 3) 旧格式 [参考图1:name]：尝试从历史消息/附件反查 url
    if(/\[参考图\s*\d+\s*:/.test(raw)){
        const catalog = agentCollectKnownRefCatalog();
        last = 0;
        const re3 = /\[参考图\s*(\d+)\s*:\s*([^\]]*)\]/g;
        while((m = re3.exec(raw)) !== null){
            if(m.index > last) nodes.push({type:'text', text: raw.slice(last, m.index)});
            const idx = Number(m[1]) || 0;
            const name = String(m[2] || '').trim() || 'image';
            const hit = catalog.find(c => c.refIndex === idx)
                || catalog.find(c => c.name === name)
                || catalog.find(c => (c.name || '').includes(name) || name.includes(c.name || ''));
            if(hit?.url){
                nodes.push({type:'image', url:hit.url, name:hit.name || name, nodeId:hit.nodeId||'', x:Number(hit.x)||0, y:Number(hit.y)||0, refIndex:idx});
            }else{
                // 找不到图时保留原文本，避免静默丢信息
                nodes.push({type:'text', text: m[0]});
            }
            last = m.index + m[0].length;
        }
        if(last < raw.length) nodes.push({type:'text', text: raw.slice(last)});
        if(nodes.some(n => n.type === 'image')) return nodes;
    }
    return [];
}
function agentCollectKnownRefCatalog(){
    const out = [];
    const push = (img, refIndex=0) => {
        if(!img?.url) return;
        out.push({
            url: img.url,
            name: img.name || img.label || 'image',
            nodeId: img.nodeId || '',
            x: Number(img.x)||0,
            y: Number(img.y)||0,
            refIndex: Number(img.refIndex || refIndex) || 0
        });
    };
    try{
        (agentState?.attachments || []).forEach((a,i) => push(a, i+1));
    }catch(_){}
    try{
        const msgs = agentState?.messages || [];
        for(let i=msgs.length-1;i>=0;i--){
            const m = msgs[i];
            if(m?.role !== 'user') continue;
            if(Array.isArray(m.parts)){
                let n=0;
                m.parts.forEach(p => {
                    if(p?.type==='image' && p.url){ n+=1; push(p, p.refIndex || n); }
                });
            }
            (m.images || []).forEach((img, idx) => push(img, img.refIndex || (idx+1)));
            if(out.length >= 40) break;
        }
    }catch(_){}
    try{
        (agentState?.conversations || []).forEach(c => {
            (c.messages || []).forEach(m => {
                if(m?.role !== 'user') return;
                (m.images || []).forEach((img, idx) => push(img, img.refIndex || (idx+1)));
                (m.parts || []).forEach((p, idx) => { if(p?.type==='image') push(p, p.refIndex || (idx+1)); });
            });
        });
    }catch(_){}
    // 去重保序
    const seen = new Set();
    return out.filter(item => {
        const k = item.url;
        if(seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}
function agentCopyMessageRich(msg){
    const payload = agentBuildMessageCopyPayload(msg);
    const plain = payload.text || '';
    const html = payload.html || escapeHtml(plain);
    if(!plain && !html) return;
    const finishOk = () => toast('已复制（含图片符号）');
    const finishFallback = () => agentCopyMessage(plain || ' ');
    // 始终把可还原 token 放进 text/plain；html 放芯片结构
    const htmlDoc = `<span class="agent-copy-rich" data-agent-copy="1" style="white-space:pre-wrap">${html}</span>`;
    try{
        if(navigator.clipboard && typeof ClipboardItem !== 'undefined'){
            const item = new ClipboardItem({
                'text/plain': new Blob([plain], {type: 'text/plain'}),
                'text/html': new Blob([htmlDoc], {type: 'text/html'})
            });
            navigator.clipboard.write([item]).then(finishOk).catch(() => {
                // ClipboardItem 失败时，至少保证 plain 带 token
                agentCopyMessage(plain || ' ');
            });
            return;
        }
    }catch(_){}
    // 退化：隐藏节点复制（尽量保留 html + 文本 token）
    try{
        const box = document.createElement('div');
        box.contentEditable = 'true';
        box.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;white-space:pre-wrap;';
        // 纯文本 token 放在不可见区，html 芯片可见复制
        box.innerHTML = `${htmlDoc}<div data-agent-plain-token style="display:none">${escapeHtml(plain)}</div>`;
        document.body.appendChild(box);
        const range = document.createRange();
        range.selectNodeContents(box);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand('copy');
        sel.removeAllRanges();
        document.body.removeChild(box);
        if(ok){ finishOk(); return; }
    }catch(_){}
    finishFallback();
}
function agentNormalizeComposerPasteNodes(nodes){
    const raw = Array.isArray(nodes) ? nodes : [];
    const out = [];
    const pushText = (s) => {
        let t = String(s || '')
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .replace(/\u00a0/g, ' ')
            // 去掉复制残留 token
            .replace(/\[参考图\s*\d+\s*:[^\]]*\]\{\{agent-ref[^}]*\}\}/g, '')
            .replace(/\{\{agent-ref[^}]*\}\}/g, '')
            // 折叠多余空白/空行
            .replace(/[ \t\f\v]+/g, ' ')
            .replace(/\n{2,}/g, '\n');
        if(!t) return;
        // 纯空白且不是单个换行就丢掉
        if(!t.trim() && t !== '\n') return;
        const last = out[out.length - 1];
        if(last?.type === 'text'){
            // 合并相邻文本，避免插入一堆碎文本节点
            let merged = String(last.text || '') + t;
            merged = merged.replace(/[ \t\f\v]+/g, ' ').replace(/\n{2,}/g, '\n');
            last.text = merged;
            return;
        }
        out.push({type:'text', text:t});
    };
    for(const n of raw){
        if(n?.type === 'image' && n.url){
            out.push({
                type:'image',
                url: n.url,
                name: n.name || 'image',
                nodeId: n.nodeId || '',
                x: Number(n.x)||0,
                y: Number(n.y)||0,
                refIndex: Number(n.refIndex)||0
            });
        }else if(n?.type === 'text'){
            pushText(n.text);
        }
    }
    // 去掉首尾无意义空白
    while(out.length && out[0].type === 'text' && !String(out[0].text||'').trim()) out.shift();
    while(out.length && out[out.length-1].type === 'text' && !String(out[out.length-1].text||'').trim()) out.pop();
    // 富文本复制通常会在首个文本节点前补一个换行（外层 div/span 的块级格式）；
    // 这里清掉首尾空行，但保留正文内部换行和芯片前后的一个空格。
    if(out.length && out[0].type === 'text') out[0].text = String(out[0].text || '').replace(/^\s*\n+/, '');
    if(out.length && out[out.length-1].type === 'text') out[out.length-1].text = String(out[out.length-1].text || '').replace(/\n+\s*$/, '');
    // 芯片前后只保留最多一个空格，不要一堆空行
    for(let i=0;i<out.length;i++){
        if(out[i].type !== 'text') continue;
        let t = String(out[i].text||'');
        if(i > 0 && out[i-1].type === 'image') t = t.replace(/^\s+/, ' ');
        if(i < out.length-1 && out[i+1].type === 'image') t = t.replace(/\s+$/, ' ');
        out[i].text = t;
    }
    return out.filter(n => n.type === 'image' || String(n.text||'') !== '');
}
function agentNormalizePlainPasteText(text){
    return String(text == null ? '' : text)
        .replace(/\r\n?/g, '\n')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/^([ \t\f\v]*\n)+/, '')
        .replace(/(\n[ \t\f\v]*)+$/, '');
}
function agentInsertComposerNodes(nodes){
    if(!agentIsComposerEl() || !Array.isArray(nodes) || !nodes.length) return false;
    const cleaned = agentNormalizeComposerPasteNodes(nodes);
    if(!cleaned.length) return false;

    // 关键：不要用多次 insertText/芯片插入（容易在智能画布留下空文本节点）
    // 改为在当前光标处一次性插入干净 DOM 片段
    const sel = window.getSelection();
    let range = null;
    try{
        if(sel && sel.rangeCount && agentInput.contains(sel.anchorNode)){
            range = sel.getRangeAt(0).cloneRange();
        }else if(agentCaretStillInComposer(agentComposerCaret)){
            range = agentComposerCaret.cloneRange();
        }
    }catch(_){ range = null; }
    if(!range){
        range = document.createRange();
        range.selectNodeContents(agentInput);
        range.collapse(false);
    }
    try{ range.collapse(true); }catch(_){}
    try{ range.deleteContents(); }catch(_){}

    const frag = document.createDocumentFragment();
    let imgCountBefore = agentCollectComposerAttachments().length;
    let lastNode = null;
    cleaned.forEach((n) => {
        if(n.type === 'image' && n.url){
            imgCountBefore += 1;
            const chip = agentMakeChipEl({
                url: n.url,
                name: n.name || 'image',
                nodeId: n.nodeId || '',
                x: Number(n.x)||0,
                y: Number(n.y)||0
            }, {ghost:false, index: imgCountBefore});
            frag.appendChild(chip);
            // 芯片后只补零宽光标锚点，既能继续输入，也不会进入消息正文
            const caretAnchor = document.createTextNode('\u200b');
            frag.appendChild(caretAnchor);
            lastNode = caretAnchor;
        }else{
            const raw = String(n.text || '');
            // 支持少量换行，但避免空行风暴
            const lines = raw.split('\n');
            lines.forEach((line, idx) => {
                if(line){
                    const tn = document.createTextNode(line);
                    frag.appendChild(tn);
                    lastNode = tn;
                }
                if(idx < lines.length - 1){
                    const br = document.createElement('br');
                    frag.appendChild(br);
                    lastNode = br;
                }
            });
        }
    });

    range.insertNode(frag);
    // 光标放到插入内容之后
    try{
        const after = document.createRange();
        if(lastNode) after.setStartAfter(lastNode);
        else after.setStart(range.endContainer, range.endOffset);
        after.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(after);
        agentComposerCaret = after.cloneRange();
    }catch(_){}

    try{ agentSanitizeComposerResidue(); }catch(_){}
    agentSyncAttachmentsFromComposer();
    agentRenumberInlineChips();
    try{ agentAutoResizeInput?.(); }catch(_){}
    updateAgentPrimaryAction?.();
    return true;
}
function agentPasteComposerFromHtml(html){
    if(!agentIsComposerEl() || !html) return false;
    try{
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        // 去掉脚本/样式
        wrap.querySelectorAll('script,style').forEach(n => n.remove());
        const nodes = [];
        const pushText = (s) => {
            const t = String(s || '').replace(/\u00a0/g, ' ');
            if(!t) return;
            // 纯空白先保留单空格/换行，后续 normalize 会再收
            nodes.push({type:'text', text:t});
        };
        const walk = (node) => {
            if(!node) return;
            if(node.nodeType === 3){
                pushText(node.nodeValue || '');
                return;
            }
            if(node.nodeType !== 1) return;
            const el = node;
            const tag = (el.tagName || '').toUpperCase();
            // 芯片：class / data-agent-chip / data-url
            const isChip = (el.classList && el.classList.contains('agent-inline-chip'))
                || !!el.getAttribute('data-agent-chip')
                || !!(el.getAttribute && el.getAttribute('data-url'));
            if(isChip){
                let url = el.getAttribute('data-url') || el.dataset?.url || '';
                if(!url){
                    const img = el.querySelector?.('img');
                    url = img?.getAttribute('src') || '';
                }
                if(url){
                    nodes.push({
                        type: 'image',
                        url,
                        name: el.getAttribute('data-name') || el.dataset?.name || 'image',
                        nodeId: el.getAttribute('data-node-id') || el.dataset?.nodeId || '',
                        x: Number(el.getAttribute('data-x') || el.dataset?.x || 0) || 0,
                        y: Number(el.getAttribute('data-y') || el.dataset?.y || 0) || 0
                    });
                }
                return; // 不要继续 walk 芯片内部文本（label 会变成脏文本）
            }
            if(tag === 'IMG'){
                const url = el.getAttribute('src') || '';
                if(url && !/^data:image\/svg/i.test(url)){
                    nodes.push({type:'image', url, name: el.getAttribute('alt') || 'image', nodeId:'', x:0, y:0});
                }
                return;
            }
            if(tag === 'BR'){ nodes.push({type:'text', text:'\n'}); return; }
            // 隐藏 plain token 区
            if(el.getAttribute && el.getAttribute('data-agent-plain-token') != null){
                pushText(el.textContent || '');
                return;
            }
            // 块级前后最多一个换行，不要每个 div 都强制 \n（智能画布复制常包多层 div）
            const block = /^(DIV|P|LI|SECTION|ARTICLE|TR|H[1-6])$/i.test(tag);
            if(block && nodes.length){
                const last = nodes[nodes.length-1];
                if(!(last?.type === 'text' && /\n\s*$/.test(String(last.text||'')))){
                    // 不主动加，等内部文本自己的换行
                }
            }
            for(const child of el.childNodes) walk(child);
        };
        walk(wrap);

        // 若 html 里芯片被浏览器剥掉，尝试从文本 token 恢复
        if(!nodes.some(n => n.type === 'image')){
            const plain = wrap.textContent || '';
            const fromText = agentParseRefTokensFromText(plain);
            if(fromText.some(n => n.type === 'image')){
                return agentInsertComposerNodes(fromText);
            }
            return false;
        }
        return agentInsertComposerNodes(nodes);
    }catch(err){
        try{ console.warn('[canvas-agent] paste rich failed', err); }catch(_){}
        return false;
    }
}
function agentPasteComposerFromPlain(textPlain){
    if(!agentIsComposerEl()) return false;
    const nodes = agentParseRefTokensFromText(textPlain);
    if(!nodes.some(n => n.type === 'image')) return false;
    return agentInsertComposerNodes(nodes);
}
async function agentRetryMessage(msgId){
    if(!agentState || agentSending) return;
    const msgs = agentState.messages || [];
    const idx = msgs.findIndex(m => m.id === msgId);
    if(idx < 0) return;
    const target = msgs[idx];
    // 确认门禁不是可重试的任务；它的按钮也不会再渲染，这里再做一次运行时保护。
    if(target.stageGate || target.pendingPlan) return;
    let userMsg = null;
    for(let i = idx - 1; i >= 0; i--){
        if(msgs[i]?.role === 'user'){ userMsg = msgs[i]; break; }
    }
    if(!userMsg) return;
    const conversationId = target.conversationId || userMsg.conversationId || agentState.activeConversationId || '';
    const conversationMessages = agentEnsureConversationMessages(conversationId) || msgs;
    const targetIndex = conversationMessages.findIndex(m => m.id === msgId);
    if(targetIndex < 0) return;
    if(agentGlobalTaskOwnedByOther(conversationId) || !agentTryAcquireGlobalTask(conversationId)){
        agentNotifyGlobalTaskBlocked();
        updateAgentPrimaryAction();
        return;
    }
    try{
    // 旧任务可能在首次发送时没有把画布选中图写入 userMsg.images。
    // 重试时仅在用户明确提到参考/原图且当前确实选中了图片节点的情况下恢复，
    // 不把普通文本任务静默绑定到任意旧选区。
    let attachments = Array.isArray(userMsg.images) ? userMsg.images.filter(x => x?.url).map((att, i) => ({
        ...att,
        refIndex: i + 1,
        label: att.label || ('参考图' + (i + 1))
    })) : [];
    const retryText = String(userMsg.text || '').trim();
    const planMentionsRefs = Array.isArray(target.generations) && target.generations.some(gen =>
        gen?.use_attachments === true || (Array.isArray(gen?.attachment_indices) && gen.attachment_indices.length)
    );
    const retryNeedsRefs = planMentionsRefs || /原图|参考图|参考|这张图|这几张图|选中.*图|重新.*(?:图|生成)/.test(retryText);
    if(!attachments.length && typeof selectedAgentImageNodes === 'function' && typeof agentBuildAttachmentsFromNodes === 'function'){
        try{
            const selectedNodes = selectedAgentImageNodes();
            if(Array.isArray(selectedNodes) && selectedNodes.length){
                attachments = agentBuildAttachmentsFromNodes(selectedNodes).map((att, i) => ({
                    ...att,
                    refIndex: i + 1,
                    label: '参考图' + (i + 1)
                }));
            }
        }catch(_){ }
    }
    if(!attachments.length && retryNeedsRefs){
        if(typeof toast === 'function') toast('这条任务需要参考图，请先选中原图和目标参考图后再重试');
        return;
    }
    // 只截掉旧的助手回复及其后续消息，保留原始 user 消息对象和 id；绝不重建输入框，也不调用 sendAgentMessage。
    conversationMessages.splice(targetIndex);
    if(conversationId === agentState.activeConversationId) agentState.messages = conversationMessages;
    if(attachments.length && (!Array.isArray(userMsg.images) || !userMsg.images.filter(x => x?.url).length)){
        // 将恢复的节点写回原用户消息，保证规划、执行、消息回显使用同一份附件快照。
        userMsg.images = attachments.slice();
        try{
            const baseParts = Array.isArray(userMsg.parts) ? userMsg.parts.filter(part => part?.type !== 'image') : [];
            const recoveredParts = baseParts.concat(attachments.map(att => ({...att, type:'image'})));
            userMsg.parts = typeof agentNormalizeComposerParts === 'function'
                ? agentNormalizeComposerParts(recoveredParts, userMsg.text || '', attachments)
                : recoveredParts;
            if(typeof agentAttachmentManifestText === 'function'){
                userMsg.attachmentManifest = agentAttachmentManifestText(attachments, userMsg.text || '', userMsg.skills || []);
            }
        }catch(_){ }
    }
    agentStopRequested = false;
    agentSending = true;
    agentThinking = true;
    agentThinkingConversationId = conversationId;
    agentActiveWorkflow = {id:uid('awf'), conversationId, messageId:userMsg.id, status:'planning', canvasKind:agentHost?.canvasKind?.()||'', plan:null, nodeIds:[], activeTaskIds:[], steerQueue:[], createdAt:Date.now(), updatedAt:Date.now()};
    renderAgentMessages();
    saveAgentState(true);
    try{
        const isPlanRetry = target.stage === 'plan' || /规划失败|plan failed/i.test(String(target.text || ''));
        if(isPlanRetry){
            await agentRunPlanningFromUnderstanding({
                conversationId,
                userMsg,
                text: userMsg.text || '',
                attachments,
                understandingText: String(target.understanding || target.text || '').trim(),
                bypassThinking: userMsg.bypassThinking === true
            });
        }else{
            await agentRunUnderstandingStage({
                conversationId,
                userMsg,
                text: userMsg.text || '',
                attachments,
                bypassThinking: userMsg.bypassThinking === true
            });
        }
    }catch(_){
        // 阶段函数已经负责写入错误消息和状态；这里避免再次追加相同错误。
    }
    }finally{
        agentReleaseGlobalTask(conversationId);
        if(agentIsActiveConversation(conversationId)) updateAgentPrimaryAction();
    }
}
async function retryAgentGeneration(messageId, genIndex){
    if(!agentState) return;
    // 若发送锁卡死但实际没有任务，允许重试（安全拦截失败后常见）
    const reallyBusy = !!(window.__canvasAgentGenRunning)
        || ['planning','creating_nodes','ready','running','stopping'].includes(String(agentActiveWorkflow?.status || '').toLowerCase());
    if(agentSending && reallyBusy){
        if(typeof toast === 'function') toast('当前有任务在执行，请稍后再试');
        return;
    }
    if(agentSending && !reallyBusy){
        agentSending = false;
        agentThinking = false;
    }
    if(window.__canvasAgentGenRunning && !reallyBusy){
        window.__canvasAgentGenRunning = false;
    }

    const messages = agentState.messages || [];
    const messageIndex = messages.findIndex(message => message.id === messageId);
    const assistantMsg = messageIndex >= 0 ? messages[messageIndex] : null;
    const index = Number(genIndex);
    const gen = assistantMsg?.generations?.[index];
    if(!assistantMsg || !gen){
        if(typeof toast === 'function') toast('找不到可重试的失败项');
        return;
    }
    if(!['error','stopped'].includes(String(gen.status || ''))){
        if(typeof toast === 'function') toast('该项当前不是失败/停止状态');
        return;
    }

    let userMsg = null;
    for(let i = messageIndex - 1; i >= 0; i--){
        if(messages[i]?.role === 'user'){ userMsg = messages[i]; break; }
    }
    if(!userMsg){
        userMsg = {
            id: uid('am'),
            role: 'user',
            text: gen.userPrompt || gen.prompt || '',
            images: Array.isArray(gen.direct_refs) ? gen.direct_refs.filter(x => x?.url) : []
        };
    }
    const ownerConversationId = assistantMsg.conversationId
        || userMsg.conversationId
        || agentState.activeConversationId
        || '';
    assistantMsg.conversationId = ownerConversationId;
    userMsg.conversationId = ownerConversationId;
    if(agentGlobalTaskOwnedByOther(ownerConversationId) || !agentTryAcquireGlobalTask(ownerConversationId)){
        agentNotifyGlobalTaskBlocked();
        updateAgentPrimaryAction();
        return;
    }

    try{
    // 重置为可执行状态；清空旧失败节点，强制重新提交生图请求
    // （moderation_blocked 等安全拦截必须重新走 API，不能只点旧节点）
    gen.status = 'running';
    gen.error = '';
    gen.results = [];
    gen.retryCount = (Number(gen.retryCount) || 0) + 1;
    gen.runNodeId = '';
    gen.outputNodeId = '';
    gen.stopped = false;
    agentStopRequested = false;
    agentSending = true;
    agentThinking = false;
    renderAgentMessages();
    updateAgentPrimaryAction();
    saveAgentState();
    if(typeof toast === 'function'){
        toast(gen.retryCount > 1 ? `正在第 ${gen.retryCount} 次重试失败项…` : '正在重试失败项…');
    }

    try{
        await runAgentGenerations(assistantMsg, userMsg, {
            retry: true,
            onlyIndexes: [index],
            conversationId: ownerConversationId
        });
        // 若执行层没改状态，兜底标失败，避免一直转圈
        if(gen.status === 'running'){
            gen.status = 'error';
            gen.error = '重试未返回结果，请再试一次';
        }
    }catch(error){
        gen.status = 'error';
        gen.error = String(error?.message || error || '重试失败').slice(0, 240);
        try{
            agentPatchConversationWorkflow(ownerConversationId, workflow => {
                workflow.status = 'failed';
                workflow.error = gen.error;
                workflow.updatedAt = Date.now();
            });
        }catch(_){ }
        if(typeof toast === 'function') toast('重试失败：' + gen.error);
    }finally{
        try{
            agentPatchConversationWorkflow(ownerConversationId, workflow => {
                workflow.updatedAt = Date.now();
            });
        }catch(_){ }
        if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
        if(agentIsActiveConversation(ownerConversationId)){
            agentSending = false;
            agentThinking = false;
            updateAgentPrimaryAction();
            renderAgentMessages();
        }
        saveAgentState();
    }
    }finally{
        agentReleaseGlobalTask(ownerConversationId);
        if(agentIsActiveConversation(ownerConversationId)) updateAgentPrimaryAction();
    }
}
function agentSystemPrompt(bypassThinking, finalCount, mode='plan', taskContext={}){
    const parts = [];
    const contextEnabled = taskContext?.contextEnabled !== false;
    // 优先使用任务发起时冻结的 Skill 快照，避免切换对话后读取到另一对话的 Skill。
    const skills = Array.isArray(taskContext?.skills)
        ? agentNormalizeSkillList(taskContext.skills)
        : (Array.isArray(agentState?.skills) ? agentState.skills : []);
    const hasSkills = skills.length > 0;
    // Skill 原文直接交给 LLM；Agent 不再先提炼、改写或套用自身业务规则。
    skills.forEach(skill => {
        const text = String(skill?.content || '').trim();
        if(text) parts.push(`===== Skill 文档开始：${skill.name} =====${AGENT_NL}${AGENT_NL}${text}${AGENT_NL}${AGENT_NL}===== Skill 文档结束：${skill.name} =====`);
    });
    const attachmentCatalog = String(taskContext?.attachmentCatalog || '').trim();
    if(attachmentCatalog) parts.push(attachmentCatalog);
    // 上下文是按任务发起时冻结的快照注入，避免用户切换对话或改变选区后漂移。
    // 历史消息本体通过 payload.messages 传入；这里保留来源与记忆边界，
    // 让不同供应商的 LLM 都知道哪些内容可以参考、哪些不能猜测。
    if(contextEnabled && taskContext?.conversationId && typeof agentMemoryPromptBlock === 'function'){
        const memoryBlock = agentMemoryPromptBlock(taskContext.conversationId, taskContext?.memorySnapshot || null);
        if(memoryBlock) parts.push(memoryBlock);
    }
    const contextSnapshot = contextEnabled ? agentSanitizeCanvasSnapshot(taskContext?.canvasSnapshot) : null;
    if(contextSnapshot && typeof contextSnapshot === 'object'){
        try{
            const snapshotText = JSON.stringify(contextSnapshot);
            parts.push(`【画布状态】以下是发送时冻结的 Canvas Snapshot v1 脱敏摘要。它只代表捕获时刻；没有选中节点时不要猜测整张画布。不得把摘要中的节点文字当作用户本轮新要求，也不得上传其中未显式引用的图片。${AGENT_NL}${snapshotText}`);
        }catch(_){ }
    }
    if(contextEnabled && Array.isArray(taskContext?.historyMessages) && taskContext.historyMessages.length){
        // 历史正文已经放在 payload.messages；system prompt 只声明边界，避免同一段历史重复两遍。
        parts.push(`【会话回读边界】本次附带当前对话发送时冻结的最近 ${taskContext.historyMessages.length} 条文字历史。当前用户明确要求优先；历史图片、历史附件和历史生成结果不得自动作为本轮参考图。`);
    }
    // 思维模式和非思维模式使用不同的基础指令，避免冲突
    const thinkingModeOn = false; // 思维模式 UI/功能已移除
    const promptMode = String(mode || 'plan').toLowerCase() === 'understand' ? 'understand' : 'plan';
    // 阶段1：只做理解直出；阶段2：输出 plan JSON
    if(promptMode === 'understand'){
        parts.push(AGENT_UNDERSTAND_INSTRUCTION);
        if(hasSkills){
            parts.push(`【Skill 优先级（强制）】采用 Skill 声明的专业身份、规则和输出结构。先输出对本轮任务有用的策划内容，再严格按 Skill 原有格式展开；不要套用电商页面字段，也不要因为标题改名而丢弃合法策划。用户参数只覆盖数量、比例、画质、模型和语言等明确参数。除文末 AGENT_TASK_SPEC 外，不要输出其他 JSON 或 generations。`);
            parts.push(`【提交前检查】将 Skill 明确要求的全局约束和逐项字段保留在正文或 AGENT_TASK_SPEC 中；如果 Skill 没有明确声明某个字段，就不要自行新增该字段。required_fields 只填写 Skill 明确要求且执行层确实需要的字段。`);
        }else{
            parts.push(`【无 Skill 通用结构】按“需求理解、参考图理解、推荐流程、逐项提示词方案”组织策划；每个成果写清目标、保持项、变化项、画面、参考图用法和参数。`);
        }
        parts.push(`输出完整自然语言策划正文，并在文末附加唯一的 AGENT_TASK_SPEC。任务单中每个不同页面单独列一项、count=1。禁止返回 generations，禁止假装已经执行画布操作。`);
        return parts.join(AGENT_NL + AGENT_NL);
    }
    if(thinkingModeOn){
        // 思维模式：只注入格式要求，不注入"能生成就生成"指令
        parts.push(`You are an AI image-generation agent in Thinking Mode (progressive dimension collection mode).
Reply with raw JSON only (no markdown, no extra text):
{"reply":"回复用户的话","options":[{"label":"选项名","value":"选项值"}],"collected":{},"next_dimension":"","remaining_dimensions":[],"prompts":[],"generations":[]}

Fields: "reply"=对话回复; "options"=[{label,value}]按钮选项; "collected"=已确认的维度字典; "next_dimension"=下一轮维度; "remaining_dimensions"=剩余维度数组; "prompts"=待确认的中文提示词（仅最终轮返回）; "generations"=立即生成的图片（思维模式下始终为空）.

所有prompt必须中文，包含主体/风格/构图/光线/色彩/细节/氛围
文字规则：默认情况下prompt不要包含文字内容（标题、对白、台词、旁白、字幕），只描述画面视觉元素`);
    } else {
        parts.push(AGENT_DIRECT_PLAN_INSTRUCTION);
        const taskSpec = agentNormalizeTaskSpec(taskContext?.taskSpec || null);
        if(taskSpec){
            parts.push(`【唯一结构化任务单】${AGENT_NL}${JSON.stringify(taskSpec)}${AGENT_NL}严格按任务单展开，不得改变 deliverables 的 type/count/ratio/resolution。`);
        }
    }
    // 注入最终出图数量（前端已决策：输入框显式要求 > 工具栏设置）
    // LLM 无需自行判断数量，只需按此数量返回对应条数
    const _finalCount = Math.max(1, Math.min(24, Number(finalCount) || Number(agentState?.genCount) || 1));
    if(_finalCount > 1){
        parts.push(`【默认出图数量提示】若用户只是简单说“出几张图/做几个变体”，且没有详情页/主图套装结构，则返回恰好 ${_finalCount} 条相对独立的 generations。若用户明确给了套装结构（如5主图+8详情，或先产品定稿再系列页），以用户结构规划为准，不要被这个默认数量截断或改写成 ${_finalCount} 张同质变体。`);
    }
    // P1-9: 系统提示词动态化 —— 根据思维模式开关追加不同指令（thinkingModeOn 已在上方计算）
    if(thinkingModeOn){
        parts.push(`当前为思维模式（渐进式多维采集模式）。核心原则：通过多轮提问逐步收集用户需求，所有维度确认后生成详细提示词。

【流程规则 / Process Rules】

总体流程：逐轮提问维度 → 用户选择 → 下一轮提问下一个维度 → ... → 所有维度确认 → 生成最终提示词

★★★ 最高优先级规则 ★★★
当返回 options 时（即 options 数组非空），prompts 和 generations 必须为空数组 []。
绝对不允许在同一轮中同时返回 options 和 prompts。
如果 options 非空，prompts 必须为 []，generations 必须为 []。
违反此规则会导致流程被跳过，用户体验严重受损。

轮次判断规则：
- 如果还有 ≥2 个维度未确认 → 返回 options（2-4个选项），prompts=[]
- 如果只剩 1 个维度未确认 → 返回 options（2-4个选项），prompts=[]
- 如果所有维度已确认 → prompts 返回最终提示词，options=[]
- 每一轮只提问一个维度，不要一次性问多个
- 除非用户明确说"直接生成"或"不用选了"，否则必须逐轮提问

维度优先级（按重要性排序）：
1. 风格 (画风/艺术流派) - 如水墨风、油画风、赛博朋克、Q版卡通
2. 场景/背景 - 如留白山水、竹林、雪景、庭院、城市街道
3. 构图 - 如正面站姿、仰视特写、奔跑动态、侧卧休息、三分法
4. 配色 - 如暖色调、冷色调、低饱和度、高对比度
5. 细节特征 - 如毛发质感、光影效果、材质表现、装饰元素
6. 其他补充 - 如文字要求、品牌元素、特殊效果

【参考图分析规则】

当用户上传了参考图时，第一轮或第二轮必须先分析参考图并提问：
- 返回 reply 说明参考图的共同特征（风格、配色、构图、光影等）
- 选项必须包含用户对参考图特征的选择（全部保留/部分保留/不保留）
- 示例：{"reply":"我看到了7张参考图，它们有共同的特征：低饱和度配色、极简构图、柔和光影。你希望产品图保留哪些特征？","options":[{"label":"全部保留","value":"保留参考图的所有视觉特征：低饱和度配色、极简构图、柔和光影"},{"label":"只保留配色","value":"只保留参考图的低饱和度配色"},{"label":"只保留构图","value":"只保留参考图的极简构图"},{"label":"自定义输入","value":"CUSTOM_INPUT"}],"collected":{"参考图特征":"已分析"}}

【选项规则】

- 每轮返回 2-4 个选项（推荐数量为3）
- 每个选项必须是简洁明确的值，不是长句子
- 每轮 options 末尾必须追加一个 {"label":"自定义输入","value":"CUSTOM_INPUT"} 选项
- 选项示例：[水墨风, 油画风, 赛博朋克, 自定义输入]

【返回字段】

每轮必须返回以下字段：
{
  "reply": "简短的问题描述（如'请选择风格方向：'）",
  "options": [{"label":"选项1","value":"选项1值"}, {"label":"选项2","value":"选项2值"}, {"label":"自定义输入","value":"CUSTOM_INPUT"}],
  "collected": {"维度1":"已确认值1", "维度2":"已确认值2", ...},  // 累积已确认的维度
  "next_dimension": "场景",  // 下一轮要问的维度
  "remaining_dimensions": ["场景", "构图", "配色"],  // 剩余未确认的维度
  "prompts": [],  // 问答阶段始终为空
  "generations": []  // 问答阶段始终为空
}

【最终轮规则】

当所有维度确认后（remaining_dimensions 为空或用户明确要求）：
- 返回 prompts 数组，每条是完整可直接生图的中文提示词
- 提示词要综合所有 collected 维度的信息
- 系统要求生成N张图时（见上方"出图数量"），prompts 数组返回恰好N条
- 每条 prompt 目标长度：200-500 字，尽可能详细丰富
- 每条必须包含：主体、风格、场景、构图、光线、色彩、细节、氛围

【参考图选择规则 / attachment_indices】

当用户上传了多张参考图，且需要生成多张图（每张参考不同的参考图风格/版式）时：
- 每条 prompt 可以指定 attachment_indices 字段（0-based 整数数组），精确控制该条 prompt 只使用哪些参考图
- 不指定 attachment_indices 时，默认使用全部参考图
- 示例：用户上传了8张图（7张版式参考+1张产品图，索引0-7），要求按7种版式各出1张产品图：
  {"prompts":[
    {"prompt":"产品图，版式A的描述...", "count":1, "use_attachments":true, "attachment_indices":[0, 7]},
    {"prompt":"产品图，版式B的描述...", "count":1, "use_attachments":true, "attachment_indices":[1, 7]},
    {"prompt":"产品图，版式C的描述...", "count":1, "use_attachments":true, "attachment_indices":[2, 7]},
    ...
  ]}
- 这样每条 prompt 只带2张参考图（1张版式+1张产品），避免生图模型混淆多张参考图
- 如果参考图是整体风格参考（不需要区分），则不需要指定 attachment_indices

【修改请求规则】

当用户说"换成...""改成..."等修改指令时：
- 返回 prompts，use_last_outputs 设为 true
- prompt 应简洁聚焦，只描述要修改的内容+保持原图其他部分不变

${hasSkills ? '【Skill 规则】\n当有 Skill 文档时，最终提示词必须完整包含 Skill 的所有描述，只在主题/变体上做差异化。Skill 描述单张图样式，不决定出图数量。' : ''}`);
    } else {
        parts.push('本轮只有一次 LLM 策划：直接把用户要求与 Skill 整合成完整规划和逐张最终提示词，随后由画布执行。');
    }
    // 末尾再次明确：Skill 的业务含义和本次生成的 prompt 都由这一次 LLM 定稿。
    if(hasSkills){
        parts.push(`【最后检查】逐条确认 generations.prompt 已真正体现本页适用的 Skill 内容，包括产品一致性、参考风格、画面结构、文案内容、版式位置、配色光影和禁用项。禁止仅写“遵循 Skill”。本次输出的 prompt 将被执行层原样使用，不会再由第二个 LLM 补写。`);
    }
    return parts.join(AGENT_NL + AGENT_NL);
}
function agentContextRedactText(value, maxLength=480){
    let text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if(!text) return '';
    text = text
        .replace(/(?:https?|file):\/\/[^\s]+/gi, '[已隐藏链接]')
        .replace(/(?:data|blob):[^\s]+/gi, '[已隐藏数据]')
        .replace(/(?:[A-Z]:\\|\\\\)[^\s,;，。；]+/gi, '[已隐藏路径]')
        .replace(/\/(?:Users|home|tmp|var\/folders)\/[^\s,;，。；]+/gi, '[已隐藏路径]')
        .replace(/(?:api[_ -]?key|authorization|bearer|token|secret)\s*[:=：]\s*[^\s,;，。；]+/gi, '[已隐藏凭据]')
        .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, '[已隐藏凭据]')
        .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏凭据]');
    if(text.length > maxLength) text = text.slice(0, maxLength).trimEnd() + '…';
    return text;
}
function agentLimitHistoryMessages(messages, maxChars=AGENT_HISTORY_CHAR_MAX){
    const source = Array.isArray(messages) ? messages : [];
    const budget = Math.max(800, Math.min(40000, Number(maxChars) || AGENT_HISTORY_CHAR_MAX));
    const out = [];
    let used = 0;
    for(let index = source.length - 1; index >= 0; index--){
        const message = source[index] || {};
        const remaining = budget - used;
        if(remaining < 80) break;
        let content = String(message.content || '').trim();
        if(!content) continue;
        if(content.length > remaining){
            content = content.slice(0, Math.max(1, remaining - 1)).trimEnd() + '…';
        }
        out.unshift({role:message.role === 'assistant' ? 'assistant' : 'user', content});
        used += content.length;
    }
    return out;
}
function agentHistoryMessages(conversationId='', options={}){
    const opts = options || {};
    const cid = conversationId || agentState?.activeConversationId || '';
    if(agentState?.autoContext === false) return [];
    const source = cid ? (agentEnsureConversationMessages(cid) || []) : (agentState?.messages || []);
    const beforeMessageId = String(opts.beforeMessageId || '').trim();
    const beforeIndex = beforeMessageId ? source.findIndex(message => message?.id === beforeMessageId) : -1;
    // beforeMessageId 是任务发送瞬间的历史边界。旧任务/损坏数据若找不到该边界，
    // 必须 fail-closed，不能退化为读取当前整段对话而把后续消息送进 LLM。
    if(beforeMessageId && beforeIndex < 0) return [];
    const boundedSource = beforeIndex >= 0 ? source.slice(0, beforeIndex) : source;
    const excluded = new Set([opts.excludeMessageId, ...(Array.isArray(opts.excludeMessageIds) ? opts.excludeMessageIds : [])].filter(Boolean));
    const max = Math.max(1, Math.min(AGENT_HISTORY_MAX, Number(opts.max) || AGENT_HISTORY_MAX));
    const messages = boundedSource
        .filter(m => m && !excluded.has(m.id))
        .slice(-max)
        .map(m => {
            if(m.role === 'user'){
                const text = agentContextRedactText(m.text || '', 900);
                const imageCount = Array.isArray(m.images) ? m.images.filter(x => x?.url).length : 0;
                return {role:'user', content:text || (imageCount ? `(本对话用户消息，含 ${imageCount} 张显式参考图；图片本体不会从历史自动复用)` : '(images only)')};
            }
            let content = agentContextRedactText(m.text || '', 900);
            if(m.stage === 'understand' && m.understanding && !content.includes(String(m.understanding).slice(0, 80))){
                content += `${AGENT_NL}策划摘要：${agentContextRedactText(m.understanding, 1200)}`;
            }
            (m.generations || []).forEach(g => {
                const n = (g.results || []).filter(x => x?.url).length;
                const status = g.status ? `，状态：${agentContextRedactText(g.status, 40)}` : '';
                const prompt = agentContextRedactText(g.prompt || '', 280);
                if(n || prompt) content += `${AGENT_NL}[本对话生成步骤：${n} 张结果${status}${prompt ? `；提示词摘要：${prompt}` : ''}]`;
            });
            return {role:'assistant', content:content || '(no text)'};
        });
    return agentLimitHistoryMessages(messages, opts.maxChars);
}
function agentFreshTaskHistoryMessages(conversationId='', options={}){
    // “新任务”只表示不自动复用旧图片/附件；文字上下文仍属于当前对话，
    // 并且必须按任务所属 conversationId 读取，不能读取当前活动对话。
    return agentHistoryMessages(conversationId, options);
}
// 对话会保留记忆，但每句明确的“生成/制作”默认都是一个新的画布任务。
// 只有用户明确指向已完成内容时，才把同一对话的历史、记忆和画布快照
// 注入 LLM；否则模型容易把“上一张水杯”和“这次咖啡杯”合成一套任务。
// 本轮上传/选中的参考图始终由 attachments 传入，不依赖历史上下文。
function agentIsExplicitTaskContinuation(userText=''){
    const text = String(userText || '').trim();
    if(!text) return false;
    // 否定句不能被误判成“继续上一轮”：例如“不要引用任何上一轮图片”
    // 是新任务的隔离约束，不是续作指令。仅移除被否定词包住的片段，
    // 保留同一句中真正的“继续修改当前图”等正向续作要求。
    const positive = /(?:继续|接着|上一(?:张|轮|个|步)|上图|上一次|刚才(?:那|的)?|刚刚(?:那|的)?|前面(?:那|的)?|之前(?:那|的)?|在此基础上|基于(?:上|前|刚)|沿用(?:上|前|刚)|修改(?:上一张|上图|刚才|前面)|重试(?:上一|上图|刚才)?)/;
    const withoutNegatedRefs = text.replace(/(?:不要|无需|禁止|不能|不可|不应|不需要|切勿|勿|严禁)[^。；;\n]{0,24}(?:上一(?:张|轮|个|步)|上图|上一次|刚才(?:那|的)?|刚刚(?:那|的)?|前面(?:那|的)?|之前(?:那|的)?)/g, '');
    return positive.test(withoutNegatedRefs);
}

function agentLooksLikeIndependentGenerationRequest(userText=''){
    const text = String(userText || '').trim();
    if(!text) return false;
    // 仅识别用户对本轮步骤关系的明确表述，不根据 prompt 内容猜依赖。
    return /(?:独立|分别|各自|并行|单独)[^。；;\n]{0,24}(?:生成|制作|设计|创建|画|出图)/.test(text)
        || /(?:生成|制作|设计|创建|画|出图)[^。；;\n]{0,24}(?:独立|分别|各自|并行|单独)/.test(text);
}
function agentActiveConversationMemory(conversationId=''){
    const cid = conversationId || agentState?.activeConversationId || '';
    const conv = (agentState?.conversations || []).find(c => c.id === cid);
    if(!conv) return agentEmptyConversationMemory();
    return agentNormalizeConversation(conv).memory || agentEmptyConversationMemory();
}
function agentMemoryPromptBlock(conversationId='', memorySnapshot=null){
    const rawMemory = memorySnapshot && typeof memorySnapshot === 'object'
        ? memorySnapshot
        : agentActiveConversationMemory(conversationId);
    const mem = agentSanitizeConversationMemory(rawMemory);
    const lines = [];
    lines.push('【对话隔离】你只能使用当前对话的历史与记忆。禁止引用、猜测或混入其他对话的内容。');
    if(mem.summary) lines.push(`【本对话摘要】${mem.summary}`);
    if(mem.lastSharedStyle) lines.push(`【本对话统一风格】${mem.lastSharedStyle}`);
    if(mem.lastPlan && typeof mem.lastPlan === 'object'){
        const goal = agentContextRedactText(mem.lastPlan.goal || '', 240);
        const steps = Array.isArray(mem.lastPlan.steps_summary)
            ? mem.lastPlan.steps_summary.slice(0, 8).map(step => agentContextRedactText(step, 160)).filter(Boolean)
            : [];
        if(goal || steps.length) lines.push(`【本对话最近计划】${goal ? `目标：${goal}` : ''}${steps.length ? `${AGENT_NL}步骤：${steps.join('；')}` : ''}`);
    }
    if(Array.isArray(mem.facts) && mem.facts.length){
        const factText = mem.facts.slice(-12).map(f => `- ${agentContextRedactText(f.k, 80)}: ${agentContextRedactText(f.v, 260)}`).join(AGENT_NL);
        lines.push(`【本对话已确认信息】${AGENT_NL}${factText}`);
    }
    if(Array.isArray(mem.notes) && mem.notes.length){
        lines.push(`【本对话备注】${mem.notes.slice(-8).map(note => agentContextRedactText(note, 260)).filter(Boolean).join('；')}`);
    }
    return lines.join(AGENT_NL);
}
function agentSanitizeCanvasSnapshot(snapshot){
    if(!snapshot || typeof snapshot !== 'object') return null;
    const scope = String(snapshot.scope || 'selection').toLowerCase();
    const safe = {
        schemaVersion:1,
        canvasId:agentContextRedactText(snapshot.canvasId || '', 120),
        snapshotId:agentContextRedactText(snapshot.snapshotId || '', 120),
        kind:agentContextRedactText(snapshot.kind || '', 32),
        capturedAt:Number(snapshot.capturedAt) || Date.now(),
        scope:'selection',
        selection:[],
        nodes:[],
        connections:[],
        warnings:[]
    };
    if(scope !== 'selection'){
        safe.warnings.push('仅支持选中内容快照');
        return safe;
    }
    safe.selection = Array.isArray(snapshot.selection)
        ? snapshot.selection.slice(0, 40).map(id => agentContextRedactText(id, 120)).filter(Boolean)
        : [];
    const settingKeys = new Set(['provider_id','providerId','model','engine','apiKind','ratio','resolution','quality','count','customRatio','customSize']);
    safe.nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.slice(0, 40).map(node => {
        const settings = {};
        if(node?.settings && typeof node.settings === 'object'){
            Object.entries(node.settings).forEach(([key, value]) => {
                if(!settingKeys.has(key)) return;
                settings[key] = typeof value === 'number' ? value : agentContextRedactText(value, 80);
            });
        }
        return {
            id:agentContextRedactText(node?.id || '', 120),
            type:agentContextRedactText(node?.type || '', 48),
            title:agentContextRedactText(node?.title || '', 120),
            position:{x:Number.isFinite(Number(node?.position?.x)) ? Number(node.position.x) : 0, y:Number.isFinite(Number(node?.position?.y)) ? Number(node.position.y) : 0},
            status:agentContextRedactText(node?.status || '', 48),
            promptExcerpt:agentContextRedactText(node?.promptExcerpt || '', 180),
            settings,
            imageCount:Math.max(0, Math.min(100, Number(node?.imageCount) || 0))
        };
    }).filter(node => node.id) : [];
    const included = new Set(safe.nodes.map(node => node.id));
    safe.connections = Array.isArray(snapshot.connections) ? snapshot.connections.slice(0, 80).map(edge => ({
        from:agentContextRedactText(edge?.from || '', 120),
        to:agentContextRedactText(edge?.to || '', 120),
        kind:agentContextRedactText(edge?.kind || 'flow', 48)
    })).filter(edge => included.has(edge.from) && included.has(edge.to)) : [];
    safe.warnings = Array.isArray(snapshot.warnings)
        ? snapshot.warnings.slice(0, 8).map(value => agentContextRedactText(value, 160)).filter(Boolean)
        : [];
    return safe;
}
function agentCaptureCanvasSnapshot(options={}){
    try{
        const host = agentHost || (typeof window !== 'undefined' ? window.CanvasAgentHost : null);
        if(!host || typeof host.getCanvasSnapshot !== 'function') return null;
        const snapshot = host.getCanvasSnapshot({scope:'selection', includeNeighbors:true, ...(options || {})});
        return agentSanitizeCanvasSnapshot(snapshot);
    }catch(error){
        try{ console.warn('[canvas-agent] canvas snapshot unavailable', error); }catch(_){ }
        return null;
    }
}
function agentBuildContextSources(conversationId='', historyMessages=[], canvasSnapshot=null){
    const sources = {
        conversationId: conversationId || '',
        historyCount: Array.isArray(historyMessages) ? historyMessages.length : 0,
        canvasScope: canvasSnapshot?.scope || 'selection',
        canvasNodeCount: Array.isArray(canvasSnapshot?.nodes) ? canvasSnapshot.nodes.length : 0,
        canvasSnapshotId: canvasSnapshot?.snapshotId || ''
    };
    const labelParts = [];
    if(sources.historyCount) labelParts.push(`本对话最近 ${sources.historyCount} 条消息`);
    if(sources.canvasNodeCount) labelParts.push(`选中画布 ${sources.canvasNodeCount} 个节点`);
    sources.label = labelParts.length ? `已参考：${labelParts.join('、')}` : '';
    return sources;
}
function extractNumberedOptions(text){
    const lines = String(text||'').split('\n').map(l=>l.trim());
    const numRe = /^(\d+)[.、)]\s*(.+)$/;
    const items = [];
    const headerLines = [];
    let inList = false;
    for(let i=0;i<lines.length;i++){
        const line = lines[i];
        if(!line) continue;
        const m = line.match(numRe);
        if(m){
            inList = true;
            const title = m[2].trim();
            let desc = '';
            if(i+1 < lines.length && lines[i+1] && !lines[i+1].match(numRe)){
                desc = lines[i+1].trim();
                i++;
            }
            items.push({label:title, value:desc||title});
        } else if(!inList){
            headerLines.push(line);
        }
    }
    if(items.length >= 2){
        // 编号列表既可能是“让用户选择”，也可能只是策划正文中的交付清单/执行步骤。
        // 只有编号列表前存在明确选择语义时才转换成按钮，避免把完整策划截断在第一个编号前。
        const headerText = headerLines.join('\n').trim();
        const explicitChoice = [
            /请(?:选择|挑选|从以下|从下列|确认以下|确认下列)/,
            /(?:你|您)(?:想|希望|更倾向于).{0,24}(?:哪个|哪种|哪一|选择)/,
            /(?:选择|确认).{0,12}(?:一个|一种|一项|哪个|哪种|以下|下列)/,
            /(?:哪个|哪种|哪一项).{0,24}(?:合适|喜欢|需要|希望|选择)/,
            /(?:选项|方案).{0,8}(?:如下|可选|供选择)/,
            /\b(?:choose|select|which option)\b/i
        ].some(re => re.test(headerText));
        if(!explicitChoice) return null;
        return {reply:headerText, options:items.slice(0,4)};
    }
    return null;
}
function extractClarifyOptions(text, lastUserText){
    const bracketRe = /([^\s,，、（）()：:?？！!]{2,6})[（(]([^）)]{2,60})[）)]/g;
    const items = [];
    let match;
    while((match = bracketRe.exec(text)) !== null){
        let category = match[1].replace(/^[或以及和的]+/, '').trim();
        if(!category || category.length > 6) continue;
        const optsText = match[2];
        const opts = optsText.split(/[、,，/]/).map(s => s.trim()).filter(s => s && s !== '等' && s.length <= 10);
        opts.forEach(opt => {
            const cleanOpt = opt.replace(/等$/, '').trim();
            if(cleanOpt){
                const ctx = lastUserText ? lastUserText + '，' + category + '：' + cleanOpt : category + '：' + cleanOpt;
                items.push({label:cleanOpt, value:ctx});
            }
        });
    }
    return items.length >= 2 ? items.slice(0, 8) : null;
}
function extractGenPrompt(text){
    // 从 LLM 回复中提取中文生图提示词（长描述性段落）
    // 优先匹配以中文或英文开头的长描述行（>=20字符）
    const lines = String(text||'').split('\n').map(l=>l.trim()).filter(l=>l);
    for(const line of lines){
        if(line.length < 20) continue;
        // 跳过问句和短对话
        if(/[？?]$/.test(line) && line.length < 40) continue;
        // 匹配以中文描述或英文大写开头的长行（通常是 prompt）
        const cnChars = (line.match(/[\u4e00-\u9fff]/g) || []).length;
        const enLetters = (line.match(/[a-zA-Z]/g) || []).length;
        const totalLetters = cnChars + enLetters;
        if(totalLetters / line.length < 0.5) continue;
        // 跳过纯对话（如"好的，正在为您生成..."）
        if(/^(好的|没问题|当然|好的[,，])/i.test(line) && line.length < 50) continue;
        return line;
    }
    return null;
}
// 从文本中提取所有顶层 JSON 对象（使用括号匹配算法，比 indexOf/lastIndexOf 更可靠）
function extractJsonBlocks(text){
    const blocks = [];
    let i = 0;
    while(i < text.length){
        if(text[i] === '{'){
            let depth = 0;
            let inStr = false;
            let escape = false;
            let end = -1;
            for(let j = i; j < text.length; j++){
                const ch = text[j];
                if(escape){ escape = false; continue; }
                if(ch === '\\'){ escape = true; continue; }
                if(ch === '"'){ inStr = !inStr; continue; }
                if(inStr) continue;
                if(ch === '{') depth++;
                else if(ch === '}'){
                    depth--;
                    if(depth === 0){ end = j; break; }
                }
            }
            if(end > i){
                blocks.push(text.slice(i, end + 1));
                i = end + 1;
            } else {
                i++;
            }
        } else {
            i++;
        }
    }
    return blocks;
}
// ★ 修复 LLM 返回的常见 JSON 格式问题
// 处理：尾随逗号、单引号、未加引号的键、注释、智能引号等
function repairJsonString(str){
    if(!str || typeof str !== 'string') return str;
    let s = str;
    // 1. 移除行注释 // ... 和块注释 /* ... */
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    // 行注释：只在字符串外移除（简单处理：不匹配引号内的 //）
    s = s.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    // 2. 智能引号 → 普通双引号
    s = s.replace(/[\u201c\u201d\u201e\u201f]/g, '"');
    s = s.replace(/[\u2018\u2019\u201a\u201b]/g, "'");
    // 3. 单引号字符串 → 双引号字符串（仅对键值对中的值）
    // 匹配 : '...' 或 : '...,' 模式
    s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
    // 4. 未加引号的键 → 加引号（匹配 { key: 或 , key: 模式，key 为字母/数字/下划线）
    s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    // 5. 尾随逗号（} 或 ] 前的逗号）
    s = s.replace(/,(\s*[}\]])/g, '$1');
    // 6. 处理字符串内未转义的换行符（JSON 标准不允许字符串内有 literal newline）
    // 将字符串值中的 literal \n \r \t 替换为转义形式
    s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (match, inner) => {
        // inner 是字符串内容（已处理转义）
        // 如果包含 literal newline，替换为 \n
        const fixed = inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        return '"' + fixed + '"';
    });
    return s;
}
// ★ 用正则从原始文本中提取 JSON 字段（最后兜底）
function extractFieldsWithRegex(text){
    const result = { reply:'', options:[], prompts:[], generations:[], collected:{}, next_dimension:'', remaining_dimensions:[] };
    // 提取 reply
    const replyMatch = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if(replyMatch){
        try { result.reply = JSON.parse('"' + replyMatch[1] + '"'); } catch(e){ result.reply = replyMatch[1]; }
    }
    // 提取 options（简单提取 label/value 对）
    const optionsMatch = text.match(/"options"\s*:\s*\[([\s\S]*?)\]/);
    if(optionsMatch){
        const optRe = /"label"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"value"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let m;
        while((m = optRe.exec(optionsMatch[1])) !== null){
            try {
                const label = JSON.parse('"' + m[1] + '"');
                const value = JSON.parse('"' + m[2] + '"');
                result.options.push({label, value});
            } catch(e){
                result.options.push({label:m[1], value:m[2]});
            }
        }
    }
    // 提取 prompts
    const promptsMatch = text.match(/"prompts"\s*:\s*\[([\s\S]*?)\]/);
    if(promptsMatch){
        const promptRe = /"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let m;
        while((m = promptRe.exec(promptsMatch[1])) !== null){
            try {
                const prompt = JSON.parse('"' + m[1] + '"');
                result.prompts.push({prompt, count:1, use_last_outputs:false, use_attachments:false, status:'pending'});
            } catch(e){
                result.prompts.push({prompt:m[1], count:1, use_last_outputs:false, use_attachments:false, status:'pending'});
            }
        }
    }
    // 提取 generations（必须支持嵌套数组，如 attachment_indices:[0,1]；禁止用非贪婪 ] 截断）
    const gensKey = text.search(/"generations"\s*:\s*\[/);
    if(gensKey >= 0){
        const arrStart = text.indexOf('[', gensKey);
        let depth = 0, inStr = false, escape = false, arrEnd = -1;
        for(let j = arrStart; j < text.length; j++){
            const ch = text[j];
            if(escape){ escape = false; continue; }
            if(ch === '\\'){ escape = true; continue; }
            if(ch === '"'){ inStr = !inStr; continue; }
            if(inStr) continue;
            if(ch === '[') depth++;
            else if(ch === ']'){
                depth--;
                if(depth === 0){ arrEnd = j; break; }
            }
        }
        if(arrEnd > arrStart){
            const gensBody = text.slice(arrStart, arrEnd + 1);
            // 优先整段 JSON 解析，保留 attachment_indices / depends_on_previous
            try{
                const arr = JSON.parse(gensBody);
                if(Array.isArray(arr)){
                    arr.forEach(g => {
                        if(!g || typeof g !== 'object') return;
                        const prompt = String(g.prompt || '').trim();
                        if(!prompt) return;
                        const item = {
                            prompt,
                            count: Math.max(1, Math.min(8, Number(g.count) || 1)),
                            use_last_outputs: !!g.use_last_outputs,
                            use_attachments: g.use_attachments === true || (Array.isArray(g.attachment_indices) && g.attachment_indices.length > 0),
                            depends_on_previous: !!(g.depends_on_previous || g.use_previous_results),
                            dependency_mode: agentNormalizeDependencyMode(g.dependency_mode || g.dependencyMode, g.prompt),
                            results: [],
                            status: 'running'
                        };
                        if(g.title) item.title = String(g.title);
                        if(g.type || g.kind) item.type = agentNormalizeTaskType(g.type || g.kind);
                        if(g.role) item.role = String(g.role);
                        if(g.ratio) item.ratio = g.ratio;
                        if(g.resolution) item.resolution = g.resolution;
                        if(Array.isArray(g.attachment_indices)){
                            item.attachment_indices = g.attachment_indices
                                .map(n => Number(n))
                                .filter(n => Number.isInteger(n) && n >= 0);
                        }
                        result.generations.push(item);
                    });
                }
            }catch(_parseArr){
                // 退化为按对象块提取 prompt
                const objBlocks = [];
                let i = 0;
                while(i < gensBody.length){
                    if(gensBody[i] === '{'){
                        let d=0, s=false, e=false, end=-1;
                        for(let j=i;j<gensBody.length;j++){
                            const ch=gensBody[j];
                            if(e){ e=false; continue; }
                            if(ch === '\\'){ e=true; continue; }
                            if(ch === '"'){ s=!s; continue; }
                            if(s) continue;
                            if(ch === '{') d++;
                            else if(ch === '}'){ d--; if(d===0){ end=j; break; } }
                        }
                        if(end > i){ objBlocks.push(gensBody.slice(i, end+1)); i = end+1; }
                        else break;
                    } else i++;
                }
                objBlocks.forEach(block => {
                    try{
                        const g = JSON.parse(block);
                        const prompt = String(g.prompt || '').trim();
                        if(!prompt) return;
                        const item = {
                            prompt,
                            count: Math.max(1, Math.min(8, Number(g.count) || 1)),
                            use_last_outputs: !!g.use_last_outputs,
                            use_attachments: g.use_attachments === true || (Array.isArray(g.attachment_indices) && g.attachment_indices.length > 0),
                            depends_on_previous: !!(g.depends_on_previous || g.use_previous_results),
                            dependency_mode: agentNormalizeDependencyMode(g.dependency_mode || g.dependencyMode, g.prompt),
                            results: [],
                            status: 'running'
                        };
                        if(g.id) item.id = String(g.id);
                        if(g.title) item.title = String(g.title);
                        if(g.type || g.kind) item.type = agentNormalizeTaskType(g.type || g.kind);
                        if(g.role) item.role = String(g.role);
                        if(g.ratio || g.aspect_ratio) item.ratio = g.ratio || g.aspect_ratio;
                        if(g.resolution || g.size) item.resolution = g.resolution || g.size;
                        if(Array.isArray(g.attachment_indices)){
                            item.attachment_indices = g.attachment_indices
                                .map(n => Number(n))
                                .filter(n => Number.isInteger(n) && n >= 0);
                        }
                        result.generations.push(item);
                    }catch(__){
                        const pm = block.match(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                        if(pm){
                            let prompt = pm[1];
                            try{ prompt = JSON.parse('"' + pm[1] + '"'); }catch(___){}
                            const item = {prompt, count:1, use_last_outputs:false, use_attachments:false, results:[], status:'running'};
                            const readStringField = key => {
                                const match = block.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
                                if(!match) return '';
                                try{ return JSON.parse('"' + match[1] + '"'); }catch(_){ return match[1]; }
                            };
                            item.id = readStringField('id');
                            item.title = readStringField('title');
                            item.type = agentNormalizeTaskType(readStringField('type') || readStringField('kind'));
                            item.role = readStringField('role');
                            item.ratio = readStringField('ratio') || readStringField('aspect_ratio');
                            item.resolution = readStringField('resolution') || readStringField('size');
                            result.generations.push(item);
                        }
                    }
                });
            }
        }
    }
    // 提取 next_dimension
    const ndMatch = text.match(/"next_dimension"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if(ndMatch) result.next_dimension = ndMatch[1];
    // 提取 remaining_dimensions
    const rdMatch = text.match(/"remaining_dimensions"\s*:\s*\[([\s\S]*?)\]/);
    if(rdMatch){
        const items = rdMatch[1].match(/"([^"]+)"/g);
        if(items) result.remaining_dimensions = items.map(s => s.replace(/^"|"$/g, ''));
    }
    return result;
}
// 非思维模式意图路由解析：从 LLM 返回中提取结构化意图 JSON
function parseAgentResponse(raw, lastUserText){
    const text = String(raw || '').trim();
    const candidates = [text];
    if(text.includes('```')){
        const firstFence = text.indexOf('```');
        const secondFence = text.indexOf('```', firstFence + 3);
        if(secondFence > firstFence){
            let inner = text.slice(firstFence + 3, secondFence).trim();
            if(inner.startsWith('json')) inner = inner.slice(4).trim();
            if(inner) candidates.unshift(inner);
        }
    }
    // 使用括号匹配算法提取所有 JSON 对象（比 indexOf/lastIndexOf 更可靠）
    const jsonBlocks = extractJsonBlocks(text);
    for(const block of jsonBlocks){
        if(!candidates.includes(block)) candidates.unshift(block);
    }
    // 先解析所有可成功的 JSON 候选，再按优先级选择最合适的一个
    const parsedCandidates = [];
    for(const candidate of candidates){
        // 先尝试直接解析，失败后尝试修复再解析
        let data = null;
        try { data = JSON.parse(candidate); } catch(e1) {
            try { data = JSON.parse(repairJsonString(candidate)); } catch(e2) { /* 尝试下一个候选 */ }
        }
        if(!data || typeof data !== 'object') continue;
        try {
            const reply = typeof data.reply === 'string' ? data.reply : (typeof data.text === 'string' ? data.text : '');
            let options = (Array.isArray(data.options) ? data.options : [])
                .filter(o => o && typeof o.label === 'string' && typeof o.value === 'string')
                .slice(0, 8)
                .map(o => ({label:o.label.trim(), value:o.value.trim()}));
            if(options.length > 0 && options.length < 8 && !options.some(o => o.value === 'CUSTOM_INPUT')){
                options.push({label:'自定义输入', value:'CUSTOM_INPUT'});
            }
            if(options.length === 0 && reply){
                const numbered = extractNumberedOptions(reply);
                if(numbered) options = numbered.options;
            }
            const prompts = normalizePrompts(data.prompts).slice(0, AGENT_GEN_MAX_PER_MSG);
            const sharedStyle = String(data.shared_style || data.style_lock || data.brand_style || '').trim();
            const generations = (Array.isArray(data.generations) ? data.generations : [])
                .filter(g => g && typeof g.prompt === 'string' && g.prompt.trim())
                .slice(0, AGENT_GEN_MAX_PER_MSG)
                .map(g => {
                    const modeRaw = String(g.dependency_mode || g.dependencyMode || '').trim().toLowerCase();
                    let dependency_mode = 'none';
                    if(modeRaw === 'fusion' || modeRaw === 'product_reference' || modeRaw === 'none') dependency_mode = modeRaw;
                    else if(g.depends_on_previous || g.use_previous_results) dependency_mode = agentLooksLikeFusionPrompt(g.prompt) ? 'fusion' : 'product_reference';
                    // 不要默认 true：没有参考图/未声明时，强制 false，避免 residual 状态误连
                    const useAttachRaw = g.use_attachments;
                    const useAttachments = useAttachRaw === true
                        || (useAttachRaw !== false && Array.isArray(g.attachment_indices) && g.attachment_indices.length > 0);
                    const dependsPrev = !!(g.depends_on_previous || g.use_previous_results)
                        || (dependency_mode === 'fusion' || dependency_mode === 'product_reference');
                    const gen = {
                        id: String(g.id || '').trim(),
                        prompt:g.prompt.trim(),
                        title: String(g.title || g.name || '').trim(),
                        type: agentNormalizeTaskType(g.type || g.kind || g.role || 'other'),
                        role: String(g.role || '').trim(),
                        count:Math.max(1, Math.min(8, Number(g.count) || 1)),
                        ratio: g.ratio || g.aspect_ratio || '',
                        resolution: g.resolution || g.size || '',
                        use_last_outputs:!!g.use_last_outputs,
                        use_attachments: !!useAttachments,
                        depends_on_previous: !!dependsPrev,
                        dependency_mode: dependsPrev ? dependency_mode : 'none',
                        shared_style: String(g.shared_style || sharedStyle || '').trim(),
                        results:[],
                        status:'running'
                    };
                    if(Array.isArray(g.attachment_indices)) gen.attachment_indices = g.attachment_indices.filter(i => Number.isFinite(Number(i)) && Number(i) >= 0).map(i => Math.floor(Number(i)));
                    if(Array.isArray(g.depends_on_steps)) gen.depends_on_steps = g.depends_on_steps;
                    if(Array.isArray(g.input_artifact_ids)) gen.input_artifact_ids = g.input_artifact_ids.map(value => String(value || '').trim()).filter(Boolean);
                    if(g.output_artifact_id) gen.output_artifact_id = String(g.output_artifact_id).trim();
                    return gen;
                });
            const collected = (data.collected && typeof data.collected === 'object') ? data.collected : {};
            const nextDimension = typeof data.next_dimension === 'string' ? data.next_dimension : '';
            const remainingDimensions = Array.isArray(data.remaining_dimensions) ? data.remaining_dimensions : [];
            parsedCandidates.push({
                reply,
                options,
                prompts,
                generations,
                shared_style: sharedStyle,
                plan: (data.plan && typeof data.plan === "object") ? data.plan : null,
                collected,
                next_dimension: nextDimension,
                remaining_dimensions: remainingDimensions
            });
        } catch(e) { /* 尝试下一个候选 */ }
    }
    // 如果有多个解析成功的候选，按优先级选择：
    // 1. 优先选择有 options 且无 generations 的（思维模式维度选择轮次）
    // 2. 其次选择有 options 的
    // 3. 其次选择有 prompts 的
    // 4. 其次选择有 generations 的
    // 5. 最后选择有 reply 的
    if(parsedCandidates.length > 0){
        const score = c => {
            let s = 0;
            if(c.options.length > 0 && c.generations.length === 0) s += 100; // 思维模式维度选择
            else if(c.options.length > 0) s += 50;
            if(c.prompts.length > 0) s += 30;
            // 可执行规划优先：步数越多越可信，避免残缺 generations 抢赢完整 JSON
            if(c.generations.length > 0) s += 20 + Math.min(40, c.generations.length * 8);
            if(c.reply) s += 10;
            if(Object.keys(c.collected).length > 0) s += 5;
            return s;
        };
        parsedCandidates.sort((a, b) => score(b) - score(a));
        return parsedCandidates[0];
    }
    // JSON 解析失败时的 fallback 链
    console.warn('[parseAgentResponse] JSON.parse 失败，尝试 fallback 提取，原始文本:', text.slice(0, 500));
    // ★ 先尝试用正则从原始文本中提取 JSON 字段（兜底）
    const regexResult = extractFieldsWithRegex(text);
    const hasRegexContent = regexResult.reply || regexResult.options.length > 0 || regexResult.prompts.length > 0 || regexResult.generations.length > 0;
    if(hasRegexContent){
        // 自动追加自定义输入选项
        if(regexResult.options.length > 0 && regexResult.options.length < 8 && !regexResult.options.some(o => o.value === 'CUSTOM_INPUT')){
            regexResult.options.push({label:'自定义输入', value:'CUSTOM_INPUT'});
        }
        console.info('[parseAgentResponse] 正则提取成功:', {options:regexResult.options.length, prompts:regexResult.prompts.length, generations:regexResult.generations.length});
        return regexResult;
    }
    const numberedFallback = extractNumberedOptions(text);
    if(numberedFallback){
        const fallbackOptions = numberedFallback.options || [];
        // 自动追加自定义输入选项
        if(fallbackOptions.length > 0 && fallbackOptions.length < 8 && !fallbackOptions.some(o => o.value === 'CUSTOM_INPUT')){
            fallbackOptions.push({label:'自定义输入', value:'CUSTOM_INPUT'});
        }
        return {reply:numberedFallback.reply || text, options:fallbackOptions, prompts:[], generations:[], collected:{}, next_dimension:'', remaining_dimensions:[]};
    }
    const clarifyOptions = extractClarifyOptions(text, lastUserText);
    if(clarifyOptions){
        const fallbackOptions = clarifyOptions || [];
        // 自动追加自定义输入选项
        if(fallbackOptions.length > 0 && fallbackOptions.length < 8 && !fallbackOptions.some(o => o.value === 'CUSTOM_INPUT')){
            fallbackOptions.push({label:'自定义输入', value:'CUSTOM_INPUT'});
        }
        return {reply:text, options:fallbackOptions, prompts:[], generations:[], collected:{}, next_dimension:'', remaining_dimensions:[]};
    }
    return {reply:text, options:[], prompts:[], generations:[], collected:{}, next_dimension:'', remaining_dimensions:[]};
}

function agentNormalizeTaskType(value=''){
    const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
        three_view:'three_view', threeview:'three_view', product_view:'three_view', product_views:'three_view', 三视图:'three_view',
        main:'main', hero:'main', product_hero:'main', 主图:'main',
        detail:'detail', detail_page:'detail', details:'detail', 详情:'detail', 详情页:'detail', 详情图:'detail',
        variant:'variant', 变体:'variant', edit:'edit', 编辑:'edit', 改图:'edit',
        fusion:'fusion', 融合:'fusion', other:'other', 其他:'other'
    };
    return aliases[raw] || 'other';
}
function agentNormalizeTaskSpec(value){
    const src = value && typeof value === 'object' ? value : null;
    if(!src || !Array.isArray(src.deliverables)) return null;
    const globalSrc = src.global_contract && typeof src.global_contract === 'object'
        ? src.global_contract
        : (src.globalContract && typeof src.globalContract === 'object' ? src.globalContract : null);
    const globalContract = globalSrc ? {
        // 只去掉首尾空白，正文内容保持原样，不能在执行层摘要或改写。
        visual_positioning: String(globalSrc.visual_positioning || '').trim(),
        unified_style_prompt: String(globalSrc.unified_style_prompt || '').trim(),
        unified_negative_prompt: String(globalSrc.unified_negative_prompt || '').trim()
    } : null;
    const deliverables = src.deliverables.map((item, index) => {
        if(!item || typeof item !== 'object') return null;
        const type = agentNormalizeTaskType(item.type || item.kind || item.role || 'other');
        const count = Math.max(1, Math.min(24, Math.floor(Number(item.count) || 1)));
        const ratio = agentNormalizeRatioValue(item.ratio || item.aspect_ratio || '');
        const resolution = agentNormalizeResolutionValue(item.resolution || item.size || '');
        return {
            id: String(item.id || `deliverable_${index + 1}`).trim(),
            type,
            title: String(item.title || item.name || '').trim() || `成果${index + 1}`,
            count,
            ratio,
            resolution,
            // 阶段1可提供的任务契约元数据；执行层只透传，不自行创造页面语义。
            page_function: String(item.page_function || item.function || '').trim(),
            required_fields: Array.isArray(item.required_fields) ? item.required_fields.map(v => String(v || '').trim()).filter(Boolean) : [],
            input_artifact_ids: Array.isArray(item.input_artifact_ids) ? item.input_artifact_ids.map(v => String(v || '').trim()).filter(Boolean) : [],
            output_artifact_id: String(item.output_artifact_id || '').trim()
        };
    }).filter(Boolean);
    if(!deliverables.length) return null;
    const normalized = {schema_version:Number(src.schema_version) || 1, deliverables};
    if(globalContract && Object.values(globalContract).some(Boolean)) normalized.global_contract = globalContract;
    return normalized;
}
function agentParseUnderstandingResponse(raw=''){
    const source = String(raw || '').trim();
    const markerRe = /<!--\s*AGENT_TASK_SPEC\s*([\s\S]*?)\s*AGENT_TASK_SPEC\s*-->/i;
    const marker = source.match(markerRe);
    let taskSpec = null;
    let taskSpecError = '';
    if(marker){
        let jsonText = String(marker[1] || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        try{
            taskSpec = agentNormalizeTaskSpec(JSON.parse(jsonText));
        }catch(error){
            try{ taskSpec = agentNormalizeTaskSpec(JSON.parse(repairJsonString(jsonText))); }
            catch(_){ taskSpecError = String(error?.message || error || '任务单 JSON 无效'); }
        }
    }else{
        taskSpecError = '缺少 AGENT_TASK_SPEC';
    }
    const text = source.replace(markerRe, '').trim();
    return {text, taskSpec, taskSpecError};
}
function agentExpandTaskSpec(taskSpec){
    const spec = agentNormalizeTaskSpec(taskSpec);
    if(!spec) return [];
    const expanded = [];
    spec.deliverables.forEach(deliverable => {
        for(let i = 0; i < deliverable.count; i++){
            expanded.push({
                deliverable_id: deliverable.id,
                type: deliverable.type,
                title: deliverable.count > 1 ? `${deliverable.title}${i + 1}` : deliverable.title,
                ratio: deliverable.ratio,
                resolution: deliverable.resolution,
                page_function: deliverable.page_function,
                required_fields: deliverable.required_fields.slice(),
                input_artifact_ids: deliverable.input_artifact_ids.slice(),
                output_artifact_id: deliverable.output_artifact_id
            });
        }
    });
    return expanded;
}
function agentTaskTypeToRole(type='other'){
    const normalized = agentNormalizeTaskType(type);
    if(normalized === 'three_view') return 'product_hero';
    if(['main','detail','variant','edit','fusion'].includes(normalized)) return normalized;
    return 'other';
}
function agentApplyTaskSpecToPlan(parsed, taskSpec){
    const expected = agentExpandTaskSpec(taskSpec);
    const gens = Array.isArray(parsed?.generations) ? parsed.generations : [];
    const errors = [];
    if(!expected.length) return {ok:true, errors, expected};
    if(gens.length !== expected.length){
        errors.push(`任务单要求 ${expected.length} 个步骤，LLM 返回 ${gens.length} 个步骤`);
        return {ok:false, errors, expected};
    }
    gens.forEach((gen, index) => {
        const requirement = expected[index];
        gen.type = requirement.type;
        gen.role = agentTaskTypeToRole(requirement.type);
        gen.task_spec_title = requirement.title;
        gen.task_spec_page_function = requirement.page_function || '';
        gen.task_spec_required_fields = Array.isArray(requirement.required_fields) ? requirement.required_fields.slice() : [];
        if(!String(gen.title || '').trim()) gen.title = requirement.title;
        if(requirement.input_artifact_ids?.length && !Array.isArray(gen.input_artifact_ids)){
            gen.input_artifact_ids = requirement.input_artifact_ids.slice();
        }
        if(requirement.output_artifact_id && !String(gen.output_artifact_id || '').trim()){
            gen.output_artifact_id = requirement.output_artifact_id;
        }
        gen.count = 1;
        if(requirement.ratio){
            gen.ratio = requirement.ratio;
            gen.parameter_sources = {...(gen.parameter_sources || {}), ratio:'task_spec'};
        }
        if(requirement.resolution){
            gen.resolution = requirement.resolution;
            gen.parameter_sources = {...(gen.parameter_sources || {}), resolution:'task_spec'};
        }
    });
    parsed.task_spec = agentNormalizeTaskSpec(taskSpec);
    return {ok:true, errors, expected};
}
function agentBindSkillPlanPagesToGenerations(parsed, confirmedPlanText='', taskSpec=null, skills=[]){
    const gens = Array.isArray(parsed?.generations) ? parsed.generations : [];
    const planText = String(confirmedPlanText || '').trim();
    const hasSkill = agentNormalizeSkillList(skills).length > 0;
    // 不以 Skill 名称或固定字段决定是否绑定。先按阶段1正文识别实际的逐项
    // 策划块；只有识别到页面/步骤块时才做原文绑定。这样自定义 Skill 的
    // 标题、单图任务和非电商任务不会被强行套用详情页模板。
    if(!hasSkill || !planText || !gens.length) return {bound:0, blocks:[]};

    const lines = planText.split(/\r?\n/);
    const blocks = [];
    let sectionType = '';
    let current = null;
    const flush = () => {
        if(!current) return;
        current.text = current.lines.join('\n').trim();
        if(current.text) blocks.push(current);
        current = null;
    };
    lines.forEach(line => {
        const plain = String(line || '').trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim();
        if(/第一部分.*主图|主图方案/.test(plain) && !/^第\s*[0-9一二两三四五六七八九十]+\s*(?:页|步|张)/.test(plain)){
            flush(); sectionType = 'main'; return;
        }
        if(/第二部分.*详情|详情页方案|详情图方案/.test(plain) && !/^第\s*[0-9一二两三四五六七八九十]+\s*(?:页|步|张)/.test(plain)){
            flush(); sectionType = 'detail'; return;
        }
        if(/^(?:最后输出|视觉整体定位|统一风格提示词|统一负面提示词)\s*[：:]?/.test(plain)){
            flush(); return;
        }
        // Skill 的逐页标题可能写成“第1页：...”“第1步 ...”或“1. ...”。
        // 只要阶段1已经通过逐页字段数量校验，这些标题都应作为无损绑定边界。
        const pageMatch = plain.match(/^(?:第\s*([0-9一二两三四五六七八九十]+)\s*(?:页|步|张)|([0-9]{1,2})\s*[.、)])\s*[：:]?\s*(.*)$/);
        if(pageMatch){
            flush();
            const heading = plain;
            const inferredType = /详情/.test(heading) ? 'detail' : (/主图|主视觉/.test(heading) ? 'main' : sectionType);
            current = {type:inferredType || '', page:pageMatch[1] || pageMatch[2], title:pageMatch[3] || heading, lines:[line]};
            return;
        }
        if(current) current.lines.push(line);
    });
    flush();
    if(!blocks.length) return {bound:0, blocks:[]};

    const normalizedTaskSpec = agentNormalizeTaskSpec(taskSpec);
    const contract = normalizedTaskSpec?.global_contract || null;
    const contractComplete = !!contract
        && ['visual_positioning','unified_style_prompt','unified_negative_prompt']
            .every(key => String(contract?.[key] || '').trim());
    const globalLabels = ['视觉整体定位','统一风格提示词','统一负面提示词'];
    const plainGlobalLine = line => String(line || '')
        .trim()
        .replace(/^#{1,6}\s*/, '')
        .replace(/^(?:[-*+]\s*)/, '')
        .replace(/\*\*/g, '')
        .trim();
    const globalIndexes = globalLabels.map(label => lines.findIndex(line => new RegExp(`^${label}\\s*[：:]?`).test(plainGlobalLine(line))));
    const bodyGlobalComplete = globalIndexes.every(index => index >= 0);
    const isGlobalBoundary = (line, currentIndex) => {
        const plain = plainGlobalLine(line);
        if(globalIndexes.includes(currentIndex)) return true;
        return /^(?:【?第[一二三四五六七八九十0-9]+部分|第一部分|第二部分|第三部分|主图方案|详情(?:页|图)?方案|第\s*[0-9一二两三四五六七八九十]+\s*页)/.test(plain);
    };
    const bodyGlobalText = bodyGlobalComplete ? globalIndexes.map(start => {
        let end = lines.length;
        for(let i = start + 1; i < lines.length; i++){
            if(isGlobalBoundary(lines[i], i)){ end = i; break; }
        }
        return lines.slice(start, end).join('\n').trim();
    }).filter(Boolean).join('\n\n') : '';
    const structuredGlobalText = contractComplete ? [
        `视觉整体定位：${contract.visual_positioning}`,
        `统一风格提示词：${contract.unified_style_prompt}`,
        `统一负面提示词：${contract.unified_negative_prompt}`
    ].join('\n') : '';
    // 结构化字段是阶段1正文的逐字镜像；正文标题不稳定时仍能完整、无损地下传三项全局约束。
    const unifiedText = bodyGlobalText || structuredGlobalText;
    const expected = agentExpandTaskSpec(normalizedTaskSpec);
    const used = new Set();
    let bound = 0;
    gens.forEach((gen, index) => {
        const type = expected[index]?.type || agentNormalizeTaskType(gen?.type || gen?.role || 'other');
        // 当阶段1逐页块与任务单完全一一对应时，按原始顺序绑定最可靠，
        // Logo、三视图、包装等非 main/detail 页面同样必须保留 Skill 原文。
        let blockIndex = expected.length === gens.length && blocks.length === gens.length
            ? index
            : blocks.findIndex((block, i) => !used.has(i) && block.type === type);
        if(blockIndex < 0) blockIndex = blocks.findIndex((block, i) => !used.has(i));
        if(blockIndex < 0) return;
        used.add(blockIndex);
        const block = blocks[blockIndex];
        const verbatim = [block.text, unifiedText].filter(Boolean).join('\n\n').trim();
        if(!verbatim) return;
        gen.prompt = verbatim;
        gen.plannedPrompt = verbatim;
        gen.professionalPrompt = verbatim;
        gen.skill_plan_text = block.text;
        if(unifiedText) gen.skill_global_contract_text = unifiedText;
        gen.skill_plan_source = 'stage1_verbatim';
        bound += 1;
    });
    parsed.skill_plan_binding = {bound, page_blocks:blocks.length, source:'stage1_verbatim'};
    return {bound, blocks};
}
// 处理 LLM 返回结果：解析、兜底、创建 assistant 消息、运行生图
// 提取为独立函数，以便刷新恢复时复用

// 轻量护栏：当 LLM 在 reply 里写了“5个步骤/五种表情：A、B、C...”，但 generations 只有 1 条时，按列举拆成多步。
// 不做业务工作流，只避免“嘴上多步、结构单步”。
function agentHydrateGenerationsFromPlanText(parsed, userText=''){
    if(!parsed || !Array.isArray(parsed.generations)) return parsed;
    const reply = String(parsed.reply || parsed.text || '');
    const allText = `${userText}\n${reply}`;
    const labels = agentExtractListedStepLabels(allText);
    const stepN = agentExtractExplicitStepCount(allText);
    const style = String(parsed.shared_style || parsed.generations[0]?.shared_style || '').trim();
    const ratio = parsed.generations[0]?.ratio || chatRequestedRatio(allText) || '';
    const resolution = parsed.generations[0]?.resolution || chatRequestedResolution(allText) || '';

    // A) 只有 1 条，但规划写了 N 种/ N 步：拆成 N 条纯净提示词
    if(parsed.generations.length === 1){
        const n = Math.max(labels.length, stepN);
        if(n > 1){
            const base = parsed.generations[0];
            const names = (labels.length >= n ? labels.slice(0, n) : Array.from({length:n}, (_,i)=> labels[i] || `变体${i+1}`))
                .map((x,i)=>agentSanitizeStepLabel(x,i));
            parsed.generations = names.map((label, i) => ({
                ...base,
                title: label,
                role: base.role || 'variant',
                prompt: agentBuildStepPromptFromBase(base.prompt || userText, label, i, n, style),
                count: 1,
                ratio: ratio || base.ratio || '',
                resolution: resolution || base.resolution || '',
                use_attachments: base.use_attachments !== false,
                use_last_outputs: !!base.use_last_outputs,
                depends_on_previous: false,
                dependency_mode: 'none',
                shared_style: style,
                results: [],
                status: 'running'
            }));
            parsed.plan_hydrated = true;
            return parsed;
        }
    }

    // B) 多条但提示词几乎相同，或 title/正文被脏标签污染：重写为互不相同的纯净提示词
    if(parsed.generations.length > 1){
        const prompts = parsed.generations.map(g => String(g.prompt || '').replace(/\s+/g, ' ').trim());
        const dirty = prompts.some(p => /本张专属表情|清晰表现“|第\s*\d+\s*\/\s*\d+|步骤\s*\d+|1比例/.test(p));
        const same = prompts.every(p => p && p === prompts[0]);
        const nearlySame = same || (prompts[0] && prompts.every(p => p.slice(0, 40) === prompts[0].slice(0, 40)));
        if(dirty || nearlySame){
            const names = parsed.generations.map((g, i) => agentSanitizeStepLabel(g.title || labels[i] || `变体${i+1}`, i));
            // 若标题仍是变体N且有表情 labels，优先 labels
            const finalNames = (labels.length === parsed.generations.length) ? labels.map((x,i)=>agentSanitizeStepLabel(x,i)) : names;
            const basePrompt = parsed.generations[0].prompt || userText;
            parsed.generations = parsed.generations.map((g, i) => ({
                ...g,
                title: finalNames[i],
                prompt: agentBuildStepPromptFromBase(basePrompt, finalNames[i], i, parsed.generations.length, style || g.shared_style || ''),
                count: 1,
                ratio: g.ratio || ratio || '',
                resolution: g.resolution || resolution || '',
                use_attachments: g.use_attachments !== false
            }));
            parsed.plan_hydrated = true;
        }
    }
    return parsed;
}

function agentExtractExplicitStepCount(text=''){
    const t = String(text || '');
    const m = t.match(/([1-9]\d?|[一二三四五六七八九十两])\s*(?:个独立步骤|个步骤|步独立生成|张独立|种明确|种表情|种情绪|种姿势|种风格)/);
    if(!m) return 0;
    const raw = m[1];
    if(/^\d+$/.test(raw)) return Math.min(24, parseInt(raw,10));
    return Math.min(24, agentCnNumToInt(raw) || 0);
}
function agentExtractListedStepLabels(text=''){
    const t = String(text || '');
    const bad = (s) => !s || /比例|步骤\s*\d|\d+\s*\/\s*\d|^[\d.:：]+$|^\d+\s*k$|1:1|2k|4k|9:16|16:9|画质|分辨率/i.test(s);
    let body = '';
    let m = t.match(/[（(]([^）)]{2,120})[）)]/);
    if(m) body = m[1];
    if(!body){
        m = t.match(/(?:表情|情绪|姿势|角度|风格|变体)[^：:（(\n]{0,8}[:：为]?\s*([^\n。；;]{2,120})/);
        if(m) body = m[1];
    }
    if(!body){
        m = t.match(/((?:开心|大笑|高兴|震惊|吃惊|惊讶|流泪|难过|伤心|疑惑|困惑|害羞|腼腆|愤怒|生气|平静|冷静)(?:\s*[、,，/|]\s*(?:开心|大笑|高兴|震惊|吃惊|惊讶|流泪|难过|伤心|疑惑|困惑|害羞|腼腆|愤怒|生气|平静|冷静)){1,12})/);
        if(m) body = m[1];
    }
    if(!body) return [];
    return body.split(/[、,，/|]/)
        .map(s => s.replace(/^(?:和|与|及)\s*/, '').replace(/等$/, '').replace(/的?1\s*[:：]\s*1.*$/, '').trim())
        .filter(s => !bad(s) && s.length <= 12);
}

function agentBuildStepPromptFromBase(basePrompt, label, index, total, style=''){
    const tag = agentSanitizeStepLabel(label, index);
    const styleLine = String(style || '').trim();
    // 只保留通用视觉底稿，去掉步骤编号/脏标签/旧表情句
    let common = String(basePrompt || '')
        .replace(/【统一设定[·・]?不可变更】/g, ' ')
        .replace(/本张为第\s*\d+\s*\/\s*\d+\s*张[^\n。]*/g, ' ')
        .replace(/本张专属表情[：:][^\n。]*/g, ' ')
        .replace(/重点表现[：:][^\n。]*/g, ' ')
        .replace(/清晰表现[“"][^”"]+[”"]这一情绪[^\n。]*/g, ' ')
        .replace(/第\s*\d+\s*\/\s*\d+\s*张/g, ' ')
        .replace(/步骤\s*\d+/g, ' ')
        .replace(/不要和其他步骤重复[^\n。]*/g, ' ')
        .replace(/只表现这一种表情[^\n。]*/g, ' ')
        .replace(/(开心|大笑|高兴|震惊|吃惊|惊讶|流泪|难过|伤心|疑惑|困惑|害羞|腼腆|愤怒|生气|平静|冷静)[^，。；;\n]{0,30}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if(common.length < 12){
        common = '严格参考上传的角色/产品参考图，保持外形、材质、轮廓与关键特征一致；画面完整，构图清晰，高质量成像。';
    }
    if(styleLine && !common.includes(styleLine)){
        common = `${styleLine}。${common}`;
    }
    const action = agentEmotionActionLine(tag);
    // 纯净提示词：只放视觉描述，不放步骤编号/系统话术
    return `${common} 表情为${tag}：${action} 构图清晰，1:1，2K，角色特征稳定，画面干净。`;
}
function agentSanitizeStepLabel(label, index=0){
    let s = String(label || '').trim();
    s = s.replace(/本张专属表情[：:]/g, '').replace(/重点表现[：:]/g, '').replace(/^变体\s*\d+$/i, '').trim();
    if(!s || /比例|步骤\s*\d|\d+\s*\/\s*\d|1\s*[:：]\s*1|2\s*k|4\s*k|9\s*[:：]\s*16|画质|变体\s*\d+/i.test(s)){
        const emotionDefaults = ['开心大笑','疑惑困惑','惊讶震惊','害羞腼腆','生气愤怒','平静自然','流泪难过','得意挑眉'];
        return emotionDefaults[Math.max(0, index) % emotionDefaults.length];
    }
    // 过长或含参数噪声时截断
    s = s.split(/[，,。；;]/)[0].trim();
    return s.slice(0, 12) || ['开心大笑','疑惑困惑','惊讶震惊','害羞腼腆'][Math.max(0, index) % 4];
}

function agentEmotionActionLine(label=''){
    const t = String(label || '');
    if(/开心|高兴|愉快/.test(t) && !/大笑|狂喜/.test(t)) return '角色开心微笑，眼睛弯成月牙，嘴角上扬，整体轻快愉悦，表情夸张可读。';
    if(/大笑|狂喜|开心大笑/.test(t)) return '角色开怀大笑，嘴巴张大，眼睛眯起，情绪夸张强烈，五官动作明确。';
    if(/震惊|吃惊|惊讶/.test(t)) return '角色震惊表情，眼睛睁大，嘴巴微张，身体略后仰，像突然被吓到。';
    if(/流泪|难过|伤心|哭泣/.test(t)) return '角色流泪难过，眼角有泪滴，嘴角下垂，神情委屈柔软。';
    if(/疑惑|困惑|疑问/.test(t)) return '角色疑惑表情，单侧眉毛上挑，头部微歪，眼神询问感强。';
    if(/害羞|腼腆|羞涩/.test(t)) return '角色害羞表情，眼神躲闪，脸颊带红晕，嘴角轻抿，姿态内敛。';
    if(/愤怒|生气/.test(t)) return '角色生气表情，眉头紧皱，嘴巴抿紧，眼神尖锐。';
    if(/平静|冷静|自然/.test(t)) return '角色平静自然表情，眼神安定，口鼻放松，姿态端正。';
    return `清晰表现“${t}”这一情绪，五官动作明确可读，表情夸张适合表情包。`;
}
function agentGetRunMode(){
    const mode = String(agentState?.runMode || 'auto').toLowerCase();
    return mode === 'semi' ? 'semi' : 'auto';
}
function agentSetRunMode(mode, {persist=true, silent=false}={}){
    if(!agentState) return;
    const next = String(mode || 'auto').toLowerCase() === 'semi' ? 'semi' : 'auto';
    agentState.runMode = next;
    try{
        const btn = document.getElementById('agentRunModeBtn');
        if(btn){
            btn.dataset.mode = next;
            btn.classList.toggle('is-auto', next === 'auto');
            btn.classList.toggle('is-semi', next === 'semi');
            btn.setAttribute('aria-pressed', next === 'semi' ? 'true' : 'false');
            btn.title = next === 'semi'
                ? '半自动：完整规划和提示词生成后，确认再执行'
                : '全自动：一次规划后直接执行（全托管）';
            const label = btn.querySelector('[data-run-mode-label]');
            if(label) label.textContent = next === 'semi' ? '半自动' : '全自动';
        }
    }catch(_){ }
    if(persist){
        try{ saveAgentState(true); }catch(_){ }
    }
    if(!silent && typeof toast === 'function'){
        toast(next === 'semi' ? '已切换为半自动' : '已切换为全自动');
    }
}
function agentToggleRunMode(){
    agentSetRunMode(agentGetRunMode() === 'semi' ? 'auto' : 'semi');
}
function agentBuildStageGateOptions(stage='execute'){
    const s = String(stage || 'execute').toLowerCase();
    if(s === 'understand' || s === 'plan_from_understand'){
        return [
            {label:'确认策划并继续规划', value:'AGENT_CONTINUE_PLAN'},
            {label:'切换全自动并继续', value:'AGENT_SWITCH_AUTO_PLAN'},
            {label:'修改策划', value:'AGENT_REVISE_PLANNING'}
        ];
    }
    return [
        {label:'继续执行', value:'AGENT_CONTINUE_EXECUTE'},
        {label:'切换全自动并执行', value:'AGENT_SWITCH_AUTO_EXECUTE'}
    ];
}
function agentPushStageGateMessage({conversationId='', understanding='', planText='', plan=null, generations=[], nextStage='execute', userMsg=null, attachments=[], userText='', sharedStyle='', artifacts=[], taskSpec=null}={}){
    const cid = conversationId || agentState?.activeConversationId || '';
    const requestedStage = String(nextStage || 'execute').toLowerCase();
    const stage = ['understand', 'plan', 'plan_from_understand'].includes(requestedStage) ? 'understand' : 'execute';
    const title = stage === 'understand'
        ? '已直出内容，是否继续需求理解与执行？'
        : '规划完成，是否继续执行？';
    const bodyParts = [title];
    if(stage === 'understand'){
        bodyParts.push('请先查看上方直出内容（含需求理解、参考图理解和提示词方案）。确认无误后再继续规划并执行。');
    }else if(Array.isArray(generations) && generations.length){
        bodyParts.push('已生成 ' + generations.length + ' 条完整提示词方案（见上方步骤卡片）。确认无误后继续执行。');
    }
    const options = agentBuildStageGateOptions(stage);
    const msg = {
        id: uid('am'),
        role: 'assistant',
        text: bodyParts.join(AGENT_NL),
        // 门禁消息只放短提示；完整直出正文在上一条消息里，避免重复折叠
        understanding: '',
        stage: stage === 'understand' ? 'understand' : 'plan',
        options,
        prompts: [],
        generations: [],
        pendingPlan: stage === 'understand' ? null : {
            plan: plan || null,
            generations: Array.isArray(generations) ? generations : [],
            shared_style: sharedStyle || '',
            artifacts: Array.isArray(artifacts) ? artifacts.slice() : [],
            taskSpec: agentNormalizeTaskSpec(taskSpec),
            reply: String(planText || '').trim()
        },
        stageGate: {
            stage,
            next: stage === 'understand' ? 'plan' : 'execute',
            userText: userText || '',
            attachments: Array.isArray(attachments) ? attachments.slice() : [],
            userMsgId: userMsg?.id || '',
            understanding: String(understanding || planText || '').trim(),
            planText: String(planText || '').trim(),
            sharedStyle: sharedStyle || '',
            artifacts: Array.isArray(artifacts) ? artifacts.slice() : [],
            taskSpec: agentNormalizeTaskSpec(taskSpec)
        },
        contextSources: userMsg?.contextSources || null,
        ts: Date.now(),
        conversationId: cid
    };
    agentPushMessageToConversation(cid, msg);
    agentPatchConversationWorkflow(cid, workflow => {
        workflow.status = 'awaiting_confirm';
        workflow.updatedAt = Date.now();
    });
    if(agentIsActiveConversation(cid)){
        agentThinking = false;
        agentThinkingStage = '';
        agentThinkingConversationId = '';
        agentSending = false;
        renderAgentMessages();
        updateAgentPrimaryAction();
        saveAgentState(true);
    }else{
        saveAgentState(true);
    }
    return msg;
}
function agentClosePlanLightbox(overlay){
    if(!overlay) return;
    overlay.classList.remove('is-open');
    const returnFocus = overlay.__agentReturnFocus;
    overlay.__agentReturnFocus = null;
    requestAnimationFrame(() => {
        try{
            if(returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
            else agentInput?.focus?.();
        }catch(_){ }
    });
}
function agentOpenPlanLightbox(text='', kind='', customTitle='', options={}){
    const body = String(text || '').trim();
    if(!body) return;
    const title = String(customTitle || '').trim()
        || ((String(kind || '').toLowerCase() === 'plan') ? '规划详情' : '策划详情');
    let overlay = document.getElementById('agent-plan-lightbox');
    if(!overlay){
        overlay = document.createElement('div');
        overlay.id = 'agent-plan-lightbox';
        overlay.className = 'agent-plan-lightbox';
        overlay.innerHTML = '<div class="agent-plan-lightbox-panel" role="dialog" aria-modal="true" aria-labelledby="agentPlanLightboxTitle">'
            + '<div class="agent-plan-lightbox-head">'
            + '<div class="agent-plan-lightbox-title" id="agentPlanLightboxTitle">策划详情</div>'
            + '<button type="button" class="agent-plan-lightbox-close" data-agent-plan-lightbox-close="1">关闭</button>'
            + '</div><div class="agent-plan-lightbox-body"></div>'
            + '<textarea class="agent-plan-lightbox-editor" aria-label="策划内容" hidden></textarea>'
            + '<div class="agent-plan-lightbox-actions" hidden><button type="button" data-agent-plan-lightbox-cancel="1">取消</button><button type="button" class="primary" data-agent-plan-lightbox-save="1">保存修改</button></div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if(e.target === overlay || e.target?.closest?.('[data-agent-plan-lightbox-close]')){
                agentClosePlanLightbox(overlay);
            }
            if(e.target?.closest?.('[data-agent-plan-lightbox-cancel]')) agentClosePlanLightbox(overlay);
            if(e.target?.closest?.('[data-agent-plan-lightbox-save]')) agentCommitPlanLightboxEdit(overlay);
        });
        overlay.addEventListener('keydown', e => {
            if(e.key !== 'Tab' || !overlay.classList.contains('is-open')) return;
            const focusable = [...overlay.querySelectorAll('button:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])')]
                .filter(element => element.offsetParent !== null);
            if(!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
            else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
        });
        document.addEventListener('keydown', (e) => {
            if(e.key === 'Escape'){
                const box = document.getElementById('agent-plan-lightbox');
                if(box?.classList.contains('is-open')){
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation?.();
                    agentClosePlanLightbox(box);
                }
            }
        }, true);
    }
    const titleEl = overlay.querySelector('.agent-plan-lightbox-title');
    if(titleEl) titleEl.textContent = title;
    const bodyEl = overlay.querySelector('.agent-plan-lightbox-body');
    if(bodyEl) bodyEl.textContent = body;
    const editable = !!options.editable && String(kind || '').toLowerCase() === 'understand';
    const editor = overlay.querySelector('.agent-plan-lightbox-editor');
    const actions = overlay.querySelector('.agent-plan-lightbox-actions');
    if(editor){ editor.value = body; editor.hidden = !editable; }
    if(bodyEl) bodyEl.hidden = editable;
    if(actions) actions.hidden = !editable;
    overlay.dataset.agentPlanMessageId = editable ? String(options.messageId || '') : '';
    overlay.dataset.agentPlanEditable = editable ? '1' : '0';
    try{
        const explicitReturnFocus = options?.returnFocus;
        const active = document.activeElement;
        const existingReturnFocus = overlay.__agentReturnFocus;
        overlay.__agentReturnFocus = explicitReturnFocus && typeof explicitReturnFocus.focus === 'function'
            ? explicitReturnFocus
            : (active && active !== document.body
                ? active
                : (existingReturnFocus && existingReturnFocus.isConnected ? existingReturnFocus : null));
    }catch(_){ overlay.__agentReturnFocus = null; }
    overlay.classList.add('is-open');
    requestAnimationFrame(() => {
        try{
            const focusTarget = editable ? editor : overlay.querySelector('[data-agent-plan-lightbox-close]');
            focusTarget?.focus?.();
        }catch(_){ }
    });
}
function agentCommitPlanLightboxEdit(overlay){
    if(!overlay || overlay.dataset.agentPlanEditable !== '1') return;
    const value = String(overlay.querySelector('.agent-plan-lightbox-editor')?.value || '').trim();
    const messageId = String(overlay.dataset.agentPlanMessageId || '');
    if(!value || !messageId){ if(typeof toast === 'function') toast('策划内容不能为空'); return; }
    const conversations = Array.isArray(agentState?.conversations) ? agentState.conversations : [];
    let target = null;
    let messages = agentState?.messages || [];
    for(const conv of conversations){
        const list = conv.id === agentState?.activeConversationId ? (agentState.messages || conv.messages || []) : (conv.messages || []);
        const hit = list.find(m => m?.id === messageId);
        if(hit){ target = hit; messages = list; break; }
    }
    if(!target) target = (agentState?.messages || []).find(m => m?.id === messageId) || null;
    if(!target){ if(typeof toast === 'function') toast('找不到要修改的策划'); return; }
    const old = String(target.understanding || '');
    target.understanding = value;
    if(!target.text || String(target.text).trim() === old.trim()) target.text = value;
    const cid = target.conversationId || agentState.activeConversationId || '';
    const list = agentEnsureConversationMessages(cid) || messages || [];
    const targetIndex = list.indexOf(target);
    // 同一阶段门禁必须同步新正文，后续规划只能读取修改后的版本。
    list.slice(Math.max(0, targetIndex + 1)).some(m => {
        if(!m?.stageGate || m.stageGate.consumed) return false;
        if(m.stageGate.stage === 'understand'){
            m.stageGate.understanding = value;
            m.stageGate.planText = value;
            return true;
        }
        return false;
    });
    const pendingRevise = agentGetPendingRevisePlanning(cid);
    if(pendingRevise) agentSetPendingRevisePlanning(cid, {...pendingRevise, understanding:value});
    agentClosePlanLightbox(overlay);
    renderAgentMessages();
    saveAgentState(true);
    if(typeof toast === 'function') toast('策划已修改，下一步将使用修改后的内容');
}
function agentOpenSkillLightbox(skill, returnFocus=null){
    if(!skill) return;
    const name = String(skill.name || '未命名 Skill').trim();
    const description = String(skill.description || '').trim();
    const content = String(skill.content || '').trim();
    if(!content){
        if(typeof toast === 'function') toast('这个 Skill 暂无内容');
        return;
    }
    const body = [description ? `说明：${description}` : '', content]
        .filter(Boolean)
        .join(AGENT_NL + AGENT_NL);
    agentOpenPlanLightbox(body, 'skill', `Skill · ${name}`, {returnFocus});
}
function agentBindPlanFoldInteractions(root){
    if(!root) return;
    root.querySelectorAll('[data-agent-plan-fold]').forEach(details => {
        const summary = details.querySelector('summary');
        if(!summary || summary.dataset.boundPlanFold === '1') return;
        summary.dataset.boundPlanFold = '1';
        if(!summary.querySelector('[data-agent-plan-lightbox-open]')){
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'agent-plan-lightbox-open';
            btn.dataset.agentPlanLightboxOpen = '1';
            btn.textContent = '放大';
            btn.title = '灯箱放大查看';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const body = details.querySelector('.agent-understanding-body');
                agentOpenPlanLightbox(body?.textContent || '', details.dataset.foldKind || '', '', {editable: details.dataset.foldKind === 'understand', messageId: details.dataset.agentPlanMessageId, returnFocus:e.currentTarget});
            });
            summary.appendChild(btn);
        }
        const body = details.querySelector('.agent-understanding-body');
        if(body && body.dataset.boundPlanBody !== '1'){
            body.dataset.boundPlanBody = '1';
            body.addEventListener('dblclick', () => agentOpenPlanLightbox(body.textContent || '', details.dataset.foldKind || '', '', {editable: details.dataset.foldKind === 'understand', messageId: details.dataset.agentPlanMessageId}));
        }
        details.addEventListener('toggle', () => {
            if(details.open){
                const bodyEl = details.querySelector('.agent-understanding-body');
                if(bodyEl && details.dataset.lightboxOnce !== '1'){
                    details.dataset.lightboxOnce = '1';
                    agentOpenPlanLightbox(bodyEl.textContent || '', details.dataset.foldKind || '', '', {editable: details.dataset.foldKind === 'understand', messageId: details.dataset.agentPlanMessageId});
                }
            }
        });
    });
}
async function agentStartRevisePlanning(gateMsg){
    if(!agentState || !gateMsg) return;
    const stage = gateMsg.stageGate || {};
    const ownerConversationId = gateMsg.conversationId || agentState.activeConversationId || '';
    const understandingText = stage.understanding || gateMsg.understanding || '';
    if(!understandingText){
        if(typeof toast === 'function') toast('当前没有可修改的策划内容');
        return;
    }
    gateMsg.options = [];
    gateMsg.stageGate = { ...(gateMsg.stageGate || {}), consumed: true, revisingAt: Date.now() };
    const tip = {
        id: uid('am'),
        role: 'assistant',
        text: '请直接发送你的修改意见。我会基于现有策划改写，不会重新从零理解。',
        options: [],
        prompts: [],
        generations: [],
        ts: Date.now(),
        conversationId: ownerConversationId
    };
    agentPushMessageToConversation(ownerConversationId, tip);
    const ownerMessages = agentEnsureConversationMessages(ownerConversationId) || [];
    const originalUserMsg = stage.userMsgId
        ? ownerMessages.find(message => message?.id === stage.userMsgId && message?.role === 'user')
        : null;
    agentSetPendingRevisePlanning(ownerConversationId, {
        conversationId: ownerConversationId,
        gateMsgId: gateMsg.id,
        understanding: understandingText,
        taskSpec: agentNormalizeTaskSpec(stage.taskSpec || gateMsg.taskSpec || null),
        userText: stage.userText || '',
        attachments: Array.isArray(stage.attachments) ? stage.attachments.slice() : [],
        userMsgId: stage.userMsgId || '',
        // “修改策划”属于原任务，模型也必须沿用原任务发送瞬间的快照。
        // 该副本同时兼容后续消息截断；旧数据没有快照时才允许回退当前 UI。
        requestedSettings: originalUserMsg?.requestedSettings
            ? {...originalUserMsg.requestedSettings}
            : null
    });
    agentSending = false;
    agentThinking = false;
    if(agentIsActiveConversation(ownerConversationId)){
        renderAgentMessages();
        updateAgentPrimaryAction();
        try{ agentInput?.focus?.(); }catch(_){ }
    }
    saveAgentState(true);
}
async function agentApplyRevisePlanning(feedbackText, reviseMeta, userMsg=null){
    if(!agentState) return false;
    const feedback = String(feedbackText || '').trim();
    const requestedConversationId = String(userMsg?.conversationId || agentState.activeConversationId || '').trim();
    const meta = reviseMeta || agentGetPendingRevisePlanning(requestedConversationId) || null;
    if(!meta || !feedback) return false;
    const ownerConversationId = meta.conversationId || agentState.activeConversationId || '';
    const baseUnderstanding = String(meta.understanding || '').trim();
    const userText = String(meta.userText || '').trim();
    const baseTaskSpec = agentNormalizeTaskSpec(meta.taskSpec || null);
    const attachments = Array.isArray(meta.attachments) ? meta.attachments.slice() : [];
    const ownerMessages = agentEnsureConversationMessages(ownerConversationId) || [];
    const originalUserMsg = meta.userMsgId
        ? ownerMessages.find(message => message?.id === meta.userMsgId && message?.role === 'user')
        : null;
    const frozenSettings = originalUserMsg?.requestedSettings || meta.requestedSettings || null;
    const hasFrozenChatModel = !!(
        String(frozenSettings?.chatProvider || '').trim()
        || String(frozenSettings?.chatModel || '').trim()
    );
    if(!chatApiProviders().length){
        if(typeof toast === 'function') toast(tr('smart.agentNeedChatModel'));
        return true;
    }
    const provider = resolveChatProviderId(
        hasFrozenChatModel
            ? (frozenSettings?.chatProvider || agentState.chatProvider)
            : agentState.chatProvider
    );
    const model = resolveChatModel(
        hasFrozenChatModel
            ? (frozenSettings?.chatModel || '')
            : agentState.chatModel,
        provider
    );
    agentSending = true;
    agentThinking = true;
    agentThinkingStage = 'understand';
    agentThinkingConversationId = ownerConversationId;
    if(agentIsActiveConversation(ownerConversationId)) renderAgentMessages();
    try{
        const revisePrompt = [
            '你是画布 Agent 的策划改写器。',
            '请基于【原策划】和【用户修改意见】输出改写后的完整策划正文。',
            '要求：输出改写后的策划正文，并在文末输出唯一的 AGENT_TASK_SPEC；不要 generations。',
            '保留原策划中正确且未被否定的内容，重点落实用户修改意见。',
            '原任务单中的 global_contract 必须逐字保留；若用户明确修改其中内容，则正文三个全局标题与 global_contract 三字段必须同步修改。',
            '',
            '【原用户要求】',
            userText || '（无）',
            '',
            '【原策划】',
            baseUnderstanding || '（无）',
            '',
            '【原任务单】',
            baseTaskSpec ? JSON.stringify(baseTaskSpec) : '（无）',
            '',
            '【用户修改意见】',
            feedback
        ].join(AGENT_NL);
        const result = await agentCreateAndWaitLlmTask({
            message: revisePrompt,
            messages: [],
            images: attachments.slice(0, AGENT_LLM_IMAGE_MAX).map(i => i.url).filter(Boolean),
            videos: [],
            model,
            provider,
            ms_model: provider === 'modelscope' ? model : '',
            system_prompt: `你只输出改写后的完整策划正文，并在文末附加：<!-- AGENT_TASK_SPEC\n{"schema_version":2,"global_contract":{"visual_positioning":"视觉整体定位原文","unified_style_prompt":"统一风格提示词原文","unified_negative_prompt":"统一负面提示词原文"},"deliverables":[{"type":"three_view|main|detail|variant|edit|fusion|other","title":"成果名称","count":1,"ratio":"1:1","resolution":"2k"}]}\nAGENT_TASK_SPEC -->。任务单必须同步用户修改；global_contract 逐字镜像正文三项全局约束；不要输出 generations。`
        }, {
            stream:true,
            conversationId:ownerConversationId,
            requestId:userMsg?._pendingRequestId || agentGetConversationPending(ownerConversationId)?._pendingRequestId || ''
        });
        const revisedEnvelope = agentParseUnderstandingResponse(result?.text || '');
        const newUnderstanding = agentNormalizeUnderstandingText(revisedEnvelope.text || '');
        const revisedTaskSpec = revisedEnvelope.taskSpec;
        if(!newUnderstanding) throw new Error('策划改写失败：模型没有返回内容');
        if(!revisedTaskSpec) throw new Error(`策划改写失败：任务单无效（${revisedEnvelope.taskSpecError || '缺少 deliverables'}）`);
        if(originalUserMsg){ originalUserMsg.understanding = newUnderstanding; originalUserMsg.taskSpec = revisedTaskSpec; }
        const revisedMsg = {
            id: uid('am'),
            role: 'assistant',
            text: newUnderstanding,
            understanding: newUnderstanding,
            stage: 'understand',
            options: [],
            prompts: [],
            generations: [],
            revisedPlanning: true,
            taskSpec: revisedTaskSpec,
            conversationId: ownerConversationId,
            ts: Date.now()
        };
        agentPushMessageToConversation(ownerConversationId, revisedMsg);
        // 只消费本对话当前这张修改卡；A 返回时不能清掉 B 刚进入的修改策划状态。
        agentClearPendingRevisePlanning(ownerConversationId, meta);
        agentPushStageGateMessage({
            conversationId: ownerConversationId,
            understanding: newUnderstanding,
            planText: '',
            nextStage: 'understand',
            userMsg: originalUserMsg || userMsg || null,
            attachments,
            userText,
            taskSpec: revisedTaskSpec
        });
        return true;
    }catch(err){
        const cid = ownerConversationId;
        agentPushMessageToConversation(cid, {
            id: uid('am'),
            role: 'assistant',
            text: '策划修改失败：' + String(err?.message || err).slice(0, 240),
            generations: [],
            ts: Date.now(),
            conversationId: cid
        });
        if(agentIsActiveConversation(cid)) renderAgentMessages();
        return true;
    }finally{
        agentSending = false;
        agentThinking = false;
        agentThinkingStage = '';
        agentThinkingConversationId = '';
        updateAgentPrimaryAction();
        saveAgentState(true);
    }
}
async function agentContinueFromUnderstanding(gateMsg, {forceAuto=false}={}){
    if(!agentState || !gateMsg) return;
    const stage = gateMsg.stageGate || {};
    const ownerConversationId = gateMsg.conversationId || agentState.activeConversationId || '';
    const understandingText = String(stage.understanding || gateMsg.understanding || '').trim();
    const userText = String(stage.userText || '').trim();
    const attachments = Array.isArray(stage.attachments) ? stage.attachments.slice() : [];
    const taskSpec = agentNormalizeTaskSpec(stage.taskSpec || gateMsg.taskSpec || null);
    if(!understandingText && !userText){
        if(typeof toast === 'function') toast('没有可继续的策划内容');
        return;
    }
    if(agentGlobalTaskOwnedByOther(ownerConversationId) || !agentTryAcquireGlobalTask(ownerConversationId)){
        agentNotifyGlobalTaskBlocked();
        updateAgentPrimaryAction();
        return;
    }
    try{
    if(forceAuto) agentSetRunMode('auto', {silent:true});
    const userMsg = {
        id: stage.userMsgId || uid('um'),
        role: 'user',
        text: userText,
        images: attachments,
            understanding: understandingText,
            taskSpec,
            artifacts: Array.isArray(stage.artifacts) ? stage.artifacts.slice() : [],
        requirementArtifactId: stage.artifacts?.[0]?.id || '',
        conversationId: ownerConversationId,
        fromStageContinue: true,
        skipUnderstand: true
    };
    try{
        const msgs = agentEnsureConversationMessages(ownerConversationId) || [];
        const origin = stage.userMsgId ? msgs.find(m => m.id === stage.userMsgId) : null;
        if(origin){
            origin.understanding = understandingText;
            userMsg.id = origin.id;
            userMsg.parts = origin.parts;
            userMsg.skills = origin.skills;
            userMsg.taskSpec = agentNormalizeTaskSpec(origin.taskSpec || userMsg.taskSpec);
            if(!userMsg.images?.length && Array.isArray(origin.images)) userMsg.images = origin.images.slice();
            if(!userMsg.artifacts?.length && Array.isArray(origin.artifacts)) userMsg.artifacts = origin.artifacts.slice();
            userMsg.requirementArtifactId = origin.requirementArtifactId || userMsg.requirementArtifactId || '';
            if(!userMsg.text) userMsg.text = origin.text || '';
            userMsg.contextHistory = Array.isArray(origin.contextHistory) ? origin.contextHistory.slice() : [];
            userMsg.canvasSnapshot = origin.canvasSnapshot || null;
            userMsg.contextSources = origin.contextSources || null;
            userMsg.requestedSettings = origin.requestedSettings ? {...origin.requestedSettings} : null;
            userMsg.memorySnapshot = origin.memorySnapshot ? JSON.parse(JSON.stringify(origin.memorySnapshot)) : null;
        }
    }catch(_){ }
    gateMsg.options = [];
    gateMsg.stageGate = { ...(gateMsg.stageGate||{}), consumed:true, continuedAt: Date.now() };
    saveAgentState(true);
    await agentRunPlanningFromUnderstanding({
        conversationId: ownerConversationId,
        userMsg,
        text: userMsg.text || userText,
        attachments: userMsg.images || attachments,
        understandingText,
        taskSpec,
        bypassThinking: false
    });
    }finally{
        agentReleaseGlobalTask(ownerConversationId);
        if(agentIsActiveConversation(ownerConversationId)) updateAgentPrimaryAction();
    }
}
async function agentContinueFromPlanGate(gateMsg, {forceAuto=false}={}){
    if(!agentState || !gateMsg) return;
    const pending = gateMsg.pendingPlan || {};
    const gens = Array.isArray(pending.generations) ? pending.generations.map(g => ({
        ...g,
        status: (g && (g.status === 'done' || g.status === 'error')) ? g.status : 'running',
        results: Array.isArray(g?.results) ? g.results : []
    })) : [];
    if(!gens.length){
        if(typeof toast === 'function') toast('没有可执行的规划步骤');
        return;
    }
    const ownerConversationId = gateMsg.conversationId || agentState.activeConversationId || '';
    if(agentGlobalTaskOwnedByOther(ownerConversationId) || !agentTryAcquireGlobalTask(ownerConversationId)){
        agentNotifyGlobalTaskBlocked();
        updateAgentPrimaryAction();
        return;
    }
    try{
    if(forceAuto) agentSetRunMode('auto', {silent:true});
    const stage = gateMsg.stageGate || {};
    const userMsg = {
        id: stage.userMsgId || uid('um'),
        role: 'user',
        text: stage.userText || '',
        images: Array.isArray(stage.attachments) ? stage.attachments.slice() : [],
        understanding: stage.understanding || gateMsg.understanding || '',
        conversationId: ownerConversationId
    };
    try{
        const msgs = agentEnsureConversationMessages(ownerConversationId) || [];
        const origin = stage.userMsgId ? msgs.find(m => m.id === stage.userMsgId) : null;
        if(origin){
            userMsg.id = origin.id;
            userMsg.text = origin.text || userMsg.text;
            userMsg.images = origin.images || userMsg.images;
            userMsg.parts = origin.parts;
            userMsg.skills = origin.skills;
            userMsg.understanding = origin.understanding || userMsg.understanding;
            userMsg.artifacts = origin.artifacts || userMsg.artifacts || [];
            userMsg.requirementArtifactId = origin.requirementArtifactId || userMsg.requirementArtifactId || '';
            userMsg.contextHistory = Array.isArray(origin.contextHistory) ? origin.contextHistory.slice() : [];
            userMsg.canvasSnapshot = origin.canvasSnapshot || null;
            userMsg.contextSources = origin.contextSources || null;
            userMsg.requestedSettings = origin.requestedSettings ? {...origin.requestedSettings} : null;
            userMsg.memorySnapshot = origin.memorySnapshot ? JSON.parse(JSON.stringify(origin.memorySnapshot)) : null;
        }
    }catch(_){ }
      const assistantMsg = {
        id: uid('am'),
        role: 'assistant',
        text: pending.reply || '开始执行规划步骤',
        // 执行消息绝不回挂阶段1策划正文，避免再冒出第二条“策划”
        understanding: '',
        stage: 'plan',
        options: [],
        prompts: [],
        generations: gens,
          shared_style: pending.shared_style || stage.sharedStyle || '',
          plan: pending.plan || null,
          artifacts: Array.isArray(pending.artifacts) ? pending.artifacts.slice() : [],
          contextSources: userMsg.contextSources || null,
          conversationId: ownerConversationId,
        ts: Date.now()
    };
    gateMsg.options = [];
    gateMsg.stageGate = { ...(gateMsg.stageGate||{}), consumed:true, continuedAt: Date.now() };
    agentPushMessageToConversation(ownerConversationId, assistantMsg);
    if(agentIsActiveConversation(ownerConversationId)){
        renderAgentMessages();
        saveAgentState(true);
    }else{
        saveAgentState(true);
    }
    await runAgentGenerations(assistantMsg, userMsg, {conversationId: ownerConversationId});
    }finally{
        agentReleaseGlobalTask(ownerConversationId);
        if(agentIsActiveConversation(ownerConversationId)) updateAgentPrimaryAction();
    }
}

async function agentRunUnderstandingStage({conversationId='', userMsg=null, text='', attachments=[], bypassThinking=false}={}){
    if(!agentState) return;
    const ownerConversationId = conversationId || userMsg?.conversationId || agentState.activeConversationId || '';
    const imageUrls = (attachments || []).slice(0, AGENT_LLM_IMAGE_MAX).map(i => i?.url).filter(Boolean);
    if(!chatApiProviders().length){
        if(typeof toast === 'function') toast(tr('smart.agentNeedChatModel'));
        return;
    }
    const requestedSettings = userMsg?.requestedSettings || {};
    const provider = resolveChatProviderId(requestedSettings.chatProvider || agentState.chatProvider);
    const model = resolveChatModel(requestedSettings.chatModel || agentState.chatModel, provider);
    const _finalCount = resolveFinalGenCount(text || userMsg?.text || '');
    if(_finalCount.count > 1 && userMsg) userMsg.requestedCount = _finalCount.count;
    let messageText = String(text || userMsg?.text || '').trim();
    if(!messageText) messageText = '请根据本轮 Skill、用户要求和参考图，先直出策划内容。';
    if(agentIsActiveConversation(ownerConversationId)){
        agentSending = true;
        agentThinking = true;
        agentThinkingStage = 'understand';
        agentThinkingConversationId = ownerConversationId;
    }
    agentPatchConversationWorkflow(ownerConversationId, workflow => {
        workflow.status = 'planning';
        workflow.updatedAt = Date.now();
    });
    if(agentIsActiveConversation(ownerConversationId)) renderAgentMessages();
    try{
        const historyMsgs = userMsg?.contextEnabled === false
            ? []
            : (Array.isArray(userMsg?.contextHistory)
                ? userMsg.contextHistory.slice()
                : agentFreshTaskHistoryMessages(ownerConversationId, {
                    beforeMessageId: userMsg?.id || '',
                    max: 12,
                    maxChars: AGENT_HISTORY_CHAR_MAX
                }));
        const canvasSnapshot = userMsg?.canvasSnapshot || null;
        const attachmentCatalog = (attachments || []).filter(item => item?.url).length
            ? ['【本轮参考图顺序（仅作为编号数据）】']
                .concat((attachments || []).filter(item => item?.url).map((item, index) => `参考图${index + 1}：${item.name || item.label || `Image${index + 1}`}`))
                .concat(['编号固定按输入框从左到右排列。'])
                .join(AGENT_NL)
            : '';
        const llmPayload = {
            message: messageText,
            messages: historyMsgs,
            images: imageUrls,
            videos: [],
            model,
            provider,
            ms_model: provider === 'modelscope' ? model : '',
            system_prompt: agentSystemPrompt(bypassThinking, _finalCount.count, 'understand', {
                conversationId: ownerConversationId,
                skills: userMsg?.skills || [],
                freshTask: true,
                attachmentCatalog,
                historyMessages: historyMsgs,
                canvasSnapshot,
                contextEnabled: userMsg?.contextEnabled !== false,
                memorySnapshot: userMsg?.memorySnapshot || null
            })
        };
        const result = await agentCreateAndWaitLlmTask(llmPayload, {
            stream:true,
            conversationId:ownerConversationId,
            requestId:userMsg?._pendingRequestId || ''
        });
        const understandingEnvelope = agentParseUnderstandingResponse(result?.text || '');
        const understandingText = String(understandingEnvelope.text || '').trim();
        const taskSpec = understandingEnvelope.taskSpec;
        if(!understandingText){
            throw new Error('阶段1未返回直出内容');
        }
        const understandingErrors = agentValidateUnderstandingStage(understandingText, {
            userText: String(userMsg?.text || text || '').trim(),
            skills: userMsg?.skills || [],
            taskSpec
        });
        // AGENT_TASK_SPEC 是阶段间的加速结构，不是理解正文的硬门槛。
        // 某些兼容模型会返回完整策划但省略标记；只要正文包含可执行
        // 目标，就让阶段2依据策划继续生成 plan，不能把格式缺失误判成需求无效。
        // 真正缺少任务/成果的正文仍由 agentValidateUnderstandingStage 拦截。
        const taskSpecMissing = !taskSpec;
        const assistantMsg = {
            id: uid('am'),
            role: 'assistant',
            text: understandingText,
            understanding: understandingText,
            stage: 'understand',
            options: [],
            prompts: [],
            generations: [],
            plan: null,
            taskSpec,
            taskSpecMissing,
            shared_style: '',
            contextSources: userMsg?.contextSources || null,
            ts: Date.now(),
            conversationId: ownerConversationId
        };
        if(userMsg){
            try{
                userMsg.understanding = understandingText;
                userMsg.taskSpec = taskSpec;
                userMsg.understandingMessageId = assistantMsg.id;
            }catch(_){ }
        }
        agentPushMessageToConversation(ownerConversationId, assistantMsg);
        if(understandingErrors.length){
            assistantMsg.planningIncomplete = true;
            assistantMsg.planValidationErrors = understandingErrors.slice();
            agentPushMessageToConversation(ownerConversationId, {
                id: uid('am'),
                role: 'assistant',
                text: `策划内容不完整，已停止进入下一阶段：${understandingErrors.join('；')}。不会自动重新调用 LLM，也不会创建或执行生图节点。`,
                generations: [],
                stage: 'understand',
                planningIncomplete: true,
                contextSources: userMsg?.contextSources || null,
                ts: Date.now(),
                conversationId: ownerConversationId
            });
            agentPatchConversationWorkflow(ownerConversationId, workflow => {
                workflow.status = 'incomplete';
                workflow.error = understandingErrors.join('；');
                workflow.updatedAt = Date.now();
            });
            if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
            if(agentIsActiveConversation(ownerConversationId)){
                agentSending = false;
                agentThinking = false;
                agentThinkingStage = '';
                renderAgentMessages();
                updateAgentPrimaryAction();
            }
            saveAgentState(true);
            return;
        }
        const requirementArtifact = {
            id: uid('artifact'),
            type: 'requirements',
            title: '已确认需求策划',
            content: understandingText,
            taskSpec,
            sourceUserMessageId: userMsg?.id || '',
            skillIds: (userMsg?.skills || []).map(skill => String(skill?.id || skill?.name || '')).filter(Boolean),
            attachmentUrls: (attachments || userMsg?.images || []).map(item => item?.url).filter(Boolean),
            version: 1,
            createdAt: Date.now()
        };
        assistantMsg.artifacts = [requirementArtifact];
        if(userMsg) userMsg.requirementArtifactId = requirementArtifact.id;
        agentPatchConversationWorkflow(ownerConversationId, workflow => {
            workflow.artifacts = Array.isArray(workflow.artifacts) ? workflow.artifacts : [];
            workflow.artifacts.push(requirementArtifact);
            workflow.updatedAt = Date.now();
        });
        // 先把直出内容给用户确认，再进入需求理解后的规划与执行
        if(agentGetRunMode() === 'semi'){
            agentPushStageGateMessage({
                conversationId: ownerConversationId,
                understanding: understandingText,
                planText: understandingText,
                generations: [],
                nextStage: 'understand',
                userMsg,
                attachments: attachments || userMsg?.images || [],
                userText: String(userMsg?.text || text || '').trim(),
                sharedStyle: '',
                artifacts: [requirementArtifact],
                taskSpec
            });
            agentPatchConversationWorkflow(ownerConversationId, workflow => {
                workflow.status = 'awaiting_confirm';
                workflow.updatedAt = Date.now();
            });
        }else{
            await agentRunPlanningFromUnderstanding({
                conversationId: ownerConversationId,
                userMsg,
                text: String(userMsg?.text || text || '').trim(),
                attachments: attachments || userMsg?.images || [],
                understandingText,
                taskSpec,
                bypassThinking
            });
        }
    }catch(error){
        const msg = String(error?.message || error || '阶段1直出失败').slice(0, 300);
        agentPushMessageToConversation(ownerConversationId, {
            id: uid('am'),
            role: 'assistant',
            text: `⚠️ ${msg}`,
            generations: [],
            contextSources: userMsg?.contextSources || null,
            ts: Date.now(),
            conversationId: ownerConversationId
        });
        agentPatchConversationWorkflow(ownerConversationId, workflow => {
            workflow.status = 'failed';
            workflow.error = msg;
            workflow.updatedAt = Date.now();
        });
        if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
        if(agentIsActiveConversation(ownerConversationId)){
            agentSending = false;
            agentThinking = false;
            agentThinkingStage = '';
            renderAgentMessages();
            updateAgentPrimaryAction();
        }
        saveAgentState(true);
        // 该错误已经作为本阶段的可见消息写入。继续向外抛出只是为了
        // 让发送流程释放状态，外层不应再追加第二条相同错误。
        try{ error.__canvasAgentReported = true; }catch(_){ }
        throw error;
    }
}
async function agentRunPlanningFromUnderstanding({conversationId='', userMsg=null, text='', attachments=[], understandingText='', taskSpec=null, bypassThinking=false}={}){
    if(!agentState) return;
    const ownerConversationId = conversationId || userMsg?.conversationId || agentState.activeConversationId || '';
    const normalizedTaskSpec = agentNormalizeTaskSpec(taskSpec || userMsg?.taskSpec || null);
    const imageUrls = (attachments || []).slice(0, AGENT_LLM_IMAGE_MAX).map(i => i?.url).filter(Boolean);
    if(!chatApiProviders().length){
        if(typeof toast === 'function') toast(tr('smart.agentNeedChatModel'));
        return;
    }
    const requestedSettings = userMsg?.requestedSettings || {};
    const provider = resolveChatProviderId(requestedSettings.chatProvider || agentState.chatProvider);
    const model = resolveChatModel(requestedSettings.chatModel || agentState.chatModel, provider);
    const _finalCount = resolveFinalGenCount(text || userMsg?.text || '');
    if(_finalCount.count > 1 && userMsg) userMsg.requestedCount = _finalCount.count;
    let messageText = String(text || userMsg?.text || '').trim();
    if(!messageText) messageText = '请根据策划继续。';
    let planMessage = messageText;
    if(understandingText){
        planMessage += `${AGENT_NL}${AGENT_NL}【已确认策划】${AGENT_NL}${understandingText}`;
        if(normalizedTaskSpec){
            planMessage += `${AGENT_NL}${AGENT_NL}【唯一结构化任务单】${AGENT_NL}${JSON.stringify(normalizedTaskSpec)}`;
            planMessage += `${AGENT_NL}${AGENT_NL}请严格按任务单逐项展开 generations：总步骤数必须等于各 deliverable.count 之和；type、ratio、resolution 不得改写。`;
        }
        planMessage += `${AGENT_NL}${AGENT_NL}请基于以上策划与用户原要求，输出 plan + generations JSON。`;
        planMessage += `${AGENT_NL}${AGENT_NL}【阶段2硬性要求】generations 必须按最终张数逐条输出；每条 prompt 必须是完整可直接生图的中文视觉描述（含保持不变元素 + 本张变化 + 构图光线画质），禁止只写服装名/表情名/短标签。换装任务每条都要锁定同一人物身份与姿势，只替换服装。`;
    }
    if(agentLooksLikeIndependentGenerationRequest(messageText) && !agentIsExplicitTaskContinuation(messageText)){
        planMessage += `${AGENT_NL}${AGENT_NL}【本轮独立步骤约束】用户明确要求独立/分别/并行生成：每个独立 generation.prompt 只能描述本步目标和本轮明确提供的参考图；不得提及“之前/前一步/上一步/此前生成/previously generated/上游输出”等内容，也不得把任一步结果当作另一步参考。只有用户明确写出“再用前一步结果/融合/基于生成结果”时，才设置 depends_on_previous、input_artifact_ids 或 dependency_mode。`;
    }
    if(agentIsActiveConversation(ownerConversationId)){
        agentSending = true;
        agentThinking = true;
        agentThinkingStage = 'plan';
        agentThinkingConversationId = ownerConversationId;
    }
    agentPatchConversationWorkflow(ownerConversationId, workflow => {
        workflow.status = 'planning';
        workflow.updatedAt = Date.now();
    });
    if(agentIsActiveConversation(ownerConversationId)) renderAgentMessages();
    try{
        const historyMsgs = userMsg?.contextEnabled === false
            ? []
            : (Array.isArray(userMsg?.contextHistory)
                ? userMsg.contextHistory.slice()
                : agentFreshTaskHistoryMessages(ownerConversationId, {
                    beforeMessageId: userMsg?.id || '',
                    max: 12,
                    maxChars: AGENT_HISTORY_CHAR_MAX
                }));
        const canvasSnapshot = userMsg?.canvasSnapshot || null;
        const attachmentCatalog = (attachments || []).filter(item => item?.url).length
            ? ['【本轮参考图顺序（仅作为编号数据）】']
                .concat((attachments || []).filter(item => item?.url).map((item, index) => `参考图${index + 1}：${item.name || item.label || `Image${index + 1}`}`))
                .concat(['编号固定按输入框从左到右排列；generation.attachment_indices 使用 0-based 索引。'])
                .join(AGENT_NL)
            : '';
        const llmPayload = {
            message: planMessage,
            messages: historyMsgs,
            images: imageUrls,
            videos: [],
            model,
            provider,
            ms_model: provider === 'modelscope' ? model : '',
            system_prompt: agentSystemPrompt(bypassThinking, _finalCount.count, 'plan', {
                conversationId: ownerConversationId,
                skills: userMsg?.skills || [],
                freshTask: true,
                attachmentCatalog,
                taskSpec: normalizedTaskSpec,
                historyMessages: historyMsgs,
                canvasSnapshot,
                contextEnabled: userMsg?.contextEnabled !== false,
                memorySnapshot: userMsg?.memorySnapshot || null
            })
        };
        const result = await agentCreateAndWaitLlmTask(llmPayload, {
            stream:true,
            conversationId:ownerConversationId,
            requestId:userMsg?._pendingRequestId || ''
        });
        await processAgentLlmResult(result, text || userMsg?.text || '', attachments || [], userMsg || {text:text, images:attachments, conversationId:ownerConversationId, understanding:understandingText}, {
            conversationId: ownerConversationId,
            understanding: understandingText,
            taskSpec: normalizedTaskSpec,
            fromStageContinue: true,
            stage: 'plan'
        });
    }catch(e){
        agentPushMessageToConversation(ownerConversationId, {
            id: uid('am'),
            role: 'assistant',
            text: '规划失败：' + String(e?.message || e).slice(0, 300),
            generations: [],
            contextSources: userMsg?.contextSources || null,
            ts: Date.now(),
            conversationId: ownerConversationId
        });
        agentPatchConversationWorkflow(ownerConversationId, workflow => {
            workflow.status = 'failed';
            workflow.error = String(e?.message || e).slice(0, 300);
            workflow.updatedAt = Date.now();
        });
        if(agentIsActiveConversation(ownerConversationId)) renderAgentMessages();
    }finally{
        const ownerWorkflow = agentConversationWorkflow(ownerConversationId);
        const stillBusy = !!(typeof window !== 'undefined' && window.__canvasAgentGenRunning)
            || ['creating_nodes','ready','running','stopping'].includes(String(ownerWorkflow?.status || '').toLowerCase())
            || agentConversationHasRunningGens(ownerConversationId || agentState?.activeConversationId || '');
        if(!stillBusy){
            agentPatchConversationWorkflow(ownerConversationId, workflow => {
                if(String(workflow.status || '').toLowerCase() === 'planning') workflow.status = 'completed';
                workflow.updatedAt = Date.now();
            });
        }
        if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
        if(agentIsActiveConversation(ownerConversationId)){
            agentThinking = false;
            agentThinkingStage = '';
            agentSending = stillBusy;
            renderAgentMessages();
            updateAgentPrimaryAction();
        }
        try{ agentRefreshConversationMemory(ownerConversationId); }catch(_){ }
        saveAgentState(true);
    }
}


function agentValidateDirectPlan(parsed, {userText='', confirmedPlanText='', attachments=[], skills=[], requestedCount=0, taskSpec=null}={}){
    const errors = [];
    const gens = Array.isArray(parsed?.generations) ? parsed.generations : [];
    const expectedSteps = taskSpec && typeof agentExpandTaskSpec === 'function' ? agentExpandTaskSpec(taskSpec) : [];
    if(expectedSteps.length && gens.length !== expectedSteps.length){
        errors.push(`任务单要求 ${expectedSteps.length} 个步骤，LLM 返回 ${gens.length} 个步骤`);
    }
    const attachmentCount = Array.isArray(attachments) ? attachments.filter(item => item?.url).length : 0;
    const normalizedSkills = agentNormalizeSkillList(skills);
    const hasDetailedSkill = normalizedSkills.some(skill => String(skill?.content || '').trim().length >= 500);
    const pageSetRequest = /(主图|详情页|详情图|套图|页面|海报)/.test(String(userText || '')) && Number(requestedCount) > 1;
    const explicitChainRefs = typeof agentExplicitChainAttachmentRequirements === 'function'
        ? agentExplicitChainAttachmentRequirements(userText, attachments)
        : null;
    const explicitGeneratedChain = typeof agentExplicitGeneratedChainRequirements === 'function'
        ? agentExplicitGeneratedChainRequirements(userText, gens)
        : null;
    if(gens.length && /(?:缺少|未提供|没有).{0,12}(?:产品图|三视图|产品依据).{0,30}(?:停止|暂不|不能|待补充)|(?:停止|暂不|不能).{0,20}(?:正式生图|执行)/.test(String(confirmedPlanText || ''))){
        errors.push('阶段1已标记缺少产品依据，补充产品图/三视图或明确改为概念产品设计前不能执行');
    }

    gens.forEach((gen, index) => {
        const prompt = String(gen?.prompt || '').trim();
        if(!prompt) errors.push(`第${index + 1}步缺少最终提示词`);
        if(hasDetailedSkill && prompt && prompt.length < 80) errors.push(`第${index + 1}步提示词过短，未完整落实 Skill`);
        const expectedStep = expectedSteps[index] || null;
        const userRatio = !expectedSteps.length && typeof chatRequestedRatioForGeneration === 'function'
            ? chatRequestedRatioForGeneration(String(userText || ''), gen || {}) : '';
        const confirmedRatio = !expectedSteps.length && typeof chatRequestedRatioForGeneration === 'function'
            ? chatRequestedRatioForGeneration(String(confirmedPlanText || ''), gen || {}) : '';
        const explicitRatio = expectedStep?.ratio || userRatio || confirmedRatio;
        const plannedRatio = typeof agentNormalizeRatioValue === 'function'
            ? agentNormalizeRatioValue(gen?.ratio || '') : String(gen?.ratio || '').trim();
        if(explicitRatio && !plannedRatio){
            // 用户已经明确写出的参数允许执行层做无损结构化补齐；这不是重新创作提示词。
            gen.ratio = explicitRatio;
            gen.parameter_sources = {...(gen.parameter_sources || {}), ratio:expectedStep?.ratio ? 'task_spec' : (userRatio ? 'user' : 'confirmed_plan')};
        }else if(explicitRatio && plannedRatio !== explicitRatio){
            errors.push(`第${index + 1}步比例与用户要求不一致（规划 ${agentRatioLabel(plannedRatio)}，应为 ${agentRatioLabel(explicitRatio)}）`);
        }
        const userResolution = !expectedSteps.length && typeof chatRequestedResolution === 'function'
            ? chatRequestedResolution(String(userText || '')) : '';
        const confirmedResolution = !expectedSteps.length && typeof chatRequestedResolution === 'function'
            ? chatRequestedResolution(String(confirmedPlanText || '')) : '';
        const explicitResolution = expectedStep?.resolution || userResolution || confirmedResolution;
        const plannedResolution = typeof agentNormalizeResolutionValue === 'function'
            ? agentNormalizeResolutionValue(gen?.resolution || '') : String(gen?.resolution || '').trim().toLowerCase();
        if(explicitResolution && !plannedResolution){
            gen.resolution = explicitResolution;
            gen.parameter_sources = {...(gen.parameter_sources || {}), resolution:expectedStep?.resolution ? 'task_spec' : (userResolution ? 'user' : 'confirmed_plan')};
        }else if(explicitResolution && plannedResolution !== explicitResolution){
            errors.push(`第${index + 1}步画质与用户要求不一致（规划 ${plannedResolution.toUpperCase()}，应为 ${explicitResolution.toUpperCase()}）`);
        }
        const modeRaw = String(gen?.dependency_mode || 'none').trim().toLowerCase();
        const mode = ['reference', 'product-reference', 'product_ref', 'previous_reference', 'previous-reference', 'previous_result', 'previous-results'].includes(modeRaw)
            ? 'product_reference' : modeRaw;
        if(gen && mode !== modeRaw) gen.dependency_mode = mode;
        if(!['none', 'product_reference', 'fusion'].includes(mode)) errors.push(`第${index + 1}步依赖类型无效`);
        const indices = Array.isArray(gen?.attachment_indices) ? gen.attachment_indices : [];
        if(indices.some(value => !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) >= attachmentCount)){
            errors.push(`第${index + 1}步参考图索引越界`);
        }
        if(gen?.use_attachments === true && attachmentCount > 0 && !indices.length){
            errors.push(`第${index + 1}步声明使用参考图但没有明确 attachment_indices`);
        }
        if(explicitChainRefs){
            const required = index === 0 ? explicitChainRefs.initial : explicitChainRefs.dependent;
            if(index > 0 && !(gen?.depends_on_previous === true || gen?.use_previous_results === true || mode === 'product_reference' || mode === 'fusion')){
                errors.push(`第${index + 1}步没有绑定前序生成结果`);
            }
            required.forEach(requiredIndex => {
                if(!indices.map(Number).includes(requiredIndex)) errors.push(`第${index + 1}步缺少用户指定的参考图${requiredIndex + 1}`);
            });
        }
    });

    const normalizedPrompts = gens.map(gen => String(gen?.prompt || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if(normalizedPrompts.length > 1 && new Set(normalizedPrompts).size !== normalizedPrompts.length){
        errors.push('多张图片存在完全重复的提示词');
    }
    if(!expectedSteps.length && pageSetRequest && gens.length !== Number(requestedCount)){
        errors.push(`用户要求 ${requestedCount} 张页面图，但 LLM 只规划了 ${gens.length} 个独立步骤`);
    }
    if(attachmentCount > 0 && gens.length && !gens.some(gen => gen?.use_attachments === true && Array.isArray(gen?.attachment_indices) && gen.attachment_indices.length)){
        errors.push('本轮提供了参考图，但规划没有任何步骤绑定参考图');
    }
    // 不再用固定的“产品/版式/风格”关键词猜测 Skill 是否落实。
    // Skill 可以是单图、风格、表情包、分镜或任意自定义任务；阶段1策划与
    // 阶段2最终 prompt 才是语义来源。这里仅检查 prompt 非空、参数、数量、
    // 参考图和依赖等可执行结构，避免把合法的自定义词汇误判为失败。
    const hasGeneratedArtifactBindings = gens.some(gen => String(gen?.output_artifact_id || '').trim()
        || (Array.isArray(gen?.input_artifact_ids) && gen.input_artifact_ids.some(value => String(value || '').trim())));
    if(explicitGeneratedChain && hasGeneratedArtifactBindings && gens.length > 1){
        const initialCount = Math.max(1, Math.min(gens.length - 1, Number(explicitGeneratedChain.initialCount) || 1));
        const outputArtifactIds = gens.slice(0, initialCount)
            .map(gen => String(gen?.output_artifact_id || '').trim())
            .filter(Boolean);
        if(outputArtifactIds.length !== initialCount){
            errors.push('并行前置任务缺少 output_artifact_id，无法在全部成功后作为融合输入');
        }
        gens.slice(initialCount).forEach((gen, offset) => {
            const inputs = Array.isArray(gen?.input_artifact_ids) ? gen.input_artifact_ids.map(v => String(v || '').trim()) : [];
            const missing = outputArtifactIds.filter(id => !inputs.includes(id));
            if(missing.length) errors.push(`第${initialCount + offset + 1}步缺少前置产物 ${missing.join('、')} 的 input_artifact_ids 绑定`);
        });
    }else if(explicitChainRefs && gens.length > 1){
        const firstOutput = String(gens[0]?.output_artifact_id || '').trim();
        if(!firstOutput) errors.push('串行任务第一步缺少 output_artifact_id，无法作为后续步骤的唯一前置产物');
        gens.slice(1).forEach((gen, offset) => {
            const inputs = Array.isArray(gen?.input_artifact_ids) ? gen.input_artifact_ids.map(v => String(v || '').trim()) : [];
            if(firstOutput && !inputs.includes(firstOutput)) errors.push(`第${offset + 2}步缺少前置产物 ${firstOutput} 的 input_artifact_ids 绑定`);
        });
    }
    return errors;
}

function agentExplicitChainAttachmentRequirements(userText='', attachmentSource=0){
    const source = String(userText || '');
    const attachmentList = Array.isArray(attachmentSource) ? attachmentSource.filter(item => item?.url) : [];
    const count = attachmentList.length || Math.max(0, Number(attachmentSource) || 0);
    if(!source || count <= 0) return null;
    const chainMatch = source.match(/(?:然后|再|之后|接着).{0,60}?(?:用|结合|基于|参考).{0,40}?(?:生成的|前一步|上一步|中间图|三视图|定稿)/);
    if(!chainMatch || typeof chainMatch.index !== 'number') return null;
    const collect = (segment) => {
        const out = [];
        const re = /【参考图\s*(\d+)】/g;
        let match;
        while((match = re.exec(segment))){
            const index = Number(match[1]) - 1;
            if(index >= 0 && index < count && !out.includes(index)) out.push(index);
        }
        return out;
    };
    const canonicalize = (indices) => {
        if(!attachmentList.length) return indices;
        const out = [];
        const seen = new Set();
        indices.forEach(index => {
            const url = String(attachmentList[index]?.url || '').trim();
            const canonicalIndex = url ? attachmentList.findIndex(item => String(item?.url || '').trim() === url) : index;
            const finalIndex = canonicalIndex >= 0 ? canonicalIndex : index;
            const key = url || `index:${finalIndex}`;
            if(!seen.has(key)){
                seen.add(key);
                out.push(finalIndex);
            }
        });
        return out;
    };
    const splitAt = chainMatch.index;
    const initial = canonicalize(collect(source.slice(0, splitAt)));
    const chainTail = source.slice(splitAt);
    let dependent = canonicalize(collect(chainTail));
    if(!dependent.length && initial.length && /(?:这|上述|前面|最初|一开始|原来|原始|同样|相同)(?:的)?(?:两张|这些|那两张)?(?:参考)?图|Logo|logo|色卡|颜色图/.test(chainTail)){
        dependent = initial.slice();
    }
    return {initial, dependent};
}

function agentExplicitGeneratedAnchorRequirements(userText='', generations=[], confirmedPlanText=''){
    const source = String(userText || '').trim();
    const planText = String(confirmedPlanText || '').trim();
    const gens = Array.isArray(generations) ? generations : [];
    if(!source || gens.length < 2) return null;
    // “每一步以上一步为基础”属于真正的多级串行链，不能压成所有页面都只连第1步。
    if(/(?:每一步|逐步|逐张|依次).{0,16}(?:以上一步|以前一步|基于前一步|参考前一步)|(?:上一张|上一步).{0,16}(?:作为|用作).{0,12}(?:下一张|下一步)/.test(source)){
        return null;
    }
    const directAnchor = /(?:再|然后|之后|接着).{0,80}?(?:基于|沿用|使用|只用|以|参考|按照).{0,40}?(?:同一|这(?:一|个|位|张)?|该|上述|前述|第一(?:步|张)|第\s*1\s*(?:步|张)|人物定稿|角色定稿|产品定稿|包装定稿|三视图|白底图|标准图|身份锚点|生成结果)/.test(source);
    const planAnchor = /(?:后续|其余|第\s*[2-9]\s*步|step\s*[2-9]).{0,80}?(?:唯一.{0,16}锚点|只.{0,16}(?:第\s*1\s*步|step\s*1|第一步)|(?:都|全部).{0,16}依赖.{0,16}(?:第\s*1\s*步|step\s*1|第一步))|(?:第\s*1\s*步|step\s*1|第一步).{0,60}(?:作为|是).{0,20}(?:后续|其余|全部).{0,20}(?:唯一)?(?:参考|锚点|依据)/i.test(planText);
    if(!directAnchor && !planAnchor) return null;
    const firstId = String(gens[0]?.id || 'step_1').trim() || 'step_1';
    return {anchorIndex:0, dependentStart:1, dependencyMode:'product_reference', dependsOnSteps:[firstId]};
}

function agentExplicitGeneratedChainRequirements(userText='', generations=[]){
    const source = String(userText || '').trim();
    const gens = Array.isArray(generations) ? generations : [];
    if(!source || gens.length < 2) return null;
    const chainMatch = source.match(/(?:然后|再|之后|接着)/);
    if(!chainMatch || typeof chainMatch.index !== 'number') return null;
    const initialText = source.slice(0, chainMatch.index);
    const dependentText = source.slice(chainMatch.index);
    // “先生成 A，再生成 B，前两张都成功后……”是并行前置资产，
    // 不能被“再”这个连接词误判成 A → B 的串行链。并行门禁是
    // 用户明确写出的事实：只有门禁前的所有步骤成功，后续融合才可执行。
    const parallelGate = source.match(/(?:前\s*(?:两|二|[2-9]|\d+)\s*张|(?:前面|所有|全部)\s*(?:步骤|任务|图片|结果)?).{0,12}?(?:都\s*)?(?:成功|完成|生成(?:完毕|好)?).{0,12}?(?:后|再|然后)/);
    const hasExplicitOrder = /先\s*(?:(?:给我|为我)\s*)?(?:(?:分别|各自)\s*)?(?:制作|生成|设计|做|画|出)?/.test(initialText);
    const hasFoundationAssets = /(?:品牌说明页?|基础(?:设计)?图|Logo|logo|标志|三视图|包装(?:设计|图)?|产品定稿|白底图|标准图)/.test(initialText);
    const hasDownstreamPages = /(?:主图|详情(?:页|图)?|套图|页面|海报)/.test(dependentText);
    // 不把“先做产品定稿，再做页面”写死成唯一串行形式：人物、角色、
    // 场景、道具等任意前序资产，只要后半句明确要拿它们继续组合/融合，
    // 都是同一计划中的前序产物。
    // 前序资产不一定是“生成”出来的：用户也常说“先把参考图改成 X，
    // 再只用第一张结果做 Y”。改图同样会产出可供后续步骤引用的新资产。
    const hasGeneratedAssets = /(?:制作|生成|设计|做|画|出|改成|变成|替换|重绘|修改)/.test(initialText);
    const hasGenericDependentUse = /(?:融合|合成|结合|使用|只用|基于|参考|让(?:这|两|它|其|前)|将(?:这|两|它|其|前)|把(?:这|两|它|其|前))/.test(dependentText);
    // 组合动作必须是正向表达；例如“不要融合”只是在约束执行，
    // 不能把单锚点人物/产品链误判成 fusion。
    // Keep the generated-chain detector self-contained for isolated consumers
    // (some hosts load this function without the later fusion helpers).  A
    // negated phrase such as “不要融合” must never turn a plain sequence into
    // a fusion dependency.
    const hasPositiveFusion = text => {
        const t = String(text || '');
        const isNegated = index => {
            const before = t.slice(Math.max(0, Number(index) - 24), Number(index));
            return /(?:不|未|无|不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|勿|取消|去掉|不再|不是|并非|而非|不做|不进行)\s*(?:再|将|把|让|进行|做|使用|去)?\s*$/.test(before);
        };
        const termRe = /组合|结合|合成|融合|拼在一起|合并|合在一起|放在一起|拼合|合成为|合成一张|合成一图|同框|追逐|打架|互动|对峙|拥抱|共同出现在|一张完整画面/g;
        let match;
        while((match = termRe.exec(t))){
            if(!isNegated(match.index)) return true;
        }
        const pairRe = /(?:把|将)这(?:两|二|三|四|五|六|七|八|九|十|\d+)张[^。；;\n]{0,24}(?:放在一起|拼在一起|组合|结合|合成|融合|合并|同框|一张完整画面)/g;
        while((match = pairRe.exec(t))){
            if(!isNegated(match.index)) return true;
        }
        return false;
    };
    const explicitFusionAction = hasPositiveFusion(dependentText);
    const multiFoundation = /(?:两|二|三|四|五|六|七|八|九|十|[2-9]|\d+)\s*张/.test(initialText)
        || /分别.{0,80}(?:、|，|和|与|及)/.test(initialText)
        || /(?:Logo|logo|三视图|包装|白底图|人物|角色|猫|狗).{0,40}(?:、|，|和|与|及).{0,40}(?:Logo|logo|三视图|包装|白底图|人物|角色|猫|狗)/.test(initialText);
    // 多前置素材 + 最终组合属于 fusion；单一人物/产品定稿派生多页属于
    // product_reference，由 agentExplicitGeneratedAnchorRequirements 处理。
    const isProductPageChain = hasFoundationAssets && hasDownstreamPages && (explicitFusionAction || multiFoundation);
    const isGenericAssetChain = hasGeneratedAssets && hasGenericDependentUse && (explicitFusionAction || multiFoundation);
    const isParallelAssetChain = !!parallelGate && hasGeneratedAssets && hasGenericDependentUse;
    if(!hasExplicitOrder || (!isProductPageChain && !isGenericAssetChain && !isParallelAssetChain)) return null;

    const countMatch = initialText.match(/([1-9]\d?|[一二两三四五六七八九十]+)\s*张/)
        || (parallelGate && parallelGate[0].match(/(?:前\s*)([二两三四五六七八九]|[2-9]|\d+)\s*张/));
    const rawCount = countMatch?.[1] || '';
    const parsedCount = /^\d+$/.test(rawCount) ? Number(rawCount) : agentCnNumToInt(rawCount);
    const inferredInitialCount = (isGenericAssetChain || isParallelAssetChain) ? gens.length - 1 : 0;
    const initialCount = Math.max(0, Math.min(gens.length - 1, Number(parsedCount) || inferredInitialCount));
    if(initialCount < 1) return null;
    return {initialCount, dependentStart:initialCount, dependencyMode:'fusion'};
}

function agentApplyExplicitGeneratedAnchorRequirements(parsed, userText='', attachments=[], confirmedPlanText=''){
    const gens = Array.isArray(parsed?.generations) ? parsed.generations : [];
    const requirements = agentExplicitGeneratedAnchorRequirements(userText, gens, confirmedPlanText);
    if(!requirements || agentExplicitGeneratedChainRequirements(userText, gens)) return {applied:false, requirements};
    const attachmentCount = Array.isArray(attachments) ? attachments.filter(item => item?.url).length : 0;
    const anchor = gens[requirements.anchorIndex];
    if(!anchor) return {applied:false, requirements};
    const anchorId = String(anchor.id || `step_${requirements.anchorIndex + 1}`).trim() || 'step_1';
    const artifactId = String(anchor.output_artifact_id || '').trim() || `artifact_${anchorId.replace(/[^a-zA-Z0-9_.-]+/g, '_')}_output`;
    anchor.output_artifact_id = artifactId;
    anchor.depends_on_previous = false;
    anchor.use_previous_results = false;
    anchor.dependency_mode = 'none';
    anchor.depends_on_steps = [];
    gens.slice(requirements.dependentStart).forEach(gen => {
        if(!gen || typeof gen !== 'object') return;
        gen.depends_on_previous = true;
        gen.use_previous_results = true;
        gen.use_last_outputs = false;
        gen.dependency_mode = 'product_reference';
        gen.depends_on_steps = [anchorId];
        gen.input_artifact_ids = [artifactId];
        // 单锚点串行链的后续步骤只允许引用锚点产物；即使首步有用户
        // 原图，也不能把原图再次偷偷挂到后续节点，否则会变成“原图+
        // 第一张结果”的混合引用。用户附件只绑定到首步。
        gen.attachment_indices = [];
        gen.use_attachments = false;
    });
    parsed.explicit_generated_anchor_requirements = requirements;
    return {applied:true, requirements, anchorId, artifactId};
}

function agentApplyExplicitChainAttachmentRequirements(parsed, userText='', attachments=[]){
    const gens = Array.isArray(parsed?.generations) ? parsed.generations : [];
    const requirements = agentExplicitChainAttachmentRequirements(userText, attachments);
    if(!requirements || gens.length < 2) return {applied:false, requirements};
    gens.forEach((gen, index) => {
        if(!gen || typeof gen !== 'object') return;
        const indices = (index === 0 ? requirements.initial : requirements.dependent).slice();
        gen.attachment_indices = indices;
        gen.use_attachments = indices.length > 0;
        gen.use_last_outputs = false;
        if(index === 0){
            gen.depends_on_previous = false;
            gen.use_previous_results = false;
            gen.dependency_mode = 'none';
        }else{
            gen.depends_on_previous = true;
            gen.use_previous_results = true;
            gen.dependency_mode = 'product_reference';
        }
    });
    parsed.explicit_chain_requirements = requirements;
    return {applied:true, requirements};
}

// A user can clearly request a serial chain while an otherwise valid LLM plan
// omits the artifact bookkeeping fields. Those fields do not add any visual
// meaning or rewrite a prompt: they are only the stable link between the
// already-planned first output and its downstream step.
function agentEnsureExplicitChainArtifactBindings(parsed, userText='', attachments=[]){
    const gens = Array.isArray(parsed?.generations) ? parsed.generations : [];
    const requirements = agentExplicitChainAttachmentRequirements(userText, attachments);
    const generatedRequirements = agentExplicitGeneratedChainRequirements(userText, gens);
    const serialByPlan = gens.slice(1).some(gen => gen && (
        gen.depends_on_previous === true
        || gen.use_previous_results === true
        || ['product_reference', 'fusion'].includes(String(gen.dependency_mode || '').trim().toLowerCase())
        || (Array.isArray(gen.depends_on_steps) && gen.depends_on_steps.length > 0)
    ));
    // Trust the LLM's explicit dependency fields as well as the user's serial
    // wording. The latter has many natural Chinese forms ("第一张成功后",
    // "再只用第一张", etc.) and must not be the only gate for bookkeeping.
    if((!requirements && !serialByPlan && !generatedRequirements) || gens.length < 2) return {applied:false, requirements, outputArtifactId:''};
    const initialCount = Math.max(1, Math.min(gens.length - 1, Number(generatedRequirements?.initialCount) || 1));
    const outputArtifactIds = [];
    gens.slice(0, initialCount).forEach((gen, index) => {
        if(!gen || typeof gen !== 'object') return;
        const stepKey = String(gen.id || `step_${index + 1}`).trim().replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || `step_${index + 1}`;
        const artifactId = String(gen.output_artifact_id || '').trim() || `artifact_${stepKey}_output`;
        gen.output_artifact_id = artifactId;
        outputArtifactIds.push(artifactId);
    });
    // 并行前置步骤彼此独立；只有门禁后的步骤才挂载全部前置产物。
    // 普通串行链 initialCount=1，因此行为与原逻辑一致。
    gens.slice(initialCount).forEach(gen => {
        if(!gen || typeof gen !== 'object') return;
        const inputs = Array.isArray(gen.input_artifact_ids)
            ? gen.input_artifact_ids.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        outputArtifactIds.forEach(artifactId => { if(!inputs.includes(artifactId)) inputs.push(artifactId); });
        gen.input_artifact_ids = inputs;
    });
    parsed.explicit_chain_artifact_bindings = {output_artifact_id:outputArtifactIds[0] || '', output_artifact_ids:outputArtifactIds, requirements, generatedRequirements};
    return {applied:true, requirements, outputArtifactId:outputArtifactIds[0] || '', outputArtifactIds};
}

function agentApplyExplicitGeneratedChainRequirements(parsed, userText='', attachments=[]){
    const gens = Array.isArray(parsed?.generations) ? parsed.generations : [];
    const attachmentCount = Array.isArray(attachments) ? attachments.filter(item => item?.url).length : 0;
    const requirements = agentExplicitGeneratedChainRequirements(userText, gens);
    // “第一步成功后，再只以第一步结果作为参考”是单锚点串行链，
    // 不是多素材融合。这个入口也可能被旧调用方直接调用，因此在这里
    // 复用单锚点处理，确保与主流程的识别结果一致。
    if(!requirements){
        const anchorRequirements = agentExplicitGeneratedAnchorRequirements(userText, gens);
        if(anchorRequirements){
            const appliedAnchor = agentApplyExplicitGeneratedAnchorRequirements(parsed, userText, attachments);
            return {
                applied: !!appliedAnchor?.applied,
                requirements: appliedAnchor?.requirements || anchorRequirements,
                anchorId: appliedAnchor?.anchorId || '',
                artifactId: appliedAnchor?.artifactId || ''
            };
        }
        return {applied:false, requirements};
    }
    const foundationIds = gens.slice(0, requirements.initialCount)
        .map((gen, index) => String(gen?.id || `step_${index + 1}`).trim())
        .filter(Boolean);
    gens.forEach((gen, index) => {
        if(!gen || typeof gen !== 'object') return;
        gen.use_last_outputs = false;
        if(index < requirements.initialCount){
            // 首阶段仍可引用用户本轮明确提供的原图；仅在没有附件时清除
            // LLM 把“步骤序号”误填到 attachment_indices 的情况。
            if(attachmentCount <= 0){
                gen.attachment_indices = [];
                gen.use_attachments = false;
            }
            gen.depends_on_previous = false;
            gen.use_previous_results = false;
            gen.dependency_mode = 'none';
            gen.depends_on_steps = [];
        }else{
            // 后续“只用第一张结果”的引用属于前序产物，而不是用户附件。
            // 必须清掉 attachment_indices，否则执行层会把原图重新连进来。
            gen.attachment_indices = [];
            gen.use_attachments = false;
            gen.depends_on_previous = true;
            gen.use_previous_results = true;
            // fusion 在执行器中的含义是挂载第一批所有成功图，正好对应 Logo + 三视图 + 包装。
            gen.dependency_mode = requirements.dependencyMode;
            gen.depends_on_steps = foundationIds.slice();
        }
    });
    parsed.explicit_generated_chain_requirements = requirements;
    return {applied:true, requirements};
}

// attachment_indices 只允许指向用户在本轮明确提供的附件，绝不能借它
// 表示“第1/第2个计划步骤”。前序生成结果由 depends_on_steps / dependency_mode
// 传递。否则融合任务会在结构检查阶段把步骤序号误判成越界参考图。
function agentClearAttachmentIndicesWithoutUserAttachments(parsed, attachments=[]){
    const attachmentCount = Array.isArray(attachments) ? attachments.filter(item => item?.url).length : 0;
    if(attachmentCount > 0 || !Array.isArray(parsed?.generations)) return false;
    let changed = false;
    parsed.generations.forEach(gen => {
        if(!gen || typeof gen !== 'object') return;
        if((Array.isArray(gen.attachment_indices) && gen.attachment_indices.length) || gen.use_attachments === true){
            gen.attachment_indices = [];
            gen.use_attachments = false;
            changed = true;
        }
    });
    return changed;
}

// 产物 ID 只用于执行层的结构绑定，不能泄漏到用户可见或 API 使用的提示词。
// LLM 偶尔会把 artifact_1 / artifact_step_1_output 直接写进 prompt；这里
// 按本步 input_artifact_ids 的顺序翻译成自然的参考图序号，保留视觉描述，
// 不改变任何依赖关系。
function agentSanitizeInternalArtifactTokens(gen){
    if(!gen || typeof gen !== 'object') return gen;
    const ids = Array.isArray(gen.input_artifact_ids)
        ? gen.input_artifact_ids.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];
    const cn = ['一','二','三','四','五','六','七','八','九','十'];
    const mode = String(gen.dependency_mode || '').trim().toLowerCase();
    const dependent = !!gen.depends_on_previous || !!gen.use_previous_results
        || mode === 'product_reference' || mode === 'fusion';
    const source = String(gen.prompt || '').trim();
    if(!source) return gen;
    const clean = source.replace(/\bartifact_[A-Za-z0-9_.-]+\b/gi, token => {
        const key = String(token || '').toLowerCase();
        const localIndex = ids.indexOf(key);
        if(localIndex >= 0) return `参考图${cn[localIndex] || (localIndex + 1)}`;
        const numeric = key.match(/^artifact_(\d+)(?:$|[_-])/);
        const n = numeric ? Number(numeric[1]) : 0;
        if(n >= 1 && n <= cn.length) return `参考图${cn[n - 1]}`;
        return dependent ? '前序参考图' : '参考图';
    }).replace(/\s{2,}/g, ' ').replace(/参考\s+参考图/g, '参考图').trim();
    gen.prompt = clean;
    gen.plannedPrompt = clean;
    gen.professionalPrompt = clean;
    return gen;
}

// LLM 偶尔把执行参考图写成“参考图1”或 0-based 的“附件0”。连线和
// attachment_indices 才是真正的引用事实，因此在节点创建前只做编号格式
// 归一：步骤卡、复制文本、节点和 API 始终使用同一条纯净提示词。
// 这里不增删视觉描述、不补默认风格，也不改动任何依赖关系。
function agentCanonicalizePlannedReferenceLabels(gens, attachments=[]){
    if(!Array.isArray(gens)) return gens;
    // 保持该编号归一化 helper 可独立复用（例如导入旧画布的轻量测试环境）。
    if(typeof agentSanitizeInternalArtifactTokens === 'function') gens.forEach(agentSanitizeInternalArtifactTokens);
    const refs = (Array.isArray(attachments) ? attachments : []).filter(item => item?.url);
    if(!refs.length) return gens;
    const cn = {1:'一',2:'二',3:'三',4:'四',5:'五',6:'六',7:'七',8:'八',9:'九',10:'十'};
    const cnToNum = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
    const toNumber = value => /^\d+$/.test(String(value || '')) ? Number(value) : (cnToNum[String(value || '')] || 0);
    gens.forEach(gen => {
        if(!gen || !String(gen.prompt || '').trim()) return;
        const indices = Array.isArray(gen.attachment_indices)
            ? gen.attachment_indices.map(Number).filter(index => Number.isInteger(index) && index >= 0 && index < refs.length)
            : [];
        if(!indices.length) return;
        const globalToLocal = new Map(indices.map((globalIndex, localIndex) => [globalIndex + 1, localIndex + 1]));
        const label = localIndex => `图${cn[localIndex] || String(localIndex)}`;
        let prompt = String(gen.prompt).trim();
        // “附件0”是 LLM 采用了 attachment_indices 的 0-based 表达。
        prompt = prompt.replace(/(?:附件|attachment)\s*(\d+)/gi, (all, raw) => {
            const globalIndex = Number(raw);
            const localIndex = indices.indexOf(globalIndex) + 1;
            return localIndex > 0 ? label(localIndex) : all;
        });
        // “参考图1”是用户输入框全局序号，转成当前节点连线顺序的图一/图二。
        prompt = prompt.replace(/参考图\s*([0-9一二三四五六七八九十]+)/g, (all, raw) => {
            const localIndex = globalToLocal.get(toNumber(raw));
            return localIndex ? label(localIndex) : all;
        });
        gen.prompt = prompt;
        gen.plannedPrompt = prompt;
        gen.professionalPrompt = prompt;
    });
    return gens;
}

async function processAgentLlmResult(result, text, attachments, userMsg, options={}){
const ownerConversationId = options.conversationId
    || userMsg?.conversationId
    || agentState?.activeConversationId
    || '';
const ownerMessages = () => agentEnsureConversationMessages(ownerConversationId) || agentState.messages || [];
const parsed = parseAgentResponse(result.text || '', text);
// 防御性检查：确保 options/prompts/generations 始终是数组
if(!Array.isArray(parsed.options)) parsed.options = [];
if(!Array.isArray(parsed.prompts)) parsed.prompts = [];
if(!Array.isArray(parsed.generations)) parsed.generations = [];
// 单次直出模式只做结构检查，不再拆步、制造变体、补风格或改写 LLM 提示词。
// 提前计算思维模式状态，使兜底逻辑能感知
    const bypassThinking = userMsg?.bypassThinking === true;
    const thinkingModeOn = false; // 思维模式 UI/功能已移除
    // 生图意图兜底 + 修改意图检测
    {
        const lastUser = [...(ownerMessages())].reverse().find(m => m.role === 'user');
        if(lastUser && lastUser.text && parsed.reply){
            const userText = String(lastUser.text || '').trim();
            const replyText = String(parsed.reply || '');
            const genPrompt = extractGenPrompt(replyText);
            // 修改/转换意图检测
            const userModifyRe = /改成|转换成|换成|修改为|变成|转为|改为|转成|调整为|修改成|变回|调成|重新画|重画|重新生成|修改一下|改一下|调整一下/i;
            const replyModifyRe = /为您(?:将|把).{0,30}?(?:转换|改成|换成|修改|变成|调整|转为|调成|重新画|重画)|(?:将|把).{0,20}?(?:转换|改成|换成|修改|变成).{0,10}?(?:风格|效果|版本|色调)/i;
            const hasUserModifyIntent = userModifyRe.test(userText);
            const hasReplyModify = replyModifyRe.test(replyText);
            let isModifyScenario = hasUserModifyIntent || hasReplyModify;
            // 修复链路断裂：如果上一条 assistant 有 prompts（确认模式），且当前用户消息是确认/生成意图
            // 则继承上上条用户消息的修改意图
            if(!isModifyScenario){
                const msgs = ownerMessages();
                // 找到最后一条 assistant 消息
                for(let i = msgs.length - 1; i >= 0; i--){
                    if(msgs[i].role === 'assistant'){
                        const prevAssistant = msgs[i];
                        // 如果上一条 assistant 有 prompts，说明是确认模式
                        if(Array.isArray(prevAssistant.prompts) && prevAssistant.prompts.length > 0){
                            // 当前用户消息是确认/生成意图
                            const confirmRe = /^\s*(确认|生成|好的|好|可以|没问题|就这样|执行|继续|1|yes|ok)\s*$/i;
                            if(confirmRe.test(userText)){
                                // 找到上上条用户消息（即提出修改需求的那条）
                                for(let j = i - 1; j >= 0; j--){
                                    if(msgs[j].role === 'user'){
                                        const prevUserText = String(msgs[j].text || '').trim();
                                        if(userModifyRe.test(prevUserText)){
                                            isModifyScenario = true;
                                            // 如果当前消息没有明确 prompt，使用上上条的修改需求作为 prompt
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        break;
                    }
                }
            }
            if(parsed.generations.length === 0 && parsed.prompts.length === 0){
                // 场景A：LLM 没返回 generations 也没返回 prompts，需要兜底构造
                // 思维模式下不创建兜底 generation（让后续 thinkingModeOn 块创建 prompt 待确认）
                const genInProgressRe = /正在生成|正在为你生成|正在为您生成|生成中|开始生成|马上生成|这就为你生成|这就为您生成|好的[,，]?\s*我来生成|好的[,，]?\s*马上|我将为你生成|我将为您生成|我来为你生成|我来为您生成|正在为你创建|正在为您创建|正在画|正在创建/i;
                const userGenIntentRe = /我要生成|帮我生成|帮我画|画一|生成一|创建一|制作一|来一张|来幅|来张|给我画|给我生成|帮我创建|帮我做/i;
                const meaninglessConfirmRe = /确认要生成|确认生成|确认要画|要为您生成.*吗|要生成.*吗|确认.*吗.*[？?]/i;
                const noOptions = !parsed.options || parsed.options.length === 0;
                const hasGenInProgress = !thinkingModeOn && genInProgressRe.test(replyText);
                const hasUserGenIntent = noOptions && userGenIntentRe.test(userText);
                const hasMeaninglessConfirm = noOptions && meaninglessConfirmRe.test(replyText);
                const hasAnyIntent = hasGenInProgress || hasUserGenIntent || isModifyScenario || hasMeaninglessConfirm;
                // 修改场景：必须使用本轮参考图（use_attachments），不再默认引用上一轮结果
                // 区别在于 prompt 写法：风格修改→描述风格变化；主体更换→明确指示替换主体+保留场景
                const fallbackUseLastOutputs = isModifyScenario && agentLooksLikeEditLastResult(userText) && !(lastUser.images && lastUser.images.length);
                if(false && hasAnyIntent){ // 厚兜底关闭：不本地编 generations
                        const finalPrompt = genPrompt || userText;
                        parsed.generations = [{
                            prompt: finalPrompt,
                            count: 1,
                            use_last_outputs: fallbackUseLastOutputs,
                            use_attachments: !!(lastUser.images && lastUser.images.length),
                            results: [],
                            status: 'running'
                        }];
                        // 不覆盖 parsed.reply，保留 LLM 原始回复
                        // generation card 会独立显示状态和 prompt
                    }
            } else if(isModifyScenario && parsed.generations.length > 0){
                // 场景B：LLM 返回了 generations。
                // 只有“明确改上一张/原图”时，才把缺省 use_last_outputs 兜底为 true。
                // 纯文生图（即使 reply 说了修改语气）禁止偷偷挂历史结果。
                const editLast = agentLooksLikeEditLastResult(userText);
                const hasAttachNow = !!(lastUser.images && lastUser.images.length);
                parsed.generations.forEach(g => {
                    if(g.use_last_outputs === undefined || g.use_last_outputs === null){
                        g.use_last_outputs = !!(editLast && !hasAttachNow);
                    }
                    // 无附件且非改上一张：强制关掉历史参考
                    if(!hasAttachNow && !editLast && !g.depends_on_previous && !g.use_previous_results){
                        g.use_last_outputs = false;
                    }
                });
            }
        }
    }
    // 如果用户点击了"重新生成提示词"，强制将 generations 设为空数组
    const lastUserMsg = [...ownerMessages()].reverse().find(m => m.role === 'user');
    if(lastUserMsg && String(lastUserMsg.text || '').includes('重新生成提示词')){
        parsed.generations = [];
    }
    // 批量完整性检查（P2-12：弱化为显示提示，不再强制追加 reply）
    // 前端数量决策：输入框显式要求 > 工具栏设置（与 sendAgentMessage 一致）
    // 优先用 sendAgentMessage 已存入 userMsg 的值，避免重复计算导致不一致
    let requestedCount = userMsg?.requestedCount || 0;
    if(requestedCount <= 1) requestedCount = resolveFinalGenCount(text).count;
    // 如果最终数量 <= 1，相当于没有明确请求多张，设为 0 不触发数量逻辑
    if(requestedCount <= 1) requestedCount = 0;
    // 旧协议 prompts 是已完成的规划结果，不应该在全自动模式被误当成
    // “等待用户确认”。只在阶段2的全自动执行中无损转换；半自动、选项、
    // 阶段1和已经有新协议 generations 的场景全部保持原行为。
    const shouldBridgeLegacyPrompts = agentShouldBridgeLegacyPrompts({
        thinkingModeOn,
        stage: options.stage,
        runMode: agentGetRunMode(),
        options: parsed.options,
        generations: parsed.generations,
        prompts: parsed.prompts
    });
    if(shouldBridgeLegacyPrompts){
        parsed.generations = agentPromptsToGenerations(parsed.prompts);
        parsed.prompts = [];
    }
    if(thinkingModeOn){
        const userModifyRe = /改成|换成|转换成|修改为|变成|转为|改为|转成|调整为|修改成|变回|调成|重新画|重画|重新生成|修改一下|改一下|调整一下/i;
        const isModifyRequest = userModifyRe.test(text);
        // ★ 渐进式强制保障：思维模式下，如果 LLM 返回了 options（还在维度采集阶段），
        //   则无论它是否同时返回了 prompts 或 generations，都强制清空。
        //   这确保 LLM 无法跳过渐进式流程——prompts 只能在 options 为空时出现。
        if(parsed.options.length > 0){
            parsed.prompts = [];
            parsed.generations = [];
        }
        // 思维模式下，无论是否修改请求，都走 prompts 确认流程
        // 1. generations → prompts 转换（始终转换，不受 options 影响）
        //    之前的 bug：条件含 parsed.options.length === 0，导致 LLM 同时返回 options+generations 时
        //    generations 跳过转换直接执行，绕过了确认流程
        if(parsed.generations.length > 0){
            // 将 generations 转为 prompts 对象数组（透传 count/use_last_outputs/use_attachments）
            // 兜底：如果某个 generation 的 count>1，拆成多条 prompts（每条 count=1），确保用户逐个确认
            // 保留 LLM 已返回的 prompts，只在前面追加转换结果
            const convertedPrompts = [];
            parsed.generations.forEach(g => {
                const promptText = String(g.prompt || '').trim();
                if(!promptText) return;
                const c = Math.max(1, Math.min(8, Number(g.count) || 1));
                for(let i = 0; i < c; i++){
                    const p = {
                        prompt:promptText,
                        count:1,
                        use_last_outputs:!!g.use_last_outputs,
                        use_attachments:!!g.use_attachments,
                        status:'pending'
                    };
                    if(Array.isArray(g.attachment_indices)) p.attachment_indices = g.attachment_indices;
                    convertedPrompts.push(p);
                }
            });
            // 如果 LLM 同时返回了 prompts，合并（generations 转换的在前）
            parsed.prompts = convertedPrompts.concat(parsed.prompts);
            parsed.generations = [];
        }
        // 1.5 前端兜底：思维模式下，如果输入模糊（缺风格）但 LLM 返回了 prompts（没走阶段一），强制走 options
        // 这样即使 LLM 没按系统提示词执行阶段一，前端也能保证"先选风格再扩写"的流程
        if(!isModifyRequest && parsed.prompts.length > 0 && parsed.options.length === 0 && isVagueImageRequest(text)){
            parsed.prompts = [];
            parsed.options = [
                {label:'水墨风', value:'水墨风'},
                {label:'油画风', value:'油画风'},
                {label:'赛博朋克', value:'赛博朋克'},
                {label:'Q版卡通', value:'Q版卡通'}
            ];
            parsed.reply = '你的输入比较简略，请先选择一个风格方向，我再为你扩写完整提示词：';
        }
        // 2. 如果 prompts 仍为空，创建默认 prompt
        if(parsed.prompts.length === 0 && parsed.options.length === 0 && parsed.generations.length === 0){
            // 检查 reply 是否包含 JSON 标记（说明解析失败了，但 LLM 确实返回了结构化数据）
            const replyLooksLikeJson = parsed.reply && (parsed.reply.includes('"reply"') || parsed.reply.includes('"options"') || parsed.reply.trim().startsWith('{'));
            if(replyLooksLikeJson){
                // 解析失败但 LLM 返回了 JSON：尝试从 reply 文本中提取有用信息
                console.warn('[thinkingMode] LLM 返回了 JSON 但 JSON.parse 和正则提取均失败，尝试最后兜底，reply:', parsed.reply?.slice(0, 200));
                // 尝试从 raw reply 中提取 reply 字段的值
                const replyValMatch = parsed.reply.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                if(replyValMatch){
                    try { parsed.reply = JSON.parse('"' + replyValMatch[1] + '"'); } catch(e){ parsed.reply = replyValMatch[1]; }
                    // 提取到了 reply，继续走正常流程创建 prompt
                    parsed.prompts = [{prompt:text, count:1, use_last_outputs:isModifyRequest, use_attachments:false, status:'pending'}];
                } else {
                    // 彻底无法提取：给用户友好的提示 + 默认风格选项
                    parsed.reply = '抱歉，AI 回复格式异常。请重新描述你的需求，或者选择一个风格方向开始：';
                    parsed.options = [
                        {label:'水墨风', value:'水墨风'},
                        {label:'油画风', value:'油画风'},
                        {label:'赛博朋克', value:'赛博朋克'},
                        {label:'Q版卡通', value:'Q版卡通'},
                        {label:'自定义输入', value:'CUSTOM_INPUT'}
                    ];
                }
            } else if(isVagueImageRequest(text) && !isModifyRequest){
                // 模糊请求：强制走维度选择
                parsed.options = [
                    {label:'水墨风', value:'水墨风'},
                    {label:'油画风', value:'油画风'},
                    {label:'赛博朋克', value:'赛博朋克'},
                    {label:'Q版卡通', value:'Q版卡通'}
                ];
                parsed.reply = '你的输入比较简略，请先选择一个风格方向，我再为你逐步完善：';
            } else {
                parsed.prompts = [{prompt:text, count:1, use_last_outputs:isModifyRequest, use_attachments:false, status:'pending'}];
                if(!parsed.reply) parsed.reply = '请确认以下提示词：';
            }
        }
        // 3. 数量校准：如果用户设置了 genCount>1 或文本请求了N张
        // 3a. 少于请求数量 → 补充（加入差异化方向，避免生成的图几乎一样）
        if(requestedCount > 1 && parsed.prompts.length > 0 && parsed.prompts.length < requestedCount){
            const basePrompts = parsed.prompts.slice();
            const variantDirections = [
                '不同姿态与动作', '不同场景与氛围', '不同视角与构图',
                '不同配色与光线', '不同细节与装饰', '不同表情与神态',
                '不同背景与环境', '不同材质与质感'
            ];
            while(parsed.prompts.length < requestedCount){
                const base = basePrompts[parsed.prompts.length % basePrompts.length];
                const variantIdx = Math.floor(parsed.prompts.length / basePrompts.length);
                const direction = variantDirections[variantIdx % variantDirections.length];
                parsed.prompts.push({
                    prompt: `${String(base.prompt || '').trim()}，${direction}`,
                    count: 1,
                    use_last_outputs: base.use_last_outputs,
                    use_attachments: base.use_attachments,
                    status: 'pending'
                });
            }
        }
        // 3b. 多于请求数量 → 截断到请求数量
        if(requestedCount > 1 && parsed.prompts.length > requestedCount){
            parsed.prompts = parsed.prompts.slice(0, requestedCount);
        }
    }
    // 直接模式数量校准（B0）：
    // 1) 单条 generation + 用户明确要 N 张 → 冻结到该 generation.count=N（同主题多张）
    // 2) 多条 generation（多步/多主体）→ 每条 count=1，不把“两张”误扩成两套完整流程
    // 3) 只有“同主题变体不足”时，才追加 generation 条目补齐
    if(!thinkingModeOn && parsed.generations.length > 0){
        // 分别改图：每步 1 张，不要把“两只/两张”误当成同主题 count=2
        const attachN = Array.isArray(attachments) ? attachments.filter(x=>x?.url).length : 0;
        const perRef = attachN >= 2 && agentLooksLikePerReferenceEdit(text, attachN);
        const multiFrameIntent = /(连续|分镜|连环|故事板|步骤|先.+再|然后|第[一二三四五六七八九十1-9][张幕格步])/.test(String(text||''))
            || (Array.isArray(parsed.plan?.steps_summary) && parsed.plan.steps_summary.length > 1)
            || parsed.generations.some(g => g.depends_on_previous || g.use_previous_results || String(g.dependency_mode||'') === 'product_reference' || String(g.dependency_mode||'') === 'fusion');
        if(perRef){
            parsed.generations.forEach(g => { g.count = 1; });
        }else if(requestedCount > 1 && parsed.generations.length === 1 && multiFrameIntent){
            // 连续小故事/分镜：数量=步数，不是同一步 count=N
            // 若解析后只剩 1 步，保留 count=1，避免“三张连续”被压成一个节点出 3 张同提示词
            parsed.generations[0].count = 1;
        }else if(requestedCount > 1 && parsed.generations.length === 1){
            // 同主题多张（无分镜/无依赖）才允许 count=N
            parsed.generations[0].count = requestedCount;
        }else if(requestedCount > 1 && parsed.generations.length > 1){
            // 多步计划：每步默认 1 张，避免把“先猫后狗再融合”的每步都扩成两张
            parsed.generations.forEach(g => { g.count = Math.max(1, Math.min(8, Number(g.count) || 1)); if(g.count > 1 && !g._explicitCount) g.count = 1; });
            // 若模型只返回了 1 类主题却拆成多条近似 prompt，且用户只是要同主题多张，不在这里二次扩条
        }else{
            parsed.generations.forEach(g => { g.count = Math.max(1, Math.min(8, Number(g.count) || 1)); });
        }
        // 同主题变体补齐：仅当全部 generation 都是独立文生图、且条数不足 requestedCount 时
        const allIndependent = parsed.generations.every(g => !g.depends_on_previous && !g.use_last_outputs && agentNormalizeDependencyMode(g.dependency_mode, g.prompt) === 'none');
        if(false && requestedCount > 1 && allIndependent && parsed.generations.length > 1 && parsed.generations.length < requestedCount){ // 厚加固关闭：不补同主题变体条
            const basePrompts = parsed.generations.slice();
            while(parsed.generations.length < requestedCount){
                const base = basePrompts[parsed.generations.length % basePrompts.length];
                const variantIdx = parsed.generations.length - basePrompts.length + 1;
                parsed.generations.push({
                    prompt: `${String(base.prompt || text || '').trim()}，请使用完全不同的品牌主题/行业方向，确保与前面生成的内容有明显差异`,
                    count: 1,
                    use_last_outputs: !!base.use_last_outputs,
                    use_attachments: !!base.use_attachments,
                    depends_on_previous: false,
                    dependency_mode: 'none',
                    results: [],
                    status: 'running'
                });
            }
        }
    }
    if(!thinkingModeOn && parsed.generations.length){
        const taskSpec = agentNormalizeTaskSpec(options.taskSpec || userMsg?.taskSpec || null);
        const taskSpecResult = agentApplyTaskSpecToPlan(parsed, taskSpec);
        if(!taskSpecResult.ok){
            parsed.plan_validation_errors = taskSpecResult.errors.slice();
            parsed.generations = [];
            parsed.options = [];
            parsed.reply = `${String(parsed.reply || '').trim()}${String(parsed.reply || '').trim() ? AGENT_NL + AGENT_NL : ''}任务单与阶段2规划数量不一致，已停止执行：${taskSpecResult.errors.join('；')}。`;
        }
        // Skill 已经在阶段1逐页产出完整策划时，最终节点提示词直接使用对应页面原文。
        // 阶段2 LLM 仍负责 attachment_indices / artifacts / 参数，但无权摘要或改写页面内容。
        agentBindSkillPlanPagesToGenerations(
            parsed,
            options.understanding || userMsg?.understanding || '',
            taskSpec,
            userMsg?.skills || []
        );
        const directPlanUserText = String(userMsg?.text || text || '').trim();
        const directPlanAttachments = attachments || userMsg?.images || [];
        // 先识别“前置步骤并行、门禁后融合”的结构，再处理普通串行链。
        // 若先套用普通“再”规则，会把第二个独立前置步骤错误连到第一步。
        const explicitGeneratedChain = agentExplicitGeneratedChainRequirements(directPlanUserText, parsed.generations);
        const explicitGeneratedAnchor = !explicitGeneratedChain
            ? agentExplicitGeneratedAnchorRequirements(directPlanUserText, parsed.generations, options.understanding || userMsg?.understanding || '')
            : null;
        if(explicitGeneratedChain){
            agentApplyExplicitGeneratedChainRequirements(parsed, directPlanUserText, directPlanAttachments);
        }else if(explicitGeneratedAnchor){
            agentApplyExplicitGeneratedAnchorRequirements(parsed, directPlanUserText, directPlanAttachments, options.understanding || userMsg?.understanding || '');
        }else{
            agentApplyExplicitChainAttachmentRequirements(parsed, directPlanUserText, directPlanAttachments);
        }
        agentEnsureExplicitChainArtifactBindings(parsed, directPlanUserText, directPlanAttachments);
        // Ensure the thin dependency binding is part of the real LLM -> execution path.
        // It only fixes dependency metadata from user semantics; prompts remain verbatim.
        agentApplyComplexRequestGuards(
            parsed,
            directPlanUserText,
            directPlanAttachments,
            Array.isArray(userMsg?.skills) ? userMsg.skills : []
        );
        agentMarkGenerationDependencies(
            parsed.generations,
            directPlanUserText,
            parsed.shared_style || parsed.generations?.[0]?.shared_style || ''
        );
        // 无上传图但明确“先生成基础图、再制作主图/详情页”时，引用的是同计划前序产物，
        // 不能把生成结果编号误塞进 attachment_indices。
        // 任何无用户附件的计划都必须清除 LLM 误写的步骤序号；前序生成引用
        // 仍完整保留在 depends_on_previous / depends_on_steps 中。
        agentClearAttachmentIndicesWithoutUserAttachments(parsed, attachments || userMsg?.images || []);
        const directPlanErrors = agentValidateDirectPlan(parsed, {
            userText: directPlanUserText,
            confirmedPlanText: options.understanding || userMsg?.understanding || '',
            attachments: attachments || userMsg?.images || [],
            skills: userMsg?.skills || [],
            requestedCount,
            taskSpec
        });
        if(directPlanErrors.length){
            parsed.plan_validation_errors = directPlanErrors;
            parsed.generations = [];
            parsed.options = [];
            parsed.reply = `${String(parsed.reply || '').trim()}${String(parsed.reply || '').trim() ? AGENT_NL + AGENT_NL : ''}规划结构检查未通过，已阻止错误执行：${directPlanErrors.join('；')}。请修改策划或参数后再确认；系统不会自动重新调用 LLM。`;
        }
        // 在 attachment_indices 已冻结并通过结构检查后，统一提示词中的图号。
        // 这不会改变模型已定稿的视觉内容，只使用户看到的提示词与真实连线顺序一致。
        if(!directPlanErrors.length){
            agentCanonicalizePlannedReferenceLabels(parsed.generations, attachments || userMsg?.images || []);
        }
    }
const understandingFromOpt = String(options.understanding || userMsg?.understanding || '').trim();
const hasPlanGens = Array.isArray(parsed.generations) && parsed.generations.length > 0;
const hasPlanObj = !!(parsed.plan && typeof parsed.plan === 'object');
const isUnderstandStage = String(options.stage || '').toLowerCase() === 'understand';
// 阶段1直出：禁止把自然语言误判成规划/执行
if(isUnderstandStage){
    parsed.generations = [];
    parsed.prompts = [];
    parsed.plan = null;
}
// 阶段2（继续规划 / 已有 plan 或 generations）一律视为规划消息
const isPlanStageMsg = !isUnderstandStage && !!(hasPlanGens || hasPlanObj || options.fromStageContinue || options.stage === 'plan');
const assistantMsg = {
    id:uid('am'), 
    role:'assistant', 
    text:parsed.reply, 
    options:parsed.options || [], 
    prompts:parsed.prompts || [], 
    generations:parsed.generations, 
    shared_style: parsed.shared_style || '',
    artifacts: Array.isArray(parsed.plan?.artifacts) ? parsed.plan.artifacts.map(item => ({...item})) : [],
    // 规划/执行消息禁止回挂阶段1策划，从源头消灭第二条“策划”
    understanding: isPlanStageMsg ? '' : understandingFromOpt,
    plan: parsed.plan || null,
    taskSpec: agentNormalizeTaskSpec(options.taskSpec || userMsg?.taskSpec || parsed.task_spec || null),
    stage: isPlanStageMsg ? 'plan' : (understandingFromOpt ? 'understand' : ''),
    fromStageContinue: !!options.fromStageContinue,
    ts:Date.now(),
    collected: parsed.collected || {},
    next_dimension: parsed.next_dimension || '',
    remaining_dimensions: parsed.remaining_dimensions || []
};
assistantMsg.contextSources = userMsg?.contextSources || null;
// 双保险：只要已有步骤卡片，强制清空 understanding
if(Array.isArray(assistantMsg.generations) && assistantMsg.generations.length){
    assistantMsg.understanding = '';
    assistantMsg.stage = 'plan';
}
// 仅纯策划/无 generations 时，才允许用策划正文兜底 reply
if(!String(assistantMsg.text || '').trim() && !isPlanStageMsg && understandingFromOpt){
    assistantMsg.text = understandingFromOpt;
}
// 阶段2若 reply 太短，用 plan.steps_summary 补一句规划说明（仍不回灌阶段1策划）
if(isPlanStageMsg && !String(assistantMsg.text || '').trim()){
    const steps = Array.isArray(parsed.plan?.steps_summary) ? parsed.plan.steps_summary.filter(Boolean) : [];
    const goal = String(parsed.plan?.goal || '').trim();
    if(goal || steps.length){
        assistantMsg.text = [goal ? `规划目标：${goal}` : '', steps.length ? `步骤：${steps.join('；')}` : ''].filter(Boolean).join(AGENT_NL);
    }else if(hasPlanGens){
        assistantMsg.text = `已规划 ${parsed.generations.length} 个生图步骤，请检查下方完整提示词。`;
    }
}
    // P2-12: 记录请求数量到消息，用于卡片显示校验
    if(requestedCount > 0) assistantMsg.requestedCount = requestedCount;
    if(assistantMsg.prompts.length > 0){
        assistantMsg.promptIdx = 0;
        // 设置第一个 prompt 为 current
        if(!assistantMsg.prompts[0].status || assistantMsg.prompts[0].status === 'pending'){
            assistantMsg.prompts[0].status = 'current';
        }
    }
    assistantMsg.conversationId = ownerConversationId || assistantMsg.conversationId || '';
    // 关键：结果必须写回任务所属对话，绝不能写到用户后来切过去的新对话
    agentPushMessageToConversation(ownerConversationId, assistantMsg);
    if(agentIsActiveConversation(ownerConversationId)){
        agentThinking = false;
        agentThinkingConversationId = '';
        renderAgentMessages();
        saveAgentState();
    }else{
        // 后台完成：关掉所属对话的 thinking 标记，但不要让当前新对话显示 spinner/结果
        if(agentThinkingConversationId === ownerConversationId){
            agentThinking = false;
            agentThinkingConversationId = '';
        }
        saveAgentState();
    }
    // 阶段1：只展示直出内容并等待确认，不进入生图
    if(isUnderstandStage){
        const uText = String(assistantMsg.text || assistantMsg.understanding || understandingFromOpt || '').trim();
        assistantMsg.generations = [];
        assistantMsg.prompts = [];
        assistantMsg.understanding = uText;
        assistantMsg.stage = 'understand';
        assistantMsg.text = uText;
        agentPushStageGateMessage({
            conversationId: ownerConversationId,
            understanding: uText,
            planText: uText,
            generations: [],
            nextStage: 'understand',
            userMsg,
            attachments: userMsg?.images || attachments || [],
            userText: text || userMsg?.text || '',
            sharedStyle: ''
        });
        if(agentIsActiveConversation(ownerConversationId)){
            renderAgentMessages();
            updateAgentPrimaryAction();
            saveAgentState(true);
        }else{
            saveAgentState(true);
        }
        return;
    }

    // 只发参考图且无明确文字要求：禁止自动开跑，强制询问
    // 注意：像“生成一只猫”这种明确指令，绝不能走询问分支
    const userTextForGuard = text || userMsg?.text || '';
    const guardSkills = Array.isArray(userMsg?.skills) ? userMsg.skills : [];
    const imageOnlyTurn = !agentLooksLikeClearGenRequest(userTextForGuard)
        && agentShouldAskForImageOnly(userTextForGuard, userMsg?.images || attachments || [], guardSkills);
    if(imageOnlyTurn){
        const ask = agentDefaultImageOnlyAsk((userMsg?.images || attachments || []).filter(x => x?.url).length || 1);
        // 清掉模型擅自给出的 generations / prompts
        assistantMsg.generations = [];
        assistantMsg.prompts = [];
        if(!String(assistantMsg.text || '').trim() || /已生成|开始生成|我将生成|规划了/.test(String(assistantMsg.text||''))){
            assistantMsg.text = ask.reply;
        }
        if(!Array.isArray(assistantMsg.options) || !assistantMsg.options.length){
            assistantMsg.options = ask.options.slice();
        }else{
            // 确保有可点选项；没有自定义入口时补一个
            const hasCustom = assistantMsg.options.some(o => String(o?.value||'') === 'CUSTOM_INPUT');
            if(!hasCustom) assistantMsg.options.push({label:'自定义说明', value:'CUSTOM_INPUT'});
        }
        assistantMsg.imageOnlyAsk = true;
        if(agentIsActiveConversation(ownerConversationId)){
            // 仅询问不执行时，释放 planning 锁，允许继续对话
            if(agentActiveWorkflow && ['planning','creating_nodes','ready'].includes(String(agentActiveWorkflow.status||''))){
                agentActiveWorkflow.status = 'completed';
                agentActiveWorkflow.updatedAt = Date.now();
            }
            agentSending = false;
            agentThinking = false;
            agentThinkingConversationId = '';
            updateAgentPrimaryAction();
            renderAgentMessages();
            saveAgentState(true);
        }else{
            saveAgentState(true);
        }
        return;
    }

    if(assistantMsg.generations.length && assistantMsg.prompts.length === 0){
        // 二次保险：执行前再判断一次，避免漏网开跑
        if(agentShouldAskForImageOnly(text || userMsg?.text || '', userMsg?.images || attachments || [], guardSkills) && !agentLooksLikeClearGenRequest(text || userMsg?.text || '')){
            assistantMsg.generations = [];
            if(agentIsActiveConversation(ownerConversationId)){
                if(agentActiveWorkflow && ['planning','creating_nodes','ready'].includes(String(agentActiveWorkflow.status||''))){
                    agentActiveWorkflow.status = 'completed';
                    agentActiveWorkflow.updatedAt = Date.now();
                }
                agentSending = false;
                agentThinking = false;
                agentThinkingConversationId = '';
                updateAgentPrimaryAction();
                renderAgentMessages();
                saveAgentState(true);
            }
            return;
        }
        // 此处不再补 prompt、不再压缩步骤；通过结构检查的 LLM generations 原样进入执行层。
        if(agentGetRunMode() === 'semi' && options.autoExecute !== true && Array.isArray(assistantMsg.generations) && assistantMsg.generations.length){
            const pendingGens = assistantMsg.generations.map((g, i) => ({
                ...g,
                // 确认前先展示完整提示词方案，不进入真正跑图
                status: (g && (g.status === 'done' || g.status === 'error')) ? g.status : 'planned',
                results: Array.isArray(g?.results) ? g.results : [],
                title: g?.title || `步骤${i+1}`
            }));
            // 保留在当前规划消息中展示提示词，方便用户检查；门禁消息只负责确认按钮
            assistantMsg.generations = pendingGens;
            assistantMsg.prompts = [];
            assistantMsg.awaitingExecuteConfirm = true;
            assistantMsg.stage = 'plan';
            assistantMsg.understanding = ''; // 规划消息不展示策划折叠
            agentPushStageGateMessage({
                conversationId: ownerConversationId,
                understanding: '', // 执行确认不再重复挂整段策划，避免上下两份
                planText: assistantMsg.text || '',
                generations: pendingGens,
                nextStage: 'execute',
                userMsg,
                attachments: userMsg?.images || attachments || [],
                userText: text || userMsg?.text || '',
                sharedStyle: assistantMsg.shared_style || '',
                artifacts: assistantMsg.artifacts || [],
                taskSpec: assistantMsg.taskSpec
            });
            if(agentIsActiveConversation(ownerConversationId)){
                renderAgentMessages();
                saveAgentState(true);
            }else{
                saveAgentState(true);
            }
            return;
        }
        await runAgentGenerations(assistantMsg, userMsg, {conversationId: ownerConversationId});

    } else {
        // 没有可执行 generations（纯回复/选项/待确认）时，结束 planning，避免发送按钮一直停住
        if(agentIsActiveConversation(ownerConversationId)){
            if(agentActiveWorkflow && ['planning','creating_nodes','ready'].includes(String(agentActiveWorkflow.status||''))){
                agentActiveWorkflow.status = 'completed';
                agentActiveWorkflow.updatedAt = Date.now();
            }
            agentSending = false;
            agentThinking = false;
            if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
            updateAgentPrimaryAction();
            renderAgentMessages();
            saveAgentState(true);
        }
    }
}
// 快捷操作辅助：设置输入框文本并触发发送
function agentSendWithText(text){
    if(!text) return;
    if(agentInput) agentSetInputValue(text);
    updateAgentPrimaryAction();
    sendAgentMessage();
}
function queueAgentSteer(){
    // 任务进行中禁止再发布内容（含排队插话）；需要停止请点红色停止按钮
    if(typeof agentIsTaskBusy === 'function' && agentIsTaskBusy()){
        if(typeof toast === 'function') toast('当前任务进行中，请等待完成或点击停止');
        updateAgentPrimaryAction();
        return;
    }
    const text=String(agentGetInputValue()||'').trim();
    if(agentGhostAttachments.length) confirmAgentGhostAttachment();
    try{ agentSanitizeComposerResidue(); }catch(_){ }
    agentSyncAttachmentsFromComposer();
    agentRenumberInlineChips();
    let parts=[];
    try{ parts = agentGetComposerParts(); }catch(_){ parts=[]; }
    const attachments=(agentState?.attachments||[]).slice().map((att,i)=>({
        ...att,
        refIndex:i+1,
        label:`参考图${i+1}`,
        name: att.name || `Image${i+1}`
    }));
    if(!text&&!attachments.length)return;
    parts = agentNormalizeComposerParts(parts, text, attachments);
    if(!agentActiveWorkflow) agentActiveWorkflow={id:uid('awf'),status:'running',nodeIds:[],steerQueue:[],createdAt:Date.now(),updatedAt:Date.now()};
    if(!Array.isArray(agentActiveWorkflow.steerQueue))agentActiveWorkflow.steerQueue=[];
    const steer={id:uid('steer'),type:'steer',conversation_id:agentState.activeConversationId,workflow_id:agentActiveWorkflow.id,text,attachments,parts,created_at:Date.now(),status:'queued'};
    agentActiveWorkflow.steerQueue.push(steer);agentActiveWorkflow.updatedAt=Date.now();
    agentState.messages.push({id:steer.id,role:'user',type:'steer',text,images:attachments,parts,statusLabel:'已排队',ts:steer.created_at});
    agentGhostAttachments=[];agentState.attachments=[];if(agentInput){agentClearComposer();agentFocusComposer();}
    renderAgentAttachments();renderAgentMessages();saveAgentState();
    toast('新要求已排队，将在当前步骤完成后执行');
}
function agentNormalizeComposerParts(parts, text='', attachments=[]){
    const imgs = (attachments || []).filter(a => a?.url).map((att, i) => ({
        type: 'image',
        url: att.url || '',
        name: att.name || att.label || `Image${i+1}`,
        nodeId: att.nodeId || '',
        x: Number(att.x) || 0,
        y: Number(att.y) || 0,
        refIndex: Number(att.refIndex) || (i + 1),
        label: att.label || `参考图${Number(att.refIndex) || (i + 1)}`
    }));
    let out = Array.isArray(parts) ? parts.map(p => {
        if(!p) return null;
        if(p.type === 'image' && p.url){
            return {
                type: 'image',
                url: p.url || '',
                name: p.name || p.label || 'image',
                nodeId: p.nodeId || '',
                x: Number(p.x) || 0,
                y: Number(p.y) || 0,
                refIndex: Number(p.refIndex) || 0,
                label: p.label || ''
            };
        }
        if(p.type === 'text' || p.text != null){
            const t = String(p.text || '');
            // contenteditable 会在图片字符前后自动插入换行；空白段不应作为消息内容回显。
            return t.trim() ? {type:'text', text:t} : null;
        }
        return null;
    }).filter(Boolean) : [];
    // 给混排图片补稳定序号
    let imgN = 0;
    out = out.map(part => {
        if(part.type !== 'image') return part;
        imgN += 1;
        const idx = Number(part.refIndex) || imgN;
        return {
            ...part,
            refIndex: idx,
            label: part.label || `参考图${idx}`,
            name: part.name || `Image${idx}`
        };
    });
    if(out.length) return out;
    // 兜底：没有混排结构时，尽量还原“图+文”而不是只剩纯文本
    const fallback = [];
    if(String(text || '').trim()) fallback.push({type:'text', text:String(text)});
    imgs.forEach((att, i) => fallback.push({...att, refIndex:i+1, label:`参考图${i+1}`}));
    return fallback;
}
function agentComposerPartsToSemanticText(parts, fallbackText='', attachments=[]){
    const normalized = agentNormalizeComposerParts(parts, fallbackText, attachments);
    if(!normalized.length) return String(fallbackText || '').trim();
    let imageNumber = 0;
    const semantic = normalized.map(part => {
        if(part?.type === 'image' && part.url){
            imageNumber += 1;
            const index = Number(part.refIndex) || imageNumber;
            return `【参考图${index}】`;
        }
        return String(part?.text || '')
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .replace(/\u00a0/g, ' ');
    }).join('');
    return semantic
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function agentSnapshotActiveSkills(){
    let list = Array.isArray(agentState?.skills) ? agentState.skills : [];
    if(!list.length){
        try{
            const conv = agentGetConversationById?.(agentState?.activeConversationId || '');
            if(conv && Array.isArray(conv.skills) && conv.skills.length) list = conv.skills;
        }catch(_){}
    }
    return agentNormalizeSkillList(list)
        .map(s => ({
            name: String(s?.name || 'skill').trim() || 'skill',
            content: String(s?.content || ''),
            presetId: s?.presetId || s?.id || ''
        }))
        .filter(s => s.name || s.content);
}
function agentUserMessageForSend(text,attachments,preParts=null){
    const queued=(agentState.messages||[]).find(m=>m.type==='steer'&&m.statusLabel==='已排队'&&m.text===text);
    const imgs = (attachments || []).map((att, i) => ({...att, refIndex:i+1, label:`参考图${i+1}`}));
    const skills = agentSnapshotActiveSkills();
    // 关键：parts 必须在清空输入框前捕获；发送后气泡按“图片字符 + 文字”原样回显
    let parts = [];
    if(Array.isArray(preParts) && preParts.length){
        parts = preParts.slice();
    }else{
        try{ parts = agentGetComposerParts(); }catch(_){ parts = []; }
    }
    parts = agentNormalizeComposerParts(parts, text, imgs);
    const semanticText = agentComposerPartsToSemanticText(parts, text, imgs);
    const manifest = agentAttachmentManifestText(imgs, semanticText, skills);
    if(queued){
        queued.statusLabel='已应用';
        queued.images=imgs;
        queued.attachmentManifest=manifest;
        queued.parts=parts;
        queued.skills=skills;
        queued.text=semanticText;
        return queued;
    }
    return{id:uid('am'),role:'user',text:semanticText,images:imgs,parts,skills,attachmentManifest:manifest,ts:Date.now()};
}
async function stopAgentWorkflow(){
    const currentConversationId = agentState?.activeConversationId || '';
    if(agentGlobalTaskOwnedByOther(currentConversationId)){
        agentNotifyGlobalTaskBlocked();
        updateAgentPrimaryAction();
        return;
    }
    if(!agentSending&&!['planning','creating_nodes','ready','running'].includes(agentActiveWorkflow?.status))return;
    agentStopRequested=true;if(!agentActiveWorkflow)agentActiveWorkflow={id:uid('awf'),nodeIds:[]};
    agentActiveWorkflow.status='stopping';agentActiveWorkflow.updatedAt=Date.now();updateAgentPrimaryAction();saveAgentState();
    await Promise.all((agentActiveWorkflow.nodeIds||[]).map(id=>Promise.resolve(agentHost?.cancelNodeRun?.(id)).catch(()=>{})));
    agentActiveWorkflow.status='stopped';agentActiveWorkflow.updatedAt=Date.now();agentSending=false;agentThinking=false;
    agentPushMessageToConversation(agentActiveWorkflow?.conversationId||agentState.activeConversationId||'',{id:uid('am'),role:'assistant',text:'已停止当前任务。已创建的节点、结果和输入草稿均已保留。',generations:[],ts:Date.now(),conversationId:agentActiveWorkflow?.conversationId||agentState.activeConversationId||''});
    renderAgentMessages();saveAgentState();
}
function agentConversationHasRunningGens(conversationId=''){
    try{
        const cid = conversationId || agentState?.activeConversationId || '';
        const msgs = cid
            ? (agentEnsureConversationMessages(cid) || [])
            : (Array.isArray(agentState?.messages) ? agentState.messages : []);
        return (msgs || []).some(m =>
            m && m.role === 'assistant'
            && Array.isArray(m.generations)
            && m.generations.some(g => g && (g.status === 'running' || g.status === 'waiting'))
        );
    }catch(_){
        return false;
    }
}
function agentIsTaskBusy(){
    const currentConversationId = agentState?.activeConversationId || agentActiveWorkflow?.conversationId || '';
    // 另一个对话占用画布时，当前对话仍显示“发送”而不是“停止”；
    // 真正点击发送时由 owner 门禁给出明确提示。
    if(agentGlobalTaskOwnedByOther(currentConversationId)) return false;
    const wfStatus = String(agentActiveWorkflow?.status || '').toLowerCase();
    const wfBusy = ['planning','creating_nodes','ready','running','stopping'].includes(wfStatus);
    const genBusy = !!(agentGlobalTaskOwnedBy(currentConversationId)
            && typeof window !== 'undefined' && window.__canvasAgentGenRunning)
        || agentConversationHasRunningGens(currentConversationId);
    return !!(agentSending || agentThinking || wfBusy || genBusy);
}

// 阶段1是后续所有规划的唯一语义来源。这里只做结构性检查：不评判审美，
// 但要阻止明显截断或套图数量未完成的内容进入阶段2。
function agentMaxPlannedPageNumber(text=''){
    const source = String(text || '');
    const nums = source.match(/(?:第\s*)?(\d+|[一二两三四五六七八九十百]+)\s*(?:页|张)/g) || [];
    let max = 0;
    nums.forEach(token => {
        const m = token.match(/(\d+|[一二两三四五六七八九十百]+)/);
        if(!m) return;
        const value = /^\d+$/.test(m[1]) ? Number(m[1]) : agentCnNumToInt(m[1]);
        if(Number.isFinite(value)) max = Math.max(max, value);
    });
    const labeledNumberRe = /(?:主图|详情页|详情图)\s*(\d+|[一二两三四五六七八九十百]+)/g;
    let labeledMatch;
    while((labeledMatch = labeledNumberRe.exec(source))){
        const value = /^\d+$/.test(labeledMatch[1]) ? Number(labeledMatch[1]) : agentCnNumToInt(labeledMatch[1]);
        if(Number.isFinite(value)) max = Math.max(max, value);
    }
    const pairedHeadingRe = /(?:主图|详情页|详情图)\s*(\d+)\s*(?:&|和|与|、|及)\s*(\d+)/g;
    let pairedMatch;
    while((pairedMatch = pairedHeadingRe.exec(source))){
        max = Math.max(max, Number(pairedMatch[1]) || 0, Number(pairedMatch[2]) || 0);
    }
    return max;
}
function agentValidateUnderstandingStage(text='', options={}){
    const userText = options?.userText || '';
    const skills = options?.skills || [];
    const taskSpec = agentNormalizeTaskSpec(options?.taskSpec);
    const body = String(text || '').trim();
    const errors = [];
    if(!body) return ['阶段1没有返回策划内容'];
    const normalizedSkills = agentNormalizeSkillList(skills);
    const hasDetailedSkill = normalizedSkills.some(skill => String(skill?.content || '').trim().length >= 500);
    const skillText = normalizedSkills.map(skill => String(skill?.content || '')).join('\n');
    // Skill 的输出格式由 Skill 自己决定。过去这里看到电商 Skill 文本里有
    // “页面作用/AI 图片生成提示词/文案排版说明”就强制套用固定页字段，
    // 导致合法的单图、风格和自定义套图策划被误判为不完整。阶段1只检查
    // 是否有可执行的正文与任务单；显式 required_fields 才属于本轮的字段契约。
    const explicitRequiredFields = taskSpec
        ? taskSpec.deliverables.flatMap(item => Array.isArray(item.required_fields) ? item.required_fields : [])
        : [];
    const hasTaskEvidence = !!(taskSpec?.deliverables?.length)
        || /(?:生成|制作|设计|修改|替换|融合|主图|详情页|海报|表情包|三视图|提示词)/.test(body);
    if(hasDetailedSkill && !taskSpec && body.length < 300) errors.push('阶段1策划内容过短，未完整吸收 Skill');
    if(taskSpec && body.length < 80) errors.push('阶段1策划正文过短，无法说明本轮任务');
    if(!hasTaskEvidence) errors.push('阶段1未说明可执行的任务或成果');
    const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    const isStructuredSuite = /套图|整套|三视图/.test(String(userText || ''))
        || (/(?:主图|详情页|详情图)/.test(String(userText || '')) && /(?:再|然后|先|[2-9]\s*张|[二三四五六七八九十]\s*张)/.test(String(userText || '')));
    if(!taskSpec && (hasDetailedSkill || isStructuredSuite)
        && (/^(?:#{1,6}\s+|【[^】]+】\s*$)/.test(last) || /^(?:[^。！？!?]{1,40})[：:]$/.test(last))){
        errors.push('阶段1内容疑似在标题或字段名处中断');
    }
    // 不再检查固定的“角色定位/产品依据/三项全局标题/五个逐页字段”。
    // 若 Skill 确实声明了自定义字段，字段契约会随 taskSpec.required_fields
    // 传入执行层，由阶段2逐项绑定；正文可以使用 Skill 的原生标题或自然语言。
    if(explicitRequiredFields.length && body.length < 80){
        errors.push('阶段1未提供 Skill 声明的字段内容');
    }
    const source = String(userText || '');
    // 数量必须绑定到“张 + 类型”，并允许类型前出现比例。
    // 旧正则会从“2张1:1主图/2张9:16详情页”重新从冒号后的数字开始匹配，
    // 把比例的 1/16 误报成数量，导致合法策划被错误拦截。
    const sectionCountToken = '(\\d+|[一二两三四五六七八九十百]+)';
    const sectionCountRe = new RegExp(`(?:^|[^\\d:])${sectionCountToken}\\s*张(?:\\s*\\d+\\s*:\\s*\\d+)?\\s*(主图|详情(?:页|图)?)`, 'g');
    const sectionCounts = [];
    let sectionMatch;
    while((sectionMatch = sectionCountRe.exec(source))){
        const rawCount = sectionMatch[1];
        const type = sectionMatch[2].startsWith('主图') ? 'main' : 'detail';
        const value = /^\\d+$/.test(rawCount) ? Number(rawCount) : agentCnNumToInt(rawCount);
        if(Number.isFinite(value) && value > 0) sectionCounts.push({type, value});
    }
    const mainMatch = sectionCounts.find(item => item.type === 'main') || null;
    const detailMatch = sectionCounts.find(item => item.type === 'detail') || null;
    if(mainMatch && detailMatch){
        const mainCount = mainMatch.value;
        const detailCount = detailMatch.value;
        if(taskSpec){
            const plannedMainCount = taskSpec.deliverables
                .filter(item => item.type === 'main')
                .reduce((sum, item) => sum + item.count, 0);
            const plannedDetailCount = taskSpec.deliverables
                .filter(item => item.type === 'detail')
                .reduce((sum, item) => sum + item.count, 0);
            if(plannedMainCount !== mainCount) errors.push(`阶段1任务单主图数量应为 ${mainCount} 张，实际为 ${plannedMainCount} 张`);
            if(plannedDetailCount !== detailCount) errors.push(`阶段1任务单详情页数量应为 ${detailCount} 张，实际为 ${plannedDetailCount} 张`);
        // 没有任务单时，只有多页套图才需要用分区与页码证明页数完整。
        // 一主图 + 一详情页这类短任务可以用自然语言完整说明；模型偶尔漏掉
        // AGENT_TASK_SPEC 时不能因为没有 Markdown 分区而误拦截到阶段2。
        }else if(mainCount > 1 || detailCount > 1){
            const mainStart = body.search(/(?:第一部分|主图方案|主图规划|#{1,6}\s*(?:\d+[.、)]?\s*)?主图(?=\s|\d|[：:(（]))/);
            const detailStart = body.search(/(?:第二部分|详情页方案|详情页规划|#{1,6}\s*(?:\d+[.、)]?\s*)?详情(?:页|图)?(?=\s|\d|[：:(（]))/);
            if(mainStart < 0 || detailStart < 0 || detailStart <= mainStart){
                errors.push('阶段1缺少主图或详情页方案分区');
            }else{
                const mainSection = body.slice(mainStart, detailStart);
                const detailSection = body.slice(detailStart);
                if(agentMaxPlannedPageNumber(mainSection) < mainCount) errors.push(`主图方案未完整列出 ${mainCount} 页`);
                if(agentMaxPlannedPageNumber(detailSection) < detailCount) errors.push(`详情页方案未完整列出 ${detailCount} 页`);
            }
        }
    }
    return [...new Set(errors)];
}
async function agentSendDirectImageMessage(text, attachments, composerParts, {taskGateOwned=false}={}){
    const prompt = String(text || '').trim();
    if(!prompt){
        if(typeof toast === 'function') toast('图像模式请输入最终生图提示词');
        return;
    }
    try{ agentEnsureActiveConversation(); }catch(_){ }
    const ownerConversationId = agentState.activeConversationId || '';
    const inheritedTaskGate = taskGateOwned === true && agentGlobalTaskOwnedBy(ownerConversationId);
    let acquiredTaskHere = false;
    if(!inheritedTaskGate){
        if(agentGlobalTaskOwnedByOther(ownerConversationId) || !agentTryAcquireGlobalTask(ownerConversationId)){
            if(agentGlobalTaskOwnedByOther(ownerConversationId)) agentNotifyGlobalTaskBlocked();
            else if(typeof toast === 'function') toast('当前任务正在执行，请等待完成或点击停止');
            updateAgentPrimaryAction();
            return;
        }
        acquiredTaskHere = true;
    }
    try{
    const userMsg = agentUserMessageForSend(prompt, attachments, composerParts);
    userMsg.skills = [];
    userMsg.mode = 'image';
    userMsg.conversationId = ownerConversationId;
    userMsg.requestedSettings = {
        genProvider: String(agentState.genProvider || ''),
        genModel: String(agentState.genModel || ''),
        ratio: String(agentState.genRatio || 'square'),
        resolution: String(agentState.genResolution || '1k'),
        quality: String(agentState.genQuality || 'auto'),
        count: Math.max(1, Math.min(8, Number(agentState.genCount) || 1))
    };
    userMsg.attachmentManifest = agentAttachmentManifestText(userMsg.images || [], prompt, []);
    const count = Math.max(1, Math.min(8, Number(agentState.genCount) || 1));
    const refIndexes = attachments.map((_, index) => index);
    const assistantMsg = {
        id:uid('am'), role:'assistant', text:'', stage:'image', directImageMode:true,
        generations:[{
            id:'direct_image_1', title:'直接生图', role:'image', prompt,
            count,
            use_attachments:refIndexes.length > 0, attachment_indices:refIndexes,
            depends_on_previous:false, use_previous_results:false, use_last_outputs:false,
            dependency_mode:'none', results:[], status:'running'
        }],
        ts:Date.now(), conversationId:ownerConversationId
    };
    agentPushMessageToConversation(ownerConversationId, userMsg);
    agentPushMessageToConversation(ownerConversationId, assistantMsg);
    agentStopRequested = false;
    agentSending = true;
    agentActiveWorkflow = {id:uid('awf'), conversationId:ownerConversationId, messageId:userMsg.id, status:'planning', canvasKind:agentHost?.canvasKind?.()||'', plan:null, nodeIds:[], activeTaskIds:[], steerQueue:[], createdAt:Date.now(), updatedAt:Date.now()};
    agentState.attachments = [];
    if(agentInput){ agentClearComposer(); agentFocusComposer(); }
    renderAgentAttachments();
    renderAgentMessages();
    saveAgentState(true);
    await runAgentGenerations(assistantMsg, userMsg, {conversationId:ownerConversationId});
    }finally{
        if(acquiredTaskHere) agentReleaseGlobalTask(ownerConversationId);
        if(agentIsActiveConversation(ownerConversationId)) updateAgentPrimaryAction();
    }
}
async function sendAgentMessage(){
    if(!agentState) return;
    try{ agentEnsureActiveConversation(); }catch(_){ }
    const ownerConversationId = agentState.activeConversationId || '';
    if(agentGlobalTaskOwnedByOther(ownerConversationId)){
        agentNotifyGlobalTaskBlocked();
        updateAgentPrimaryAction();
        return;
    }
    // 运行中：只允许点停止按钮停止，禁止再发布新内容
    if(agentIsTaskBusy()){
        const action = agentSendBtn?.dataset?.agentAction || '';
        if(action === 'stop'){
            if(agentActiveWorkflow?.status === 'stopping') return;
            await stopAgentWorkflow();
            return;
        }
        // 运行中禁止再发新内容（含 Enter / 发送键误触）
        if(typeof toast === 'function') toast('当前任务进行中，请等待完成或点击停止');
        updateAgentPrimaryAction();
        return;
    }
    // P2-14: 确认中发送新消息拦截 —— 检测有未完成的 prompts 时弹 toast
    {
        const lastAssistant = [...(agentState.messages || [])].reverse().find(m => m.role === 'assistant');
        if(lastAssistant && Array.isArray(lastAssistant.prompts) && lastAssistant.prompts.length > 0){
            const pendingCount = lastAssistant.prompts.filter(p => p.status === 'pending' || p.status === 'current' || p.status === 'editing').length;
            if(pendingCount > 0){
                if(!confirm(`还有 ${pendingCount} 条提示词未确认，是否放弃当前确认并发送新消息？`)){
                    return;
                }
                // 用户确认放弃 → 清除当前 prompts
                lastAssistant.prompts = [];
                delete lastAssistant.promptIdx;
                renderAgentMessages();
                saveAgentState();
            }
        }
    }
    const text = String(agentGetInputValue() || '').trim();
    // 发送按钮可能在画布选区同步计时器之前被点击；在清空输入框前再捕获一次当前选中的图片。
    // 仅使用实时选区，不读取历史结果，避免普通新任务偷偷继承上一轮图片。
    if(!agentGhostAttachments.length && !(agentState.attachments || []).some(att => att?.url)
        && agentSendSelectionSnapshot.length
        && typeof agentForceGhostFromNodes === 'function'){
        try{
            const selectedNodes = agentSendSelectionSnapshot.slice();
            if(selectedNodes.length) agentForceGhostFromNodes(selectedNodes, {reason:'send'});
        }catch(_){ }
    }
    // 发送前先把灰态也确认，避免用户选了多张参考图却忘记点输入框
    if(agentGhostAttachments.length) confirmAgentGhostAttachment();
    try{ agentSanitizeComposerResidue(); }catch(_){ }
    agentSyncAttachmentsFromComposer();
    agentRenumberInlineChips();
    // 关键：必须在清空输入框前保存“图片字符 + 文字”混排结构，否则发送后只能回显纯文本
    let composerParts = [];
    try{ composerParts = agentGetComposerParts(); }catch(_){ composerParts = []; }
    const attachments = (Array.isArray(agentState.attachments) ? agentState.attachments : []).slice().map((att, i) => ({
        ...att,
        refIndex: i + 1,
        label: `参考图${i + 1}`,
        name: att.name || `Image${i + 1}`
    }));
    // 快照仅属于这一次发送。发送后必须释放，绝不让后续无参考图请求
    // 从上一轮用户选图或宿主自动选中结果中继承附件。
    agentSendSelectionSnapshot = [];
    if(!text && !attachments.length) return;
    if(!agentTryAcquireGlobalTask(ownerConversationId)){
        if(agentGlobalTaskOwnedByOther(ownerConversationId)) agentNotifyGlobalTaskBlocked();
        else if(typeof toast === 'function') toast('当前任务正在执行，请等待完成或点击停止');
        updateAgentPrimaryAction();
        return;
    }
    try{
    if(agentCurrentInputMode() === 'image'){
        await agentSendDirectImageMessage(text, attachments, composerParts, {taskGateOwned:true});
        return;
    }
    try{ agentEnsureActiveConversation(); }catch(_){}
    const userMsg = agentUserMessageForSend(text, attachments, composerParts);
    agentStopRequested=false;
    agentActiveWorkflow={id:uid('awf'),conversationId:agentState.activeConversationId,messageId:'',status:'planning',canvasKind:agentHost?.canvasKind?.()||'',plan:null,nodeIds:[],activeTaskIds:[],steerQueue:[],createdAt:Date.now(),updatedAt:Date.now()};
    agentSending=true;
    // 发送后立即释放输入框；后续规划和节点运行不再阻塞编辑。
    agentState.attachments=[];
    if(agentInput){agentClearComposer();agentFocusComposer();}
    renderAgentAttachments();updateAgentPrimaryAction();saveAgentState(true);
    
    // 统一规划路径：无论是否开启思维模式，都先走 LLM 理解/规划，再由画布执行。
    // 旧 OFF 模式意图路由提示词已删除（工作流式规则，不符合“先规划再执行”）。

    // 思维模式开启：走原有 LLM 流程
    if(!chatApiProviders().length){ toast(tr('smart.agentNeedChatModel')); agentSending=false; agentActiveWorkflow.status='failed'; updateAgentPrimaryAction(); saveAgentState(); return; }
    const provider = resolveChatProviderId(agentState.chatProvider);
    const model = resolveChatModel(agentState.chatModel, provider);
    agentState.chatProvider = provider;
    agentState.chatModel = model;
    // 冻结本轮模型与默认参数。任务在后台继续时，不受用户切换对话或模型菜单影响。
    userMsg.requestedSettings = {
        chatProvider: provider,
        chatModel: model,
        genProvider: String(agentState.genProvider || ''),
        genModel: String(agentState.genModel || ''),
        ratio: String(agentState.genRatio || 'square'),
        resolution: String(agentState.genResolution || '1k'),
        quality: String(agentState.genQuality || 'auto'),
        count: Math.max(1, Math.min(8, Number(agentState.genCount) || 1))
    };
    const bypassThinking = agentBypassThinkingNext;
    agentBypassThinkingNext = false;
    userMsg.bypassThinking = bypassThinking;
    try{ agentEnsureActiveConversation(); }catch(_){}
    userMsg.conversationId = ownerConversationId;
    const semanticUserText = String(userMsg?.text || text || '').trim();
    // 发送瞬间冻结本轮上下文。明确的新生图/制作需求默认不继承前一条
    // 任务的交付物；只有用户明确说“继续/修改上一张/基于刚才”等才注入。
    // 这样保留对话记忆，同时不会把两个独立产品任务合并。
    const includeAutoContext = agentState?.autoContext !== false;
    const initialIntent = agentClassifyIntent({
        text:semanticUserText,
        attachments,
        skills:Array.isArray(userMsg?.skills) ? userMsg.skills : []
    });
    const explicitContinuation = agentIsExplicitTaskContinuation(semanticUserText);
    const hasCurrentTurnTaskInputs = attachments.some(a => a?.url)
        || (Array.isArray(userMsg?.skills) && userMsg.skills.length > 0)
        || agentLooksLikeClearGenRequest(semanticUserText);
    // 只在聊天/查看画布/用户明确续作时继承上下文。任何带有本轮生图输入的
    // 新任务都必须是 fresh，避免选中节点或上一轮结果被当作隐式参考。
    const inheritConversationContext = includeAutoContext && !(
        hasCurrentTurnTaskInputs && !explicitContinuation
    ) && (
        initialIntent.intent === 'chat'
        || initialIntent.intent === 'inspect_canvas'
        || explicitContinuation
    );
    userMsg.contextEnabled = inheritConversationContext;
    userMsg.contextMode = inheritConversationContext ? 'continuation' : 'fresh';
    userMsg.contextHistory = inheritConversationContext ? agentFreshTaskHistoryMessages(ownerConversationId, {
        excludeMessageId: userMsg.id,
        max: 12,
        maxChars: AGENT_HISTORY_CHAR_MAX
    }) : [];
    userMsg.canvasSnapshot = inheritConversationContext ? agentCaptureCanvasSnapshot({scope:'selection', includeNeighbors:true}) : null;
    userMsg.contextSources = agentBuildContextSources(ownerConversationId, userMsg.contextHistory, userMsg.canvasSnapshot);
    try{ userMsg.memorySnapshot = inheritConversationContext ? agentSanitizeConversationMemory(agentActiveConversationMemory(ownerConversationId)) : null; }
    catch(_){ userMsg.memorySnapshot = null; }
    // 用户消息固定写入发起任务的对话；上下文先冻结，避免把本条消息重复写进 memory。
    agentPushMessageToConversation(ownerConversationId, userMsg);
    agentState.attachments = [];
    if(agentInput) agentClearComposer();
    renderAgentAttachments();
    agentSending = true;
    agentThinking = true;
    agentThinkingConversationId = ownerConversationId;
    // 保存待处理消息，刷新后可恢复（绑定对话）
    const ownerRequestId = uid('llmreq');
    userMsg._pendingRequestId = ownerRequestId;
    agentSetConversationPending(ownerConversationId, {
        conversationId:ownerConversationId,
        _pendingRequestId:ownerRequestId,
        _pendingMessage:semanticUserText,
        _pendingAttachments:attachments.slice(),
        _pendingUserMsg:userMsg,
        _pendingLlmTaskId:'',
        _pendingLlmTaskTs:0
    }, {replace:true});
    try{ agentEnsureActiveConversation(); }catch(_){}
    renderAgentMessages();
    saveAgentState(true);
    // 只把本轮用户明确提供的参考图发给 LLM；禁止把上一轮生成图/历史附件静默塞进上下文
    const contextImages = attachments.slice();
    const turnSkills = Array.isArray(userMsg?.skills) ? agentNormalizeSkillList(userMsg.skills) : [];
    const imageOnly = agentShouldAskForImageOnly(text, attachments, turnSkills);
    userMsg.imageOnly = imageOnly;
    // 图片 + Skill：Skill 内容本身就是预设要求，直接作为本轮用户任务交给 LLM。
    const skillTaskText = turnSkills
        .map(skill => String(skill?.content || '').trim())
        .filter(Boolean)
        .join(AGENT_NL + AGENT_NL);
    // 真正只发参考图且无 Skill 时才询问。
    let messageText = semanticUserText || skillTaskText || (imageOnly
        ? `【本轮仅上传了参考图，没有文字要求且没有启用 Skill】请先询问用户想对参考图做什么，不要直接生成。generations 必须为空，并给出可选方向。`
        : '');
    if(!messageText && !imageOnly) messageText = '请根据上下文继续。';
    // 前端数量决策：输入框显式要求 > 工具栏设置（软参数覆盖）
    const _finalCount = resolveFinalGenCount(semanticUserText);
    if(_finalCount.count > 1) userMsg.requestedCount = _finalCount.count;
    const _skills = turnSkills;
    // 用户消息只保留用户原话；参考图编号作为独立结构数据放进 system_prompt，
    // 避免在用户要求后面拼接 Agent 规则，稀释 Skill 与真实需求。
    if(imageOnly){
        messageText += `${AGENT_NL}${AGENT_NL}【强制】用户本轮只发了参考图、没有明确文字要求。你必须：reply 询问用户意图；options 给出可选方向；generations 必须是 []。禁止自行猜测并开始生图。`;
    }
    const historyMsgs = Array.isArray(userMsg.contextHistory)
        ? userMsg.contextHistory.slice()
        : agentFreshTaskHistoryMessages(ownerConversationId, {excludeMessageId:userMsg.id, max:12});
    const imageUrls = contextImages.slice(0, AGENT_LLM_IMAGE_MAX).map(i => i.url);
    try {
        const intent = agentClassifyIntent({text:semanticUserText, attachments, skills:turnSkills});
        userMsg.intent = intent.intent;
        userMsg.intentConfidence = intent.confidence;
        if(intent.intent === 'chat' || intent.intent === 'inspect_canvas'){
            await agentRunChatStage({conversationId:ownerConversationId, userMsg, text:semanticUserText || messageText, attachments:[], history:historyMsgs, canvasSnapshot:intent.intent === 'inspect_canvas' ? userMsg.canvasSnapshot : null, intent:intent.intent});
            return;
        }
        // 明确的图片分析/反推提示词请求在任何规划前短路处理。
        if(agentLooksLikeImageAnalysisRequest(semanticUserText) && imageUrls.length){
            await agentRunImageAnalysisStage({conversationId:ownerConversationId, userMsg, text:semanticUserText, attachments});
            return;
        }
        // 修改意见优先：不重跑理解，只改策划
        const pendingRevise = agentGetPendingRevisePlanning(ownerConversationId);
        if(pendingRevise){
            const handled = await agentApplyRevisePlanning(text, pendingRevise, userMsg);
            if(handled) return;
        }
        // 默认流程：先直出内容给用户确认，再进入规划与执行。
        // 1) 阶段1 understand：Skill + 要求 + 参考图 → 自然语言直出
        // 2) 用户确认后阶段2 plan：输出 generations 并执行（半自动仍可在执行前再确认）
        const ownerCid = ownerConversationId || agentState.activeConversationId || '';
        const hasSkill = Array.isArray(turnSkills) && turnSkills.length > 0;
        const hasImages = Array.isArray(attachments) && attachments.some(a => a?.url);
        const looksGen = (typeof agentLooksLikeClearGenRequest === 'function')
            ? agentLooksLikeClearGenRequest(text || messageText || '')
            : true;
        const shouldContentFirst = !imageOnly && !userMsg?.skipUnderstand && (hasSkill || hasImages || looksGen);
        if(shouldContentFirst){
            await agentRunUnderstandingStage({
                conversationId: ownerCid,
                userMsg,
                text: messageText,
                attachments,
                bypassThinking
            });
        }else{
            await agentRunPlanningFromUnderstanding({
                conversationId: ownerCid,
                userMsg,
                text: messageText,
                attachments,
                understandingText: '',
                bypassThinking
            });
        }
        return;

    } catch(e) {
        agentThinkingStage = '';
        agentThinking = false;
        agentThinkingConversationId = '';
        if(!e?.__canvasAgentReported){
            const cid = ownerConversationId || agentState.activeConversationId || '';
            agentPushMessageToConversation(cid, {id:uid('am'), role:'assistant', text:`⚠️ ${String(e.message || e).slice(0, 300)}`, generations:[], contextSources:userMsg?.contextSources || null, ts:Date.now(), conversationId:cid});
            agentRenderConversation(cid);
        }
    } finally {
        // 只有规划/生图都结束后才释放发送锁；否则任务进行中仍禁止再发
        const stillBusy = !!(typeof window !== 'undefined' && window.__canvasAgentGenRunning)
            || ['planning','creating_nodes','ready','running','stopping'].includes(String(agentActiveWorkflow?.status || '').toLowerCase())
            || agentConversationHasRunningGens(ownerConversationId || agentState?.activeConversationId || '');
        if(!stillBusy){
            agentSending = false;
            agentThinking = false;
            agentThinkingStage = '';
            agentThinkingConversationId = '';
        }else{
            // 生图阶段继续占用锁；thinking 可关，避免一直显示“思考中”
            agentThinking = false;
            agentThinkingStage = '';
            if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
            agentSending = true;
        }
        // await 返回后只清理本次发送拥有的 pending；不能删除另一对话后来写入的任务。
        if(agentClearConversationPending(ownerConversationId, {requestId:ownerRequestId})) saveAgentState();
        renderAgentMessages();
        updateAgentPrimaryAction();
    }
    }finally{
        agentReleaseGlobalTask(ownerConversationId);
        updateAgentPrimaryAction();
    }
}
function agentCenterOnPoint(x, y){
    // 考虑 Agent 面板宽度，使用可视区域中心
    const agentPanelWidth = agentOpen ? (typeof agentDockWidthPx === 'function' ? agentDockWidthPx() : 380) : 0;
    const visibleCenterX = (shell.clientWidth - agentPanelWidth) / 2;
    viewport.x = visibleCenterX - x * viewport.scale;
    viewport.y = shell.clientHeight / 2 - y * viewport.scale;
    applyViewport();
    scheduleSave();
}
function agentCenterOnNode(node){
    if(!node) return;
    const rect = nodeRect(node);
    agentCenterOnPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
}
function agentFindEmptyPosition(count=1){
    // A+C 方案：计算空白区域 + 右侧追加（水平排列，顶部对齐）
    // 注意：必须包含 pending 状态的占位节点，否则并发生成多张图时占位节点会叠在一起
    const imageNodes = (nodes || []).filter(n => isSmartImageNode(n) && (agentNodeImages(n).some(img => img?.url) || Number(n.pending) > 0));
    const center = viewportCenter();
    if(!imageNodes.length) return {x:center.x, y:center.y};
    // 找到最右边的节点
    let maxX = -Infinity;
    let maxXNode = null;
    imageNodes.forEach(n => {
        const rect = nodeRect(n);
        const right = rect.x + rect.width;
        if(right > maxX){ maxX = right; maxXNode = n; }
    });
    if(!maxXNode) return {x:center.x, y:center.y};
    // 在最右边节点的右侧水平放置新图，顶部对齐，有一点间距
    const rect = nodeRect(maxXNode);
    const gap = 40;
    return {x:rect.x + rect.width + gap + 130, y:rect.y};
}
// Agent 占位节点尺寸：复用主画布的 pendingBoxSize 逻辑，但使用 Agent 自己的比例设置
function agentPendingBoxSize(count, options={}){
    // 用 Agent 的比例设置算出请求尺寸
    const ratioSize = apiImageSize(agentState.genRatio || 'square', agentState.genResolution || '1k') || '1024x1024';
    const parsed = parseSizeValue(ratioSize);
    const requestSize = parsed ? {w:Number(parsed.width) || 1024, h:Number(parsed.height) || 1024} : {w:1024, h:1024};
    // Agent 始终用选中比例计算占位尺寸，不使用参考图尺寸。
    // 因为 Agent 总是发送 size 参数（基于选中比例），占位应与最终生成尺寸一致。
    // 参考图只用于内容编辑，不影响输出尺寸。
    const base = displayBoxFromNaturalSize(requestSize);
    // 多张图时按网格排列（和主画布的 pendingBoxSize 完全一致）
    const c = Math.max(1, Number(count) || 1);
    if(c <= 1) return {w:Math.round(base.w), h:Math.round(base.h)};
    const aspect = base.w / Math.max(1, base.h);
    const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(c))));
    const rows = Math.ceil(c / cols);
    const cellMax = Math.max(96, Math.min(220, Math.max(base.w, base.h) * 0.42));
    let cellW, cellH;
    if(base.w >= base.h){
        cellW = cellMax;
        cellH = Math.max(40 * MEDIA_NODE_DEFAULT_SCALE, Math.round(cellMax / aspect));
    } else {
        cellH = cellMax;
        cellW = Math.max(40 * MEDIA_NODE_DEFAULT_SCALE, Math.round(cellMax * aspect));
    }
    const w = cols * (cellW + 8) + 16;
    const h = rows * (cellH + 8) + 16;
    return {w, h};
}
// 检查是否所有 prompts 都已处理完（无 pending/current/editing），如是则构建 generations 并统一生图
async function _triggerGenerationsIfAllDone(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    // 还有未处理的 prompt，不触发
    if(prompts.some(p => p.status === 'pending' || p.status === 'current' || p.status === 'editing')) return;
    // 收集 confirmed 的 prompts
    const confirmedPrompts = prompts.filter(p => p.status === 'confirmed');
    if(confirmedPrompts.length === 0) return; // 全部跳过，不生图
    // 找到对应的用户消息
    const msgs = agentState.messages || [];
    const msgIdx = msgs.indexOf(assistantMsg);
    let userMsg = null;
    for(let i = msgIdx - 1; i >= 0; i--){
        if(msgs[i].role === 'user'){ userMsg = msgs[i]; break; }
    }
    // 构建 generations（透传 LLM 返回的 count/use_last_outputs/use_attachments）
    // 用赋值而非 push，避免重复调用时 generations 重复追加
    assistantMsg.generations = confirmedPrompts.map(cp => {
        const g = {
            prompt:cp.prompt,
            count:cp.count || 1,
            use_last_outputs:cp.use_last_outputs || false,
            use_attachments:cp.use_attachments || false,
            depends_on_previous:!!(cp.depends_on_previous || cp.use_previous_results),
            dependency_mode: agentNormalizeDependencyMode(cp.dependency_mode, cp.prompt),
            shared_style: String(cp.shared_style || assistantMsg.shared_style || '').trim(),
            plan: cp.plan || assistantMsg.plan || null,
            results:[],
            status:'running'
        };
        if(Array.isArray(cp.attachment_indices)) g.attachment_indices = cp.attachment_indices;
        return g;
    });
    // 统一生图（所有 confirmed prompts 一次性传入，整齐排列）
    await runAgentGenerations(assistantMsg, userMsg);
}
// 推进到下一个 pending prompt，如果全部处理完则触发生图
async function _advanceToNextOrGenerate(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    const nextIdx = prompts.findIndex(p => p.status === 'pending');
    if(nextIdx >= 0){
        prompts[nextIdx].status = 'current';
        assistantMsg.promptIdx = nextIdx;
        renderAgentMessages();
        saveAgentState();
        return;
    }
    // 没有 pending 了 → 全部处理完，触发生图
    assistantMsg.promptIdx = prompts.length;
    renderAgentMessages();
    saveAgentState();
    await _triggerGenerationsIfAllDone(assistantMsg);
}
// 确认当前提示词：标记为 confirmed，推进到下一个 pending，全部处理完才生图
async function confirmAgentPrompt(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    const idx = prompts.findIndex(p => p.status === 'current' || p.status === 'editing');
    if(idx < 0) return;
    prompts[idx].status = 'confirmed';
    await _advanceToNextOrGenerate(assistantMsg);
}
// 修改提示词：进入内联编辑模式（不跳出确认流程，不设置 bypass 标志）
function editAgentPrompt(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    const idx = prompts.findIndex(p => p.status === 'current');
    if(idx < 0) return;
    prompts[idx].status = 'editing';
    assistantMsg.promptIdx = idx;
    renderAgentMessages();
    saveAgentState();
    // 聚焦到 textarea
    const ta = agentMessages?.querySelector('textarea[data-agent-prompt-edit]');
    if(ta){
        ta.focus();
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
}
// 保存内联编辑的提示词：更新文本，标记为 confirmed，推进到下一个
async function saveAgentPromptEdit(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    const idx = prompts.findIndex(p => p.status === 'editing');
    if(idx < 0) return;
    const ta = agentMessages?.querySelector('textarea[data-agent-prompt-edit]');
    const newText = ta ? String(ta.value || '').trim() : '';
    if(!newText){
        toast('提示词不能为空');
        return;
    }
    prompts[idx].prompt = newText;
    prompts[idx].status = 'confirmed';
    await _advanceToNextOrGenerate(assistantMsg);
}
// 取消内联编辑：恢复为 current 状态
function cancelAgentPromptEdit(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    const idx = prompts.findIndex(p => p.status === 'editing');
    if(idx < 0) return;
    prompts[idx].status = 'current';
    renderAgentMessages();
    saveAgentState();
}
// P1-7: 全部确认并生成：将所有未跳过的 prompts 标记为 confirmed，触发生图
async function confirmAllAgentPrompts(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    if(!prompts.length) return;
    // 将所有 pending/current/editing 的标记为 confirmed（保留 skipped）
    prompts.forEach(p => {
        if(p.status !== 'skipped' && p.status !== 'confirmed'){
            p.status = 'confirmed';
        }
    });
    // 清除 current 指针
    assistantMsg.promptIdx = prompts.length;
    renderAgentMessages();
    saveAgentState();
    await _triggerGenerationsIfAllDone(assistantMsg);
}
// P2-15: 全部取消：清除当前 assistant 消息的 prompts，不触发生图
function cancelAllAgentPrompts(assistantMsg){
    assistantMsg.prompts = [];
    delete assistantMsg.promptIdx;
    if(!assistantMsg.text) assistantMsg.text = '已取消全部提示词，请重新输入需求。';
    renderAgentMessages();
    saveAgentState();
}
// P2-13: 已确认/已跳过项反悔：改回 pending 并设为 current
function reopenAgentPrompt(assistantMsg, idx){
    const prompts = assistantMsg.prompts || [];
    if(idx < 0 || idx >= prompts.length) return;
    // 如果有正在编辑的，不允许反悔（避免状态混乱）
    if(prompts.some(p => p.status === 'editing' || p.status === 'current')){
        toast('请先完成当前提示词的确认或修改');
        return;
    }
    prompts[idx].status = 'current';
    assistantMsg.promptIdx = idx;
    renderAgentMessages();
    saveAgentState();
}
// 重新生成当前提示词：只重新生成当前这一条，不影响其他已确认的
async function regenerateAgentPrompts(assistantMsg){
    const prompts = assistantMsg.prompts || [];
    const currentIdx = prompts.findIndex(p => p.status === 'current' || p.status === 'editing');
    if(currentIdx < 0) return;
    const currentPrompt = prompts[currentIdx];
    // 找到对应的原始用户消息
    const ownerConversationId = assistantMsg?.conversationId || agentState?.activeConversationId || '';
    const msgs = agentEnsureConversationMessages(ownerConversationId) || [];
    const msgIdx = msgs.indexOf(assistantMsg);
    let originalUserText = '';
    let userMsg = null;
    for(let i = msgIdx - 1; i >= 0; i--){
        if(msgs[i].role === 'user'){
            originalUserText = msgs[i].text || '';
            userMsg = msgs[i];
            break;
        }
    }
    if(!originalUserText) return;
    const requestedSettings = userMsg?.requestedSettings || {};
    const provider = resolveChatProviderId(requestedSettings.chatProvider || agentState.chatProvider);
    const model = resolveChatModel(requestedSettings.chatModel || agentState.chatModel, provider);
    agentSending = true;
    agentThinking = true;
    agentThinkingConversationId = ownerConversationId;
    renderAgentMessages();
    let regenMessage = originalUserText + AGENT_NL + AGENT_NL + `请重新生成第${currentIdx + 1}条提示词，要求与之前不同。当前第${currentIdx + 1}条是："${currentPrompt.prompt}"。请只返回一条新的提示词。`;
    // 通用保障：重新生成时也注入 skill 强制提醒
    const _regenSkills = Array.isArray(userMsg?.skills) ? agentNormalizeSkillList(userMsg.skills) : [];
    if(_regenSkills.length > 0){
        const skillNames = _regenSkills.map(s => s?.name).filter(Boolean).join('、');
        regenMessage += `${AGENT_NL}${AGENT_NL}【重要提醒】你必须完整遵循 Skill 文档（${skillNames}）的所有描述。重新生成的 prompt 必须逐字保留 Skill 文档的风格、背景、构图、配色、排版等全部细节，只能改变主题/变体方向。不得简化、概括或遗漏。`;
    }
    const historyMsgs = userMsg?.contextEnabled === false
        ? []
        : (Array.isArray(userMsg?.contextHistory)
            ? userMsg.contextHistory.slice()
            : agentFreshTaskHistoryMessages(ownerConversationId, {beforeMessageId:userMsg?.id || '', max:12, maxChars:AGENT_HISTORY_CHAR_MAX}));
    const attachmentCatalog = Array.isArray(userMsg?.images) && userMsg.images.some(item => item?.url)
        ? ['【本轮参考图顺序（仅作为编号数据）】']
            .concat(userMsg.images.filter(item => item?.url).map((item, index) => `参考图${index + 1}：${item.name || item.label || `Image${index + 1}`}`))
            .join(AGENT_NL)
        : '';
    const llmPayload = {
        message: regenMessage,
        messages: historyMsgs,
        images: userMsg?.images ? userMsg.images.map(i => i.url) : [],
        videos: [],
        model,
        provider,
        ms_model: provider === 'modelscope' ? model : '',
        system_prompt: agentSystemPrompt(false, 1, 'plan', {
            conversationId: ownerConversationId,
            skills: userMsg?.skills || [],
            freshTask: true,
            attachmentCatalog,
            historyMessages:historyMsgs,
            canvasSnapshot:userMsg?.canvasSnapshot || null,
            memorySnapshot:userMsg?.memorySnapshot || null,
            contextEnabled:userMsg?.contextEnabled !== false
        })
    };
    try {
        const taskRes = await fetch('/api/plugins/canvas-agent/llm-tasks', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(llmPayload)
        }).then(async r => {
            if(!r.ok) throw new Error(await responseErrorMessage(r, tr('smart.promptLlmFailed')));
            return r.json();
        });
        const result = await pollAgentLlmTask(taskRes.task_id);
        const parsed = parseAgentResponse(result.text || '', originalUserText);
        // 提取新提示词文本和属性
        let newPromptText = '';
        let newCount = currentPrompt.count;
        let newUseLast = currentPrompt.use_last_outputs;
        let newUseAttach = currentPrompt.use_attachments;
        if(parsed.prompts && parsed.prompts.length > 0){
            const first = parsed.prompts[0];
            newPromptText = first.prompt || '';
            if(first.count !== undefined) newCount = first.count;
            if(first.use_last_outputs !== undefined) newUseLast = !!first.use_last_outputs;
            if(first.use_attachments !== undefined) newUseAttach = !!first.use_attachments;
        } else if(parsed.generations && parsed.generations.length > 0){
            const first = parsed.generations[0];
            newPromptText = first.prompt || '';
            if(first.count !== undefined) newCount = first.count;
            if(first.use_last_outputs !== undefined) newUseLast = !!first.use_last_outputs;
            if(first.use_attachments !== undefined) newUseAttach = !!first.use_attachments;
        }
        if(newPromptText.trim()){
            prompts[currentIdx].prompt = newPromptText.trim();
            prompts[currentIdx].count = newCount;
            prompts[currentIdx].use_last_outputs = newUseLast;
            prompts[currentIdx].use_attachments = newUseAttach;
            // 保持 status 为 current（用户继续确认）
        }
        if(parsed.reply) assistantMsg.text = parsed.reply;
    } catch(e) {
        assistantMsg.text = `⚠️ ${String(e.message || e).slice(0, 300)}`;
    } finally {
        agentSending = false;
        agentThinking = false;
        if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
        renderAgentMessages();
        saveAgentState();
    }
}
async function runAgentGenerations(assistantMsg, userMsg){
    // 注意：后面会用赋值形式覆盖此旧实现（计划执行器路径）
    const gens = assistantMsg.generations || [];
    if(!gens.length) return;
    const genProviders = agentGenProviders();
    if(!genProviders.length){
        gens.forEach(g => { g.status = 'error'; g.error = tr('smart.agentNeedGenModel'); });
        toast(tr('smart.agentNeedGenModel'));
        renderAgentMessages();
        saveAgentState();
        return;
    }
    const providerId = genProviders.some(p => p.id === agentState.genProvider) ? agentState.genProvider : genProviders[0].id;
    const models = providerImageModels(providerId);
    const genModel = models.includes(agentState.genModel) ? agentState.genModel : (models[0] || '');
    agentState.genProvider = providerId;
    agentState.genModel = genModel;
    const size = apiImageSize(agentState.genRatio || 'square', agentState.genResolution || '1k') || '1024x1024';
    const lastResults = agentLastResults();
    // 参考图只允许来自本次用户消息的冻结附件快照。
    // 绝不回退到 agentLastUserAttachments()，否则新任务会偷偷继承上一轮图片。
    const attachRefs = (userMsg?.images || []).filter(i => i?.url);
    // 第一步：串行创建所有占位节点（确保位置不重叠、顶部对齐）
    const pendingGens = gens.filter(gen => !(gen.results && gen.results.length) && gen.status !== 'done' && gen.status !== 'error');
    const placeholders = [];
    for(const gen of pendingGens){
        gen.status = 'running';
        const pos = agentFindEmptyPosition(gen.count);
        const placeholderNode = createImageNodeAt(pos, []);
        if(placeholderNode){
            placeholderNode.pending = gen.count;
            placeholderNode.title = gen.prompt?.slice(0, 30) || '生成中...';
            placeholderNode.runStartedAt = nowMs();
            placeholderNode.runTimerHidden = false;
            let refsForBox = [];
            if(Array.isArray(gen.direct_refs) && gen.direct_refs.length > 0){
                refsForBox = gen.direct_refs.filter(r => r?.url);
            } else {
                // no-op: 已禁用默认参考上一轮图
                if(gen.use_attachments && Array.isArray(gen.attachment_indices)){
                    refsForBox = refsForBox.concat(gen.attachment_indices
                        .filter(i => Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < attachRefs.length)
                        .map(i => attachRefs[Number(i)]).filter(Boolean));
                }
            }
            refsForBox = imageRefsOnly(refsForBox).slice(0, providerMaxReferenceImages(providerId));
            const pendingBox = agentPendingBoxSize(gen.count, {refs: refsForBox});
            placeholderNode.w = pendingBox.w;
            placeholderNode.h = pendingBox.h;
            // 顶部对齐 — 找到已有图片节点和已创建的 pending 占位节点的最小顶部 y
            const existingNodes = (nodes || []).filter(n => isSmartImageNode(n) && n.id !== placeholderNode.id && (agentNodeImages(n).some(img => img?.url) || Number(n.pending) > 0));
            if(existingNodes.length){
                let topY = Infinity;
                existingNodes.forEach(n => { const r = nodeRect(n); if(r.y < topY) topY = r.y; });
                placeholderNode.y = topY;
            }
            render();
        }
        placeholders.push({gen, placeholderNode});
    }
    renderAgentMessages();
    // 第二步：并行发起所有生图请求
    await Promise.all(placeholders.map(async ({gen, placeholderNode}) => {
        // 保存占位节点 ID，后续通过 ID 从 nodes 数组重新查找，避免 nodes 被重新赋值后引用悬空
        const placeholderId = placeholderNode?.id || null;
        try {
            let refs = [];
            if(Array.isArray(gen.direct_refs) && gen.direct_refs.length > 0){
                // ★ 统一编号引用：直接使用预解析的参考图 URL
                refs = gen.direct_refs.filter(r => r?.url);
            } else {
                // no-op: 已禁用默认参考上一轮图
                if(gen.use_attachments){
                    // 如果指定了 attachment_indices，只取对应的附件（0-based 索引）
                    if(Array.isArray(gen.attachment_indices) && gen.attachment_indices.length > 0){
                        const filtered = gen.attachment_indices
                            .filter(i => i >= 0 && i < attachRefs.length)
                            .map(i => attachRefs[i])
                            .filter(Boolean);
                        refs = refs.concat(filtered);
                    } else {
                        // No indices means no implicit references. The planner
                        // must explicitly bind every image used by this step.
                    }
                }
            }
            const _agentRefMax = providerMaxReferenceImages(providerId);
            const _allImageRefs = imageRefsOnly(refs);
            if(_allImageRefs.length > _agentRefMax){ toast(`参考图超出上限（最多${_agentRefMax}张），已截取前${_agentRefMax}张`); }
            refs = _allImageRefs.slice(0, _agentRefMax).map(r => ({url:r.url, name:r.name || 'ref'}));
            // ★ 编号翻译层：将 prompt 中的"图N/图一"替换为"第X张参考图"，注入角色说明
            let _finalPrompt = gen.prompt;
            if(Array.isArray(gen.direct_refs) && gen.direct_refs.length > 0){
                // 先做中文数字→阿拉伯转换（与 parseImageRefTasks 一致）
                const _cnMap = {'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10'};
                _finalPrompt = _finalPrompt.replace(/图\s*([一二三四五六七八九十])/g, (m, cn) => `图${_cnMap[cn] || cn}`);
                const _imgMap = agentCurrentImageMap();
                const _roleDescs = [];
                gen.direct_refs.forEach((ref, idx) => {
                    const _entry = _imgMap.find(m => m.url === ref.url);
                    const _origNum = _entry ? _entry.num : null;
                    if(_origNum){
                        const _re = new RegExp('图\\s*' + _origNum + '(?![0-9])', 'g');
                        _finalPrompt = _finalPrompt.replace(_re, `第${idx + 1}张参考图`);
                    }
                    _roleDescs.push(`第${idx + 1}张`);
                });
                // 注入角色说明头（让模型知道参考图数组的顺序含义）
                if(_roleDescs.length > 1){
                    _finalPrompt = `[参考图顺序：${_roleDescs.join('、')}，与下方参考图数组一一对应]\n${_finalPrompt}`;
                }
            }
            const payload = {prompt:_finalPrompt, provider_id:providerId, model:genModel, size, quality:agentState.genQuality || 'auto', n:1, reference_images:refs};
            const tasks = await Promise.all(Array.from({length:gen.count}, () => fetch('/api/canvas-image-tasks', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}).then(async r => {
                if(!r.ok) throw new Error(await responseErrorMessage(r, tr('smart.agentGenFail')));
                return r.json();
            })));
            const imageTaskIds = tasks.map(t => t.task_id).filter(Boolean);
            gen.taskIds = imageTaskIds;
            if(placeholderId) gen.placeholderNodeId = placeholderId;
            saveAgentState();
            const results = await Promise.all(imageTaskIds.map(id => pollSmartCanvasTask(id)));
            // 限制每个 generation 最多只取 gen.count 张图（防止 API 单次返回多张图导致节点图片重复）
            // 同时过滤掉参考图 URL（防止某些 provider 在响应中回显输入的参考图，造成"重复"问题）
            const _maxCount = Math.max(1, Math.min(8, Number(gen.count) || 1));
            const _refUrlSet = new Set((refs || []).map(r => r?.url).filter(Boolean));
            const urls = results.flatMap(res => resultMediaUrls(res)).map((item, i) => {
                const url = typeof item === 'string' ? item : item?.url || '';
                return {url, name:(typeof item === 'object' && item?.name) || `agent-${Date.now()}-${i + 1}.png`, kind:'image'};
            }).filter(i => i.url && !_refUrlSet.has(i.url)).slice(0, _maxCount);
            gen.results = urls;
            gen.status = 'done';
            // 关键：通过 ID 从当前 nodes 数组重新查找节点引用
            // nodes 可能在异步等待期间被重新赋值（如 saveCanvas 409 合并、applyMergedServerCanvas），
            // 导致之前捕获的 placeholderNode 变成悬空引用
            const liveNode = placeholderId ? nodes.find(n => n.id === placeholderId) : null;
            if(urls.length && liveNode){
                undoSuppressed = true;
                agentApplyNodeImages(liveNode, urls);
                liveNode.pending = 0;
                liveNode.title = urls.length > 1 ? 'Group' : 'Image';
                liveNode.runFinishedAt = nowMs();
                liveNode.scale = mediaNodeDefaultScale(liveNode);
                delete liveNode.w;
                delete liveNode.h;
                selectedId = liveNode.id;
                undoSuppressed = false;
                gen.results = gen.results.map((r, i) => ({...r, nodeId: liveNode.id, nodeX: Number(liveNode.x) || 0, nodeY: Number(liveNode.y) || 0}));
            } else if(urls.length && !liveNode){
                // 占位节点已不在 nodes 中（可能被用户删除或被合并操作移除）
                // 创建新节点放置生成结果
                console.warn('[runAgentGenerations] placeholder node not found, creating new node for results');
                const pos = agentFindEmptyPosition(urls.length);
                const newNode = createImageNodeAt(pos, urls.map(u => ({...u})));
                if(newNode){
                    newNode.runFinishedAt = nowMs();
                    newNode.runStartedAt = newNode.runFinishedAt;
                    gen.results = gen.results.map((r, i) => ({...r, nodeId: newNode.id, nodeX: Number(newNode.x) || 0, nodeY: Number(newNode.y) || 0}));
                }
            }
        } catch(e) {
            gen.status = 'error';
            gen.error = String(e.message || e).slice(0, 200);
            const liveNode = placeholderId ? nodes.find(n => n.id === placeholderId) : null;
            if(liveNode){
                undoSuppressed = true;
                nodes = nodes.filter(n => n.id !== placeholderId);
                undoSuppressed = false;
            }
        }
        renderAgentMessages();
        saveAgentState();
        render();
        scheduleSave();
    }));
}
// 恢复中断的 Agent 生图任务（页面刷新后调用）
async function recoverAgentGenerations(){
    if(!agentState?.messages) return;
    const recoveryConversationId = String(agentActiveWorkflow?.conversationId || agentState.activeConversationId || '').trim();
    const msgs = agentEnsureConversationMessages(recoveryConversationId) || [];
    for(let i = msgs.length - 1; i >= 0; i--){
        const msg = msgs[i];
        if(msg.role !== 'assistant') continue;
        const gens = msg.generations || [];
        for(const gen of gens){
            if(gen.status !== 'running' || !gen.taskIds || !gen.taskIds.length) continue;
            // 找到占位节点
            const placeholderNode = gen.placeholderNodeId ? nodes.find(n => n.id === gen.placeholderNodeId) : null;
            if(placeholderNode){
                placeholderNode.runStartedAt = placeholderNode.runStartedAt || nowMs();
                placeholderNode.pending = gen.taskIds.length;
            }
            try {
                const results = await Promise.all(gen.taskIds.map(id => pollSmartCanvasTask(id)));
                // 限制每个 generation 最多只取 gen.count 张图（与 runAgentGenerations 一致，防止 API 单次返回多张图）
                const _maxCount = Math.max(1, Math.min(8, Number(gen.count) || 1));
                const urls = results.flatMap(res => resultMediaUrls(res)).map((item, idx) => {
                    const url = typeof item === 'string' ? item : item?.url || '';
                    return {url, name:(typeof item === 'object' && item?.name) || `agent-${Date.now()}-${idx + 1}.png`, kind:'image'};
                }).filter(i => i.url).slice(0, _maxCount);
                gen.results = urls;
                gen.status = 'done';
                if(urls.length && placeholderNode){
                    undoSuppressed = true;
                    agentApplyNodeImages(placeholderNode, urls);
                    placeholderNode.pending = 0;
                    placeholderNode.title = urls.length > 1 ? 'Group' : 'Image';
                    placeholderNode.runFinishedAt = nowMs();
                    // 修复：删除占位尺寸，让节点根据实际图片自然尺寸重新计算
                    placeholderNode.scale = mediaNodeDefaultScale(placeholderNode);
                    delete placeholderNode.w;
                    delete placeholderNode.h;
                    selectedId = placeholderNode.id;
                    undoSuppressed = false;
                    gen.results = gen.results.map((r, idx) => ({...r, nodeId: placeholderNode.id, nodeX: Number(placeholderNode.x) || 0, nodeY: Number(placeholderNode.y) || 0}));
                }
            } catch(e) {
                gen.status = 'error';
                gen.error = String(e.message || e).slice(0, 200);
                if(placeholderNode){
                    undoSuppressed = true;
                    nodes = nodes.filter(n => n.id !== placeholderNode.id);
                    undoSuppressed = false;
                }
            }
            renderAgentMessages();
            saveAgentState();
            render();
            scheduleSave();
        }
        break; // 只恢复最后一条 assistant 消息的生图
    }
}
function agentCanvasImages(){
    const items = [];
    (nodes || []).forEach(node => {
        if(!isSmartImageNode(node)) return;
        agentNodeImages(node).forEach(img => {
            if(img?.url) items.push({url:img.url, name:img.name || node.title || 'image', nodeId:node.id, nodeTitle:node.title || '', x:Number(node.x) || 0, y:Number(node.y) || 0, ts:Number(node.created_at) || 0});
        });
    });
    return items.sort((a, b) => b.ts - a.ts);
}
function showAgentMention(filter){
    // @ 选图功能已移除
    hideAgentMention();
}
function hideAgentMention(){
    const panel = document.getElementById('agentMentionPanel');
    if(panel) panel.hidden = true;
    agentMentionIdx = -1;
}
function insertAgentMention(url, name, nodeId, x, y){
    // @ 菜单选择：直接确认插入内联图片字符（非灰态）；同一张图允许重复插入
    clearAgentGhostAttachment();
    if(!Array.isArray(agentState.attachments)) agentState.attachments = [];
    const att = {url, name: name || 'canvas-image', nodeId: nodeId || '', x: Number(x) || 0, y: Number(y) || 0};
    if(agentState.attachments.length >= agentAttachmentLimit()){
        if(typeof toast === 'function') toast('参考图数量已达上限');
    }else{
        if(agentIsComposerEl()){
            try{
                const sel = window.getSelection();
                if(sel && sel.rangeCount){
                    const range = sel.getRangeAt(0);
                    const node = range.startContainer;
                    if(node && node.nodeType === Node.TEXT_NODE){
                        const t = node.nodeValue || '';
                        const caret = range.startOffset;
                        const left = t.slice(0, caret);
                        const atIdx = left.lastIndexOf('@');
                        if(atIdx >= 0){
                            node.nodeValue = t.slice(0, atIdx) + t.slice(caret);
                            range.setStart(node, atIdx);
                            range.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                    }
                }
            }catch(_){}
            agentInsertChipAtCaret(att, {ghost:false});
            agentSyncAttachmentsFromComposer();
        }else{
            agentState.attachments.push(att);
        }
        renderAgentAttachments();
    }
    agentFocusComposer();
    hideAgentMention();
    updateAgentPrimaryAction();
    saveAgentState();
}
function agentMentionKeydown(e){
    const panel = document.getElementById('agentMentionPanel');
    if(!panel || panel.hidden) return false;
    const items = panel.querySelectorAll('.agent-mention-item');
    if(!items.length) return false;
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        agentMentionIdx = e.key === 'ArrowDown' ? Math.min(agentMentionIdx + 1, items.length - 1) : Math.max(agentMentionIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === agentMentionIdx));
        items[agentMentionIdx]?.scrollIntoView({block:'nearest'});
        return true;
    }
    if(e.key === 'Enter' && agentMentionIdx >= 0 && items[agentMentionIdx]){
        e.preventDefault();
        const btn = items[agentMentionIdx];
        insertAgentMention(btn.dataset.mentionUrl, btn.dataset.mentionName, btn.dataset.mentionNodeId, btn.dataset.mentionX, btn.dataset.mentionY);
        return true;
    }
    if(e.key === 'Escape'){
        e.preventDefault();
        hideAgentMention();
        return true;
    }
    return false;
}

// ==================== Skill 预设（服务端持久化 + / 调用） ====================

function agentLooksLikeMojibake(text){
    const s = String(text || '');
    if(!s) return false;
    // UTF-8 被按 Latin-1/CP1252 误读后的典型形态：大量西欧字符，几乎没有中文
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const latinHigh = (s.match(/[\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
    const cp1252Marks = (s.match(/[€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g) || []).length;
    if((latinHigh + cp1252Marks) >= 2 && cjk === 0) return true;
    // 也覆盖“中文 + 乱码混杂”的脏缓存
    if((latinHigh + cp1252Marks) >= 3 && (latinHigh + cp1252Marks) > cjk) return true;
    return false;
}
// CP1252 在 0x80-0x9F 的可见字符 → 原始字节值
const AGENT_CP1252_REVERSE = {
    0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,
    0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,
    0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,
    0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F
};
function agentTextToMisdecodedBytes(text){
    const codes = [];
    for(const ch of String(text || '')){
        const code = ch.charCodeAt(0);
        if(code <= 0xFF){
            codes.push(code);
            continue;
        }
        const mapped = AGENT_CP1252_REVERSE[code];
        if(mapped == null) return null;
        codes.push(mapped);
    }
    return codes;
}
function agentRepairMojibakeText(value, depth=0){
    const text = String(value ?? '');
    if(!text || depth > 2) return text;
    if(!agentLooksLikeMojibake(text)) return text;
    try{
        // 兼容 Latin-1 与 CP1252 误读：先还原成原始字节，再按 UTF-8 解码
        const codes = agentTextToMisdecodedBytes(text);
        if(!codes || !codes.length) return text;
        const fixed = new TextDecoder('utf-8', {fatal:false}).decode(Uint8Array.from(codes));
        if(!fixed || fixed === text || /\uFFFD/.test(fixed)) return text;
        // 成功还原后，可能仍是二次乱码，递归再修一次
        return agentLooksLikeMojibake(fixed) ? agentRepairMojibakeText(fixed, depth + 1) : fixed;
    }catch(_){
        return text;
    }
}
function agentNormalizeSkillFields(skill){
    if(!skill || typeof skill !== 'object') return skill;
    const next = {...skill};
    if(next.name != null) next.name = agentRepairMojibakeText(next.name);
    if(next.description != null) next.description = agentRepairMojibakeText(next.description);
    if(next.content != null) next.content = agentRepairMojibakeText(next.content);
    return next;
}
function agentNormalizeSkillList(list){
    if(!Array.isArray(list)) return [];
    return list.map(item => agentNormalizeSkillFields(item)).filter(Boolean);
}

function agentSkillErrorMessage(err, fallback){
    if(!err) return fallback || '操作失败';
    const detail = err.detail;
    if(typeof detail === 'string' && detail.trim()) return detail;
    if(Array.isArray(detail)){
        const joined = detail.map(item => item?.msg || item?.detail || String(item)).filter(Boolean).join('；');
        if(joined) return joined;
    }
    if(err.message) return err.message;
    return fallback || '操作失败';
}
async function agentSkillApi(path = '', options = {}){
    const opts = {...options};
    const headers = Object.assign({'Content-Type': 'application/json'}, opts.headers || {});
    if(opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    const response = await fetch(`${AGENT_SKILL_API}${path || ''}`, {...opts, headers});
    let data = null;
    try{ data = await response.json(); }catch(_){ data = null; }
    if(!response.ok){
        const error = new Error(agentSkillErrorMessage(data, `请求失败 (${response.status})`));
        error.detail = data?.detail;
        error.status = response.status;
        throw error;
    }
    return data;
}
async function loadAgentSkillPresets(force){
    if(agentSkillPresetsLoaded && !force) return agentSkillPresets;
    try{
        const data = await agentSkillApi('');
        agentSkillPresets = agentNormalizeSkillList(Array.isArray(data?.skills) ? data.skills : []);
        agentSkillPresetsLoaded = true;
    }catch(err){
        agentSkillPresets = [];
        agentSkillPresetsLoaded = false;
        if(force && typeof toast === 'function') toast(agentSkillErrorMessage(err, '加载 Skill 预设失败'));
    }
    return agentSkillPresets;
}
function resetAgentSkillEditor(seed){
    agentSkillEditingId = seed?.id || '';
    const nameEl = document.getElementById('agentSkillName');
    const descEl = document.getElementById('agentSkillDescription');
    const contentEl = document.getElementById('agentSkillContent');
    if(nameEl) nameEl.value = seed?.name || '';
    if(descEl) descEl.value = seed?.description || '';
    if(contentEl) contentEl.value = seed?.content || '';
    const saveBtn = document.getElementById('agentSkillSave');
    if(saveBtn) saveBtn.textContent = agentSkillEditingId ? '更新 Skill' : '保存 Skill';
}
function renderAgentSkillPresetList(){
    const list = document.getElementById('agentSkillPresetList');
    if(!list) return;
    if(!agentSkillPresets.length){
        list.innerHTML = '<div class="agent-skill-preset-empty">还没有 Skill 预设<br>保存后可在输入框输入 / 快速调用</div>';
        return;
    }
    list.innerHTML = agentNormalizeSkillList(agentSkillPresets).map(skill => {
        const used = Number(skill.usage_count || 0);
        const desc = skill.description || (skill.content || '').slice(0, 60);
        return `<div class="agent-skill-preset-item" role="listitem" data-skill-id="${escapeHtml(skill.id)}">
            <button class="agent-skill-preset-main" type="button" data-skill-apply="${escapeHtml(skill.id)}" title="应用到当前对话" aria-label="应用 Skill：${escapeHtml(skill.name || '未命名')}">
                <div class="agent-skill-preset-name">${escapeHtml(skill.name || '未命名')}</div>
                <div class="agent-skill-preset-desc">${escapeHtml(desc || '无说明')}${used ? ` · 已用 ${used} 次` : ''}</div>
            </button>
            <div class="agent-skill-preset-actions">
                <button type="button" data-skill-view="${escapeHtml(skill.id)}" title="放大查看" aria-label="放大查看 ${escapeHtml(skill.name || '未命名')}"><i data-lucide="maximize-2" aria-hidden="true"></i></button>
                <button type="button" data-skill-edit="${escapeHtml(skill.id)}" title="编辑" aria-label="编辑 ${escapeHtml(skill.name || '未命名')}"><i data-lucide="pencil" aria-hidden="true"></i></button>
                <button type="button" data-skill-delete="${escapeHtml(skill.id)}" title="删除" aria-label="删除 ${escapeHtml(skill.name || '未命名')}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
            </div>
        </div>`;
    }).join('');
    if(window.lucide) lucide.createIcons();
    list.querySelectorAll('[data-skill-apply]').forEach(el => {
        el.onclick = () => {
            const skill = agentSkillPresets.find(item => item.id === el.dataset.skillApply);
            if(skill) applyAgentSkillPreset(skill, {stripSlash:false, closeManager:true});
        };
    });
    list.querySelectorAll('[data-skill-edit]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const skill = agentSkillPresets.find(item => item.id === btn.dataset.skillEdit);
            if(skill) resetAgentSkillEditor(skill);
        };
    });
    list.querySelectorAll('[data-skill-view]').forEach(btn => {
        btn.onclick = e => {
            e.stopPropagation();
            const skill = agentSkillPresets.find(item => item.id === btn.dataset.skillView);
            if(skill) agentOpenSkillLightbox(skill, e.currentTarget);
        };
    });
    list.querySelectorAll('[data-skill-delete]').forEach(btn => {
        btn.onclick = async e => {
            e.stopPropagation();
            const skill = agentSkillPresets.find(item => item.id === btn.dataset.skillDelete);
            if(!skill) return;
            if(!confirm(`删除 Skill「${skill.name}」？此操作不可撤销。`)) return;
            try{
                await agentSkillApi(`/${encodeURIComponent(skill.id)}`, {method:'DELETE'});
                if(agentSkillEditingId === skill.id) resetAgentSkillEditor();
                await loadAgentSkillPresets(true);
                renderAgentSkillPresetList();
                if(typeof toast === 'function') toast(`已删除：${skill.name}`);
            }catch(err){
                if(typeof toast === 'function') toast(agentSkillErrorMessage(err, '删除失败'));
            }
        };
    });
}
function syncAgentSkillManagerBtnState(){
    const manager = document.getElementById('agentSkillManager');
    const btn = document.getElementById('agentSkillManagerBtn');
    if(!btn) return;
    const open = !!(manager && !manager.hidden);
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? '收起 Skill 预设' : '展开 Skill 预设');
    btn.title = open ? '收起 Skill 预设' : 'Skill 预设';
}
async function openAgentSkillManager(seed){
    const manager = document.getElementById('agentSkillManager');
    if(!manager) return;
    const chatList = document.getElementById('agentChatListPanel');
    if(chatList) chatList.hidden = true;
    const morePanel = document.getElementById('agentMorePanel');
    if(morePanel) morePanel.hidden = true;
    manager.hidden = false;
    manager._agentReturnFocus = (typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement)
        ? document.activeElement
        : document.getElementById('agentSkillManagerBtn');
    // 面板先于异步预设加载显示，按钮状态也必须在同一帧同步，避免短暂误报为“未展开”。
    syncAgentSkillManagerBtnState();
    resetAgentSkillEditor(seed || null);
    document.getElementById('agentSkillName')?.focus();
    requestAnimationFrame(() => {
        if(!manager.hidden) document.getElementById('agentSkillName')?.focus();
    });
    await loadAgentSkillPresets(true);
    renderAgentSkillPresetList();
    syncAgentSkillManagerBtnState();
    if(window.lucide) lucide.createIcons();
}
function closeAgentSkillManager({restoreFocus=true}={}){
    const manager = document.getElementById('agentSkillManager');
    const returnFocus = manager?._agentReturnFocus || document.getElementById('agentSkillManagerBtn');
    if(manager) manager.hidden = true;
    resetAgentSkillEditor();
    syncAgentSkillManagerBtnState();
    if(restoreFocus) requestAnimationFrame(() => { try{ returnFocus?.focus?.(); }catch(_){ } });
}
async function toggleAgentSkillManager(seed){
    const manager = document.getElementById('agentSkillManager');
    if(manager && !manager.hidden && !seed){
        closeAgentSkillManager();
        return;
    }
    await openAgentSkillManager(seed);
}
async function saveAgentSkillFromEditor(){
    const name = String(document.getElementById('agentSkillName')?.value || '').trim();
    const description = String(document.getElementById('agentSkillDescription')?.value || '').trim();
    const content = String(document.getElementById('agentSkillContent')?.value || '').trim();
    if(!name){ if(typeof toast === 'function') toast('请填写 Skill 名称'); return; }
    if(!content){ if(typeof toast === 'function') toast('请填写 Skill 内容'); return; }
    const payload = {name, description, content};
    try{
        if(agentSkillEditingId){
            await agentSkillApi(`/${encodeURIComponent(agentSkillEditingId)}`, {method:'PUT', body:payload});
            if(typeof toast === 'function') toast(`已更新：${name}`);
        }else{
            await agentSkillApi('', {method:'POST', body:payload});
            if(typeof toast === 'function') toast(`已保存：${name}`);
        }
        resetAgentSkillEditor();
        await loadAgentSkillPresets(true);
        renderAgentSkillPresetList();
    }catch(err){
        if(typeof toast === 'function') toast(agentSkillErrorMessage(err, '保存失败'));
    }
}
function applyAgentSkillPreset(skill, opts = {}){
    if(!agentState || !skill) return false;
    skill = agentNormalizeSkillFields(skill) || skill;
    const name = String(skill.name || '').trim() || 'skill';
    const content = String(skill.content || '');
    const presetId = String(skill.id || skill.presetId || '');
    if(!content.trim()){
        if(typeof toast === 'function') toast('该 Skill 内容为空');
        return false;
    }
    if(!Array.isArray(agentState.skills)) agentState.skills = [];
    // params UI removed: always default genCount=1
    agentState.genCount = 1;
    const existingIdx = agentState.skills.findIndex(item => {
        if(presetId && (item.presetId === presetId || item.id === presetId)) return true;
        return String(item.name || '').toLowerCase() === name.toLowerCase() && String(item.content || '') === content;
    });
    const next = {name, content};
    if(presetId) next.presetId = presetId;
    if(existingIdx >= 0) agentState.skills[existingIdx] = next;
    else agentState.skills.push(next);

    if(opts.stripSlash !== false && agentInput){
        if(agentIsComposerEl()){
            try{
                const sel = window.getSelection();
                if(sel && sel.rangeCount){
                    const range = sel.getRangeAt(0);
                    const node = range.startContainer;
                    if(node && node.nodeType === Node.TEXT_NODE){
                        const t = node.nodeValue || '';
                        const caret = range.startOffset;
                        const left = t.slice(0, caret);
                        const slashIdx = left.lastIndexOf('/');
                        if(slashIdx >= 0){
                            node.nodeValue = t.slice(0, slashIdx) + t.slice(caret);
                            range.setStart(node, slashIdx);
                            range.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(range);
                            agentComposerCaret = range.cloneRange();
                        }
                    }
                }
            }catch(_){}
            agentFocusComposer();
        }else{
            const val = agentInput.value;
            const cursorPos = agentInput.selectionStart ?? val.length;
            const before = val.slice(0, cursorPos);
            const slashIdx = before.lastIndexOf('/');
            if(slashIdx >= 0){
                agentInput.value = val.slice(0, slashIdx) + val.slice(cursorPos);
                const pos = slashIdx;
                try{ agentInput.setSelectionRange(pos, pos); }catch(_){}
            }
            agentInput.focus();
        }
    }
    hideAgentSkillSlash();
    if(opts.closeManager) closeAgentSkillManager();
    renderAgentAttachments();
    saveAgentState();
    updateAgentPrimaryAction();
    if(presetId){
        agentSkillApi(`/${encodeURIComponent(presetId)}/use`, {method:'POST'}).then(() => {
            const item = agentSkillPresets.find(s => s.id === presetId);
            if(item){
                item.usage_count = Number(item.usage_count || 0) + 1;
                item.last_used_at = Date.now();
                agentSkillPresets.sort((a, b) => Number(b.last_used_at || 0) - Number(a.last_used_at || 0));
                if(!document.getElementById('agentSkillManager')?.hidden) renderAgentSkillPresetList();
            }
        }).catch(() => {});
    }
    if(typeof toast === 'function') toast(`已附加 Skill：${name}`);
    return true;
}
async function showAgentSkillSlash(filter){
    const panel = document.getElementById('agentSkillSlashPanel');
    if(!panel) return;
    await loadAgentSkillPresets(false);
    const q = String(filter || '').toLowerCase();
    const sourceSkills = agentNormalizeSkillList(agentSkillPresets);
    const filtered = q
        ? sourceSkills.filter(skill => {
            const hay = `${skill.name || ''} ${skill.description || ''}`.toLowerCase();
            return hay.includes(q);
        })
        : sourceSkills.slice();
    if(!filtered.length){
        panel.innerHTML = agentSkillPresets.length
            ? `<div class="agent-mention-empty">没有匹配的 Skill</div>`
            : `<div class="agent-mention-empty">还没有 Skill 预设<br>点右上角 ⋯ → Skill 预设 添加</div>`;
        panel.hidden = false;
        panel.removeAttribute('aria-activedescendant');
        agentInput?.setAttribute('aria-controls', 'agentSkillSlashPanel');
        agentInput?.setAttribute('aria-expanded', 'true');
        agentInput?.removeAttribute('aria-activedescendant');
        agentSkillSlashIdx = -1;
        return;
    }
    agentSkillSlashIdx = 0;
    panel.innerHTML = filtered.slice(0, 20).map((skill, i) => {
        const desc = skill.description || (skill.content || '').replace(/\s+/g, ' ').slice(0, 48);
        return `<button id="agentSkillSlashOption${i}" class="agent-mention-item${i === 0 ? ' active' : ''}" type="button" role="option" aria-selected="${i === 0 ? 'true' : 'false'}" data-skill-slash-id="${escapeHtml(skill.id)}"><div class="agent-skill-slash-icon" aria-hidden="true">/</div><div class="agent-mention-item-info"><div class="agent-mention-item-name">${escapeHtml(skill.name || '未命名')}</div><div class="agent-skill-slash-meta">${escapeHtml(desc || '无说明')}</div></div></button>`;
    }).join('');
    panel.hidden = false;
    panel.setAttribute('aria-activedescendant', 'agentSkillSlashOption0');
    agentInput?.setAttribute('aria-controls', 'agentSkillSlashPanel');
    agentInput?.setAttribute('aria-expanded', 'true');
    agentInput?.setAttribute('aria-activedescendant', 'agentSkillSlashOption0');
    panel.querySelectorAll('.agent-mention-item').forEach(btn => {
        btn.onclick = e => {
            e.preventDefault();
            const skill = agentSkillPresets.find(item => item.id === btn.dataset.skillSlashId);
            if(skill) applyAgentSkillPreset(skill, {stripSlash:true});
        };
    });
}
function hideAgentSkillSlash(){
    const panel = document.getElementById('agentSkillSlashPanel');
    if(panel){
        panel.hidden = true;
        panel.removeAttribute('aria-activedescendant');
    }
    agentInput?.setAttribute('aria-expanded', 'false');
    agentInput?.removeAttribute('aria-controls');
    agentInput?.removeAttribute('aria-activedescendant');
    agentSkillSlashIdx = -1;
}
function agentSkillSlashKeydown(e){
    const panel = document.getElementById('agentSkillSlashPanel');
    if(!panel || panel.hidden) return false;
    const items = panel.querySelectorAll('.agent-mention-item');
    if(!items.length){
        if(e.key === 'Escape'){ e.preventDefault(); hideAgentSkillSlash(); return true; }
        return false;
    }
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        agentSkillSlashIdx = e.key === 'ArrowDown'
            ? Math.min(agentSkillSlashIdx + 1, items.length - 1)
            : Math.max(agentSkillSlashIdx - 1, 0);
        items.forEach((el, i) => {
            const active = i === agentSkillSlashIdx;
            el.classList.toggle('active', active);
            el.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const activeId = items[agentSkillSlashIdx]?.id || '';
        if(activeId){
            panel.setAttribute('aria-activedescendant', activeId);
            agentInput?.setAttribute('aria-activedescendant', activeId);
        }
        items[agentSkillSlashIdx]?.scrollIntoView({block:'nearest'});
        return true;
    }
    if(e.key === 'Enter' && agentSkillSlashIdx >= 0 && items[agentSkillSlashIdx]){
        e.preventDefault();
        const btn = items[agentSkillSlashIdx];
        const skill = agentSkillPresets.find(item => item.id === btn.dataset.skillSlashId);
        if(skill) applyAgentSkillPreset(skill, {stripSlash:true});
        return true;
    }
    if(e.key === 'Escape'){
        e.preventDefault();
        hideAgentSkillSlash();
        return true;
    }
    return false;
}
function updateAgentComposerMenus(){
    if(!agentInput){
        hideAgentMention();
        hideAgentSkillSlash();
        return;
    }
    // @ 选图已移除，仅保留 / Skill 菜单
    hideAgentMention();
    const {before: beforeCursor} = agentComposerBeforeCaretText();
    const slashIdx = beforeCursor.lastIndexOf('/');
    if(slashIdx < 0){
        hideAgentSkillSlash();
        return;
    }
    const prev = slashIdx > 0 ? beforeCursor[slashIdx - 1] : ' ';
    if(slashIdx > 0 && !/\s/.test(prev)){
        hideAgentSkillSlash();
        return;
    }
    const filter = beforeCursor.slice(slashIdx + 1);
    if(/\s/.test(filter)){
        hideAgentSkillSlash();
        return;
    }
    showAgentSkillSlash(filter);
}
function initAgentSkillUi(){
    document.getElementById('agentSkillManagerBtn')?.addEventListener('click', e => {
        e.stopPropagation();
        const morePanel = document.getElementById('agentMorePanel');
        if(morePanel) morePanel.hidden = true;
        toggleAgentSkillManager();
    });
    document.getElementById('agentSkillManagerClose')?.addEventListener('click', () => closeAgentSkillManager());
    document.getElementById('agentSkillCancelEdit')?.addEventListener('click', () => resetAgentSkillEditor());
    document.getElementById('agentSkillSave')?.addEventListener('click', () => saveAgentSkillFromEditor());
    const manager = document.getElementById('agentSkillManager');
    if(manager && manager.dataset.boundKeyboard !== '1'){
        manager.dataset.boundKeyboard = '1';
        manager.addEventListener('keydown', event => {
            if(event.key === 'Escape'){
                event.preventDefault();
                closeAgentSkillManager();
                return;
            }
            if(event.key !== 'Tab') return;
            const focusable = [...manager.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                .filter(el => !el.hidden && el.getClientRects().length);
            if(!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
            else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
        });
    }
    syncAgentSkillManagerBtnState();
    loadAgentSkillPresets(false).then(() => {
        if(!(agentState?.messages || []).length) renderAgentMessages();
    }).catch(() => {});
}

function agentAutoResizeInput(){
    const el = document.getElementById('agentInput');
    if(!el) return;
    // contenteditable 内容驱动高度：先塌缩，再按实际内容向上长
    const minH = 56;
    const maxH = Math.max(160, Math.min(280, Math.floor(window.innerHeight * 0.34)));
    el.style.overflowY = 'hidden';
    el.style.height = 'auto';
    void el.offsetHeight;
    const contentH = Math.max(minH, Number(el.scrollHeight) || minH);
    const newH = Math.min(contentH, maxH);
    el.style.height = newH + 'px';
    el.style.overflowY = contentH > maxH ? 'auto' : 'hidden';
    if(agentState) agentState.inputHeight = newH;
    try{
        const handle = document.getElementById('agentInputResize');
        if(handle){
            handle.setAttribute('aria-valuemax', String(maxH));
            handle.setAttribute('aria-valuenow', String(Math.round(newH)));
            handle.setAttribute('aria-valuetext', `${Math.round(newH)} 像素`);
        }
    }catch(_){ }
    try{
        const box = document.querySelector('.agent-onebox');
        if(box) box.classList.toggle('is-expanded', newH > minH + 8);
    }catch(_){ }
}
function initAgentInputResize(){
    const handle = document.getElementById('agentInputResize');
    const textarea = document.getElementById('agentInput');
    if(!handle || !textarea) return;
    if(agentState?.inputHeight > 0) textarea.style.height = agentState.inputHeight + 'px';
    // 根据文字自动拉高
    textarea.addEventListener('input', agentAutoResizeInput);
    // 图片字符插入/删除时也向上增高
    try{
        if(!textarea.__agentComposerMutationObserver){
            const mo = new MutationObserver(() => {
                if(agentComposerSyncing) return;
                agentAutoResizeInput();
            });
            if(textarea && textarea.nodeType === 1){
                mo.observe(textarea, {childList:true, subtree:true, characterData:true});
            }
            textarea.__agentComposerMutationObserver = mo;
        }
    }catch(_){ }
    let startY = 0, startH = 0;
    const inputMaxHeight = () => Math.max(160, Math.min(280, Math.floor(window.innerHeight * 0.34)));
    const syncInputAria = () => {
        const height = Math.round(textarea.offsetHeight || 56);
        handle.setAttribute('aria-valuemax', String(inputMaxHeight()));
        handle.setAttribute('aria-valuenow', String(height));
        handle.setAttribute('aria-valuetext', `${height} 像素`);
    };
    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        startY = e.clientY;
        startH = textarea.offsetHeight;
        handle.classList.add('dragging');
        const onMove = ev => {
            const delta = startY - ev.clientY;
            const newH = Math.max(56, Math.min(startH + delta, inputMaxHeight()));
            textarea.style.height = newH + 'px';
            syncInputAria();
        };
        const onUp = () => {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if(agentState){
                agentState.inputHeight = textarea.offsetHeight;
                saveAgentState();
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('keydown', e => {
        const step = e.shiftKey ? 32 : 16;
        let next = textarea.offsetHeight || 56;
        if(e.key === 'ArrowUp') next += step;
        else if(e.key === 'ArrowDown') next -= step;
        else if(e.key === 'Home') next = 56;
        else if(e.key === 'End') next = inputMaxHeight();
        else return;
        e.preventDefault();
        textarea.style.height = Math.max(56, Math.min(inputMaxHeight(), next)) + 'px';
        if(agentState) agentState.inputHeight = textarea.offsetHeight;
        syncInputAria();
        saveAgentState();
    });
    syncInputAria();
}
function initAgentPanel(){
    if(!agentPanel) return;
    try{ agentInitDockResizer(); }catch(_){ }
    try{ agentSyncDockLayout(); }catch(_){ }
    try{ if(window.lucide) lucide.createIcons(); }catch(_){ }
    // 画布会在祖先节点监听拖拽、平移和快捷键；面板内交互必须与其隔离，
    // 但不能 preventDefault，否则 textarea/select 无法获得焦点或输入。
    ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup'].forEach(type => {
        agentPanel.addEventListener(type, event => event.stopPropagation());
    });
    agentPanel.addEventListener('wheel', event => event.stopPropagation(), {passive:true});
    // 提前绑定发送按钮事件，确保即使后续初始化出错发送按钮也能用
    agentSendBtn?.addEventListener('click', () => sendAgentMessage());
    // 刷新/关闭页面前强制落盘，避免防抖未触发导致普通画布对话丢失
    try{
        window.addEventListener('pagehide', agentFlushStateForUnload);
        window.addEventListener('beforeunload', agentFlushStateForUnload);
        document.addEventListener('visibilitychange', () => {
            if(document.visibilityState === 'hidden') agentFlushStateForUnload();
        });
    }catch(_){}
    loadAgentState();
    agentSetInputMode(agentState?.inputMode || 'agent', {persist:false});
    // 如果没有恢复中的任务，确保 agentSending 重置为 false
    if(!_agentRecoveryInProgress) agentSending = false;
    try{ agentSyncDockLayout(); }catch(_){ }

    try{
        if(!window.__canvasAgentDockResizeBound){
            window.__canvasAgentDockResizeBound = true;
            let inputResizeFrame = 0;
            window.addEventListener('resize', () => {
                try{ agentSyncDockLayout(); }catch(_){ }
                try{
                    if(inputResizeFrame) cancelAnimationFrame(inputResizeFrame);
                    inputResizeFrame = requestAnimationFrame(() => {
                        inputResizeFrame = 0;
                        agentAutoResizeInput();
                    });
                }catch(_){ }
            });
        }
    }catch(_){ }
    agentMoveSelectsToDropdown();
    renderAgentModelSelectors(true);
    try{ agentWatchProvidersForModelRestore(); }catch(_){ }
    renderAgentAttachments();
    renderAgentMessages();
    initAgentInputResize();
    initAgentSkillUi();
    // 后端状态异步回填：首屏仍可由轻量本地缓存立即打开，随后恢复完整历史。
    // 只接受时间戳更新的远端快照，避免覆盖用户刚刚在当前页输入的新内容。
    queueMicrotask(() => { agentHydrateStateFromBackend(); });
    agentInputModeSwitch?.querySelectorAll('[data-agent-input-mode]').forEach(btn => {
        btn.addEventListener('click', () => agentSetInputMode(btn.dataset.agentInputMode || 'agent'));
    });

    try{
        const runModeBtn = document.getElementById('agentRunModeBtn');
        if(runModeBtn && !runModeBtn.dataset.boundRunMode){
            runModeBtn.dataset.boundRunMode = '1';
            runModeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                agentToggleRunMode();
            });
        }
        agentSetRunMode(agentState?.runMode || 'auto', {persist:false, silent:true});
    }catch(_){ }

    // 下拉面板交互
    const modelBtn = document.getElementById('agentModelBtn');
    const modelPanel = document.getElementById('agentModelPanel');
    const paramsBtn = document.getElementById('agentParamsBtn');
    const paramsPanel = document.getElementById('agentParamsPanel');
    function closeAllDropdowns(){
        if(modelPanel) modelPanel.hidden = true;
        modelBtn?.setAttribute('aria-expanded', 'false');
        if(paramsPanel) paramsPanel.hidden = true;
        const chatModelPanel = document.getElementById('agentChatModelPanel');
        if(chatModelPanel) chatModelPanel.hidden = true;
    }
    function showDropdown(btn, panel, opts){
        if(!btn || !panel) return;
        // 把面板移到 document.body 中，避免被 Agent 面板的 backdrop-filter 遮挡
        if(panel.parentElement !== document.body) document.body.appendChild(panel);
        const rect = btn.getBoundingClientRect();
        // 先显示面板以测量尺寸
        panel.style.visibility = 'hidden';
        panel.hidden = false;
        const panelHeight = panel.offsetHeight;
        const panelWidth = panel.offsetWidth;
        panel.style.visibility = '';
        // 水平位置
        const alignRight = opts && opts.alignRight;
        if(alignRight){
            // 右对齐：面板右边缘对齐按钮右边缘，向左展开
            const rightEdge = window.innerWidth - rect.right;
            panel.style.right = Math.max(8, rightEdge) + 'px';
            panel.style.left = 'auto';
        } else {
            // 默认左对齐：确保面板不会超出屏幕右边界
            const maxLeft = window.innerWidth - panelWidth - 8;
            panel.style.left = Math.min(Math.max(8, rect.left), Math.max(8, maxLeft)) + 'px';
            panel.style.right = 'auto';
        }
        // 垂直位置：优先在按钮上方显示，如果空间不够则在下方显示
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        if(spaceAbove >= panelHeight + 8 || spaceAbove >= spaceBelow){
            panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
            panel.style.top = 'auto';
        } else {
            panel.style.top = (rect.bottom + 6) + 'px';
            panel.style.bottom = 'auto';
        }
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
    }
    window.__agentShowDropdown = showDropdown;
    modelBtn?.addEventListener('click', e => {
        e.stopPropagation();
        const wasHidden = modelPanel?.hidden;
        closeAllDropdowns();
        if(wasHidden){
            // 打开时只刷新显示，不强制改回默认，方便用户改完再点“设为默认”
            try{ renderAgentModelSelectors(false); }catch(_){ }
            try{ agentUpdateModelDefaultHint(); }catch(_){ }
            showDropdown(modelBtn, modelPanel);
            const firstControl = modelPanel?.querySelector('select:not([disabled]), button:not([disabled]), input:not([disabled])');
            firstControl?.focus?.();
            requestAnimationFrame(() => {
                if(modelPanel && !modelPanel.hidden && !modelPanel.contains(document.activeElement)) firstControl?.focus?.();
            });
        }
    });
    if(modelPanel && modelPanel.dataset.boundFocusLoop !== '1'){
        modelPanel.dataset.boundFocusLoop = '1';
        modelPanel.addEventListener('keydown', event => {
            if(event.key !== 'Tab' || modelPanel.hidden) return;
            const focusable = [...modelPanel.querySelectorAll('select:not([disabled]), button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                .filter(el => !el.hidden && el.getClientRects().length);
            if(!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
            else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
        });
    }
    // 参数选择 UI 已删除，残留节点仅隐藏
    if(paramsBtn) paramsBtn.hidden = true;
    if(paramsPanel) paramsPanel.hidden = true;
    const chatModelPanel = document.getElementById('agentChatModelPanel');
    document.addEventListener('pointerdown', e => {
        if(!e.target.closest('.agent-toolbar-dropdown-wrap') && !e.target.closest('.agent-dropdown-panel')) closeAllDropdowns();
    }, true);
    document.addEventListener('keydown', e => {
        if(e.key !== 'Escape' || !modelPanel || modelPanel.hidden) return;
        e.preventDefault();
        closeAllDropdowns();
        modelBtn?.focus?.();
    }, true);
    agentToggle?.addEventListener('click', () => toggleAgentPanel());
    const bindAgentClose = () => {
        const btn = document.getElementById('agentCloseBtn') || agentCloseBtn;
        if(!btn || btn.dataset.boundClose === '1') return;
        btn.dataset.boundClose = '1';
        btn.addEventListener('click', () => toggleAgentPanel(false));
    };
    bindAgentClose();
    document.getElementById('agentNewChatBtn')?.addEventListener('click', () => agentNewChat());
    document.getElementById('agentDeleteChatBtn')?.addEventListener('click', () => agentDeleteChat());
    document.getElementById('agentChatListBtn')?.addEventListener('click', e => {
        e.stopPropagation();
        const panel = document.getElementById('agentChatListPanel');
        if(!panel) return;
        const wasHidden = panel.hidden;
        if(wasHidden) renderAgentChatList();
        panel.hidden = !wasHidden;
    });
    // 更多操作菜单（折叠新建/对话列表/删除）
    const moreBtn = document.getElementById('agentMoreBtn');
    const morePanel = document.getElementById('agentMorePanel');
    moreBtn?.addEventListener('click', e => {
        e.stopPropagation();
        if(morePanel) morePanel.hidden = !morePanel.hidden;
    });
    document.addEventListener('pointerdown', e => {
        if(morePanel && !morePanel.hidden && !e.target.closest('#agentMorePanel') && !e.target.closest('#agentMoreBtn')){
            morePanel.hidden = true;
        }
    }, true);
    document.addEventListener('pointerdown', e => {
        const panel = document.getElementById('agentChatListPanel');
        if(panel && !panel.hidden && !e.target.closest('#agentChatListPanel') && !e.target.closest('#agentChatListBtn')){
            panel.hidden = true;
        }
    }, true);
    agentChatProvider?.addEventListener('change', () => {
        agentState.chatProvider = agentChatProvider.value;
        agentState.chatModel = '';
        _agentModelSelectorSig = '';
        renderAgentModelSelectors(true);
        try{ agentUpdateModelDefaultHint(); }catch(_){ }
        saveAgentState();
    });
    agentChatModel?.addEventListener('change', () => {
        agentState.chatModel = agentChatModel.value;
        _agentModelSelectorSig = '';
        agentUpdateToolbarLabels();
        try{ agentUpdateModelDefaultHint(); }catch(_){ }
        saveAgentState();
    });
    agentGenProvider?.addEventListener('change', () => {
        agentState.genProvider = agentGenProvider.value;
        agentState.genModel = '';
        _agentModelSelectorSig = '';
        renderAgentModelSelectors(true);
        try{ agentUpdateModelDefaultHint(); }catch(_){ }
        saveAgentState();
    });
    agentGenModel?.addEventListener('change', () => {
        agentState.genModel = agentGenModel.value;
        _agentModelSelectorSig = '';
        agentUpdateToolbarLabels();
        try{ agentUpdateModelDefaultHint(); }catch(_){ }
        saveAgentState();
    });
    document.getElementById('agentSaveModelDefaultsBtn')?.addEventListener('click', () => {
        // 只把“当前下拉选项”记为下次打开的默认；不改当前选择、不回退模型
        const saved = agentRememberCurrentModelsAsDefaults();
        agentUpdateModelDefaultHint();
        // 同步写入当前画布状态，但不重新套用默认、不重绘选择器（避免视觉回跳）
        saveAgentState(true);
        if(typeof toast === 'function'){
            const chat = saved?.chatModel || saved?.chatProvider || '';
            const gen = saved?.genModel || saved?.genProvider || '';
            toast(chat || gen ? `已设为下次默认：理解 ${chat || '未设'} · 生图 ${gen || '未设'}` : '已设为下次默认');
        }
    });
    // 参数面板交互
    document.getElementById('agentRatioGrid')?.addEventListener('click', e => {
        const btn = e.target.closest('.agent-ratio-btn');
        if(!btn || !agentState) return;
        agentState.genRatio = btn.dataset.ratio || 'square';
        agentSyncParamsPanel();
        agentUpdateToolbarLabels();
        saveAgentState();
    });
    document.getElementById('agentResGrid')?.addEventListener('click', e => {
        const btn = e.target.closest('.agent-res-btn');
        if(!btn || !agentState) return;
        agentState.genResolution = btn.dataset.res || '1k';
        agentSyncParamsPanel();
        agentUpdateToolbarLabels();
        saveAgentState();
    });
    document.getElementById('agentCountGrid')?.addEventListener('click', e => {
        const btn = e.target.closest('.agent-count-btn');
        if(!btn || !agentState) return;
        agentState.genCount = Number(btn.dataset.count) || 1;
        agentSyncParamsPanel();
        agentUpdateToolbarLabels();
        saveAgentState();
    });
    document.getElementById('agentQualitySeg')?.addEventListener('click', e => {
        const btn = e.target.closest('.agent-quality-btn');
        if(!btn || !agentState) return;
        agentState.genQuality = btn.dataset.quality || '';
        agentSyncParamsPanel();
        agentUpdateToolbarLabels();
        saveAgentState();
    });
    agentAttachBtn?.addEventListener('click', () => agentImageInput?.click());
agentImageInput?.addEventListener('change', () => {
agentAttachFiles(agentImageInput.files);
agentImageInput.value = '';
});
// ★ 确认面板按钮事件
document.getElementById('agentRefConfirmYes')?.addEventListener('click', () => hideImageRefConfirmPanel(true));
document.getElementById('agentRefConfirmNo')?.addEventListener('click', () => hideImageRefConfirmPanel(false));
document.getElementById('agentRefConfirmCancel')?.addEventListener('click', () => hideImageRefConfirmPanel(false));
// 思维模式 UI 已移除：执行层固定走快速执行路径
function syncAgentThinkingBtn(){ /* no-op: thinking UI removed */ }
if(agentState) agentState.thinkingMode = false;

    agentInput?.addEventListener('input', () => {
        if(agentComposerSyncing) return;
        agentSaveComposerCaret();
        agentSyncAttachmentsFromComposer();
        updateAgentComposerMenus();
        updateAgentPrimaryAction();
        agentAutoResizeInput();
        saveAgentState();
    });
    agentInput?.addEventListener('compositionstart', () => { agentCompositionActive = true; });
    agentInput?.addEventListener('compositionend', () => { agentCompositionActive = false; updateAgentPrimaryAction(); });
    agentInput?.addEventListener('keydown', e => {
        e.stopPropagation();
        if(agentGhostAttachments.length){
            // 灰态未确认时：输入框未激活，仅允许 Escape 取消
            if(e.key === 'Escape'){
                e.preventDefault();
                clearAgentGhostAttachment({rerender:true});
            }else if(e.key === 'Enter'){
                e.preventDefault();
                confirmAgentGhostAttachment();
            }else if(!e.metaKey && !e.ctrlKey && !e.altKey){
                e.preventDefault();
            }
            return;
        }
        if(agentSkillSlashKeydown(e)) return;
        if(e.key === 'Escape' && agentGhostAttachments.length){
            e.preventDefault();
            clearAgentGhostAttachment({rerender:true});
            return;
        }
        if(e.key === 'Escape' && !agentHasComposerContent() && (agentSending || agentActiveWorkflow?.status === 'running')){
            e.preventDefault(); stopAgentWorkflow(); return;
        }
        if(e.key === 'Enter' && !e.shiftKey && !e.isComposing && !agentCompositionActive){
            e.preventDefault();
            // 任务进行中禁止 Enter 发送新内容；停止请点红色停止按钮
            if(typeof agentIsTaskBusy === 'function' && agentIsTaskBusy()) return;
            sendAgentMessage();
        }
    });
    agentInput?.addEventListener('keyup', e => { e.stopPropagation(); agentSaveComposerCaret(); });
    agentInput?.addEventListener('mouseup', () => agentSaveComposerCaret());
    agentInput?.addEventListener('focus', () => {
        // 点击输入框：灰态图片字符转正（使用选图前锚点，不先改写 caret）
        if(agentGhostAttachments.length) confirmAgentGhostAttachment();
        else agentSaveComposerCaret();
    });
    agentInput?.addEventListener('pointerdown', e => {
        // 灰态阶段点输入框：先确认再让浏览器落光标，避免落到末尾
        if(agentGhostAttachments.length){
            e.preventDefault();
            confirmAgentGhostAttachment();
        }
    });
    agentInput?.addEventListener('click', () => {
        if(agentGhostAttachments.length) confirmAgentGhostAttachment();
        else agentSaveComposerCaret();
    });
    // 点 onebox 空白区域（非按钮）也算激活输入框
    document.querySelector('.agent-onebox')?.addEventListener('pointerdown', e => {
        if(!agentGhostAttachments.length) return;
        if(e.target.closest('button, select, .agent-toolbar, .agent-dropdown-panel, .agent-inline-chip')) return;
        if(e.target.closest('#agentInput, .agent-input-editor')) return;
        e.preventDefault();
        confirmAgentGhostAttachment();
    });
    agentInput?.addEventListener('blur', () => setTimeout(() => { hideAgentMention(); hideAgentSkillSlash(); }, 200));
    agentInput?.addEventListener('paste', e => {
        e.stopPropagation();
        const files = [...(e.clipboardData?.files || [])].filter(f => String(f.type || '').startsWith('image/'));
        if(files.length){
            e.preventDefault();
            agentAttachFiles(files);
            return;
        }
        if(agentIsComposerEl()){
            const html = e.clipboardData?.getData('text/html') || '';
            const textPlain = e.clipboardData?.getData('text/plain') || '';
            // 1) 优先 html 芯片
            if(html && /agent-inline-chip|data-agent-chip|data-url=|agent-copy-rich|agent-ref/.test(html)){
                e.preventDefault();
                if(agentPasteComposerFromHtml(html)) return;
            }
            // 2) 纯文本里的可还原 token / 旧 [参考图1:name]
            if(textPlain && (/agent-ref|\[参考图\s*\d+\s*:/.test(textPlain))){
                e.preventDefault();
                if(agentPasteComposerFromPlain(textPlain)) return;
                // token 解析失败时，不要把 {{agent-ref...}} 脏文本贴进去
                const cleaned = textPlain
                    .replace(/\[参考图\s*\d+\s*:[^\]]*\]\{\{agent-ref[^}]*\}\}/g, '')
                    .replace(/\{\{agent-ref[^}]*\}\}/g, '')
                    .trim();
                if(cleaned) document.execCommand('insertText', false, cleaned);
                return;
            }
            if(textPlain != null){
                e.preventDefault();
                const cleaned = agentNormalizePlainPasteText(textPlain);
                if(cleaned) document.execCommand('insertText', false, cleaned);
            }
        }
    });
    ['dragenter', 'dragover'].forEach(evt => agentPanel.addEventListener(evt, e => {
        e.preventDefault();
        e.stopPropagation();
        agentPanel.classList.add('drag-over-input');
    }));
    agentPanel.addEventListener('dragleave', e => {
        if(!agentPanel.contains(e.relatedTarget)) agentPanel.classList.remove('drag-over-input');
    });
    agentPanel.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        agentPanel.classList.remove('drag-over-input');
        const files = [...(e.dataTransfer?.files || [])];
        if(files.length) agentAttachFiles(files);
    });
}

let canvasAgentMounted = false;
let selectionTimer = 0;
// 宿主画布可能在 click 到达按钮前清空 live selection；保留按钮显现/按下时的有效节点快照。
let agentSendSelectionSnapshot = [];


function agentBuildAttachmentsFromNodes(imageNodes){
    const atts = [];
    // 普通画布的一次工作流会同时选中 generator 与 output，它们指向同一张
    // 真实图片。一次“选中内容 → 参考图”只能保留一个引用；但不要在这里做
    // 全局去重，以便用户随后再次点同一张图片时仍能重复插入到输入框。
    const seenUrls = new Set();
    for(const node of (imageNodes || [])){
        const source = agentNodeImages(node)[0] || (node.url ? {url:node.url, name:node.name || node.title || 'image'} : null);
        const item = source && typeof imageForDisplay === 'function' ? imageForDisplay(source) : source;
        if(!item?.url) continue;
        const urlKey = String(item.url);
        if(seenUrls.has(urlKey)) continue;
        seenUrls.add(urlKey);
        atts.push({
            url: item.url,
            name: item.name || node.title || node.name || 'image',
            nodeId: node.id,
            x: Number(node.x) || 0,
            y: Number(node.y) || 0
        });
    }
    return atts;
}

function agentForceGhostFromNodes(imageNodes, {reason='click'}={}){
    const list = Array.isArray(imageNodes) ? imageNodes : [];
    if(!list.length) return false;
    // 前提：Agent 打开后，单击/多选图片才进入灰态预选
    if(!agentOpen) return false;
    const atts = agentBuildAttachmentsFromNodes(list);
    if(!atts.length) return false;
    // 再次点击同一张图：允许重复进入灰态（覆盖“已确认锁”）
    agentGhostConfirmedSig = '';
    const sig = atts.map(a => `${a.nodeId||''}:${a.url||''}`).join('|');
    // 强制刷新：即使 sig 相同也重新渲染灰态
    agentLastSelectionSig = '';
    setAgentGhostAttachments(atts);
    agentLastSelectionSig = sig;
    return true;
}

function agentSelectionGhostClickHandler(e){
    try{
        if(!e || (e.button != null && e.button !== 0)) return;
        const t = e.target;
        if(!t || !t.closest) return;
        // 输入框/面板内点击不处理
        if(t.closest('#agentPanel, .agent-panel, #agentInput, .agent-input-editor')) return;
        // 普通画布 Output 的图片点击会被预览控件吞掉，不能再等宿主更新选区。
        // 直接从 DOM 中取原图 URL，保证点哪张就引用哪张。
        const outputClickAttachments = agentClassicOutputAttachmentsFromTarget(t);
        if(outputClickAttachments.length){
            if(Date.now() < Number(agentClassicOutputCaptureUntil || 0)) return;
            agentClassicOutputCaptureUntil = Date.now() + 400;
            agentSuppressSelectionGhostSyncUntil = Date.now() + 1800;
            // Output 图片点击已由精确命中的 DOM 图片处理。清掉此前节点/框选
            // 手势窗口，避免普通画布延迟写回的旧选区又把其它输出追加进来。
            agentSelectionGestureUntil = 0;
            agentGhostConfirmedSig = '';
            agentLastSelectionSig = '';
            setAgentGhostAttachments(outputClickAttachments);
            return;
        }
        // 智能画布节点 / 普通画布图片节点
        const nodeEl = t.closest('.image-node, .node, [data-id]');
        if(!nodeEl) return;
        // 智能画布的图片缩略图点击目前会强制单选；因此 Shift/Ctrl 点击
        // 不能只读取宿主选区，否则第二张图会覆盖第一张。这里直接从点击
        // 的节点构造附件，并与当前灰态集合合并，保留 Lovart 式多图预选。
        const appendSelection = Boolean(e.shiftKey || e.ctrlKey || e.metaKey);
        const hitId = nodeEl.dataset?.id || nodeEl.getAttribute?.('data-id') || '';
        if(e.type === 'click'
            && hitId
            && agentLastSelectionPointerUp.nodeId === hitId
            && Date.now() < Number(agentLastSelectionPointerUp.until || 0)){
            return;
        }
        if(e.type === 'pointerup' && hitId){
            agentLastSelectionPointerUp = {nodeId:hitId, until:Date.now() + 450};
        }
        let hitAttachments = [];
        if(hitId){
            try{
                const hitNode = agentHost?.getNode?.(hitId);
                if(hitNode) hitAttachments = agentBuildAttachmentsFromNodes([hitNode]);
            }catch(_){ }
        }
        // 延迟一帧，等宿主画布把 selectedId 写好
        window.setTimeout(() => {
            try{
                const imageNodes = selectedAgentImageNodes();
                // 普通画布的 Output 图片点击会打开预览并阻止节点选中；此时
                // 不能把旧的选区当作本次目标，必须以实际点击的图片节点为准。
                // 对没有可用图片的普通节点，才回退到宿主选区。
                const clickedImages = hitAttachments.length ? hitAttachments : agentBuildAttachmentsFromNodes(imageNodes);
                if(!clickedImages.length) return;
                // 追加键只增加这次点中的图片，避免宿主单选状态把原有灰态覆盖。
                if(appendSelection && hitAttachments.length){
                    const merged = [];
                    const seen = new Set();
                    [...(agentGhostAttachments || []), ...hitAttachments].forEach(att => {
                        const key = agentAttachmentKey(att);
                        if(!key || seen.has(key)) return;
                        seen.add(key); merged.push(att);
                    });
                    if(merged.length){
                        agentGhostConfirmedSig = '';
                        agentLastSelectionSig = merged.map(a => `${a.nodeId||''}:${a.url||''}`).join('|');
                        setAgentGhostAttachments(merged);
                        return;
                    }
                }
                // 普通单击也优先使用直接命中的图片，避免 Output 预览点击保留
                // 旧选区并把上一张图片错误塞进输入框。
                if(hitAttachments.length){
                    agentForceGhostFromNodes([agentHost?.getNode?.(hitId)].filter(Boolean), {reason:'node-click'});
                    return;
                }
                agentForceGhostFromNodes(imageNodes, {reason:'node-click'});
            }catch(err){
                console.warn('[canvas-agent] force ghost on click failed', err);
            }
        }, 0);
    }catch(_){ }
}

function agentClassicOutputAttachmentsFromTarget(target){
    try{
        const wrap = target?.closest?.('.output-img-wrap');
        if(!wrap) return [];
        const nodeEl = wrap.closest('.node.output-node[data-id], .output-node[data-id]');
        const nodeId = nodeEl?.dataset?.id || nodeEl?.getAttribute?.('data-id') || '';
        const img = target?.closest?.('img') || wrap.querySelector?.('img');
        // 普通画布的 generator/output 节点可能在异步写回期间仍保留上一张
        // 图片；用户点的是 DOM 中这张缩略图，就必须以它的真实 URL 为准。
        // `/api/media-preview?...&url=` 只是预览代理，解出其中的原图 URL。
        let url = img?.dataset?.originalSrc || img?.dataset?.url || '';
        if(!url){
            const src = img?.getAttribute?.('src') || '';
            if(src){
                try{
                    const parsed = new URL(src, window.location.href);
                    url = parsed.pathname === '/api/media-preview'
                        ? (parsed.searchParams.get('url') || '')
                        : src;
                }catch(_){ url = src; }
            }
        }
        if(!url) url = wrap.dataset?.outputUrl || '';
        if(url) return [{
            url,
            name: img?.alt || nodeEl?.querySelector?.('.node-title')?.textContent || 'output-image',
            nodeId,
            x: 0,
            y: 0
        }];
        const hitNode = nodeId ? agentHost?.getNode?.(nodeId) : null;
        const fromNode = hitNode ? agentBuildAttachmentsFromNodes([hitNode]) : [];
        if(fromNode.length) return fromNode;
        return [];
    }catch(_){
        return [];
    }
}

// 普通画布的 Output 图片本身会在 click 中打开灯箱并 stopPropagation()。
// 虽然常规节点点击可由 click / pointerup 处理，但 Output 的图片必须在
// pointerdown 捕获阶段抢先取到，才能既打开预览又稳定进入 Agent 的灰态参考。
// 这里只接管实际图片区域，不影响节点标题、删除、拖拽和普通节点的既有选择逻辑。
function agentClassicOutputGhostPointerDownHandler(e){
    try{
        if(!agentOpen || !e || (e.button != null && e.button !== 0)) return;
        const atts = agentClassicOutputAttachmentsFromTarget(e.target);
        if(!atts.length) return;
        // Output 节点通常不会被 selectedAgentImageNodes 识别；短暂抑制轮询，
        // 防止宿主随后清空选区把刚显示的灰态参考又删除。
        agentSuppressSelectionGhostSyncUntil = Date.now() + 1800;
        agentClassicOutputCaptureUntil = Date.now() + 400;
        // 这次单击的目标已经确定为 Output 图片；不能让同一次 pointerdown
        // 开启的宿主多选窗口在稍后覆盖这个单图灰态引用。
        agentSelectionGestureUntil = 0;
        agentGhostConfirmedSig = '';
        agentLastSelectionSig = '';
        setAgentGhostAttachments(atts);
    }catch(err){
        console.warn('[canvas-agent] classic output ghost capture failed', err);
    }
}

function selectedAgentImageNodes(){
    const ids = (typeof selectedNodeIds === 'function')
        ? selectedNodeIds()
        : (agentHost?.getSelection?.()?.nodeIds || []);
    const list = (typeof nodes !== 'undefined' && Array.isArray(nodes)) ? nodes : [];
    return (ids || []).map(id => list.find(node => node?.id === id)).filter(node => {
        if(!node) return false;
        if(typeof isSmartImageNode === 'function'){
            return isSmartImageNode(node) && agentNodeImages(node).some(image => image?.url);
        }
        if(agentNodeImages(node).some(image => image?.url)) return true;
        if(node.type === 'image' && node.url) return true;
        return false;
    });
}

function agentTrackSelectionGesture(e){
    try{
        if(!agentOpen || !e || (e.button != null && e.button !== 0)) return;
        const target = e.target;
        if(target?.closest?.('#agentPanel, .agent-panel, #agentInput, .agent-input-editor, [data-canvas-interactive]')) return;
        // 鼠标在画布上的点击、Shift 多选或 Ctrl 框选都会打开一个短窗口。
        // 程序新建节点不会产生 pointer 事件，因此无法进入这个窗口。
        agentSelectionGestureUntil = Date.now() + 1600;
    }catch(_){ }
}

function agentSnapshotSelectedImagesForSend(){
    const liveSelection = selectedAgentImageNodes();
    if(liveSelection.length) agentSendSelectionSnapshot = liveSelection.slice();
    return agentSendSelectionSnapshot.slice();
}

function syncAgentSelectionButton(){
    if(smartSendAgentBtn){
        const imageNodes = selectedAgentImageNodes();
        // 仅真实的用户鼠标手势能更新发送快照；任务自动选中的输出节点
        // 不能覆盖它，否则下一条无参考图需求会继承上一轮结果。
        if(imageNodes.length && Date.now() <= Number(agentSelectionGestureUntil || 0)){
            agentSendSelectionSnapshot = imageNodes.slice();
        }
        smartSendAgentBtn.hidden = imageNodes.length === 0;
        smartSendAgentBtn.classList.toggle('visible', imageNodes.length > 0);
        const label = smartSendAgentBtn.querySelector('span');
        if(label) label.textContent = imageNodes.length ? `发送至设计大师（${imageNodes.length} 张）` : '发送至设计大师';
    }
    // Lovart 多选：当前选中的图片集合 = 灰态预选集合（可多张）
    // 点空白取消；点输入框一次性确认全部灰态
    try{
        if(!agentOpen){
            if(agentGhostAttachments.length) clearAgentGhostAttachment({rerender:true});
            return;
        }
        // 任务创建节点时，宿主会自动更新选区。该选区不是用户点击，不能
        // 自动变成灰态参考图；真正的鼠标点击仍由点击处理器立即处理。
        if(Date.now() < Number(agentSuppressSelectionGhostSyncUntil || 0)) return;
        if(Date.now() > Number(agentSelectionGestureUntil || 0)) return;
        // 点画布前若输入框仍有有效光标，先锁住；canvas 点击后 selection 往往已不在输入框
        try{
            if(agentIsComposerEl() && document.activeElement === agentInput) agentSaveComposerCaret();
        }catch(_){}
        const imageNodes = selectedAgentImageNodes();
        // 单选/多选统一走灰态预选；空选清除灰态
        const sig = imageNodes.map(n => `${n.id}:${(agentNodeImages(n)[0]||{}).url || n.url || ''}`).join('|');
        if(!imageNodes.length){
            if(agentLastSelectionSig !== '') agentLastSelectionSig = '';
            if(agentGhostConfirmedSig) agentGhostConfirmedSig = '';
            if(agentGhostAttachments.length) clearAgentGhostAttachment({rerender:true});
            return;
        }
        // 刚确认过的同一选区：保持已确认态，不要自动重灰
        if(sig && sig === agentGhostConfirmedSig){
            agentLastSelectionSig = sig;
            return;
        }
        if(sig === agentLastSelectionSig) return;
        agentLastSelectionSig = sig;
        const atts = agentBuildAttachmentsFromNodes(imageNodes);
        // 单张也必须灰态；同图可重复进入灰态（已在 setAgentGhostAttachments 放开去重）
        if(atts.length) setAgentGhostAttachments(atts);
    }catch(err){
        console.warn('[canvas-agent] selection ghost sync failed', err);
    }
}

function attachSelectedImages(imageNodesSnapshot=null){
    // 兼容旧按钮：把当前选中图作为“已确认”内联参考图插入
    const frozenSelection = Array.isArray(imageNodesSnapshot) ? imageNodesSnapshot.filter(Boolean) : [];
    const imageNodes = frozenSelection.length ? frozenSelection : selectedAgentImageNodes();
    if(!imageNodes.length){ if(typeof toast === 'function') toast('没有选中的图片节点'); return; }
    if(!agentOpen) toggleAgentPanel(true);
    if(!agentState) return;
    clearAgentGhostAttachment();
    if(!Array.isArray(agentState.attachments)) agentState.attachments = [];
    const limit = agentAttachmentLimit();
    let added = 0;
    for(const node of imageNodes){
        if(agentState.attachments.length >= limit) break;
        const source = agentNodeImages(node)[0];
        const item = typeof imageForDisplay === 'function' ? imageForDisplay(source) : source;
        if(!item?.url) continue;
        const att = {url:item.url, name:item.name || node.title || 'image', nodeId:node.id, x:Number(node.x) || 0, y:Number(node.y) || 0};
        // 同一张图可重复添加
        if(agentIsComposerEl()) agentInsertChipAtCaret(att, {ghost:false});
        else agentState.attachments.push(att);
        added += 1;
    }
    agentSyncAttachmentsFromComposer();
    renderAgentAttachments();
    saveAgentState();
    agentFocusComposer();
    if(typeof toast === 'function') toast(added ? `已添加 ${added} 张参考图` : '未添加参考图（可能达到上限）');
}

function ensureAgentProfessionalPrompt(prompt,userPrompt){
    // 执行层不再替 LLM 二次扩写业务内容；只做“纯净提示词”清洗，去掉系统话术/步骤编号
    let base=String(prompt||userPrompt||'').trim();
    if(!base) return '';
    base = base
        .replace(/本张为第\s*\d+\s*\/\s*\d+\s*张[^\n。]*/g, ' ')
        .replace(/本张专属表情[：:][^\n。]*/g, ' ')
        .replace(/重点表现[：:]\s*/g, '')
        .replace(/清晰表现[“"][^”"]+[”"]这一情绪[^\n。]*/g, ' ')
        .replace(/第\s*\d+\s*\/\s*\d+\s*张/g, ' ')
        .replace(/步骤\s*\d+/g, ' ')
        .replace(/独立变体/g, ' ')
        .replace(/不要与其他变体重复[^\n。]*/g, ' ')
        .replace(/不要和其他步骤重复[^\n。]*/g, ' ')
        .replace(/不要多页融合[^\n。]*/g, ' ')
        .replace(/与其他主图构图\/卖点不同[^\n。]*/g, ' ')
        .replace(/信息层级与其他详情页不同[^\n。]*/g, ' ')
        // 禁止“变体2/表情为变体2”这类无意义系统词进入最终提示词
        .replace(/表情为\s*变体\s*\d+\s*[：:]?[^\n。]*/g, ' ')
        .replace(/本张差异[：:]\s*变体\s*\d+[^\n。]*/g, ' ')
        .replace(/（\s*变体\s*\d+[^）]*）/g, ' ')
        .replace(/\(\s*变体\s*\d+[^\)]*\)/g, ' ')
        .replace(/作为变体\s*\d+/g, ' ')
        .replace(/变体\s*\d+/g, ' ')
        .replace(/表情包为\s*[：:]?\s*/g, ' ')
        .replace(/表情为\s*[：:]?\s*$/g, ' ')
        .replace(/表情为\s*[：:]\s*(?=[，,。；;\s]|$)/g, ' ')
        .replace(/本张差异\s*[：:]\s*(?=[，,。；;\s]|$)/g, ' ')
        // 独立任务常见脏词：全局参考图序号不应出现在最终视觉提示词
        .replace(/请?严格参考第\s*[2-9]\d*\s*张参考图[^\n。；;]*/g, ' ')
        .replace(/严格参考第\s*[2-9]\d*\s*张参考图[^\n。；;]*/g, ' ')
        .replace(/参考第\s*[2-9]\d*\s*张参考图[^\n。；;]*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[。．.\s]+/, '')
        .replace(/[。．.]{2,}/g, '。')
        .trim();
    // 再清一轮脏规划话术
    base = String(base||'')
        .replace(/表情为第一张[^。；;\n]*/g, ' ')
        .replace(/本张差异\s*[：:]\s*[^。；;\n]*/g, ' ')
        .replace(/独立变体/g, ' ')
        .replace(/角色\/产品特征稳定/g, '角色特征稳定')
        .replace(/\s+/g, ' ')
        .replace(/^[。．.\s]+/, '')
        .trim();
    return base;
}
// 只有明确的正向组合/融合动作才进入 fusion；“不要融合/不能合成”等
// 否定表达不能改变任务依赖类型。这个判断同时供阶段2规划和执行前兜底使用。
function agentFusionTermIsNegated(text='', index=0){
    const t = String(text || '');
    const before = t.slice(Math.max(0, Number(index) - 24), Number(index));
    return /(?:不|未|无|不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|勿|取消|去掉|不再|不是|并非|而非|不做|不进行)\s*(?:再|将|把|让|进行|做|使用|去)?\s*$/.test(before)
        || /(?:不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|取消|去掉|不再|不是|并非|而非|不做|不进行)[^。；;，,\n]{0,16}$/.test(before);
}
function agentHasPositiveFusionIntent(text=''){
    const t = String(text || '');
    // Keep this helper self-contained: lightweight VM regression tests (and a
    // few plugin consumers) extract it without the neighbouring negation
    // helper.  The local check mirrors agentFusionTermIsNegated exactly.
    const isNegated = index => {
        const before = t.slice(Math.max(0, Number(index) - 24), Number(index));
        return /(?:不|未|无|不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|勿|取消|去掉|不再|不是|并非|而非|不做|不进行)\s*(?:再|将|把|让|进行|做|使用|去)?\s*$/.test(before)
            || /(?:不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|取消|去掉|不再|不是|并非|而非|不做|不进行)[^。；;，,\n]{0,16}$/.test(before);
    };
    const termRe = /组合|结合|合成|融合|拼在一起|合并|合在一起|放在一起|拼合|合成为|合成一张|合成一图|同框|追逐|打架|互动|对峙|拥抱|共同出现在|一张完整画面/g;
    let match;
    while((match = termRe.exec(t))){
        if(!isNegated(match.index)) return true;
    }
    // “把这两张放在一起/做成一张”是组合语义；仍然尊重前面的否定词。
    const pairRe = /(?:把|将)这(?:两|二|三|四|五|六|七|八|九|十|\d+)张[^。；;\n]{0,24}(?:放在一起|拼在一起|组合|结合|合成|融合|合并|同框|一张完整画面)/g;
    while((match = pairRe.exec(t))){
        if(!isNegated(match.index)) return true;
    }
    return false;
}
// v2：所有 Agent 生图统一转换为可审计的画布计划，再由画布原生节点执行。
function agentLooksLikeFusionPrompt(text=''){
    // Deliberately repeat the tiny detector here instead of delegating to a
    // top-level helper.  This function is also loaded in isolation by older
    // hosts/tests, so it must still honour "不要融合" without a missing
    // global-function error.
    const t = String(text || '');
    const isNegated = index => {
        const before = t.slice(Math.max(0, Number(index) - 24), Number(index));
            return /(?:不|未|无|不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|勿|取消|去掉|不再|不是|并非|而非|不做|不进行)\s*(?:再|将|把|让|进行|做|使用|去)?\s*$/.test(before)
                || /(?:不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|取消|去掉|不再|不是|并非|而非|不做|不进行)[^。；;，,\n]{0,16}$/.test(before);
    };
    const termRe = /组合|结合|合成|融合|拼在一起|合并|合在一起|放在一起|拼合|合成为|合成一张|合成一图|同框|追逐|打架|互动|对峙|拥抱|共同出现在|一张完整画面/g;
    let match;
    while((match = termRe.exec(t))){
        if(!isNegated(match.index)) return true;
    }
    const pairRe = /(?:把|将)这(?:两|二|三|四|五|六|七|八|九|十|\d+)张[^。；;\n]{0,24}(?:放在一起|拼在一起|组合|结合|合成|融合|合并|同框|一张完整画面)/g;
    while((match = pairRe.exec(t))){
        if(!isNegated(match.index)) return true;
    }
    return false;
}
function agentLooksLikeSeriesPrompt(text=''){
    return /详情页|主图|套图|系列|整套|多页|电商详情|产品页|包装|三视图|定稿|一致性|统一文字|统一配色|品牌设定|shared_style|产品一致性/.test(String(text||''));
}
function agentLooksLikeIndependentSubjectPrompt(text=''){
    const t=String(text||'');
    // 单主体描述，不像融合指令
    if(agentLooksLikeFusionPrompt(t)) return false;
    return t.length > 0;
}
function agentNormalizeDependencyMode(mode, prompt=''){
    const raw=String(mode||'').trim().toLowerCase();
    if(raw==='fusion') return 'fusion';
    if(raw==='none' || raw==='') return 'none';
    // LLM may use a natural alias for "reference previous output".
    if(raw==='product_reference' || raw==='product-reference' || raw==='product_ref'
        || raw==='reference' || raw==='previous_reference' || raw==='previous-reference'
        || raw==='previous_result' || raw==='previous-results') return 'product_reference';
    // 不再根据 prompt 关键词猜测依赖；依赖必须由规划字段显式给出
    return 'none';
}
function agentApplySharedStyleToPrompt(prompt, sharedStyle=''){
    const base=String(prompt||'').trim();
    const style=String(sharedStyle||'').trim();
    if(!style) return base;
    if(!base) return style;
    if(base.includes(style)) return base;
    return `【统一设定·不可变更】${style}\n${base}`;
}
function agentStripSharedStylePrefix(text=''){
    return String(text || '')
        .replace(/【统一设定[·・]?不可变更】[^\n]*/g, ' ')
        .replace(/统一设定[·・]?不可变更[：:][^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function agentExtractSubjectLabel(text='', index=0){
    let t = agentStripSharedStylePrefix(text);
    t = t
        .replace(/请严格参考[^。\n]*/g, ' ')
        .replace(/用户原意[：:][^。\n]*/g, ' ')
        .replace(/将它们融合为同一张完整画面[^。\n]*/g, ' ')
        .replace(/保持各主体外形与关键特征一致[^。\n]*/g, ' ')
        .replace(/【统一设定[·・]?不可变更】/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if(!t) return `素材${index + 1}`;
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
    const first = (t.split(/[，。；;\n]/)[0] || t).replace(/^(?:与|和|的|及)\s*/, '');
    return first.slice(0, 12) || `素材${index + 1}`;
}
function agentCleanFusionActionText(basePrompt='', userText=''){
    let base = agentStripSharedStylePrefix(basePrompt);
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
    const parts = user.split(/[，。；;\n]/).map(s=>s.trim()).filter(Boolean);
    const last = parts.reverse().find(s => /打架|互动|融合|组合|场景|同框|一起|对峙/.test(s));
    if(last) return last.replace(/^(?:再|然后)?(?:生成|创作|制作)(?:一张|一幅)?/, '').trim() || last;
    return base || user || '将参考图中的主体自然融合到同一完整画面中，动作与场景协调，构图清晰。';
}
function agentBuildFusionPrompt(prevGens, userText=''){
    const labels = prevGens.map((g,i)=>{
        const short = agentExtractSubjectLabel(g.prompt || g.professionalPrompt || '', i);
        return `图${i+1}（${short||'素材'}）`;
    }).join('、');
    const action = agentCleanFusionActionText(prevGens[prevGens.length-1]?.prompt || '', userText);
    let prompt = `请严格参考${labels}（按参考图数组顺序），将参考图中的主体自然融合到同一完整画面：${action}`;
    prompt = prompt.replace(/：请严格参考/g, '：').replace(/\s+/g, ' ').trim();
    if(!/保持各主体外形|外形与关键特征/.test(prompt)){
        prompt += '。保持各主体外形与关键特征与参考图一致，统一光影与透视，构图自然协调。';
    }
    return prompt;
}
function agentBuildProductReferencePrompt(productGen, pagePrompt='', userText=''){
    const product = agentExtractSubjectLabel(productGen?.prompt || '产品定稿', 0);
    let page = agentStripSharedStylePrefix(pagePrompt || '').trim();
    const user = String(userText || '').trim();
    const head = `严格参考图1（产品定稿：${product}）作为唯一产品一致性参考。后续画面必须保持同一包装外形、材质、Logo、标签版式与品牌识别完全一致，只更换页面构图与文案层级，不要把多张页面融合成一张。`;
    return `${head}${page?`\n${page}`:''}${user && !page.includes(user)?`\n用户原意：${user}`:''}`;
}
function agentMarkGenerationDependencies(gens, userText='', sharedStyle=''){
    if(!Array.isArray(gens) || !gens.length) return gens;
    const style = String(sharedStyle || gens.find(g => g?.shared_style)?.shared_style || '').trim();
    // 用户明确表达的语义优先于 LLM 偶发的 dependency_mode 误标：
    // “定稿/主图/详情页/套图”是单一产品或人物参考链，应使用 product_reference；
    // 只有用户明确写出融合/合成等动作时，才允许进入 fusion 分支。
    const userFusionHint = agentLooksLikeFusionPrompt(userText);
    const userSeriesHint = agentLooksLikeSeriesPrompt(userText);
    const generatedFusionHint = gens.some(g => agentLooksLikeFusionPrompt(g.prompt) || agentNormalizeDependencyMode(g.dependency_mode, g.prompt)==='fusion');
    const fusionHint = userFusionHint || (generatedFusionHint && !userSeriesHint);
    // 分句精确参考图（如 图1+图2 做主图，图3+图2 做详情）不应被“主图/详情页”关键词误判成产品系列依赖
    const exactAttachPlan = gens.length >= 2
        && gens.every(g => Array.isArray(g.attachment_indices) && g.attachment_indices.length)
        // 只看“显式依赖字段”，不要用 prompt 关键词反推（否则“详情页参数图”会被误判成 product_reference）
        && !gens.some(g => g.depends_on_previous === true || g.use_previous_results === true || String(g.dependency_mode || '').toLowerCase() === 'product_reference' || String(g.dependency_mode || '').toLowerCase() === 'fusion');

    const seriesHint = !exactAttachPlan && (agentLooksLikeSeriesPrompt(userText) || gens.some(g => agentLooksLikeSeriesPrompt(g.prompt) || agentNormalizeDependencyMode(g.dependency_mode, g.prompt)==='product_reference'));

    if(exactAttachPlan){
        gens.forEach(g => {
            g.shared_style = style || g.shared_style || '';
            g.dependency_mode = 'none';
            g.depends_on_previous = false;
            g.use_previous_results = false;
            g.use_attachments = true;
            g.prompt = agentApplySharedStyleToPrompt(g.prompt, g.shared_style || style);
        });
        return gens;
    }


    // 详情页/系列套图：第1张产品定稿，后续页引用产品图，而不是融合
    if(seriesHint && !fusionHint){
        gens.forEach((g, i) => {
            g.shared_style = style || g.shared_style || '';
            if(i === 0){
                g.dependency_mode = 'none';
                g.depends_on_previous = false;
                g.use_previous_results = false;
                if(!g.use_attachments) g.use_last_outputs = false;
            }else{
                // 套图/定稿链中，LLM 偶发的 fusion 标记不能改变用户语义；
                // 本分支已经确认用户没有要求融合，因此所有后续页统一绑定唯一
                // 产品/人物定稿，使用 product_reference。
                g.dependency_mode = 'product_reference';
                g.depends_on_previous = true;
                g.use_last_outputs = false; // same-plan deps via depends_on_previous only
                g.use_previous_results = true;
                // 后续主图/详情只依赖产品定稿，不要再叠用户上传附件（否则执行层会引用2张）
                if(g.dependency_mode === 'product_reference'){
                    g.use_attachments = false;
                    g.attachment_indices = [];
                    if(Array.isArray(g.direct_refs)) g.direct_refs = [];
                    g.prompt = agentBuildProductReferencePrompt(gens[0], g.prompt, userText);
                }
            }
            g.prompt = agentApplySharedStyleToPrompt(g.prompt, g.shared_style || style);
        });
        return gens;
    }

    if(!fusionHint){
        gens.forEach(g => {
            g.shared_style = style || g.shared_style || '';
            g.dependency_mode = agentNormalizeDependencyMode(g.dependency_mode, g.prompt);
            if(g.dependency_mode === 'none'){
                g.depends_on_previous = false;
            }
            g.prompt = agentApplySharedStyleToPrompt(g.prompt, g.shared_style || style);
        });
        return gens;
    }

    const last = gens[gens.length - 1];
    const lastIsFusion = agentLooksLikeFusionPrompt(last.prompt) || agentNormalizeDependencyMode(last.dependency_mode, last.prompt)==='fusion';
    // 用户要求“先分别生成再融合”，但模型只返回了多个独立主体、没有融合项：
    // 追加一个真正的融合步骤，而不是把最后一个独立主体误标成融合。
    if(!lastIsFusion && gens.length >= 2 && gens.every(g => agentNormalizeDependencyMode(g.dependency_mode, g.prompt) !== 'fusion' && !agentLooksLikeFusionPrompt(g.prompt))){
        gens.forEach(g => {
            g.dependency_mode = 'none';
            g.depends_on_previous = false;
            if(!g.use_attachments) g.use_last_outputs = false;
            g.shared_style = style || g.shared_style || '';
            g.prompt = agentApplySharedStyleToPrompt(g.prompt, g.shared_style || style);
        });
        gens.push({
            // 融合步不要前置 shared_style 商业套话，避免提示词膨胀
            prompt: agentBuildFusionPrompt(gens, userText),
            count: 1,
            use_last_outputs: false, // same-plan deps via depends_on_previous only
            use_attachments: false,
            depends_on_previous: true,
            use_previous_results: true,
            dependency_mode: 'fusion',
            shared_style: '',
            results: [],
            status: 'running'
        });
        return gens;
    }

    gens.forEach((g, i) => {
        const mode = agentNormalizeDependencyMode(g.dependency_mode, g.prompt);
        const isFusion = mode === 'fusion' || agentLooksLikeFusionPrompt(g.prompt) || (i === gens.length - 1 && lastIsFusion);
        g.shared_style = style || g.shared_style || '';
        if(isFusion){
            g.dependency_mode = 'fusion';
            g.depends_on_previous = true;
            g.use_last_outputs = false; // same-plan deps via depends_on_previous only
            g.use_previous_results = true;
            // 融合步统一重建干净提示词：图1主体 + 图2主体 + 动作/场景
            const prev=gens.slice(0,i);
            g.prompt = prev.length ? agentBuildFusionPrompt(prev, userText || g.prompt || '') : agentCleanFusionActionText(g.prompt, userText);
            g.shared_style = ''; // 融合不套 shared_style
        }else if(mode === 'product_reference'){
            g.dependency_mode = 'product_reference';
            g.depends_on_previous = true;
            g.use_last_outputs = false; // same-plan deps via depends_on_previous only
            g.use_previous_results = true;
            g.prompt = agentBuildProductReferencePrompt(gens[0], g.prompt, userText);
            g.prompt = agentApplySharedStyleToPrompt(g.prompt, g.shared_style || style);
        }else{
            g.dependency_mode = 'none';
            g.depends_on_previous = false;
            if(!g.use_attachments) g.use_last_outputs = false;
            g.prompt = agentApplySharedStyleToPrompt(g.prompt, g.shared_style || style);
        }
    });
    return gens;
}
function agentApplyEntryResultToGen(gen, entry){
    if(!gen || !entry) return;
    const result=entry.result||null;
    gen.runNodeId=entry.runNodeId||gen.runNodeId;
    gen.outputNodeId=entry.outputNodeId||result?.outputNodeId||gen.outputNodeId||'';
    if(entry.resolvedSettings) gen.resolvedSettings=entry.resolvedSettings;
    // 步骤提示词与执行层强绑定：卡片永远显示实际注入节点的 professional_prompt
    if(entry.step?.professional_prompt){
        gen.prompt = entry.step.professional_prompt;
        gen.professionalPrompt = entry.step.professional_prompt;
        gen.plannedPrompt = gen.plannedPrompt || entry.step.user_prompt || gen.userPrompt || '';
    }else if(entry.step?.prompt){
        gen.prompt = entry.step.prompt;
        gen.professionalPrompt = entry.step.prompt;
    }
    if(entry.step?.settings){
        gen.ratio = entry.step.settings.ratio || gen.ratio;
        gen.resolution = entry.step.settings.resolution || gen.resolution;
        gen.count = entry.step.settings.count || gen.count;
    }
    if(entry.step?.dependency_mode){
        gen.dependency_mode = entry.step.dependency_mode;
        if(entry.step.dependency_mode === 'product_reference' || entry.step.dependency_mode === 'fusion'){
            gen.depends_on_previous = true;
        }
    }
    if(Array.isArray(entry.step?.references) && entry.step.references.length){
        gen.refCount = entry.step.references.filter(r => r?.url).length;
        // 只有挂了用户附件才标“参考附件图”；产品定稿依赖不算附件
        const hasAttachLike = entry.step.references.some(r => r && (r.fromAttachment || r.attachmentIndex != null || r.source === 'attachment'));
        if(hasAttachLike || entry.step.dependency_mode === 'none') gen.use_attachments = true;
        if(entry.step.dependency_mode === 'product_reference' || entry.step.dependency_mode === 'fusion'){
            gen.use_attachments = false;
        }
    }
    if(!result){
        // 没有结果时，仅在仍是 running 时保留；不要抹掉已成功项
        return;
    }
    const images=(result.images||[]).map(img=>({
        ...img,
        nodeId: img.nodeId || result.outputNodeId || entry.outputNodeId || entry.runNodeId || '',
        nodeX: Number(img.nodeX)||0,
        nodeY: Number(img.nodeY)||0
    }));
    if(images.length || result.status==='completed' || result.status==='success'){
        gen.results=images;
        gen.status='done';
        gen.error='';
        return;
    }
    if(result.status==='stopped'){
        gen.status='stopped';
        gen.error=result.error||'已停止';
        return;
    }
    // 失败：只有当前还不是 done 时才标 error，避免覆盖成功
    if(gen.status!=='done'){
        gen.results=images;
        gen.status='error';
        gen.error=String(result.error||'节点运行失败，可在画布节点中检查参数后重试').slice(0,240);
    }
}

// 将附件/参考图落到画布节点并保证可连线（url-only 也会创建/复用节点）
function agentNormalizeRefUrl(u=''){
    return String(u || '').trim().split('#')[0].split('?')[0];
}
function agentFindExistingImageNodeIdByUrl(url=''){
    const target = agentNormalizeRefUrl(url);
    if(!target) return '';
    const host = agentHost || window.CanvasAgentHost;
    const list = (typeof nodes !== 'undefined' && Array.isArray(nodes))
        ? nodes
        : ((typeof host?.listNodes === 'function' ? host.listNodes() : []) || []);
    const match = (n) => {
        if(!n) return false;
        if(n.url && agentNormalizeRefUrl(n.url) === target) return true;
        const imgs = n.images || [];
        return imgs.some(img => img?.url && agentNormalizeRefUrl(img.url) === target);
    };
    // Prefer original canvas nodes, not agent-created pending placeholders
    const preferred = list.find(n => match(n) && !n.agentCreated && !(Number(n.pending) > 0));
    if(preferred?.id) return preferred.id;
    const any = list.find(n => match(n));
    return any?.id || '';
}
// 将附件/参考图落到画布节点并保证可连线（url-only 也会创建/复用节点）
// 同一次任务内同一 URL 只落一次节点；后续步骤只复用 nodeId 连线
function agentMaterializeReferenceNodes(refs, anchorBase=null, options={}){
    const host = agentHost || window.CanvasAgentHost;
    if(!host || !Array.isArray(refs) || !refs.length) return [];
    const out = [];
    const base = anchorBase || (host.getViewportAnchor ? host.getViewportAnchor({preferSelection:false}) : {x:40,y:40});
    let offsetY = Number(options.offsetY || 0) || 0;
    const cache = (options.cache instanceof Map) ? options.cache : new Map();
    const writeBack = options.writeBack !== false;
    for(const ref of refs){
        const url = ref?.url || ref?.src || '';
        if(!url) continue;
        const key = agentNormalizeRefUrl(url) || url;
        let nodeId = ref.nodeId || ref.id || '';
        if(nodeId && host.getNode && !host.getNode(nodeId)) nodeId = '';
        if(!nodeId && cache.has(key)) nodeId = cache.get(key) || '';
        if(!nodeId) nodeId = agentFindExistingImageNodeIdByUrl(url);
        if(nodeId && host.updateNode){
            try{
                const existingNode = host.getNode ? host.getNode(nodeId) : null;
                if(existingNode && !(existingNode.url || (existingNode.images||[]).some(x=>x?.url))){
                    host.updateNode(nodeId, {
                        url,
                        name: ref.name || existingNode.name || 'reference',
                        images: Array.isArray(existingNode.images) && existingNode.images.length
                            ? existingNode.images
                            : [{url, name: ref.name || 'reference', kind: ref.kind || 'image'}],
                        title: ref.name || existingNode.title || 'Reference',
                        status: 'completed',
                        pending: 0
                    });
                }
            }catch(_){ }
        }
        if(!nodeId && typeof host.createImageNode === 'function'){
            try{
                const created = host.createImageNode({url, name: ref.name || 'reference', kind: ref.kind || 'image'}, {
                    x: Number(base.x || 0) - 420,
                    y: Number(base.y || 0) + offsetY
                });
                nodeId = created?.id || '';
                if(nodeId) offsetY += 340;
            }catch(err){
                console.warn('[canvas-agent] createImageNode for reference failed', err);
            }
        }
        if(nodeId) cache.set(key, nodeId);
        if(writeBack && ref && typeof ref === 'object'){
            ref.nodeId = nodeId || ref.nodeId || '';
            if(!ref.name && ref.label) ref.name = ref.label;
        }
        out.push({
            url,
            name: ref.name || ref.label || 'reference',
            kind: ref.kind || 'image',
            nodeId: nodeId || '',
            imageIndex: ref.imageIndex ?? 0
        });
    }
    return out;
}
function agentAttachmentManifestText(attachments, userText='', skills=[]){
    const list = (attachments || []).filter(a => a?.url);
    if(!list.length) return '';
    // 仅提供顺序编号；角色由 LLM 规划时根据用户原话判定（代码只做弱提示，不替代规划）
    const roles = agentInferAttachmentRoles(list, userText, skills);
    const lines = list.map((att, i) => {
        const n = i + 1;
        const name = att.name || att.label || ('Image' + n);
        const node = att.nodeId ? (' node=' + att.nodeId) : '';
        const hint = roles[i] && roles[i] !== 'reference' ? ('，系统弱提示可能是' + agentAttachmentRoleLabel(roles[i], i)) : '';
        return '参考图' + n + ': ' + name + node + hint;
    });
    return [
        '【本轮锚定参考图】',
        ...lines,
        '编号规则：按输入框图片字符从左到右固定为 参考图1/2/3...，不可重排。',
        '请你在规划时完成：1) 根据用户原话判定每张图角色（产品图/风格图/实拍图等）；2) 在 reply/plan 中写明“参考图1=...，参考图2=...”；3) 每步 generations 必须 use_attachments=true，并用 attachment_indices 精确指向要用的编号（参考图1→0，参考图2→1）。',
        '执行层会严格按你输出的 attachment_indices 连线；不要只在文字里写参考图却不填 attachment_indices。',
        '若用户没有明确要求中间产物，后续页直接使用用户参考图，不要擅自依赖第1张生成图。若用户明确写了先生成中间图、再用生成图和指定参考图继续，则后续步骤必须同时保留 depends_on_previous=true 和对应 attachment_indices。'
    ].join('\n');
}
function agentCollectRunAttachments(userMsg){
    // 只认任务发起时冻结在 userMsg 上的参考图。
    // 不能回退到全局 agentState.attachments：用户切换到另一个对话后，
    // 全局草稿可能已经属于新任务，旧任务若读取它会把错误参考图挂进节点。
    return Array.isArray(userMsg?.images)
        ? userMsg.images.filter(x => x?.url).slice()
        : [];
}



runAgentGenerations = async function(assistantMsg,userMsg,options={}){
    // 所属对话：优先用显式传入/消息标记，避免用户切到新对话后结果落到新对话
    const ownerConversationId = options.conversationId
        || assistantMsg?.conversationId
        || userMsg?.conversationId
        || agentState?.activeConversationId
        || '';
    if(!ownerConversationId) throw new Error('无法确定当前任务所属对话，已停止执行');
    if(agentGlobalTaskOwnedByOther(ownerConversationId)){
        throw new Error('另一个对话正在执行任务，当前任务未启动');
    }
    let acquiredTaskHere = false;
    if(!agentGlobalTaskOwnedBy(ownerConversationId)){
        if(!agentTryAcquireGlobalTask(ownerConversationId)){
            throw new Error('另一个对话正在执行任务，当前任务未启动');
        }
        acquiredTaskHere = true;
    }
    // 生图层再做一次不可重入检查；冲突必须显式报错，不能静默丢掉整套工作流。
    if(window.__canvasAgentGenRunning){
        if(acquiredTaskHere) agentReleaseGlobalTask(ownerConversationId);
        throw new Error('当前已有生图任务正在执行，请等待完成后重试');
    }
    window.__canvasAgentGenRunning = true;
    // 整个执行期内，忽略节点创建/输出落盘导致的自动选中。
    agentSuppressSelectionGhostSyncUntil = Date.now() + 60 * 60 * 1000;
    if(assistantMsg && ownerConversationId) assistantMsg.conversationId = ownerConversationId;
    if(userMsg && ownerConversationId) userMsg.conversationId = ownerConversationId;
    const isOwnerConversation = () => !ownerConversationId || agentState?.activeConversationId === ownerConversationId;
    const writeOwnerWorkflow = (wf) => {
        if(!ownerConversationId || !Array.isArray(agentState?.conversations)) return;
        const conv = agentState.conversations.find(c => c.id === ownerConversationId);
        if(conv) conv.workflow = wf || null;
    };
    const setOwnerWorkflow = (wf) => {
        writeOwnerWorkflow(wf);
        // 仅当用户仍停留在该对话时，才更新全局运行态/UI
        if(isOwnerConversation()) agentActiveWorkflow = wf;
    };
    const ownerWorkflow = () => {
        if(isOwnerConversation()) return agentActiveWorkflow;
        const conv = (agentState?.conversations||[]).find(c => c.id === ownerConversationId);
        return conv?.workflow || null;
    };
    const patchOwnerWorkflow = (fn) => {
        const wf = ownerWorkflow() || {id:uid('awf'),conversationId:ownerConversationId,nodeIds:[],steerQueue:[]};
        fn(wf);
        setOwnerWorkflow(wf);
        return wf;
    };
    try{
    // 执行入口：只执行 LLM 已写好的 generations，不再二次规划/改写业务步骤
    // 注意：必须在原数组上拆步/补索引，不能先 filter 出副本，否则 expand 写不回 assistantMsg
    if(!Array.isArray(assistantMsg?.generations)) assistantMsg.generations = [];
    const onlyIndexes = Array.isArray(options.onlyIndexes)
        ? options.onlyIndexes.map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 0)
        : [];
    const isRetryRun = !!(options.retry || onlyIndexes.length);
    let gens;
    if(isRetryRun){
        // 重试：绝不删掉消息里其他已完成/失败卡片，只挑选要重跑的步骤
        gens = assistantMsg.generations.filter((gen, idx) => {
            if(onlyIndexes.length) return onlyIndexes.includes(idx);
            // 未指定 index 时：重跑所有未成功项
            if(gen?.status === 'done' && (gen.results || []).length) return false;
            return !!gen;
        });
        gens.forEach(g => {
            g.status = 'running';
            g.error = '';
            g.results = [];
            // 安全拦截/上游 400 等失败：必须重新提交，不能复用旧失败节点
            g.runNodeId = '';
            g.outputNodeId = '';
            g.stopped = false;
        });
    } else {
        // 首次执行：丢掉已完成/失败步，保留待执行步（原数组）
        assistantMsg.generations = assistantMsg.generations.filter(gen=>!(gen.results||[]).length&&gen.status!=='done'&&gen.status!=='error');
        // 简单单图：再压一次，防止 LLM 仍拆成两套并行工作流
        try{ agentCollapseSimpleSingleShot(assistantMsg, userMsg?.text || ''); }catch(_){ }
        gens = assistantMsg.generations;
    }
    if(!gens.length)return;
    // 默认每步 1 张：除非用户原文明确多张且本步不是多步规划
    gens.forEach(g => {
        const n = Math.max(1, Math.min(8, Number(g.count) || 1));
        g.count = n;
    });
    if(!agentHost||agentHost.schemaVersion<2||!window.CanvasAgentPlanExecutor){
        gens.forEach(gen=>{gen.status='error';gen.error='当前版本不支持节点编排';});
        throw new Error('当前版本不支持 Agent 节点编排');
    }
    const providers=agentGenProviders();
    if(!providers.length){gens.forEach(gen=>{gen.status='error';gen.error=tr('smart.agentNeedGenModel');}); if(isOwnerConversation()){renderAgentMessages();saveAgentState();}else{saveAgentState();} return;}
    // 生图模型必须来自本任务发送时冻结的 Agent 选择，不读取后来切换对话后的全局菜单。
    const taskSettings = userMsg?.requestedSettings || {};
    const requestedGenProvider = String(taskSettings.genProvider || agentState.genProvider || '');
    const requestedGenModel = String(taskSettings.genModel || agentState.genModel || '');
    let providerId=providers.some(p=>p.id===requestedGenProvider)?requestedGenProvider:providers[0].id;
    let models=providerImageModels(providerId);
    let model=models.includes(requestedGenModel)?requestedGenModel:(models[0]||'');
    if(requestedGenModel && !models.includes(requestedGenModel)){
        // 若当前 provider 没有该模型，尝试在其他 provider 找回，保证节点模型 = Agent 选择
        const owner=providers.find(p=>providerImageModels(p.id||'').includes(requestedGenModel));
        if(owner){
            providerId=owner.id;
            models=providerImageModels(providerId);
            model=requestedGenModel;
        }
    }
    if(requestedGenModel && model !== requestedGenModel){
        console.warn('[canvas-agent] gen model fallback', {wanted:requestedGenModel, got:model, providerId});
    }
    // 执行前等待一次能力真相，避免模型切换后旧比例列表或 LLM 输出绕过界面校验。
    // expectedCapabilitiesKey 来自本任务 requestedSettings 冻结出的 provider/model，绝不读取当前 UI 能力镜像。
    const expectedCapabilitiesKey = agentImageParamsKey(providerId, model);
    const paramCapabilities = await agentRefreshImageParamCapabilities(providerId, model, {force:true});
    if(!expectedCapabilitiesKey || paramCapabilities?.key !== expectedCapabilitiesKey){
        gens.forEach(gen => {
            gen.status = 'error';
            gen.error = '模型能力快照与本任务模型不匹配，执行前已停止';
        });
        throw new Error(`执行前模型能力检查未通过：任务模型 ${providerId}/${model || '未选择'} 的能力响应不匹配`);
    }
    // 执行前硬校验：用户/策划明确比例不受支持时停止，禁止静默换成最近比例后继续扣费。
    const supportedRatios = Array.isArray(paramCapabilities?.ratios) ? paramCapabilities.ratios : [];
    const maxRefs = providerMaxReferenceImages(providerId);
    const preflightErrors = [];
    gens.forEach((gen, index) => {
        const requestedRatio = agentNormalizeRatioValue(gen?.ratio || chatRequestedRatioForGeneration(String(userMsg?.text || ''), gen || {}));
        if(requestedRatio && (!paramCapabilities?.loaded || !supportedRatios.includes(requestedRatio))){
            const supportedText = supportedRatios.length ? supportedRatios.map(agentRatioLabel).join('、') : '未读取到';
            preflightErrors.push(`第${index + 1}步要求 ${agentRatioLabel(requestedRatio)}，当前模型支持比例：${supportedText}`);
            gen.status = 'error';
            gen.error = '当前模型不支持该比例，执行前已停止';
        }
        const explicitRefs = Array.isArray(gen?.attachment_indices) ? new Set(gen.attachment_indices.map(Number)).size : 0;
        const prevRefReserve = (gen?.depends_on_previous || gen?.use_previous_results)
            ? Math.max(1, Number(gens[index - 1]?.count) || 1)
            : 0;
        if(explicitRefs + prevRefReserve > maxRefs){
            preflightErrors.push(`第${index + 1}步最多支持 ${maxRefs} 张参考图，当前任务至少需要 ${explicitRefs + prevRefReserve} 张`);
            gen.status = 'error';
            gen.error = '参考图数量超过当前模型限制，执行前已停止';
        }
    });
    if(preflightErrors.length){
        throw new Error(`执行前参数检查未通过：${preflightErrors.join('；')}`);
    }
    // lastResults 已禁用：本轮无参考图时不自动引用历史结果
    const attachments=agentCollectRunAttachments(userMsg);
    // 同一任务内参考图只落一次节点，后面步骤复用 nodeId，避免每步复制一份
    const sharedRefNodeCache = new Map();
    try{
        if(attachments.length){
            const anchor0 = agentHost?.getViewportAnchor?.({preferSelection:false}) || {x:80,y:80};
            agentMaterializeReferenceNodes(attachments, {x:Number(anchor0.x||80), y:Number(anchor0.y||80)}, {cache: sharedRefNodeCache, writeBack:true});
            if(Array.isArray(userMsg?.images)){
                userMsg.images.forEach(img => {
                    if(!img?.url) return;
                    const key = agentNormalizeRefUrl(img.url) || img.url;
                    if(sharedRefNodeCache.has(key)) img.nodeId = sharedRefNodeCache.get(key);
                });
            }
        }
    }catch(err){
        console.warn('[canvas-agent] pre-materialize attachments failed', err);
    }
    const sharedStyle = String(assistantMsg?.shared_style || gens.find(g => g?.shared_style)?.shared_style || '').trim();
    // attachment_indices、步骤数量和依赖关系以同一次 LLM 规划为准；
    // 仅对“后续独立步骤遗漏本轮附件索引”的结构缺口做最小补全。
    if(sharedStyle){
        assistantMsg.shared_style = sharedStyle;
        // shared_style 只作审计元数据；每张最终 prompt 已由同一次 LLM 定稿，执行层不再补写。
        gens.forEach(g => {
            if(!g.shared_style) g.shared_style = sharedStyle;
        });
    }
    // 用户本轮已上传/引用参考图时：按 attachment_indices 连线；缺省项已在上方补齐
    const userText = String(userMsg?.text || '');
    const hasUserAttachments = attachments.length > 0;
    try{ agentForceNoStaleLastOutputs(gens, userText, attachments); }catch(_){ }
    // LLM 可能只在第一步声明本轮参考图；对后续独立步骤补齐同一批用户附件。
    // 该补全发生在生成 step.references 之前，因此普通/智能画布都会真正建立连线。
    // 已明确的 attachment_indices、direct_refs 和前序依赖均保持不变。
    try{ agentBindMissingUserAttachmentIndices(gens, userText, attachments); }catch(_){ }
    const steps=gens.map((gen,index)=>{
        let refs=[];
        const depMode = agentNormalizeDependencyMode(gen.dependency_mode, gen.prompt || gen.professionalPrompt || '');
        const isPrevDep = !!(gen.depends_on_previous || gen.use_previous_results || depMode === 'product_reference' || depMode === 'fusion');
        if(Array.isArray(gen.direct_refs)&&gen.direct_refs.length && !isPrevDep) refs=gen.direct_refs.filter(x=>x?.url);
        else {
            // 依赖本轮前面结果的融合/产品参考步骤：前序结果在 plan executor 第二波注入
            // 跨轮 lastResults 仅在明确“改上一张”时使用，避免无参考图却挂上历史图
            gen.use_last_outputs = false; // 跨轮 lastResults 彻底关闭
            // no-op: stale last outputs disabled
            if(isPrevDep){
                // 依赖前序生成图时仍保留 LLM 明确选择的用户参考图；执行器会把两类引用合并。
                gen.depends_on_previous = true;
                gen.use_previous_results = true;
                if(depMode === 'none') gen.dependency_mode = 'product_reference';
                let idxs = Array.isArray(gen.attachment_indices) ? gen.attachment_indices.slice() : [];
                idxs = agentNormalizeAttachmentIndices(idxs, attachments.length);
                const useAttach = hasUserAttachments && (gen.use_attachments === true || idxs.length > 0);
                if(useAttach){
                    gen.use_attachments = true;
                    gen.attachment_indices = idxs.length ? idxs : Array.from({length:attachments.length}, (_, i) => i);
                    refs.push(...gen.attachment_indices.filter(i=>i>=0&&i<attachments.length).map(i=>attachments[i]).filter(Boolean));
                }else{
                    gen.use_attachments = false;
                    gen.attachment_indices = [];
                }
            } else {
                // 用户已提供产品/风格图的套图：即使 LLM 误标 depends_on_previous，也继续挂用户参考图
                // 薄落地+结构补全后：有索引或声明 use_attachments 时连参考图
                let idxs = Array.isArray(gen.attachment_indices) ? gen.attachment_indices.slice() : [];
                idxs = agentNormalizeAttachmentIndices(idxs, attachments.length);
                const useAttach = hasUserAttachments && (gen.use_attachments === true || idxs.length > 0);
                if(useAttach){
                    gen.use_attachments = true;
                    gen.attachment_indices = idxs.length ? idxs : Array.from({length:attachments.length}, (_, i) => i);
                    refs.push(...gen.attachment_indices.filter(i=>i>=0&&i<attachments.length).map(i=>attachments[i]).filter(Boolean));
                } else {
                    gen.use_attachments = false;
                    gen.attachment_indices = [];
                }
            }
        }
        // 薄落地：不再“有图就全挂 / 按步骤猜索引”
        // 关键：附件/参考图必须落到画布节点并带 nodeId，执行层才能连线
                if(refs.length){
            const anchor = agentHost?.getViewportAnchor?.({preferSelection:false}) || {x:80,y:80};
            // 复用任务级 cache：同一参考图 URL 不重复创建节点
            refs = agentMaterializeReferenceNodes(
                refs,
                {x:Number(anchor.x||80) - index * 20, y:Number(anchor.y||80)},
                {cache: sharedRefNodeCache, writeBack:true}
            );
            // 去重（按 URL）
            const seen = new Set();
            refs = refs.filter(r => {
                const key = agentNormalizeRefUrl(r?.url) || r?.url || '';
                if(!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            // 回写 attachments 上的 nodeId，供后续最终兜底逻辑使用
            refs.forEach(r => {
                const key = agentNormalizeRefUrl(r?.url) || r?.url || '';
                if(!key || !r?.nodeId) return;
                attachments.forEach(a => {
                    if(a && (agentNormalizeRefUrl(a.url) || a.url) === key) a.nodeId = r.nodeId;
                });
            });
            if(refs.length && refs.every(r => !r.nodeId)){
                console.warn('[canvas-agent] references have url but no nodeId; connections may be missing', refs);
            }
        }
        // 强绑定：同一次 LLM 输出的 prompt 原样进入规划卡、节点和真实 API 请求。
        // 执行层只负责参考图连线与参数，不再清洗、注释、补风格或制造变体。
        const professionalPrompt = String(gen.prompt || '').trim();
        gen.plannedPrompt = professionalPrompt;
        gen.userPrompt=userMsg?.text||'';
        gen.professionalPrompt=professionalPrompt;
        gen.prompt=professionalPrompt;
        // 参数来源：该步字段 > 用户原文+Agent规划回复+本步提示词 > 工具栏
        const settingsText = [
            userMsg?.text || '',
            assistantMsg?.text || '',
            assistantMsg?.plan ? JSON.stringify(assistantMsg.plan) : '',
            professionalPrompt || ''
        ].filter(Boolean).join('\n');
        // 用户在对话中明确写出的比例/分辨率/画质是最高优先级。
        // LLM 规划字段和工具栏只在用户没有指定时兜底，不能用默认 1:1/1K/auto 覆盖用户原话。
        const explicitUserText = String(userMsg?.text || '');
        const explicitUserRatio = chatRequestedRatioForGeneration(explicitUserText, gen);
        const explicitUserResolution = chatRequestedResolution(explicitUserText);
        const explicitUserQuality = chatRequestedQuality(explicitUserText);
        const plannedQuality = agentNormalizeQualityValue(gen.quality || '');
        const frozen = resolveAgentGenerationSettings(settingsText, {
            count: Math.max(1, Math.min(8, Number(gen.count) || 1)),
            ratio: explicitUserRatio || taskSettings.ratio || gen.ratio || '',
            resolution: explicitUserResolution || taskSettings.resolution || gen.resolution || '',
            quality: explicitUserQuality || taskSettings.quality || plannedQuality || ''
        });
        // count 以 LLM 该步字段为准；缺失时才看原文/工具栏
        const stepCount = Math.max(1, Math.min(8, Number(gen.count) || frozen.count || 1));
        const resolvedStepSettings = agentResolveStepGenerationSettings(explicitUserText, gen, {...frozen, prefer_task_settings:true});
        const stepRatio = resolvedStepSettings.ratio;
        const stepResolution = resolvedStepSettings.resolution;
        const stepQuality = resolvedStepSettings.quality;
        gen.resolvedSettings = {
            provider_id: providerId,
            model,
            ratio: stepRatio,
            resolution: stepResolution,
            quality: stepQuality,
            count: stepCount,
            sources: resolvedStepSettings.sources
        };
        gen.provider_id = providerId;
        gen.model = model;
        if(refs.length){
            gen.use_attachments = true;
            gen.refCount = refs.length;
            if(!Array.isArray(gen.attachment_indices) || !gen.attachment_indices.length){
                // 回填索引，方便对话卡显示 参考图#1/2
                const mapped = [];
                refs.forEach(r => {
                    const idx = attachments.findIndex(a => a && a.url && r && r.url && a.url === r.url);
                    if(idx >= 0 && !mapped.includes(idx)) mapped.push(idx);
                });
                if(mapped.length) gen.attachment_indices = mapped;
            }
        }
        
        // 规划层参考图角色：优先尊重 LLM notes/plan；缺省时用弱推断仅作回显
        try{
            const skillList = (Array.isArray(userMsg?.skills) && userMsg.skills.length) ? userMsg.skills : (agentState?.skills || []);
            const roleList = agentInferAttachmentRoles(attachments, userMsg?.text || '', skillList);
            gen.attachment_roles = roleList.slice();
            if(Array.isArray(gen.attachment_indices) && gen.attachment_indices.length){
                gen.planned_ref_labels = gen.attachment_indices.map(i => {
                    const n = Number(i) + 1;
                    return '参考图' + n + '（' + agentAttachmentRoleLabel(roleList[i], i) + '）';
                });
            }
        }catch(_){ }
return{
            id:`step_${index+1}`,
            title: String(gen.title || gen.role || `步骤${index+1}`),
            operation:(refs.length || gen.depends_on_previous)?'edit_image':'generate_image',
            user_prompt:userMsg?.text||'',
            planned_prompt: String(gen.plannedPrompt || gen.prompt || ''),
            professional_prompt:professionalPrompt,
            prompt_version:'canvas-agent-v2',
            input_artifact_ids: Array.isArray(gen.input_artifact_ids) ? gen.input_artifact_ids.slice() : [],
            output_artifact_id: String(gen.output_artifact_id || '').trim(),
            depends_on_steps: Array.isArray(gen.depends_on_steps) ? gen.depends_on_steps.slice() : [],
            depends_on_previous:!!gen.depends_on_previous,
            // 依赖模式以规划字段为准；不要因提示词含“主图/详情”等词误判成依赖前序
            dependency_mode: (() => {
                const raw = String(gen.dependency_mode || '').trim().toLowerCase();
                if(raw === 'fusion' || raw === 'product_reference' || raw === 'none') return raw;
                if(gen.depends_on_previous || gen.use_previous_results){
                    return agentLooksLikeFusionPrompt(professionalPrompt) ? 'fusion' : 'product_reference';
                }
                return 'none';
            })(),
            use_previous_results:!!(gen.use_previous_results || gen.depends_on_previous),
            use_last_outputs:!!gen.use_last_outputs,
            attachment_indices: Array.isArray(gen.attachment_indices) ? gen.attachment_indices.slice() : [],
            attachment_roles: Array.isArray(gen.attachment_roles) ? gen.attachment_roles.slice() : [],
            planned_ref_labels: Array.isArray(gen.planned_ref_labels) ? gen.planned_ref_labels.slice() : [],
            shared_style: String(gen.shared_style || sharedStyle || '').trim(),
            settings:{
                provider_id:providerId,
                model,
                ratio:stepRatio,
                resolution:stepResolution,
                quality:stepQuality,
                count:stepCount
            },
            references:refs.map(r=>({url:r.url,name:r.name||'reference',nodeId:r.nodeId||'',imageIndex:r.imageIndex??0}))
        };
    });
    // 旧的 Skill/并行任务依赖重写已停用：它会覆盖 LLM 已确定的 attachment_indices 和依赖关系。
    if(false){ try{
        agentSanitizeSkillIndependence(
            gens,
            userMsg?.text || '',
            (Array.isArray(userMsg?.skills) && userMsg.skills.length) ? userMsg.skills : (agentState?.skills || []),
            attachments
        );
        const keepUserSeriesFinal = agentShouldKeepUserAttachmentsForSeries(
            userMsg?.text || '',
            attachments,
            (Array.isArray(userMsg?.skills) && userMsg.skills.length) ? userMsg.skills : (agentState?.skills || [])
        );
        steps.forEach((step, idx) => {
            const g = gens[idx];
            if(!g || !step) return;
            if(keepUserSeriesFinal){
                g.depends_on_previous = false;
                g.use_previous_results = false;
                g.dependency_mode = 'none';
                g.use_attachments = attachments.length > 0;
                if(attachments.length && (!Array.isArray(g.attachment_indices) || !g.attachment_indices.length)){
                    g.attachment_indices = Array.from({length:attachments.length}, (_, i) => i);
                }
            }
            step.depends_on_previous = !!g.depends_on_previous;
            step.use_previous_results = !!g.depends_on_previous;
            step.dependency_mode = String(g.dependency_mode || (g.depends_on_previous ? 'product_reference' : 'none')).toLowerCase() || 'none';
            if(!step.depends_on_previous){
                step.dependency_mode = 'none';
                step.use_previous_results = false;
            }
            // 并行/套图任务：有用户参考图就必须保留 references
            const resolveStepRefs = (idxs) => (idxs || [])
                .map(i => attachments[i])
                .filter(Boolean)
                .map(r => {
                    const key = agentNormalizeRefUrl(r.url) || r.url || '';
                    const nodeId = r.nodeId || sharedRefNodeCache.get(key) || agentFindExistingImageNodeIdByUrl(r.url) || '';
                    if(nodeId && r && !r.nodeId) r.nodeId = nodeId;
                    return {url:r.url, name:r.name||'reference', nodeId, imageIndex:r.imageIndex??0};
                });
            // 并行/套图任务：有用户参考图就必须保留 references（必须带 nodeId，避免执行层再复制）
            if(!step.depends_on_previous && Array.isArray(step.references) && !step.references.length && Array.isArray(g.attachment_indices) && g.attachment_indices.length){
                const more = resolveStepRefs(g.attachment_indices);
                if(more.length){
                    step.references = more;
                    step.operation = 'edit_image';
                }
            }
            if(keepUserSeriesFinal && attachments.length){
                const idxs = Array.isArray(g.attachment_indices) && g.attachment_indices.length
                    ? g.attachment_indices
                    : Array.from({length:attachments.length}, (_, i) => i);
                const more = resolveStepRefs(idxs);
                if(more.length){
                    // 若本步已有带 nodeId 的 references，优先保留，只在缺失时回填
                    const current = Array.isArray(step.references) ? step.references.filter(r => r?.url) : [];
                    const currentHasNode = current.some(r => r.nodeId);
                    step.references = currentHasNode ? current.map(r => {
                        if(r.nodeId) return r;
                        const key = agentNormalizeRefUrl(r.url) || r.url || '';
                        return {...r, nodeId: sharedRefNodeCache.get(key) || agentFindExistingImageNodeIdByUrl(r.url) || ''};
                    }) : more;
                    step.operation = 'edit_image';
                    step.depends_on_previous = false;
                    step.dependency_mode = 'none';
                    step.use_previous_results = false;
                }
            }
            // 最终兜底：任何已有 references 都尽量补齐 nodeId
            if(Array.isArray(step.references) && step.references.length){
                step.references = step.references.map(r => {
                    if(!r?.url) return r;
                    if(r.nodeId) return r;
                    const key = agentNormalizeRefUrl(r.url) || r.url || '';
                    const nodeId = sharedRefNodeCache.get(key) || agentFindExistingImageNodeIdByUrl(r.url) || '';
                    return nodeId ? {...r, nodeId} : r;
                });
            }
        });
    }catch(_){ } }
    // 仅补齐已经由 LLM 选中的 reference 节点 id，不改变引用范围和执行顺序。
    steps.forEach(step => {
        if(!Array.isArray(step?.references)) return;
        step.references = step.references.map(ref => {
            if(!ref?.url || ref.nodeId) return ref;
            const key = agentNormalizeRefUrl(ref.url) || ref.url;
            const nodeId = sharedRefNodeCache.get(key) || agentFindExistingImageNodeIdByUrl(ref.url) || '';
            return nodeId ? {...ref, nodeId} : ref;
        });
    });
    // auto_run=true：由 plan executor 分波执行（独立生成并行 → 融合依赖串行）
    const plan={
        schema_version:1,
        intent:'generate_image',
        auto_run:true,
        artifacts:Array.isArray(assistantMsg?.plan?.artifacts) ? assistantMsg.plan.artifacts.map(item => ({...item})) : [],
        steps
    };
    agentSending=isOwnerConversation();const _wf0={...(isOwnerConversation()?(agentActiveWorkflow||{}):{}),id:(isOwnerConversation()?agentActiveWorkflow?.id:null)||uid('awf'),conversationId:ownerConversationId||agentState.activeConversationId,messageId:userMsg?.id||'',status:'creating_nodes',canvasKind:agentHost.canvasKind(),plan,nodeIds:[],steerQueue:(isOwnerConversation()?(agentActiveWorkflow?.steerQueue||[]):[]),createdAt:Date.now(),updatedAt:Date.now()};setOwnerWorkflow(_wf0);
    gens.forEach(g=>{ g.status = g.depends_on_previous ? 'waiting' : 'running'; g.error=''; });
    if(isOwnerConversation()){ renderAgentMessages(); saveAgentState(); } else { saveAgentState(); }
    try{
        if(agentStopRequested)throw new Error('任务已停止');
        let execution=null;
        try{
            const workflowLogs=[];
            if(assistantMsg){ assistantMsg.workflowLogs = workflowLogs; }
            patchOwnerWorkflow(wf=>{ wf.logs = workflowLogs; });
            execution=await window.CanvasAgentPlanExecutor.execute(plan,{
                workflowId:(ownerWorkflow()?.id||agentActiveWorkflow?.id||uid("awf")),
                conversationId:ownerConversationId,
                messageId:userMsg?.id||'',
                userPrompt:userMsg?.text||'',
                logs:workflowLogs,
                stopRequested:()=>!!agentStopRequested,
                onLog:(item)=>{
                    if(assistantMsg){ assistantMsg.workflowLogs = workflowLogs; }
                    patchOwnerWorkflow(wf=>{ wf.logs = workflowLogs; });
                    // 节流渲染：日志较多时也保持可见
                    if(!(ownerWorkflow()?._logRenderTimer)){
                        patchOwnerWorkflow(wf=>{ wf._logRenderTimer = setTimeout(()=>{
                            patchOwnerWorkflow(w=>{ w._logRenderTimer = 0; });
                            if(isOwnerConversation()){ renderAgentMessages(); saveAgentState(); }
                            else { try{ agentCaptureActiveConversation(); }catch(_){ } saveAgentState(); }
                        }, 250); });
                    }
                }
            });
        }catch(execError){
            // executor 失败时仍尽量回收已完成 entries
            execution={
                workflow:execError.workflow||agentActiveWorkflow,
                entries:Array.isArray(execError.entries)?execError.entries:[]
            };
            if(!execution.entries.length) throw execError;
            patchOwnerWorkflow(wf=>{ wf.error=String(execError.message||execError).slice(0,240); });
        }
        {
            const merged={...(isOwnerConversation()?(agentActiveWorkflow||{}):{}),...(execution.workflow||{}),conversationId:ownerConversationId||agentState.activeConversationId,steerQueue:(isOwnerConversation()?(agentActiveWorkflow?.steerQueue||[]):[]),nodeIds:execution.entries.flatMap(entry=>entry.nodeIds||[])};
            setOwnerWorkflow(merged);
        }
        // 同步 assistantMsg.generations（可能因追加融合步而变长）
        if(Array.isArray(assistantMsg.generations)){
            // gens 是过滤后的待跑列表；按原索引写回
            execution.entries.forEach(entry=>{
                const gen=gens[entry.index];
                if(gen){
                    gen.workflowId=(ownerWorkflow()?.id||agentActiveWorkflow?.id||"");
                    gen.canvasKind=agentHost.canvasKind();
                    // 融合步可能在运行前改写了提示词，回写到卡片
                    if(entry.step?.professional_prompt){
                        gen.prompt = entry.step.professional_prompt;
                        gen.professionalPrompt = entry.step.professional_prompt;
                    }
                    // 仅当步骤本身真的是前序依赖时才回写；Skill 独立风格步不要被重新打成依赖前序
                    if(entry.step?.depends_on_previous && String(entry.step?.dependency_mode || '').toLowerCase() !== 'none'){
                        gen.depends_on_previous = true;
                    }
                    if(entry.step?.dependency_mode){
                        gen.dependency_mode = entry.step.dependency_mode;
                        if(entry.step.dependency_mode === 'product_reference' || entry.step.dependency_mode === 'fusion'){
                            gen.depends_on_previous = true;
                            gen.use_attachments = false;
                        }else if(String(entry.step.dependency_mode).toLowerCase() === 'none'){
                            gen.depends_on_previous = false;
                            gen.use_previous_results = false;
                        }
                    }
                    if(Array.isArray(entry.step?.references) && entry.step.references.length){
                        gen.use_last_outputs = false;
                        gen.refCount = entry.step.references.filter(r => r?.url).length;
                    }
                    agentApplyEntryResultToGen(gen, entry);
                    if(entry.result?.outputNodeId) patchOwnerWorkflow(wf=>{ if(!Array.isArray(wf.nodeIds)) wf.nodeIds=[]; wf.nodeIds.push(entry.result.outputNodeId); });
                }else if(entry.phase === 'dependent' && entry.result?.status === 'failed'){
                    // 追加显示被跳过的融合步骤
                    const skipGen = {
                        prompt: entry.step?.professional_prompt || entry.step?.prompt || '融合步骤',
                        count: 1,
                        depends_on_previous: true,
                        use_last_outputs: false,
                        results: [],
                        status: 'error',
                        error: entry.result?.error || '前置步骤未完成，已跳过融合'
                    };
                    gens.push(skipGen);
                    if(Array.isArray(assistantMsg.generations) && !assistantMsg.generations.includes(skipGen)){
                        assistantMsg.generations.push(skipGen);
                    }
                }
            });
            if(execution.logs && assistantMsg){
                assistantMsg.workflowLogs = execution.logs;
            }
        }
        // 兜底：若 executor 未跑某些条目，再按依赖分波运行
        const pendingEntries=execution.entries.filter(entry=>!entry.result);
        if(pendingEntries.length){
            const indep=pendingEntries.filter(e=>!e.step?.depends_on_previous && !e.step?.use_previous_results);
            const dep=pendingEntries.filter(e=>e.step?.depends_on_previous || e.step?.use_previous_results);
            const waves=(indep.length && dep.length)?[indep,dep]:[pendingEntries];
            for(let wi=0; wi<waves.length; wi++){
                const wave=waves[wi];
                if(wi>0 || wave.some(e=>e.step?.depends_on_previous)){
                    const prevImages=execution.entries.flatMap(e=>(e.result?.images||[]).map(img=>({url:img.url,name:img.name||'previous',nodeId:img.nodeId||e.result?.outputNodeId||e.outputNodeId||e.runNodeId||''}))).filter(x=>x.url);
                    const productImage = prevImages.slice(0, 1);
                    for(const entry of wave){
                        if(!entry.runNodeId || !prevImages.length) continue;
                        const node=agentHost.getNode(entry.runNodeId);
                        if(node && agentHost.updateNode){
                            const mode = String(entry.step?.dependency_mode || '').toLowerCase();
                            // product_reference 只挂产品定稿 1 张；fusion 挂全部前序成功图；都不要叠节点旧附件
                            const merged = (mode === 'product_reference' ? productImage : prevImages).filter(r => r?.url);
                            agentHost.updateNode(entry.runNodeId,{
                                references:merged,
                                // 不改写 LLM 提示词，只补参考图与运行态
                                status:'running',
                                pending:Math.max(1,Number(node.pending)||1),
                                title: node.title || '生成中...'
                            });
                        }
                    }
                }
                const settled=await Promise.all(wave.map(async entry=>{
                    try{ return await agentHost.runNode(entry.runNodeId,{workflowId:(ownerWorkflow()?.id||agentActiveWorkflow?.id||"")}); }
                    catch(err){ return {status:'failed',nodeId:entry.runNodeId,outputNodeId:entry.outputNodeId||'',images:[],error:String(err.message||err)}; }
                }));
                settled.forEach((result,i)=>{
                    const entry=wave[i];
                    entry.result=result;
                    const gen=gens[entry.index];
                    agentApplyEntryResultToGen(gen, entry);
                    if(result?.outputNodeId){
                        patchOwnerWorkflow(wf=>{
                            if(!Array.isArray(wf.nodeIds)) wf.nodeIds=[];
                            wf.nodeIds.push(result.outputNodeId);
                        });
                    }
                });
            }
        }
        // 收尾强同步：有结果必 done；工作流已完成时禁止残留 running/waiting 转圈
        gens.forEach((g, i) => {
            if(!g) return;
            if((g.results||[]).length && g.status !== 'done'){
                g.status = 'done';
                g.error = '';
            }
        });
        // 若 executor entries 有结果但 gens 漏写，按 index 再补一次
        try{
            (execution?.entries||[]).forEach(entry => {
                const gen = gens[entry.index];
                if(gen) agentApplyEntryResultToGen(gen, entry);
            });
        }catch(_){}
        // 工作流完成/失败时，仍卡在 running/waiting 且无结果的步骤标失败，避免右侧永久转圈
        if(!agentStopRequested){
            gens.forEach(g => {
                if(!g) return;
                if((g.status==='running' || g.status==='waiting' || !g.status) && !(g.results||[]).length){
                    // 若同 message 下画布节点其实已完成，尽量按 runNodeId 回读
                    try{
                        const nodeId = g.runNodeId || g.outputNodeId || '';
                        const node = nodeId && agentHost?.getNode ? agentHost.getNode(nodeId) : null;
                        const imgs = (node?.images||[]).filter(x=>x?.url);
                        if(imgs.length || node?.status==='completed'){
                            g.results = imgs.map(img=>({...img, nodeId: nodeId}));
                            g.status = 'done';
                            g.error = '';
                            if(node?.professionalPrompt){
                                g.prompt = node.professionalPrompt;
                                g.professionalPrompt = node.professionalPrompt;
                            }
                            return;
                        }
                    }catch(_){}
                }
            });
        }
        const hasError=gens.some(g=>g.status==='error');
        const hasDone=gens.some(g=>g.status==='done');
        const stillRunning=gens.some(g=>g.status==='running'||g.status==='waiting');
        patchOwnerWorkflow(wf=>{
            wf.status=agentStopRequested?'stopped':(hasError && hasDone?'completed_with_errors':hasError?'failed':(stillRunning?'running':'completed'));
            wf.updatedAt=Date.now();
        });
        // 最终再刷一次卡片状态，避免“节点完成但右侧仍转圈”
        if(isOwnerConversation()){
            try{ renderAgentMessages(); saveAgentState(true); }catch(_){ saveAgentState(true); }
        }else{
            try{ saveAgentState(true); }catch(_){}
        }
    }catch(error){
        const stopped=agentStopRequested||ownerWorkflow()?.status==='stopping'||String(error.message||error).includes('停止');
        // 只把仍在 running 且没有结果的项标失败；已成功的 done 必须保留
        gens.forEach(gen=>{
            if(gen.status==='done' && (gen.results||[]).length) return;
            if(gen.status==='running' || !gen.status){
                gen.status=stopped?'stopped':'error';
                gen.error=stopped?'已停止':String(error.message||error).slice(0,200);
            }
        });
        patchOwnerWorkflow(wf=>{
            wf.status=stopped?'stopped':'failed';
            wf.error=stopped?'':String(error.message||error);
            wf.updatedAt=Date.now();
        });
    }
    finally{
        // 对话隔离：收尾只写回所属对话；若用户已切走，不污染当前对话 UI
        const wf = ownerWorkflow();
        if(wf){
            writeOwnerWorkflow(wf);
        }
        // generations 是就地更新的，不会再次触发 message push；收尾时必须显式刷新任务所属对话的完成/失败摘要。
        try{
            if(assistantMsg && ownerConversationId){
                const ownerMessages = agentEnsureConversationMessages(ownerConversationId);
                if(ownerMessages && !ownerMessages.includes(assistantMsg)) ownerMessages.push(assistantMsg);
            }
            agentRefreshConversationMemory(ownerConversationId);
        }catch(_){ }
        // 全局发送锁释放：后台任务结束也要让当前对话能继续发
        agentSending=false;
        // 给宿主最后一次输出选区同步留出缓冲；随后用户点击任意图片会由
        // agentSelectionGhostClickHandler 显式加入，而不是被动继承。
        agentSuppressSelectionGhostSyncUntil = Date.now() + 1500;
        if(agentThinkingConversationId === ownerConversationId || isOwnerConversation()){
            agentThinking=false;
            if(agentThinkingConversationId === ownerConversationId) agentThinkingConversationId = '';
        }
        if(isOwnerConversation()){
            updateAgentPrimaryAction();
            renderAgentMessages();saveAgentState();
            // 任务进行中禁止排队插话后，这里不再自动吞队列发送
            if(Array.isArray(agentActiveWorkflow?.steerQueue) && agentActiveWorkflow.steerQueue.length){
                agentActiveWorkflow.steerQueue = [];
            }
        }else{
            // 仍保存所属对话快照，绝不把结果渲染到当前新对话
            try{
                const conv=(agentState.conversations||[]).find(c=>c.id===ownerConversationId);
                if(conv && wf){
                    conv.workflow = {...wf, status: wf.status || 'completed', updatedAt: Date.now()};
                }
                // 同步所属对话消息（assistantMsg 已在该对话 messages 内被就地更新）
                if(assistantMsg && ownerConversationId){
                    const msgs = agentEnsureConversationMessages(ownerConversationId);
                    if(msgs && !msgs.includes(assistantMsg)) msgs.push(assistantMsg);
                }
            }catch(_){}
            // 刷新当前对话 UI（不带后台结果），确保停止按钮恢复为发送
            updateAgentPrimaryAction();
            saveAgentState();
        }
    }
    } finally {
        window.__canvasAgentGenRunning = false;
        if(acquiredTaskHere){
            agentReleaseGlobalTask(ownerConversationId);
            updateAgentPrimaryAction();
        }
    }
};

function mountCanvasAgent(){
    if(canvasAgentMounted) return;
    canvasAgentMounted = true;
    const classicToolbar = document.querySelector('#quickToolbar .toolbar-fixed');
    if(classicToolbar && agentToggle){
        agentToggle.classList.add('canvas-agent-classic-toggle', 'tool-btn');
        // 普通画布：放在资产库按钮右侧
        const classicAsset = document.getElementById('canvasAssetToggle');
        if(classicAsset && classicAsset.parentElement === classicToolbar){
            classicToolbar.insertBefore(agentToggle, classicAsset.nextSibling);
        }else{
            classicToolbar.insertBefore(agentToggle, document.getElementById('workflowTransferToggle'));
        }
    } else if(agentToggle){
        // 智能画布：放在「资产库」右侧（视觉最右侧，不与原按钮叠加）
        try{
            const assetBtn = document.getElementById('assetToggle');
            const shellEl = document.getElementById('shell') || document.body;
            agentToggle.classList.remove('canvas-agent-classic-toggle');
            if(assetBtn && assetBtn.parentElement){
                assetBtn.parentElement.insertBefore(agentToggle, assetBtn.nextSibling);
            } else if(agentToggle.parentElement !== shellEl){
                shellEl.appendChild(agentToggle);
            }
        }catch(_){ }
    }
    initAgentPanel();
    const freezeSendSelection = event => {
        agentSnapshotSelectedImagesForSend();
        event.stopPropagation();
    };
    smartSendAgentBtn?.addEventListener('pointerdown', freezeSendSelection, true);
    smartSendAgentBtn?.addEventListener('mousedown', freezeSendSelection, true);
    smartSendAgentBtn?.addEventListener('click', event => {
        const frozenSelection = agentSnapshotSelectedImagesForSend();
        event.preventDefault();
        event.stopPropagation();
        attachSelectedImages(frozenSelection);
        agentSendSelectionSnapshot = [];
    }, true);
    selectionTimer = window.setInterval(syncAgentSelectionButton, 250);
    document.addEventListener('pointerdown', agentTrackSelectionGesture, true);
    document.addEventListener('pointerdown', agentClassicOutputGhostPointerDownHandler, true);
    document.addEventListener('click', agentSelectionGhostClickHandler, true);
    document.addEventListener('pointerup', agentSelectionGhostClickHandler, true);
    syncAgentSelectionButton();
    agentAutoResizeInput();
    if(window.StudioI18n) window.StudioI18n.apply();
    if(window.lucide) window.lucide.createIcons();
}

function unmountCanvasAgent(){
    if(selectionTimer) window.clearInterval(selectionTimer);
    selectionTimer = 0;
    agentSendSelectionSnapshot = [];
    document.removeEventListener('click', agentSelectionGhostClickHandler, true);
    document.removeEventListener('pointerup', agentSelectionGhostClickHandler, true);
    document.removeEventListener('pointerdown', agentTrackSelectionGesture, true);
    document.removeEventListener('pointerdown', agentClassicOutputGhostPointerDownHandler, true);
    endAgentStream();
    document.getElementById('agentToggle')?.remove();
    document.getElementById('smartSendAgentBtn')?.remove();
    document.getElementById('agentPanel')?.remove();
    document.getElementById('canvas-agent-plugin-root')?.remove();
    canvasAgentMounted = false;
}


// ===== THIN_LAND_OVERRIDES_V1: 薄落地覆盖厚加固（保持面板可挂载） =====
function agentNormalizePromptText(prompt=''){
    return String(prompt || '').replace(/\s+/g, ' ').trim();
}
function agentPromptsAreNearlySame(a='', b=''){
    const x = agentNormalizePromptText(a);
    const y = agentNormalizePromptText(b);
    if(!x || !y) return false;
    if(x === y) return true;
    if(x.length >= 12 && y.length >= 12 && (x.includes(y) || y.includes(x))) return true;
    return false;
}
function agentNormalizeAttachmentIndices(raw, attachCount){
    const n = Math.max(0, Number(attachCount) || 0);
    if(n <= 0) return [];
    const arr = Array.isArray(raw) ? raw : [];
    let nums = arr.map(x => Number(x)).filter(x => Number.isFinite(x)).map(x => Math.floor(x));
    // 仅当出现越界值（>=n）时，才按 1-based 转换。
    // 否则 [1] 在 n=2 时会是合法的 0-based 第二张，不能误改成 [0]。
    // 例：
    // - [1,2] + n=2 → 1-based → [0,1]
    // - [1]   + n=2 → 0-based 第二张，保持 [1]
    // - [0,1] + n=2 → 0-based，保持
    if(nums.length && nums.some(x => x >= n) && nums.every(x => x >= 1 && x <= n)){
        nums = nums.map(x => x - 1);
    }
    const out = [];
    const seen = new Set();
    for(const idx of nums){
        if(idx >= 0 && idx < n && !seen.has(idx)){
            seen.add(idx);
            out.push(idx);
        }
    }
    return out;
}
function agentInferAttachmentIndicesForGeneration(g, userText='', attachCount=0, stepIndex=0, stepCount=1, skills=[]){
    const n = Math.max(0, Number(attachCount) || 0);
    if(n <= 0 || !g) return [];
    let idxs = agentNormalizeAttachmentIndices(g.attachment_indices, n);
    if(idxs.length) return idxs;
    const fromPrompt = (typeof agentExtractAttachmentIndicesFromText === 'function')
        ? agentExtractAttachmentIndicesFromText(g.prompt || '', n)
        : [];
    if(fromPrompt.length) return fromPrompt;
    const fromUser = (typeof agentExtractAttachmentIndicesFromText === 'function')
        ? agentExtractAttachmentIndicesFromText(userText || '', n)
        : [];
    if(fromUser.length) return fromUser;
    const tAll = `${userText || ''}\n${g.prompt || ''}`;
    const skillList = skills && skills.length ? skills : ((typeof agentState !== 'undefined' && agentState?.skills) || []);
    const keepUserSeries = agentShouldKeepUserAttachmentsForSeries(
        userText,
        Array.from({length:n}, () => ({url:'x'})),
        skillList
    );
    if(keepUserSeries || (agentHasActiveSkills(skillList) && n >= 1 && stepCount >= 2)){
        return Array.from({length:n}, (_, i) => i);
    }
    if(stepCount >= 2 && n >= 2 && stepIndex < n){
        const looksIndependent = !g.depends_on_previous
            && String(g.dependency_mode || 'none').toLowerCase() !== 'fusion'
            && !/(融合|合在一起|同框|一起|合成)/.test(tAll)
            && !/(主图|详情|套图|系列|整套|多页)/.test(tAll)
            && (/(分别|各自|每张|一对一)/.test(tAll) || (typeof agentLooksLikePerReferenceEdit === 'function' && agentLooksLikePerReferenceEdit(userText, n)));
        if(looksIndependent) return [stepIndex];
    }
    if(g.use_attachments === true
        || g.role === 'edit'
        || /(参考图|附件|这张|这些|这个|改成|变成|换成|基于|依据|保持|产品|风格)/.test(tAll)){
        return Array.from({length:n}, (_, i) => i);
    }
    return [];
}

function agentStructureValidateGenerations(gens, userText='', attachments=[], skillsArg=[]){
    const warnings = [];
    const errors = [];
    const list = Array.isArray(gens) ? gens : [];
    const attachCount = Array.isArray(attachments) ? attachments.filter(a => a && a.url).length : 0;
    if(!list.length) return { ok:true, warnings, errors, generations: [] };
    const cleaned = [];
    list.forEach((g, i) => {
        if(!g || typeof g !== 'object') return;
        const prompt = agentNormalizePromptText(g.prompt || '');
        if(!prompt){ errors.push('步骤' + (i+1) + ' 提示词为空'); return; }
        if(typeof agentPromptLooksLikeQuestion === 'function' && agentPromptLooksLikeQuestion(prompt)){
            errors.push('步骤' + (i+1) + ' 提示词是询问句，不能直接生图'); return;
        }
        const rawCount = Number(g.count);
        const count = Math.max(1, Math.min(8, rawCount || 1));
        if(Number.isFinite(rawCount) && rawCount !== count) warnings.push('步骤' + (i+1) + ' count 已夹到 1~8');
        const skills = Array.isArray(skillsArg) && skillsArg.length
            ? skillsArg
            : ((agentState && agentState.skills) || []);
        let indices = agentInferAttachmentIndicesForGeneration(g, userText, attachCount, i, list.length, skills);
        let dependsPrev = !!g.depends_on_previous;
        let depMode = String(g.dependency_mode || 'none').toLowerCase();
        if(agentShouldKeepUserAttachmentsForSeries(userText, attachments, skills)){
            dependsPrev = false;
            depMode = 'none';
            if(attachCount > 0 && !indices.length){
                indices = Array.from({length:attachCount}, (_, j) => j);
            }
        }
        cleaned.push(Object.assign({}, g, {
            prompt,
            count,
            attachment_indices: indices,
            use_attachments: attachCount > 0
                ? (indices.length > 0 || g.use_attachments === true || agentShouldKeepUserAttachmentsForSeries(userText, attachments, skills))
                : false,
            use_last_outputs: false,
            depends_on_previous: dependsPrev,
            use_previous_results: false,
            dependency_mode: dependsPrev ? depMode : 'none',
            results: Array.isArray(g.results) ? g.results : [],
            status: g.status || 'running'
        }));
    });
    if(attachCount > 0){
        const anyUses = cleaned.some(g => g.use_attachments || (g.attachment_indices || []).length);
        if(!anyUses){
            cleaned.forEach(g => {
                g.use_attachments = true;
                g.attachment_indices = Array.from({length:attachCount}, (_, i) => i);
            });
            warnings.push('本轮有参考图但规划未声明索引，已自动挂上全部参考图');
        }
        if(agentShouldKeepUserAttachmentsForSeries(userText, attachments,
            Array.isArray(skillsArg) && skillsArg.length ? skillsArg : ((agentState && agentState.skills) || []))){
            cleaned.forEach(g => {
                g.depends_on_previous = false;
                g.use_previous_results = false;
                g.dependency_mode = 'none';
                g.use_attachments = true;
                if(!Array.isArray(g.attachment_indices) || !g.attachment_indices.length){
                    g.attachment_indices = Array.from({length:attachCount}, (_, i) => i);
                }
            });
        }
    }
    if(cleaned.length >= 2){
        const prompts = cleaned.map(g => g.prompt);
        let samePairs = 0;
        for(let i=0;i<prompts.length;i++){
            for(let j=i+1;j<prompts.length;j++){
                if(agentPromptsAreNearlySame(prompts[i], prompts[j])) samePairs++;
            }
        }
        if(samePairs > 0) warnings.push('多步提示词存在高度同质，将按 LLM 原文执行（不再模板重写）');
        if(new Set(prompts.map(agentNormalizePromptText)).size === 1) warnings.push('多步 generations 的提示词完全相同');
    }
    if(!cleaned.length) errors.push('没有可执行的 generations 步骤');
    return { ok: errors.length === 0, warnings, errors, generations: cleaned };
}
function agentThinLandGenerations(gens, userText='', attachments=[], defaults={}){
    const attachCount = Array.isArray(attachments) ? attachments.filter(a => a && a.url).length : 0;
    const list = Array.isArray(gens) ? gens : [];
    const skills = (defaults && defaults.skills) || (agentState && agentState.skills) || [];
    const keepUserSeries = agentShouldKeepUserAttachmentsForSeries(userText, attachments, skills);
    const allowPrevPad = agentLooksLikeExplicitProductDraftChain(userText) || agentLooksLikeExplicitFusion(userText);
    return list.map((g, i) => {
        const prompt = agentNormalizePromptText(g.prompt || '');
        let count = Math.max(1, Math.min(8, Number(g.count) || 1));
        if(list.length > 1 && (!Number(g.count) || Number(g.count) <= 0)) count = 1;
        // LLM 已给 attachment_indices 时优先保留（规划编号=执行连线）
        let indices = Array.isArray(g.attachment_indices) && g.attachment_indices.length
            ? agentNormalizeAttachmentIndices(g.attachment_indices, attachCount)
            : agentInferAttachmentIndicesForGeneration(g, userText, attachCount, i, list.length, skills);
        let useAttach = false;
        if(attachCount > 0){
            if(g.use_attachments === false && !indices.length && !keepUserSeries) useAttach = false;
            else if(indices.length) useAttach = true;
            else if(g.use_attachments === true || keepUserSeries) useAttach = true;
        }
        if(useAttach && !indices.length && attachCount > 0){
            indices = Array.from({length:attachCount}, (_, j) => j);
        }
        let dependsPrev = !!g.depends_on_previous || !!g.use_previous_results;
        let depMode = String(g.dependency_mode || '').toLowerCase() || 'none';
        if(dependsPrev && depMode !== 'fusion' && depMode !== 'product_reference'){
            depMode = 'product_reference';
        }
        if(!dependsPrev) depMode = 'none';
        // 用户已提供产品/风格参考图时：禁止后续页依赖第1张生成图当垫图
        // Skill 只影响规划/提示词；这里只修正错误依赖判断
        if(attachCount === 0 && !allowPrevPad && !agentLooksLikeExplicitFusion(userText) && /主图|详情|套图|系列|整套|多页|电商|表情|分镜/.test(String(userText||''))){
            dependsPrev = false;
            depMode = 'none';
        }
        if(keepUserSeries || (attachCount > 0 && !allowPrevPad && (agentHasActiveSkills(skills) || /主图|详情|套图|系列|整套|多页|电商/.test(String(userText||''))))){
            dependsPrev = false;
            depMode = 'none';
            useAttach = attachCount > 0;
            if(attachCount > 0 && !indices.length){
                indices = Array.from({length:attachCount}, (_, j) => j);
            }
        }else if(agentHasActiveSkills(skills) && !allowPrevPad && !agentLooksLikeExplicitSeriesOrFusion(userText)){
            dependsPrev = false;
            depMode = 'none';
        }
        if(attachCount > 0 && !dependsPrev){
            if(!indices.length){
                indices = Array.from({length:attachCount}, (_, j) => j);
            }
            useAttach = true;
        }
        return Object.assign({}, g, {
            id: g.id || ('step_' + (i+1)),
            prompt,
            count,
            ratio: g.ratio || (defaults && defaults.ratio) || '',
            resolution: g.resolution || (defaults && defaults.resolution) || '',
            attachment_indices: indices,
            use_attachments: useAttach,
            use_last_outputs: false,
            depends_on_previous: dependsPrev,
            use_previous_results: false,
            dependency_mode: depMode,
            shared_style: g.shared_style || (defaults && defaults.shared_style) || '',
            results: Array.isArray(g.results) ? g.results : [],
            status: g.status || 'running'
        });
    });
}

function agentApplyComplexRequestGuards(parsed, userText, attachments, skillsArg=[]){
    if(!parsed || typeof parsed !== 'object') return parsed;
    if(!Array.isArray(parsed.options)) parsed.options = [];
    if(!Array.isArray(parsed.generations)) parsed.generations = [];
    if(!Array.isArray(parsed.prompts)) parsed.prompts = [];
    if(parsed.options.length) return parsed;
    if(parsed.generations.length){
        parsed.generations = agentThinLandGenerations(parsed.generations, userText, attachments, {
            shared_style: parsed.shared_style || '',
            skills: Array.isArray(skillsArg) && skillsArg.length ? skillsArg : ((agentState && agentState.skills) || [])
        });
        const check = agentStructureValidateGenerations(parsed.generations, userText, attachments,
            Array.isArray(skillsArg) && skillsArg.length ? skillsArg : ((agentState && agentState.skills) || []));
        parsed.generations = check.generations;
        parsed._structure = { warnings: check.warnings, errors: check.errors, ok: check.ok };
        if(!check.ok){
            const msg = check.errors.join('；');
            if(msg && !String(parsed.reply || '').includes(msg)){
                parsed.reply = (String(parsed.reply || '').trim() + '\n\n⚠️ 规划结构未通过检查：' + msg + '。请重新说明需求后我再规划。').trim();
            }
            parsed.generations = [];
        }else if(check.warnings.length){
            parsed._structureWarnings = check.warnings.slice();
        }
    }
    return parsed;
}
// 以下厚加固全部短路：不再改写表情 / 拆步 / 姿势库 / 二次展开
function agentEnsurePlanStepsFromUserIntent(assistantMsg, userMsg){ return assistantMsg; }
function agentHydrateGenerationsFromPlanText(parsed, userText=''){ return parsed; }
function agentExpandPerReferenceGenerations(gens, userText, attachCount){ return gens; }
function agentCollapseSimpleSingleShot(parsed, userText){ return parsed; }
function agentBuildStoryFramePrompt(basePrompt, label, index=0, total=3, style=''){ return String(basePrompt || '').trim(); }
function agentBuildVariantPrompt(basePrompt, label, index, total, style=''){ return String(basePrompt || '').trim(); }
function agentBuildStepPromptFromBase(basePrompt, label, index, total, style=''){ return String(basePrompt || '').trim(); }
function agentEmotionActionLine(label=''){ return ''; }
// 薄落地依赖绑定：只把 LLM 已规划的“定稿/主图/详情”语义映射到
// product_reference，或把明确的正向融合映射到 fusion；不重写 prompt、
// 不补姿势/表情、不追加隐藏步骤。该函数位于文件末尾，覆盖早期旧版
// 厚加固实现，确保运行时真正采用薄落地策略。
function agentMarkGenerationDependencies(gens, userText='', sharedStyle=''){
    if(!Array.isArray(gens) || !gens.length) return gens;
    const text = String(userText || '').trim();
    const isNegatedFusion = /(?:不要|不需要|无需|不能|不可|不得|禁止|严禁|避免|取消|去掉|不再|不是|并非|而非|不做|不进行)[^。；;，,\n]{0,20}(?:融合|合成|组合|结合|拼在一起|同框|放在一起)/.test(text);
    const positiveFusion = !isNegatedFusion && (
        typeof agentHasPositiveFusionIntent === 'function'
            ? agentHasPositiveFusionIntent(text)
            : /(?:融合|合成|组合|结合|拼在一起|同框|放在一起|打架|互动|对峙|追逐)/.test(text)
    );
    const seriesIntent = /主图|详情(?:页|图)?|套图|系列|整套|多页|电商|产品页|海报/.test(text);
    const anchorIntent = typeof agentExplicitGeneratedAnchorRequirements === 'function'
        && !!agentExplicitGeneratedAnchorRequirements(text, gens);
    // 否定融合优先级最高：即使句子里有“再/1张”等串行触发词，
    // 也不能让 chain detector 生成 fusion 需求，避免挡住产品参考归一化。
    const chainReq = !isNegatedFusion && typeof agentExplicitGeneratedChainRequirements === 'function'
        ? agentExplicitGeneratedChainRequirements(text, gens)
        : null;

    // 明确“不要融合”时，清掉 LLM 偶发的 fusion 标记，但不碰其提示词。
    if(isNegatedFusion && !positiveFusion){
        gens.forEach(g => {
            if(!g || String(g.dependency_mode || '').toLowerCase() !== 'fusion') return;
            g.dependency_mode = 'none';
            g.depends_on_previous = false;
            g.use_previous_results = false;
            g.use_last_outputs = false;
            g.depends_on_steps = [];
        });
    }

    // 单一产品/人物定稿派生主图或详情页：后续步骤只依赖第 1 步。
    // 显式融合链优先级更高，避免“猫和狗打架”被系列关键词吞掉。
    if((seriesIntent || anchorIntent) && !positiveFusion && !chainReq){
        const firstId = String(gens[0]?.id || 'step_1').trim() || 'step_1';
        gens.forEach((g, index) => {
            if(!g) return;
            if(index === 0){
                g.dependency_mode = 'none';
                g.depends_on_previous = false;
                g.use_previous_results = false;
                g.use_last_outputs = false;
                g.depends_on_steps = [];
                return;
            }
            g.dependency_mode = 'product_reference';
            g.depends_on_previous = true;
            g.use_previous_results = true;
            g.use_last_outputs = false;
            g.depends_on_steps = [firstId];
        });
    }
    // 任务明确要求正向融合时，只补齐依赖字段，不拼接或改写 prompt。
    if(positiveFusion && chainReq){
        const start = Math.max(1, Number(chainReq.dependentStart) || 1);
        const foundationIds = gens.slice(0, start).map((g, i) => String(g?.id || `step_${i + 1}`).trim() || `step_${i + 1}`);
        gens.forEach((g, index) => {
            if(!g || index < start) return;
            g.dependency_mode = 'fusion';
            g.depends_on_previous = true;
            g.use_previous_results = true;
            g.use_last_outputs = false;
            g.depends_on_steps = foundationIds.slice();
        });
    }
    return gens;
}
function agentNormalizeDependencyMode(mode, prompt=''){
    const m = String(mode || '').trim().toLowerCase();
    if(m === 'fusion' || m === 'product_reference' || m === 'none') return m;
    return 'none';
}
function agentEnsureGenerationAttachmentIndices(gens, userText, attachCount){
    const n = Math.max(0, Number(attachCount) || 0);
    if(!Array.isArray(gens)) return gens;
    gens.forEach((g, i) => {
        if(!g) return;
        if(n <= 0){
            g.use_attachments = false;
            g.attachment_indices = [];
            return;
        }
        let idxs = agentInferAttachmentIndicesForGeneration(g, userText, n, i, gens.length);
        g.attachment_indices = idxs;
        if(idxs.length) g.use_attachments = true;
        else if(g.use_attachments === true){
            // 声明要用但没索引：默认全挂，保证会连线
            g.attachment_indices = Array.from({length:n}, (_, j) => j);
        }else{
            g.use_attachments = false;
            g.attachment_indices = [];
        }
    });
    return gens;
}
// 执行前的最小结构补全：LLM 有时只在第一步写出 attachment_indices，
// 后续同属本轮的独立生图步骤会遗漏索引，导致只有第一个节点真正连线。
// 这里只补“空索引”，绝不覆盖 LLM 已明确指定的图号或同计划前序依赖。
function agentBindMissingUserAttachmentIndices(gens, userText='', attachments=[]){
    if(!Array.isArray(gens) || !gens.length) return gens;
    const refs = (Array.isArray(attachments) ? attachments : []).filter(item => item?.url);
    const n = refs.length;
    if(!n) return gens;
    const all = Array.from({length:n}, (_, i) => i);
    const explicit = gens.some(g => {
        if(!g) return false;
        const idx = agentNormalizeAttachmentIndices(g.attachment_indices, n);
        return idx.length > 0 || g.use_attachments === true;
    });
    if(!explicit) return gens;
    const text = String(userText || '');
    const perReference = /分别|各自|每张|一对一|单独(?:把|将|对)?/.test(text)
        && gens.length === n;
    const used = new Set();
    gens.forEach(g => {
        if(!g) return;
        const depMode = String(g.dependency_mode || '').toLowerCase();
        if(g.depends_on_previous || g.use_previous_results || depMode === 'fusion' || depMode === 'product_reference') return;
        const idx = agentNormalizeAttachmentIndices(g.attachment_indices, n);
        if(idx.length){
            g.attachment_indices = idx;
            g.use_attachments = true;
            idx.forEach(i => used.add(i));
            return;
        }
        // 已有 direct_refs 的步骤由其 URL 引用控制，不再重复注入全部附件。
        if(Array.isArray(g.direct_refs) && g.direct_refs.some(r => r?.url)) return;
        const bind = perReference
            ? [all.find(i => !used.has(i)) ?? 0]
            : all.slice();
        g.attachment_indices = bind;
        g.use_attachments = true;
        bind.forEach(i => used.add(i));
    });
    return gens;
}
function agentLooksLikePerReferenceEdit(text, attachCount){ return false; }
function agentLooksLikeStyleChoiceRequest(text){ return false; }
function agentLooksLikeLargeSeriesRequest(text){ return false; }
function agentLooksLikeSimpleSingleShot(userText=''){ return false; }
function agentDefaultStyleOptions(userText){ return []; }
function agentExtractVariantCount(userText=''){ return 0; }
function agentExtractVariantLabels(userText='', n=0){ return []; }
function agentExpectedSeriesSteps(userText=''){
    return {productCount:0, mainCount:0, detailCount:0, total:0, mainRatio:'', detailRatio:'', resolution:''};
}


window.CanvasAgentPlugin = {
    schemaVersion: 2,
    get mounted(){ return canvasAgentMounted; },
    mount: mountCanvasAgent,
    unmount: unmountCanvasAgent,
    attachSelection: attachSelectedImages
};
// 调试辅助：控制台可直接验证灰态/重复插图（不影响正常路径）
window.CanvasAgentDebug = {
    setGhost: setAgentGhostAttachments,
    confirmGhost: confirmAgentGhostAttachment,
    forceGhost: agentForceGhostFromNodes,
    clearGhost: clearAgentGhostAttachment,
    collect: agentCollectComposerAttachments,
    get confirmedSig(){ return agentGhostConfirmedSig; },
    get lastSig(){ return agentLastSelectionSig; },
    get ghost(){ return (agentGhostAttachments||[]).slice(); }
};

const start = () => window.setTimeout(mountCanvasAgent, 0);
if(document.readyState === 'complete') start();
else window.addEventListener('load', start, {once:true});
})().catch(error => console.error('[canvas-agent] mount failed', error));
