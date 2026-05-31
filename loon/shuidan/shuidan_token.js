/**
 * 水弹签到参数自动抓取 -> 青龙面板环境变量更新
 * 配合 shuidan_token.plugin 使用
 *
 * 环境变量 SDGUN 格式:
 * 账号描述#uid#完整cookie字符串#完整User-Agent
 */

const ENV_NAME = 'SDGUN';
const ENV_COOKIE_NAME = '3df5d0fc98d8c119af2e389a3f45b5b0';
const UID_STORE_KEY = 'shuidan_uid_by_cookie';

const $ = {
    notify: (title, subtitle, body) => $notification.post(title, subtitle, body),
    done: (value) => $done(value || {}),
    get: (opts) => new Promise((resolve, reject) => {
        $httpClient.get(opts, (err, resp, data) => {
            if (err) reject(err);
            else resolve({ status: resp && resp.status, headers: resp && resp.headers, body: data });
        });
    }),
    put: (opts) => new Promise((resolve, reject) => {
        $httpClient.put(opts, (err, resp, data) => {
            if (err) reject(err);
            else resolve({ status: resp && resp.status, headers: resp && resp.headers, body: data });
        });
    }),
    post: (opts) => new Promise((resolve, reject) => {
        $httpClient.post(opts, (err, resp, data) => {
            if (err) reject(err);
            else resolve({ status: resp && resp.status, headers: resp && resp.headers, body: data });
        });
    }),
};

(async () => {
    const tgBotToken = getArg('tg_bot_token', 4);
    const tgChatId = getArg('tg_chat_id', 5);

    try {
        const capture = buildCapture();
        if (!capture.cookie || !capture.ua) {
            return $.done();
        }

        if (!capture.uid && capture.cookieValue) {
            capture.uid = readStoredUid(capture.cookieValue);
        }

        if (!capture.uid) {
            const message = '已抓到 Cookie 和 UA，但未从签到页识别到 uid。可以点一次签到按钮，插件会从 signReward 请求补齐 uid。';
            $.notify('水弹签到参数', '缺少 uid', message);
            await sendTG(tgBotToken, tgChatId, '水弹签到参数: 缺少 uid\n' + message);
            return $.done();
        }

        if (capture.cookieValue) {
            writeStoredUid(capture.cookieValue, capture.uid);
        }

        const result = await syncQingLong(capture);
        $.notify('水弹签到参数', result.name + ' 抓取成功', result.message);
        await sendTG(
            tgBotToken,
            tgChatId,
            '水弹签到参数: ' + escapeHtml(result.name) +
                '\n' + escapeHtml(result.message) +
                '\nuid: <code>' + escapeHtml(capture.uid) + '</code>' +
                '\nCookie: <code>' + escapeHtml(maskCookie(capture.cookie)) + '</code>'
        );
    } catch (error) {
        const message = errorMessage(error);
        $.notify('水弹签到参数', '脚本异常', message);
        await sendTG(tgBotToken, tgChatId, '水弹签到参数脚本异常: ' + escapeHtml(message));
    }

    $.done();
})();

function buildCapture() {
    const request = typeof $request === 'undefined' ? {} : $request;
    const response = typeof $response === 'undefined' ? null : $response;
    const headers = request.headers || {};
    const url = request.url || '';
    const cookie = normalizeCookie(getHeader(headers, 'cookie'));
    const ua = getHeader(headers, 'user-agent');
    const body = response && response.body ? String(response.body) : '';
    const uid = extractUid(url, body);

    return {
        uid: uid,
        cookie: cookie,
        ua: ua,
        cookieValue: getCookieValue(cookie, ENV_COOKIE_NAME),
        source: response ? 'signView' : 'signReward',
    };
}

async function syncQingLong(capture) {
    const qlUrl = trimTrailingSlash(getArg('ql_url', 0));
    const clientId = getArg('ql_client_id', 1);
    const clientSecret = getArg('ql_client_secret', 2);

    if (!qlUrl || !clientId || !clientSecret) {
        return {
            name: defaultName(capture.uid),
            message: '青龙参数未填写，已抓到参数但未更新',
        };
    }

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

    const updateResult = await upsertEnv(qlUrl, authHeaders, capture);
    let message = updateResult.message;

    if (updateResult.changed) {
        const runResult = await runCron(qlUrl, authHeaders);
        if (runResult) {
            message += '\n' + runResult;
        }
    }

    return {
        name: updateResult.name,
        message: message,
    };
}

