/**
 * 水弹签到参数自动抓取 -> 青龙环境变量更新 (ProxyPin)
 *
 * ProxyPin 配置建议:
 * - URL: https://mag1.sdgun.net/mag/addon/v1/sign/
 * - signView 使用 Response，并开启响应体
 * - signReward 使用 Request，用来从 URL 兜底获取 uid
 * - 域名过滤/MITM: mag1.sdgun.net
 *
 * ProxyPin 没有 Loon 的插件参数面板，请在下方 shuidanProxyPinConfig 中填写配置。
 *
 * 环境变量 SDGUN 格式:
 * 账号描述#uid#完整cookie字符串#完整User-Agent
 */

var shuidanProxyPinConfig = {
    qlUrl: '',
    qlClientId: '',
    qlClientSecret: '',

    telegramEnabled: true,
    tgBotToken: '',
    tgChatId: '',

    envName: 'SDGUN',
    cronSearchValue: 'shuidan_sign',
    latestCaptureFile: 'shuidan_token_latest.json',
    uidMapFile: 'shuidan_uid_by_cookie.json',
    debugModifyBody: false,
};

var shuidanProxyPinTag = '[ShuidanToken]';
var shuidanProxyPinUidSessionKey = 'shuidan_uid_by_cookie';
var shuidanCookieName = '3df5d0fc98d8c119af2e389a3f45b5b0';

async function onRequest(context, request) {
    if (!isSignRewardRequest(request)) {
        return request;
    }

    try {
        const result = await handleShuidanCapture(context, request, null, 'signReward');
        log(result || 'signReward handled');
    } catch (error) {
        const message = errorMessage(error);
        log('处理水弹 signReward 请求异常: ' + message);
        await sendTelegram('<b>水弹签到参数</b>\n处理 signReward 请求异常: ' + escapeHtml(message));
    }

    return request;
}

async function onResponse(context, request, response) {
    if (!isSignViewRequest(request)) {
        return response;
    }

    try {
        const result = await handleShuidanCapture(context, request, response, 'signView');
        setDebugMarker(response, 'ok', result || 'handled');
    } catch (error) {
        const message = errorMessage(error);
        log('处理水弹 signView 响应异常: ' + message);
        setDebugMarker(response, 'error', message);
        await sendTelegram('<b>水弹签到参数</b>\n处理 signView 响应异常: ' + escapeHtml(message));
    }

    return response;
}

async function handleShuidanCapture(context, request, response, source) {
    const capture = buildCapture(request, response, source);

    if (!capture.cookie || !capture.ua) {
        return '缺少 Cookie 或 User-Agent，跳过';
    }

    if (!capture.uid && capture.cookieValue) {
        capture.uid = await readStoredUid(context, capture.cookieValue);
    }

    if (!capture.uid) {
        const message = '已抓到 Cookie 和 UA，但未识别到 uid。可以点一次签到按钮，让 signReward 请求补齐 uid。';
        log(message);
        await sendTelegram('<b>水弹签到参数</b>\n' + escapeHtml(message));
        return message;
    }

    if (capture.cookieValue) {
        await writeStoredUid(context, capture.cookieValue, capture.uid);
    }

    await saveLatestCapture(capture);

    const qlResult = await syncQingLong(context, capture);
    const message = qlResult.name + ': ' + qlResult.message;
    log('抓取成功: ' + message);

    await sendTelegram(
        '<b>水弹签到参数</b>: ' + escapeHtml(qlResult.name) +
        '\n' + escapeHtml(qlResult.message) +
        '\nuid: <code>' + escapeHtml(capture.uid) + '</code>' +
        '\n来源: <code>' + escapeHtml(capture.source) + '</code>' +
        '\nCookie: <code>' + escapeHtml(maskCookie(capture.cookie)) + '</code>'
    );

    return message;
}

