'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizedTables, normalizedIndexes, summarizePlan, collectEvidence } = require('./p7-partition-assessment.cjs');
test('converts only allowlisted aggregate catalog data', () => {
  const a = normalizedTables([{table_name:'messages',estimated_rows:'60',stat_live_rows:'55',stat_dead_rows:'5',heap_bytes:'1000',index_bytes:'500',total_bytes:'1600',analyzed:true,partitioned:false,partitions:0}]);
  assert.deepEqual(a,[{table:'messages',estimatedRows:60,statLiveRows:55,statDeadRows:5,heapBytes:1000,indexBytes:500,totalBytes:1600,analyzed:true,partitioned:false,partitions:0}]);
  assert.throws(()=>normalizedTables([{table_name:'users',stat_live_rows:'0',stat_dead_rows:'0',heap_bytes:0,index_bytes:0,total_bytes:0,partitions:0}]));
  assert.deepEqual(normalizedIndexes([{table_name:'messages',index_name:'idx_messages_channel_cursor',index_bytes:'321',scans:'5'}]), [{table:'messages',index:'idx_messages_channel_cursor',bytes:321,scansSinceStatsReset:5}]);
});
test('summarizes plans without leaking filter values or query text', () => {
  const input=[{Plan:{'Node Type':'Limit','Plan Rows':50,'Total Cost':32.25,Plans:[{'Node Type':'Index Scan','Index Name':'idx_messages_channel_cursor','Plan Rows':20,'Total Cost':25.3,'Filter':'private@secret.test','Index Cond':'"channelId" = real-person-id'}]}}];
  const result=summarizePlan(input);
  assert.equal(result[1].index,'idx_messages_channel_cursor');
  assert.doesNotMatch(JSON.stringify(result),/real-person|secret|Filter|Cond/);
  assert.throws(()=>summarizePlan([{Plan:{'Node Type':'Bad!!!','Plan Rows':1,'Total Cost':0}}]));
});
test('enforces transaction read-only and never echoes operator-supplied channel/server ids', async () => {
  const statements=[];
  const client={async query(sql,params){statements.push({sql,params});if(sql.includes('pg_stat_user_tables'))return {rows:[]};if(sql.includes('pg_stat_user_indexes'))return {rows:[]};if(sql.startsWith('EXPLAIN'))return {rows:[{'QUERY PLAN':[{Plan:{'Node Type':'Limit','Plan Rows':50,'Total Cost':1}}]}]};return {rows:[]};}};
  const data=await collectEvidence(client,{P7_CHANNEL_PROBE_ID:'private-channel-44',P7_SERVER_PROBE_ID:'private-server-33'});
  assert.equal(statements[0].sql,'BEGIN TRANSACTION READ ONLY');
  assert.equal(statements.at(-1).sql,'COMMIT');
  assert.equal(data.readOnly,true);
  assert.deepEqual(data.plans.map(x=>x.inputKind),['operator-supplied','operator-supplied']);
  assert.doesNotMatch(JSON.stringify(data),/private-channel|private-server/);
});
test('database errors roll back without returning partial evidence', async()=>{
  const statements=[];
  const client={async query(sql){statements.push(sql);if(sql.includes('pg_stat_user_tables'))throw new Error('fake query failure');return {rows:[]};}};
  await assert.rejects(()=>collectEvidence(client,{}),/fake query failure/);
  assert.equal(statements.at(-1),'ROLLBACK');
});
