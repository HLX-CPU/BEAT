import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOLS,MCP_TOOLS} from '../src/tools.mjs';

const d={id:'dock:t',model:'glm-5.3',baseUrl:'https://relay.invalid/v1',reasoningConfig:{protocol:'glm',models:['glm-5.3'],levels:['low','high','max']}};
test('dock reasoning preview supports editing and clearing declaration',()=>{
 const o={config:{dock:[d]}};
 assert.equal(TOOLS.dock_reasoning.run(o,{id:d.id}).status,'supported');
 assert.equal(TOOLS.dock_reasoning.run(o,{id:d.id,reasoning:null}).status,'unknown');
 assert.equal(TOOLS.dock_reasoning.run(o,{id:d.id,model:'unknown-model'}).status,'unknown');
});
test('collaboration tool rejects spoofed native provider in dock effort map',async()=>{
 await assert.rejects(()=>TOOLS.beat_parallel.run({models:{}},{goal:'g',dock_efforts:{codex:'high'}},'codex'),/dock:id/);
});
test('dock quick ask accepts supported effort without calling native effort catalog',async()=>{
 const o={config:{dock:[d]},models:{validateEffort:()=>{throw Error('must not validate dock as native');}},startAsk:a=>({id:'R-fixture',effort:a.effort}),waitFor:async id=>({id})};
 assert.deepEqual(await TOOLS.beat_ask.run(o,{to:d.id,question:'g',effort:'low',wait_seconds:0},'codex'),{id:'R-fixture'});
});
test('reasoning capability is discoverable from MCP',()=>assert.ok(MCP_TOOLS.some(t=>t.name==='dock_reasoning')));
