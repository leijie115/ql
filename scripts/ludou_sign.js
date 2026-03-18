/**
 * new Env('麓豆签到')
 * cron 35 8 * * *
 * 环境变量: LUDOU  格式: 账号描述#X-Token  多账号用 @ 或换行分隔
 * 示例: 账号1#eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.xxxxx
 * TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
 */

const https = require('https');
const { log } = console;

const scriptName = '麓豆签到';
const TG_BOT_TOKEN = process.env.LEOS_TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.LEOS_TG_CHAT_ID || '';

// ============ 工具函数 ============

function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: headers
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(data);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function sendTelegram(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        log('⚠️ 未配置TG环境变量，跳过通知');
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const text = encodeURIComponent(message);
        const path = `/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${text}&parse_mode=HTML`;
        const options = {
            hostname: 'api.telegram.org',
            path: path,
            method: 'GET'
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.ok) log(`⚠️ TG通知发送失败: ${json.description}`);
                } catch {}
                resolve();
            });
        });
        req.on('error', (e) => {
            log(`⚠️ TG通知发送异常: ${e.message}`);
            resolve();
        });
        req.end();
    });
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getTokens(envName, splitors = ['@', '\n']) {
    let str = process.env[envName] || '';
    if (!str) {
        log(`⚠️ 未配置环境变量: ${envName}`);
        return [];
    }
    let splitor = splitors[0];
    for (let sp of splitors) {
        if (str.indexOf(sp) > -1) {
            splitor = sp;
            break;
        }
    }
    let tokens = str.split(splitor).filter(Boolean);
    log(`共 ${tokens.length} 个账号`);
    return tokens;
}

// ============ Token检查 ============

function checkTokenExpiry(xToken, name) {
    try {
        const payload = JSON.parse(Buffer.from(xToken.split('.')[1], 'base64').toString());
        const exp = payload.exp * 1000;
        const now = Date.now();
        const remaining = exp - now;
        const hours = Math.floor(remaining / 3600000);

        if (remaining <= 0) {
            return { valid: false, msg: `❌ ${name} token已过期，请打开小程序刷新后更新环境变量` };
        }
        if (hours < 24) {
            return { valid: true, msg: `⚠️ ${name} token将在 ${hours} 小时后过期，请尽快打开小程序刷新` };
        }
        return { valid: true, msg: null };
    } catch {
        return { valid: true, msg: null };
    }
}

// ============ 签到逻辑 ============

function buildHeaders(xToken) {
    return {
        'X-Token': xToken,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip,compress,br,deflate',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x1800452f) NetType/4G Language/zh_CN',
        'Referer': 'https://servicewechat.com/wx09df719a551e8820/687/page-frame.html'
    };
}

async function doSign(name, xToken, index) {
    const headers = buildHeaders(xToken);
    let msg = '';

    try {
        // 1. 签到
        const signUrl = 'https://luhu-beta1-web.crm.luxelakes.com//v1/user-task/signIn/mb/signIn?city=510100&secretKey=';
        const signResult = await httpGet(signUrl, headers);
        log(`======== 【${index}】 ${name} ========`);

        if (signResult.success && signResult.data && signResult.data.success) {
            msg = `✅ ${name} 签到成功! 获得 ${signResult.data.rewardLdCount} 麓豆`;
        } else {
            msg = `⚠️ ${name} 签到失败: ${signResult.message || JSON.stringify(signResult)}`;
            log(msg);
            await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
            return;
        }

        await wait(1000);

        // 2. 查询签到概况
        const summaryUrl = 'https://luhu-beta1-web.crm.luxelakes.com//v1/user-task/signIn/mb/user-sign-in/basic-summary?city=510100&secretKey=';
        const summaryResult = await httpGet(summaryUrl, headers);

        if (summaryResult.success && summaryResult.data) {
            const d = summaryResult.data;
            msg += `\n累计签到: ${d.totalCumulativeDays}天, 本月: ${d.cumulativeDays}天`;
            if (d.cumulativeTaskRule) {
                msg += `\n${d.cumulativeTaskRule}`;
            }
        }
    } catch (e) {
        msg = `⚠️ ${name} 请求异常: ${e.message}`;
    }

    log(msg);
    await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
}

// ============ 主流程 ============

!(async () => {
    log(`🔔 ${scriptName}, 开始!`);
    const startTime = Date.now();

    const tokens = getTokens('LUDOU');
    if (tokens.length === 0) {
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 未配置环境变量 LUDOU`);
        return;
    }

    for (let i = 0; i < tokens.length; i++) {
        const idx = tokens[i].indexOf('#');
        if (idx === -1) {
            log(`⚠️ 【${i + 1}】 token格式错误，需要: 账号描述#X-Token`);
            continue;
        }
        const name = tokens[i].substring(0, idx);
        const xToken = tokens[i].substring(idx + 1);

        if (!name || !xToken) {
            log(`⚠️ 【${i + 1}】 token格式错误，需要: 账号描述#X-Token`);
            continue;
        }

        const tokenCheck = checkTokenExpiry(xToken, name);
        if (!tokenCheck.valid) {
            log(tokenCheck.msg);
            await sendTelegram(`<b>${scriptName}</b>\n${tokenCheck.msg}`);
            continue;
        }
        if (tokenCheck.msg) {
            log(tokenCheck.msg);
            await sendTelegram(`<b>${scriptName}</b>\n${tokenCheck.msg}`);
        }

        await doSign(name, xToken, i + 1);

        if (i < tokens.length - 1) {
            const delay = Math.floor(Math.random() * 3000) + 2000;
            log(`等待 ${(delay / 1000).toFixed(1)} 秒...`);
            await wait(delay);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n🔔 ${scriptName}, 结束! 🕛 ${elapsed} 秒`);
})().catch(e => log(`⚠️ 脚本异常: ${e.message}`));
