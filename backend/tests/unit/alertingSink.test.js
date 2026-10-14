// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Operational alerts have ONE sink, the webhook (owner, 2026-10-13: staff have
 * no Telegram, so the bot has nobody on the staff side to message). Replaces
 * staffAlertsPg, which proved the Telegram half that no longer exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchWithRetry, getSystemConfig } = vi.hoisted(() => ({ fetchWithRetry: vi.fn(), getSystemConfig: vi.fn() }));
vi.mock('../../utils/retry.js', () => ({ fetchWithRetry }));
vi.mock('#db/repositories/config.js', () => ({ getSystemConfig }));
vi.mock('../../domains/telegram/telegramClient.js', () => {
  throw new Error('alerting must not reach for the Telegram bot');
});

const { sendAlert } = await import('../../services/alerting.service.js');

beforeEach(() => {
  fetchWithRetry.mockReset().mockResolvedValue({ ok: true });
  getSystemConfig.mockReset();
  delete process.env.ALERT_WEBHOOK_URL;
});

describe('sendAlert', () => {
  it('posts to the configured webhook, once per key per cooldown', async () => {
    getSystemConfig.mockResolvedValue({ alertWebhookUrl: 'https://hooks.example.test/a' });
    await sendAlert('sink-a', 'Ledger reconciliation failed', { id: 1 });
    await sendAlert('sink-a', 'Ledger reconciliation failed', { id: 2 });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithRetry.mock.calls[0];
    expect(url).toBe('https://hooks.example.test/a');
    expect(JSON.parse(init.body)).toMatchObject({ key: 'sink-a', title: 'Ledger reconciliation failed', details: { id: 1 } });
  });

  it('is a silent no-op with no webhook, and does not silence the key (the opposite case)', async () => {
    getSystemConfig.mockResolvedValue({});
    await sendAlert('sink-b', 'Settlement error');
    expect(fetchWithRetry).not.toHaveBeenCalled();
    getSystemConfig.mockResolvedValue({ alertWebhookUrl: 'https://hooks.example.test/b' });
    await sendAlert('sink-b', 'Settlement error');
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it('never throws into the caller when the webhook fails', async () => {
    getSystemConfig.mockResolvedValue({ alertWebhookUrl: 'https://hooks.example.test/c' });
    fetchWithRetry.mockRejectedValue(new Error('down'));
    await expect(sendAlert('sink-c', 'x')).resolves.toBeUndefined();
  });
});
