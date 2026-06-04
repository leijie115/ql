/*
cron: 0 * * * *
环境变量: SDGUN  格式: 账号描述#uid#完整cookie字符串[#完整User-Agent]  多账号用 @ 或换行分隔
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
* new Env('水弹关键词监控')
*/

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { log } = console;

const scriptName = '水弹关键词监控';
const TG_BOT_TOKEN = process.env.LEOS_TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.LEOS_TG_CHAT_ID || '';
const SIGN_HOST = 'mag1.sdgun.net';
const SIGN_BASE_URL = `https://${SIGN_HOST}`;
const SDGUN_COOKIE_NAME = '3df5d0fc98d8c119af2e389a3f45b5b0';
const STATE_FILE = path.join(__dirname, '.shuidan_keyword_monitor_seen.json');
const ACCEPT_ENCODING = [
    'gzip',
    'deflate',
    'br',
    typeof zlib.zstdDecompress === 'function' ? 'zstd' : ''
].filter(Boolean).join(', ');

const KEYWORD_RULES = [
    { keyword: '沼泽狐', subjectIncludes: ['沼泽狐', '自由'] },
    { keyword: '城市虎s2' },
    { keyword: '城市虎g26' },
    { keyword: '城市虎s5' },
    { keyword: '城市虎g19' }
];

const USER_AGENTS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MAGAPPX|6.1.3-4.0.0-132|iOS 18.5 iPhone17,2|shuidan|E128D1C5-DBD8-4F24-906D-9922B96B883B|6e572d3917ff565534f8ef11f6b06644|43b0e472c0e730535bbbe4eee5175cca|ec7470d175c5bd16f08431b26606ddfa',
    'Mozilla/5.0 (Linux; Android 16; 25019PNF3C Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/148.0.7778.178 Mobile Safari/537.36 MAGAPPX|6.4.0-2.90-30042|Android 16 Xiaomi 25019PNF3C|shuidan|aflGtKnGdmkDAG7WohsnsMeS|174336833b7a87531020e2a8dfe8a38a|7d99e86dd6ca62f374d7e796806896ea|5c48e424c6463977c93a3007c7f84727',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MAGAPPX|6.1.3-4.0.0-132|iOS 26.3.1 iPhone17,2|shuidan|08691728-561C-40E3-9690-0536BC98568B|79e30307f3183a028a5b94d7233763f1|a4cc2ee15b2de2aa661c80bb1e624f06|409ab63de78984d3924e44b9a471959f'
];

function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                decodeBody(res, Buffer.concat(chunks))
                    .then((body) => {
                        const data = body.toString('utf8');
                        if (res.statusCode >= 400) {
                            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(data));
                        } catch {
                            reject(new Error(`响应不是JSON: ${data.slice(0, 200)}`));
                        }
                    })
                    .catch(reject);
            });
        });

        req.on('error', reject);
        req.end();
    });
}

function decodeBody(res, body) {
    const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
    if (!encoding || encoding === 'identity') return Promise.resolve(body);

    return new Promise((resolve, reject) => {
        const done = (err, decoded) => err ? reject(err) : resolve(decoded);

        if (encoding.includes('gzip')) {
            zlib.gunzip(body, done);
        } else if (encoding.includes('deflate')) {
            zlib.inflate(body, done);
        } else if (encoding.includes('br')) {
            zlib.brotliDecompress(body, done);
        } else if (encoding.includes('zstd') && typeof zlib.zstdDecompress === 'function') {
            zlib.zstdDecompress(body, done);
        } else {
            resolve(body);
        }
    });
}

