// counter-server.js (stops the counter being stuck at 0)
//
// Run:  START_COUNT=12345 PORT=8080 node counter-server.js        (Node 18+)
// Env:  PORT (8080), HOST (127.0.0.1), START_COUNT (0, only used on first run),
//       PUBLIC_DIR (./public — set to a non-existent dir to run API-only)
//
// API:  GET  /api/count   -> {"count": N}
//       POST /api/thank   -> {"count": N+1}
//       GET  /api/stream  -> Server-Sent Events, pushes {"count": N} on every change

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const DATA = path.join(__dirname, 'counter.json');

// ---- state (persisted to counter.json) ----
let count = Number(process.env.START_COUNT) || 0;
try { count = JSON.parse(fs.readFileSync(DATA, 'utf8')).count || 0; } catch {}

let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  fs.writeFileSync(DATA + '.tmp', JSON.stringify({ count }));
  fs.renameSync(DATA + '.tmp', DATA);
}
setInterval(save, 5000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

// ---- simple per-IP rate limit: max 30 thanks per 10 s ----
const recent = new Map();
function tooFast(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < 10000);
  list.push(now);
  recent.set(ip, list);
  return list.length > 30;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of recent) if (!list.length || now - list[list.length - 1] > 10000) recent.delete(ip);
}, 60000);

function clientIp(req) {
  return req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress;
}

// ---- live updates (SSE) ----
const clients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify({ count })}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---- http ----
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.m4a': 'audio/mp4',
};

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/count' && req.method === 'GET') return json(res, { count });

  if (url.pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ count })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/thank' && req.method === 'POST') {
    if (tooFast(clientIp(req))) { res.writeHead(429); return res.end(); }
    count++;
    dirty = true;
    broadcast();
    return json(res, { count });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  // static files from PUBLIC_DIR
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}).listen(PORT, HOST, () => console.log(`counter on http://${HOST}:${PORT} (count=${count})`));
