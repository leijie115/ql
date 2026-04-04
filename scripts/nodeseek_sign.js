/*
cron: 50 7 * * *
环境变量: NODESEEK  格式: 账号描述#完整Cookie字符串  多账号用 @ 或换行分隔
示例: 账号1#session=074efadb...; cf_clearance=n_Kujt...; fog=0d50421f...
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
* new Env('NodeSeek签到')
*/

const https = require('https');
const { log } = console;

const scriptName = 'NodeSeek签到';
const TG_BOT_TOKEN = process.env.LEOS_TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.LEOS_TG_CHAT_ID || '';

// ============ 工具函数 ============

function httpPost(url, headers) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'content-length': '0',
                ...headers
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve({ raw: data });
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

function getAccounts(envName, splitors = ['@', '\n']) {
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
    const accounts = str.split(splitor).filter(Boolean);
    log(`共 ${accounts.length} 个账号`);
    return accounts;
}

// ============ 签到逻辑 ============

function buildHeaders(cookie) {
    return {
        'accept': '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cookie': cookie,
        'origin': 'https://www.nodeseek.com',
        'referer': 'https://www.nodeseek.com/board',
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
    };
}

async function doSign(name, cookie, index) {
    let msg = '';
    try {
        log(`======== 【${index}】 ${name} ========`);
        const headers = buildHeaders(cookie);
        const result = await httpPost('https://www.nodeseek.com/api/attendance?random=false', headers);

        log(`签到响应: ${JSON.stringify(result)}`);

        if (result.success) {
            msg = `✅ ${name} 签到成功!\n${result.message}\n当前鸡腿: ${result.current}`;
        } else if (result.message) {
            msg = `ℹ️ ${name} ${result.message}`;
        } else if (result.raw) {
            msg = `⚠️ ${name} 响应异常: ${result.raw.substring(0, 200)}`;
        } else {
            msg = `⚠️ ${name} 签到失败: ${JSON.stringify(result)}`;
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

    const accounts = getAccounts('NODESEEK');
    if (accounts.length === 0) {
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 未配置环境变量 NODESEEK`);
        return;
    }

    for (let i = 0; i < accounts.length; i++) {
        const idx = accounts[i].indexOf('#');
        if (idx === -1) {
            log(`⚠️ 【${i + 1}】 格式错误，需要: 账号描述#Cookie字符串`);
            continue;
        }
        const name = accounts[i].substring(0, idx);
        const cookie = accounts[i].substring(idx + 1);

        if (!name || !cookie) {
            log(`⚠️ 【${i + 1}】 格式错误，需要: 账号描述#Cookie字符串`);
            continue;
        }

        await doSign(name, cookie, i + 1);

        if (i < accounts.length - 1) {
            const delay = Math.floor(Math.random() * 3000) + 2000;
            log(`等待 ${(delay / 1000).toFixed(1)} 秒...`);
            await wait(delay);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n🔔 ${scriptName}, 结束! 🕛 ${elapsed} 秒`);
})().catch(e => log(`⚠️ 脚本异常: ${e.message}`)).finally(() => process.exit(0));