function buildCapture(request, response, source) {
    request = request || {};
    response = response || null;

    const headers = request.headers || {};
    const url = request.url || '';
    const body = response && response.body ? String(response.body) : '';
    const cookie = normalizeCookie(getHeader(headers, 'cookie'));
    const ua = getHeader(headers, 'user-agent');
    const uid = extractUid(url, body);

    return {
        uid: uid,
        cookie: cookie,
        ua: ua,
        cookieValue: getCookieValue(cookie, shuidanCookieName),
        source: source || (response ? 'signView' : 'signReward'),
    };
}

async function syncQingLong(context, capture) {
    const qlUrl = trimTrailingSlash(shuidanProxyPinConfig.qlUrl);
    const clientId = shuidanProxyPinConfig.qlClientId;
    const clientSecret = shuidanProxyPinConfig.qlClientSecret;

    if (!qlUrl || !clientId || !clientSecret) {
        return {
            name: defaultName(capture.uid),
            message: '青龙参数未填写，已抓到参数但未更新',
        };
    }

    log('开始请求青龙 token');
    const loginUrl = qlUrl +
        '/open/auth/token?client_id=' + encodeURIComponent(clientId) +
        '&client_secret=' + encodeURIComponent(clientSecret);
    const loginData = await fetchJson(loginUrl);
    if (loginData.code !== 200 || !loginData.data || !loginData.data.token) {
        throw new Error(loginData.message || '青龙登录失败');
    }

    const authHeaders = {
        Authorization: 'Bearer ' + loginData.data.token,
        'Content-Type': 'application/json',
    };

    const updateResult = await upsertQingLongEnv(qlUrl, authHeaders, capture);
    let message = updateResult.message;

    if (updateResult.changed) {
        const runResult = await runQingLongCron(qlUrl, authHeaders);
        if (runResult) {
            message += '\n' + runResult;
        }
    }

    return {
        name: updateResult.name,
        message: message,
    };
}

async function upsertQingLongEnv(qlUrl, authHeaders, capture) {
    const envName = shuidanProxyPinConfig.envName;
    const envUrl = qlUrl + '/open/envs?searchValue=' + encodeURIComponent(envName);
    log('开始查询青龙环境变量: ' + envName);
    const envData = await fetchJson(envUrl, { headers: authHeaders });
    const envList = toList(envData.data);
    const targetEnv = find(envList, function (env) {
        return env && env.name === envName;
    });
    const oldLines = targetEnv ? splitEnvValue(targetEnv.value) : [];
    const entries = oldLines.map(parseEnvEntry);
    const matchedEntry = findMatchingEntry(entries, capture);
    const accountName = matchedEntry && matchedEntry.name ? matchedEntry.name : defaultName(capture.uid);
    const newEntry = buildEnvEntry(accountName, capture);

    if (!targetEnv) {
        log('开始创建青龙环境变量: ' + envName);
        await fetchJson(qlUrl + '/open/envs', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify([{ name: envName, value: newEntry }]),
        });
        return {
            name: accountName,
            changed: true,
            message: '青龙 ' + envName + ' 环境变量已创建',
        };
    }

    const lines = oldLines.slice();
    let found = false;
    let unchanged = false;

    if (matchedEntry) {
        found = true;
        if (matchedEntry.raw === newEntry) {
            unchanged = true;
        } else {
            lines[matchedEntry.index] = newEntry;
        }
    }

    if (unchanged) {
        return {
            name: accountName,
            changed: false,
            message: '参数未变化，跳过更新',
        };
    }

    if (!found) {
        lines.push(newEntry);
    }

    const envId = targetEnv.id || targetEnv._id;
    if (!envId) {
        throw new Error('青龙环境变量缺少 id，无法更新');
    }

    log('开始更新青龙环境变量: ' + envName);
    await fetchJson(qlUrl + '/open/envs', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
            name: envName,
            value: lines.join('\n'),
            id: envId,
        }),
    });

    return {
        name: accountName,
        changed: true,
        message: found ? '青龙参数已替换' : '青龙已追加新账号',
    };
}