async function upsertEnv(qlUrl, authHeaders, capture) {
    const envData = await fetchJson(qlUrl + '/open/envs?searchValue=' + encodeURIComponent(ENV_NAME), {
        headers: authHeaders,
    });
    const envList = toList(envData.data);
    const targetEnv = find(envList, (env) => env && env.name === ENV_NAME);
    const oldLines = targetEnv ? splitEnvValue(targetEnv.value) : [];
    const entries = oldLines.map(parseEnvEntry);
    const match = findMatchingEntry(entries, capture);
    const name = match && match.name ? match.name : defaultName(capture.uid);
    const newEntry = buildEnvEntry(name, capture);

    if (!targetEnv) {
        await $.post({
            url: qlUrl + '/open/envs',
            headers: authHeaders,
            body: JSON.stringify([{ name: ENV_NAME, value: newEntry }]),
        });
        return {
            name: name,
            changed: true,
            message: '青龙 ' + ENV_NAME + ' 环境变量已创建',
        };
    }

    const lines = oldLines.slice();
    let unchanged = false;
    let found = false;

    if (match) {
        found = true;
        if (match.raw === newEntry) {
            unchanged = true;
        } else {
            lines[match.index] = newEntry;
        }
    }

    if (unchanged) {
        return {
            name: name,
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

    await $.put({
        url: qlUrl + '/open/envs',
        headers: authHeaders,
        body: JSON.stringify({
            name: ENV_NAME,
            value: lines.join('\n'),
            id: envId,
        }),
    });

    return {
        name: name,
        changed: true,
        message: found ? '青龙参数已替换' : '青龙已追加新账号',
    };
}

async function runCron(qlUrl, authHeaders) {
    const searchValue = getArg('cron_search', 3, 'shuidan_sign');
    if (!searchValue) {
        return '';
    }

    try {
        const cronData = await fetchJson(qlUrl + '/open/crons?searchValue=' + encodeURIComponent(searchValue), {
            headers: authHeaders,
        });
        const cronList = toList(cronData.data);
        const task = find(cronList, (cron) => {
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

        await $.put({
            url: qlUrl + '/open/crons/run',
            headers: authHeaders,
            body: JSON.stringify([taskId]),
        });
        return '签到任务已触发';
    } catch (error) {
        return '触发签到失败: ' + errorMessage(error);
    }
}

async function fetchJson(url, options) {
    const opts = options || {};
    const resp = await $.get(Object.assign({ url: url }, opts));
    const text = resp.body || '';
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error('接口响应不是 JSON: ' + shortText(text, 200));
    }
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

    const pairs = cookie.split(';').map((item) => item.trim()).filter(Boolean);
    const picked = [];
    const wanted = [ENV_COOKIE_NAME, 'PHPSESSID'];

    for (let i = 0; i < wanted.length; i++) {
        const key = wanted[i];
        const pair = find(pairs, (item) => item.indexOf(key + '=') === 0);
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
        cookieValue: getCookieValue(cookie, ENV_COOKIE_NAME),
    };
}

function findMatchingEntry(entries, capture) {
    if (capture.uid) {
        const byUid = find(entries, (entry) => entry.uid === capture.uid);
        if (byUid) {
            return byUid;
        }
    }

    if (capture.cookieValue) {
        const byCookie = find(entries, (entry) => entry.cookieValue === capture.cookieValue);
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
        .map((line) => line.trim())
        .filter(Boolean);
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

function readStoredUid(cookieValue) {
    const map = readUidMap();
    return map[cookieValue] || '';
}

function writeStoredUid(cookieValue, uid) {
    if (!cookieValue || !uid) {
        return;
    }

    const map = readUidMap();
    if (map[cookieValue] === uid) {
        return;
    }

    map[cookieValue] = uid;
    $persistentStore.write(JSON.stringify(map), UID_STORE_KEY);
}

function readUidMap() {
    try {
        return JSON.parse($persistentStore.read(UID_STORE_KEY) || '{}') || {};
    } catch (error) {
        return {};
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

function getArg(name, index, defaultValue) {
    const hasDefault = arguments.length >= 3;
    const fallback = hasDefault ? defaultValue : '';

    if (typeof $argument === 'undefined' || $argument === null) {
        return fallback;
    }

    if (typeof $argument === 'object') {
        if (Object.prototype.hasOwnProperty.call($argument, name) && $argument[name] !== undefined && $argument[name] !== null) {
            return String($argument[name]);
        }
        return fallback;
    }

    let raw = String($argument || '').trim();
    if (!raw) {
        return fallback;
    }

    if (raw[0] === '[' && raw[raw.length - 1] === ']') {
        raw = raw.slice(1, -1);
    }

    const sep = raw.indexOf('|') > -1 ? '|' : ',';
    const parts = raw.split(sep).map((part) => {
        return part.trim().replace(/^["']|["']$/g, '');
    });

    if (index < parts.length && parts[index] !== undefined) {
        return parts[index];
    }

    return fallback;
}

function defaultName(uid) {
    return uid ? '水弹账号' + uid : '水弹账号';
}

function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function shortText(text, maxLen) {
    text = String(text || '');
    const len = maxLen || 100;
    return text.length > len ? text.slice(0, len) + '...' : text;
}

function maskCookie(cookie) {
    return String(cookie || '').split(';').map((part) => {
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

function sendTG(botToken, chatId, text) {
    if (!botToken || !chatId) {
        return Promise.resolve();
    }

    return $.get({
        url: 'https://api.telegram.org/bot' + botToken +
            '/sendMessage?chat_id=' + encodeURIComponent(chatId) +
            '&text=' + encodeURIComponent(text) +
            '&parse_mode=HTML',
    }).catch(() => {});
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
