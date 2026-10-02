// Servidor de Pedidos Distribuidora: sirve la app y la API (/api/p/*). Postgres si hay DATABASE_URL, si no archivo local.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pedidos = require('./api/pedidos.js');

const E = process.env;
const SECRET = E.AUTH_SECRET || 'pedidos-' + (E.APP_PASS || 'kevin123');
const DB_URL0 = E.DATABASE_URL || E.DATABASE_PRIVATE_URL || E.DATABASE_PUBLIC_URL ||
  (E.PGHOST && E.PGUSER && E.PGPASSWORD ? `postgres://${encodeURIComponent(E.PGUSER)}:${encodeURIComponent(E.PGPASSWORD)}@${E.PGHOST}:${E.PGPORT || 5432}/${E.PGDATABASE || 'railway'}` : null);
const DB_URL = DB_URL0 && !DB_URL0.includes('${{') ? DB_URL0 : null;   // referencia de Railway sin resolver
if (DB_URL0 && !DB_URL) console.error('DATABASE_URL no se resolvió: usar "Add Reference" a la base de Railway');
console.log(DB_URL ? 'Base de datos: configurada' : 'Base de datos: NO configurada (se guarda en data/pedidos.json)');
const pool = DB_URL ? new Pool({
  connectionString: DB_URL,
  ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
}) : null;

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8' };
const FILES = ['index.html', 'manifest.json', 'icon.svg', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'apple-touch-icon.png'];

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
function body(req, limit = 15e6) {
  return new Promise(ok => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(raw || '{}')); } catch { ok({}); } });
  });
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/p/')) return await pedidos(req, res, url, body, send, pool, SECRET);
    const name = url === '/' ? 'index.html' : url.slice(1);
    if (!FILES.includes(name)) { res.statusCode = 404; return res.end('No encontrado'); }
    res.setHeader('content-type', TYPES[path.extname(name)]);
    if (name === 'sw.js' || name === 'index.html') res.setHeader('cache-control', 'no-cache');
    fs.createReadStream(path.join(__dirname, name)).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Error interno' });
  }
}).listen(E.PORT || 3000);
