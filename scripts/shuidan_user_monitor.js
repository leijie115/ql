/*
cron: 10,40 * * * *
环境变量: SDGUN  格式: 账号描述#uid#完整cookie字符串[#完整User-Agent]  多账号用 @ 或换行分隔
可选环境变量: SHUIDAN_MONITOR_USERS  格式: 用户名#user_id  多用户用 @ 或换行分隔，默认 城市虎#252120
可选环境变量: SHUIDAN_MAG_SS_KEY  如 userActivityPage 接口要求 mag-ss-key，可填抓包值
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
* new Env('水弹用户发帖监控')
*/

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { log } = console;

const scriptName = '水弹用户发帖监控';
const TG_BOT_TOKEN = process.env.LEOS_TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.LEOS_TG_CHAT_ID || '';
const SHUIDAN_MAG_SS_KEY = process.env.SHUIDAN_MAG_SS_KEY || '';
const SIGN_HOST = 'mag1.sdgun.net';
const SIGN_BASE_URL = `https://${SIGN_HOST}`;
const SDGUN_COOKIE_NAME = '3df5d0fc98d8c119af2e389a3f45b5b0';
const STATE_FILE = path.join(__dirname, '.shuidan_user_monitor_seen.json');
const ACTIVITY_STEP = 20;
const MAX_CONTENT_LENGTH = 1600;
const MAX_MEDIA_ITEMS = 10;
const MAX_MEDIA_GROUP_ITEMS = 10;
const TELEGRAM_CAPTION_LIMIT = 1000;
const ACCEPT_ENCODING = [
    'gzip',
    'deflate',
    'br',
    typeof zlib.zstdDecompress === 'function' ? 'zstd' : ''
].filter(Boolean).join(', ');

const USER_AGENTS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MAGAPPX|6.1.3-4.0.0-132|iOS 18.5 iPhone17,2|shuidan|E128D1C5-DBD8-4F24-906D-9922B96B883B|6e572d3917ff565534f8ef11f6b06644|43b0e472c0e730535bbbe4eee5175cca|ec7470d175c5bd16f08431b26606ddfa',
    'Mozilla/5.0 (Linux; Android 16; 25019PNF3C Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/148.0.7778.178 Mobile Safari/537.36 MAGAPPX|6.4.0-2.90-30042|Android 16 Xiaomi 25019PNF3C|shuidan|aflGtKnGdmkDAG7WohsnsMeS|174336833b7a87531020e2a8dfe8a38a|7d99e86dd6ca62f374d7e796806896ea|5c48e424c6463977c93a3007c7f84727',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MAGAPPX|6.1.3-4.0.0-132|iOS 26.3.1 iPhone17,2|shuidan|08691728-561C-40E3-9690-0536BC98568B|79e30307f3183a028a5b94d7233763f1|a4cc2ee15b2de2aa661c80bb1e624f06|409ab63de78984d3924e44b9a471959f'
];

function httpGetText(url, headers) {
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
                        const text = body.toString('utf8');
                        if (res.statusCode >= 400) {
                            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                            return;
                        }
                        resolve(text);
                    })
                    .catch(reject);
            });
        });

        req.on('error', reject);
        req.end();
    });
}

async function httpGetJson(url, headers) {
    const text = await httpGetText(url, headers);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`响应不是JSON: ${text.slice(0, 200)}`);
    }
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
    return telegramApi('sendMessage', {
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    }).then(() => true).catch((e) => {
        log(`⚠️ TG通知发送失败: ${e.message}`);
        return false;
    });
}

function telegramApi(method, payload) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        log('⚠️ 未配置TG环境变量，跳过通知');
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${TG_BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.ok) {
                        throw new Error(json.description || `Telegram ${method} 失败`);
                    }
                    resolve(json);
                } catch (e) {
                    resolve({ ok: false, error: e.message || `Telegram ${method} 响应异常` });
                }
            });
        });
        req.on('error', (e) => {
            resolve({ ok: false, error: e.message });
        });
        req.write(body);
        req.end();
    }).then((json) => {
        if (json && json.ok === false) {
            throw new Error(json.error || `Telegram ${method} 失败`);
        }
        return json;
    });
}