async function runQingLongCron(qlUrl, authHeaders) {
    const searchValue = shuidanProxyPinConfig.cronSearchValue;
    if (!searchValue) {
        return '';
    }

    try {
        const cronUrl = qlUrl + '/open/crons?searchValue=' + encodeURIComponent(searchValue);
        const cronData = await fetchJson(cronUrl, { headers: authHeaders });
        const cronList = toList(cronData.data);
        const task = find(cronList, function (cron) {
            const command = cron && cron.command ? cron.command : '';
            const name = cron && cron.name ? cron.name : '';
            return command.indexOf(searchValue) !== -1 || name.indexOf(searchValue) !== -1;
        });

        if (!task) {
            return '未找到签到任务: ' + searchValue;
        }

        const taskId = task.id || task._id;
        if (!taskId) {
            return '找到签到任务但缺少 id，未触发';
        }

        log('开始触发青龙任务: ' + searchValue);
        await fetchJson(qlUrl + '/open/crons/run', {
            method: 'PUT',
            headers: authHeaders,
            body: JSON.stringify([taskId]),
        });
        return '签到任务已触发';
    } catch (error) {
        return '触发签到失败: ' + errorMessage(error);
    }
}

async function saveLatestCapture(capture) {
    if (typeof File === 'undefined' || !shuidanProxyPinConfig.latestCaptureFile) {
        return;
    }

    try {
        const record = {
            uid: capture.uid,
            cookie: capture.cookie,
            ua: capture.ua,
            cookieValue: capture.cookieValue,
            source: capture.source,
            updatedAt: new Date().toISOString(),
        };
        await File(shuidanProxyPinConfig.latestCaptureFile).writeAsString(JSON.stringify(record));
    } catch (error) {
        log('保存最新参数失败: ' + errorMessage(error));
    }
}

async function readStoredUid(context, cookieValue) {
    const map = await readUidMap(context);
    return map[cookieValue] || '';
}

async function writeStoredUid(context, cookieValue, uid) {
    if (!cookieValue || !uid) {
        return;
    }

    const map = await readUidMap(context);
    if (map[cookieValue] === uid) {
        return;
    }

    map[cookieValue] = uid;
    await saveUidMap(context, map);
}

async function readUidMap(context) {
    let map = null;

    if (typeof File !== 'undefined' && shuidanProxyPinConfig.uidMapFile) {
        try {
            const file = File(shuidanProxyPinConfig.uidMapFile);
            if (await file.exists()) {
                map = parseJson(await file.readAsString(), '');
            }
        } catch (error) {
            log('读取 uid 缓存失败: ' + errorMessage(error));
        }
    }

    if (!map && context && context.session) {
        map = context.session[shuidanProxyPinUidSessionKey];
    }

    if (!map || typeof map !== 'object' || isArray(map)) {
        return {};
    }

    return map;
}

async function saveUidMap(context, map) {
    if (context && context.session) {
        context.session[shuidanProxyPinUidSessionKey] = map;
    }

    if (typeof File === 'undefined' || !shuidanProxyPinConfig.uidMapFile) {
        return;
    }

    try {
        await File(shuidanProxyPinConfig.uidMapFile).writeAsString(JSON.stringify(map));
    } catch (error) {
        log('写入 uid 缓存失败: ' + errorMessage(error));
    }
}

async function fetchJson(url, options) {
    const requestOptions = options || {};
    if (!requestOptions.method) {
        requestOptions.method = 'GET';
    }

    const response = await fetch(url, requestOptions);
    const text = await response.text();
    const data = parseJson(text, '接口响应不是 JSON: ' + shortText(text));
    return data;
}

