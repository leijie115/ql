/**
 * 萱子签到参数自动抓取 → 青龙面板环境变量更新
 * 从 get-member-sign-info.json 请求 URL 中提取身份参数
 * 环境变量 XUANZI 格式: 账号#memberId&enterpriseId&unionid&openid&wxOpenid
 * 多账号按 memberId 去重 / 更新
 * 配合 xuanzi_token.plugin 使用
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

// Bark 推送: barkKey 可为设备key, 也可为完整URL(自建服务)
function sendBark(barkKey, title, body) {
    if (!barkKey) return Promise.resolve();
    const base = /^https?:\/\//.test(barkKey) ? barkKey.replace(/\/+$/, '') : `https://api.day.app/${barkKey}`;
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('萱子')}`;
    return $.get({ url }).catch(() => {});
}

// 同时推送 TG 和 Bark, 配了哪个发哪个
function notifyAll(tgBotToken, tgChatId, barkKey, title, tgText, barkBody) {
    return Promise.all([
        sendTG(tgBotToken, tgChatId, tgText),
        sendBark(barkKey, title, barkBody),
    ]);
}

function getQuery(url, key) {
    const m = url.match(new RegExp('[?&]' + key + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : '';
}

(async () => {
    const tgBotToken = $argument.tg_bot_token || '';
    const tgChatId = $argument.tg_chat_id || '';
    const barkKey = $argument.bark_key || '';

    try {
        const url = $request.url;

        const memberId = getQuery(url, 'memberId');
        const enterpriseId = getQuery(url, 'enterpriseId');
        const unionid = getQuery(url, 'unionid');
        const openid = getQuery(url, 'openid');
        const wxOpenid = getQuery(url, 'wxOpenid');

        // 签到页会先发一次 memberId=-1 的占位请求(用户信息未加载完), 必须跳过,
        // 只有拿到真实 memberId 时才抓取, 避免写入无效数据
        if (!memberId || memberId === '-1' || !enterpriseId || !unionid || !openid || !wxOpenid) {
            return $.done();
        }

        const name = $argument.account_name || `萱子_${memberId.slice(-6)}`;
        const newEntry = `${name}#${memberId}&${enterpriseId}&${unionid}&${openid}&${wxOpenid}`;

        // 从插件 [Argument] 读取配置
        const qlUrl = $argument.ql_url || '';
        const clientId = $argument.ql_client_id || '';
        const clientSecret = $argument.ql_client_secret || '';
        const cronSearch = $argument.cron_search || '';

        // 检查今天是否已同步过青龙 (按 memberId 去重)
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        let syncRecord = {};
        try { syncRecord = JSON.parse($persistentStore.read('xuanzi_ql_synced') || '{}'); } catch {}
        if (syncRecord.date !== todayStr) syncRecord = { date: todayStr, accounts: [] };
        const alreadySynced = syncRecord.accounts.includes(memberId);

        let qlResult = '';
        if (alreadySynced) {
            qlResult = '今日已同步过青龙，跳过 ⏭️';
        } else if (!qlUrl || !clientId || !clientSecret) {
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
                    url: `${qlUrl}/open/envs?searchValue=XUANZI`,
                    headers: authHeaders,
                });
                const envData = JSON.parse(envResp.body);
                const envList = envData.data || [];
                const targetEnv = (envList || []).find(e => e.name === 'XUANZI');
                let unchanged = false;

                if (targetEnv) {
                    const lines = (targetEnv.value || '').split('\n').filter(Boolean);
                    let found = false;
                    for (let i = 0; i < lines.length; i++) {
                        // 按 memberId 匹配同一账号 (memberId 是 # 后第一个字段)
                        const hashIdx = lines[i].indexOf('#');
                        const lineMemberId = hashIdx > -1 ? lines[i].substring(hashIdx + 1).split('&')[0] : '';
                        if (lineMemberId === memberId) {
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
                        qlResult = '参数未变化，跳过更新 ⏭️';
                    } else {
                        if (!found) lines.push(newEntry);
                        await $.put({
                            url: `${qlUrl}/open/envs`,
                            headers: authHeaders,
                            body: JSON.stringify({ name: 'XUANZI', value: lines.join('\n'), id: targetEnv.id }),
                        });
                        qlResult = found ? '青龙参数已替换 ✅' : '青龙已追加新账号 ✅';
                    }
                } else {
                    await $.post({
                        url: `${qlUrl}/open/envs`,
                        headers: authHeaders,
                        body: JSON.stringify([{ name: 'XUANZI', value: newEntry }]),
                    });
                    qlResult = '青龙 XUANZI 环境变量已创建 ✅';
                }

                // 参数有变化时触发青龙签到任务
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
                            qlResult += '\n签到任务已触发 🚀';
                        }
                    } catch (runErr) {
                        qlResult += `\n触发签到失败: ${runErr.message || runErr}`;
                    }
                }

                // 记录今日已同步
                if (!syncRecord.accounts.includes(memberId)) {
                    syncRecord.accounts.push(memberId);
                    $persistentStore.write(JSON.stringify(syncRecord), 'xuanzi_ql_synced');
                }
            } catch (qlErr) {
                qlResult = `青龙更新失败: ${qlErr.message || qlErr}`;
            }
        }

        $.notify('萱子签到参数', `${name} 抓取成功`, qlResult);
        await notifyAll(tgBotToken, tgChatId, barkKey, '萱子签到参数',
            `萱子签到参数: ${name}\n${qlResult}\n\n参数👇\n<pre>${newEntry}</pre>`,
            `${name}\n${qlResult}\n\n${newEntry}`);
    } catch (e) {
        $.notify('萱子签到参数', '脚本异常 ❌', e.message || e);
        await notifyAll(tgBotToken, tgChatId, barkKey, '萱子签到参数',
            `萱子签到参数 脚本异常: ${e.message || e}`,
            `脚本异常: ${e.message || e}`);
    }

    $.done();
})();
