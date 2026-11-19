import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequestedPartnerModel} from '../src/tools.mjs';

test('an explicitly pinned configured dock model uses its own catalog, never the native provider catalog', async () => {
  let nativeCalls=0;
  const o={config:{dock:[{id:'dock:judge',model:'exact-judge'}],claude:{model:'exact-advisor'}},models:{validate:async()=>{nativeCalls++;}}};
  await validateRequestedPartnerModel(o,'dock:judge','exact-judge');
  await validateRequestedPartnerModel(o,'claude','exact-advisor');
  assert.equal(nativeCalls,0);
  await assert.rejects(validateRequestedPartnerModel(o,'dock:judge','different'),/未派发/);
  await assert.rejects(validateRequestedPartnerModel(o,'dock:missing','exact-judge'),/未派发/);
  assert.equal(nativeCalls,0);
  await validateRequestedPartnerModel(o,'codex','native-model');
  assert.equal(nativeCalls,1);
});