function sendTelegram(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        log('⚠️ 未配置TG环境变量，跳过通知');
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const text = encodeURIComponent(message);
        const tgPath = `/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${text}&parse_mode=HTML&disable_web_page_preview=true`;
        const options = {
            hostname: 'api.telegram.org',
            path: tgPath,
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

    const tokens = str.split(splitor).map(s => s.trim()).filter(Boolean);
    log(`共 ${tokens.length} 个账号`);
    return tokens;
}

function parseAccount(token, index) {
    const firstHash = token.indexOf('#');
    if (firstHash === -1) return null;

    const secondHash = token.indexOf('#', firstHash + 1);
    if (secondHash === -1) return null;

    const thirdHash = token.indexOf('#', secondHash + 1);
    const name = token.substring(0, firstHash);
    const uid = token.substring(firstHash + 1, secondHash);
    const cookie = thirdHash === -1
        ? token.substring(secondHash + 1)
        : token.substring(secondHash + 1, thirdHash);
    const accountUa = thirdHash === -1 ? '' : token.substring(thirdHash + 1);
    const ua = getUserAgent(cookie, accountUa, index);

    if (!name || !uid || !cookie || !ua) return null;
    return { name, uid, cookie, ua };
}

function getCookieValue(cookie, key) {
    const parts = String(cookie || '').split(';');
    for (let part of parts) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const name = part.substring(0, idx).trim();
        if (name === key) return part.substring(idx + 1).trim();
    }
    return '';
}

function getUserAgent(cookie, accountUa, index) {
    if (accountUa) return accountUa;

    const cookieToken = getCookieValue(cookie, SDGUN_COOKIE_NAME);
    if (cookieToken) {
        const matched = USER_AGENTS.find(ua => ua.endsWith(`|${cookieToken}`) || ua.indexOf(`|${cookieToken}`) > -1);
        if (matched) return matched;
    }

    return USER_AGENTS[(index - 1) % USER_AGENTS.length];
}

function buildHeaders(account) {
    return {
        'Host': SIGN_HOST,
        'Cookie': account.cookie,
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-dest': 'empty',
        'x-requested-with': 'XMLHttpRequest',
        'sec-fetch-mode': 'cors',
        'user-agent': account.ua,
        'accept-language': 'zh-CN,zh-Hans;q=0.9',
        'Accept-Encoding': ACCEPT_ENCODING
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return { seen: {} };
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (!data || typeof data !== 'object') return { seen: {} };
        if (!data.seen || typeof data.seen !== 'object') data.seen = {};
        return data;
    } catch (e) {
        log(`⚠️ 读取状态文件失败，将重建: ${e.message}`);
        return { seen: {} };
    }
}

