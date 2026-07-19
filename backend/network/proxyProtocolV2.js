// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * network/proxyProtocolV2.js — trusted PROXY protocol v2 TCP preface handling.
 *
 * HAProxy `send-proxy-v2` prepends a binary header before the first HTTP/TLS
 * byte. Node's HTTP/HTTPS parsers cannot consume that header directly, so this
 * optional listener wrapper validates the edge router source IP, strips the
 * binary preface, stores the parsed client metadata on the socket, and then
 * hands the original socket to the normal HTTP/HTTPS server.
 *
 * It is OFF by default. Enable only when the backend listener is directly
 * behind an internal HAProxy/LB tier that sends PROXY v2:
 *   PROXY_PROTOCOL_V2=true
 *   PROXY_PROTOCOL_TRUSTED_SUBNETS=10.0.10.0/24,127.0.0.1/32
 */
import net from 'net';
import ipaddr from 'ipaddr.js';

const SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const HEADER_LENGTH = 16;
const MAX_PROXY_HEADER_BYTES = 512;

/** Normalize Node socket IP strings before parser validation. */
function normalizeIp(ip) {
  const value = String(ip || '').trim();
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

/** Convert a normalized IPv4 address to an unsigned 32-bit integer. */
function ipv4ToInt(ip) {
  const parts = normalizeIp(ip).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv6ToBytes(ip) {
  const normalized = normalizeIp(ip).toLowerCase();
  if (!normalized || !net.isIPv6(normalized)) return null;

  const expandIpv4Tail = (value) => {
    const groups = value ? value.split(':') : [];
    if (!groups.length || !groups.at(-1)?.includes('.')) return groups;
    const asInt = ipv4ToInt(groups.at(-1));
    if (asInt == null) return null;
    return [...groups.slice(0, -1), ((asInt >>> 16) & 0xffff).toString(16), (asInt & 0xffff).toString(16)];
  };

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const head = expandIpv4Tail(halves[0]);
  const tail = expandIpv4Tail(halves[1] || '');
  if (!head || !tail) return null;

  const missing = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (missing < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;

  const bytes = Buffer.alloc(16);
  for (let i = 0; i < groups.length; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    bytes.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return bytes;
}

function ipv6MatchesCidr(addressBytes, subnetBytes, prefix) {
  if (!Buffer.isBuffer(addressBytes) || !Buffer.isBuffer(subnetBytes)) return false;
  const fullBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  if (!addressBytes.subarray(0, fullBytes).equals(subnetBytes.subarray(0, fullBytes))) return false;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (addressBytes[fullBytes] & mask) === (subnetBytes[fullBytes] & mask);
}

function parseCidr(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return null;
  const parts = raw.split('/');
  if (parts.length > 2) return null;
  const [ip, prefixRaw = null] = parts;
  if (prefixRaw != null && !/^\d+$/.test(prefixRaw)) return null;
  const version = net.isIP(normalizeIp(ip));
  if (!version) return null;
  if (version === 4) {
    const prefix = prefixRaw == null ? 32 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { version, base: ipv4ToInt(ip), prefix, raw };
  }
  const prefix = prefixRaw == null ? 128 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  return { version, base: ipv6ToBytes(ip), prefix, raw };
}

/** Parse a comma-separated list of trusted IPv4 and IPv6 CIDR ranges. */
export function parseTrustedSubnets(value) {
  return String(value || '')
    .split(',')
    .map(parseCidr)
    .filter(Boolean);
}

/** Return true when the TCP peer address belongs to the configured trusted proxy set. */
export function isTrustedProxyAddress(remoteAddress, trustedSubnets) {
  const ip = normalizeIp(remoteAddress);
  const version = net.isIP(ip);
  if (!version) return false;
  if (!Array.isArray(trustedSubnets) || trustedSubnets.length === 0) return false;
  if (version === 4) {
    const asInt = ipv4ToInt(ip);
    return trustedSubnets.some((subnet) => {
      if (subnet.version !== 4 || asInt == null || subnet.base == null) return false;
      const mask = subnet.prefix === 0 ? 0 : (0xffffffff << (32 - subnet.prefix)) >>> 0;
      return (asInt & mask) === (subnet.base & mask);
    });
  }
  const bytes = ipv6ToBytes(ip);
  return trustedSubnets.some((subnet) => subnet.version === 6 && ipv6MatchesCidr(bytes, subnet.base, subnet.prefix));
}

/** Extract source and destination metadata from a validated PROXY v2 address block. */
function parseAddressBlock(buffer, family, protocol, length) {
  if (family === 0x10 && length >= 12) {
    return {
      protocol,
      sourceAddress: `${buffer[16]}.${buffer[17]}.${buffer[18]}.${buffer[19]}`,
      destinationAddress: `${buffer[20]}.${buffer[21]}.${buffer[22]}.${buffer[23]}`,
      sourcePort: buffer.readUInt16BE(24),
      destinationPort: buffer.readUInt16BE(26),
    };
  }
  if (family === 0x20 && length >= 36) {
    return {
      protocol,
      sourceAddress: buffer.subarray(16, 32).toString('hex').match(/.{1,4}/g)?.join(':') || '',
      destinationAddress: buffer.subarray(32, 48).toString('hex').match(/.{1,4}/g)?.join(':') || '',
      sourcePort: buffer.readUInt16BE(48),
      destinationPort: buffer.readUInt16BE(50),
    };
  }
  return { protocol, sourceAddress: '', destinationAddress: '', sourcePort: 0, destinationPort: 0 };
}

/** Parse a complete or partial PROXY protocol v2 preface from a socket buffer. */
export function parseProxyProtocolV2(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_LENGTH) return { complete: false };
  if (!buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return { complete: true, proxy: null, headerLength: 0 };
  const versionCommand = buffer[12];
  if ((versionCommand & 0xf0) !== 0x20) throw new Error('invalid PROXY protocol v2 version');
  const command = versionCommand & 0x0f;
  const familyProtocol = buffer[13];
  const family = familyProtocol & 0xf0;
  const protocol = familyProtocol & 0x0f;
  const length = buffer.readUInt16BE(14);
  const totalLength = HEADER_LENGTH + length;
  if (totalLength > MAX_PROXY_HEADER_BYTES) throw new Error('PROXY protocol v2 header too large');
  if (buffer.length < totalLength) return { complete: false };
  const proxy = command === 0x01 ? parseAddressBlock(buffer, family, protocol, length) : null;
  return { complete: true, proxy, headerLength: totalLength };
}

/** Attach parsed PROXY metadata and expose the verified client IP to Express middleware. */
export function attachProxyProtocolRequestMetadata(req, _res, next) {
  if (req.socket?.proxyProtocol) {
    req.proxyProtocol = req.socket.proxyProtocol;
    if (net.isIP(req.socket.proxyProtocol.sourceAddress)) {
      Object.defineProperty(req, 'ip', { configurable: true, value: req.socket.proxyProtocol.sourceAddress });
      Object.defineProperty(req, 'ips', { configurable: true, value: [req.socket.proxyProtocol.sourceAddress] });
    }
  }
  next();
}

/** Start an HTTP server directly, or through a PROXY v2-stripping TCP wrapper. */
export function listenWithOptionalProxyProtocol(httpServer, { port, host = '0.0.0.0', enabled, trustedSubnets }) {
  if (!enabled) {
    return httpServer.listen(port, host);
  }
  const parsedTrustedSubnets = Array.isArray(trustedSubnets)
    ? trustedSubnets.map((entry) => (typeof entry === 'string' ? parseCidr(entry) : entry)).filter(Boolean)
    : parseTrustedSubnets(trustedSubnets);
  if (parsedTrustedSubnets.length === 0) {
    throw new Error('PROXY_PROTOCOL_V2 enabled but PROXY_PROTOCOL_TRUSTED_SUBNETS is empty');
  }

  const tcpServer = net.createServer((socket) => {
    socket.on('error', (error) => {
      if (error?.code && error.code !== 'ECONNRESET') {
        console.warn('[proxy-protocol-v2] socket error:', error.code);
      }
    });

    if (!isTrustedProxyAddress(socket.remoteAddress, parsedTrustedSubnets)) {
      socket.destroy();
      return;
    }

    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let parsed;
      try {
        parsed = parseProxyProtocolV2(buffered);
      } catch (error) {
        socket.destroy();
        return;
      }
      if (!parsed.complete) return;
      socket.removeListener('data', onData);
      if (!parsed.proxy) {
        socket.destroy();
        return;
      }
      socket.proxyProtocol = parsed.proxy;
      const remaining = buffered.subarray(parsed.headerLength);
      if (remaining.length) socket.unshift(remaining);
      httpServer.emit('connection', socket);
    };
    socket.on('data', onData);
  });

  return tcpServer.listen(port, host);
}
