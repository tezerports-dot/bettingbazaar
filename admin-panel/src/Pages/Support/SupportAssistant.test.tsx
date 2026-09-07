// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Support Assistant reaches all five endpoints, and reports the two halves apart.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The five RAG endpoints were built, tested, merged and unreachable — no screen
 * called any of them, so the only way to put anything in the knowledge base was
 * to call the API by hand. This suite guards that a screen asks.
 *
 * The readiness split is the other half. Retrieval and generation are
 * configured independently and fail differently: retrieval down means nothing
 * is found at all, generation down means passages ARE found and nothing is
 * written from them. A page that collapsed them into one "enabled" light would
 * still pass a test that only checked "some status rendered", so the assertion
 * here is that one half can be ready while the other is not and the screen says
 * which.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get, post, delete: del } }));
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { success: toastSuccess, error: toastError } }));

import { SupportAssistant } from './SupportAssistant';

// Field names copied from ragStatus() / embeddingInfo() / listDocuments().
const READY = {
  success: true,
  enabled: true,
  retrievalReady: true,
  generationReady: true,
  generationProvider: 'anthropic',
  generationModel: 'claude-sonnet-test',
  embedding: { provider: 'voyage', model: 'voyage-3', dim: 1024, configured: true },
  store: { configured: true, documents: 3, chunks: 47 },
};
const DOCS = {
  success: true,
  documents: [
    { doc_id: 'kb:withdrawals', title: 'Withdrawal policy', category: 'withdrawals', chunks: 12, updated_at: '2026-01-02T00:00:00.000Z' },
    { doc_id: 'kb:kyc', title: null, category: 'kyc', chunks: 5, updated_at: '2026-01-01T00:00:00.000Z' },
  ],
};

function routed(status: any = READY, docs: any = DOCS) {
  get.mockImplementation((url: string) => {
    if (url === '/api/admin/support/status') return Promise.resolve({ data: status });
    if (url === '/api/admin/support/documents') return Promise.resolve({ data: docs });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); del.mockReset();
  toastSuccess.mockReset(); toastError.mockReset();
  routed();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('SupportAssistant', () => {
  it('asks the two read endpoints and lists what is ingested', async () => {
    render(<SupportAssistant />);
    await screen.findByText('Withdrawal policy');

    const urls = get.mock.calls.map((c: any[]) => c[0]);
    expect(urls).toContain('/api/admin/support/status');
    expect(urls).toContain('/api/admin/support/documents');

    // A doc with no title falls back to its id rather than rendering blank.
    // Exact match, so this is the title line falling back to the id — not the
    // metadata line below it, which also contains the id.
    expect(screen.getByText('kb:kyc')).toBeInTheDocument();
    expect(screen.getByText(/Ingested documents \(2\)/)).toBeInTheDocument();
  });

  it('reports retrieval and generation separately, not as one light', async () => {
    // Retrieval configured, generation NOT: passages are found and nothing is
    // written. A collapsed single light cannot express this.
    routed({ ...READY, enabled: false, generationReady: false, generationProvider: '', generationModel: '' });
    render(<SupportAssistant />);

    const retrieval = (await screen.findByText('Retrieval')).closest('div')!.parentElement!;
    expect(within(retrieval).getByText(/voyage-3/)).toBeInTheDocument();

    const generation = screen.getByText('Generation').closest('div')!.parentElement!;
    expect(within(generation).getByText(/passages are found but nothing is written/)).toBeInTheDocument();

    expect(screen.getByText(/Dormant/)).toBeInTheDocument();
  });

  it('shows the embedding dimension the server actually sends', async () => {
    render(<SupportAssistant />);
    // `dim`, not `dimensions` — reading a name the server never sends renders
    // blank rather than failing, which is how the UTR stat cards went unnoticed.
    expect(await screen.findByText(/voyage · voyage-3 · 1024d/)).toBeInTheDocument();
  });

  it('re-ingests the built-in knowledge base and reloads', async () => {
    post.mockResolvedValue({ data: { success: true, documents: 4, chunks: 60 } });
    render(<SupportAssistant />);
    await screen.findByText('Withdrawal policy');
    get.mockClear();

    await userEvent.click(screen.getByRole('button', { name: /Re-ingest/ }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/support/ingest/knowledge-base', {}));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('4'));
    // Reload, so the store counts on screen are the ones after the write.
    await waitFor(() => expect(get.mock.calls.map((c: any[]) => c[0])).toContain('/api/admin/support/documents'));
  });

  it('ingests a typed document with the exact field names the route requires', async () => {
    post.mockResolvedValue({ data: { success: true, docId: 'fees', chunks: 2 } });
    render(<SupportAssistant />);
    await screen.findByText('Withdrawal policy');

    await userEvent.type(screen.getByPlaceholderText(/Document id/), 'fees');
    await userEvent.type(screen.getByPlaceholderText(/Title/), 'Fee schedule');
    await userEvent.type(screen.getByPlaceholderText(/answered from/), 'Withdrawals carry no fee.');
    await userEvent.click(screen.getByRole('button', { name: /Ingest document/ }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/support/ingest', {
      docId: 'fees', title: 'Fee schedule', category: 'general', text: 'Withdrawals carry no fee.',
    }));
  });

  it('never posts a document without an id or without text', async () => {
    render(<SupportAssistant />);
    await screen.findByText('Withdrawal policy');

    // The route rejects both with a 400; the screen should not spend the call.
    const button = screen.getByRole('button', { name: /Ingest document/ });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/Document id/), 'fees');
    expect(button).toBeDisabled(); // id alone is not enough — text is required

    await userEvent.type(screen.getByPlaceholderText(/answered from/), 'text');
    expect(button).toBeEnabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('deletes a document by its id, url-encoded', async () => {
    del.mockResolvedValue({ data: { success: true, removedChunks: 12 } });
    render(<SupportAssistant />);
    await screen.findByText('Withdrawal policy');

    const row = screen.getByText('Withdrawal policy').closest('div')!.parentElement!;
    await userEvent.click(within(row).getByTitle('Remove'));

    // The id contains a colon; an unencoded path would not resolve to the route.
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/admin/support/documents/kb%3Awithdrawals'));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('12'));
  });

  it('asks before removing, and does not call the route when refused', async () => {
    (window.confirm as any).mockReturnValue(false);
    render(<SupportAssistant />);
    await screen.findByText('Withdrawal policy');

    const row = screen.getByText('Withdrawal policy').closest('div')!.parentElement!;
    await userEvent.click(within(row).getByTitle('Remove'));

    expect(del).not.toHaveBeenCalled();
  });

  it('survives the status endpoint being unavailable without losing the document list', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/admin/support/status') return Promise.reject(new Error('503'));
      return Promise.resolve({ data: DOCS });
    });
    render(<SupportAssistant />);

    // The half that answered still renders — one failure does not blank the page.
    expect(await screen.findByText('Withdrawal policy')).toBeInTheDocument();
    expect(screen.getByText('Status unavailable.')).toBeInTheDocument();
  });

  it('says the store is empty rather than looking merely quiet', async () => {
    routed(READY, { success: true, documents: [] });
    render(<SupportAssistant />);
    expect(await screen.findByText(/The assistant has nothing to answer from/)).toBeInTheDocument();
  });
});
