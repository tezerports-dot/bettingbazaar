// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/support/ragStore.js — pgvector persistence for the RAG support
 * assistant (CAP-71).
 *
 * The vector store lives in the SAME Postgres the hybrid money DB provisions
 * (backend/postgres/pgClient.js), in its own `support_documents` table using the
 * `vector` extension. Activation is env-gated on DATABASE_URL exactly like the
 * money layer: with Postgres unconfigured every function here is a no-op/empty.
 *
 * PRODUCTION REQUIREMENT: the pgvector extension must be available on the server
 * (use the pgvector/pgvector image, or a managed Postgres that offers
 * `CREATE EXTENSION vector`). initSchema() creates the extension, table, and
 * index idempotently — see backend/domains/support/README.md.
 */
import { pgConfigured, pgQuery, getPool } from '../../postgres/pgClient.js';
import { embeddingDim } from './embeddings.js';

let _schemaReady = false;

/** Serialize a JS number[] to a pgvector literal: '[1,2,3]'. Pure — unit-tested. */
export function toVectorLiteral(vec) {
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('vector must be a non-empty array');
  return '[' + vec.map((n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) throw new Error('vector contains a non-finite value');
    return x;
  }).join(',') + ']';
}

/**
 * Create the extension + table + index idempotently. `dim` is a validated
 * integer (1..4096) from embeddingDim(), so interpolating it into the DDL is
 * safe (pgvector requires a literal dimension in the column type). No user input
 * ever reaches DDL.
 */
export async function initSchema() {
  if (!pgConfigured()) return false;
  const dim = embeddingDim();
  await pgQuery('CREATE EXTENSION IF NOT EXISTS vector');
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS support_documents (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      doc_id         TEXT NOT NULL,
      chunk_index    INT  NOT NULL,
      title          TEXT NOT NULL DEFAULT '',
      source         TEXT NOT NULL DEFAULT '',
      category       TEXT NOT NULL DEFAULT 'general',
      content        TEXT NOT NULL,
      content_hash   TEXT NOT NULL DEFAULT '',
      token_estimate INT  NOT NULL DEFAULT 0,
      embedding      vector(${dim}) NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (doc_id, chunk_index)
    )`);
  // HNSW cosine index — works at any row count (unlike ivfflat, which needs data
  // present before building) and gives sub-linear ANN search at 1M-DAU volumes.
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS support_documents_embedding_hnsw
      ON support_documents USING hnsw (embedding vector_cosine_ops)`);
  await pgQuery(`
    CREATE INDEX IF NOT EXISTS support_documents_category
      ON support_documents (category)`);
  _schemaReady = true;
  console.log(`✅ RAG vector store ready (support_documents, vector(${dim}), HNSW cosine)`);
  return true;
}

async function ensureSchema() {
  if (!_schemaReady) await initSchema();
}

/**
 * Replace ALL chunks for a document atomically (re-ingest = delete + insert in
 * one transaction, so a doc is never half-updated).
 * @param {string} docId
 * @param {{chunkIndex,title,source,category,content,contentHash,tokenEstimate,embedding:number[]}[]} records
 * @returns {Promise<number>} rows written
 */
export async function replaceDocument(docId, records) {
  if (!pgConfigured()) throw Object.assign(new Error('Postgres not configured (DATABASE_URL unset)'), { status: 503 });
  await ensureSchema();
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM support_documents WHERE doc_id = $1', [docId]);
    for (const r of records) {
      await client.query(
        `INSERT INTO support_documents
           (doc_id, chunk_index, title, source, category, content, content_hash, token_estimate, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`,
        [docId, r.chunkIndex, r.title, r.source, r.category, r.content,
         r.contentHash || '', r.tokenEstimate || 0, toVectorLiteral(r.embedding)]);
    }
    await client.query('COMMIT');
    return records.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Cosine top-K retrieval. `<=>` is pgvector's cosine DISTANCE, so score =
 * 1 - distance is cosine SIMILARITY in [−1, 1] (≈1 = most similar).
 * @param {number[]} queryEmbedding
 * @param {{topK?:number, category?:string|null, minScore?:number}} [opts]
 */
export async function retrieve(queryEmbedding, { topK = 5, category = null, minScore = 0 } = {}) {
  if (!pgConfigured()) return [];
  await ensureSchema();
  const vec = toVectorLiteral(queryEmbedding);
  const limit = Math.min(Math.max(1, Number(topK) || 5), 20);
  const params = [vec, limit];
  let where = '';
  if (category) { where = 'WHERE category = $3'; params.push(String(category)); }
  const { rows } = await pgQuery(
    `SELECT doc_id, chunk_index, title, source, category, content,
            1 - (embedding <=> $1::vector) AS score
       FROM support_documents
       ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
    params);
  return rows
    .map((r) => ({ ...r, score: Number(r.score) }))
    .filter((r) => r.score >= minScore);
}

export async function deleteDocument(docId) {
  if (!pgConfigured()) return 0;
  await ensureSchema();
  const { rowCount } = await pgQuery('DELETE FROM support_documents WHERE doc_id = $1', [docId]);
  return rowCount;
}

export async function listDocuments() {
  if (!pgConfigured()) return [];
  await ensureSchema();
  const { rows } = await pgQuery(
    `SELECT doc_id,
            max(title)         AS title,
            max(category)      AS category,
            count(*)::int      AS chunks,
            max(updated_at)    AS updated_at
       FROM support_documents
      GROUP BY doc_id
      ORDER BY max(updated_at) DESC`);
  return rows;
}

export async function stats() {
  if (!pgConfigured()) return { configured: false, documents: 0, chunks: 0 };
  try {
    await ensureSchema();
    const { rows } = await pgQuery(
      'SELECT count(*)::int AS chunks, count(DISTINCT doc_id)::int AS documents FROM support_documents');
    return { configured: true, documents: rows[0].documents, chunks: rows[0].chunks };
  } catch (e) {
    return { configured: true, documents: 0, chunks: 0, note: `store not ready: ${e.message}` };
  }
}
