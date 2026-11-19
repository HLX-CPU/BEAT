import test from 'node:test';import assert from 'node:assert/strict';
import {Roster,apiHistory,API_HISTORY,API_HISTORY_TRUNCATED} from '../src/roster.mjs';
import {fixedConversation,unseenRecords,rememberRecords} from '../src/conversation.mjs';
function setup(agents){
 const kv=new Map(),config={flow:{},dock:[{id:'dock:d',name:'fixture',enabled:true,model:'fixture',baseUrl:'https://example.invalid/v1'}],secrets:{dockKeys:{'dock:d':'test'}}};
 const store={get:k=>kv.get(k),set:(k,v)=>kv.set(k,v),event:()=>{}};
 const roster=new Roster({config,store,agents});
 const call=(sessions,agent,role,prompt,extra={})=>roster.call({runId:'R1',sessions,seat:agent,slot:agent+':'+role,role,cwd:'E:/fixture',models:{codex:'c',deepseek:'d'},build:()=>prompt,...extra});
 return {roster,call,config,store};
}
test('native discussion, execution, evaluation and resumed calls retain one ID; new task creates a new ID',async()=>{
 let created=0;const seen=[];
 const {call}=setup({codex:async o=>{seen.push([o.nativeId,o.access]);const id=o.nativeId||'native-'+(++created);o.onNative?.(id);return {nativeId:id,text:'reply'};}});
 const sessions={};await call(sessions,'codex','think','discussion');await call(sessions,'codex','write','execution');
 const reloaded=JSON.parse(JSON.stringify(sessions));await call(reloaded,'codex','think','evaluation');await call(reloaded,'codex','write','resume');
 assert.deepEqual(seen.map(x=>x[0]),[undefined,'native-1','native-1','native-1']);assert.equal(seen[1][1],'workspace-write');assert.equal(created,1);
 await call({},'codex','think','new task',{runId:'R2'});assert.equal(created,2);assert.equal(seen.at(-1)[0],undefined);
});
test('legacy execution slots migrate to an existing conversation without creating a replacement',()=>{
 const sessions={'codex:exec:codex':{native:'existing',model:'c'}};
 assert.equal(fixedConversation(sessions,'codex',{id:'R1',cwd:'E:/fixture'}).native,'existing');
 assert.equal(sessions['codex:exec:codex'].native,'existing');
});
test('different slots for one partner serialize while different partners still run concurrently',async()=>{
 const active={codex:0,deepseek:0},peak={codex:0,deepseek:0};let total=0,totalPeak=0;
 const agent=who=>async o=>{active[who]++;peak[who]=Math.max(peak[who],active[who]);total++;totalPeak=Math.max(totalPeak,total);await new Promise(r=>setTimeout(r,20));active[who]--;total--;return {nativeId:o.nativeId||who,text:'ok'};};
 const {call}=setup({codex:agent('codex'),deepseek:agent('deepseek')});const sessions={};
 await Promise.all([call(sessions,'codex','think','one'),call(sessions,'codex','write','two'),call(sessions,'deepseek','write','three')]);
 assert.equal(peak.codex,1);assert.equal(totalPeak,2);
});
test('dock history continues across discussion, execution and evaluation with stable conversation ID',async()=>{
 const seen=[];const reply=async o=>{seen.push(JSON.parse(JSON.stringify(o)));return {text:'reply-'+seen.length,status:'succeeded',desktopTaskId:'D-'+seen.length,history:[...o.history,{role:'user',content:o.prompt},{role:'assistant',content:'reply-'+seen.length}]};};
 const {call}=setup({dockRead:(_id,o)=>reply(o),desktopDock:(_id,o)=>reply(o)});let sessions={};
 await call(sessions,'dock:d','think','discuss');await call(sessions,'dock:d','write','execute');sessions=JSON.parse(JSON.stringify(sessions));await call(sessions,'dock:d','think','evaluate');
 assert.equal(new Set(seen.map(s=>s.conversationId)).size,1);assert.deepEqual(seen.map(s=>s.history.length),[0,2,4]);
 assert.deepEqual(seen[2].history.filter(m=>m.role==='user').map(m=>m.content),['discuss','execute']);
});
test('each partner receives only unseen discussion records; fixed task records persist across reloads',()=>{
 const sessions={},records=[{label:'Codex',text:'first'},{label:'DeepSeek',text:'second'}];const c=fixedConversation(sessions,'codex',{id:'R1'});
 rememberRecords(records.slice(0,1),c);assert.deepEqual(unseenRecords(records,sessions,'codex'),records.slice(1));
 assert.deepEqual(unseenRecords(records,JSON.parse(JSON.stringify(sessions)),'codex'),records.slice(1));
 assert.equal(unseenRecords(records,sessions,'deepseek').length,2);
});
test('native continuation returning a different ID fails instead of silently resetting context',async()=>{
 let n=0;const {call}=setup({codex:async()=>({nativeId:++n===1?'one':'two',text:'reply'})});const sessions={};
 await call(sessions,'codex','think','first');await assert.rejects(call(sessions,'codex','write','second'),/不同的原生 ID/);
 assert.equal(sessions['conversation:codex'].native,'one');
});
// R138 审计发现：控制器记账里有历史，但 API 搭档（拓展坞/Claude）在 reference 模式下收到的是空数组——每步失忆、续问接不上。
test('API 搭档在 reference 模式下也带上同一会话的上文（默认开，不是按需勾选）',async()=>{
 const seen=[];const {call}=setup({dock:async(id,o)=>{seen.push(JSON.parse(JSON.stringify(o)));return {text:'答复'+seen.length};}});
 let sessions={};const opts={contextPolicy:'references',referenceOnly:false};
 await call(sessions,'dock:d','think','第一个问题',opts);
 sessions=JSON.parse(JSON.stringify(sessions));await call(sessions,'dock:d','think','第二个问题',opts);
 sessions=JSON.parse(JSON.stringify(sessions));await call(sessions,'dock:d','think','第三个问题',opts);
 assert.deepEqual(seen[0].history,[],'第一步没有上文');
 assert.deepEqual(seen[1].history.map(m=>m.role),['user','assistant'],'第二步必须带同一会话的第一步');
 assert.deepEqual(seen[1].history.map(m=>m.content),['第一个问题','答复1']);
 assert.deepEqual(seen[2].history.map(m=>m.content),['第一个问题','答复1','第二个问题','答复2'],'同一会话逐轮累积');
 assert.equal(new Set(seen.map(s=>s.conversationId)).size,1,'始终是同一条固定会话');
 assert.equal(seen[0].system!==undefined,true,'系统提示仍然按原样下发');
});
test('发给 API 搭档的上文有上限：条数、单条、总量都封顶，超出只留最近的',()=>{
 assert.deepEqual(apiHistory([]),[]);
 assert.deepEqual(apiHistory(null),[]);
 const many=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',content:'第'+i+'条'}));
 const capped=apiHistory(many);
 assert.ok(capped.length<=API_HISTORY.messages,'条数有上限');
 assert.deepEqual(capped.at(-1),{role:'assistant',content:'第39条'},'留下的是最近的');
 assert.deepEqual(capped[0],{role:'user',content:'第'+(40-capped.length)+'条'},'按时间顺序返回');
 const huge={role:'user',content:'x'.repeat(API_HISTORY.messageChars+500)};
 assert.equal(apiHistory([huge])[0].content.length,API_HISTORY.messageChars+API_HISTORY_TRUNCATED.length);
 const fat=Array.from({length:8},()=>({role:'assistant',content:'y'.repeat(3000)}));
 assert.ok(apiHistory(fat).reduce((n,m)=>n+m.content.length,0)<=API_HISTORY.chars,'总量有上限');
 assert.deepEqual(apiHistory([{role:'system',content:'不该出现'}]).map(m=>m.role),['user'],'只保留 user/assistant');
 assert.deepEqual(apiHistory([{role:'user',content:'   '}]),[],'空白内容丢掉');
});
// 「截断了不就会报错吗」：截断只发生在上文，且保留开头、标明截断；当前这条提问永远原样送达。
test('截断只动上文：保留开头、标明截断、当前提问一个字都不少',async()=>{
 const long='开头代号：紫电-77。'+'说明'.repeat(3000)+'。请只回复 OK。';
 assert.ok(long.length>API_HISTORY.messageChars,'构造的超长消息要真的超上限');
 const sent=apiHistory([{role:'user',content:long},{role:'assistant',content:'OK'}]);
 assert.equal(sent[0].content.startsWith('开头代号：紫电-77。'),true,'截断必须保留开头（问题/目标都在开头）');
 assert.equal(sent[0].content.endsWith(API_HISTORY_TRUNCATED),true,'截断标记必须在末尾');
 assert.ok(sent[0].content.length<long.length);
 assert.equal(sent[0].content.length,API_HISTORY.messageChars+API_HISTORY_TRUNCATED.length);
 assert.deepEqual(sent[1],{role:'assistant',content:'OK'},'没超上限的消息原样保留');
 const newest={role:'assistant',content:'z'.repeat(API_HISTORY.chars*3)};
 assert.equal(apiHistory([newest]).length,1,'最近一条永远留得住，不会因为超总量而被清空');
 // 当前这条提问（prompt）不走上文通道：它原样传给搭档，绝不会被截断。
 const seen=[];const {call}=setup({dock:async(id,o)=>{seen.push(JSON.parse(JSON.stringify(o)));return {text:'OK'};}});
 let sessions={};
 const opt={contextPolicy:'references'};
 await call(sessions,'dock:d','think','第一问',opt);
 sessions=JSON.parse(JSON.stringify(sessions));await call(sessions,'dock:d','think',long,opt);
 sessions=JSON.parse(JSON.stringify(sessions));await call(sessions,'dock:d','think','第三问',opt);
 assert.equal(seen[1].prompt,long,'当前提问必须一字不差地送达（超长也不截）');
 assert.deepEqual(seen[1].history.map(m=>m.content),['第一问','OK'],'上文只放之前发生过的往来');
 const inHistory=seen[2].history.find(m=>m.content.startsWith('开头代号：紫电-77。'));
 assert.ok(inHistory,'上一条超长消息应当作为上文出现');
 assert.equal(inHistory.content.endsWith(API_HISTORY_TRUNCATED),true,'轮到它做上文时才截断，并且保留开头');
 assert.equal(inHistory.content.length,API_HISTORY.messageChars+API_HISTORY_TRUNCATED.length);
 assert.equal(seen[2].prompt,'第三问','当前提问依旧原样');
});
// 提供方回的是「含上文的完整历史」，不能再跟本地历史拼接：否则同一轮被记两次（实测 6→14→28 条），
// 上限额度全浪费在重复内容上，模型也会看到重复对话。
test('会话历史不重复累积：多轮之后每条只出现一次',async()=>{
 const seen=[];
 const {call}=setup({dock:async(id,o)=>{const t='答复'+(seen.length+1);seen.push(JSON.parse(JSON.stringify(o)));return {text:t,history:[...(o.history||[]),{role:'user',content:o.prompt},{role:'assistant',content:t}]};}});
 let sessions={};
 for(const q of ['第一问','第二问','第三问','第四问']){await call(sessions,'dock:d','think',q,{contextPolicy:'references'});sessions=JSON.parse(JSON.stringify(sessions));}
 assert.deepEqual(seen.map(s=>s.history.length),[0,2,4,6],'每一轮只加两条');
 assert.deepEqual(seen[3].history.map(m=>m.content),['第一问','答复1','第二问','答复2','第三问','答复3'],'没有重复条目');
 assert.equal(new Set(seen[3].history.map(m=>m.content)).size,6,'六条各不相同');
 const stored=sessions['conversation:dock:d'].history;
 assert.equal(stored.length,8,'本地存的也该是 8 条（4 轮 × 2），而不是翻倍累积');
 assert.equal(new Set(stored.map(m=>m.content)).size,8,'本地历史同样不允许重复');
});

