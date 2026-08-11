(() => {
    'use strict';

    const STATUS_KEY = 'canvasBugFixLoopRefs';

    function setStatus(value) {
        document.documentElement.dataset[STATUS_KEY] = value;
    }

    function mergeLoopRoundReferences(node, loopRefs, ctx) {
        if(!Array.isArray(loopRefs) || !ctx?.nodeId) return null;
        const getInputs = typeof inputNodesFor === 'function' ? inputNodesFor : null;
        const getOutputImages = typeof outputImagesForNode === 'function' ? outputImagesForNode : null;
        const getManualImages = typeof manualReferenceImagesFor === 'function' ? manualReferenceImagesFor : null;
        const uniqueImages = typeof uniqueReferenceImages === 'function' ? uniqueReferenceImages : null;
        if(typeof getInputs !== 'function' || typeof getOutputImages !== 'function' || typeof getManualImages !== 'function' || typeof uniqueImages !== 'function') return null;

        const inputs = getInputs(node) || [];
        const loopId = String(ctx.nodeId);
        if(!inputs.some(input => input?.id === loopId)) return null;

        // 当前循环批次排在前面；其余连接输入和手动参考图依次保留为图二、图三……
        const fixedInputs = inputs
            .filter(input => input?.id && input.id !== loopId)
            .flatMap(input => getOutputImages(input, true, ctx) || [])
            .filter(image => image?.url);
        const manualInputs = (getManualImages(node) || []).filter(image => image?.url);
        return uniqueImages([...loopRefs, ...fixedInputs, ...manualInputs]);
    }

    function install() {
        const original = typeof buildPromptRequestForNode === 'function' ? buildPromptRequestForNode : null;
        if(typeof original !== 'function') return false;
        if(original.__canvasBugFixLoopRefs) return true;

        function patchedBuildPromptRequestForNode(node, defaultImages, ctx) {
            const merged = mergeLoopRoundReferences(node, defaultImages, ctx);
            return original.call(this, node, merged || defaultImages, ctx);
        }
        patchedBuildPromptRequestForNode.__canvasBugFixLoopRefs = true;
        buildPromptRequestForNode = patchedBuildPromptRequestForNode;
        return true;
    }

    if(install()) setStatus('active');
    else {
        setStatus('waiting');
        window.addEventListener('load', () => setStatus(install() ? 'active' : 'unavailable'), {once:true});
    }
    window.CanvasBugFixLoopReference = {install, mergeLoopRoundReferences};
})();
