// Task-owned probe: real Node + real pi SDK, scripted loopback model/ops only.
// No user data, real credentials, or paid model request is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DURABLE_VERSION } from '../durable-session-owner.mjs';
import { canvasKey } from '../session-owner.mjs';
import { serveEmptyHostState } from './skill-context-fixture.mjs';

const root = path.resolve(process.argv[2] || '.');
const destination = process.argv[3];
const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv synthetic host '));
const hostAuth = 'synthetic-host-credential-not-real';
const seen = [];
let mode = 'plain';
let providerCount = 0;
let child;
let hostLog = '';
let releaseHeldReply = null;
let releaseHeldOps = null;
let releaseAuthHold = null;
let holdAuthTurn = '';
let failSecondAuthTurn = '';
const authReads = new Map();
const failCompleteCount = new Map();
const completedTurns = new Set();
const closedTurns = new Set();
const descriptors = [
  { id:'canvas.get',assistantModes: ['canvas', 'full-access', 'read-only'], replay: 'safe', readOnly:true,scope:'canvas',summary:'Read canvas',params:{type:'object',properties:{canvasId:{type:'string'}},required:['canvasId']} },
  { id:'asset.get',assistantModes: ['canvas', 'full-access', 'read-only'], replay: 'safe', readOnly:true,scope:'workspace_read',summary:'Read allowed asset',params:{type:'object',properties:{assetId:{type:'string'}},required:['assetId']} },
];
const listen = server => new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const readJSON = async req => { let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body||'{}'); };
function sse(response,model,message,tool) {
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const chunk = data=>response.write('data: '+JSON.stringify({id:'synthetic-'+providerCount,object:'chat.completion.chunk',created:1,model,...data})+'\n\n');
  chunk({choices:[{index:0,delta:{role:'assistant',content:tool?'':message,...(tool?{tool_calls:[{index:0,id:'synthetic-call-'+providerCount,type:'function',function:tool}]}:{})},finish_reason:null}]});
  chunk({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  response.end('data: [DONE]\n\n');
}
const provider=createServer(async(req,res)=>{
  try {
    const body=await readJSON(req);providerCount++;
    const toolAlready=body.messages?.at(-1)?.role==='tool';
    if(mode==='budget-loop') return sse(res,body.model,'',{name:'canvas_get',arguments:'{}'});
    if((mode==='asset'||mode==='hold-ops')&&!toolAlready) return sse(res,body.model,'',{name:'asset_get',arguments:JSON.stringify({assetId:'explicit-asset'})});
    if(mode==='reference'&&!toolAlready) return sse(res,body.model,'',{name:'canvas_get',arguments:JSON.stringify({canvasId:'referenced-canvas'})});
    if(mode==='hold'){
      await new Promise(resolve=>{releaseHeldReply=resolve;req.on('close',resolve);});
      if(!res.writableEnded)res.end();
      return;
    }
    if(mode==='hold-then-reply'){
      await new Promise(resolve=>{releaseHeldReply=resolve;req.on('close',resolve);});
      if(!res.writableEnded)return sse(res,body.model,'Synthetic probe acknowledged.');
      return;
    }
    return sse(res,body.model,'Synthetic probe acknowledged.');
  } catch(error){res.writeHead(500).end(String(error));}
});
const ops=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.headers['x-beeftv-agent-token']!==hostAuth){res.writeHead(403).end(JSON.stringify({code:403,reason:'synthetic_unauthorized'}));return;}
  if(serveEmptyHostState(req,res))return;
  if(req.method==='GET'&&req.url==='/api/ops'){res.end(JSON.stringify({code:0,data:{ops:descriptors}}));return;}
  if(req.url.startsWith('/api/assistant/runtime/turns/')){
    if(req.method!=='GET')await readJSON(req);
    const parts=req.url.split('/');
    const turnId=decodeURIComponent(parts[5]||'');
    const subAction=parts[6]||'';
    if(req.method==='POST'&&subAction==='complete'){
      const remaining502=failCompleteCount.get(turnId)||0;
      if(remaining502>0){
        failCompleteCount.set(turnId,remaining502-1);
        res.writeHead(502).end(JSON.stringify({code:502,reason:'synthetic_complete_502'}));return;
      }
      completedTurns.add(turnId);
      res.end(JSON.stringify({code:0,data:{turnId,completed:true}}));return;
    }
    if(req.method==='GET'){
      const count=(authReads.get(turnId)||0)+1;
      authReads.set(turnId,count);
      if(holdAuthTurn===turnId){
        await new Promise(resolve=>{releaseAuthHold=resolve;req.on('close',resolve);});
      }
      if(failSecondAuthTurn===turnId&&count>=2){
        res.end(JSON.stringify({code:0,data:{turnId,canvasId:'other-canvas',permissionMode:'canvas',open:false}}));return;
      }
    }
    res.end(JSON.stringify({code:0,data:{turnId,canvasId:turnCanvas.get(turnId)||'canvas',permissionMode:'canvas',open:!closedTurns.has(turnId)}}));return;
  }
  const body=await readJSON(req);seen.push({path:req.url,body,turn:req.headers['x-beeftv-agent-turn']});
  if(mode==='hold-ops'&&req.url==='/api/ops/asset.get'){
    await new Promise(resolve=>{releaseHeldOps=resolve;req.on('close',resolve);});
    if(!res.writableEnded)res.end(JSON.stringify({code:0,data:{op:'asset.get',replayed:false,result:{assetId:body.params.assetId,asset:{id:body.params.assetId,name:'Synthetic asset'}}}}));
    return;
  }
  if(req.url==='/api/ops/asset.get'&&Object.keys(body.params||{}).some(k=>k!=='assetId')){
    res.writeHead(400).end(JSON.stringify({code:400,reason:'invalid_params',msg:'unknown field in asset.get'}));return;
  }
  const result=req.url==='/api/ops/asset.get'?{assetId:body.params.assetId,asset:{id:body.params.assetId,name:'Synthetic asset'}}:{canvasId:body.params.canvasId,canvas:{id:body.params.canvasId,revision:1,nodes:[],connections:[]}};
  res.end(JSON.stringify({code:0,data:{op:req.url.split('/').at(-1),replayed:false,result}}));
});
const results=[];
const turnCanvas=new Map();
async function request(route,body) {
  if(body&&body.turnId&&body.canvasId)turnCanvas.set(body.turnId,body.canvasId);
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const text=await response.text();let events=[];try{events=text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{}
  return {status:response.status,events,text};
}
async function scenario(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS',name);}catch(error){results.push({name,passed:false,error:error.message});console.log('FAIL',name,error.message);}}
let base;
try{
  const modelPort=await listen(provider),opsPort=await listen(ops);
  const reservation=createServer();const hostPort=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
  base=`http://127.0.0.1:${hostPort}`;
  const env={...process.env,BEEFTV_AGENT_DATA_DIR:scratch,BEEFTV_AGENT_PORT:String(hostPort),BEEFTV_OPS_URL:`http://127.0.0.1:${opsPort}/api`,BEEFTV_AGENT_HOST_TOKEN:hostAuth,BEEFTV_AGENT_API_KEY:'synthetic-model-key',BEEFTV_AGENT_MODEL:'synthetic-model',BEEFTV_AGENT_API:'openai-completions',BEEFTV_AGENT_BASE_URL:`http://127.0.0.1:${modelPort}/v1`,BEEFTV_AGENT_MAX_REQUESTS_PER_TURN:'1',BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN:'4'};
  delete env.BEEFTV_AGENT_NEW_SESSION_RUNTIME; // 只有 Durable 一套执行运行时。
  child=spawn(process.execPath,[path.join(root,'agent-host/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{hostLog+=c});child.stderr.on('data',c=>{hostLog+=c});
  const deadline=Date.now()+15000;let healthy=false;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('host exited '+child.exitCode+' '+hostLog.slice(-1500));try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(r.ok){healthy=true;break;}}catch{}await delay(100);}
  assert(healthy,'real host must become healthy');
  mode='budget-loop';
  await scenario('budget-exhaustion-is-an-explicit-failed-turn',async()=>{
    const result=await request('/chat',{canvasId:'synthetic-budget',message:'Run the synthetic bounded loop.',turnId:'aa11',revisionBefore:1});
    assert.equal(result.status,200,result.text);const end=result.events.find(e=>e.type==='turn_end');assert(end,'turn_end required');
    assert(/budget|预算|上限/.test(JSON.stringify(end.error||end.reason||'')),'budget denial must be explicit, not an empty successful turn or unrelated timeout: '+JSON.stringify(end));
    assert.equal(providerCount,1,'denied request must not reach the model');
  });
  mode='plain';
  await scenario('new-turn-after-budget-exhaustion-still-works',async()=>{
    const before=providerCount;const result=await request('/chat',{canvasId:'synthetic-budget',message:'Acknowledge.',turnId:'aa12',revisionBefore:1});
    const end=result.events.find(e=>e.type==='turn_end');assert.equal(result.status,200,result.text);assert(end&&!end.error&&!end.cancelled,'new turn must finish');assert.match(end.reply,/acknowledged/);assert.equal(providerCount,before+1);
  });
  mode='asset';
  await scenario('asset-tool-does-not-inject-unknown-canvasId',async()=>{
    const before=seen.length;await request('/chat',{canvasId:'synthetic-asset',message:'Read the referenced asset.',turnId:'aa13',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]});
    const call=seen.slice(before).find(c=>c.path==='/api/ops/asset.get');assert(call,'asset tool should reach ops');assert.deepEqual(Object.keys(call.body.params).sort(),['assetId']);assert.equal(call.turn,'aa13');
  });
  mode='reference';
  await scenario('explicit-reference-canvas-can-reach-backend-read-guard',async()=>{
    const before=seen.length;await request('/chat',{canvasId:'synthetic-current',message:'Read the referenced canvas.',turnId:'aa14',revisionBefore:1,references:[{kind:'canvas',id:'referenced-canvas'}]});
    const call=seen.slice(before).find(c=>c.path==='/api/ops/canvas.get'&&c.body.params.canvasId==='referenced-canvas');assert(call,'host must not unconditionally reject an explicitly referenced read');assert.equal(call.turn,'aa14');
  });
  await scenario('history-and-sessions-survive-unresumable-turn-and-corrupt-manifest',async()=>{
    mode='plain';
    const canvasId='synthetic-resilience';
    // Create a first valid session (which becomes a non-current sibling once we create the second session)
    // so GET /sessions cannot pass merely via the currentSessionId fallback.
    const siblingTurn=await request('/chat',{canvasId,message:'Valid sibling conversation title',turnId:'aa14b',revisionBefore:1});
    assert.equal(siblingTurn.status,200,siblingTurn.text);
    const siblingSessionId=siblingTurn.events.find(e=>e.type==='session')?.sessionId;
    assert(siblingSessionId,'sibling session id required');
    const secondCreated=await request('/sessions',{canvasId});
    assert.equal(secondCreated.status,200,secondCreated.text);
    const first=await request('/chat',{canvasId,message:'First settled turn.',turnId:'aa15',revisionBefore:1});
    assert.equal(first.status,200,first.text);
    mode='hold';
    turnCanvas.set('aa16',canvasId);
    const heldAbort=new AbortController();
    const heldPromise=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,message:'Interrupted turn.',turnId:'aa16',revisionBefore:1}),signal:heldAbort.signal}).catch(()=>null);
    const waitDeadline=Date.now()+8000;
    while(!releaseHeldReply&&Date.now()<waitDeadline)await delay(40);
    assert(releaseHeldReply,'held turn must reach model');
    heldAbort.abort();
    await heldPromise;
    // Simulate hard restart after Go already closed aa16 + 4 kinds of corrupt sibling files on disk.
    closedTurns.add('aa16');
    const killed=new Promise(resolve=>child.once('close',resolve));
    child.kill('SIGKILL');
    await killed;
    releaseHeldReply?.();
    releaseHeldReply=null;
    const durableDir=path.join(scratch,'sessions',canvasKey(canvasId),'durable');
    mkdirSync(durableDir,{recursive:true});
    const corruptIds=[
      '00000000-0000-4000-8000-000000000091',
      '00000000-0000-4000-8000-000000000092',
      '00000000-0000-4000-8000-000000000093',
      '00000000-0000-4000-8000-000000000094',
      '00000000-0000-4000-8000-000000000095',
    ];
    writeFileSync(path.join(durableDir,`${corruptIds[0]}.json`),'{corrupt-json');
    writeFileSync(path.join(durableDir,`${corruptIds[1]}.json`),'null');
    writeFileSync(path.join(durableDir,`${corruptIds[2]}.json`),JSON.stringify({
      sessionId:`durable:${corruptIds[2]}`,
      canvasId,
      handoffSourceId:'',
      version:DURABLE_VERSION,
      createdAt:'2026-01-01T00:00:00.000Z',
    }));
    writeFileSync(path.join(durableDir,`${corruptIds[2]}.sqlite`),'not-a-valid-sqlite-database');
    const manifestDirAsFile=path.join(durableDir,`${corruptIds[3]}.json`);
    mkdirSync(manifestDirAsFile,{recursive:true});
    // Mismatched manifest pointing at valid siblingSessionId must be skipped rather than duplicating siblingSessionId.
    writeFileSync(path.join(durableDir,`${corruptIds[4]}.json`),JSON.stringify({
      sessionId:siblingSessionId,
      canvasId,
      handoffSourceId:'',
      version:DURABLE_VERSION,
      createdAt:'2026-01-01T00:00:00.000Z',
    }));
    child=spawn(process.execPath,[path.join(root,'agent-host/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',c=>{hostLog+=c});child.stderr.on('data',c=>{hostLog+=c});
    const restartDeadline=Date.now()+15000;let restarted=false;
    while(Date.now()<restartDeadline){if(child.exitCode!==null)throw new Error('restarted host exited '+child.exitCode+' '+hostLog.slice(-1500));try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(r.ok){restarted=true;break;}}catch{}await delay(100);}
    assert(restarted,'restarted host must become healthy');
    const historyRes=await request(`/history?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(historyRes.status,200,historyRes.text);
    const historyJson=JSON.parse(historyRes.text);
    assert.equal(historyJson.active,null,'closed unresumable turn must settle locally instead of staying running');
    assert.equal(historyJson.turns.length,2);
    assert.match(historyJson.turns[0].reply,/acknowledged/);
    assert.equal(historyJson.turns[1].errorReason,'turn_interrupted');
    const sessionsRes=await request(`/sessions?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(sessionsRes.status,200,sessionsRes.text);
    const sessionsJson=JSON.parse(sessionsRes.text);
    const listedSiblings=sessionsJson.sessions.filter(s=>s.sessionId===siblingSessionId);
    assert.equal(listedSiblings.length,1,'valid non-current sibling session must be listed once without spoofed duplicate');
    assert.match(listedSiblings[0].title,/Valid sibling conversation/);
    for(const cid of corruptIds){
      assert(!sessionsJson.sessions.some(s=>s.sessionId.includes(cid)),`corrupt session ${cid} must be skipped`);
    }
    rmSync(manifestDirAsFile,{recursive:true,force:true});
    // Entry must not remain busy: follow-up chat and creating/activating sessions must succeed without 409 session_busy.
    mode='plain';
    const followUp=await request('/chat',{canvasId,sessionId:historyJson.sessionId,message:'After interrupted turn.',turnId:'aa17',revisionBefore:1});
    assert.equal(followUp.status,200,followUp.text);
    const followEnd=followUp.events.find(e=>e.type==='turn_end');
    assert(followEnd&&!followEnd.error&&!followEnd.cancelled,'follow-up turn must succeed after settling interrupted turn');
    const createdRes=await request('/sessions',{canvasId});
    assert.equal(createdRes.status,200,createdRes.text);
    const createdId=JSON.parse(createdRes.text).sessionId;
    const activateRes=await request('/sessions/activate',{canvasId,sessionId:historyJson.sessionId});
    assert.equal(activateRes.status,200,activateRes.text);
    assert(createdId&&createdId!==historyJson.sessionId,'new session creation and switching back must succeed');
  });
  await scenario('transient-frozen-model-resumes-when-restored-and-allows-continue-when-superseded',async()=>{
    const canvasId='synthetic-transient-model';
    const restartHost=async(modelName)=>{
      if(child&&child.exitCode===null){const killed=new Promise(r=>child.once('close',r));child.kill('SIGKILL');await killed;}
      releaseHeldReply?.();releaseHeldReply=null;
      releaseHeldOps?.();releaseHeldOps=null;
      child=spawn(process.execPath,[path.join(root,'agent-host/server.mjs')],{cwd:root,env:{...env,BEEFTV_AGENT_MODEL:modelName,BEEFTV_AGENT_MAX_REQUESTS_PER_TURN:'3'},stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',c=>{hostLog+=c});child.stderr.on('data',c=>{hostLog+=c});
      const dl=Date.now()+15000;let ok=false;
      while(Date.now()<dl){if(child.exitCode!==null)throw new Error('host exited '+child.exitCode+' '+hostLog.slice(-1500));try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(r.ok){ok=true;break;}}catch{}await delay(100);}
      assert(ok,`host must start with ${modelName}`);
    };
    await restartHost('synthetic-model');
    // 1. Start turn on synthetic-model and SIGKILL mid-tool-execution while Go turn remains open.
    mode='hold-ops';
    turnCanvas.set('aa18',canvasId);
    const abort1=new AbortController();
    const p1=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,message:'Frozen turn one.',turnId:'aa18',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:abort1.signal}).catch(()=>null);
    const w1=Date.now()+8000;while(!releaseHeldOps&&Date.now()<w1)await delay(40);
    assert(releaseHeldOps,'aa18 must reach safe tool execution');
    abort1.abort();await p1;
    // 2a. Restart with NO configured model (BEEFTV_AGENT_MODEL=''): /history and /sessions return 200 without mutating disk active.
    mode='plain';
    await restartHost('');
    const unconfiguredHistRes=await request(`/history?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(unconfiguredHistRes.status,200,unconfiguredHistRes.text);
    const histUnconfigured=JSON.parse(unconfiguredHistRes.text);
    assert.equal(histUnconfigured.active,null);
    assert.equal(histUnconfigured.pausedTurnReason,'model_unavailable_for_resume');
    assert.equal(histUnconfigured.turns.length,1);
    assert.equal(histUnconfigured.turns[0].errorReason,'turn_interrupted');
    const unconfiguredSessionsRes=await request(`/sessions?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(unconfiguredSessionsRes.status,200,unconfiguredSessionsRes.text);
    // 2b. Restart with other-model: /history projects non-running interrupted turn without mutating disk active.
    await restartHost('other-model');
    const histMissing=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(canvasId)}`)).text);
    assert.equal(histMissing.active,null);
    assert.equal(histMissing.pausedTurnReason,'model_unavailable_for_resume');
    assert.equal(histMissing.turns.length,1);
    assert.equal(histMissing.turns[0].errorReason,'turn_interrupted');
    // 3. Switch back to synthetic-model: /history resumes aa18 cleanly with zero duplicate turns!
    await restartHost('synthetic-model');
    const resumeDeadline=Date.now()+10000;let histRestored=null;
    while(Date.now()<resumeDeadline){
      histRestored=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(canvasId)}`)).text);
      if(!histRestored.active&&histRestored.turns.length>=1)break;
      await delay(100);
    }
    assert.equal(histRestored.active,null);
    assert.equal(histRestored.turns.length,1,'resumed turn must not duplicate');
    assert.match(histRestored.turns[0].reply,/acknowledged/);
    // 4. Start frozen turn aa18b, SIGKILL, restore synthetic-model, and POST /chat (aa18c) WITHOUT prior /history -> 200 OK & zero duplicate turns!
    mode='hold-ops';
    turnCanvas.set('aa18b',canvasId);
    const abort1b=new AbortController();
    const p1b=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,sessionId:histRestored.sessionId,message:'Frozen turn 1b.',turnId:'aa18b',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:abort1b.signal}).catch(()=>null);
    const w1b=Date.now()+8000;while(!releaseHeldOps&&Date.now()<w1b)await delay(40);
    assert(releaseHeldOps,'aa18b must reach safe tool execution');
    abort1b.abort();await p1b;
    mode='plain';
    await restartHost('synthetic-model');
    const directChat=await request('/chat',{canvasId,sessionId:histRestored.sessionId,message:'Continue after restoring model.',turnId:'aa18c',revisionBefore:1});
    assert.equal(directChat.status,200,directChat.text);
    const directChatEnd=directChat.events.find(e=>e.type==='turn_end');
    assert(directChatEnd&&!directChatEnd.error,'direct /chat on restored model must settle stale turn and succeed 200');
    const histAfterDirect=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(canvasId)}`)).text);
    assert.deepEqual(histAfterDirect.turns.map(t=>t.turnId),['aa18','aa18b','aa18c']);
    assert.equal(histAfterDirect.turns[1].errorReason,'turn_interrupted');
    assert.match(histAfterDirect.turns[2].reply,/acknowledged/);
    // 5. Start frozen turn aa19, SIGKILL mid-tool, switch to other-model, and send Continue (/chat) on other-model -> must settle aa19 and succeed 200!
    mode='hold-ops';
    turnCanvas.set('aa19',canvasId);
    const abort2=new AbortController();
    const p2=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,sessionId:histRestored.sessionId,message:'Frozen turn two.',turnId:'aa19',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:abort2.signal}).catch(()=>null);
    const w2=Date.now()+8000;while(!releaseHeldOps&&Date.now()<w2)await delay(40);
    assert(releaseHeldOps,'aa19 must reach safe tool execution');
    abort2.abort();await p2;
    mode='plain';
    await restartHost('other-model');
    const superseded=await request('/chat',{canvasId,sessionId:histRestored.sessionId,message:'Continue on other-model.',turnId:'aa20',revisionBefore:1});
    assert.equal(superseded.status,200,superseded.text);
    const supersededEnd=superseded.events.find(e=>e.type==='turn_end');
    assert(supersededEnd&&!supersededEnd.error,'follow-up chat on new model must succeed without 409 session_busy');
    const histAfter=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(canvasId)}`)).text);
    assert.deepEqual(histAfter.turns.map(t=>t.turnId),['aa18','aa18b','aa18c','aa19','aa20']);
    assert.equal(histAfter.turns[3].errorReason,'turn_interrupted');
    assert.match(histAfter.turns[4].reply,/acknowledged/);
    // 6. Overlapping concurrent POST /chat (aa22 & aa23) after cold-start stale turn (aa21):
    // winner holds in model while loser arrives -> loser gets 409 session_busy without aborting winner!
    await restartHost('synthetic-model');
    mode='hold-ops';
    turnCanvas.set('aa21',canvasId);
    const abort3=new AbortController();
    const p3=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,sessionId:histRestored.sessionId,message:'Frozen turn three.',turnId:'aa21',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:abort3.signal}).catch(()=>null);
    const w3=Date.now()+8000;while(!releaseHeldOps&&Date.now()<w3)await delay(40);
    assert(releaseHeldOps,'aa21 must reach safe tool execution');
    abort3.abort();await p3;
    mode='hold-then-reply';
    await restartHost('synthetic-model');
    const pOverlapB=request('/chat',{canvasId,sessionId:histRestored.sessionId,message:'Concurrent B.',turnId:'aa22',revisionBefore:1});
    const pOverlapC=request('/chat',{canvasId,sessionId:histRestored.sessionId,message:'Concurrent C.',turnId:'aa23',revisionBefore:1});
    const firstSettled=await Promise.race([pOverlapB,pOverlapC]);
    assert.equal(firstSettled.status,409,`loser of overlapping /chat must get 409, got ${JSON.stringify(firstSettled)}`);
    const wModel=Date.now()+8000;while(!releaseHeldReply&&Date.now()<wModel)await delay(30);
    assert(releaseHeldReply,'winner must reach held model without being aborted by loser');
    releaseHeldReply();releaseHeldReply=null;
    const [overlapB,overlapC]=await Promise.all([pOverlapB,pOverlapC]);
    const statuses=[overlapB.status,overlapC.status].sort((a,b)=>a-b);
    assert.deepEqual(statuses,[200,409]);
    const winnerRes=overlapB.status===200?overlapB:overlapC;
    const winnerEnd=winnerRes.events.find(e=>e.type==='turn_end');
    assert(winnerEnd&&!winnerEnd.error&&!winnerEnd.cancelled,'winning concurrent /chat must finish cleanly without being aborted');
    assert.match(winnerEnd.reply,/acknowledged/);
    const histFinal=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(canvasId)}`)).text);
    assert.equal(histFinal.turns.length,7);
    assert.equal(histFinal.turns[5].turnId,'aa21');
    assert.equal(histFinal.turns[5].errorReason,'turn_interrupted');
    assert(['aa22','aa23'].includes(histFinal.turns[6].turnId));
    // 7. Concurrent GET /history recovery racing POST /chat after cold-start stale turn (aa24):
    // /history never returns 500 and turn IDs never duplicate!
    mode='hold-ops';
    turnCanvas.set('aa24',canvasId);
    const abort4=new AbortController();
    const p4=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,sessionId:histRestored.sessionId,message:'Frozen turn four.',turnId:'aa24',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:abort4.signal}).catch(()=>null);
    const w4=Date.now()+8000;while(!releaseHeldOps&&Date.now()<w4)await delay(40);
    assert(releaseHeldOps,'aa24 must reach safe tool execution');
    abort4.abort();await p4;
    mode='plain';
    await restartHost('synthetic-model');
    const [raceHist,raceChat]=await Promise.all([
      request(`/history?canvasId=${encodeURIComponent(canvasId)}`),
      request('/chat',{canvasId,sessionId:histRestored.sessionId,message:'Race chat.',turnId:'aa25',revisionBefore:1}),
    ]);
    assert.equal(raceHist.status,200,raceHist.text);
    assert([200,409].includes(raceChat.status),`race /chat must be 200 or 409, got ${raceChat.status} ${raceChat.text}`);
    const settleRaceDeadline=Date.now()+10000;let histAfterRace=null;
    while(Date.now()<settleRaceDeadline){
      histAfterRace=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(canvasId)}`)).text);
      if(!histAfterRace.active)break;
      await delay(80);
    }
    assert.equal(histAfterRace.active,null);
    const turnIds=histAfterRace.turns.map(t=>t.turnId);
    assert.equal(new Set(turnIds).size,turnIds.length,`turn IDs must never duplicate: ${JSON.stringify(turnIds)}`);
    // 8. Replacing /chat settles stale turn (aa26) and then fails authorizeTurn on aa27 -> stale Go turn aa26 STILL receives /complete!
    mode='hold-ops';
    turnCanvas.set('aa26',canvasId);
    const abort5=new AbortController();
    const p5=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,sessionId:histRestored.sessionId,message:'Frozen turn five.',turnId:'aa26',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:abort5.signal}).catch(()=>null);
    const w5=Date.now()+8000;while(!releaseHeldOps&&Date.now()<w5)await delay(40);
    assert(releaseHeldOps,'aa26 must reach safe tool execution');
    abort5.abort();await p5;
    mode='plain';
    completedTurns.delete('aa26');
    failSecondAuthTurn='aa27';
    await restartHost('synthetic-model');
    const failedReplacement=await request('/chat',{canvasId,sessionId:histRestored.sessionId,message:'Failing replacement.',turnId:'aa27',revisionBefore:1});
    failSecondAuthTurn='';
    assert.notEqual(failedReplacement.status,200,'aa27 must fail authorization inside submit');
    assert(completedTurns.has('aa26'),'stale turn aa26 must still be completed on Go even when replacing /chat fails');
    // 9. Slow /history recovery after transient busy=false blocks session create/switch with 409 instead of closing harness into 500!
    mode='hold-ops';
    turnCanvas.set('aa28',canvasId);
    const abort6=new AbortController();
    const p6=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,sessionId:histRestored.sessionId,message:'Frozen turn six.',turnId:'aa28',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:abort6.signal}).catch(()=>null);
    const w6=Date.now()+8000;while(!releaseHeldOps&&Date.now()<w6)await delay(40);
    assert(releaseHeldOps,'aa28 must reach safe tool execution');
    abort6.abort();await p6;
    mode='plain';
    await restartHost('other-model');
    // First /history hits transient model_unavailable_for_resume, setting entry.busy=false while doc.active stays aa28.
    const transientHist=await request(`/history?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(transientHist.status,200);
    // Second /history starts a slow recovery held in authorization while POST /sessions races it.
    holdAuthTurn='aa28';
    const slowHistPromise=request(`/history?canvasId=${encodeURIComponent(canvasId)}`);
    const wHold=Date.now()+8000;while(!releaseAuthHold&&Date.now()<wHold)await delay(30);
    assert(releaseAuthHold,'slow /history must enter authorization');
    const switchDuringRecover=await request('/sessions',{canvasId});
    assert.equal(switchDuringRecover.status,409,`session create during recovery must return 409 session_busy, got ${switchDuringRecover.status} ${switchDuringRecover.text}`);
    holdAuthTurn='';
    releaseAuthHold();releaseAuthHold=null;
    const slowHistRes=await slowHistPromise;
    assert.equal(slowHistRes.status,200,slowHistRes.text);
  });
  await scenario('corrupt-current-session-and-pointer-self-heal-without-500',async()=>{
    mode='plain';
    const restartCurrentHost=async(beforeStart=null)=>{
      if(child&&child.exitCode===null&&child.signalCode===null){const killed=new Promise(r=>child.once('close',r));child.kill('SIGKILL');await killed;}
      releaseHeldReply?.();releaseHeldReply=null;
      releaseHeldOps?.();releaseHeldOps=null;
      releaseAuthHold?.();releaseAuthHold=null;
      if(beforeStart)await beforeStart();
      child=spawn(process.execPath,[path.join(root,'agent-host/server.mjs')],{cwd:root,env:{...env,BEEFTV_AGENT_MODEL:'synthetic-model',BEEFTV_AGENT_MAX_REQUESTS_PER_TURN:'3'},stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',c=>{hostLog+=c});child.stderr.on('data',c=>{hostLog+=c});
      const dl=Date.now()+15000;let ok=false;
      while(Date.now()<dl){if(child.exitCode!==null||child.signalCode!==null)throw new Error('host exited '+child.exitCode+' '+hostLog.slice(-1500));try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(r.ok){ok=true;break;}}catch{}await delay(100);}
      assert(ok,'host must restart for corrupt current session scenario');
    };
    await restartCurrentHost();
    const canvasId='synthetic-corrupt-current';
    const validTurn=await request('/chat',{canvasId,message:'Valid fallback conversation',turnId:'aa29',revisionBefore:1});
    assert.equal(validTurn.status,200,validTurn.text);
    const validSessionId=validTurn.events.find(e=>e.type==='session')?.sessionId;
    assert(validSessionId,'valid fallback session id required');
    // Also leave an unresumable active turn (aa29_orphan) on validSessionId so fallback /history & /active must run recoverForRead without mutating current.json!
    mode='hold-ops';
    turnCanvas.set('aa29_orphan',canvasId);
    const orphanAbort=new AbortController();
    const orphanChat=fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},
      body:JSON.stringify({canvasId,sessionId:validSessionId,message:'Orphan fallback turn.',turnId:'aa29_orphan',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]}),signal:orphanAbort.signal}).catch(()=>null);
    const orphanWait=Date.now()+8000;while(!releaseHeldOps&&Date.now()<orphanWait)await delay(40);
    assert(releaseHeldOps,'aa29_orphan must reach tool execution');
    orphanAbort.abort();await orphanChat;
    mode='plain';
    closedTurns.add('aa29_orphan');
    await restartCurrentHost();
    const doomedRes=await request('/sessions',{canvasId});
    assert.equal(doomedRes.status,200,doomedRes.text);
    const doomedSessionId=JSON.parse(doomedRes.text).sessionId;
    assert(doomedSessionId&&doomedSessionId!==validSessionId);
    // Stop host first so WAL frames do not replay over the corrupted SQLite file, then cold-start.
    const doomedRawId=doomedSessionId.slice('durable:'.length);
    const canvasSessionDir=path.join(scratch,'sessions',canvasKey(canvasId));
    await restartCurrentHost(()=>{
      rmSync(path.join(canvasSessionDir,'durable',`${doomedRawId}.sqlite-wal`),{force:true});
      rmSync(path.join(canvasSessionDir,'durable',`${doomedRawId}.sqlite-shm`),{force:true});
      writeFileSync(path.join(canvasSessionDir,'durable',`${doomedRawId}.sqlite`),'corrupt-current-sqlite-bytes');
    });
    // Explicit ?sessionId=<corrupt> must return 409 corrupt_session_manifest, never 500.
    const explicitHist=await request(`/history?canvasId=${encodeURIComponent(canvasId)}&sessionId=${encodeURIComponent(doomedSessionId)}`);
    assert.equal(explicitHist.status,409,`explicit corrupt session history must return 409, got ${explicitHist.status} ${explicitHist.text}`);
    // Default /sessions, /active, and /history must fall back to validSessionId, settle aa29_orphan via recoverForRead, and NOT mutate current.json!
    const pointerBeforeReads=readFileSync(path.join(canvasSessionDir,'current.json'),'utf8');
    const healedActive=await request(`/active?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(healedActive.status,200,healedActive.text);
    assert.equal(JSON.parse(healedActive.text).busy,false,'fallback /active must settle unresumable turn rather than reporting busy');
    const healedHist=await request(`/history?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(healedHist.status,200,healedHist.text);
    const healedHistJson=JSON.parse(healedHist.text);
    assert.equal(healedHistJson.sessionId,validSessionId);
    assert.equal(healedHistJson.active,null,'fallback /history must not leave unresumable turn running');
    assert.equal(healedHistJson.turns.length,2);
    assert.equal(healedHistJson.turns[1].turnId,'aa29_orphan');
    assert.equal(healedHistJson.turns[1].errorReason,'turn_interrupted');
    const healedSessions=await request(`/sessions?canvasId=${encodeURIComponent(canvasId)}`);
    assert.equal(healedSessions.status,200,healedSessions.text);
    const healedSessionsJson=JSON.parse(healedSessions.text);
    assert.equal(healedSessionsJson.currentSessionId,validSessionId);
    assert(!healedSessionsJson.sessions.some(s=>s.sessionId===doomedSessionId),'corrupt current session must not be unshifted into /sessions');
    assert.equal(readFileSync(path.join(canvasSessionDir,'current.json'),'utf8'),pointerBeforeReads,'read endpoints must not mutate current.json on fallback');
    // Malformed JSON request bodies must return 400 invalid_request, never 409 corrupt_session_manifest.
    const malformedRes=await fetch(base+'/sessions',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},body:'{malformed-json',signal:AbortSignal.timeout(5000)});
    assert.equal(malformedRes.status,400);
    assert.equal((await malformedRes.json()).reason,'invalid_request');
    // Corrupt current.json on a canvas that only has a valid legacy JSONL session -> /chat without sessionId hands off legacy instead of stranding it!
    const legacyFallbackCanvas='synthetic-legacy-fallback';
    const legacyWorkspaceDir=path.join(scratch,'workspace',canvasKey(legacyFallbackCanvas));
    const legacySessionDir=path.join(scratch,'sessions',canvasKey(legacyFallbackCanvas));
    mkdirSync(legacyWorkspaceDir,{recursive:true});
    mkdirSync(legacySessionDir,{recursive:true});
    const legacyId='legacy-fallback-001';
    const legacyRows=[
      {type:'session',version:3,id:legacyId,timestamp:'2026-10-07T12:00:00.000Z',cwd:legacyWorkspaceDir},
      {type:'message',id:'m1',parentId:null,timestamp:'2026-10-07T12:00:01.000Z',message:{role:'user',content:[{type:'text',text:'Legacy fallback memory anchor'}],timestamp:1791374401000}},
    ];
    writeFileSync(path.join(legacySessionDir,`2026-10-07T12-00-00-000Z_${legacyId}.jsonl`),legacyRows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    // Read-only GET /skill-context on a legacy session (explicit or current) must NOT create/publish a durable session or mutate current.json!
    writeFileSync(path.join(legacySessionDir,'current.json'),JSON.stringify({sessionId:legacyId}));
    const legacySkillExplicit=await request(`/skill-context?canvasId=${encodeURIComponent(legacyFallbackCanvas)}&sessionId=${encodeURIComponent(legacyId)}`);
    assert.equal(legacySkillExplicit.status,200,legacySkillExplicit.text);
    const legacySkillCurrent=await request(`/skill-context?canvasId=${encodeURIComponent(legacyFallbackCanvas)}`);
    assert.equal(legacySkillCurrent.status,200,legacySkillCurrent.text);
    assert.equal(JSON.parse(readFileSync(path.join(legacySessionDir,'current.json'),'utf8')).sessionId,legacyId,'GET /skill-context must not mutate legacy current.json');
    const preChatSessions=JSON.parse((await request(`/sessions?canvasId=${encodeURIComponent(legacyFallbackCanvas)}`)).text);
    assert.equal(preChatSessions.sessions.length,1,'GET /skill-context must not create a durable session for legacy view');
    writeFileSync(path.join(legacySessionDir,'current.json'),'{truncated-legacy-pointer');
    const legacyHealedChat=await request('/chat',{canvasId:legacyFallbackCanvas,message:'Continue after corrupt legacy pointer.',turnId:'aa32',revisionBefore:1});
    assert.equal(legacyHealedChat.status,200,legacyHealedChat.text);
    const legacyHealedSessions=JSON.parse((await request(`/sessions?canvasId=${encodeURIComponent(legacyFallbackCanvas)}`)).text);
    // Also verify GET /history returns 200 (never 500) when doc.active.result is committed on disk and Go /complete returns 502 twice, then settles into 1 turn!
    const retryCompleteCanvas='synthetic-complete-retry';
    turnCanvas.set('aa33',retryCompleteCanvas);
    failCompleteCount.set('aa33',3);
    const chat502=await request('/chat',{canvasId:retryCompleteCanvas,message:'Reply then fail complete.',turnId:'aa33',revisionBefore:1});
    // /chat fails to complete on attempt 1 (leaves doc.active.result on disk); restart host and read /history while 2 more 502s remain!
    void chat502;
    await restartCurrentHost();
    failCompleteCount.set('aa33',2);
    const histDuring502=await request(`/history?canvasId=${encodeURIComponent(retryCompleteCanvas)}`);
    assert.equal(histDuring502.status,200,`GET /history must return 200 even during /complete 502, got ${histDuring502.status} ${histDuring502.text}`);
    const histDuring502Json=JSON.parse(histDuring502.text);
    assert.equal(histDuring502Json.active,null);
    assert.equal(histDuring502Json.turns.length,1);
    assert.equal(histDuring502Json.pausedTurnReason,undefined);
    const waitCompleteDl=Date.now()+6000;
    while(!completedTurns.has('aa33')&&Date.now()<waitCompleteDl)await delay(100);
    assert(completedTurns.has('aa33'),'background reconciler must retry /complete until Go acknowledges');
    const histAfterCompleteOk=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(retryCompleteCanvas)}`)).text);
    assert.equal(histAfterCompleteOk.active,null);
    assert.equal(histAfterCompleteOk.turns.length,1,'must produce exactly one turn after /complete retry succeeds');
    assert.equal(legacyHealedSessions.sessions.length,2,'legacy session and handed-off durable session must both exist');
    // Corrupt current.json itself on an empty canvas -> /sessions, /history, and /chat self-heal without 500!
    const badPtrCanvas='synthetic-corrupt-pointer';
    const badPtrDir=path.join(scratch,'sessions',canvasKey(badPtrCanvas));
    mkdirSync(badPtrDir,{recursive:true});
    writeFileSync(path.join(badPtrDir,'current.json'),'{truncated-json');
    const ptrSessions=await request(`/sessions?canvasId=${encodeURIComponent(badPtrCanvas)}`);
    assert.equal(ptrSessions.status,200,ptrSessions.text);
    assert.equal(JSON.parse(ptrSessions.text).currentSessionId,null);
    writeFileSync(path.join(badPtrDir,'current.json'),'{truncated-json-2');
    const ptrHist=await request(`/history?canvasId=${encodeURIComponent(badPtrCanvas)}`);
    assert.equal(ptrHist.status,200,ptrHist.text);
    assert.deepEqual(JSON.parse(ptrHist.text),{sessionId:null,turns:[]});
    rmSync(path.join(badPtrDir,'current.json'),{force:true});
    mkdirSync(path.join(badPtrDir,'current.json'),{recursive:true});
    const dirPtrHist=await request(`/history?canvasId=${encodeURIComponent(badPtrCanvas)}`);
    assert.equal(dirPtrHist.status,200,dirPtrHist.text);
    assert.deepEqual(JSON.parse(dirPtrHist.text),{sessionId:null,turns:[]});
    rmSync(path.join(badPtrDir,'current.json'),{recursive:true,force:true});
    if(process.platform!=='win32'&&typeof process.getuid==='function'&&process.getuid()!==0){
      const unreadablePtr=path.join(badPtrDir,'current.json');
      writeFileSync(unreadablePtr,JSON.stringify({sessionId:'durable:00000000-0000-4000-8000-000000000099'}));
      chmodSync(unreadablePtr,0o000);
      try{
        const permSessions=await request(`/sessions?canvasId=${encodeURIComponent(badPtrCanvas)}`);
        assert.equal(permSessions.status,503,permSessions.text);
        assert.equal(JSON.parse(permSessions.text).reason,'session_pointer_unavailable');
        const permHist=await request(`/history?canvasId=${encodeURIComponent(badPtrCanvas)}`);
        assert.equal(permHist.status,503,permHist.text);
        assert.equal(JSON.parse(permHist.text).reason,'session_pointer_unavailable');
      }finally{
        chmodSync(unreadablePtr,0o600);
        rmSync(unreadablePtr,{force:true});
      }
    }
    writeFileSync(path.join(badPtrDir,'current.json'),'{truncated-json-3');
    const ptrChat=await request('/chat',{canvasId:badPtrCanvas,message:'Heal corrupt pointer on chat.',turnId:'aa30',revisionBefore:1});
    assert.equal(ptrChat.status,200,ptrChat.text);
    const ptrSessionId=ptrChat.events.find(e=>e.type==='session')?.sessionId;
    assert(ptrSessionId);
    // While a new turn (aa31) is active before streaming any token after settled aa30, GET /history must never leak aa30's streamed text onto active!
    mode='hold-then-reply';
    const nextChatPromise=request('/chat',{canvasId:badPtrCanvas,sessionId:ptrSessionId,message:'Second turn.',turnId:'aa31',revisionBefore:1});
    const wNext=Date.now()+8000;while(!releaseHeldReply&&Date.now()<wNext)await delay(20);
    assert(releaseHeldReply,'aa31 must reach held model');
    const midSubmitHist=JSON.parse((await request(`/history?canvasId=${encodeURIComponent(badPtrCanvas)}`)).text);
    assert.equal(midSubmitHist.active?.turnId,'aa31');
    assert.notEqual(midSubmitHist.active?.streamed,'Synthetic probe acknowledged.','prior turn streamed text must never leak onto new active turn');
    releaseHeldReply();releaseHeldReply=null;
    mode='plain';
    const nextChatRes=await nextChatPromise;
    assert.equal(nextChatRes.status,200,nextChatRes.text);
    // POST /steer on an idle current session must return 409 session_not_running, never 500 internal_error!
    const idleSteerRes=await request('/steer',{canvasId:badPtrCanvas,sessionId:ptrSessionId,message:'Too late steer'});
    assert.equal(idleSteerRes.status,409,idleSteerRes.text);
    assert.equal(JSON.parse(idleSteerRes.text).reason,'session_not_running');
  });
} catch(error){results.push({name:'probe-runtime',passed:false,error:error.message});console.error(error.message);}
finally{
  if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await Promise.race([exited,delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  for(const server of [ops,provider])if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(destination)writeFileSync(destination,JSON.stringify({kind:'real-host-scripted-model-no-paid-calls',results,modelRequests:providerCount,opsCalls:seen,hostLog:hostLog.slice(-5000)},null,2));
  rmSync(scratch,{recursive:true,force:true});
}
if(results.some(r=>!r.passed))process.exitCode=1;
