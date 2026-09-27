'use strict';
process.env.NODE_ENV='test';
process.env.REDIS_URL='redis://configured.test:6379';
const sliding=jest.fn();
const increment=jest.fn();
const del=jest.fn();
let available=true;
jest.mock('../lib/redisAdapter',()=>({
  cache:{slidingWindowCount:(...a:any[])=>sliding(...a),increment:(...a:any[])=>increment(...a),del:(...a:any[])=>del(...a)},
  isRedisAvailable:()=>available,
}));
jest.mock('../lib/logger',()=>({__esModule:true,default:{warn:jest.fn(),info:jest.fn(),error:jest.fn(),debug:jest.fn()}}));
jest.mock('../middleware/ipBan',()=>({getBan:jest.fn().mockResolvedValue(null),banIp:jest.fn().mockResolvedValue(undefined)}));

import {socketRateCheck,SOCKET_RL,_socketRateStore} from '../socket/socketRateLimit';
import {ipRateCheck,IP_SOCKET_RL} from '../socket/ipRateLimit';

describe('socket/IP rate limiting Redis atomic owner',()=>{
  beforeEach(()=>{jest.clearAllMocks();available=true;_socketRateStore.clear();sliding.mockResolvedValue(1);increment.mockResolvedValue(1);});
  it('uses one atomic sliding-window call for user event limits',async()=>{
    await expect(socketRateCheck('u1','message:send')).resolves.toBe(true);
    expect(sliding).toHaveBeenCalledWith('socketrl:u1:message:send',SOCKET_RL['message:send']!.windowMs,expect.any(Number));
  });
  it('blocks from the Redis-returned aggregate count',async()=>{
    sliding.mockResolvedValueOnce(SOCKET_RL['message:send']!.max+1);
    await expect(socketRateCheck('u1','message:send')).resolves.toBe(false);
  });
  it('fails closed and never consumes process-local quota when configured Redis window fails',async()=>{
    sliding.mockRejectedValue(new Error('redis down'));
    await expect(socketRateCheck('local','message:send')).resolves.toBe(false);
    await expect(socketRateCheck('local','message:send')).resolves.toBe(false);
    expect(_socketRateStore.size).toBe(0);
  });
  it('fails closed before touching a process-local quota when configured Redis is already unavailable',async()=>{
    available=false;
    await expect(socketRateCheck('local-unavailable','message:send')).resolves.toBe(false);
    expect(_socketRateStore.size).toBe(0);
  });
  it('IP limiter uses atomic window and atomic violation increment',async()=>{
    const event=Object.keys(IP_SOCKET_RL)[0]!; const cfg=IP_SOCKET_RL[event as keyof typeof IP_SOCKET_RL];
    sliding.mockResolvedValueOnce(cfg.max+1); increment.mockResolvedValueOnce(1);
    await expect(ipRateCheck('198.51.100.2',event)).resolves.toBe(false);
    expect(sliding).toHaveBeenCalledWith(`ipratelimit:ip:198.51.100.2:${event}`,cfg.windowMs,expect.any(Number));
    expect(increment).toHaveBeenCalledWith('ipviolation:198.51.100.2',3600);
  });
});
