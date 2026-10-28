import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nodesOf,namedNode,centerOf} from '../scripts/android-auth-ui.mjs';
const node=(pkg,text,extra='')=>`<node package="${pkg}" text="${text}" content-desc="" enabled="true" bounds="[10,20][110,80]" ${extra}/>`;
test('native selectors require the intended app, exact label and enabled control',()=>{
  const nodes=nodesOf('<hierarchy>'+node('chrome','Sign out')+node('bridge','Sign out')+node('bridge','Sign out extra')+'</hierarchy>');
  assert.equal(namedNode(nodes,'Sign out',['bridge']).package,'bridge');
  assert.equal(namedNode(nodes,'Missing',['bridge']),null);
});
test('ambiguous native controls fail closed instead of clicking an arbitrary account or consent',()=>{
  const nodes=nodesOf('<hierarchy>'+node('bridge','Continue')+node('bridge','Continue')+'</hierarchy>');
  assert.throws(()=>namedNode(nodes,'Continue',['bridge']),/AMBIGUOUS_NATIVE_CONTROL/);
});
test('accessibility labels decode XML entities and gestures use actual positive bounds',()=>{
  const nodes=nodesOf('<hierarchy>'+node('settings','Encryption &amp; credentials')+'</hierarchy>');
  assert.deepEqual(centerOf(namedNode(nodes,'Encryption & credentials',['settings'])),[60,50]);
  assert.throws(()=>centerOf({bounds:'[0,0][0,0]'}),/EMPTY_NATIVE_CONTROL/);
  assert.throws(()=>nodesOf('<html/>'),/NATIVE_UI_HIERARCHY_REQUIRED/);
});