test('DeepSeek 原会话丢失：清理失效会话并用新会话继续，不把任务卡死（R408 回归）',async()=>{
 const seen=[];
 const {call}=setup({deepseek:async o=>{
   seen.push(o.nativeId);
   if(seen.length===1){const e=new Error('DeepSeek 原会话已不存在（可能换了登录目录或会话被清理），本次没有开始执行');e.code='NATIVE_SESSION_MISSING';e.notDispatched=true;e.noFallback=true;throw e;}
   o.onNative?.('native-new');return {nativeId:'native-new',nativeHome:'C:/mock-dsh',text:'ok'};
 }});
 const sessions={'conversation:deepseek:write':{id:'R1:deepseek:write',cwd:'E:/fixture',native:'native-old',policy:'write',history:[],deepseekHome:'C:/mock-dsh'}};
 const r=await call(sessions,'deepseek','write','执行');
 assert.deepEqual(seen,['native-old',undefined],'第一次续用原会话，丢失后必须用新会话继续而不是反复撞同一 ID');
 assert.equal(sessions['conversation:deepseek:write'].native,'native-new');
 assert.equal(sessions['conversation:deepseek:write'].deepseekHome,'C:/mock-dsh','新会话所在的 home 要记录下来供后续续用');
 assert.equal(r.nativeId,'native-new');
});

test('电脑助手类的提供方账号池故障先标记冷却再拒绝重放，避免 1 秒内连续重试同一家（R408 回归）',async()=>{
 const {call,roster}=setup({desktopDock:async()=>{
   const e=new Error('桌面搭档未完成：酷AI-Gemini：服务商的上游账号池暂时没有可用账号');
   e.noFallback=true;e.desktopTaskId='D-fixture';e.desktopEvidence={status:'failed',calls:[]};throw e;
 }});
 await assert.rejects(call({},'dock:d','write','执行'),/上游账号池/);
 const state=roster.state('dock:d');
 assert.equal(state.status,'cooldown','账号池故障必须进入冷却，队列才不会立刻再选同一家');
 assert.match(state.reason||'',/账号池/);
});
