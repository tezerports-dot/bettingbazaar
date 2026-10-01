// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What the installed app asks the server. The server chooses a release FOR
 * the phone's Android (R9), so the question must carry the API level — and an
 * install whose plugin cannot report one must still ask, exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sdkLevel } = vi.hoisted(() => ({ sdkLevel: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ sdkLevel }) }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: async () => ({ build: '12' }) } }));

import { checkForUpdate, shouldShow } from './nativeUpdater';

const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ success: true, status: 'current', minRequiredVersionCode: 0, latest: null }) }));

beforeEach(() => {
  fetchMock.mockClear();
  sdkLevel.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('checkForUpdate', () => {
  it('sends the phone\'s Android API level with its version code', async () => {
    sdkLevel.mockResolvedValue({ sdkInt: 33 });
    await checkForUpdate();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/app\/android\/update\?versionCode=12&sdk=33$/);
  });

  it('still asks, without an API level, on an install whose plugin cannot report one', async () => {
    sdkLevel.mockRejectedValue(new Error('not implemented'));
    await checkForUpdate();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/app\/android\/update\?versionCode=12$/);
  });

  it('carries the server\'s words for an unsupported phone, and always shows it', async () => {
    sdkLevel.mockResolvedValue({ sdkInt: 28 });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, status: 'unsupported', minRequiredVersionCode: 0, latest: null, requiredAndroid: 'Android 11 (API 30)' }) } as never);
    const check = await checkForUpdate();
    expect(check).toMatchObject({ status: 'unsupported', requiredAndroid: 'Android 11 (API 30)' });
    expect(shouldShow(check)).toBe(true);
  });
});
