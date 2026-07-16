// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/support/ragService.js — RAG support assistant orchestrator (CAP-71).
 *
 * Use case (owner-confirmed): an AI support assistant that answers over the
 * platform's own docs/policies/FAQs — deposit rules, KYC, game logic — grounded
 * in retrieved content, NOT free-form generation.
 *
 * Flow:  ingest → chunk → embed (Voyage) → store (pgvector)
 *        ask    → embed query → cosine top-K retrieve → generate (provider adapter)
 *
 * Two independent activation gates, reported separately by ragStatus() so an
 * operator can see exactly what is missing:
 *   RETRIEVAL  = Postgres/pgvector configured  AND  embedding provider configured
 *   GENERATION = ANTHROPIC_API_KEY set
 * The feature is a documented no-op until both are satisfied (support routes
 * return 503) — the platform's standard dormant-until-provisioned pattern.
 *
 * SAFETY: this is a money/betting platform. The system prompt hard-constrains
 * the model to answer ONLY from retrieved context, to refuse to invent policies,
 * amounts, limits, or payout promises, and to hand off to a human when unsure.
 * If retrieval returns nothing, we short-circuit WITHOUT calling the model.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { chunkDocument } from './chunk.js';
import { embedDocuments, embedQuery, embeddingsConfigured, embeddingInfo } from './embeddings.js';
import { replaceDocument, retrieve, listDocuments, deleteDocument, stats } from './ragStore.js';
import { pgConfigured } from '../../postgres/pgClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const MAX_CONTEXT_CHARS = 8000;

// ── Activation gates ──────────────────────────────────────────────────────────
export function retrievalReady()  { return pgConfigured() && embeddingsConfigured(); }

function generationProvider() {
  return (process.env.RAG_GENERATION_PROVIDER || 'anthropic').trim().toLowerCase();
}

function openAICompatibleKey() {
  return process.env.RAG_CHAT_API_KEY || process.env.OPENAI_API_KEY || '';
}

export function generationReady()  {
  switch (generationProvider()) {
    case 'openai':
    case 'openai-compatible':
    case 'custom':
      return !!openAICompatibleKey().trim();
    case 'anthropic':
    default:
      return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
  }
}
export function ragEnabled()       { return retrievalReady() && generationReady(); }

function generationModel() {
  if (generationProvider() === 'anthropic') return process.env.RAG_MODEL || 'claude-opus-4-8';
  return process.env.RAG_MODEL || process.env.RAG_CHAT_MODEL || 'gpt-4.1-mini';
}

async function createAnthropicMessage({ model, maxTokens, system, userContent }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  return (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function createOpenAICompatibleMessage({ model, maxTokens, system, userContent }) {
  const baseUrl = (process.env.RAG_CHAT_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${openAICompatibleKey()}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()); } catch { detail = await response.text().catch(() => ''); }
    throw new Error(`OpenAI-compatible chat API failed (${response.status}): ${detail || response.statusText}`);
  }

  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function generateGroundedAnswer({ system, userContent }) {
  const model = generationModel();
  const maxTokens = Number(process.env.RAG_MAX_TOKENS || 1024);
  switch (generationProvider()) {
    case 'openai':
    case 'openai-compatible':
    case 'custom':
      return { answerText: await createOpenAICompatibleMessage({ model, maxTokens, system, userContent }), model };
    case 'anthropic':
    default:
      return { answerText: await createAnthropicMessage({ model, maxTokens, system, userContent }), model };
  }
}

export async function ragStatus() {
  const store = await stats().catch(() => ({ configured: pgConfigured(), documents: 0, chunks: 0 }));
  return {
    enabled: ragEnabled(),
    retrievalReady: retrievalReady(),
    generationReady: generationReady(),
    generationProvider: generationProvider(),
    embedding: embeddingInfo(),
    generationModel: generationModel(),
    store,
  };
}

// ── Ingestion ─────────────────────────────────────────────────────────────────
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * Ingest a single document: chunk → embed → replace in the vector store.
 * @param {{docId, title?, source?, category?, text}} doc
 * @returns {Promise<{docId, chunks}>}
 */
export async function ingestDocument(doc) {
  if (!retrievalReady()) {
    throw Object.assign(new Error('RAG retrieval not configured (need DATABASE_URL + embedding provider key).'), { status: 503 });
  }
  const records = chunkDocument(doc);
  if (!records.length) return { docId: doc.docId, chunks: 0 };
  const vectors = await embedDocuments(records.map((r) => r.content));
  const withVectors = records.map((r, i) => ({ ...r, contentHash: sha256(r.content), embedding: vectors[i] }));
  const written = await replaceDocument(doc.docId, withVectors);
  return { docId: doc.docId, chunks: written };
}

/** Parse a knowledge markdown file into a document (title = first H1, category = filename stem). */
function parseKnowledgeFile(file) {
  const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
  const stem = file.replace(/\.md$/i, '');
  const h1 = raw.match(/^#\s+(.+)$/m);
  return {
    docId: `kb:${stem}`,
    title: (h1 ? h1[1] : stem).trim(),
    source: `knowledge/${file}`,
    category: stem,
    text: raw,
  };
}

/**
 * Ingest the bundled knowledge base (backend/domains/support/knowledge/*.md).
 * Idempotent — re-running replaces each doc's chunks. This is the curated,
 * user-facing help content grounded in how the platform actually behaves.
 */
export async function ingestKnowledgeBase() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return { documents: 0, chunks: 0 };
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => /\.md$/i.test(f)).sort();
  let documents = 0, chunks = 0;
  for (const f of files) {
    const res = await ingestDocument(parseKnowledgeFile(f));
    documents += 1;
    chunks += res.chunks;
  }
  return { documents, chunks };
}

