const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || process.argv[2] || 23241);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'received');
const JSONL_FILE = path.join(DATA_DIR, 'captures.jsonl');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

function loadCaptures() {
  try {
    const lines = fs.readFileSync(JSONL_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line)).reverse();
  } catch (_) {
    return [];
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(value, null, 2));
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHome(captures) {
  const latest = captures[0];
  const rows = captures
    .slice(0, 50)
    .map((capture, index) => {
      const itemId =
        capture.body && typeof capture.body === 'object' ? capture.body.item_id || '' : '';
      const comments =
        capture.body && capture.body.comments && Array.isArray(capture.body.comments)
          ? capture.body.comments.length
          : 0;
      const images =
        capture.body && capture.body.images && Array.isArray(capture.body.images)
          ? capture.body.images.length
          : 0;
      return `<tr>
        <td>${index + 1}</td>
        <td>${htmlEscape(capture.time)}</td>
        <td>${htmlEscape(itemId)}</td>
        <td>${images}</td>
        <td>${comments}</td>
        <td><a href="/capture/${capture.id}">查看</a></td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PPX Receiver</title>
  <style>
    body { margin: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #1f2328; }
    main { max-width: 1180px; margin: 0 auto; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    .bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    a.button { color: #fff; background: #0969da; padding: 8px 12px; border-radius: 6px; text-decoration: none; }
    section { background: #fff; border: 1px solid #d8dee4; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #d8dee4; padding: 8px; text-align: left; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto; max-height: 520px; }
  </style>
</head>
<body>
  <main>
    <h1>PPX Receiver</h1>
    <div class="bar">
      <a class="button" href="/">刷新</a>
      <a class="button" href="/latest">latest.json</a>
      <a class="button" href="/captures">captures.json</a>
    </div>
    <section>
      <h2>最近一次</h2>
      <pre>${latest ? htmlEscape(JSON.stringify(latest, null, 2)) : '还没有收到数据'}</pre>
    </section>
    <section>
      <h2>最近 50 条</h2>
      <table>
        <thead><tr><th>#</th><th>时间</th><th>item_id</th><th>图片</th><th>评论</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6">暂无</td></tr>'}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function saveCapture(req, rawBody) {
  ensureDataDir();
  const capture = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: parseBody(rawBody),
  };

  fs.appendFileSync(JSONL_FILE, `${JSON.stringify(capture)}\n`);
  fs.writeFileSync(LATEST_FILE, JSON.stringify(capture, null, 2));
  return capture;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    if (req.method === 'POST') {
      const rawBody = await readBody(req);
      const capture = saveCapture(req, rawBody);
      return sendJson(res, 200, { ok: true, id: capture.id, saved: LATEST_FILE });
    }

    if (req.url === '/latest') {
      const captures = loadCaptures();
      return sendJson(res, 200, captures[0] || null);
    }

    if (req.url === '/captures') {
      return sendJson(res, 200, loadCaptures());
    }

    const captureMatch = req.url.match(/^\/capture\/([^/?#]+)/);
    if (captureMatch) {
      const capture = loadCaptures().find((item) => item.id === captureMatch[1]);
      return sendJson(res, capture ? 200 : 404, capture || { error: 'not found' });
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderHome(loadCaptures()));
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

ensureDataDir();
server.listen(PORT, HOST, () => {
  console.log(`PPX receiver listening on http://${HOST}:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
