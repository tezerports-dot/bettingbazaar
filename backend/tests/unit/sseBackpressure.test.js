// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import SSEManager from '../../domains/notification/sseManager.service.js';

class FakeResponse extends EventEmitter {
  constructor({ writableLength = 0, writeResult = true } = {}) {
    super();
    this.writableLength = writableLength;
    this.writeResult = writeResult;
    this.ended = false;
    this.writeCalls = 0;
  }

  write(payload) {
    this.writeCalls++;
    this.lastPayload = payload;
    return this.writeResult;
  }

  end() {
    this.ended = true;
    this.emit('close');
  }
}

describe('SSEManager backpressure', () => {
  const previousMax = process.env.SSE_MAX_BUFFERED_BYTES;

  afterEach(() => {
    if (previousMax === undefined) delete process.env.SSE_MAX_BUFFERED_BYTES;
    else process.env.SSE_MAX_BUFFERED_BYTES = previousMax;
  });


  it('falls back to the default buffer cap for invalid configuration', () => {
    process.env.SSE_MAX_BUFFERED_BYTES = 'Infinity';
    const manager = new SSEManager();

    expect(manager.getStats().maxBufferedBytes).toBe(1024 * 1024);
    manager.destroy();
  });

  it('drops a public client whose response buffer is already over the cap', () => {
    process.env.SSE_MAX_BUFFERED_BYTES = '1024';
    const manager = new SSEManager();
    const res = new FakeResponse({ writableLength: 2048 });
    const id = manager.addClient(res);

    manager.sendToClient(id, 'snapshot', { ok: true });

    expect(manager.clients.has(id)).toBe(false);
    expect(res.ended).toBe(true);
    expect(manager.getStats().droppedBackpressure).toBe(1);
    manager.destroy();
  });


  it('drops an oversized payload before write is attempted', () => {
    process.env.SSE_MAX_BUFFERED_BYTES = '1024';
    const manager = new SSEManager();
    const res = new FakeResponse({ writableLength: 0 });
    const id = manager.addClient(res);

    manager.sendToClient(id, 'snapshot', { text: 'x'.repeat(2048) });

    expect(res.writeCalls).toBe(0);
    expect(manager.clients.has(id)).toBe(false);
    expect(res.ended).toBe(true);
    expect(manager.getStats().droppedBackpressure).toBe(1);
    manager.destroy();
  });

  it('keeps healthy clients and records successful writes', () => {
    process.env.SSE_MAX_BUFFERED_BYTES = '1024';
    const manager = new SSEManager();
    const res = new FakeResponse({ writableLength: 0 });
    const id = manager.addClient(res);

    manager.sendToClient(id, 'snapshot', { ok: true });

    expect(manager.clients.has(id)).toBe(true);
    expect(res.lastPayload).toContain('event: snapshot');
    expect(manager.getStats().totalOut).toBe(1);
    manager.destroy();
  });
});
