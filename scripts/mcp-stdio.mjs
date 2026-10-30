/*
 * scripts/mcp-stdio.mjs — stdio ⇄ HTTP bridge for the Cumulus MCP server.
 *
 * Speaks line-delimited JSON-RPC on stdin/stdout (the stdio mapping most
 * desktop agents use: one JSON-RPC message per line), and forwards every
 * message to the Cumulus MCP HTTP endpoint.
 *
 * Usage:
 *   node scripts/mcp-stdio.mjs [baseUrl]
 *   baseUrl default: http://localhost:3000/mcp  (override or set CUMULUS_MCP_URL)
 *
 * Example client config:
 *   {
 *     "mcpServers": {
 *       "cumulus": { "command": "node", "args": ["scripts/mcp-stdio.mjs"],
 *                    "env": { "CUMULUS_MCP_URL": "https://your-deployment/mcp",
 *                             "CUMULUS_API_KEY": "…" } }
 *     }
 *   }
 */
import readline from 'node:readline';

const base = (process.argv[2] || process.env.CUMULUS_MCP_URL || 'http://localhost:3000/mcp').replace(/\/$/, '/');
void base; // normalised below

const MCP_URL = (process.argv[2] || process.env.CUMULUS_MCP_URL || 'http://localhost:3000/mcp').replace(/\/+$/, '');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function writeOut(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* client gone */ }
}

/** Endpoints like /mcp and /mcp/ behave the same for POST. */
function postUrl() {
  return MCP_URL + '/';
}

rl.on('line', (line) => {
  const s = String(line || '').trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (err) {
    writeOut({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error (input must be line-delimited JSON-RPC 2.0)' } });
    return;
  }
  // Batch of messages
  if (Array.isArray(msg)) {
    Promise.all(msg.map((m) => postOne(m))).then((out) => out.forEach(writeOut));
    return;
  }
  postOne(msg).then(writeOut).catch((err) => {
    writeOut({ jsonrpc: '2.0', id: (msg && ('id' in msg ? msg.id : null)) ?? null, error: { code: -32603, message: String(err && err.message || err) } });
  });
});

async function postOne(msg) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (process.env.CUMULUS_API_KEY) headers.authorization = `Bearer ${process.env.CUMULUS_API_KEY}`;
  let res;
  try {
    res = await fetch(postUrl(), { method: 'POST', headers, body: JSON.stringify(msg) });
  } catch (err) {
    return { jsonrpc: '2.0', id: ('id' in msg ? msg.id : null) ?? null, error: { code: -32603, message: `Cannot reach ${MCP_URL} (${err && err.message})` } };
  }
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.jsonrpc) return parsed;
    // Some servers answer notifications with an empty body / plain status; normalise.
    return { jsonrpc: '2.0', id: ('id' in msg ? msg.id : null) ?? null, result: parsed };
  } catch {
    return { jsonrpc: '2.0', id: ('id' in msg ? msg.id : null) ?? null, error: { code: -32603, message: `MCP answered HTTP ${res.status} with non-JSON body` } };
  }
}

// keepalive so long-lived sessions don't pull the bridge down
process.stdin.resume();
