(() => {
    'use strict';
    const status = value => { document.documentElement.dataset.canvasBugFixInputOrderClassic = value; };
    if(typeof reorderInput !== 'function' || typeof generatorSources !== 'function') { status('incompatible'); return; }
    reorderInput = function fixedReorderInput(generator, movedId, targetId){
        if(!generator || !movedId || movedId === targetId) return false;
        const sources = generatorSources(generator);
        const imageIds = sources.filter(source => source.refs?.length).map(source => source.id);
        if(!imageIds.includes(movedId) || !imageIds.includes(targetId)) return false;
        const ordered = (generator.inputs || []).filter(id => imageIds.includes(id));
        imageIds.forEach(id => { if(!ordered.includes(id)) ordered.push(id); });
        const from = ordered.indexOf(movedId), to = ordered.indexOf(targetId);
        if(from < 0 || to < 0) return false;
        ordered.splice(to, 0, ordered.splice(from, 1)[0]);
        generator.inputs = [...ordered, ...(generator.inputs || []).filter(id => !imageIds.includes(id))];
        render(); scheduleSave(); return true;
    };
    status('active');
})();
