/*
cron 30 8 * * *
环境变量: SDGUN  格式: 账号描述#uid#完整cookie字符串  多账号用 @ 或换行分隔
示例: 账号1##=; PHPSESSID=
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
* new Env('水弹签到')
*/

const https = require('https');
const { log } = console;

const scriptName = '水弹签到';
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

// ============ UA轮换 ============

const USER_AGENTS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MAGAPPX|6.1.3-4.0.0-132|iOS 18.5 iPhone17,2|shuidan|E128D1C5-DBD8-4F24-906D-9922B96B883B|6e572d3917ff565534f8ef11f6b06644|43b0e472c0e730535bbbe4eee5175cca|ec7470d175c5bd16f08431b26606ddfa',
    'Mozilla/5.0 (Linux; Android 16; 25019PNF3C Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.7632.159 Mobile Safari/537.36 MAGAPPX|6.4.0-2.90-30042|Android 16 Xiaomi 25019PNF3C|shuidan|aaKSZpbM1gADAD2zSckBuXfF|b9bf6e6ca9973b9fa89baa9578c11cdb|bc4094881bb499e855ed001bb1871419|f3963f8e2ba1b6ddb6911ae3ba444571',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MAGAPPX|6.1.3-4.0.0-132|iOS 26.3.1 iPhone17,2|shuidan|08691728-561C-40E3-9690-0536BC98568B|79e30307f3183a028a5b94d7233763f1|a4cc2ee15b2de2aa661c80bb1e624f06|409ab63de78984d3924e44b9a471959f'
];

// ============ 签到逻辑 ============

async function sign(name, uid, cookie, index) {
    const url = `https://shuidan.app1.magcloud.net/mag/addon/v1/sign/signReward?uid=${uid}`;
    const ua = USER_AGENTS[(index - 1) % USER_AGENTS.length];

    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/javascript, text/html, application/xml, text/xml, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': ua,
        'Referer': 'https://shuidan.app1.magcloud.net/mag/addon/v1/sign/signView?needlogin=1&themecolor=111111',
        'Cookie': cookie
    };

    let msg = '';
    try {
        const result = await httpGet(url, headers);
        log(`======== 【${index}】 ${name} ========`);

        if (result.success) {
            const gold = result.data && result.data.gold;
            if (gold) {
                msg = `✅ ${name} 签到成功!\n基础奖励: ${gold.baseGoldReward}, 额外奖励: ${gold.extraGoldReward}`;
            } else {
                msg = `✅ ${name} 签到成功!\n返回: ${JSON.stringify(result.data)}`;
            }
        } else {
            msg = `⚠️ ${name} 签到失败: ${result.msg || JSON.stringify(result)}`;
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

    const tokens = getTokens('SDGUN');
    if (tokens.length === 0) {
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 未配置环境变量 SDGUN`);
        return;
    }

    for (let i = 0; i < tokens.length; i++) {
        const firstHash = tokens[i].indexOf('#');
        if (firstHash === -1) {
            log(`⚠️ 【${i + 1}】 token格式错误，需要: 账号描述#uid#完整cookie字符串`);
            continue;
        }
        const secondHash = tokens[i].indexOf('#', firstHash + 1);
        if (secondHash === -1) {
            log(`⚠️ 【${i + 1}】 token格式错误，需要: 账号描述#uid#完整cookie字符串`);
            continue;
        }

        const name = tokens[i].substring(0, firstHash);
        const uid = tokens[i].substring(firstHash + 1, secondHash);
        const cookie = tokens[i].substring(secondHash + 1);

        if (!name || !uid || !cookie) {
            log(`⚠️ 【${i + 1}】 token格式错误，需要: 账号描述#uid#完整cookie字符串`);
            continue;
        }

        await sign(name, uid, cookie, i + 1);

        if (i < tokens.length - 1) {
            const delay = Math.floor(Math.random() * 20000) + 30000;
            log(`等待 ${(delay / 1000).toFixed(1)} 秒...`);
            await wait(delay);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n🔔 ${scriptName}, 结束! 🕛 ${elapsed} 秒`);
})().catch(e => log(`⚠️ 脚本异常: ${e.message}`));
