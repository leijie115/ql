/**
 * 麓豆 Token 自动抓取 -> 青龙环境变量更新 (ProxyPin)
 *
 * ProxyPin 配置建议:
 * - 类型: Response
 * - URL: https://luhu-beta1-web.crm.luxelakes.com//v1/user/userInfo
 * - 需要响应体: 开启
 * - 域名过滤/MITM: luhu-beta1-web.crm.luxelakes.com
 *
 * ProxyPin 没有 Loon 的插件参数面板，请在下方 ludouProxyPinConfig 中填写配置。
 */

var ludouProxyPinConfig = {
    qlUrl: '',
    qlClientId: '',
    qlClientSecret: '',

    telegramEnabled: true,
    tgBotToken: '',
    tgChatId: '',

    envName: 'LUDOU',
    cronSearchValue: 'ludou_sign',
    latestTokenFile: 'ludou_token_latest.json',
    syncRecordFile: 'ludou_ql_synced.json',
    skipSameDayAccount: true,
    debugModifyBody: false,
};

var ludouProxyPinTag = '[LudouToken]';
var ludouProxyPinSyncSessionKey = 'ludou_ql_synced';

async function onRequest(context, request) {
    return request;
}

async function onResponse(context, request, response) {
    if (!isLudouUserInfoRequest(request)) {
        return response;
    }

    try {
        const result = await handleLudouResponse(context, response);
        setDebugMarker(response, 'ok', result || 'handled');
    } catch (error) {
        const message = errorMessage(error);
        log('处理麓豆响应异常: ' + message);
        setDebugMarker(response, 'error', message);
        await sendTelegram('<b>麓豆Token</b>\n处理麓豆响应异常: ' + escapeHtml(message));
    }

    return response;
}

async function handleLudouResponse(context, response) {
    if (!response || !response.body) {
        log('响应体为空，跳过');
        return '响应体为空';
    }

    const body = parseJson(response.body, '麓豆 userInfo 响应不是 JSON');
    if (body.code !== 200 || !body.data || !body.data.token) {
        log('未发现有效 token，跳过');
        return '未发现有效 token';
    }

    const token = body.data.token;
    const name = body.data.nickName || body.data.mobile || body.data.userId || '麓豆账号';
    log(name + ' 已抓到 token，开始同步青龙');
    await saveLatestToken(name, token);

    const qlResult = await syncQingLong(context, name, token);

    log(name + ' 抓取成功: ' + qlResult);
    const tgResult = await sendTelegram(
        '<b>麓豆Token</b>: ' + escapeHtml(String(name)) +
        '\n' + escapeHtml(qlResult) +
        '\n\nToken:\n<pre>' + escapeHtml(token) + '</pre>'
    );
    return name + ': ' + qlResult + '\n' + tgResult;
}

async function saveLatestToken(name, token) {
    if (typeof File === 'undefined' || !ludouProxyPinConfig.latestTokenFile) {
        return;
    }

    try {
        const record = {
            name: name,
            token: token,
            updatedAt: new Date().toISOString(),
        };
        await File(ludouProxyPinConfig.latestTokenFile).writeAsString(JSON.stringify(record));
    } catch (error) {
        log('保存最新 token 失败: ' + errorMessage(error));
    }
}