async function sendTelegram(text) {
    if (!shuidanProxyPinConfig.telegramEnabled || !shuidanProxyPinConfig.tgBotToken || !shuidanProxyPinConfig.tgChatId) {
        log('Telegram 未启用或未配置，跳过');
        return 'Telegram 未启用或未配置';
    }

    try {
        const response = await fetch('https://api.telegram.org/bot' + shuidanProxyPinConfig.tgBotToken + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: shuidanProxyPinConfig.tgChatId,
                text: text,
                parse_mode: 'HTML',
            }),
        });
        const responseText = await response.text();
        const data = parseJson(responseText, '');
        if (data && data.ok === false) {
            const description = data.description || 'unknown error';
            log('Telegram 通知发送失败: ' + description);
            return 'Telegram 发送失败: ' + description;
        }
        log('Telegram 通知已发送');
        return 'Telegram 已发送';
    } catch (error) {
        log('Telegram 通知发送失败: ' + errorMessage(error));
        return 'Telegram 发送失败: ' + errorMessage(error);
    }
}

function isSignViewRequest(request) {
    if (!request) {
        return false;
    }

    const host = request.host || getUrlHost(request.url);
    const path = request.path || getUrlPath(request.url);
    const url = request.url || '';

    if (host === 'mag1.sdgun.net' && path.indexOf('/mag/addon/v1/sign/signView') !== -1) {
        return true;
    }

    return /^https:\/\/mag1\.sdgun\.net\/mag\/addon\/v1\/sign\/signView\?/.test(url);
}

function isSignRewardRequest(request) {
    if (!request) {
        return false;
    }

    const host = request.host || getUrlHost(request.url);
    const path = request.path || getUrlPath(request.url);
    const url = request.url || '';

    if (host === 'mag1.sdgun.net' && path.indexOf('/mag/addon/v1/sign/signReward') !== -1) {
        return true;
    }

    return /^https:\/\/mag1\.sdgun\.net\/mag\/addon\/v1\/sign\/signReward\?uid=/.test(url);
}

