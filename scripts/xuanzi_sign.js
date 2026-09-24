/*
cron: 59 7 * * *
环境变量: XUANZI  格式: 账号描述#memberId&enterpriseId&unionid&openid&wxOpenid  多账号用 @ 或换行分隔
示例: 我的账号#8a80a18e...&ff80808174...&oyzS25ws...&orZki5UA...&oX7Wutz8...
说明: appid 固定为 wxaa9dfe89bba7ec1e; sign 由脚本按小程序算法本地计算, 无需抓取
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
* new Env('萱子签到')
*/

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { log } = console;

const scriptName = '萱子签到';
const TG_BOT_TOKEN = process.env.LEOS_TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.LEOS_TG_CHAT_ID || '';

const HOST = 'hope.demogic.com';
const APPID = 'wxaa9dfe89bba7ec1e';
const SECRET = 'damogic8888';
const GIC_WXA_VERSION = '3.9.95';

// ============ 工具函数 ============

function httpRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method,
            headers: Object.assign({}, headers),
        };
        if (body) {
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(data);
                }
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
        const p = `/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${text}&parse_mode=HTML`;
        const req = https.request({ hostname: 'api.telegram.org', path: p, method: 'GET' }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
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
    return new Promise((resolve) => setTimeout(resolve, ms));
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

// ============ 签名算法 (还原自小程序 app-service.js) ============
// sign = MD5("timestamp=" + ts + "transId=" + appid + ts + "secret=damogic8888" + "random=" + random + "memberId=" + memberId)

function nowGMT8() {
    // 北京时间, 格式 YYYY-MM-DD HH:mm:ss
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).format(new Date());
    // sv-SE 输出形如 "2026-09-24 13:57:07"
    return parts.replace('T', ' ');
}

function buildAuth(memberId) {
    const ts = nowGMT8();
    const random = Math.floor(Math.random() * 1e7);
    const transId = APPID + ts;
    const raw = `timestamp=${ts}transId=${transId}secret=${SECRET}random=${random}memberId=${memberId}`;
    const sign = crypto.createHash('md5').update(raw, 'utf8').digest('hex');
    return { ts, random, transId, sign };
}

// ============ 已签到通知去重 ============

const NOTIFIED_FILE = path.join(__dirname, '.xuanzi_notified.json');

function loadNotified() {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    try {
        const data = JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8'));
        if (data.date === today) return data;
    } catch {}
    return { date: today, accounts: [] };
}

function markNotified(name) {
    const data = loadNotified();
    if (!data.accounts.includes(name)) data.accounts.push(name);
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(data));
}

function alreadyNotified(name) {
    return loadNotified().accounts.includes(name);
}

// ============ 账号解析 ============

function parseAccount(raw, index) {
    const idx = raw.indexOf('#');
    if (idx === -1) {
        log(`⚠️ 【${index}】 格式错误，需要: 账号描述#memberId&enterpriseId&unionid&openid&wxOpenid`);
        return null;
    }
    const name = raw.substring(0, idx);
    const fields = raw.substring(idx + 1).split('&');
    if (!name || fields.length < 5 || fields.some((f) => !f)) {
        log(`⚠️ 【${index}】 字段不完整，需要 5 个字段: memberId&enterpriseId&unionid&openid&wxOpenid`);
        return null;
    }
    const [memberId, enterpriseId, unionid, openid, wxOpenid] = fields;
    return { name, memberId, enterpriseId, unionid, openid, wxOpenid };
}

// ============ 请求构造 ============

function buildHeaders(acc) {
    return {
        Host: HOST,
        sign: acc.enterpriseId,
        channelEntrance: 'wx_app',
        xweb_xhr: '1',
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: '*/*',
        Referer: `https://servicewechat.com/${APPID}/97/page-frame.html`,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) MiniProgramEnv/Mac',
    };
}

function commonParams(acc) {
    const { ts, random, transId, sign } = buildAuth(acc.memberId);
    return {
        memberId: acc.memberId,
        cliqueId: '-1',
        cliqueMemberId: '-1',
        useClique: 0,
        enterpriseId: acc.enterpriseId,
        unionid: acc.unionid,
        openid: acc.openid,
        wxOpenid: acc.wxOpenid,
        sign,
        random,
        appid: APPID,
        transId,
        timestamp: ts,
        gicWxaVersion: GIC_WXA_VERSION,
    };
}

