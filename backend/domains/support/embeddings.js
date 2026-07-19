// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/support/embeddings.js — pluggable embedding provider for the RAG
 * support assistant (CAP-71).
 *
 * Anthropic does not ship a first-party embeddings API; the recommended pairing
 * for Claude RAG is Voyage AI. This module is an ADAPTER seam (same shape as
 * domains/funding/providerRegistry.js): Voyage is the implemented provider
 * today, and adding another (Cohere, OpenAI, a self-hosted model) is one object
 * here — no call-site changes in ragService/ragStore.
 *
 * Activation is env-gated. With no provider key set, configured() is false and
 * the whole RAG feature stays dormant (support routes answer 503) — the same
 * pg / S3 / USDT dormancy pattern used across the platform. Network calls go
 * through the platform's own backoff+jitter helper (utils/retry.js).
 *
 * Env:
 *   RAG_EMBEDDING_PROVIDER  default 'voyage'
 *   RAG_EMBEDDING_MODEL     default 'voyage-3.5'
 *   RAG_EMBEDDING_DIM       default 1024   (MUST equal the pgvector column dim)
 *   VOYAGE_API_KEY          the Voyage credential
 */
import { fetchWithRetry } from '../../utils/retry.js';

const DEFAULT_DIM = 1024;
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

/** Validated embedding dimension (bounded so it is safe to inline into DDL). */
export function embeddingDim() {
  const d = Number(process.env.RAG_EMBEDDING_DIM || DEFAULT_DIM);
  return Number.isInteger(d) && d > 0 && d <= 4096 ? d : DEFAULT_DIM;
}

// ── Voyage AI provider ────────────────────────────────────────────────────────
const voyage = {
  name: 'voyage',
  model: () => process.env.RAG_EMBEDDING_MODEL || 'voyage-3.5',
  configured: () => !!(process.env.VOYAGE_API_KEY && process.env.VOYAGE_API_KEY.trim()),
  async embed(texts, inputType) {
    if (!this.configured()) {
      throw Object.assign(new Error('Embedding provider not configured (VOYAGE_API_KEY unset).'), { status: 503 });
    }
    const res = await fetchWithRetry(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model(),
        input_type: inputType === 'query' ? 'query' : 'document',
        output_dimension: embeddingDim(),
      }),
    }, { retries: 3, baseMs: 500, capMs: 8000, timeoutMs: 30000 });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(
        new Error(`Voyage embeddings failed (${res.status}): ${String(body).slice(0, 200)}`),
        { status: res.status >= 500 ? 502 : res.status });
    }
    const json = await res.json();
    const vectors = (json.data || [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => d.embedding);
    if (vectors.length !== texts.length) {
      throw new Error(`Voyage returned ${vectors.length} vectors for ${texts.length} inputs`);
    }
    return vectors;
  },
};

const PROVIDERS = Object.freeze({ voyage });

export function getEmbeddingProvider() {
  const name = (process.env.RAG_EMBEDDING_PROVIDER || 'voyage').toLowerCase();
  return PROVIDERS[name] || voyage;
}

export function embeddingsConfigured() {
  return getEmbeddingProvider().configured();
}

export function embeddingInfo() {
  const p = getEmbeddingProvider();
  return { provider: p.name, model: p.model(), dim: embeddingDim(), configured: p.configured() };
}

/** Embed documents for ingestion (batched). @returns {Promise<number[][]>} */
export async function embedDocuments(texts) {
  if (!texts.length) return [];
  return getEmbeddingProvider().embed(texts, 'document');
}

/** Embed a single query string for retrieval. @returns {Promise<number[]>} */
export async function embedQuery(text) {
  const [v] = await getEmbeddingProvider().embed([text], 'query');
  return v;
}
