// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { describe, expect, it } from 'vitest';
import { runtimeProfile, runtimeRole } from '../../startup/runtimeRole.js';

describe('runtimeRole', () => {
  it('defaults to the legacy all-in-one monolith role', () => {
    expect(runtimeRole({})).toBe('all');
    expect(runtimeProfile({})).toMatchObject({
      acceptsHttpApi: true,
      acceptsRealtime: true,
      runsSchedulers: true,
      runsWorkers: true,
    });
  });

  it('keeps API pods away from long-lived realtime and scheduler work', () => {
    expect(runtimeProfile({ BB_RUNTIME_ROLE: 'api' })).toMatchObject({
      acceptsHttpApi: true,
      acceptsRealtime: false,
      runsSchedulers: false,
      runsWorkers: false,
    });
  });

  it('dedicates realtime pods to SSE/WebSocket clients without cron producers', () => {
    expect(runtimeProfile({ BB_RUNTIME_ROLE: 'realtime' })).toMatchObject({
      acceptsHttpApi: true,
      acceptsRealtime: true,
      runsSchedulers: false,
      runsWorkers: false,
    });
  });

  it('keeps scheduler pods off realtime connection ownership', () => {
    expect(runtimeProfile({ BB_RUNTIME_ROLE: 'scheduler' })).toMatchObject({
      acceptsRealtime: false,
      runsSchedulers: true,
      runsWorkers: true,
    });
  });
});
