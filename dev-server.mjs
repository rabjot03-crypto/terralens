// TerraLens local development server (no dependencies, Node 18+).
// Serves index.html and runs api/analyze.js exactly as Vercel would.
// Usage:  node dev-server.mjs     then open http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local / .env into process.env (server-side only)
for (const f of ['.env.local', '.env']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { default: analyze } = await import(pathToFileURL(path.join(root, 'api', 'analyze.js')).href);
const PORT = Number(process.env.PORT) || 3000;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/analyze') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 6_000_000) req.destroy(); });
    req.on('end', async () => {
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }
      await analyze(req, res);
    });
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const full = path.join(root, path.normalize(file));
  const blocked = /(^|\/)\.env|dev-server|\/api\//.test(file);
  if (!full.startsWith(root) || blocked || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => {
  const k = process.env.XAI_API_KEY || process.env.GROQ_API_KEY;
  console.log(`\n  TerraLens running at http://localhost:${PORT}`);
  console.log(k ? `  API key loaded (${k.slice(0, 4)}…, hidden from the browser)\n` : '  ⚠  No XAI_API_KEY found — add it to .env.local\n');
});