export async function listIngestedDocuments() { return listDocuments(); }
export async function removeDocument(docId)   { return deleteDocument(docId); }

// ── Retrieval + generation ────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  'You are the BettingBazaar support assistant. You help users understand the',
  'platform\'s own policies and mechanics: deposits, withdrawals, KYC, game logic,',
  'and account safety.',
  '',
  'STRICT RULES — a money platform depends on these:',
  '1. Answer ONLY using the numbered CONTEXT passages provided in the user message.',
  '2. If the answer is not clearly supported by the context, say you don\'t have that',
  '   information and tell the user to contact human support. Do NOT guess.',
  '3. NEVER invent policies, amounts, fees, limits, timelines, or eligibility rules.',
  '   NEVER promise or guarantee winnings, payouts, refunds, or outcomes.',
  '4. Do not give legal, tax, or financial advice. Do not encourage gambling.',
  '5. Be concise and specific. Cite the passages you used as [1], [2], … inline.',
  '6. If the user asks something off-topic (not about using this platform), politely',
  '   decline and redirect to support topics.',
].join('\n');

function buildContextBlock(rows) {
  let used = [];
  let total = 0;
  rows.forEach((r, i) => {
    const header = `[${i + 1}] (${r.title || r.source || r.doc_id})`;
    const piece = `${header}\n${r.content}`;
    if (total + piece.length > MAX_CONTEXT_CHARS && used.length) return;
    used.push({ ...r, marker: i + 1 });
    total += piece.length;
  });
  const text = used.map((r) => `[${r.marker}] (${r.title || r.source || r.doc_id})\n${r.content}`).join('\n\n');
  return { text, used };
}

/**
 * Answer a support question with retrieval-augmented generation.
 * @param {{query:string, category?:string|null, topK?:number}} params
 * @returns {Promise<{answer, citations, model, grounded, contextChunks}>}
 */
export async function answer({ query, category = null, topK = 5 }) {
  const q = String(query || '').trim();
  if (!q) throw Object.assign(new Error('query is required'), { status: 400 });
  if (!retrievalReady())  throw Object.assign(new Error('RAG retrieval not configured.'),  { status: 503 });
  if (!generationReady()) throw Object.assign(new Error('RAG generation not configured for selected provider.'), { status: 503 });

  const queryVec = await embedQuery(q);
  const rows = await retrieve(queryVec, { topK, category, minScore: 0.2 });

  // No grounded context → refuse WITHOUT calling the model (no hallucination, no spend).
  if (!rows.length) {
    return {
      answer: "I couldn't find this in our help center. Please contact human support and they'll assist you.",
      citations: [],
      model: generationModel(),
      grounded: false,
      contextChunks: 0,
    };
  }

  const { text: contextText, used } = buildContextBlock(rows);
  const userContent =
    `CONTEXT:\n${contextText}\n\n` +
    `QUESTION: ${q}\n\n` +
    'Answer using only the context above. Cite passages as [n]. If the context does ' +
    "not answer the question, say so and suggest contacting support.";

  const { answerText, model } = await generateGroundedAnswer({
    system: SYSTEM_PROMPT,
    userContent,
  });

  // Citations = the passages actually placed in context, deduped by document.
  const seen = new Set();
  const citations = [];
  for (const r of used) {
    const key = r.doc_id;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ marker: r.marker, title: r.title || r.doc_id, source: r.source, category: r.category, score: Math.round(r.score * 1000) / 1000 });
  }

  return { answer: answerText, citations, model, grounded: true, contextChunks: used.length };
}