async function sendTelegramMedia(mediaItems, caption = '') {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID || mediaItems.length === 0) {
        return false;
    }

    const chunks = [];
    for (let i = 0; i < mediaItems.length; i += MAX_MEDIA_GROUP_ITEMS) {
        chunks.push(mediaItems.slice(i, i + MAX_MEDIA_GROUP_ITEMS));
    }

    try {
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            if (chunk.length === 1) {
                await sendTelegramSingleMedia(chunk[0], chunkIndex === 0 ? caption : '');
            } else {
                await telegramApi('sendMediaGroup', {
                    chat_id: TG_CHAT_ID,
                    media: chunk.map((item, itemIndex) => {
                        const data = {
                            type: item.type,
                            media: item.url
                        };
                        if (chunkIndex === 0 && itemIndex === 0 && caption) {
                            data.caption = caption;
                            data.parse_mode = 'HTML';
                        }
                        return data;
                    })
                });
            }
            await wait(800);
        }
        return true;
    } catch (e) {
        log(`⚠️ TG媒体发送失败: ${e.message}`);
        return false;
    }
}

function sendTelegramSingleMedia(item, caption = '') {
    const captionFields = caption
        ? { caption, parse_mode: 'HTML' }
        : {};

    if (item.type === 'video') {
        return telegramApi('sendVideo', {
            chat_id: TG_CHAT_ID,
            video: item.url,
            ...captionFields
        });
    }

    return telegramApi('sendPhoto', {
        chat_id: TG_CHAT_ID,
        photo: item.url,
        ...captionFields
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

function getMagVersion(ua) {
    const parts = String(ua || '').split('MAGAPPX|')[1];
    if (!parts) return '';
    const version = parts.split('|')[0];
    if (!version) return '';
    return /iPhone|iOS/i.test(ua) ? `iOS-${version}` : `Android-${version}`;
}

function buildActivityHeaders(account) {
    const headers = {
        'Host': SIGN_HOST,
        'Cookie': account.cookie,
        'accept': '*/*',
        'user-agent': account.ua,
        'accept-language': 'zh-Hans-US;q=1, en-US;q=0.9, zh-Hant-US;q=0.8',
        'Accept-Encoding': ACCEPT_ENCODING
    };

    const magVersion = getMagVersion(account.ua);
    if (magVersion) headers['mag-version'] = magVersion;
    if (SHUIDAN_MAG_SS_KEY) headers['mag-ss-key'] = SHUIDAN_MAG_SS_KEY;

    return headers;
}

function buildDetailHeaders(account) {
    return {
        'Host': SIGN_HOST,
        'Cookie': account.cookie,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'user-agent': account.ua,
        'accept-language': 'zh-CN,zh-Hans;q=0.9',
        'Accept-Encoding': ACCEPT_ENCODING
    };
}

function getMonitorUsers() {
    const raw = process.env.SHUIDAN_MONITOR_USERS || '城市虎#252120';
    const splitor = raw.indexOf('@') > -1 ? '@' : '\n';
    return raw.split(splitor).map((item) => {
        const line = item.trim();
        if (!line) return null;
        const idx = line.indexOf('#');
        if (idx === -1) return { name: `用户${line}`, userId: line };
        const name = line.substring(0, idx).trim();
        const userId = line.substring(idx + 1).trim();
        if (!userId) return null;
        return { name: name || `用户${userId}`, userId };
    }).filter(Boolean);
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

function shuffled(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function fetchUserActivity(user, accounts) {
    const url = `${SIGN_BASE_URL}/mag/user/v2/User/userActivityPage?user_id=${encodeURIComponent(user.userId)}&p=1&step=${ACTIVITY_STEP}`;
    let lastError = null;

    for (const account of shuffled(accounts)) {
        try {
            log(`拉取 ${user.name}(${user.userId}) 动态，使用账号: ${account.name}`);
            const result = await httpGetJson(url, buildActivityHeaders(account));
            if (!result || result.success !== true) {
                const detail = result && result.msg ? result.msg : String(JSON.stringify(result) || result).slice(0, 200);
                throw new Error(detail);
            }
            return { list: extractList(result), account };
        } catch (e) {
            lastError = e;
            log(`⚠️ 账号 ${account.name} 拉取 ${user.name} 动态失败: ${e.message}`);
        }
    }

    throw lastError || new Error(`拉取 ${user.name} 动态失败`);
}

async function fetchThreadDetail(item, accounts, preferredAccount) {
    const url = buildThreadUrl(item, true);
    const orderedAccounts = preferredAccount
        ? [preferredAccount].concat(accounts.filter(account => account !== preferredAccount))
        : accounts;
    let lastError = null;

    for (const account of orderedAccounts) {
        try {
            log(`拉取帖子详情 tid=${itemId(item)}，使用账号: ${account.name}`);
            const html = await httpGetText(url, buildDetailHeaders(account));
            const row = extractRow(html);
            return row || buildFallbackRow(item);
        } catch (e) {
            lastError = e;
            log(`⚠️ 账号 ${account.name} 拉取帖子详情失败: ${e.message}`);
        }
    }

    throw lastError || new Error(`拉取帖子详情失败: ${itemId(item)}`);
}

function extractList(result) {
    if (Array.isArray(result.list)) return result.list;
    if (result.data && Array.isArray(result.data.list)) return result.data.list;
    if (Array.isArray(result.data)) return result.data;
    return [];
}

function isForumPost(item) {
    const type = String(item.type || '').toLowerCase();
    const typeInfo = String(item.type_info || '');
    return itemId(item) && (type === 'forum' || typeInfo.includes('发表了帖子'));
}

function itemId(item) {
    return String(item.tid || item.id || item.link || '').trim();
}

function buildFallbackRow(item) {
    return {
        tid: itemId(item),
        title: item.title || '新帖',
        user_id: item.user && item.user.id,
        user_name: item.user && item.user.name,
        forum_name: item.forum_name || item.circle_name,
        create_time: item.create_time,
        create_time_ago: item.create_time_str,
        reply_count: item.comment_count,
        click: item.click,
        content: '',
        pics: (item.pics_arr || []).map(pic => pic.url || pic.tburl).filter(Boolean),
        link: item.link
    };
}

function extractRow(html) {
    const marker = String(html || '').match(/var\s+row\s*=/);
    if (!marker) throw new Error('详情页未找到 var row');

    const start = html.indexOf('{', marker.index);
    if (start === -1) throw new Error('详情页 row 不是对象');

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (inString) {
            if (escape) {
                escape = false;
            } else if (ch === '\\') {
                escape = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return JSON.parse(html.slice(start, i + 1));
            }
        }
    }

    throw new Error('详情页 row JSON 不完整');
}

function buildThreadUrl(item, includeTheme) {
    const link = String(item.link || '');
    let url = '';
    if (/^https?:\/\//i.test(link)) {
        url = link;
    } else if (link) {
        url = `${SIGN_BASE_URL}${link}`;
    } else {
        url = `${SIGN_BASE_URL}/mag/circle/v1/forum/threadViewPage?tid=${encodeURIComponent(itemId(item))}`;
    }

    if (includeTheme && url.indexOf('themecolor=') === -1) {
        url += `${url.indexOf('?') === -1 ? '?' : '&'}themecolor=111111`;
    }

    return url;
}

function htmlToText(html) {
    let text = String(html || '');
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<img\b[^>]*>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = decodeHtmlEntities(text);
    text = text.replace(/\r/g, '\n');
    text = text.replace(/[ \t\f\v]+/g, ' ');
    text = text.replace(/\u00a0/g, ' ');
    text = text.split('\n').map(line => line.trim()).join('\n');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function collectMedia(row, item) {
    const media = [];
    const add = (type, url) => {
        url = normalizeMediaUrl(type, url);
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (media.some(item => item.url === url)) return;
        media.push({ type, url });
    };

    if (Array.isArray(row.pics)) row.pics.forEach(url => add('photo', url));
    if (Array.isArray(item.pics_arr)) {
        item.pics_arr.forEach(pic => add('photo', pic && (pic.url || pic.tburl)));
    }

    add('video', row.video_url);
    add('video', row.video);
    add('video', item.video_url);
    collectVideoArray(row.videos, add);
    collectVideoArray(item.videos, add);

    if (Array.isArray(row.video_pics)) row.video_pics.forEach(url => add('photo', url));

    const content = String(row.content || '');
    content.replace(/<img\b[^>]*(?:data-original|src)=["']([^"']+)["'][^>]*>/gi, (_, url) => {
        add('photo', url);
        return '';
    });
    content.replace(/<(?:video|source)\b[^>]*src=["']([^"']+)["'][^>]*>/gi, (_, url) => {
        add('video', url);
        return '';
    });

    return media.slice(0, MAX_MEDIA_ITEMS);
}

function collectVideoArray(value, add) {
    if (!value) return;
    const list = Array.isArray(value) ? value : [value];

    for (const item of list) {
        if (!item) continue;
        if (typeof item === 'string') {
            add('video', item);
            continue;
        }
        if (typeof item !== 'object') continue;

        add('video', item.video_url || item.videoUrl || item.url || item.src || item.play_url || item.playUrl);
        add('photo', item.cover_url || item.coverUrl || item.cover || item.pic || item.pic_url || item.picUrl || item.thumb || item.tburl);
    }
}

function normalizeMediaUrl(type, url) {
    url = decodeHtmlEntities(String(url || '').trim());
    if (!url) return '';
    if (url.indexOf('//') === 0) url = `https:${url}`;
    if (type === 'photo') return url.replace(/\?.*$/, '');
    return url;
}

function formatTime(row, item) {
    if (row.create_time_ago) return row.create_time_ago;
    if (item.create_time_str) return item.create_time_str;
    const ts = Number(row.create_time || item.create_time || 0);
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function truncateText(text, maxLen) {
    text = String(text || '');
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}\n...`;
}

function buildTelegramMessage(user, item, row, media) {
    const title = row.title || item.title || '新帖';
    const url = buildThreadUrl(item, false);
    const author = row.user_name || (item.user && item.user.name) || user.name;
    const forum = row.forum_name || item.forum_name || item.circle_name || '';
    const time = formatTime(row, item);
    const replyCount = row.reply_count != null ? row.reply_count : item.comment_count;
    const click = row.click != null ? row.click : item.click;
    const content = truncateText(htmlToText(row.content || row.all_des || row.des || ''), MAX_CONTENT_LENGTH);
    const mediaText = formatMediaSummary(media);

    const meta = [
        `作者: ${escapeHtml(author)}`,
        forum ? `版块: ${escapeHtml(forum)}` : '',
        time ? `时间: ${escapeHtml(time)}` : '',
        replyCount != null && replyCount !== '' ? `回复: ${escapeHtml(replyCount)}` : '',
        click != null && click !== '' ? `阅读: ${escapeHtml(click)}` : '',
        mediaText ? `媒体: ${escapeHtml(mediaText)}` : ''
    ].filter(Boolean).join('\n');

    return `<b>${scriptName}</b>\n${escapeHtml(user.name)} 发现新帖\n\n标题: ${escapeHtml(title)}\n链接: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>\n${meta}${content ? `\n\n内容:\n<pre>${escapeHtml(content)}</pre>` : ''}`;
}

function buildTelegramMediaCaption(user, item, row, media) {
    const title = row.title || item.title || '新帖';
    const url = buildThreadUrl(item, false);
    const author = row.user_name || (item.user && item.user.name) || user.name;
    const forum = row.forum_name || item.forum_name || item.circle_name || '';
    const time = formatTime(row, item);
    const replyCount = row.reply_count != null ? row.reply_count : item.comment_count;
    const click = row.click != null ? row.click : item.click;
    const content = htmlToText(row.content || row.all_des || row.des || '');
    const mediaText = formatMediaSummary(media);
    const meta = [
        `监控用户: ${escapeHtml(user.name)}`,
        `作者: ${escapeHtml(author)}`,
        forum ? `版块: ${escapeHtml(forum)}` : '',
        time ? `时间: ${escapeHtml(time)}` : '',
        replyCount != null && replyCount !== '' ? `回复: ${escapeHtml(replyCount)}` : '',
        click != null && click !== '' ? `阅读: ${escapeHtml(click)}` : '',
        mediaText ? `媒体: ${escapeHtml(mediaText)}` : ''
    ].filter(Boolean).join('\n');
    const base = `<b>${scriptName}</b>\n${escapeHtml(user.name)} 发现新帖\n\n标题: ${escapeHtml(title)}\n链接: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>\n${meta}`;

    for (const maxContentLength of [520, 360, 220, 120, 0]) {
        const contentText = maxContentLength > 0 ? truncateText(content, maxContentLength) : '';
        const caption = `${base}${contentText ? `\n\n内容:\n${escapeHtml(contentText)}` : ''}`;
        if (caption.length <= TELEGRAM_CAPTION_LIMIT) return caption;
    }

    return '';
}

function formatMediaSummary(media) {
    const photoCount = media.filter(item => item.type === 'photo').length;
    const videoCount = media.filter(item => item.type === 'video').length;
    return [
        photoCount > 0 ? `${photoCount} 张图片` : '',
        videoCount > 0 ? `${videoCount} 个视频` : ''
    ].filter(Boolean).join('，');
}

function formatMediaLinkSection(media) {
    const lines = media.map((item, index) => {
        const label = item.type === 'video' ? '视频' : '图片';
        const url = escapeHtml(item.url);
        return `${index + 1}. ${label}: <a href="${url}">${url}</a>`;
    });
    return lines.join('\n');
}

function buildMediaLinkMessages(user, item, row, media) {
    if (!media.length) return [];

    const title = row.title || item.title || '新帖';
    const url = buildThreadUrl(item, false);
    const header = `<b>${scriptName}</b>\n${escapeHtml(user.name)} 新帖媒体链接\n${escapeHtml(title)}\n帖子: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>\n`;
    const lines = formatMediaLinkSection(media).split('\n').filter(Boolean);
    const messages = [];
    let current = `${header}\n`;

    for (const line of lines) {
        if ((current + line + '\n').length > 3600 && current.trim() !== header.trim()) {
            messages.push(current.trim());
            current = `${header}\n`;
        }
        current += `${line}\n`;
    }

    if (current.trim() !== header.trim()) messages.push(current.trim());
    return messages;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

async function monitorUser(user, accounts, state) {
    const { list, account } = await fetchUserActivity(user, accounts);
    const posts = list.filter(isForumPost);
    const currentIds = posts.map(itemId).filter(Boolean);
    const hadBaseline = Array.isArray(state.seen[user.userId]);
    const seenSet = new Set(state.seen[user.userId] || []);

    if (!hadBaseline) {
        state.seen[user.userId] = trimSeenIds([], currentIds);
        log(`${user.name} 首次运行，记录 ${currentIds.length} 条帖子基线，不发送历史数据`);
        return { initialized: true, notified: 0, errors: [] };
    }

    const newPosts = posts
        .filter(item => !seenSet.has(itemId(item)))
        .sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0));
    const failedIds = new Set();
    const errors = [];
    let notified = 0;

    for (const item of newPosts) {
        const tid = itemId(item);
        try {
            const row = await fetchThreadDetail(item, accounts, account);
            const media = collectMedia(row, item);
            if (media.length > 0) {
                const mediaCaption = buildTelegramMediaCaption(user, item, row, media);
                if (mediaCaption) {
                    const mediaSent = await sendTelegramMedia(media, mediaCaption);
                    if (mediaSent) {
                        notified++;
                        await wait(1000);
                        continue;
                    }
                    log('媒体合并发送失败，回退为文本通知');
                }
            }
            await sendTelegram(buildTelegramMessage(user, item, row, media));
            if (media.length > 0) {
                const mediaLinkMessages = buildMediaLinkMessages(user, item, row, media);
                for (const message of mediaLinkMessages) {
                    await sendTelegram(message);
                    await wait(500);
                }
                const mediaSent = await sendTelegramMedia(media);
                if (!mediaSent) {
                    log('媒体直发失败，已在通知中保留可点击链接');
                }
            }
            notified++;
            await wait(1000);
        } catch (e) {
            failedIds.add(tid);
            const msg = `${user.name} 新帖 ${tid} 详情失败: ${e.message}`;
            errors.push(msg);
            log(`⚠️ ${msg}`);
        }
    }

    const safeCurrentIds = currentIds.filter(id => !failedIds.has(id));
    state.seen[user.userId] = trimSeenIds(state.seen[user.userId], safeCurrentIds);

    if (notified === 0 && errors.length === 0) {
        log(`${user.name} 无新增帖子`);
    } else {
        log(`${user.name} 新增 ${newPosts.length} 条，已通知 ${notified} 条`);
    }

    return { initialized: false, notified, errors };
}

!(async () => {
    log(`🔔 ${scriptName}, 开始!`);
    const startTime = Date.now();
    const tokens = getTokens('SDGUN');
    const accounts = tokens.map((token, index) => parseAccount(token, index + 1)).filter(Boolean);
    const users = getMonitorUsers();

    if (accounts.length === 0) {
        const msg = '⚠️ 未找到可用 SDGUN 账号';
        log(msg);
        await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
        return;
    }

    if (users.length === 0) {
        const msg = '⚠️ 未配置监控用户';
        log(msg);
        await sendTelegram(`<b>${scriptName}</b>\n${msg}`);
        return;
    }

    const state = loadState();
    const allErrors = [];
    let initializedCount = 0;
    let notifiedCount = 0;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        try {
            const result = await monitorUser(user, accounts, state);
            if (result.initialized) initializedCount++;
            notifiedCount += result.notified;
            allErrors.push(...result.errors);
        } catch (e) {
            const msg = `${user.name}(${user.userId}) 监控失败: ${e.message}`;
            allErrors.push(msg);
            log(`⚠️ ${msg}`);
        }

        if (i < users.length - 1) {
            await wait(5000);
        }
    }

    saveState(state);

    if (allErrors.length > 0) {
        await sendTelegram(`<b>${scriptName}</b>\n${allErrors.map(escapeHtml).join('\n')}`);
    } else if (notifiedCount === 0) {
        const initText = initializedCount > 0 ? `，初始化 ${initializedCount} 个用户基线` : '';
        log(`本次无新增通知${initText}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n🔔 ${scriptName}, 结束! 🕛 ${elapsed} 秒`);
})().catch(async (e) => {
    const msg = `⚠️ 脚本异常: ${e.message}`;
    log(msg);
    await sendTelegram(`<b>${scriptName}</b>\n${escapeHtml(msg)}`);
}).finally(() => process.exit(0));