async function syncQingLong(context, name, token) {
    const qlUrl = trimTrailingSlash(ludouProxyPinConfig.qlUrl);
    const clientId = ludouProxyPinConfig.qlClientId;
    const clientSecret = ludouProxyPinConfig.qlClientSecret;

    const syncRecord = await loadSyncRecord(context);
    if (
        ludouProxyPinConfig.skipSameDayAccount &&
        syncRecord.accounts.indexOf(name) !== -1
    ) {
        return '今日已同步过青龙，跳过';
    }

    if (!qlUrl || !clientId || !clientSecret) {
        return '青龙参数未填写，跳过更新';
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

    const updateResult = await upsertQingLongEnv(
        qlUrl,
        authHeaders,
        name,
        token
    );

    let message = updateResult.message;
    if (updateResult.changed) {
        const runResult = await runQingLongCron(qlUrl, authHeaders);
        if (runResult) {
            message += '\n' + runResult;
        }
    }

    if (syncRecord.accounts.indexOf(name) === -1) {
        syncRecord.accounts.push(name);
        await saveSyncRecord(context, syncRecord);
    }

    return message;
}

async function upsertQingLongEnv(qlUrl, authHeaders, name, token) {
    const envName = ludouProxyPinConfig.envName;
    const envUrl = qlUrl + '/open/envs?searchValue=' + encodeURIComponent(envName);
    log('开始查询青龙环境变量: ' + envName);
    const envData = await fetchJson(envUrl, { headers: authHeaders });
    const envList = toList(envData.data);
    const targetEnv = find(envList, function (env) {
        return env && env.name === envName;
    });
    const newEntry = name + '#' + token;

    if (!targetEnv) {
        log('开始创建青龙环境变量: ' + envName);
        await fetchJson(qlUrl + '/open/envs', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify([{ name: envName, value: newEntry }]),
        });
        return {
            changed: true,
            message: '青龙 ' + envName + ' 环境变量已创建',
        };
    }

    const lines = splitEnvValue(targetEnv.value);
    let found = false;
    let unchanged = false;

    for (let i = 0; i < lines.length; i++) {
        const separatorIndex = lines[i].indexOf('#');
        if (separatorIndex === -1) {
            continue;
        }

        const currentName = lines[i].substring(0, separatorIndex);
        if (currentName !== name) {
            continue;
        }

        found = true;
        if (lines[i] === newEntry) {
            unchanged = true;
        } else {
            lines[i] = newEntry;
        }
        break;
    }

    if (unchanged) {
        return {
            changed: false,
            message: 'token 未变化，跳过更新',
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
        changed: true,
        message: found ? '青龙 token 已替换' : '青龙已追加新账号',
    };
}

async function runQingLongCron(qlUrl, authHeaders) {
    const searchValue = ludouProxyPinConfig.cronSearchValue;
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

async function loadSyncRecord(context) {
    const today = chinaDateString();
    const fallback = { date: today, accounts: [] };
    let record = null;

    if (typeof File !== 'undefined') {
        try {
            const file = File(ludouProxyPinConfig.syncRecordFile);
            if (await file.exists()) {
                record = parseJson(await file.readAsString(), '');
            }
        } catch (error) {
            log('读取同步记录失败: ' + errorMessage(error));
        }
    }

    if (!record && context && context.session) {
        record = context.session[ludouProxyPinSyncSessionKey];
    }

    if (!record || record.date !== today || !isArray(record.accounts)) {
        return fallback;
    }

    return record;
}

async function saveSyncRecord(context, record) {
    if (context && context.session) {
        context.session[ludouProxyPinSyncSessionKey] = record;
    }

    if (typeof File === 'undefined') {
        return;
    }

    try {
        await File(ludouProxyPinConfig.syncRecordFile).writeAsString(JSON.stringify(record));
    } catch (error) {
        log('写入同步记录失败: ' + errorMessage(error));
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
    if (!ludouProxyPinConfig.telegramEnabled || !ludouProxyPinConfig.tgBotToken || !ludouProxyPinConfig.tgChatId) {
        log('Telegram 未启用或未配置，跳过');
        return 'Telegram 未启用或未配置';
    }

    try {
        const response = await fetch('https://api.telegram.org/bot' + ludouProxyPinConfig.tgBotToken + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ludouProxyPinConfig.tgChatId,
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

function setDebugMarker(response, status, message) {
    if (!response) {
        return;
    }

    if (!response.headers) {
        response.headers = {};
    }

    const safeStatus = asciiHeaderValue(status);
    const safeMessage = asciiHeaderValue(message);
    response.headers['X-Ludou-ProxyPin'] = safeStatus;
    response.headers['X-Ludou-ProxyPin-Message'] = safeMessage;

    if (!ludouProxyPinConfig.debugModifyBody || !response.body) {
        return;
    }

    try {
        const body = JSON.parse(response.body);
        body.proxyPinLudouDebug = {
            status: status,
            message: String(message || ''),
            time: new Date().toISOString(),
        };
        response.body = JSON.stringify(body);
    } catch (error) {
        log('写入响应体调试字段失败: ' + errorMessage(error));
    }
}

function isLudouUserInfoRequest(request) {
    if (!request) {
        return false;
    }

    const host = request.host || '';
    const path = request.path || '';
    const url = request.url || '';

    if (host === 'luhu-beta1-web.crm.luxelakes.com' && path.indexOf('/v1/user/userInfo') !== -1) {
        return true;
    }

    return /^https:\/\/luhu-beta1-web\.crm\.luxelakes\.com\/{1,2}v1\/user\/userInfo/.test(url);
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
        if (predicate(list[i])) {
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

function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function chinaDateString() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    console.log(ludouProxyPinTag + ' ' + message);
}
