# AI in Bridge — providers, data boundary, operation

This page describes what Bridge's AI features send where, and how an operator
controls it. Evidence for every statement here is in
`docs/P5_FEDERATION_AI_SELFHOSTING.md` (Workstream B and the capstone lab).

## Nothing is required

AI is optional. With no provider configured, summaries, suggestions and the
server digest fall back to local, rule-based output; nothing leaves the
server. Bridge does not operate an AI service and does not need one.

## Providers

`AI_PROVIDER` picks exactly one provider. If it is unset, Bridge uses the first
one configured, in this order: Groq → Gemini → OpenRouter → Ollama → OpenAI-compatible.

| `AI_PROVIDER` | Settings | Where data goes |
|---|---|---|
| `ollama` | `OLLAMA_URL`, `OLLAMA_MODEL` | your Ollama server |
| `openai-compatible` | `AI_BASE_URL` (e.g. `http://llm:8000/v1`), `AI_MODEL`, optional `AI_API_KEY` | your server: vLLM, llama.cpp server, LM Studio, LocalAI, Ollama `/v1` |
| `groq` | `GROQ_API_KEY` | Groq (third party) |
| `gemini` | `GEMINI_API_KEY` | Google (third party) |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter (third party) |
| `none` | — | nowhere: AI is off **even if keys are set** |

Notes:

- **Internal hosts.** `OLLAMA_URL` and `AI_BASE_URL` are operator-configured, so
  they may point at internal hosts. The SSRF guard that blocks private
  addresses for user-supplied URLs does not apply to them.
- **No credentials in the URL.** `AI_BASE_URL` must be http(s) without
  credentials, and `AI_MODEL` is required. An invalid value disables the
  provider and is logged at error level.
- **Time limit.** `AI_TIMEOUT_MS` (default 30000) is the total time one AI call
  may take, retries included. Streams end after 45 s.

## What is sent to a provider

Channel content is read through one function, `server/lib/aiContext.ts`, and
only after these checks:

- **Permissions.** The requester must hold VIEW_CHANNELS and READ_HISTORY on
  that channel; server membership alone is not enough. Requests for channels,
  servers or DMs the requester cannot read are refused before any provider is
  contacted.
- **Excluded messages.** Deleted messages, system messages and end-to-end
  encrypted payloads are never read.
- **Summary cache.** A cached channel summary is keyed by the exact messages it
  summarised, so a summary made before a deletion is not served after it.
- **Data, not instructions.** Channel text is placed in a delimited block in a
  user turn, never in the system prompt, and the delimiters cannot be forged
  from inside a message. Client-supplied chat history may contain only `user`
  and `assistant` turns.
- **Size limits.** Each message and the total context are capped in size.

This narrows prompt injection; it does not eliminate it. A model can still be
talked into a bad answer, but only from data the requester was already allowed
to read, because nothing else is ever in the context.

## Failures and secrets

- **Provider down or slow.** Summaries degrade to the local summary
  (`degraded: true`) and are not cached. Reply suggestions degrade to canned
  ones. Translation answers 503. Streams end with a generic error event.
- **Error text.** Upstream error text, which can name internal hosts, is
  logged server-side and never sent to clients.
- **Keys.** Keys are read from the environment on the server only. The Gemini
  key is sent in the `x-goog-api-key` header, never in a URL. Logs record
  provider, status and latency, never prompts or keys. `/api/ai/status`
  reports whether AI is enabled; in production it reports the provider only
  as `ai`.

## Known limits

- **No per-server opt-out.** Control is per installation (`AI_PROVIDER`). A
  server owner cannot opt their server out of AI features while the
  installation has a provider.
- **Embeddings.** pgvector semantic search (`PGVECTOR_ENABLED`) has an
  embedding writer, `saveMessageEmbedding`, that nothing calls, so semantic
  search uses its keyword/AI fallback. Vector search excludes deleted messages
  if embeddings are ever written.
- **Auto-moderation.** It is opt-in per server (`autoModerate`). When enabled,
  message content is sent to the configured provider by design.
