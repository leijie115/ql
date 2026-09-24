/**
 * 萱子微商城 x-wx-token 自动抓取 → 青龙面板环境变量更新
 * 从 queryPageInfo 请求头中获取 x-wx-token
 * 环境变量 XUANZI_WEIMOB 格式: 账号#x-wx-token
 * 配合 xuanzi_weimob_token.plugin 使用
 */

const $ = {
    notify: (title, subtitle, body) => $notification.post(title, subtitle, body),
    done: (body) => $done(body ? { body } : {}),
    get: (opts) => new Promise((resolve, reject) => {
        $httpClient.get(opts, (err, resp, data) => {
            if (err) reject(err);
            else resolve({ status: resp.status, body: data });
        });
    }),
    put: (opts) => new Promise((resolve, reject) => {
        $httpClient.put(opts, (err, resp, data) => {
            if (err) reject(err);
            else resolve({ status: resp.status, body: data });
        });
    }),
    post: (opts) => new Promise((resolve, reject) => {
        $httpClient.post(opts, (err, resp, data) => {
            if (err) reject(err);
            else resolve({ status: resp.status, body: data });
        });
    }),
};

function sendTG(botToken, chatId, text) {
    if (!botToken || !chatId) return Promise.resolve();
    return $.get({
        url: `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML`,
    }).catch(() => {});
}

// Bark 推送: barkKey 支持多设备, 用 , 换行 或 @ 分隔多个 key/完整URL
function sendBark(barkKey, title, body) {
    if (!barkKey) return Promise.resolve();
    const keys = barkKey.split(/[,\n@]/).map((s) => s.trim()).filter(Boolean);
    return Promise.all(keys.map((k) => {
        const base = /^https?:\/\//.test(k) ? k.replace(/\/+$/, '') : `https://api.day.app/${k}`;
        const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('萱子')}`;
        return $.get({ url }).catch(() => {});
    }));
}

// 同时推送 TG 和 Bark, 配了哪个发哪个
function notifyAll(tgBotToken, tgChatId, barkKey, title, tgText, barkBody) {
    return Promise.all([
        sendTG(tgBotToken, tgChatId, tgText),
        sendBark(barkKey, title, barkBody),
    ]);
}

// 请求头大小写不敏感取值
function getHeader(headers, key) {
    if (!headers) return '';
    const lk = key.toLowerCase();
    for (const k in headers) {
        if (k.toLowerCase() === lk) return headers[k];
    }
    return '';
}

(async () => {
    const tgBotToken = $argument.tg_bot_token || '';
    const tgChatId = $argument.tg_chat_id || '';
    const barkKey = $argument.bark_key || '';

    try {
        const token = getHeader($request.headers, 'x-wx-token');
        if (!token) return $.done();

        const name = $argument.account_name || '萱子';
        const newEntry = `${name}#${token}`;

        const qlUrl = $argument.ql_url || '';
        const clientId = $argument.ql_client_id || '';
        const clientSecret = $argument.ql_client_secret || '';
        const cronSearch = $argument.cron_search || '';

        // 按 token 值去重: 同一 token 当天只同步一次
        let syncRecord = {};
        try { syncRecord = JSON.parse($persistentStore.read('xuanzi_weimob_synced') || '{}'); } catch {}
        if (syncRecord.token === token) {
            return $.done();
        }

        let qlResult = '';
        if (!qlUrl || !clientId || !clientSecret) {
            qlResult = '青龙参数未填写，跳过更新';
        } else {
            try {
                const loginResp = await $.get({
                    url: `${qlUrl}/open/auth/token?client_id=${clientId}&client_secret=${clientSecret}`,
                });
                const loginData = JSON.parse(loginResp.body);
                if (loginData.code !== 200) {
                    throw new Error(loginData.message || '青龙登录失败');
                }
                const qlToken = loginData.data.token;
                const authHeaders = { 'Authorization': `Bearer ${qlToken}`, 'Content-Type': 'application/json' };

                const envResp = await $.get({
                    url: `${qlUrl}/open/envs?searchValue=XUANZI_WEIMOB`,
                    headers: authHeaders,
                });
                const envData = JSON.parse(envResp.body);
                const envList = envData.data || [];
                const targetEnv = (envList || []).find(e => e.name === 'XUANZI_WEIMOB');
                let unchanged = false;

                if (targetEnv) {
                    const lines = (targetEnv.value || '').split('\n').filter(Boolean);
                    let found = false;
                    for (let i = 0; i < lines.length; i++) {
                        const hashIdx = lines[i].indexOf('#');
                        const lineName = hashIdx > -1 ? lines[i].substring(0, hashIdx) : lines[i];
                        if (lineName === name) {
                            if (lines[i] === newEntry) {
                                unchanged = true;
                            } else {
                                lines[i] = newEntry;
                            }
                            found = true;
                            break;
                        }
                    }

                    if (unchanged) {
                        qlResult = 'token未变化，跳过更新 ⏭️';
                    } else {
                        if (!found) lines.push(newEntry);
                        await $.put({
                            url: `${qlUrl}/open/envs`,
                            headers: authHeaders,
                            body: JSON.stringify({ name: 'XUANZI_WEIMOB', value: lines.join('\n'), id: targetEnv.id }),
                        });
                        qlResult = found ? '青龙token已替换 ✅' : '青龙已追加新账号 ✅';
                    }
                } else {
                    await $.post({
                        url: `${qlUrl}/open/envs`,
                        headers: authHeaders,
                        body: JSON.stringify([{ name: 'XUANZI_WEIMOB', value: newEntry }]),
                    });
                    qlResult = '青龙 XUANZI_WEIMOB 环境变量已创建 ✅';
                }

                // token 有变化时触发监控任务
                if (!unchanged && cronSearch) {
                    try {
                        const cronResp = await $.get({
                            url: `${qlUrl}/open/crons?searchValue=${encodeURIComponent(cronSearch)}`,
                            headers: authHeaders,
                        });
                        const cronData = JSON.parse(cronResp.body);
                        const cronList = (cronData.data && cronData.data.data) || cronData.data || [];
                        const task = cronList.find(c => c.command && c.command.indexOf(cronSearch) > -1);
                        if (task) {
                            await $.put({
                                url: `${qlUrl}/open/crons/run`,
                                headers: authHeaders,
                                body: JSON.stringify([task.id]),
                            });
                            qlResult += '\n监控任务已触发 🚀';
                        }
                    } catch (runErr) {
                        qlResult += `\n触发任务失败: ${runErr.message || runErr}`;
                    }
                }

                // 记录本次已同步的 token
                $persistentStore.write(JSON.stringify({ token }), 'xuanzi_weimob_synced');
            } catch (qlErr) {
                qlResult = `青龙更新失败: ${qlErr.message || qlErr}`;
            }
        }

        $.notify('萱子微商城Token', `${name} 抓取成功`, qlResult);
        await notifyAll(tgBotToken, tgChatId, barkKey, '萱子微商城Token',
            `萱子微商城Token: ${name}\n${qlResult}\n\nx-wx-token👇\n<pre>${token}</pre>`,
            `${name}\n${qlResult}\n\n${token}`);
    } catch (e) {
        $.notify('萱子微商城Token', '脚本异常 ❌', e.message || e);
        await notifyAll(tgBotToken, tgChatId, barkKey, '萱子微商城Token',
            `萱子微商城Token 脚本异常: ${e.message || e}`,
            `脚本异常: ${e.message || e}`);
    }

    $.done();
})();
