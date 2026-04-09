/**
 * 麓豆Token自动抓取 → 青龙面板环境变量更新 (Surge版)
 * 配合 ludou_token.sgmodule 使用
 * 参数通过模块 arguments 配置
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

function parseArgument(arg) {
    const result = {};
    if (!arg) return result;
    const pairs = arg.split(',');
    const keys = ['ql_url', 'ql_client_id', 'ql_client_secret', 'tg_bot_token', 'tg_chat_id'];
    keys.forEach((key, i) => {
        result[key] = (pairs[i] || '').trim();
    });
    return result;
}

function sendTG(botToken, chatId, text) {
    if (!botToken || !chatId) return Promise.resolve();
    return $.get({
        url: `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML`,
    }).catch(() => {});
}

(async () => {
    const args = parseArgument($argument);
    const tgBotToken = args.tg_bot_token || '';
    const tgChatId = args.tg_chat_id || '';

    try {
        const body = JSON.parse($response.body);

        if (body.code !== 200 || !body.data || !body.data.token) {
            return $.done();
        }

        const token = body.data.token;
        const name = body.data.nickName || '麓豆账号';

        const qlUrl = args.ql_url || '';
        const clientId = args.ql_client_id || '';
        const clientSecret = args.ql_client_secret || '';

        // 检查今天是否已同步过青龙
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        let syncRecord = {};
        try { syncRecord = JSON.parse($persistentStore.read('ludou_ql_synced') || '{}'); } catch {}
        if (syncRecord.date !== todayStr) syncRecord = { date: todayStr, accounts: [] };
        const alreadySynced = syncRecord.accounts.includes(name);

        // 更新青龙环境变量
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
                    url: `${qlUrl}/open/envs?searchValue=LUDOU`,
                    headers: authHeaders,
                });
                const envData = JSON.parse(envResp.body);
                const envList = envData.data || [];
                const newEntry = `${name}#${token}`;
                const targetEnv = envList.find(e => e.name === 'LUDOU');
                let unchanged = false;

                if (targetEnv) {
                    const lines = targetEnv.value.split('\n').filter(Boolean);
                    let found = false;
                    for (let i = 0; i < lines.length; i++) {
                        const idx = lines[i].indexOf('#');
                        if (idx > -1 && lines[i].substring(0, idx) === name) {
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
                            body: JSON.stringify({ name: 'LUDOU', value: lines.join('\n'), id: targetEnv.id }),
                        });
                        qlResult = found ? '青龙token已替换 ✅' : '青龙已追加新账号 ✅';
                    }
                } else {
                    await $.post({
                        url: `${qlUrl}/open/envs`,
                        headers: authHeaders,
                        body: JSON.stringify([{ name: 'LUDOU', value: newEntry }]),
                    });
                    qlResult = '青龙LUDOU环境变量已创建 ✅';
                }

                // token有变化时触发青龙签到任务
                if (!unchanged) {
                    try {
                        const cronResp = await $.get({
                            url: `${qlUrl}/open/crons?searchValue=ludou_sign`,
                            headers: authHeaders,
                        });
                        const cronData = JSON.parse(cronResp.body);
                        const cronList = cronData.data && cronData.data.data || cronData.data || [];
                        const task = cronList.find(c => c.command && c.command.indexOf('ludou_sign') > -1);
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
                if (!syncRecord.accounts.includes(name)) {
                    syncRecord.accounts.push(name);
                    $persistentStore.write(JSON.stringify(syncRecord), 'ludou_ql_synced');
                }
            } catch (qlErr) {
                qlResult = `青龙更新失败: ${qlErr.message || qlErr}`;
            }
        }

        $.notify('麓豆Token', `${name} 抓取成功`, qlResult);
        await sendTG(tgBotToken, tgChatId, `麓豆Token: ${name}\n${qlResult}\n\nToken👇\n<pre>${token}</pre>`);
    } catch (e) {
        $.notify('麓豆Token', '脚本异常 ❌', e.message || e);
        await sendTG(tgBotToken, tgChatId, `麓豆Token 脚本异常: ${e.message || e}`);
    }

    $.done();
})();
