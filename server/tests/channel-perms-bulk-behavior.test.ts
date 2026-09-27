process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: jest.fn().mockResolvedValue(actual.PERMS.MANAGE_CHANNELS), hasPermission: jest.fn().mockReturnValue(true) };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import channelPermsRouter from '../routes/channelPerms';
import { PERMS } from '../lib/permissions';
import { ChannelPermissions } from '../db/repositories';

const db = require('../db/loader');
const permissions = require('../lib/permissions');
const { invalidatePerms } = require('../lib/permCache');
import { requireDoc } from './helpers/mockDb';

const SID='bulk-behavior-server', CID='bulk-source', C2='bulk-target-2', C3='bulk-target-3', USER='bulk-user';
const R1='bulk-role-1', R2='bulk-role-2', R3='bulk-role-3';
function token(){return jwt.sign({id:USER,v:0},process.env.JWT_SECRET!,{expiresIn:'1h'});}
function app(io:any=null){const a=express();a.use(express.json());if(io)a.set('io',io);a.use('/api/servers/:sid/channels/:cid/permissions',channelPermsRouter);return a;}
async function seed(){
 db._reset?.(); jest.clearAllMocks(); permissions.resolvePermissions.mockResolvedValue(PERMS.MANAGE_CHANNELS); permissions.hasPermission.mockReturnValue(true);
 await db.users.insert({_id:USER,username:'bulkuser',displayName:'Bulk User',tokenVersion:0});
 await db.servers.insert({_id:SID,name:'Bulk Server',ownerId:USER,logChannelId:'log'});
 await db.channels.insert({_id:CID,serverId:SID,name:'source',type:'text'});
 await db.channels.insert({_id:C2,serverId:SID,name:'two',type:'voice'});
 await db.channels.insert({_id:C3,serverId:SID,name:'three'});
 await db.channels.insert({_id:'log',serverId:SID,name:'logs',type:'text'});
 await db.roles.insert({_id:R1,serverId:SID,name:'Alpha',permissions:0});
 await db.roles.insert({_id:R2,serverId:SID,name:'Beta',permissions:0});
 await db.roles.insert({_id:R3,serverId:SID,name:'Gamma',permissions:0});
}

