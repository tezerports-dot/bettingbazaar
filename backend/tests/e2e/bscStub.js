// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A stand-in BNB Smart Chain node for the end-to-end run: the two JSON-RPC
 * calls the USDT watcher makes (`eth_blockNumber`, `eth_getLogs`), answered
 * from transfers a scenario "sends" with `sendUsdt`. Everything after the node
 * (the watcher, the credit, the books) is the real server.
 *
 * The head starts just past the cursor the shared database already holds, so
 * the server's watcher reaches the new blocks on its first tick instead of
 * catching up from wherever an earlier run left the chain.
 */
import http from 'node:http';
import { BSC_USDT_CONTRACT, TRANSFER_TOPIC, addressTopic } from '../../domains/payment/usdtBsc.js';

const logs = [];
let head = 0;

/** Send `usdt` USDT to `to`, mined in a new block that is already deep enough to count. */
export function sendUsdt(to, usdt, { from = `0x${'e'.repeat(40)}` } = {}) {
  head += 1;
  const block = head;
  const txHash = `0x${Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`;
  logs.push({
    address: BSC_USDT_CONTRACT, removed: false,
    topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: `0x${(BigInt(Math.round(usdt * 1e6)) * 10n ** 12n).toString(16)}`,
    blockNumber: `0x${block.toString(16)}`, logIndex: '0x0', transactionHash: txHash,
  });
  // Bury it under more blocks than any confirmation setting the admin can choose (200).
  head += 250;
  return { txHash, block };
}

function answer(method, params) {
  if (method === 'eth_blockNumber') return `0x${head.toString(16)}`;
  if (method === 'eth_getLogs') {
    const [{ fromBlock, toBlock, topics }] = params;
    const lo = Number(fromBlock); const hi = Number(toBlock);
    const wanted = new Set((topics?.[2] ?? []).map((t) => String(t).toLowerCase()));
    return logs.filter((l) => {
      const n = Number(l.blockNumber);
      return n >= lo && n <= hi && wanted.has(l.topics[2]);
    });
  }
  throw new Error(`method ${method} is not served by the stub`);
}

/** Start the stub; resolves to its URL. `startBlock` is where the head begins. */
export function startBscStub({ startBlock }) {
  head = Math.max(1000, Number(startBlock) || 0);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let id = null;
      try {
        const msg = JSON.parse(body); id = msg.id;
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: answer(msg.method, msg.params) }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: e.message } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}
