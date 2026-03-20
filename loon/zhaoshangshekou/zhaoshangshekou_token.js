/**
 * 招商蛇口Token自动抓取 → 青龙面板环境变量更新
 * 从请求体中获取 Token，从响应体中获取 Mobile 和 Bonus
 * 环境变量 ZHAOSHANGSHEKOU 格式: mobile1#token1\nmobile2#token2
 * 配合 zhaoshangshekou_token.plugin 使用
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

(async () => {
    const tgBotToken = $argument.tg_bot_token || '';
    const tgChatId = $argument.tg_chat_id || '';

    try {
        // 从请求体获取 token
        const reqBody = JSON.parse($request.body);
        const token = reqBody.Header && reqBody.Header.Token;
        if (!token) return $.done();

        // 从响应体获取 mobile 和积分
        const resBody = JSON.parse($response.body);
        if (resBody.m !== 1 || !resBody.d) return $.done();

        const mobile = resBody.d.Mobile || '招商蛇口账号';
        const bonus = resBody.d.Bonus || 0;

        // 从插件 [Argument] 读取配置
        const qlUrl = $argument.ql_url || '';
        const clientId = $argument.ql_client_id || '';
        const clientSecret = $argument.ql_client_secret || '';

        // 更新青龙环境变量
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
                    url: `${qlUrl}/open/envs?searchValue=ZHAOSHANGSHEKOU`,
                    headers: authHeaders,
                });
                const envData = JSON.parse(envResp.body);
                const envList = envData.data || [];
                const newEntry = `${mobile}#${token}`;
                const targetEnv = envList.find(e => e.name === 'ZHAOSHANGSHEKOU');
                let unchanged = false;

                if (targetEnv) {
                    const lines = targetEnv.value.split('\n').filter(Boolean);
                    let found = false;
                    for (let i = 0; i < lines.length; i++) {
                        const idx = lines[i].indexOf('#');
                        if (idx > -1 && lines[i].substring(0, idx) === mobile) {
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
                            body: JSON.stringify({ name: 'ZHAOSHANGSHEKOU', value: lines.join('\n'), id: targetEnv.id }),
                        });
                        qlResult = found ? '青龙token已替换 ✅' : '青龙已追加新账号 ✅';
                    }
                } else {
                    await $.post({
                        url: `${qlUrl}/open/envs`,
                        headers: authHeaders,
                        body: JSON.stringify([{ name: 'ZHAOSHANGSHEKOU', value: newEntry }]),
                    });
                    qlResult = '青龙ZHAOSHANGSHEKOU环境变量已创建 ✅';
                }
            } catch (qlErr) {
                qlResult = `青龙更新失败: ${qlErr.message || qlErr}`;
            }
        }

        $.notify('招商蛇口Token', `${mobile} 抓取成功`, `积分: ${bonus}\n${qlResult}`);
        await sendTG(tgBotToken, tgChatId, `招商蛇口Token: ${mobile}\n积分: ${bonus}\n${qlResult}\n\nToken👇\n<pre>${token}</pre>`);
    } catch (e) {
        $.notify('招商蛇口Token', '脚本异常 ❌', e.message || e);
        await sendTG(tgBotToken, tgChatId, `招商蛇口Token 脚本异常: ${e.message || e}`);
    }

    $.done();
})();
