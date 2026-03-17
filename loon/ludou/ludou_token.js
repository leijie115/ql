/**
 * 麓豆Token自动抓取 → 青龙面板环境变量更新
 * 配合 ludou_token.plugin 使用
 */

// ====== 青龙配置，填写你的信息 ======
const QL_URL = 'https://ql.leos.cyou';
const QL_CLIENT_ID = '0h1ZnR57nd_1';
const QL_CLIENT_SECRET = 'jpgHRZSg_166Ri_UiZr9gppB';
// ==================================

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

(async () => {
    try {
        const body = JSON.parse($response.body);

        if (body.code !== 200 || !body.data || !body.data.token) {
            return $.done();
        }

        const token = body.data.token;
        const name = body.data.nickName || '麓豆账号';

        if (!QL_URL || !QL_CLIENT_ID || !QL_CLIENT_SECRET) {
            $.notify('麓豆Token', `${name} 抓取成功`, `请在脚本中填写青龙配置\nToken: ${token.substring(0, 20)}...`);
            return $.done();
        }

        // 1. 获取青龙access_token
        const loginResp = await $.get({
            url: `${QL_URL}/open/auth/token?client_id=${QL_CLIENT_ID}&client_secret=${QL_CLIENT_SECRET}`,
        });
        const loginData = JSON.parse(loginResp.body);
        if (loginData.code !== 200) {
            $.notify('麓豆Token', '青龙登录失败', loginData.message || '请检查Client ID/Secret');
            return $.done();
        }
        const qlToken = loginData.data.token;
        const authHeaders = { 'Authorization': `Bearer ${qlToken}`, 'Content-Type': 'application/json' };

        // 2. 查找现有LUDOU环境变量
        const envResp = await $.get({
            url: `${QL_URL}/open/envs?searchValue=LUDOU`,
            headers: authHeaders,
        });
        const envData = JSON.parse(envResp.body);
        const envList = envData.data || [];

        const newValue = `${name}#${token}`;

        // 青龙换行分隔 = 多条同名LUDOU环境变量，每条值为 名称#token
        // 用nickName匹配对应条目
        const targetList = envList.filter(e => e.name === 'LUDOU');

        if (targetList.length > 0) {
            let targetEnv = targetList.find(e => {
                const idx = e.value.indexOf('#');
                return idx > -1 && e.value.substring(0, idx) === name;
            });

            if (targetEnv) {
                await $.put({
                    url: `${QL_URL}/open/envs`,
                    headers: authHeaders,
                    body: JSON.stringify({ name: 'LUDOU', value: newValue, id: targetEnv.id }),
                });
                $.notify('麓豆Token', `${name} 更新成功 ✅`, 'token已自动更新到青龙面板');
            } else {
                await $.post({
                    url: `${QL_URL}/open/envs`,
                    headers: authHeaders,
                    body: JSON.stringify([{ name: 'LUDOU', value: newValue }]),
                });
                $.notify('麓豆Token', `${name} 新增成功 ✅`, '已新增一条LUDOU环境变量');
            }
        } else {
            await $.post({
                url: `${QL_URL}/open/envs`,
                headers: authHeaders,
                body: JSON.stringify([{ name: 'LUDOU', value: newValue }]),
            });
            $.notify('麓豆Token', `${name} 新建成功 ✅`, 'LUDOU环境变量已创建');
        }
    } catch (e) {
        $.notify('麓豆Token', '更新失败 ❌', e.message || e);
    }

    $.done();
})();
