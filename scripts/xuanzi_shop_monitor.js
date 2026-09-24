/*
cron: 0 0,6,12,18 * * *
环境变量: XUANZI_WEIMOB  格式: 账号描述#x-wx-token  (单账号可只填 token)
说明: 监控萱子"会员俱乐部/积分兑好物"装修页, 检测热区商品是否有新上/下架, 变化时TG通知(附图)
其余商户参数(vid/bosId/pid/pageId 等)为固定常量, 已写死在脚本中
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
* new Env('萱子好物监控')
*/

const https = require('https');
const fs = require('fs');
const path = require('path');
const { log } = console;

const scriptName = '萱子好物监控';
const TG_BOT_TOKEN = process.env.LEOS_TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.LEOS_TG_CHAT_ID || '';

// ============ 固定常量 (取自 app-config.json / 抓包) ============
const HOST = 'xapi.weimob.com';
const API_PATH = '/api3/mp-decoration/web/page/queryPageInfo';
const APPID = 'wx82947e2e2d008f6d';
const VID = 6001394219686;
const BOS_ID = 4002534742686;
const PID = '100001345271';
const CID = 178603686;
const MERCHANT_ID = 2000059821686;
const CMS_PII = 2473289686; // cms productInstanceId
const EC_PII = 2473269686; // 商城 productInstanceId (用于详情链接)
const PAGE_ID = '84913012686'; // 会员俱乐部 页面ID
const SHOP_BIZCODE = '902D405FEEFE68DA';

// ============ 工具函数 ============

function httpPost(pathname, headers, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: HOST,
            path: pathname,
            method: 'POST',
            headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers),
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(data);
                }
            });
        });
        req.on('error', reject);
        req.write(body);
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
        const p = `/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${text}&parse_mode=HTML&disable_web_page_preview=true`;
        const req = https.request({ hostname: 'api.telegram.org', path: p, method: 'GET' }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (!j.ok) log(`⚠️ TG通知发送失败: ${j.description}`);
                } catch {}
                resolve();
            });
        });
        req.on('error', (e) => {
            log(`⚠️ TG通知异常: ${e.message}`);
            resolve();
        });
        req.end();
    });
}

// 发送图片(带说明)
function sendTelegramPhoto(photoUrl, caption) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return Promise.resolve();
    return new Promise((resolve) => {
        const p = `/bot${TG_BOT_TOKEN}/sendPhoto?chat_id=${TG_CHAT_ID}&photo=${encodeURIComponent(photoUrl)}&caption=${encodeURIComponent(caption || '')}&parse_mode=HTML`;
        const req = https.request({ hostname: 'api.telegram.org', path: p, method: 'GET' }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (!j.ok) log(`⚠️ TG图片发送失败: ${j.description}`);
                } catch {}
                resolve();
            });
        });
        req.on('error', (e) => {
            log(`⚠️ TG图片异常: ${e.message}`);
            resolve();
        });
        req.end();
    });
}

function getToken(envName) {
    let str = (process.env[envName] || '').trim();
    if (!str) return null;
    // 支持 账号#token 或 纯 token
    const idx = str.indexOf('#');
    if (idx > -1) {
        return { name: str.substring(0, idx) || '萱子', token: str.substring(idx + 1).trim() };
    }
    return { name: '萱子', token: str };
}

// ============ 请求 & 解析 ============

function buildBody() {
    return JSON.stringify({
        appid: APPID,
        basicInfo: {
            vid: VID, vidType: 2, bosId: BOS_ID, productId: 1,
            productInstanceId: CMS_PII, productVersionId: '38000',
            merchantId: MERCHANT_ID, tcode: 'weimob', cid: CID,
        },
        extendInfo: {
            wxTemplateId: 8306, analysis: [], bosTemplateId: 1000002354,
            childTemplateIds: [
                { customId: 90004, version: 'crm@0.1.106' },
                { customId: 90002, version: 'ec@90.4' },
                { customId: 90006, version: 'hudong@0.0.255' },
                { customId: 90008, version: 'cms@0.0.539' },
                { customId: 90070, version: '1.0.44' },
            ],
            quickdeliver: { enable: false }, youshu: { enable: false },
            source: 1, channelsource: 5, refer: 'cms-design', mpScene: 1007,
        },
        queryParameter: null,
        i18n: { language: 'zh', timezone: '8' },
        pid: PID, storeId: '0', bosId: BOS_ID,
        requestType: 1, pageSize: 10, pageNum: 1,
        exParams: { pageId: PAGE_ID }, jsonSwitch: true, pageId: PAGE_ID, $level: 1,
    });
}

function buildHeaders(token) {
    return {
        Host: HOST,
        'x-wx-token': token,
        'x-wmsdk-vid': String(VID),
        'x-req-from': 'cms_design',
        'x-biz-id': '1',
        'content-type': 'application/json',
        'x-component-is': 'cms_design/RAW/components/design/index',
        'weimob-bosid': String(BOS_ID),
        'wos-x-channel': '0:TITAN',
        'x-page-route': 'cms_design/design',
        'weimob-pid': PID,
        accept: '*/*',
        referer: `https://servicewechat.com/${APPID}/218/page-frame.html`,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 MicroMessenger/7.0.20.1781 MiniProgramEnv/Mac',
    };
}

