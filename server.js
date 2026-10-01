const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const dashboard = require('./api/dashboard');
const stations = require('./api/stations');
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml',
  '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8'
};

function makeApiResponse(res) {
  const apiRes = {
    setHeader(name, value) { res.setHeader(name, value); return apiRes; },
    status(code) { res.statusCode = code; return apiRes; },
    json(payload) {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return apiRes;
    },
    send(payload) {
      if (Buffer.isBuffer(payload) || typeof payload === 'string') res.end(payload);
      else apiRes.json(payload);
      return apiRes;
    }
  };
  return apiRes;
}

function safeStaticPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.endsWith('/')) decoded += 'index.html';
  const resolved = path.resolve(ROOT, '.' + decoded);
  if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) return null;
  if (resolved.includes(path.sep + 'api' + path.sep)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(u.searchParams.entries());

  if (u.pathname === '/api/dashboard') {
    try { return await dashboard({ ...req, query }, makeApiResponse(res)); }
    catch (err) { console.error(err); res.statusCode = 500; return res.end(JSON.stringify({error:'Error interno'})); }
  }
  if (u.pathname === '/api/stations') {
    try { return await stations({ ...req, query }, makeApiResponse(res)); }
    catch (err) { console.error(err); res.statusCode = 500; return res.end(JSON.stringify({error:'Error interno'})); }
  }

  const filePath = safeStaticPath(u.pathname);
  if (!filePath) { res.statusCode = 403; return res.end('Forbidden'); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    if (path.basename(filePath) === 'sw.js' || ext === '.html' || ext === '.webmanifest') {
      res.setHeader('Cache-Control','no-cache');
    } else {
      res.setHeader('Cache-Control','public, max-age=3600');
    }
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Evolta escuchando en el puerto ${PORT}`);
});
