process.env.NODE_ENV='test';
jest.mock('../db/loader',()=>require('./helpers/mockDb').createMockDb());
import db from '../db/loader';
import Gdm from '../db/repositories/GroupDmRepository';

describe('GroupDmRepository direct behavior',()=>{
  beforeEach(()=>db._reset?.());
  test('conversation/member lifecycle, read cursors and ownership transfer',async()=>{
    const g:any=await Gdm.create({name:'G',ownerId:'u1',lastMessageAt:1});
    expect(await Gdm.findById(g._id)).not.toBeNull();
    await Gdm.update(g._id,{name:'G2'}); expect((await Gdm.findById(g._id))?.name).toBe('G2');
    expect(await Gdm.markRead(g._id,'u1')).toBe(false);
    await Gdm.addMember(g._id,'u1'); await Gdm.addMember(g._id,'u2');
    expect(await Gdm.countMembers(g._id)).toBe(2); expect(await Gdm.findMember(g._id,'u1')).not.toBeNull(); expect(await Gdm.findMembers(g._id)).toHaveLength(2); expect(await Gdm.findGroupsByUser('u2')).toHaveLength(1);
    expect(await Gdm.markRead(g._id,'u1')).toBe(true); expect(typeof (await Gdm.findMember(g._id,'u1'))?.readAt).toBe('number');
    await Gdm.removeMember(g._id,'u1'); const next:any=await Gdm.transferOwnership(g._id); expect(next.userId).toBe('u2'); expect((await Gdm.findById(g._id))?.ownerId).toBe('u2');
    await Gdm.removeMember(g._id,'u2'); expect(await Gdm.transferOwnership(g._id)).toBeNull();
  });

  test('bulk member add/remove handles empty, fallback and insertMany paths',async()=>{
    const g:any=await Gdm.create({name:'G',ownerId:'u1'});
    await Gdm.addMembersMany(g._id,[]); await Gdm.addMembersMany(g._id,['u1','u2']); expect(await Gdm.countMembers(g._id)).toBe(2);
    await Gdm.removeMembersMany(g._id,[]); await Gdm.removeMembersMany(g._id,['u1']); expect(await Gdm.countMembers(g._id)).toBe(1);
    const col:any=db.groupDmMembers; const orig=col.insertMany; col.insertMany=jest.fn(async(docs:any[])=>{for(const d of docs) await col.insert(d);});
    try { await Gdm.addMembersMany(g._id,['u3','u4']); expect(col.insertMany).toHaveBeenCalledTimes(1); expect(await Gdm.countMembers(g._id)).toBe(3); } finally { if(orig) col.insertMany=orig; else delete col.insertMany; }
  });

  test('message lifecycle/unread filters exclude self/system and honor after cursor',async()=>{
    const g:any=await Gdm.create({name:'G',ownerId:'u1'});
    await Gdm.insertMessage({groupId:g._id,userId:'u1',type:'text',content:'self',createdAt:100});
    await Gdm.insertMessage({groupId:g._id,userId:'u2',type:'system',content:'sys',createdAt:200});
    const m:any=await Gdm.insertMessage({groupId:g._id,userId:'u2',type:'text',content:'new',createdAt:300});
    expect(await Gdm.countUnread(g._id,'u1')).toBe(1); expect(await Gdm.countUnread(g._id,'u1',350)).toBe(0); expect((await Gdm.findLatestUnread(g._id,'u1'))?._id).toBe(m._id); expect(await Gdm.findLatestUnread(g._id,'u1',350)).toBeNull();
    expect((await Gdm.findMessage(m._id,g._id))?.content).toBe('new'); expect(await Gdm.findMessage(m._id,'other')).toBeNull();
    expect(await Gdm.findMessages(g._id,{limit:500})).toHaveLength(3); expect(await Gdm.findMessages(g._id,{before:300})).toHaveLength(2);
  });

  test('deleteGroup removes messages, members, and conversation',async()=>{
    const g:any=await Gdm.create({name:'G',ownerId:'u1'}); await Gdm.addMember(g._id,'u1'); await Gdm.insertMessage({groupId:g._id,userId:'u1',content:'x'}); await Gdm.deleteGroup(g._id);
    expect(await Gdm.findById(g._id)).toBeNull(); expect(await Gdm.findMembers(g._id)).toHaveLength(0); expect(await Gdm.findMessages(g._id)).toHaveLength(0);
  });
});
