import { disconnectUserSockets } from '../lib/sessionRevocation';

describe('live session socket revocation', () => {
  it('emits revocation and disconnects every socket in the canonical user room', async () => {
    const a = { emit: jest.fn(), disconnect: jest.fn() };
    const b = { emit: jest.fn(), disconnect: jest.fn() };
    const fetchSockets = jest.fn(async () => [a, b]);
    const io = { in: jest.fn(() => ({ fetchSockets })) };

    await expect(disconnectUserSockets(io, 'u1', 'password_changed')).resolves.toBe(2);
    expect(io.in).toHaveBeenCalledWith('user:u1');
    for (const socket of [a, b]) {
      expect(socket.emit).toHaveBeenCalledWith('auth:revoked', { reason: 'password_changed' });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    }
  });

  it('is a no-op before Socket.IO is initialized', async () => {
    await expect(disconnectUserSockets(null, 'u1', 'logout_all')).resolves.toBe(0);
  });


  it('fails closed when the socket adapter cannot enumerate live sessions', async () => {
    const io = { in: jest.fn(() => ({ fetchSockets: jest.fn(async () => { throw new Error('adapter unavailable'); }) })) };
    await expect(disconnectUserSockets(io, 'u1', 'password_changed')).rejects.toThrow('adapter unavailable');
  });
});
