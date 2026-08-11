(function(){
    'use strict';
    const RUNNING=new Set(['planning','creating_nodes','ready','running']);
    class CanvasAgentInputStateMachine{
        constructor(options={}){this.options=options;this.conversationId='';this.state={status:'idle',draft:'',attachments:[],workflow:null,submitLocked:false};}
        load(conversationId,saved={}){this.conversationId=conversationId||'default';this.state={status:saved.status||'idle',draft:String(saved.draft||''),attachments:Array.isArray(saved.attachments)?saved.attachments.slice():[],workflow:saved.workflow||null,submitLocked:false};return this.snapshot();}
        snapshot(){return{status:this.state.status,draft:this.state.draft,attachments:this.state.attachments.slice(),workflow:this.state.workflow};}
        isRunning(){return RUNNING.has(this.state.status);}
        hasContent(){return Boolean(this.state.draft.trim()||this.state.attachments.length);}
        action(){if(this.state.status==='stopping')return'stopping';if(this.state.status==='failed')return this.hasContent()?'retry':'idle';if(this.isRunning())return this.hasContent()?'steer':'stop';return this.hasContent()?'send':'idle';}
        setDraft(value){this.state.draft=String(value||'');this.emit();}
        setAttachments(items){this.state.attachments=Array.isArray(items)?items.slice():[];this.emit();}
        start(workflow){this.state.workflow=workflow||this.state.workflow;this.state.status=workflow?.status||'planning';this.emit();}
        setStatus(status){this.state.status=status||'idle';if(['completed','stopped'].includes(status))this.state.status='idle';this.emit();}
        consume(){const payload={text:this.state.draft.trim(),attachments:this.state.attachments.slice()};this.state.draft='';this.state.attachments=[];this.emit();return payload;}
        emit(){this.options.onChange?.(this.snapshot(),this.action());}
    }
    window.CanvasAgentInputStateMachine=CanvasAgentInputStateMachine;
})();
