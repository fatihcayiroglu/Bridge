// Compatibility wrapper for legacy dynamic imports.
export async function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<Response & { typed(): Promise<T> }> {
  const res = await fetch(url, opts) as Response & { typed(): Promise<T> };
  res.typed = async () => (await res.json()) as T;
  return res;
}
export default apiFetch;
