/**
 * Hikiot 请求/响应抓取到 Telegram
 * 配合 hikiot_capture.plugin 使用，参数通过 [Argument] 配置。
 */

const STORE_PREFIX = 'hikiot_capture_request_';
const STORE_TTL_MS = 10 * 60 * 1000;
const STORE_MAX_ITEMS = 8;
const TG_MAX_LEN = 3900;
const DEFAULT_BODY_LIMIT = 1600;

const $ = {
  notify: (title, subtitle, body) => $notification.post(title, subtitle, body),
  done: () => $done({}),
  post: (opts) =>
    new Promise((resolve, reject) =>
      $httpClient.post(opts, (err, resp, data) =>
        err ? reject(err) : resolve({ status: resp && resp.status, body: data })
      )
    ),
};

function readArgs() {
  if (typeof $argument === 'object' && $argument) {
    if (Array.isArray($argument)) return argsFromArray($argument);
    return $argument;
  }

  if (typeof $argument !== 'string') return {};

  try {
    const parsed = JSON.parse($argument);
    if (Array.isArray(parsed)) return argsFromArray(parsed);
    return parsed || {};
  } catch (_) {}

  const bracketMatch = $argument.match(/^\[(.*)\]$/);
  if (bracketMatch) {
    return argsFromArray(bracketMatch[1].split(',').map((part) => part.trim()));
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

function argsFromArray(parts) {
  return {
    tg_bot_token: parts[0] || '',
    tg_chat_id: parts[1] || '',
    include_headers: parts[2] || 'false',
    mask_sensitive: parts[3] || 'true',
    max_body_chars: parts[4] || String(DEFAULT_BODY_LIMIT),
  };
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function intArg(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function getRequest() {
  return typeof $request === 'object' && $request ? $request : {};
}

function getResponse() {
  return typeof $response === 'object' && $response ? $response : null;
}

function statusOf(response) {
  return response && (response.status || response.statusCode || response.code || '');
}

function methodOf(request) {
  return String(request.method || request.httpMethod || 'GET').toUpperCase();
}

function hashText(text) {
  const input = String(text || '');
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function storeKey(request) {
  return STORE_PREFIX + hashText(`${methodOf(request)} ${request.url || ''}`);
}

function readQueue(key) {
  try {
    const items = JSON.parse($persistentStore.read(key) || '[]');
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item && Date.now() - Number(item.saved_at || 0) < STORE_TTL_MS);
  } catch (_) {
    return [];
  }
}

function writeQueue(key, queue) {
  const items = queue.slice(-STORE_MAX_ITEMS);
  return $persistentStore.write(JSON.stringify(items), key);
}

function headerValue(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return '';
}

function shouldMaskKey(key) {
  return /authorization|cookie|token|secret|password|passwd|session|access[-_]?key|refresh[-_]?key|refresh[-_]?token|api[-_]?key|openid|unionid|phone|mobile/i.test(
    String(key || '')
  );
}

function maskObject(value) {
  if (Array.isArray(value)) return value.map(maskObject);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value).reduce((next, key) => {
    next[key] = shouldMaskKey(key) ? '***' : maskObject(value[key]);
    return next;
  }, {});
}

function maskText(text) {
  return String(text || '')
    .replace(/((?:token|secret|password|passwd|authorization|cookie|session|api[-_]?key)=)[^&\s]+/gi, '$1***')
    .replace(/("(?:token|secret|password|passwd|authorization|cookie|session|api[-_]?key)"\s*:\s*")[^"]*(")/gi, '$1***$2');
}

function sanitizeHeaders(headers, maskSensitive) {
  const next = {};
  Object.keys(headers || {}).forEach((key) => {
    if (/^content-length$/i.test(key)) return;
    next[key] = maskSensitive && shouldMaskKey(key) ? '***' : headers[key];
  });
  return next;
}

function parseFormBody(text) {
  return text.split('&').reduce((params, part) => {
    if (!part) return params;
    const index = part.indexOf('=');
    const rawKey = index === -1 ? part : part.slice(0, index);
    const rawValue = index === -1 ? '' : part.slice(index + 1);
    try {
      params[decodeURIComponent(rawKey.replace(/\+/g, ' '))] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch (_) {
      params[rawKey] = rawValue;
    }
    return params;
  }, {});
}

function formatBody(body, headers, maskSensitive, maxLen) {
  if (body === undefined || body === null || body === '') return '(empty)';

  let text = typeof body === 'string' ? body : String(body);
  const contentType = String(headerValue(headers, 'content-type')).toLowerCase();

  try {
    const parsed = JSON.parse(text);
    text = JSON.stringify(maskSensitive ? maskObject(parsed) : parsed, null, 2);
  } catch (_) {
    if (contentType.indexOf('application/x-www-form-urlencoded') !== -1 || /^[^=&\s]+=[\s\S]*&?/.test(text)) {
      const parsedForm = parseFormBody(text);
      text = JSON.stringify(maskSensitive ? maskObject(parsedForm) : parsedForm, null, 2);
    } else if (maskSensitive) {
      text = maskText(text);
    }
  }

  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... [truncated ${text.length - maxLen} chars, total ${text.length}]`;
}

function captureRequest(request, opts) {
  return {
    saved_at: Date.now(),
    time: new Date().toISOString(),
    method: methodOf(request),
    url: request.url || '',
    headers: opts.includeHeaders ? sanitizeHeaders(request.headers || {}, opts.maskSensitive) : undefined,
    body: formatBody(request.body, request.headers || {}, opts.maskSensitive, opts.maxBodyChars),
  };
}

function saveRequest(request, opts) {
  const key = storeKey(request);
  const queue = readQueue(key);
  queue.push(captureRequest(request, opts));
  writeQueue(key, queue);
}

function takeRequest(request, opts) {
  const key = storeKey(request);
  const queue = readQueue(key);
  const captured = queue.shift();
  writeQueue(key, queue);
  return captured || captureRequest(request, opts);
}

function block(title, value) {
  if (!value) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `\n\n${title}\n${text}`;
}

function buildMessage(requestInfo, responseInfo, opts) {
  const lines = [
    'Hikiot Capture',
    `Time: ${new Date().toISOString()}`,
    `Method: ${requestInfo.method}`,
    `Status: ${responseInfo.status || '(unknown)'}`,
    `URL: ${requestInfo.url}`,
  ];

  return [
    lines.join('\n'),
    opts.includeHeaders ? block('Request Headers:', requestInfo.headers) : '',
    block('Request Body:', requestInfo.body),
    opts.includeHeaders ? block('Response Headers:', responseInfo.headers) : '',
    block('Response Body:', responseInfo.body),
  ].join('');
}

function splitText(text, maxLen) {
  const value = String(text || '');
  if (value.length <= maxLen) return [value];

  const parts = [];
  for (let start = 0; start < value.length; start += maxLen) {
    parts.push(value.slice(start, start + maxLen));
  }
  return parts;
}

async function sendTG(botToken, chatId, text) {
  if (!botToken || !chatId || !text) return false;

  const parts = splitText(text, TG_MAX_LEN);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `[${i + 1}/${parts.length}]\n` : '';
    await $.post({
      url: `https://api.telegram.org/bot${botToken}/sendMessage`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: prefix + parts[i],
        disable_web_page_preview: true,
      }),
    });
  }
  return true;
}

(async () => {
  const args = readArgs();
  const opts = {
    tgBotToken: args.tg_bot_token || '',
    tgChatId: args.tg_chat_id || '',
    includeHeaders: boolArg(args.include_headers, false),
    maskSensitive: boolArg(args.mask_sensitive, true),
    maxBodyChars: intArg(args.max_body_chars, DEFAULT_BODY_LIMIT),
  };

  const request = getRequest();
  const response = getResponse();

  try {
    if (!response) {
      saveRequest(request, opts);
      return $.done();
    }

    const requestInfo = takeRequest(request, opts);
    const responseInfo = {
      status: statusOf(response),
      headers: opts.includeHeaders ? sanitizeHeaders(response.headers || {}, opts.maskSensitive) : undefined,
      body: formatBody(response.body, response.headers || {}, opts.maskSensitive, opts.maxBodyChars),
    };

    const sent = await sendTG(opts.tgBotToken, opts.tgChatId, buildMessage(requestInfo, responseInfo, opts));
    if (!sent) {
      $.notify('Hikiot Capture', 'Telegram参数未配置', '请在插件参数填写 tg_bot_token 和 tg_chat_id');
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    $.notify('Hikiot Capture', '发送失败', message);
  }

  $.done();
})();
