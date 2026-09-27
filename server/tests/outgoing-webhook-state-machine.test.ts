'use strict';
process.env.NODE_ENV='test';
process.env.JWT_SECRET=process.env.JWT_SECRET||'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET=process.env.REFRESH_SECRET||'test-refresh-secret-long-enough-32!!';

const repo = {
  hasCollection: jest.fn(() => true),
  findEnabledByServer: jest.fn(), enqueueDeliveryBounded: jest.fn(),
  claimDueDeliveries: jest.fn(), findByIdAndServer: jest.fn(),
  completeDelivery: jest.fn(), retryDelivery: jest.fn(),
  recordDeliveryFailure: jest.fn(), recordDeliverySuccess: jest.fn(),
  findByServer: jest.fn(), insert: jest.fn(), update: jest.fn(), findById: jest.fn(), remove: jest.fn(),
};
const checkOutboundUrl=jest.fn();
const fetchT=jest.fn();
const logWarn=jest.fn(), logError=jest.fn();

jest.mock('../db/repositories',()=>({OutgoingWebhooks:repo}));
jest.mock('../lib/urlSafety',()=>({checkOutboundUrl:(...a:unknown[])=>checkOutboundUrl(...a)}));
jest.mock('../lib/fetch',()=>({fetchT:(...a:unknown[])=>fetchT(...a)}));
jest.mock('../lib/logger',()=>({__esModule:true,default:{warn:(...a:unknown[])=>logWarn(...a),error:(...a:unknown[])=>logError(...a)}}));
jest.mock('../middleware/auth',()=>({authMiddleware:(_q:unknown,_s:unknown,n:()=>void)=>n()}));
jest.mock('../middleware/rateLimit',()=>({limits:{webhooks:()=> (_q:unknown,_s:unknown,n:()=>void)=>n()}}));
jest.mock('../lib/permissions',()=>({resolvePermissions:jest.fn(async()=>0),hasPermission:jest.fn(()=>false),PERMS:{MANAGE_SERVER:1}}));

import {
  dispatchEvent, processOutgoingWebhookDeliveries,
  startOutgoingWebhookDeliveryJob, stopOutgoingWebhookDeliveryJob,
} from '../routes/outgoingWebhooks';

const wh=(overrides:Record<string,unknown>={})=>({
  _id:'wh1',serverId:'s1',name:'h',url:'https://example.com/h',events:['message:new'],
  secret:'secret',enabled:true,createdBy:'u',createdAt:1,consecutiveFailures:0,...overrides,
});
const row=(overrides:Record<string,unknown>={})=>({_id:'d1',webhookId:'wh1',serverId:'s1',eventName:'message:new',payload:{x:1},attempts:0,...overrides});

async function tick(){ await new Promise<void>(r=>setImmediate(r)); }

