/**
 * 烤匠Token自动抓取 → 青龙面板环境变量更新
 * 从 mini-app-login 响应中获取 token 和 username
 * 环境变量 KAOJIANG 格式: username1#token1\nusername2#token2
 * 配合 kaojiang_token.plugin 使用
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
        const body = JSON.parse($response.body);

        if (!body.status || !body.data || !body.data.token) {
            return $.done();
        }

        const token = body.data.token;
        const name = (body.data.user && body.data.user.username) || '烤匠账号';

        // 从插件 [Argument] 读取配置
        const qlUrl = $argument.ql_url || '';
        const clientId = $argument.ql_client_id || '';
        const clientSecret = $argument.ql_client_secret || '';

        if (!qlUrl || !clientId || !clientSecret) {
            $.notify('烤匠Token', `${name} 抓取成功`, `请在插件设置中填写青龙参数\nToken: ${token.substring(0, 20)}...`);
            return $.done();
        }

        // 1. 获取青龙access_token
        const loginResp = await $.get({
            url: `${qlUrl}/open/auth/token?client_id=${clientId}&client_secret=${clientSecret}`,
        });
        const loginData = JSON.parse(loginResp.body);
        if (loginData.code !== 200) {
            $.notify('烤匠Token', '青龙登录失败', loginData.message || '请检查Client ID/Secret');
            return $.done();
        }
        const qlToken = loginData.data.token;
        const authHeaders = { 'Authorization': `Bearer ${qlToken}`, 'Content-Type': 'application/json' };

        // 2. 查找现有KAOJIANG环境变量
        const envResp = await $.get({
            url: `${qlUrl}/open/envs?searchValue=KAOJIANG`,
            headers: authHeaders,
        });
        const envData = JSON.parse(envResp.body);
        const envList = envData.data || [];

        const newEntry = `${name}#${token}`;
        const targetEnv = envList.find(e => e.name === 'KAOJIANG');

        if (targetEnv) {
            // 按换行拆分，用 username 匹配替换
            const lines = targetEnv.value.split('\n').filter(Boolean);
            let found = false;

            for (let i = 0; i < lines.length; i++) {
                const idx = lines[i].indexOf('#');
                if (idx > -1 && lines[i].substring(0, idx) === name) {
                    lines[i] = newEntry;
                    found = true;
                    break;
                }
            }

            if (!found) {
                lines.push(newEntry);
            }

            const updatedValue = lines.join('\n');
            await $.put({
                url: `${qlUrl}/open/envs`,
                headers: authHeaders,
                body: JSON.stringify({ name: 'KAOJIANG', value: updatedValue, id: targetEnv.id }),
            });
            const msg = found ? 'token已替换' : '已追加新账号';
            $.notify('烤匠Token', `${name} 更新成功 ✅`, msg);
            await sendTG(tgBotToken, tgChatId, `烤匠Token: ${name} 更新成功 ✅ ${msg}\n\nToken: ${token}`);
        } else {
            await $.post({
                url: `${qlUrl}/open/envs`,
                headers: authHeaders,
                body: JSON.stringify([{ name: 'KAOJIANG', value: newEntry }]),
            });
            $.notify('烤匠Token', `${name} 新建成功 ✅`, 'KAOJIANG环境变量已创建');
            await sendTG(tgBotToken, tgChatId, `烤匠Token: ${name} 新建成功 ✅\n\nToken: ${token}`);
        }
    } catch (e) {
        $.notify('烤匠Token', '更新失败 ❌', e.message || e);
        await sendTG(tgBotToken, tgChatId, `烤匠Token 更新失败: ${e.message || e}`);
    }

    $.done();
})();
