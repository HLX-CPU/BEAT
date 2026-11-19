import fs from 'node:fs';
import {call}from '../src/client.mjs';
const id=process.argv[2];if(!/^R\d+$/.test(id||''))throw new Error('Provide run ID');
let before='';
for(let n=0;n<160;n++){
const r=await call('beat_get',{id,wait_seconds:15});
const brief={id,state:r.state,steps:r.steps.map(s=>({agent:s.agent,state:s.state,role:s.role,note:s.note,error:s.error})),queue:r.taskQueue?.map(t=>({id:t.id,state:t.state,executor:t.executor,issues:t.issues})),metrics:r.controlMetrics?.phases,discussion:r.discussionMetrics};
const summary=JSON.stringify(brief);if(summary!==before){console.log(summary);before=summary;}
if(r.finished){fs.writeFileSync(`data/reports/control-live-${id}-final.json`,JSON.stringify(r,null,2));console.log(JSON.stringify({final:r.state,error:r.error,result:r.result}));process.exitCode=r.state==='passed'?0:1;break;}
}
