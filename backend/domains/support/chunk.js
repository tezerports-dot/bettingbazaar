// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/support/chunk.js — deterministic text chunker for the RAG support
 * assistant (CAP-71). Pure functions, no I/O — unit-tested in
 * backend/tests/unit/ragChunk.test.js.
 *
 * Splits source documents into overlapping windows sized for an embedding
 * model's context. Paragraph-aware: it never splits mid-paragraph unless a
 * single paragraph exceeds the window, in which case it hard-wraps on
 * sentence/whitespace boundaries. Overlap preserves cross-boundary context so a
 * fact that spans two chunks is still retrievable from either one.
 */

const DEFAULT_MAX_CHARS = 1200; // ≈300 tokens — comfortable for voyage-3.x
const DEFAULT_OVERLAP   = 200;  // ≈50 tokens of trailing context carried forward

/** Rough token estimate (≈4 chars/token). Good enough for budgeting, not billing. */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/** Collapse noisy whitespace WITHOUT destroying paragraph structure. */
function normalize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Double-newline-separated blocks. */
function paragraphs(text) {
  return normalize(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Hard-wrap an oversized paragraph on sentence, then whitespace, boundaries. */
function hardWrap(block, maxChars) {
  const out = [];
  let rest = block;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('. ', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars; // no good boundary — hard cut
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/**
 * Chunk raw text into overlapping windows.
 * @param {string} text
 * @param {{maxChars?:number, overlap?:number}} [opts]
 * @returns {string[]} chunk texts in document order (each ≤ maxChars, save a
 *          single unavoidable hard cut)
 */
export function chunkText(text, { maxChars = DEFAULT_MAX_CHARS, overlap = DEFAULT_OVERLAP } = {}) {
  const max = Math.max(200, Number(maxChars) || DEFAULT_MAX_CHARS);
  const ov  = Math.min(Math.max(0, Number(overlap) || 0), Math.floor(max / 2));
  const blocks = paragraphs(text).flatMap((p) => (p.length > max ? hardWrap(p, max) : [p]));

  const chunks = [];
  let cur = '';
  for (const block of blocks) {
    if (!cur) { cur = block; continue; }
    if (cur.length + 2 + block.length <= max) {
      cur += '\n\n' + block;
      continue;
    }
    chunks.push(cur);
    // Seed the next chunk with an overlap tail of the one we just closed.
    const tail = ov > 0 ? cur.slice(-ov) : '';
    cur = tail ? `${tail}\n\n${block}` : block;
    if (cur.length > max) cur = block; // overlap+block too big — drop the overlap
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/**
 * Chunk a document into records ready for embedding + storage.
 * @param {{docId:string, title?:string, source?:string, category?:string, text:string}} doc
 * @param {object} [opts] forwarded to chunkText
 * @returns {{docId, chunkIndex, title, source, category, content, tokenEstimate}[]}
 */
export function chunkDocument(doc, opts = {}) {
  const { docId, title = '', source = '', category = 'general', text = '' } = doc || {};
  if (!docId) throw new Error('chunkDocument: docId required');
  return chunkText(text, opts).map((content, i) => ({
    docId,
    chunkIndex: i,
    title,
    source,
    category,
    content,
    tokenEstimate: estimateTokens(content),
  }));
}
