# Support domain — RAG assistant (CAP-71)

An AI support assistant that answers user questions over the platform's own
**docs / policies / FAQs** (deposit rules, KYC, game logic, withdrawals, account
safety) using **Retrieval-Augmented Generation** — grounded answers with
citations, not free-form generation.

## Pipeline

```
ingest:  document → chunk.js → embeddings.js (Voyage) → ragStore.js (pgvector)
ask:     query → embed → ragStore.retrieve (cosine top-K) → ragService (Claude) → answer + citations
```

| File | Role |
|---|---|
| `chunk.js` | Deterministic, paragraph-aware text chunker (pure) |
| `embeddings.js` | Pluggable embedding provider adapter (Voyage default, via `fetch`) |
| `ragStore.js` | pgvector schema + upsert + cosine top-K retrieval (on the hybrid-DB Postgres) |
| `ragService.js` | Orchestrator: ingest + grounded answer generation (Claude via `@anthropic-ai/sdk`) |
| `support.routes.js` | `GET /api/support/status`, `POST /api/support/ask` (auth + per-user rate limit) |
| `support.admin.routes.js` | `/api/admin/support/*` — ingest KB / ingest doc / list / delete |
| `knowledge/*.md` | Curated, user-facing help content grounded in real platform behavior |

## Activation (dormant by default)

Two independent gates, reported by `GET /api/support/status`:

- **Retrieval** — needs `DATABASE_URL` (Postgres with the **pgvector** extension)
  **and** an embedding key (`VOYAGE_API_KEY`).
- **Generation** — needs `ANTHROPIC_API_KEY`.

With any gate unmet the routes return `503` and the feature is a documented
no-op — the platform's standard env-gated dormancy (like the money DB, S3, USDT).

### Production requirements

1. **pgvector** must be available on the Postgres server (use the
   `pgvector/pgvector` image, or a managed Postgres offering `CREATE EXTENSION
   vector`). `initSchema()` creates the extension, table, and HNSW cosine index
   idempotently at boot — but only when retrieval is configured, so a money-only
   Postgres is never touched.
2. Set the keys above. `RAG_EMBEDDING_DIM` (default 1024) **must** match the
   embedding model and is used as the `vector(N)` column dimension.
3. Ingest content: `POST /api/admin/support/ingest/knowledge-base` (loads
   `knowledge/*.md`) and/or `POST /api/admin/support/ingest` for admin-authored docs.

## Safety

`ragService.js` hard-constrains the model to answer **only** from retrieved
context, to **refuse to invent** policies/amounts/limits/payout promises, and to
hand off to human support when unsure. If retrieval returns nothing, it
short-circuits **without** calling the model (no hallucination, no spend). This is
deliberate for a money/betting platform.

## Env reference

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | enables generation |
| `RAG_MODEL` | `claude-opus-4-8` | generation model |
| `RAG_MAX_TOKENS` | `1024` | answer length cap |
| `VOYAGE_API_KEY` | — | enables embeddings |
| `RAG_EMBEDDING_PROVIDER` | `voyage` | embedding adapter |
| `RAG_EMBEDDING_MODEL` | `voyage-3.5` | embedding model |
| `RAG_EMBEDDING_DIM` | `1024` | vector dimension (must match model + column) |
| `RAG_ASK_RATE` | `10` | `/ask` requests per user per minute |