function saveState(state) {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getRandomDelay() {
    return Math.floor(Math.random() * 7000) + 18000;
}

function shuffled(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function searchKeyword(rule, accounts) {
    const keyword = rule.keyword;
    const url = `${SIGN_BASE_URL}/mag/circle/v1/Forum/threadSearch?fid=&keywords=${encodeURIComponent(keyword)}`;
    let lastError = null;

    for (const account of shuffled(accounts)) {
        try {
            log(`搜索「${keyword}」，使用账号: ${account.name}`);
            const result = await httpGet(url, buildHeaders(account));
            if (!result || result.success !== true) {
                const detail = result && result.msg ? result.msg : String(JSON.stringify(result) || result).slice(0, 200);
                throw new Error(detail);
            }
            return extractList(result);
        } catch (e) {
            lastError = e;
            log(`⚠️ 账号 ${account.name} 搜索「${keyword}」失败: ${e.message}`);
        }
    }

    throw lastError || new Error(`搜索「${keyword}」失败`);
}

function extractList(result) {
    if (Array.isArray(result.list)) return result.list;
    if (result.data && Array.isArray(result.data.list)) return result.data.list;
    if (Array.isArray(result.data)) return result.data;
    return [];
}

function itemMatchesRule(item, rule) {
    const subject = String(item.subject || '');
    const includes = rule.subjectIncludes || [];
    for (const word of includes) {
        if (!subject.includes(word)) return false;
    }
    return true;
}

function itemId(item) {
    return String(item.tid || item.id || item.link || '').trim();
}

function trimSeenIds(ids, latestIds) {
    const merged = [];
    const seen = new Set();
    for (const id of latestIds.concat(ids || [])) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
        if (merged.length >= 500) break;
    }
    return merged;
}

function formatItem(item) {
    const subject = escapeHtml(item.subject || '无标题');
    const url = buildThreadUrl(item);
    const forum = escapeHtml(item.forum_name || '');
    const user = escapeHtml(item.user_name || '');
    const time = escapeHtml(formatTime(item));
    const meta = [forum, user, time].filter(Boolean).join(' / ');
    return `- <a href="${escapeHtml(url)}">${subject}</a>${meta ? `\n  ${meta}` : ''}`;
}

function buildThreadUrl(item) {
    const link = String(item.link || '');
    if (/^https?:\/\//i.test(link)) return link;
    if (link) return `${SIGN_BASE_URL}${link}`;
    const tid = itemId(item);
    return `${SIGN_BASE_URL}/mag/circle/v1/forum/threadViewPage?tid=${encodeURIComponent(tid)}`;
}

function formatTime(item) {
    if (item.dateline) return item.dateline;
    const ts = Number(item.create_time || 0);
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function splitTelegramMessages(sections) {
    const messages = [];
    let current = `<b>${scriptName}</b>\n发现新增记录`;

    for (const section of sections) {
        if ((current + '\n\n' + section).length > 3500) {
            messages.push(current);
            current = `<b>${scriptName}</b>\n发现新增记录`;
        }
        current += '\n\n' + section;
    }

    messages.push(current);
    return messages;
}

!(async () => {
    log(`🔔 ${scriptName}, 开始!`);
    const startTime = Date.now();
    const tokens = getTokens('SDGUN');
    const accounts = tokens.map((token, index) => parseAccount(token, index + 1)).filter(Boolean);

    if (accounts.length === 0) {
        const msg = '⚠️ 未找到可用 SDGUN 账号';
        log(msg);
        await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
        return;
    }

    const state = loadState();
    const notifySections = [];
    const errors = [];
    let initializedCount = 0;

    for (let i = 0; i < KEYWORD_RULES.length; i++) {
        const rule = KEYWORD_RULES[i];
        try {
            const list = await searchKeyword(rule, accounts);
            const currentIds = list.map(itemId).filter(Boolean);
            const hadBaseline = Array.isArray(state.seen[rule.keyword]);
            const seenSet = new Set(state.seen[rule.keyword] || []);
            const newMatches = [];

            for (const item of list) {
                const id = itemId(item);
                if (!id || seenSet.has(id)) continue;
                if (itemMatchesRule(item, rule)) newMatches.push(item);
            }

            state.seen[rule.keyword] = trimSeenIds(state.seen[rule.keyword], currentIds);

            if (!hadBaseline) {
                initializedCount++;
                log(`「${rule.keyword}」首次运行，记录 ${currentIds.length} 条基线，不发送历史数据`);
            } else if (newMatches.length > 0) {
                newMatches.sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0));
                const lines = newMatches.map(formatItem).join('\n');
                notifySections.push(`<b>${escapeHtml(rule.keyword)}</b>\n${lines}`);
                log(`「${rule.keyword}」发现 ${newMatches.length} 条新增匹配`);
            } else {
                log(`「${rule.keyword}」无新增匹配`);
            }
        } catch (e) {
            const errMsg = `「${rule.keyword}」搜索失败: ${e.message}`;
            errors.push(errMsg);
            log(`⚠️ ${errMsg}`);
        }

        if (i < KEYWORD_RULES.length - 1) {
            const delay = getRandomDelay();
            log(`等待 ${(delay / 1000).toFixed(1)} 秒后继续...`);
            await wait(delay);
        }
    }

    saveState(state);

    if (notifySections.length > 0) {
        for (const message of splitTelegramMessages(notifySections)) {
            await sendTelegram(message);
        }
    }

    if (errors.length > 0) {
        await sendTelegram(`<b>${scriptName}</b>\n${errors.map(escapeHtml).join('\n')}`);
    } else if (notifySections.length === 0) {
        const initText = initializedCount > 0 ? `，初始化 ${initializedCount} 个关键词基线` : '';
        log(`本次无新增通知${initText}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n🔔 ${scriptName}, 结束! 🕛 ${elapsed} 秒`);
})().catch(async (e) => {
    const msg = `⚠️ 脚本异常: ${e.message}`;
    log(msg);
    await sendTelegram(`<b>${scriptName}</b>\n${escapeHtml(msg)}`);
}).finally(() => process.exit(0));
