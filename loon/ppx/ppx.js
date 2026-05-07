/**
 * 皮皮虾数据抓取
 * - 拦截推荐流接口，尝试上报 feed 中已携带的热评
 * - 拦截评论接口，使用 App 真实返回的评论数据上报到本地 ppx 服务器
 * 配合 ppx.plugin 使用，参数通过 [Argument] 配置
 */

const MIN_COMMENTS = 5;
const MAX_ACTIVE_COMMENT_REQUESTS = 5;
const NOTIFY_MAX_LEN = 520;

const $ = {
  notify: (title, subtitle, body) => $notification.post(title, subtitle, body),
  done: () => $done({}),
  get: (opts) =>
    new Promise((resolve, reject) =>
      $httpClient.get(opts, (err, resp, data) =>
        err ? reject(err) : resolve({ status: resp.status, body: data })
      )
    ),
  post: (opts) =>
    new Promise((resolve, reject) =>
      $httpClient.post(opts, (err, resp, data) =>
        err ? reject(err) : resolve({ status: resp.status, body: data })
      )
    ),
};

function truncate(value, maxLen) {
  const text = String(value || '');
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function notifyPPX(subtitle, body) {
  $.notify('皮皮虾', subtitle, truncate(body, NOTIFY_MAX_LEN));
}

function readArgs() {
  if (typeof $argument === 'object' && $argument) {
    if (Array.isArray($argument)) {
      return {
        server_url: $argument[0] || '',
        tg_bot_token: $argument[1] || '',
        tg_chat_id: $argument[2] || '',
      };
    }
    return $argument;
  }
  if (typeof $argument !== 'string') return {};

  try {
    const parsed = JSON.parse($argument);
    if (Array.isArray(parsed)) {
      return {
        server_url: parsed[0] || '',
        tg_bot_token: parsed[1] || '',
        tg_chat_id: parsed[2] || '',
      };
    }
    return parsed || {};
  } catch (_) {}

  const bracketMatch = $argument.match(/^\[(.*)\]$/);
  if (bracketMatch) {
    const parts = bracketMatch[1].split(',').map((part) => part.trim());
    return {
      server_url: parts[0] || '',
      tg_bot_token: parts[1] || '',
      tg_chat_id: parts[2] || '',
    };
  }

  return $argument.split('&').reduce((args, part) => {
    const index = part.indexOf('=');
    if (index === -1) return args;
    const key = decodeURIComponent(part.slice(0, index));
    const value = decodeURIComponent(part.slice(index + 1));
    args[key] = value;
    return args;
  }, {});
}

function sendTG(botToken, chatId, text) {
  if (!botToken || !chatId || !text) return Promise.resolve();
  return $.get({
    url: `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML`,
  }).catch(() => {});
}

function getParam(url, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = url.match(new RegExp(`[?&]${escaped}=([^&]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function parseQuery(url) {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return {};

  const hashIndex = url.indexOf('#', queryIndex);
  const query = url.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex);
  return query.split('&').reduce((params, part) => {
    if (!part) return params;
    const index = part.indexOf('=');
    const key = decodeURIComponent(index === -1 ? part : part.slice(0, index));
    const value = decodeURIComponent(index === -1 ? '' : part.slice(index + 1));
    params[key] = value;
    return params;
  }, {});
}

function buildQuery(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&');
}

function originOf(url) {
  const match = String(url || '').match(/^https?:\/\/[^/?#]+/);
  return match ? match[0] : 'https://api5-lf.pipix.com';
}

function hostOf(url) {
  return originOf(url).replace(/^https?:\/\//, '');
}

function routeOf(url) {
  const path = String(url || '').replace(/^https?:\/\/[^/]+/, '');
  return path.split('?')[0] || '/';
}

function headerValue(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return '';
}

function isPpxTraceRequest(url, headers) {
  const host = hostOf(url).toLowerCase();
  const route = routeOf(url).toLowerCase();
  const ua = String(headerValue(headers, 'user-agent')).toLowerCase();

  if (route.indexOf('/bds/rule/table') !== -1) return false;

  return (
    host.indexOf('pipix.com') !== -1 ||
    host.indexOf('snssdk.com') !== -1 ||
    route.indexOf('/bds/') !== -1 ||
    ua.indexOf('super ') !== -1 ||
    ua.indexOf('super/') !== -1 ||
    ua.indexOf('pipix') !== -1
  );
}

function getRequest() {
  return typeof $request === 'object' && $request ? $request : {};
}

function getResponse() {
  return typeof $response === 'object' && $response ? $response : null;
}

function buildCommentUrl(feedUrl, itemId, cellType) {
  const params = parseQuery(feedUrl);
  params.offset = '0';
  params.cell_type = String(cellType || 1);
  params.api_version = '1';
  params.cell_id = String(itemId);

  return `${originOf(feedUrl)}/bds/cell/cell_comment/?${buildQuery(params)}`;
}

function buildCommentHeaders(headers, targetUrl, stripSignatures) {
  const bodyHeaders = {
    'content-length': true,
    'content-type': true,
    'x-ss-stub': true,
  };
  const signHeaders = {
    'x-argus': true,
    'x-gorgon': true,
    'x-helios': true,
    'x-khronos': true,
    'x-ladon': true,
    'x-medusa': true,
    'x-tt-trace-id': true,
    'tt-request-time': true,
  };
  const nextHeaders = {};

  Object.keys(headers || {}).forEach((key) => {
    const lower = key.toLowerCase();
    if (bodyHeaders[lower]) return;
    if (stripSignatures && signHeaders[lower]) return;

    nextHeaders[key] = lower === 'host' ? hostOf(targetUrl) : headers[key];
  });

  return nextHeaders;
}

function firstUrl(image) {
  if (!image) return '';
  const downloadList = image.download_list || [];
  const urlList = image.url_list || [];
  return (
    (downloadList[0] && downloadList[0].url) ||
    (urlList[0] && urlList[0].url) ||
    image.url ||
    ''
  );
}

function extractImages(item) {
  const note = (item && item.note) || {};
  const multiImage = note.multi_image || [];
  const images = multiImage
    .map((image) => ({
      url: firstUrl(image),
      is_gif: !!image.is_gif,
    }))
    .filter((image) => image.url);

  if (images.length > 0) return images;

  const coverUrl = firstUrl(item && item.cover);
  return coverUrl ? [{ url: coverUrl, is_gif: !!(item && item.cover && item.cover.is_gif) }] : [];
}

function cleanText(text) {
  return String(text || '')
    .replace(/\[b[^\]]*\]/g, '')
    .replace(/\[\/b\]/g, '')
    .trim();
}

function extractComments(cellsOrComments) {
  const seen = {};
  const comments = [];

  (cellsOrComments || []).forEach((cell) => {
    const info = cell && (cell.comment_info || cell);
    if (!info) return;

    const text = cleanText(info.text || info.content);
    const id = String(info.comment_id_str || info.comment_id || cell.cell_id_str || cell.cell_id || '');
    if (!text || seen[id || text]) return;
    if (text.indexOf('type=1') !== -1) return;

    seen[id || text] = true;
    comments.push({ id, text });
  });

  return comments;
}

function extractItemFromComments(cellComments) {
  for (const cell of cellComments || []) {
    const info = cell && cell.comment_info;
    if (info && info.item) return info.item;
  }
  return null;
}

function itemIdOf(item) {
  return String((item && (item.item_id_str || item.item_id)) || '');
}

function commentItemIdOf(cell) {
  const info = cell && (cell.comment_info || cell);
  if (!info) return '';

  return String(
    itemIdOf(info.item) ||
      info.item_id_str ||
      info.item_id ||
      info.root_cell_id_str ||
      info.root_cell_id ||
      ''
  );
}

function buildPayload(item, comments, source) {
  const note = (item && item.note) || {};
  return {
    item_id: itemIdOf(item),
    title: cleanText(note.title || note.text || (item && item.content)),
    images: extractImages(item),
    comments,
    source,
  };
}

async function collect(serverUrl, payload) {
  notifyPPX(
    '准备上报',
    `server=${serverUrl.replace(/\/+$/, '')}/collect item=${payload.item_id} images=${payload.images.length} comments=${payload.comments.length} source=${payload.source}`
  );

  const resp = await $.post({
    url: serverUrl.replace(/\/+$/, '') + '/collect',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (resp.status < 200 || resp.status >= 300) {
    notifyPPX(
      '上报失败',
      `status=${resp.status} item=${payload.item_id} body=${String(resp.body || '').slice(0, 160)}`
    );
    throw new Error(`collect status=${resp.status} body=${String(resp.body || '').slice(0, 120)}`);
  }

  notifyPPX('上报成功', `item=${payload.item_id} status=${resp.status}`);
}

async function fetchCommentPage(feedUrl, reqHeaders, itemId, cellType) {
  const url = buildCommentUrl(feedUrl, itemId, cellType);
  const attempts = [
    { name: 'clean', headers: buildCommentHeaders(reqHeaders, url, true) },
    { name: 'fallback', headers: buildCommentHeaders(reqHeaders, url, false) },
  ];
  let lastError = '';

  for (const attempt of attempts) {
    try {
      notifyPPX('主动拉评论', `item=${itemId} mode=${attempt.name} url=${routeOf(url)}`);
      const resp = await $.get({ url, headers: attempt.headers });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`status=${resp.status}`);
      }

      const data = JSON.parse(resp.body || '{}');
      if (data.status_code !== undefined && data.status_code !== 0) {
        throw new Error(`code=${data.status_code} message=${data.message || ''}`);
      }

      const count = data.data && data.data.cell_comments ? data.data.cell_comments.length : 0;
      notifyPPX('主动拉成功', `item=${itemId} mode=${attempt.name} comments=${count}`);
      return { data, url, mode: attempt.name };
    } catch (e) {
      lastError = `${attempt.name}: ${e && e.message ? e.message : e}`;
      notifyPPX('主动拉失败', `item=${itemId} ${lastError}`);
      console.log(`[PPX] comment fetch ${itemId} ${lastError}`);
    }
  }

  throw new Error(lastError || 'comment fetch failed');
}

async function handleFeed(feedData, serverUrl, reqUrl, reqHeaders) {
  const items = (feedData.data && feedData.data.data) || [];
  const itemById = {};
  const cellTypeById = {};
  const commentsByItemId = {};
  let commentCellCount = 0;

  notifyPPX(
    'Feed 响应已抓到',
    `items=${items.length} host=${hostOf(reqUrl)} server=${serverUrl || '未配置'}`
  );

  function addComments(itemId, comments) {
    if (!itemId || !comments || comments.length === 0) return;
    commentsByItemId[itemId] = (commentsByItemId[itemId] || []).concat(comments);
  }

  for (const cell of items) {
    const item = cell && cell.item;
    if (item && cell.cell_type === 1) {
      const id = itemIdOf(item) || String(cell.cell_id_str || cell.cell_id || '');
      if (id) itemById[id] = item;
      if (id) cellTypeById[id] = cell.cell_type || item.item_cell_type || item.item_type || 1;
      addComments(id, item.comments || []);
      continue;
    }

    if (cell && cell.comment_info) {
      commentCellCount++;
      const id = commentItemIdOf(cell);
      if (id && !itemById[id] && cell.comment_info.item) {
        itemById[id] = cell.comment_info.item;
      }
      if (id && !cellTypeById[id]) {
        cellTypeById[id] = cell.comment_info.root_cell_type || 1;
      }
      addComments(id, [cell]);
    }
  }

  let successCount = 0;
  let candidateCount = 0;
  let activeTried = 0;
  let activeFetched = 0;
  let activeFailed = 0;
  const activeTargets = [];

  for (const id in itemById) {
    const item = itemById[id];
    const images = extractImages(item);
    const comments = extractComments(commentsByItemId[id] || []);
    const commentCount = (item.stats && item.stats.comment_count) || comments.length;

    if (images.length > 0 && commentCount >= MIN_COMMENTS) candidateCount++;
    if (images.length === 0 || commentCount < MIN_COMMENTS) continue;

    if (comments.length >= MIN_COMMENTS) {
      await collect(serverUrl, buildPayload(item, comments, 'feed'));
      successCount++;
      continue;
    }

    activeTargets.push({ id, item, cellType: cellTypeById[id] || 1 });
  }

  notifyPPX(
    'Feed 候选统计',
    `帖子=${Object.keys(itemById).length} 评论卡=${commentCellCount} 候选=${candidateCount} 需主动=${activeTargets.length}`
  );

  for (const target of activeTargets.slice(0, MAX_ACTIVE_COMMENT_REQUESTS)) {
    activeTried++;

    try {
      const page = await fetchCommentPage(reqUrl, reqHeaders, target.id, target.cellType);
      const data = page.data.data || {};
      const cellComments = data.cell_comments || [];
      const comments = extractComments(cellComments);
      const item = extractItemFromComments(cellComments) || target.item;
      const payload = buildPayload(item, comments, `active_comment:${page.mode}`);
      payload.item_id = payload.item_id || target.id;

      if (payload.images.length === 0 || payload.comments.length < MIN_COMMENTS) {
        notifyPPX(
          '主动评论不足',
          `item=${target.id} images=${payload.images.length} comments=${payload.comments.length}`
        );
        console.log(`[PPX] comment fetch ${target.id} not enough images=${payload.images.length} comments=${payload.comments.length}`);
        continue;
      }

      await collect(serverUrl, payload);
      activeFetched++;
      successCount++;
    } catch (e) {
      activeFailed++;
      notifyPPX('主动处理失败', `item=${target.id} ${e && e.message ? e.message : e}`);
      console.log(`[PPX] comment fetch ${target.id} failed: ${e && e.message ? e.message : e}`);
    }
  }

  notifyPPX(
    'Feed 已拦截',
    `共 ${items.length} 条，评论卡 ${commentCellCount} 条，候选 ${candidateCount} 条，主动 ${activeTried}/${activeTargets.length} 条，上报 ${successCount} 条，失败 ${activeFailed} 条`
  );

  return {
    successCount,
    candidateCount,
    total: items.length,
    commentCellCount,
    activeTried,
    activeFetched,
    activeFailed,
  };
}

async function handleComments(commentData, serverUrl, reqUrl) {
  const data = commentData.data || {};
  const cellComments = data.cell_comments || [];
  const comments = extractComments(cellComments);
  const item = extractItemFromComments(cellComments);
  const itemId = getParam(reqUrl, 'cell_id') || (item && (item.item_id_str || item.item_id)) || '';
  const offset = getParam(reqUrl, 'offset') || '0';

  notifyPPX(
    '评论响应已抓到',
    `cell=${itemId} offset=${offset} raw=${cellComments.length} filtered=${comments.length}`
  );

  if (offset !== '0') {
    notifyPPX('评论分页跳过', `cell=${itemId} offset=${offset}`);
    return { skipped: true, reason: 'offset' };
  }

  if (!item) {
    notifyPPX('评论无正文', `cell=${itemId} comments=${comments.length}`);
    return { skipped: true, reason: 'no_item' };
  }

  const payload = buildPayload(item, comments, 'comment');
  payload.item_id = payload.item_id || String(itemId);

  if (payload.images.length === 0 || payload.comments.length < MIN_COMMENTS) {
    notifyPPX(
      '评论不足',
      `cell=${payload.item_id} images=${payload.images.length} comments=${payload.comments.length}`
    );
    return { skipped: true, reason: 'not_enough' };
  }

  await collect(serverUrl, payload);
  notifyPPX('评论上报完成', `cell=${payload.item_id} comments=${payload.comments.length}`);
  return { successCount: 1, itemId: payload.item_id, comments: payload.comments.length };
}

(async () => {
  const req = getRequest();
  const resp = getResponse();
  const args = readArgs();
  const serverUrl = args.server_url || '';
  const tgBotToken = args.tg_bot_token || '';
  const tgChatId = args.tg_chat_id || '';
  const reqUrl = req.url || '';

  if (/^https?:\/\/neverssl\.com\/ppx-debug/.test(reqUrl)) {
    notifyPPX(
      '脚本触发',
      `method=${req.method || 'n/a'} url=${routeOf(reqUrl)} response=${resp ? 'yes' : 'no'} server=${serverUrl || '未配置'} body=${resp && resp.body ? resp.body.length : 0}`
    );
    notifyPPX('测试命中', `response=${resp ? 'yes' : 'no'} status=${resp && resp.status ? resp.status : 'n/a'}`);
    return $.done();
  }

  if (!isPpxTraceRequest(reqUrl, req.headers || {})) {
    return $.done();
  }

  notifyPPX(
    '脚本触发',
    `method=${req.method || 'n/a'} url=${routeOf(reqUrl)} response=${resp ? 'yes' : 'no'} server=${serverUrl || '未配置'} body=${resp && resp.body ? resp.body.length : 0}`
  );

  if (!resp) {
    notifyPPX(
      '请求已抓到',
      `host=${hostOf(reqUrl)} route=${routeOf(reqUrl)} ua=${truncate(headerValue(req.headers, 'user-agent'), 140)}`
    );
    return $.done();
  }

  const isTargetResponse =
    /\/bds\/cell\/cell_comment\//.test(reqUrl) || /\/bds\/feed\/stream/.test(reqUrl);
  if (!isTargetResponse && /(pipix|snssdk)\.com\//.test(reqUrl)) {
    notifyPPX(
      '域名响应命中',
      `host=${hostOf(reqUrl)} route=${routeOf(reqUrl)} body=${resp && resp.body ? resp.body.length : 0}`
    );
    return $.done();
  }

  if (!serverUrl) {
    notifyPPX('配置缺失', '请在插件参数中填写服务器地址');
    return $.done();
  }

  try {
    const body = JSON.parse(resp.body || '{}');
    let result;

    notifyPPX(
      '响应解析成功',
      `route=${routeOf(reqUrl)} status_code=${body.status_code === undefined ? 'n/a' : body.status_code}`
    );

    if (/\/bds\/cell\/cell_comment\//.test(reqUrl)) {
      result = await handleComments(body, serverUrl, reqUrl);
    } else if (/\/bds\/feed\/stream/.test(reqUrl)) {
      result = await handleFeed(body, serverUrl, reqUrl, req.headers || {});
    } else {
      result = { skipped: true, reason: 'unknown_url' };
    }

    if (result && result.successCount > 0) {
      await sendTG(tgBotToken, tgChatId, `皮皮虾抓取成功：${JSON.stringify(result)}`);
    }
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    notifyPPX('脚本异常', message);
    await sendTG(tgBotToken, tgChatId, `皮皮虾脚本异常: ${message}`);
  }

  $.done();
})();
