// Lume Player - serviço local (roda dentro do TizenBrew, só na TV)
// Faz as consultas da lista (Xtream/M3U) por dentro da TV, sem a trava de CORS do navegador.
var http = require('http'), https = require('https'), url = require('url');
var PORT = 8097;

function hdr(res, code, extra) {
  var h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' };
  for (var k in extra) h[k] = extra[k];
  res.writeHead(code, h);
}

function fetchU(u, res, n, insecure) {
  var p;
  try { p = url.parse(u); } catch (e) { hdr(res, 400); return res.end('bad url'); }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') { hdr(res, 400); return res.end('bad protocol'); }
  var lib = p.protocol === 'https:' ? https : http;
  var opt = { hostname: p.hostname, port: p.port, path: p.path, method: 'GET', timeout: 25000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Tizen) Lume', 'Accept': '*/*' } };
  if (insecure) opt.rejectUnauthorized = false;
  var r = lib.request(opt, function (up) {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && n < 4) {
      up.resume();
      return fetchU(url.resolve(u, up.headers.location), res, n + 1, insecure);
    }
    var h = {};
    if (up.headers['content-type']) h['Content-Type'] = up.headers['content-type'];
    hdr(res, up.statusCode, h);
    up.pipe(res);
  });
  r.on('timeout', function () { r.abort(); });
  r.on('error', function (e) {
    if (!insecure && p.protocol === 'https:' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|EXPIRED/i.test(String(e.code || e.message))) {
      return fetchU(u, res, n, true);
    }
    if (!res.headersSent) { hdr(res, 502, { 'Content-Type': 'text/plain' }); res.end('proxy error: ' + (e.code || e.message)); }
    else { try { res.end(); } catch (x) {} }
  });
  r.end();
}

function start() {
  var s = http.createServer(function (req, res) {
    if (req.method === 'OPTIONS') { hdr(res, 204); return res.end(); }
    var q = url.parse(req.url, true);
    if (q.pathname === '/ping') { hdr(res, 200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (q.query && q.query.u) return fetchU(q.query.u, res, 0, false);
    hdr(res, 404); res.end();
  });
  s.on('error', function () {});
  s.listen(PORT, '127.0.0.1');
}

if (!global.__lumeProxy) { global.__lumeProxy = true; start(); }
module.exports = { onStart: function () {}, onStop: function () {} };
