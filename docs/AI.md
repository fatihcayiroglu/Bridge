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
| `none` | — | nowhere: AI is off **even if keys are set** — chat, voice transcription and embeddings alike |

Notes:

- **Internal hosts.** `OLLAMA_URL` and `AI_BASE_URL` are operator-configured, so
  they may point at internal hosts. The SSRF guard that blocks private
  addresses for user-supplied URLs does not apply to them.
- **No credentials in the URL.** `AI_BASE_URL` must be http(s) without
  credentials, and `AI_MODEL` is required. An invalid value disables the
  provider and is logged at error level.
- **Time limit.** `AI_TIMEOUT_MS` (default 30000) is the total time one AI call
  may take, retries included. Streams end after 45 s.
- **Voice-message transcription** follows `AI_PROVIDER` too (P6). It runs only
  when `AI_PROVIDER` is unset (Groq key, else OpenAI key) or `groq`. Any other
  selected provider, or `none`, means no audio is sent anywhere.
- **Embeddings** (`PGVECTOR_ENABLED`, `EMBEDDING_PROVIDER`) are a separate
  operator opt-in, but `AI_PROVIDER=none` turns them off as well (P6).

## Per-server opt-out (P6)

The installation decides whether AI exists. A **server owner** decides whether
their server's content may reach it: Server Settings → General → "Allow AI
features on this server" (`PATCH /api/servers/:id { "aiEnabled": false }`,
owner only, a real boolean).

With AI off for a server, nothing from it is sent to an AI provider: no channel
context, no message text, no voice audio, no search query embedding, no tags or
name for server recommendations.

- **Routes with a local fallback still answer.** Summary, reply suggestions,
  moderation, search and digest answer from rules, marked
  `aiDisabledForServer: true`.
- **Routes without one refuse.** Streams and translation answer 403
  `AI_DISABLED_FOR_SERVER`.

How the setting behaves:

- **Read on every request, from the database.** Turning it off or on takes effect
  on the next request. An AI answer cached before the opt-out is not served
  after it, and a local answer is not cached.
- **Permission first.** The requester's own permission check runs first, so a
  non-member learns nothing about another server's setting.
- **Default.** Existing and new servers allow AI (migration 078), which
  preserves behaviour. An unreadable setting counts as "off".
- **Translation needs the server id.** Text sent to `/api/ai/translate` is
  attributed to a server only when the client passes `serverId`; the server
  cannot attribute free text sent without it.

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

## Embeddings and vector search (P6)

pgvector semantic search is an operator opt-in (`PGVECTOR_ENABLED=true` plus
an embedding provider). How it behaves:

- **When messages are embedded.** A live sweep runs every
  `EMBED_SWEEP_INTERVAL_MS` (60 s by default). One node per interval, chosen by a
  cluster-wide claim, embeds up to `EMBED_SWEEP_BATCH` of the newest messages
  without a vector. A nightly job (03:00 UTC) handles older history. "Pending"
  is `embedding IS NULL` in the database, so a restart loses nothing.
- **What is never sent to the embedding provider:**
  - anything when `AI_PROVIDER=none`;
  - anything from a server whose owner turned AI off;
  - deleted messages, E2EE payloads and system messages.

  Each message is re-checked against the database immediately before the
  provider call.
- **Edits and deletes.** Database triggers handle them, so every write path is
  covered:
  - An edit or delete clears the message's vector in the same statement, and
    the sweep then embeds the new text.
  - A vector is stored only if the row still holds the text that was embedded.
    An edit that lands during the provider call wins, and the vector is
    discarded.
- **Opt-out.** When an owner turns AI off, that server's vectors are removed in
  the same transaction. Turning it back on re-indexes the server.
- **Search.** Vector search ranks only messages in channels the member can see,
  and never deleted or E2EE rows.
  - A cached search answer (3 min) is re-checked on every hit: deleted messages
    and newly hidden channels drop out, and edited messages show their current
    text.
  - If the provider is down, search falls back to AI or keyword answers, and
    the sweep stops a pass after `EMBED_SWEEP_MAX_FAILURES` failures.
- **Logs** record message ids and outcomes, never message text.

## Known limits

- **Embeddings.** Indexing is per server, not per channel: with AI allowed on
  a server, messages in its private channels are embedded too, and so reach the
  embedding provider. Only members who can see a channel ever get its messages
  back from search. An edit to a message older than the sweep window (48 h by
  default) is re-indexed by the nightly job; until then the message has no
  vector and is found by keyword only. The deterministic embedder used in the
  lab and the tests demonstrates the plumbing, not search quality.
- **Auto-moderation.** It is opt-in per server (`autoModerate`). When enabled,
  message content is sent to the configured provider by design.
