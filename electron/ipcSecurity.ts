import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { isSameAppOrigin } from './navigationPolicy';

type IpcEventLike = Partial<IpcMainEvent & IpcMainInvokeEvent> & {
  senderFrame?: { url?: string | null } | null;
  sender?: { getURL?: () => string } | null;
};

export function ipcSenderUrl(event: IpcEventLike | undefined | null): string {
  const frameUrl = event?.senderFrame?.url;
  if (typeof frameUrl === 'string' && frameUrl) return frameUrl;
  try {
    const senderUrl = event?.sender?.getURL?.();
    return typeof senderUrl === 'string' ? senderUrl : '';
  } catch {
    return '';
  }
}

export function isTrustedIpcSender(event: IpcEventLike | undefined | null): boolean {
  const url = ipcSenderUrl(event);
  return Boolean(url) && isSameAppOrigin(url);
}

export function assertTrustedIpcSender(event: IpcEventLike | undefined | null): void {
  if (!isTrustedIpcSender(event)) throw new Error('Untrusted IPC sender');
}