function extractUid(url, body) {
    const combined = normalizeBodyText(String(url || '') + '\n' + String(body || ''));
    const patterns = [
        /[?&]uid=(\d{3,})/i,
        /signReward[^"'<>]*[?&]uid=(\d{3,})/i,
        /["']uid["']\s*[:=]\s*["']?(\d{3,})/i,
        /\buid\s*[:=]\s*["']?(\d{3,})/i,
        /data-uid=["'](\d{3,})["']/i,
    ];

    for (let i = 0; i < patterns.length; i++) {
        const match = combined.match(patterns[i]);
        if (match && match[1]) {
            return match[1];
        }
    }

    return '';
}

function normalizeBodyText(text) {
    return String(text || '')
        .replace(/\\u0026/g, '&')
        .replace(/&amp;/g, '&')
        .replace(/%3F/ig, '?')
        .replace(/%26/ig, '&')
        .replace(/%3D/ig, '=');
}

function normalizeCookie(cookie) {
    cookie = String(cookie || '').trim();
    if (!cookie) {
        return '';
    }

    const pairs = cookie.split(';').map(function (item) {
        return item.trim();
    }).filter(function (item) {
        return !!item;
    });
    const picked = [];
    const wanted = [shuidanCookieName, 'PHPSESSID'];

    for (let i = 0; i < wanted.length; i++) {
        const key = wanted[i];
        const pair = find(pairs, function (item) {
            return item.indexOf(key + '=') === 0;
        });
        if (pair) {
            picked.push(pair);
        }
    }

    return picked.length ? picked.join('; ') : cookie;
}

function getCookieValue(cookie, key) {
    const pairs = String(cookie || '').split(';');
    for (let i = 0; i < pairs.length; i++) {
        const part = pairs[i].trim();
        const idx = part.indexOf('=');
        if (idx === -1) {
            continue;
        }
        if (part.substring(0, idx).trim() === key) {
            return part.substring(idx + 1).trim();
        }
    }
    return '';
}

function parseEnvEntry(line, index) {
    const raw = String(line || '').trim();
    const first = raw.indexOf('#');
    const second = first === -1 ? -1 : raw.indexOf('#', first + 1);
    const third = second === -1 ? -1 : raw.indexOf('#', second + 1);

    if (first === -1 || second === -1) {
        return {
            raw: raw,
            index: index,
            name: '',
            uid: '',
            cookie: '',
            ua: '',
            cookieValue: '',
        };
    }

    const cookie = third === -1 ? raw.substring(second + 1) : raw.substring(second + 1, third);
    return {
        raw: raw,
        index: index,
        name: raw.substring(0, first),
        uid: raw.substring(first + 1, second),
        cookie: cookie,
        ua: third === -1 ? '' : raw.substring(third + 1),
        cookieValue: getCookieValue(cookie, shuidanCookieName),
    };
}

function findMatchingEntry(entries, capture) {
    if (capture.uid) {
        const byUid = find(entries, function (entry) {
            return entry.uid === capture.uid;
        });
        if (byUid) {
            return byUid;
        }
    }

    if (capture.cookieValue) {
        const byCookie = find(entries, function (entry) {
            return entry.cookieValue === capture.cookieValue;
        });
        if (byCookie) {
            return byCookie;
        }
    }

    return null;
}

function buildEnvEntry(name, capture) {
    return name + '#' + capture.uid + '#' + capture.cookie + '#' + capture.ua;
}

function splitEnvValue(value) {
    return String(value || '')
        .split(/\n|@/)
        .map(function (line) {
            return line.trim();
        })
        .filter(function (line) {
            return !!line;
        });
}

function setDebugMarker(response, status, message) {
    if (!response) {
        return;
    }

    if (!response.headers) {
        response.headers = {};
    }

    response.headers['X-Shuidan-ProxyPin'] = asciiHeaderValue(status);
    response.headers['X-Shuidan-ProxyPin-Message'] = asciiHeaderValue(message);

    if (!shuidanProxyPinConfig.debugModifyBody || !response.body) {
        return;
    }

    try {
        response.body = String(response.body) +
            '\n<!-- proxyPinShuidanDebug: ' + asciiHeaderValue(status + ' ' + String(message || '')) + ' -->';
    } catch (error) {
        log('写入响应体调试字段失败: ' + errorMessage(error));
    }
}

function getHeader(headers, name) {
    const target = String(name || '').toLowerCase();
    const keys = Object.keys(headers || {});
    for (let i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === target) {
            return String(headers[keys[i]] || '');
        }
    }
    return '';
}

function getUrlHost(url) {
    const match = String(url || '').match(/^https?:\/\/([^/]+)/i);
    return match ? match[1] : '';
}

function getUrlPath(url) {
    const match = String(url || '').match(/^https?:\/\/[^/]+([^?#]*)/i);
    return match ? match[1] : '';
}

function toList(data) {
    if (isArray(data)) {
        return data;
    }
    if (data && isArray(data.data)) {
        return data.data;
    }
    if (data && data.data && isArray(data.data.data)) {
        return data.data.data;
    }
    return [];
}

function find(list, predicate) {
    for (let i = 0; i < list.length; i++) {
        if (predicate(list[i], i)) {
            return list[i];
        }
    }
    return null;
}

function parseJson(text, errorPrefix) {
    try {
        return JSON.parse(text);
    } catch (error) {
        if (!errorPrefix) {
            return null;
        }
        throw new Error(errorPrefix);
    }
}

function defaultName(uid) {
    return uid ? '水弹账号' + uid : '水弹账号';
}

function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function shortText(text) {
    text = String(text || '');
    return text.length > 200 ? text.slice(0, 200) + '...' : text;
}

function asciiHeaderValue(value) {
    return shortText(String(value || ''))
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/[\r\n]/g, ' ');
}

function maskCookie(cookie) {
    return String(cookie || '').split(';').map(function (part) {
        part = part.trim();
        const idx = part.indexOf('=');
        if (idx === -1) {
            return part;
        }
        const key = part.substring(0, idx);
        const value = part.substring(idx + 1);
        if (value.length <= 8) {
            return key + '=****';
        }
        return key + '=' + value.slice(0, 4) + '...' + value.slice(-4);
    }).join('; ');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
}

function log(message) {
    console.log(shuidanProxyPinTag + ' ' + message);
}
