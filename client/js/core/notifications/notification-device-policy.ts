// Device-local attention policy. This policy is intentionally not synced to
// the server: DND/quiet-hours here describe how THIS browser/device should
// surface pushes. The Service Worker receives and persists the same policy.

export interface NotificationDevicePolicy {
  dnd: boolean;
  quietEnabled: boolean;
  quietStart: string; // HH:MM local device time
  quietEnd: string;   // HH:MM local device time
}

const STORAGE_KEY = 'bridge_notification_device_policy_v1';
export const DEFAULT_NOTIFICATION_DEVICE_POLICY: NotificationDevicePolicy = {
  dnd: false,
  quietEnabled: false,
  quietStart: '22:00',
  quietEnd: '08:00',
};

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeNotificationDevicePolicy(value: unknown): NotificationDevicePolicy {
  if (!value || typeof value !== 'object') return { ...DEFAULT_NOTIFICATION_DEVICE_POLICY };
  const raw = value as Partial<NotificationDevicePolicy>;
  return {
    dnd: raw.dnd === true,
    quietEnabled: raw.quietEnabled === true,
    quietStart: validTime(raw.quietStart) ? raw.quietStart : DEFAULT_NOTIFICATION_DEVICE_POLICY.quietStart,
    quietEnd: validTime(raw.quietEnd) ? raw.quietEnd : DEFAULT_NOTIFICATION_DEVICE_POLICY.quietEnd,
  };
}

export function loadNotificationDevicePolicy(): NotificationDevicePolicy {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_NOTIFICATION_DEVICE_POLICY };
  try { return normalizeNotificationDevicePolicy(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_NOTIFICATION_DEVICE_POLICY }; }
}

async function postPolicyToServiceWorker(policy: NotificationDevicePolicy): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const target = navigator.serviceWorker.controller ?? reg.active ?? reg.waiting;
    target?.postMessage({ type: 'SET_NOTIFICATION_POLICY', notificationPolicy: policy });
  } catch { /* service worker may be unavailable in this runtime */ }
}

export async function saveNotificationDevicePolicy(policy: NotificationDevicePolicy): Promise<void> {
  const normalized = normalizeNotificationDevicePolicy(policy);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* storage can be disabled */ }
  await postPolicyToServiceWorker(normalized);
}

export async function syncNotificationDevicePolicy(): Promise<NotificationDevicePolicy> {
  const policy = loadNotificationDevicePolicy();
  await postPolicyToServiceWorker(policy);
  return policy;
}

function minutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

export function isQuietHoursActive(
  policy: NotificationDevicePolicy,
  now: Date = new Date(),
): boolean {
  if (!policy.quietEnabled) return false;
  const start = minutes(policy.quietStart);
  const end = minutes(policy.quietEnd);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true; // explicit 24-hour quiet window
  return start < end ? current >= start && current < end : current >= start || current < end;
}