describe('outgoing webhook durable state-machine failure branches',()=>{
  beforeEach(()=>{
    jest.clearAllMocks(); stopOutgoingWebhookDeliveryJob();
    repo.hasCollection.mockReturnValue(true);
    repo.findEnabledByServer.mockResolvedValue([]);
    repo.enqueueDeliveryBounded.mockResolvedValue('d');
    repo.claimDueDeliveries.mockResolvedValue([]);
    repo.findByIdAndServer.mockResolvedValue(wh());
    repo.completeDelivery.mockResolvedValue(undefined);
    repo.retryDelivery.mockResolvedValue(undefined);
    repo.recordDeliveryFailure.mockResolvedValue({consecutiveFailures:1,enabled:true});
    repo.recordDeliverySuccess.mockResolvedValue(undefined);
    checkOutboundUrl.mockResolvedValue({ok:true});
    fetchT.mockResolvedValue({ok:true,status:204});
  });
  afterEach(()=>stopOutgoingWebhookDeliveryJob());

  it('skips overlapping worker execution instead of double-claiming',async()=>{
    let release!:(v:unknown[])=>void;
    repo.claimDueDeliveries.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
    const first=processOutgoingWebhookDeliveries();
    await tick();
    await processOutgoingWebhookDeliveries();
    expect(repo.claimDueDeliveries).toHaveBeenCalledTimes(1);
    release([]); await first;
  });

  it.each([null, wh({enabled:false})])('ACKs missing/disabled webhook without network delivery',async(value)=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    repo.findByIdAndServer.mockResolvedValueOnce(value as any);
    await processOutgoingWebhookDeliveries();
    expect(repo.completeDelivery).toHaveBeenCalledWith('d1',expect.stringMatching(/^webhook:/));
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('unsafe target is permanent: records failure and ACKs durable row',async()=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    checkOutboundUrl.mockResolvedValueOnce({ok:false,reason:'private network'});
    await processOutgoingWebhookDeliveries();
    expect(repo.recordDeliveryFailure).toHaveBeenCalledWith('wh1',0,'private network');
    expect(repo.completeDelivery).toHaveBeenCalled();
    expect(repo.retryDelivery).not.toHaveBeenCalled();
  });

  it.each([400,401,403,404,410,422])('ordinary HTTP %s is permanent and gets ACKed',async(status)=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    fetchT.mockResolvedValueOnce({ok:false,status});
    await processOutgoingWebhookDeliveries();
    expect(repo.completeDelivery).toHaveBeenCalled();
    expect(repo.retryDelivery).not.toHaveBeenCalled();
  });

  it.each([408,409,425,429,500,503])('retryable HTTP %s releases lease with incremented attempts',async(status)=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    fetchT.mockResolvedValueOnce({ok:false,status});
    await processOutgoingWebhookDeliveries();
    expect(repo.retryDelivery).toHaveBeenCalledWith('d1',expect.stringMatching(/^webhook:/),1,expect.any(Number),`HTTP ${status}`);
    expect(repo.completeDelivery).not.toHaveBeenCalled();
  });

  it('network exception is retryable and preserves error reason',async()=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    fetchT.mockRejectedValueOnce(new Error('ECONNRESET'));
    await processOutgoingWebhookDeliveries();
    expect(repo.recordDeliveryFailure).toHaveBeenCalledWith('wh1',0,'ECONNRESET');
    expect(repo.retryDelivery).toHaveBeenCalledWith('d1',expect.any(String),1,expect.any(Number),'ECONNRESET');
  });

  it('third retryable delivery failure is bounded and ACKed as exhausted',async()=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row({attempts:2})]);
    fetchT.mockResolvedValueOnce({ok:false,status:503});
    await processOutgoingWebhookDeliveries();
    expect(repo.completeDelivery).toHaveBeenCalled();
    expect(repo.retryDelivery).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.delivery.exhausted',attempts:3}),expect.any(String));
  });

  it('internal repository error retries and a retry-release error remains observable',async()=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    repo.findByIdAndServer.mockRejectedValueOnce(new Error('db read failed'));
    repo.retryDelivery.mockRejectedValueOnce(new Error('release failed'));
    await processOutgoingWebhookDeliveries();
    await tick();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.delivery.release_failed'}),expect.any(String));
  });

  it('terminal internal error attempts cleanup; cleanup failure is logged without escaping worker',async()=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row({attempts:2})]);
    repo.findByIdAndServer.mockRejectedValueOnce(new Error('db broken'));
    repo.completeDelivery.mockRejectedValueOnce(new Error('cleanup broken'));
    await expect(processOutgoingWebhookDeliveries()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.delivery.terminal_cleanup_failed'}),expect.any(String));
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.delivery.worker_exhausted',attempts:3}),expect.any(String));
  });

  it.each(['01','1e0',' 1 ','oops',-1])('malformed persisted attempts are quarantined instead of retried: %p',async(attempts)=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row({attempts})]);
    await processOutgoingWebhookDeliveries();
    expect(repo.completeDelivery).toHaveBeenCalledWith('d1',expect.stringMatching(/^webhook:/));
    expect(fetchT).not.toHaveBeenCalled();
    expect(repo.retryDelivery).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.delivery.invalid_attempt_state'}),expect.any(String));
  });

  it('successful signed delivery records status and ACKs',async()=>{
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    await processOutgoingWebhookDeliveries();
    expect(repo.recordDeliverySuccess).toHaveBeenCalledWith('wh1',204);
    const opts=fetchT.mock.calls[0][1] as any;
    expect(opts.headers['X-Bridge-Signature']).toMatch(/^sha256=/);
    expect(opts.headers['X-Bridge-Delivery']).toBe('d1');
    expect(repo.completeDelivery).toHaveBeenCalled();
  });

  it('failure threshold >=10 remains observable for HTTP and network failures',async()=>{
    repo.recordDeliveryFailure.mockResolvedValue({consecutiveFailures:10,enabled:false});
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]);
    fetchT.mockResolvedValueOnce({ok:false,status:503});
    await processOutgoingWebhookDeliveries();
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.disabled.max_failures'}),expect.any(String));

    jest.clearAllMocks();
    repo.claimDueDeliveries.mockResolvedValueOnce([row()]); repo.findByIdAndServer.mockResolvedValue(wh());
    repo.recordDeliveryFailure.mockResolvedValue({consecutiveFailures:10,enabled:false});
    checkOutboundUrl.mockResolvedValue({ok:true}); fetchT.mockRejectedValueOnce(new Error('down'));
    await processOutgoingWebhookDeliveries();
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.disabled.max_failures'}),expect.any(String));
  });

  it('dispatch returns immediately when durable collection is unavailable',async()=>{
    repo.hasCollection.mockReturnValueOnce(false);
    await dispatchEvent('s1','message:new',{x:1});
    expect(repo.findEnabledByServer).not.toHaveBeenCalled();
  });

  it('dispatch supports JSON-string, scalar-string and wildcard event configs; skips nonmatches',async()=>{
    repo.findEnabledByServer.mockResolvedValueOnce([
      wh({_id:'a',events:'["message:new"]'}),
      wh({_id:'b',events:'message:new'}),
      wh({_id:'c',events:['*']}),
      wh({_id:'d',events:['member:join']}),
      wh({_id:'e',events:'not-json'}),
    ] as any);
    await dispatchEvent('s1','message:new','payload');
    expect(repo.enqueueDeliveryBounded).toHaveBeenCalledTimes(3);
    expect(repo.enqueueDeliveryBounded).toHaveBeenCalledWith('a','s1','message:new',{value:'payload'},1000);
  });

  it('queue-full is logged; lookup/enqueue failure is rethrown so caller can observe durability loss',async()=>{
    repo.findEnabledByServer.mockResolvedValueOnce([wh()] as any);
    repo.enqueueDeliveryBounded.mockResolvedValueOnce(null);
    await dispatchEvent('s1','message:new',{x:1});
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.delivery.queue_full'}),expect.any(String));

    repo.findEnabledByServer.mockRejectedValueOnce(new Error('lookup down'));
    await expect(dispatchEvent('s1','message:new',{})).rejects.toThrow('lookup down');
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({event:'webhook.dispatch.lookup_failed'}),expect.any(String));
  });

  it('keeps startup, periodic, and immediate worker failures observable without unhandled rejections',async()=>{
    let intervalCallback!:()=>void;
    const intervalHandle={unref:jest.fn()};
    const setIntervalSpy=jest.spyOn(global,'setInterval').mockImplementation(((callback:()=>void)=>{
      intervalCallback=callback;
      return intervalHandle as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clearIntervalSpy=jest.spyOn(global,'clearInterval').mockImplementation((()=>undefined) as typeof clearInterval);
    try {
      repo.claimDueDeliveries.mockRejectedValueOnce(new Error('startup claim down'));
      startOutgoingWebhookDeliveryJob();
      await tick();
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({event:'webhook.delivery.startup_worker_failed'}),expect.any(String),
      );
      expect(intervalHandle.unref).toHaveBeenCalled();

      repo.claimDueDeliveries.mockRejectedValueOnce(new Error('periodic claim down'));
      intervalCallback();
      await tick();
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({event:'webhook.delivery.worker_failed'}),expect.any(String),
      );

      repo.findEnabledByServer.mockResolvedValueOnce([wh()] as any);
      repo.claimDueDeliveries.mockRejectedValueOnce(new Error('immediate claim down'));
      await dispatchEvent('s1','message:new',{x:1});
      await tick();
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({event:'webhook.delivery.immediate_worker_failed'}),expect.any(String),
      );
    } finally {
      stopOutgoingWebhookDeliveryJob();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('start is idempotent and stop is idempotent',async()=>{
    startOutgoingWebhookDeliveryJob();
    startOutgoingWebhookDeliveryJob();
    await tick();
    expect(repo.claimDueDeliveries).toHaveBeenCalledTimes(1);
    stopOutgoingWebhookDeliveryJob();
    stopOutgoingWebhookDeliveryJob();
  });
});
