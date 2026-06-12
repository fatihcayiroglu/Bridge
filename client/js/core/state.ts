export interface CurrentUser { id?: string; _id?: string; username?: string; displayName?: string; avatar?: string; [key: string]: unknown }
export function getCurrentUser(): CurrentUser | null {
  const w = globalThis as unknown as { currentUser?: CurrentUser | null };
  return w.currentUser ?? null;
}
