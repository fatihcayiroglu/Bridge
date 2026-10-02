// server/lib/aiInstallation.ts
//
// P6 AI-09/AI-10 — the installation's AI master switch as ONE dependency-free
// rule. lib/aiProvider.ts (chat), routes/voicemsg.ts (transcription, via
// aiProvider) and lib/pgvector.ts (embeddings) all decide "is AI off here?"
// with this function, so `AI_PROVIDER=none` means the same thing everywhere.
// No imports: modules that must stay light (pgvector) can use it freely.

export const KNOWN_AI_PROVIDERS: ReadonlySet<string> =
  new Set(['groq', 'gemini', 'openrouter', 'ollama', 'openai-compatible', 'none', 'off', 'rules']);

/** `none`, `off`, `rules` or an unknown AI_PROVIDER value turn AI off. Read at call time. */
export function aiOffByInstallation(e: NodeJS.ProcessEnv = process.env): boolean {
  const sel = (e.AI_PROVIDER || '').trim().toLowerCase();
  return ['none', 'off', 'rules'].includes(sel) || (!!sel && !KNOWN_AI_PROVIDERS.has(sel));
}