// 查询签到概况
async function querySignInfo(acc) {
    const p = commonParams(acc);
    const qs = Object.keys(p)
        .map((k) => `${k}=${encodeURIComponent(p[k])}`)
        .join('&');
    const url = `https://${HOST}/gic-wx-app/sign/get-member-sign-info.json?${qs}`;
    return httpRequest('GET', url, buildHeaders(acc));
}

// 执行签到
async function doMemberSign(acc) {
    const p = Object.assign({ source: 'wxapp' }, commonParams(acc));
    const url = `https://${HOST}/gic-wx-app/sign/member_sign.json`;
    return httpRequest('POST', url, buildHeaders(acc), JSON.stringify(p));
}

// ============ 签到逻辑 ============

function findToday(calendar) {
    return (calendar || []).find((d) => d.currentDayFlag === 1);
}

function awardText(entry) {
    if (!entry || !entry.memberSignAwards || !entry.memberSignAwards.length) return '';
    return entry.memberSignAwards
        .map((a) => `${a.count}${a.type === 'integral' ? '积分' : a.type}`)
        .join('、');
}

async function handleAccount(acc, index) {
    let msg = '';
    try {
        log(`======== 【${index}】 ${acc.name} ========`);

        // 1. 查询签到概况
        const info = await querySignInfo(acc);
        if (!info || info.code !== '0' || !info.result) {
            msg = `⚠️ ${acc.name} 查询签到信息失败: ${(info && info.message) || JSON.stringify(info)}`;
            log(msg);
            await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
            return;
        }

        const r = info.result;
        const todayEntry = findToday(r.memberSignCalendar);
        if (todayEntry && todayEntry.signFlag === 1) {
            msg = `ℹ️ ${acc.name} 今天已签到，跳过`;
            msg += `\n连续签到: ${r.continuousSign}天, 累计: ${r.cumulativeSign}天`;
            log(msg);
            if (!alreadyNotified(acc.name)) {
                await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
                markNotified(acc.name);
            } else {
                log('(今日已通知过，不再发送TG)');
            }
            return;
        }

        await wait(1000);

        // 2. 执行签到
        const signRes = await doMemberSign(acc);
        if (!signRes || signRes.code !== '0') {
            msg = `⚠️ ${acc.name} 签到失败: ${(signRes && signRes.message) || JSON.stringify(signRes)}`;
            log(msg);
            await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
            return;
        }

        const signedToday = findToday(signRes.result);
        const award = awardText(signedToday);
        msg = `✅ ${acc.name} 签到成功!`;
        if (award) msg += ` 获得 ${award}`;

        await wait(800);

        // 3. 重新查询累计天数
        try {
            const info2 = await querySignInfo(acc);
            if (info2 && info2.code === '0' && info2.result) {
                msg += `\n连续签到: ${info2.result.continuousSign}天, 累计: ${info2.result.cumulativeSign}天`;
            }
        } catch {}
    } catch (e) {
        msg = `⚠️ ${acc.name} 请求异常: ${e.message}`;
    }

    log(msg);
    await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
}

// ============ 主流程 ============

!(async () => {
    log(`🔔 ${scriptName}, 开始!`);
    const startTime = Date.now();

    const tokens = getTokens('XUANZI');
    if (tokens.length === 0) {
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 未配置环境变量 XUANZI`);
        return;
    }

    for (let i = 0; i < tokens.length; i++) {
        const acc = parseAccount(tokens[i], i + 1);
        if (!acc) continue;

        await handleAccount(acc, i + 1);

        if (i < tokens.length - 1) {
            const delay = Math.floor(Math.random() * 3000) + 2000;
            log(`等待 ${(delay / 1000).toFixed(1)} 秒...`);
            await wait(delay);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n🔔 ${scriptName}, 结束! 🕛 ${elapsed} 秒`);
})()
    .catch((e) => log(`⚠️ 脚本异常: ${e.message}`))
    .finally(() => process.exit(0));