function cleanName(s) {
    return (s || '').replace(/^商城-商品详情页-/, '').replace(/^商城-/, '').trim();
}

// 递归收集商品详情热区 -> { goodsId: name }
function collectGoods(obj, out) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const x of obj) collectGoods(x, out);
        return;
    }
    if (obj.refer === 'ec-goods-detail') {
        let gid = obj.bizParam && obj.bizParam.goodsId;
        if (!gid && obj.miniUrl) {
            const m = obj.miniUrl.match(/[?&]id=(\d+)/);
            if (m) gid = m[1];
        }
        if (gid) out[String(gid)] = cleanName(obj.linkName || obj.name || '');
    }
    for (const k in obj) collectGoods(obj[k], out);
}

// 递归收集装修图片
function collectImages(obj, out) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const x of obj) collectImages(x, out);
        return;
    }
    if (typeof obj.imageUrl === 'string' && obj.imageUrl.startsWith('http')) out.add(obj.imageUrl);
    for (const k in obj) collectImages(obj[k], out);
}

function goodsDetailUrl(goodsId) {
    return `https://${CID}.shop.n.weimob.com/bos/shop/${CID}/0/${EC_PII}/goods/detail/index?bizCode=${SHOP_BIZCODE}&id=${goodsId}`;
}

// ============ 快照存取 ============

const SNAP_FILE = path.join(__dirname, '.xuanzi_shop_goods.json');

function loadSnapshot() {
    try {
        return JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function saveSnapshot(snap) {
    fs.writeFileSync(SNAP_FILE, JSON.stringify(snap, null, 2));
}

// ============ 主流程 ============

!(async () => {
    log(`🔔 ${scriptName}, 开始!`);

    const acc = getToken('XUANZI_WEIMOB');
    if (!acc || !acc.token) {
        log('⚠️ 未配置环境变量 XUANZI_WEIMOB');
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 未配置环境变量 XUANZI_WEIMOB`);
        return;
    }

    let res;
    try {
        res = await httpPost(API_PATH, buildHeaders(acc.token), buildBody());
    } catch (e) {
        log(`请求异常: ${e.message}`);
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 请求异常: ${e.message}`);
        return;
    }

    if (!res || res.errcode !== 0 || !res.data) {
        const msg = res && res.errmsg ? res.errmsg : JSON.stringify(res).slice(0, 200);
        // 1041 等 = 登录态失效
        const hint = res && (res.errcode === 1041 || /登录/.test(msg)) ? '\n👉 x-wx-token 已失效，请打开小程序刷新后更新 XUANZI_WEIMOB' : '';
        log(`接口失败: ${msg}`);
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 接口失败: ${msg}${hint}`);
        return;
    }

    // 解析商品 + 图片
    const goods = {};
    collectGoods(res.data, goods);
    const imgSet = new Set();
    collectImages(res.data, imgSet);
    const images = [...imgSet];
    const image = images[0] || '';

    const ids = Object.keys(goods);
    log(`本次商品数: ${ids.length}`);
    ids.forEach((id) => log(`  ${id}  ${goods[id]}`));

    if (ids.length === 0) {
        log('未解析到商品，可能页面结构变化，跳过(不覆盖快照)');
        await sendTelegram(`<b>${scriptName}</b>\n⚠️ 未解析到商品，页面结构可能已变化，请检查`);
        return;
    }

    const prev = loadSnapshot();
    const nowSnap = { time: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), goods, image };

    // 首次运行：记录基线
    if (!prev || !prev.goods) {
        saveSnapshot(nowSnap);
        log('首次运行，已记录基线');
        await sendTelegram(`<b>${scriptName}</b>\n✅ 首次运行，已记录基线，当前 ${ids.length} 个商品\n后续有新上/下架会通知`);
        return;
    }

    const prevIds = Object.keys(prev.goods);
    const added = ids.filter((id) => !prevIds.includes(id));
    const removed = prevIds.filter((id) => !ids.includes(id));
    const imageChanged = prev.image && image && prev.image !== image;

    if (added.length === 0 && removed.length === 0 && !imageChanged) {
        log('无变化');
        saveSnapshot(nowSnap); // 更新时间戳
        return;
    }

    // 组织通知
    let msg = `<b>${scriptName}</b> 📢 检测到变化`;
    if (added.length) {
        msg += `\n\n🆕 <b>新上 ${added.length} 个:</b>`;
        added.forEach((id) => {
            msg += `\n• <a href="${goodsDetailUrl(id)}">${goods[id] || id}</a>`;
        });
    }
    if (removed.length) {
        msg += `\n\n❌ <b>下架 ${removed.length} 个:</b>`;
        removed.forEach((id) => {
            msg += `\n• ${prev.goods[id] || id}`;
        });
    }
    if (imageChanged) {
        msg += `\n\n🖼️ 装修图已更新`;
    }

    log(msg);

    // 有新上且装修图更新时，附图发送
    if (added.length && image) {
        await sendTelegramPhoto(image, `萱子好物上新 ${added.length} 个`);
    }
    await sendTelegram(msg);

    saveSnapshot(nowSnap);
    log('快照已更新');
})()
    .catch((e) => log(`⚠️ 脚本异常: ${e.message}`))
    .finally(() => process.exit(0));
