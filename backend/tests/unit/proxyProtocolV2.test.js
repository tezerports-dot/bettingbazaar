// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { describe, expect, it } from 'vitest';
import {
  isTrustedProxyAddress,
  parseProxyProtocolV2,
  parseTrustedSubnets,
} from '../../network/proxyProtocolV2.js';

const signature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

function ipv4ProxyHeader({ source = [203, 0, 113, 10], destination = [10, 0, 20, 10], sourcePort = 54321, destinationPort = 443 } = {}) {
  const header = Buffer.alloc(28);
  signature.copy(header, 0);
  header[12] = 0x21; // v2, PROXY command
  header[13] = 0x11; // TCP over IPv4
  header.writeUInt16BE(12, 14);
  Buffer.from(source).copy(header, 16);
  Buffer.from(destination).copy(header, 20);
  header.writeUInt16BE(sourcePort, 24);
  header.writeUInt16BE(destinationPort, 26);
  return header;
}

describe('PROXY protocol v2 parsing', () => {
  it('parses IPv4 client metadata and leaves following payload untouched', () => {
    const payload = Buffer.from('GET /health HTTP/1.1\r\n\r\n');
    const parsed = parseProxyProtocolV2(Buffer.concat([ipv4ProxyHeader(), payload]));

    expect(parsed.complete).toBe(true);
    expect(parsed.headerLength).toBe(28);
    expect(parsed.proxy).toMatchObject({
      sourceAddress: '203.0.113.10',
      destinationAddress: '10.0.20.10',
      sourcePort: 54321,
      destinationPort: 443,
    });
  });

  it('requires trusted HAProxy source subnets before accepting metadata', () => {
    const subnets = parseTrustedSubnets('10.0.10.0/24,127.0.0.1/32');

    expect(isTrustedProxyAddress('10.0.10.25', subnets)).toBe(true);
    expect(isTrustedProxyAddress('::ffff:127.0.0.1', subnets)).toBe(true);
    expect(isTrustedProxyAddress('10.0.11.25', subnets)).toBe(false);
    expect(isTrustedProxyAddress('203.0.113.20', subnets)).toBe(false);
  });
});
