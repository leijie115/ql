/*
cron: 50 7 * * *
环境变量: NODESEEK  格式: 账号描述#完整Cookie字符串  多账号用 @ 或换行分隔
示例: 账号1#session=2U6g...; pjwt=eyJp...; smac=1792...; cf_clearance=fJNA...
      (至少包含 session、pjwt、smac、cf_clearance, 登录后有效期约30天)
可选环境变量: NODESEEK_UA  抓取Cookie时浏览器的User-Agent, 必须一致, 否则 cf_clearance 失效
             (默认为 iPhone Chrome, 换设备/浏览器抓Cookie时务必同步修改)
可选环境变量: NODESEEK_REFRACT_VERSION  站点 sw.js 版本, 默认 0.3.34
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
* new Env('NodeSeek签到')
*/

const https = require('https');
const crypto = require('crypto');
const { log } = console;

const scriptName = 'NodeSeek签到';
const TG_BOT_TOKEN = process.env.LEOS_TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.LEOS_TG_CHAT_ID || '';

const BASE = 'https://www.nodeseek.com';
const DEFAULT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.7977.151 Mobile/15E148 Safari/604.1';
const USER_AGENT = process.env.NODESEEK_UA || DEFAULT_UA;

// refract 协议 (还原自 www.nodeseek.com/sw.js): 所有请求都要带签名头, 否则返回 403 Forbiden
const REFRACT_VERSION = process.env.NODESEEK_REFRACT_VERSION || '0.3.34';
const REFRACT_INIT_KEY = 'CHICZkKViFoZmVbIH1Y6';
const REFRACT_MAX_RETRY = 3;

// ============ 工具函数 ============

function rawRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method,
            headers
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let json = null;
                try {
                    json = JSON.parse(data);
                } catch {}
                resolve({ status: res.statusCode, headers: res.headers, raw: data, json });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
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

// ============ refract 客户端 ============

class RefractClient {
    constructor(cookie, userAgent) {
        this.cookie = cookie;
        this.userAgent = userAgent;
        this.key = REFRACT_INIT_KEY;
    }

    // refract-sign = SHA1(method \n\n url \n\n UA \n\n body \n\n key)
    sign(method, url, body) {
        return crypto.createHash('sha1')
            .update([method, url, this.userAgent, body, this.key].join('\n\n'))
            .digest('hex');
    }

    async request(method, path, body = '') {
        const url = BASE + path;
        let res;
        for (let i = 0; i < REFRACT_MAX_RETRY; i++) {
            const headers = {
                'accept': '*/*',
                'accept-language': 'zh-CN,zh-Hans;q=0.9',
                'cookie': this.cookie,
                'origin': BASE,
                'referer': `${BASE}/sw.js?v=${REFRACT_VERSION}`,
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'user-agent': this.userAgent,
                'refract-version': REFRACT_VERSION,
                'refract-key': this.key,
                'refract-sign': this.sign(method, url, body)
            };
            if (method === 'POST') {
                headers['content-type'] = 'text/plain;charset=UTF-8';
                headers['content-length'] = String(Buffer.byteLength(body));
            }

            res = await rawRequest(method, url, headers, body);

            // 服务端用 refract-key-update 下发新 key; 旧 key 请求会被 403, 换 key 后重试
            const keyUpdate = res.headers['refract-key-update'];
            if (keyUpdate && keyUpdate !== this.key) {
                this.key = keyUpdate;
                if (res.status === 403) continue;
            }
            return res;
        }
        return res;
    }

    // 用初始 key 请求 /edge-cgi/ping 换取会话 key
    async init() {
        await this.request('GET', '/edge-cgi/ping');
        return this.key !== REFRACT_INIT_KEY;
    }
}

// ============ 签到逻辑 ============

function isCloudflareChallenge(res) {
    return res && res.raw && (res.raw.includes('cf_chl') || res.raw.includes('Just a moment'));
}

function describeFailure(res) {
    if (!res) return '无响应';
    if (isCloudflareChallenge(res)) {
        return 'Cloudflare 人机验证拦截\n请在浏览器重新通过验证后更新 NODESEEK Cookie, 并确认 NODESEEK_UA 与该浏览器一致';
    }
    if (res.status === 403) {
        return `refract 校验失败 (403)\n站点 sw.js 可能已升级, 请检查 refract 版本 (当前 ${REFRACT_VERSION})`;
    }
    if (res.json && res.json.message) return res.json.message;
    return `HTTP ${res.status}: ${res.raw.replace(/<[^>]*>/g, '').trim().substring(0, 100)}`;
}

async function getAttendanceBoard(client) {
    const res = await client.request('GET', '/api/attendance/board?page=1');
    log(`签到榜响应: HTTP ${res.status} ${res.raw.slice(0, 200)}`);
    return res;
}

function hasSignedToday(board) {
    return !!(board && board.record && board.record.id);
}

function formatBoardInfo(board) {
    if (!board || !board.record) return '';

    const parts = [];
    if (board.record.gain != null) parts.push(`今日收益: ${board.record.gain} 个鸡腿`);
    if (board.order != null) parts.push(`排名: ${board.order}`);
    if (board.total != null) parts.push(`总人数: ${board.total}`);
    return parts.join('\n');
}

async function doSign(name, cookie, index) {
    let msg = '';
    try {
        log(`======== 【${index}】 ${name} ========`);
        const client = new RefractClient(cookie, USER_AGENT);

        if (await client.init()) {
            log('refract 会话 key 获取成功');
        } else {
            log('⚠️ 未获取到 refract 会话 key, 将直接尝试请求');
        }

        // 1. 查询签到榜, 判断今天是否已签到
        const beforeRes = await getAttendanceBoard(client);
        if (isCloudflareChallenge(beforeRes) || beforeRes.status === 403) {
            msg = `⚠️ ${name} 查询签到榜失败: ${describeFailure(beforeRes)}`;
            log(msg);
            await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
            return;
        }

        const beforeBoard = beforeRes.json;
        if (hasSignedToday(beforeBoard)) {
            const boardInfo = formatBoardInfo(beforeBoard);
            msg = `ℹ️ ${name} 今天已签到${boardInfo ? `\n${boardInfo}` : ''}`;
            log(msg);
            await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
            return;
        }

        await wait(1000);

        // 2. 签到
        const signRes = await client.request('POST', '/api/attendance?random=false');
        log(`签到响应: HTTP ${signRes.status} ${signRes.raw.slice(0, 200)}`);
        const result = signRes.json;

        if (result && result.success) {
            let boardInfo = '';
            try {
                await wait(1000);
                const afterRes = await getAttendanceBoard(client);
                boardInfo = formatBoardInfo(afterRes.json);
            } catch (e) {
                log(`⚠️ 签到后查询榜单失败: ${e.message}`);
            }
            msg = `✅ ${name} 签到成功!\n${result.message}\n当前鸡腿: ${result.current}${boardInfo ? `\n${boardInfo}` : ''}`;
        } else if (result && result.message) {
            msg = `ℹ️ ${name} ${result.message}`;
        } else {
            msg = `⚠️ ${name} 签到失败: ${describeFailure(signRes)}`;
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
        const cookie = accounts[i].substring(idx + 1).trim();

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
})().catch(async (e) => {
    log(`⚠️ 脚本异常: ${e.message}`);
    await sendTelegram(`<b>${scriptName}</b>\n⚠️ 脚本异常: ${e.message}`);
}).finally(() => process.exit(0));
