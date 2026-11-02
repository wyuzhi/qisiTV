import {expect,test} from "bun:test";
import {shouldReloadForContinuation} from "@/pages/canvas/use-canvas-assistant-continuation";
import type {AssistantContinuation} from "@/services/api/assistant-continuation";

const row:AssistantContinuation={id:"receipt",canvasId:"canvas",sessionId:"session",proposalId:"gp-one",sourceTurnId:"source",requestId:"generation-fixed",turnId:"fixed",message:"【自动继续】检查已生成结果",permissionMode:"canvas",state:"claimed",taskIds:["task"],nodeIds:["actual"]};
const controller=()=>({canvasId:"canvas",sessionId:"session",historyLoaded:true,streaming:false,sessionBusy:false,reloadHistory:async()=>true});

test("a backend-claimed receipt makes an idle page re-read history to show the worker's turn",()=>{
 expect(shouldReloadForContinuation(controller(),[row],true)).toBe(true);
 expect(shouldReloadForContinuation(controller(),[{...row,state:"running"}],true)).toBe(true);
});

test("a waiting receipt is only displayed, never acted on",()=>{
 expect(shouldReloadForContinuation(controller(),[{...row,state:"waiting"}],true)).toBe(false);
});

test("a receipt leaving the pending list refreshes history once so the finished turn appears",()=>{
 expect(shouldReloadForContinuation(controller(),[],true)).toBe(true);
 expect(shouldReloadForContinuation(controller(),[],false)).toBe(false);
});

test("a busy, unloaded or different session never triggers a read",()=>{
 for(const patch of [{historyLoaded:false},{streaming:true},{sessionBusy:true},{sessionId:"other"}])expect(shouldReloadForContinuation({...controller(),...patch},[row],true)).toBe(false);
 expect(shouldReloadForContinuation({...controller(),canvasId:"other"},[row],false)).toBe(false);
});

test("the observer module exposes no claim or send path",async()=>{
 const source=await Bun.file(import.meta.dir+"/../src/pages/canvas/use-canvas-assistant-continuation.ts").text();
 const api=await Bun.file(import.meta.dir+"/../src/services/api/assistant-continuation.ts").text();
 expect(source).not.toMatch(/\.send\(|claimAssistantContinuation|continueAssistantOnce/);
 expect(api).not.toMatch(/\/claim\b/);
});