describe('channel permission bulk state machine',()=>{
 beforeEach(seed);

 it('bulk-sync replaces each target, excludes the source, audits every target and broadcasts', async()=>{
  await db.channelPermissions.insert({_id:'old2',channelId:C2,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  await db.channelPermissions.insert({_id:'old3',channelId:C3,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  const emit=jest.fn(),io={to:jest.fn().mockReturnValue({emit})};
  const res=await request(app(io)).post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync`).set('Authorization',`Bearer ${token()}`).send({
   channelIds:[CID,C2,C3], overrides:[{roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0},{roleId:R2,allow:0,deny:PERMS.ATTACH_FILES}],
  });
  expect(res.status).toBe(200); expect(res.body).toEqual({ok:true,updated:2});
  expect(await db.channelPermissions.count({channelId:C2})).toBe(2);
  expect(await db.channelPermissions.count({channelId:C3})).toBe(2);
  expect(await db.channelPermissions.count({channelId:CID})).toBe(0);
  expect(await db.auditLogs.count({serverId:SID,action:'PERM_BULK_SYNC'})).toBe(2);
  expect(emit).toHaveBeenCalledTimes(2);
  expect(invalidatePerms).toHaveBeenCalledWith(SID);
 });

 it('bulk preview reports added, updated, removed and unchanged entries accurately', async()=>{
  await db.channelPermissions.insert({_id:'r1',channelId:C2,serverId:SID,roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0});
  await db.channelPermissions.insert({_id:'r2',channelId:C2,serverId:SID,roleId:R2,allow:0,deny:PERMS.ATTACH_FILES});
  await db.channelPermissions.insert({_id:'r3',channelId:C2,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync/preview`).set('Authorization',`Bearer ${token()}`).send({
   channelIds:[CID,C2,C3], overrides:[
    {roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0}, // unchanged on C2
    {roleId:R2,allow:PERMS.ATTACH_FILES,deny:0}, // updated on C2
   ],
  });
  expect(res.status).toBe(200);
  const two=res.body.preview.find((x:any)=>x.channelId===C2);
  const three=res.body.preview.find((x:any)=>x.channelId===C3);
  expect(two).toMatchObject({channelType:'voice',added:0,updated:1,removed:1,unchanged:1,totalChanges:2});
  expect(three).toMatchObject({channelType:'text',added:2,updated:0,removed:0,unchanged:0,totalChanges:2});
  expect(res.body.summary).toMatchObject({totalChannels:2,channelsWithChanges:2,totalAdded:2,totalUpdated:1,totalRemoved:1});
 });

 it('batch updates existing, inserts new, deletes requested roles and writes one summary log', async()=>{
  await db.channelPermissions.insert({_id:'existing',channelId:CID,serverId:SID,roleId:R1,allow:0,deny:PERMS.SEND_MESSAGES});
  await db.channelPermissions.insert({_id:'delete-me',channelId:CID,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  const emit=jest.fn(),io={to:jest.fn().mockReturnValue({emit})};
  const res=await request(app(io)).put(`/api/servers/${SID}/channels/${CID}/permissions/batch`).set('Authorization',`Bearer ${token()}`).send({
   overrides:[{roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0,targetType:'role',targetName:'Alpha'},{roleId:R2,allow:0,deny:PERMS.ATTACH_FILES}], deletes:[R3],
  });
  expect(res.status).toBe(200); expect(res.body).toEqual({ok:true,saved:2,deleted:1});
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R1})).toMatchObject({allow:PERMS.SEND_MESSAGES,deny:0});
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R2})).toBeTruthy();
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R3})).toBeNull();
  expect(await db.auditLogs.count({serverId:SID,channelId:CID})).toBe(3);
  expect(await db.messages.count({channelId:'log'})).toBe(1);
  expect(emit).toHaveBeenCalledWith('permissions:updated',{serverId:SID,channelId:CID});
 });

 it('batch with no changes is a valid no-op and does not create a log message', async()=>{
  const res=await request(app()).put(`/api/servers/${SID}/channels/${CID}/permissions/batch`).set('Authorization',`Bearer ${token()}`).send({overrides:[],deletes:[]});
  expect(res.status).toBe(200); expect(res.body).toEqual({ok:true,saved:0,deleted:0});
  expect(await db.messages.count({channelId:'log'})).toBe(0);
 });

 it('export enriches local role names, everyone, and safely falls back for stale ids', async()=>{
  await db.channelPermissions.insert({_id:'e1',channelId:CID,serverId:SID,roleId:R1,allow:1,deny:0});
  await db.channelPermissions.insert({_id:'e2',channelId:CID,serverId:SID,roleId:'__everyone__',allow:0,deny:2});
  await db.channelPermissions.insert({_id:'e3',channelId:CID,serverId:SID,roleId:'stale-role',allow:4,deny:0});
  const res=await request(app()).get(`/api/servers/${SID}/channels/${CID}/permissions/export`).set('Authorization',`Bearer ${token()}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({version:1,sourceServer:'Bulk Server',sourceChannel:'source'});
  expect(res.body.overrides.find((x:any)=>x.roleId===R1).roleName).toBe('Alpha');
  expect(res.body.overrides.find((x:any)=>x.roleId==='__everyone__').roleName).toBe('@everyone');
  expect(res.body.overrides.find((x:any)=>x.roleId==='stale-role').roleName).toBe('stale-role');
 });

 it('import replace mode removes old overrides, updates mapped entries, skips users/unknown roles and reports them', async()=>{
  await db.channelPermissions.insert({_id:'old',channelId:CID,serverId:SID,roleId:R3,allow:1,deny:0});
  const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`).set('Authorization',`Bearer ${token()}`).send({
   merge:false, overrides:[
    {roleId:'foreign-alpha',roleName:'Alpha',allow:PERMS.SEND_MESSAGES,deny:0},
    {roleId:R2,allow:0,deny:PERMS.ATTACH_FILES},
    {roleId:'user:abc',roleName:'Some User',targetType:'user',allow:1,deny:0},
    {roleId:'missing-role',allow:1,deny:0},
   ],
  });
  expect(res.status).toBe(200); expect(res.body).toMatchObject({ok:true,imported:2,merge:false,skippedCount:2});
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R3})).toBeNull();
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R1})).toBeTruthy();
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R2})).toBeTruthy();
 });

 it('import merge mode preserves existing rows and updates matching rows', async()=>{
  await db.channelPermissions.insert({_id:'keep',channelId:CID,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  await db.channelPermissions.insert({_id:'update',channelId:CID,serverId:SID,roleId:R1,allow:0,deny:PERMS.SEND_MESSAGES});
  const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`).set('Authorization',`Bearer ${token()}`).send({
   merge:true, overrides:[{roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0}],
  });
  expect(res.status).toBe(200); expect(res.body).toMatchObject({imported:1,merge:true});
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R3})).toBeTruthy();
  expect(await db.channelPermissions.findOne({channelId:CID,roleId:R1})).toMatchObject({allow:PERMS.SEND_MESSAGES,deny:0});
 });

 it('bulk-sync atomic owner rejection causes no partial mutation, audit, or invalidation', async()=>{
  await db.channelPermissions.insert({_id:'keep-target',channelId:C2,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  jest.spyOn(ChannelPermissions,'replaceManyChannelsAtomic').mockResolvedValueOnce(false);
  const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync`)
    .set('Authorization',`Bearer ${token()}`).send({channelIds:[C2,C3],overrides:[{roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0}]});
  expect(res.status).toBe(404);
  expect(await db.channelPermissions.findOne({_id:'keep-target'})).toBeTruthy();
  expect(await db.auditLogs.count({action:'PERM_BULK_SYNC'})).toBe(0);
  expect(invalidatePerms).not.toHaveBeenCalled();
 });

 it('batch atomic owner rejection leaves prior permission state and side effects untouched', async()=>{
  await db.channelPermissions.insert({_id:'keep-batch',channelId:CID,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  jest.spyOn(ChannelPermissions,'applyChannelBatchAtomic').mockResolvedValueOnce(false);
  const res=await request(app()).put(`/api/servers/${SID}/channels/${CID}/permissions/batch`)
    .set('Authorization',`Bearer ${token()}`).send({overrides:[{roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0}],deletes:[R3]});
  expect(res.status).toBe(404);
  expect(await db.channelPermissions.findOne({_id:'keep-batch'})).toBeTruthy();
  expect(await db.auditLogs.count({serverId:SID,channelId:CID})).toBe(0);
  expect(invalidatePerms).not.toHaveBeenCalled();
 });

 it.each([
  ['merge',true,'applyChannelBatchAtomic'],
  ['replace',false,'replaceManyChannelsAtomic'],
 ] as const)('import %s atomic owner rejection preserves existing rows',async(_label,merge,method)=>{
  await db.channelPermissions.insert({_id:'keep-import',channelId:CID,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  jest.spyOn(ChannelPermissions,method).mockResolvedValueOnce(false);
  const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
    .set('Authorization',`Bearer ${token()}`).send({merge,overrides:[{roleId:R1,allow:PERMS.SEND_MESSAGES,deny:0}]});
  expect(res.status).toBe(404);
  expect(await db.channelPermissions.findOne({_id:'keep-import'})).toBeTruthy();
  expect(invalidatePerms).not.toHaveBeenCalled();
 });

 it('import rejects two source rows that map to the same local role before replacement',async()=>{
  await db.channelPermissions.insert({_id:'keep-duplicate-map',channelId:CID,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
  const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
    .set('Authorization',`Bearer ${token()}`).send({merge:false,overrides:[
      {roleId:'source-alpha-a',roleName:'Alpha',allow:PERMS.SEND_MESSAGES,deny:0},
      {roleId:'source-alpha-b',roleName:'Alpha',allow:0,deny:PERMS.ATTACH_FILES},
    ]});
  expect(res.status).toBe(400);
  expect(await db.channelPermissions.findOne({_id:'keep-duplicate-map'})).toBeTruthy();
 });
});

describe('channel permission import hostile-body validation',()=>{
 beforeEach(seed);
 it.each([
  [null,'nesne'],
  [7,'nesne'],
  [{roleId:'',allow:0,deny:0},'roleId'],
  [{roleId:R1,roleName:7,allow:0,deny:0},'roleName'],
  [{roleId:R1,targetType:'admin',allow:0,deny:0},'targetType'],
  [{roleId:R1,allow:1.5,deny:0},'tamsayı'],
  [{roleId:R1,allow:0,deny:Number.MAX_SAFE_INTEGER+1},'tamsayı'],
 ])('rejects malformed import override %p before repository mutation',async(override,needle)=>{
   await db.channelPermissions.insert({_id:'preserve',channelId:CID,serverId:SID,roleId:R3,allow:PERMS.VIEW_CHANNELS,deny:0});
   const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
     .set('Authorization',`Bearer ${token()}`).send({merge:false,overrides:[override]});
   expect(res.status).toBe(400);
   expect(res.body.error).toContain(needle);
   expect(await db.channelPermissions.findOne({channelId:CID,roleId:R3})).toBeTruthy();
 });

 it('ignores malformed persisted role names while still importing by canonical role id',async()=>{
   await db.roles.update({_id:R2},{$set:{name:null}});
   const res=await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
     .set('Authorization',`Bearer ${token()}`).send({merge:true,overrides:[{roleId:R2,allow:0,deny:PERMS.ATTACH_FILES}]});
   expect(res.status).toBe(200);
   expect(await db.channelPermissions.findOne({channelId:CID,roleId:R2})).toBeTruthy();
 });
});
