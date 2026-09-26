'use strict';
process.env.NODE_ENV='test';

const get = jest.fn();
const set = jest.fn();
const withKeyLock = jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn());
jest.mock('../lib/redisAdapter', () => ({ cache: { getAuthoritative: get, setAuthoritative: set, withKeyLock } }));

import {
  setChannelKeyPackage, getChannelKeyPackage, getWrappedKeyForUser,
  isChannelE2EEEnabled, addMemberKey, removeMemberKey,
} from '../lib/channelE2EE';

const TTL = 60 * 60 * 24 * 30;

describe('channelE2EE key-package state machine', () => {
  beforeEach(() => {
    get.mockReset(); set.mockReset(); withKeyLock.mockClear();
    set.mockResolvedValue(undefined);
    withKeyLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
  });

  it('creates epoch 1 package and writes canonical Redis key with 30-day TTL', async () => {
    get.mockResolvedValueOnce(null);
    jest.spyOn(Date,'now').mockReturnValue(1234);
    const pkg=await setChannelKeyPackage('ch1',{u1:'wrapped'});
    expect(pkg).toEqual({channelId:'ch1',wrappedKeys:{u1:'wrapped'},epoch:1,updatedAt:1234});
    expect(set).toHaveBeenCalledWith('e2ee:channel:keys:ch1',pkg,TTL);
    expect(withKeyLock).toHaveBeenCalledWith('e2ee-channel:ch1', expect.any(Function));
    jest.restoreAllMocks();
  });

  it('rotating an existing package increments epoch rather than resetting it', async () => {
    get.mockResolvedValueOnce({channelId:'ch1',wrappedKeys:{u1:'old'},epoch:7,updatedAt:1});
    const pkg=await setChannelKeyPackage('ch1',{u1:'new'});
    expect(pkg.epoch).toBe(8);
    expect(pkg.wrappedKeys.u1).toBe('new');
  });

  it('get passes through null/package and wrapped-key lookup handles all branches', async () => {
    get.mockResolvedValueOnce(null);
    expect(await getChannelKeyPackage('none')).toBeNull();

    get.mockResolvedValueOnce(null);
    expect(await getWrappedKeyForUser('ch','u')).toBeNull();

    get.mockResolvedValueOnce({channelId:'ch',wrappedKeys:{other:'x'},epoch:2,updatedAt:1});
    expect(await getWrappedKeyForUser('ch','u')).toBeNull();

    get.mockResolvedValueOnce({channelId:'ch',wrappedKeys:{u:'abc'},epoch:3,updatedAt:1});
    expect(await getWrappedKeyForUser('ch','u')).toEqual({wrappedKey:'abc',epoch:3});
  });

  it('enabled requires both a package and at least one wrapped key', async () => {
    get.mockResolvedValueOnce(null);
    expect(await isChannelE2EEEnabled('a')).toBe(false);
    get.mockResolvedValueOnce({channelId:'a',wrappedKeys:{},epoch:1,updatedAt:1});
    expect(await isChannelE2EEEnabled('a')).toBe(false);
    get.mockResolvedValueOnce({channelId:'a',wrappedKeys:{u:'x'},epoch:1,updatedAt:1});
    expect(await isChannelE2EEEnabled('a')).toBe(true);
  });

  it('addMemberKey is no-op when E2EE is off; otherwise updates in place and persists', async () => {
    get.mockResolvedValueOnce(null);
    await addMemberKey('ch','u','k');
    expect(set).not.toHaveBeenCalled();

    const pkg={channelId:'ch',wrappedKeys:{old:'v'},epoch:4,updatedAt:1};
    get.mockResolvedValueOnce(pkg);
    jest.spyOn(Date,'now').mockReturnValue(2222);
    await addMemberKey('ch','u','k');
    expect(pkg.wrappedKeys).toEqual({old:'v'});
    expect(set).toHaveBeenCalledWith('e2ee:channel:keys:ch', {
      ...pkg, wrappedKeys:{old:'v',u:'k'}, updatedAt:2222,
    }, TTL);
    expect(withKeyLock).toHaveBeenCalledWith('e2ee-channel:ch', expect.any(Function));
    jest.restoreAllMocks();
  });

  it('removeMemberKey is no-op without package; otherwise deletes and persists', async () => {
    get.mockResolvedValueOnce(null);
    await removeMemberKey('ch','u');
    expect(set).not.toHaveBeenCalled();

    const pkg={channelId:'ch',wrappedKeys:{u:'k',other:'v'},epoch:5,updatedAt:1};
    get.mockResolvedValueOnce(pkg);
    jest.spyOn(Date,'now').mockReturnValue(3333);
    await removeMemberKey('ch','u');
    expect(pkg.wrappedKeys).toEqual({u:'k',other:'v'});
    expect(set).toHaveBeenCalledWith('e2ee:channel:keys:ch', {
      ...pkg, wrappedKeys:{other:'v'}, updatedAt:3333,
    }, TTL);
    expect(withKeyLock).toHaveBeenCalledWith('e2ee-channel:ch', expect.any(Function));
    jest.restoreAllMocks();
  });
});
