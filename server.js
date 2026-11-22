const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

function setCorsHeaders(res, code, extra = {}) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type',
    ...extra,
  };
  res.writeHead(code, headers);
}

function isBlockedHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  return (
    h === '169.254.169.254' ||
    h === 'metadata.google.internal' ||
    h === 'metadata'
  );
}

function rewriteHlsManifest(text, baseUrl) {
  const toProxy = (raw, isPlaylist) => {
    const abs = new url.URL(raw, baseUrl).toString();
    return '/proxy?' + (isPlaylist || /\.m3u8(\?|$)/i.test(abs) ? 'hls=1&' : '') + 'u=' + encodeURIComponent(abs);
  };
  let expectVariant = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        if (/^#EXT-X-STREAM-INF:/i.test(t)) {
          expectVariant = true;
        }
        return line.replace(/URI="([^"]+)"/gi, (_, u) => {
          const isPl = /#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)/i.test(t);
          return `URI="${toProxy(u, isPl)}"`;
        });
      }
      const isPl = expectVariant || /\.m3u8(?:\?|$)/i.test(t);
      expectVariant = false;
      try {
        return toProxy(t, isPl);
      } catch (e) {
        return line;
      }
    })
    .join('\n');
}

function fetchUpstream(targetUrl, req, res, redirects = 0, insecure = false, altUa = false) {
  let parsed;
  try {
    parsed = new url.URL(targetUrl);
  } catch (e) {
    setCorsHeaders(res, 400);
    return res.end('bad url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    setCorsHeaders(res, 400);
    return res.end('bad protocol');
  }

  if (isBlockedHost(parsed.hostname)) {
    setCorsHeaders(res, 403);
    return res.end('blocked host');
  }

  const isImg = Boolean(res._isImg);
  const isHls = Boolean(res._isHls);
  const isDiag = Boolean(res._isDiag);
  const lib = parsed.protocol === 'https:' ? https : http;
  const uaStep = typeof altUa === 'number' ? altUa : altUa ? 2 : 0;
  const customUa = req && req.query && typeof req.query.ua === 'string' ? req.query.ua.trim() : '';
  const customRef = req && req.query && typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  const streamUas = [
    'VLC/3.0.20 LibVLC/3.0.20',
    'Dalvik/2.1.0 (Linux; U; Android 13; TV Build/TQ3A.230805.001) ExoPlayerLib/2.18.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];
  const reqHeaders = {
    'User-Agent': isImg ? streamUas[2] : customUa && uaStep === 0 ? customUa : streamUas[uaStep] || streamUas[0],
    Accept: isImg ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' : '*/*',
  };
  if (!isImg) {
    reqHeaders['Accept-Encoding'] = 'identity';
  }
  if (isImg) {
    reqHeaders.Referer = parsed.origin + '/';
  } else if (customRef) {
    reqHeaders.Referer = customRef;
  }
  if (req && req.headers && req.headers.range && !isImg && !isHls && !isDiag) {
    reqHeaders.Range = req.headers.range;
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: parsed.pathname + parsed.search,
    method: req && req.method === 'HEAD' ? 'HEAD' : 'GET',
    timeout: isImg ? 7000 : 25000,
    headers: reqHeaders,
  };

  if (insecure) {
    options.rejectUnauthorized = false;
  }

  let closed = false;
  const upstreamReq = lib.request(options, (upstreamRes) => {
    if (
      upstreamRes.statusCode >= 300 &&
      upstreamRes.statusCode < 400 &&
      upstreamRes.headers.location &&
      redirects < 8
    ) {
      upstreamRes.resume();
      res.removeListener('close', cleanup);
      const nextUrl = new url.URL(upstreamRes.headers.location, targetUrl).toString();
      return fetchUpstream(nextUrl, req, res, redirects + 1, insecure, uaStep);
    }

    if (!isImg && uaStep < streamUas.length - 1 && (upstreamRes.statusCode === 403 || upstreamRes.statusCode === 404)) {
      upstreamRes.resume();
      res.removeListener('close', cleanup);
      return fetchUpstream(targetUrl, req, res, redirects, insecure, uaStep + 1);
    }

    const ct = String(upstreamRes.headers['content-type'] || '');
    if (isDiag) {
      upstreamRes.destroy();
      res.removeListener('close', cleanup);
      setCorsHeaders(res, 200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          ok: upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 400,
          status: upstreamRes.statusCode,
          contentType: ct,
          url: targetUrl,
        })
      );
    }
    if (isImg && (upstreamRes.statusCode >= 400 || /text\/html/i.test(ct))) {
      upstreamRes.resume();
      setCorsHeaders(res, 502, { 'Content-Type': 'text/plain' });
      return res.end('invalid image response');
    }

    const looksLikeHls =
      isHls &&
      upstreamRes.statusCode < 400 &&
      (/mpegurl|m3u8/i.test(ct) ||
        (!/video\/|audio\/|application\/octet-stream/i.test(ct) &&
          (/text\/plain/i.test(ct) || /\.m3u8(?:\?|$)/i.test(targetUrl) || !ct)));

    if (looksLikeHls && options.method !== 'HEAD') {
      const chunks = [];
      let total = 0;
      let streamedRaw = false;

      const sendRawHeaders = () => {
        const headers = {};
        if (ct) headers['Content-Type'] = ct;
        if (upstreamRes.headers['content-length']) headers['Content-Length'] = upstreamRes.headers['content-length'];
        setCorsHeaders(res, upstreamRes.statusCode || 200, headers);
      };

      upstreamRes.on('data', (chunk) => {
        if (closed || res.writableEnded) return;
        if (streamedRaw) {
          res.write(chunk);
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
        if (total === chunk.length) {
          let firstByte = chunk[0];
          if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
            firstByte = chunk[3];
          }
          const headText = chunk.slice(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
          if (chunk[0] === 0x47 || (headText.length > 0 && headText[0] !== '#')) {
            streamedRaw = true;
            sendRawHeaders();
            res.write(chunk);
            chunks.length = 0;
            return;
          }
        }
        if (total > 2 * 1024 * 1024) {
          streamedRaw = true;
          sendRawHeaders();
          for (const c of chunks) res.write(c);
          chunks.length = 0;
        }
      });

      upstreamRes.on('end', () => {
        if (closed || res.writableEnded) return;
        if (streamedRaw) {
          return res.end();
        }
        const buf = Buffer.concat(chunks);
        const txt = buf.toString('utf8').replace(/^\uFEFF/, '');
        if (/^\s*#EXTM3U/i.test(txt) && /#EXT-X-/i.test(txt)) {
          const rewritten = rewriteHlsManifest(txt, targetUrl);
          setCorsHeaders(res, 200, {
            'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          return res.end(rewritten);
        }
        sendRawHeaders();
        res.end(buf);
      });

      upstreamRes.on('error', () => {
        if (!res.headersSent) {
          setCorsHeaders(res, 502, { 'Content-Type': 'text/plain' });
        }
        try {
          res.end();
        } catch (e) {}
      });
      return;
    }

    const headers = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstreamRes.headers[h]) headers[h] = upstreamRes.headers[h];
    }
    if (!isImg && (!headers['content-type'] || /octet-stream/i.test(headers['content-type']))) {
      const extm = parsed.pathname.match(/\.(mp4|m4v|mkv|webm|ogv|ts|m3u8)$/i);
      if (extm) {
        const map = {
          mp4: 'video/mp4',
          m4v: 'video/mp4',
          mkv: 'video/x-matroska',
          webm: 'video/webm',
          ogv: 'video/ogg',
          ts: 'video/mp2t',
          m3u8: 'application/vnd.apple.mpegurl',
        };
        headers['content-type'] = map[extm[1].toLowerCase()] || headers['content-type'];
      }
    }
    if (isImg) {
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    setCorsHeaders(res, upstreamRes.statusCode || 200, headers);
    if (options.method === 'HEAD') {
      upstreamRes.resume();
      return res.end();
    }
    upstreamRes.on('error', () => {
      try {
        res.end();
      } catch (e) {}
    });
    upstreamRes.pipe(res);
  });

  const cleanup = () => {
    closed = true;
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  };
  res.on('close', cleanup);

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('ETIMEDOUT'));
  });

  upstreamReq.on('error', (err) => {
    if (closed) return;
    if (
      !insecure &&
      parsed.protocol === 'https:' &&
      /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|EXPIRED/i.test(String(err.code || err.message))
    ) {
      res.removeListener('close', cleanup);
      return fetchUpstream(targetUrl, req, res, redirects, true, altUa);
    }
    if (isDiag) {
      if (!res.headersSent) {
        setCorsHeaders(res, 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, status: 0, error: String(err.code || err.message), url: targetUrl }));
      }
      return;
    }
    if (!res.headersSent) {
      setCorsHeaders(res, 502, { 'Content-Type': 'text/plain' });
      res.end('proxy error: ' + (err.code || err.message));
    } else {
      try {
        res.end();
      } catch (e) {}
    }
  });

  upstreamReq.end();
}

function cleanPosterTitle(raw) {
  return String(raw || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(?:[ST]\d+\s*[Ex.]?\s*\d+|\d+\s*x\s*\d+|EP\.?\s*\d+|TEMP(?:ORADA)?\.?\s*\d+)\b.*$/i, ' ')
    .replace(/\b(4k|uhd|fhd|hd|sd|1080p|720p|480p|h264|h265|hevc|dublado|dub|legendado|leg|nacional|dual|áudio|audio|cam|ts|hdcam|web-?dl|bluray)\b/ig, ' ')
    .replace(/\s*[-–|:]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const posterCache = new Map();
let activeLookups = 0;
const lookupQueue = [];

function runWithLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeLookups++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          activeLookups--;
          if (lookupQueue.length) lookupQueue.shift()();
        });
    };
    if (activeLookups < 6) run();
    else lookupQueue.push(run);
  });
}

async function resolvePosterUrl(title, type) {
  const cleaned = cleanPosterTitle(title);
  if (!cleaned) return null;
  const key = `${type || 'movie'}:${cleaned.toLowerCase()}`;
  if (posterCache.has(key)) return posterCache.get(key);

  const found = await runWithLimit(async () => {
    if (posterCache.has(key)) return posterCache.get(key);
    let imgUrl = null;

    if (type === 'series') {
      try {
        const r = await fetch(
          `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(cleaned)}`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (r.ok) {
          const data = await r.json();
          imgUrl = data?.image?.medium || data?.image?.original || null;
        }
      } catch (e) {}
    }

    if (!imgUrl) {
      try {
        const q = cleaned.slice(0, 60);
        const r = await fetch(
          `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`,
          {
            signal: AbortSignal.timeout(4500),
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
            },
          }
        );
        if (r.ok) {
          const data = await r.json();
          const list = Array.isArray(data?.d) ? data.d : [];
          const wantTv = type === 'series';
          const match =
            list.find((x) => x?.i?.imageUrl && (wantTv ? /tv/i.test(x.qid || '') : /movie/i.test(x.qid || ''))) ||
            list.find((x) => x?.i?.imageUrl);
          if (match?.i?.imageUrl) {
            imgUrl = String(match.i.imageUrl).replace(/\._V1_.*\.jpg$/i, '._V1_UX360_.jpg');
          }
        }
      } catch (e) {}
    }

    if (posterCache.size > 2000) {
      const firstKey = posterCache.keys().next().value;
      posterCache.delete(firstKey);
    }
    posterCache.set(key, imgUrl || '');
    return imgUrl;
  });

  return found || null;
}

function buildFallbackPosterSvg(title, type) {
  const clean = cleanPosterTitle(title) || String(title || 'Lume Player');
  const words = clean.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 16 && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= 3) break;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur && lines.length < 4) lines.push(cur);
  const palette = [
    ['#1e1b4b', '#be123c', '#ff4d6d'],
    ['#0f172a', '#0369a1', '#38bdf8'],
    ['#064e3b', '#0f172a', '#34d399'],
    ['#431407', '#18181b', '#fb923c'],
    ['#312e81', '#09090b', '#a78bfa'],
  ];
  let hash = 0;
  for (let i = 0; i < clean.length; i++) hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  const [c1, c2, ac] = palette[hash % palette.length];
  const badge = type === 'series' ? 'SÉRIE' : type === 'live' ? 'TV' : 'FILME';
  const textEls = lines
    .map((ln, idx) => `<text x="48" y="${620 + idx * 54}" fill="#ffffff" font-family="system-ui,-apple-system,sans-serif" font-size="42" font-weight="800">${escapeXml(ln)}</text>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <circle cx="460" cy="210" r="130" fill="${ac}" fill-opacity="0.16" stroke="${ac}" stroke-opacity="0.35" stroke-width="3"/>
  <path d="M440 175 L500 210 L440 245 Z" fill="#ffffff" fill-opacity="0.85"/>
  <rect x="48" y="64" width="124" height="40" rx="10" fill="${ac}"/>
  <text x="110" y="92" text-anchor="middle" fill="#ffffff" font-family="system-ui,-apple-system,sans-serif" font-size="20" font-weight="800" letter-spacing="2">${badge}</text>
  <rect x="0" y="530" width="600" height="370" fill="#000000" fill-opacity="0.38"/>
  <line x1="48" y1="566" x2="136" y2="566" stroke="${ac}" stroke-width="6" stroke-linecap="round"/>
  ${textEls}
</svg>`;
}

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, 204);
    return res.end();
  }
  next();
});

app.get('/ping', (req, res) => {
  setCorsHeaders(res, 200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

app.all(['/proxy', '/proxy/:file'], (req, res) => {
  const target = req.query && req.query.u;
  if (!target || typeof target !== 'string') {
    setCorsHeaders(res, 400, { 'Content-Type': 'text/plain' });
    return res.end('missing url');
  }
  if (req.query.img) res._isImg = true;
  if (req.query.hls) res._isHls = true;
  if (req.query.diag) res._isDiag = true;
  return fetchUpstream(target, req, res, 0, false);
});

app.get('/vendor/hls.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/hls.js/dist/hls.min.js'));
});

app.get('/vendor/mpegts.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/mpegts.js/dist/mpegts.js'));
});

app.get('/api/poster', async (req, res) => {
  const title = String(req.query.title || '');
  const type = String(req.query.type || 'movie');
  try {
    const imgUrl = type !== 'live' ? await resolvePosterUrl(title, type) : null;
    if (imgUrl) {
      const r = await fetch(imgUrl, { signal: AbortSignal.timeout(5000) });
      const ct = r.headers.get('content-type') || 'image/jpeg';
      if (r.ok && /^image\//i.test(ct)) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.end(buf);
      }
    }
  } catch (e) {}
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(buildFallbackPosterSvg(title, type));
});

app.get('/', (req, res, next) => {
  if (req.query && typeof req.query.u === 'string') {
    return fetchUpstream(req.query.u, req, res, 0, false);
  }
  return next();
});

const DEMO_ITEMS = {
  // Canais
  'ch-cine': { title: 'Lume Cine', sub: 'AO VIVO · FILMES HD', c1: '#1e1b4b', c2: '#be123c', ac: '#ff4d6d', kind: 'TV' },
  'ch-doc': { title: 'Terra & Cosmos', sub: 'AO VIVO · DOCUMENTÁRIOS', c1: '#064e3b', c2: '#0f172a', ac: '#34d399', kind: 'TV' },
  'ch-acao': { title: 'Ação Total', sub: 'AO VIVO · SÉRIES & AÇÃO', c1: '#431407', c2: '#18181b', ac: '#fb923c', kind: 'TV' },
  'ch-anim': { title: 'Studio Anim', sub: 'AO VIVO · ANIMAÇÃO', c1: '#172554', c2: '#312e81', ac: '#38bdf8', kind: 'TV' },
  // Filmes
  'sintel': { title: 'SINTEL', sub: 'FANTASIA · 2010', c1: '#3b0764', c2: '#9f1239', ac: '#fb7185', kind: 'FILME' },
  'tos': { title: 'TEARS OF STEEL', sub: 'FICÇÃO CIENTÍFICA · 2012', c1: '#0f172a', c2: '#0369a1', ac: '#38bdf8', kind: 'FILME' },
  'bbb': { title: 'BIG BUCK BUNNY', sub: 'ANIMAÇÃO · COMÉDIA', c1: '#14532d', c2: '#1e293b', ac: '#4ade80', kind: 'FILME' },
  'ed': { title: 'ELEPHANTS DREAM', sub: 'SCI-FI · SURREAL', c1: '#312e81', c2: '#09090b', ac: '#a78bfa', kind: 'FILME' },
  'blazes': { title: 'CHAMAS NA SERRA', sub: 'AVENTURA · AÇÃO', c1: '#7c2d12', c2: '#1c1917', ac: '#fb923c', kind: 'FILME' },
  'escapes': { title: 'ROTA DE FUGA', sub: 'SUSPENSE · DRAMA', c1: '#1e293b', c2: '#4c0519', ac: '#f43f5e', kind: 'FILME' },
  // Séries - Cosmos
  'cosmos-1': { title: 'COSMOS', sub: 'T1 E1 · O DESPERTAR', c1: '#090d1f', c2: '#1d4ed8', ac: '#60a5fa', kind: 'SÉRIE' },
  'cosmos-2': { title: 'COSMOS', sub: 'T1 E2 · ÓRBITA PERDIDA', c1: '#0f172a', c2: '#0e7490', ac: '#22d3ee', kind: 'SÉRIE' },
  'cosmos-3': { title: 'COSMOS', sub: 'T1 E3 · NEBULOSA', c1: '#1e1b4b', c2: '#6d28d9', ac: '#c084fc', kind: 'SÉRIE' },
  'cosmos-4': { title: 'COSMOS', sub: 'T1 E4 · NOVO HORIZONTE', c1: '#042f2e', c2: '#0f172a', ac: '#2dd4bf', kind: 'SÉRIE' },
  // Séries - Horizonte Digital
  'horizonte-1': { title: 'HORIZONTE', sub: 'T1 E1 · CÓDIGO ZERO', c1: '#18181b', c2: '#be123c', ac: '#fb7185', kind: 'SÉRIE' },
  'horizonte-2': { title: 'HORIZONTE', sub: 'T1 E2 · SINAL OCULTO', c1: '#27272a', c2: '#9a3412', ac: '#fb923c', kind: 'SÉRIE' },
  'horizonte-3': { title: 'HORIZONTE', sub: 'T1 E3 · ÚLTIMA REDE', c1: '#09090b', c2: '#3730a3', ac: '#818cf8', kind: 'SÉRIE' },
};

function escapeXml(str) {
  return String(str || '').replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;'
  }[ch]));
}

app.get('/posters/:slug.svg', (req, res) => {
  const item = DEMO_ITEMS[req.params.slug] || {
    title: 'LUME PLAYER',
    sub: 'CATÁLOGO',
    c1: '#1a1c24',
    c2: '#0a0b0e',
    ac: '#ff4d6d',
    kind: 'MÍDIA',
  };
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${item.c1}"/>
      <stop offset="100%" stop-color="${item.c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="75%" cy="25%" r="60%">
      <stop offset="0%" stop-color="${item.ac}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${item.ac}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <rect width="600" height="900" fill="url(#glow)"/>
  <circle cx="460" cy="210" r="140" fill="none" stroke="${item.ac}" stroke-opacity="0.35" stroke-width="3"/>
  <circle cx="460" cy="210" r="90" fill="${item.ac}" fill-opacity="0.16"/>
  <path d="M440 175 L500 210 L440 245 Z" fill="#ffffff" fill-opacity="0.88"/>
  <rect x="48" y="64" width="124" height="40" rx="10" fill="${item.ac}"/>
  <text x="110" y="92" text-anchor="middle" fill="#ffffff" font-family="system-ui,-apple-system,sans-serif" font-size="20" font-weight="800" letter-spacing="2">${escapeXml(item.kind)}</text>
  <rect x="0" y="580" width="600" height="320" fill="#000000" fill-opacity="0.38"/>
  <line x1="48" y1="640" x2="148" y2="640" stroke="${item.ac}" stroke-width="6" stroke-linecap="round"/>
  <text x="48" y="720" fill="#ffffff" font-family="system-ui,-apple-system,sans-serif" font-size="48" font-weight="800">${escapeXml(item.title)}</text>
  <text x="48" y="772" fill="#d1d5db" font-family="system-ui,-apple-system,sans-serif" font-size="24" font-weight="600" letter-spacing="1">${escapeXml(item.sub)}</text>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(svg);
});

app.get('/demo.m3u', (req, res) => {
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-logo="/posters/ch-cine.svg" group-title="Canais | Entretenimento",Lume Cine HD
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-logo="/posters/ch-doc.svg" group-title="Canais | Documentários",Terra & Cosmos TV
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
#EXTINF:-1 tvg-logo="/posters/ch-acao.svg" group-title="Canais | Ação",Ação Total TV
https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4
#EXTINF:-1 tvg-logo="/posters/ch-anim.svg" group-title="Canais | Infantil",Studio Anim TV
https://download.blender.org/peach/trailer/trailer_iphone.m4v
#EXTINF:-1 tvg-logo="/posters/sintel.svg" group-title="Filmes | Fantasia",Sintel (2010)
https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4
#EXTINF:-1 tvg-logo="/posters/tos.svg" group-title="Filmes | Ficção Científica",Tears of Steel (2012)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-logo="/posters/bbb.svg" group-title="Filmes | Animação",Big Buck Bunny (2008)
https://download.blender.org/peach/trailer/trailer_iphone.m4v
#EXTINF:-1 tvg-logo="/posters/ed.svg" group-title="Filmes | Ficção Científica",Elephants Dream (2006)
https://download.blender.org/peach/trailer/trailer_400p.ogg
#EXTINF:-1 tvg-logo="/posters/blazes.svg" group-title="Filmes | Ação",Chamas na Serra (2018)
https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4
#EXTINF:-1 tvg-logo="/posters/escapes.svg" group-title="Filmes | Suspense",Rota de Fuga (2020)
https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
#EXTINF:-1 tvg-logo="/posters/cosmos-1.svg" group-title="Séries | Ficção",Cosmos: Mundos Distantes S01E01 - O Despertar
https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4
#EXTINF:-1 tvg-logo="/posters/cosmos-2.svg" group-title="Séries | Ficção",Cosmos: Mundos Distantes S01E02 - Órbita Perdida
https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4
#EXTINF:-1 tvg-logo="/posters/cosmos-3.svg" group-title="Séries | Ficção",Cosmos: Mundos Distantes S01E03 - Nebulosa
https://download.blender.org/peach/trailer/trailer_iphone.m4v
#EXTINF:-1 tvg-logo="/posters/cosmos-4.svg" group-title="Séries | Ficção",Cosmos: Mundos Distantes S01E04 - Novo Horizonte
https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
#EXTINF:-1 tvg-logo="/posters/horizonte-1.svg" group-title="Séries | Suspense",Horizonte Digital S01E01 - Código Zero
https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4
#EXTINF:-1 tvg-logo="/posters/horizonte-2.svg" group-title="Séries | Suspense",Horizonte Digital S01E02 - Sinal Oculto
https://download.blender.org/peach/trailer/trailer_400p.ogg
#EXTINF:-1 tvg-logo="/posters/horizonte-3.svg" group-title="Séries | Suspense",Horizonte Digital S01E03 - Última Rede
https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4
`;
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.end(m3u);
});

app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Lume Player listening on http://${HOST}:${PORT}`);
});
