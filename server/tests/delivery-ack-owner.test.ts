const mockGet = jest.fn();
const mockSet = jest.fn();

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: (...args: unknown[]) => mockGet(...args),
    set: (...args: unknown[]) => mockSet(...args),
  },
}));

import { getAckRecord, sendAck, sendTmpAck, setAckRecord, type AckRecord } from '../lib/deliveryAck';

describe('delivery ACK accelerator and wire contract', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('scopes cached ACK ids by user and returns null/object without widening authority', async () => {
    mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce({ messageId: 'm1', channelId: 'c1', userId: 'u1', ts: 7 });
    await expect(getAckRecord('same-ack', 'u1')).resolves.toBeNull();
    await expect(getAckRecord('same-ack', 'u2')).resolves.toEqual(expect.objectContaining({ messageId: 'm1' }));
    expect(mockGet.mock.calls).toEqual([
      ['msg:ack:u1:same-ack'],
      ['msg:ack:u2:same-ack'],
    ]);
  });

  it('stores the canonical record under the record owner with the bounded five-minute TTL', async () => {
    const record: AckRecord = { messageId: 'm1', channelId: 'c1', userId: 'u1', ts: 123, tmpId: 'tmp-1' };
    mockSet.mockResolvedValue(undefined);
    await setAckRecord('ack-1', record);
    expect(mockSet).toHaveBeenCalledWith('msg:ack:u1:ack-1', record, 300);
  });

  it('emits durable ACKs with optional tmpId only when it is actually present', () => {
    const socket = { emit: jest.fn() };
    const base: AckRecord = { messageId: 'm1', channelId: 'c1', userId: 'u1', ts: 123 };
    sendAck(socket, 'ack-1', base);
    expect(socket.emit).toHaveBeenLastCalledWith('message:ack', {
      ackId: 'ack-1', messageId: 'm1', channelId: 'c1', ts: 123,
    });

    sendAck(socket, 'ack-2', { ...base, tmpId: 'tmp-2' });
    expect(socket.emit).toHaveBeenLastCalledWith('message:ack', {
      ackId: 'ack-2', messageId: 'm1', channelId: 'c1', ts: 123, tmpId: 'tmp-2',
    });
  });

  it('emits tmp-only ACKs without Redis writes and stamps the server time', () => {
    jest.spyOn(Date, 'now').mockReturnValue(456);
    const socket = { emit: jest.fn() };
    sendTmpAck(socket, 'tmp-only', 'm9', 'c9');
    expect(socket.emit).toHaveBeenCalledWith('message:ack', {
      tmpId: 'tmp-only', messageId: 'm9', channelId: 'c9', ts: 456,
    });
    expect(mockSet).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
