/*
cron: 0 0,3,6,9,12,15,18,21 * * *
环境变量: XUANZI_WEIMOB  格式: 账号描述#x-wx-token  多账号用 @ 或换行分隔(每次运行轮换一个)
说明: 监控萱子"会员俱乐部/积分兑好物"装修页, 检测热区商品是否有新上/下架, 变化时Bark通知(附图)
其余商户参数(vid/bosId/pid/pageId 等)为固定常量, 已写死在脚本中
Bark通知环境变量: LEOS_BARK_KEY  (多设备用 , 换行 或 @ 分隔)
* new Env('萱子好物监控')
*/

const https = require('https');
const fs = require('fs');
const path = require('path');
const { log } = console;

const scriptName = '萱子好物监控';
const BARK_KEY = process.env.LEOS_BARK_KEY || ''; // 多设备用 , 换行 或 @ 分隔

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

// HTML → 纯文本 (Bark 不支持HTML), 链接转成 "文字 URL"
function htmlToText(s) {
    return String(s)
        .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, '$2 $1')
        .replace(/<[^>]+>/g, '');
}

// Bark 推送: LEOS_BARK_KEY 支持多设备(, 换行 @ 分隔), 每个可为设备key或完整URL
// image 可选, 传商品/装修图 URL 时 Bark 会展示大图
function sendBark(title, body, image) {
    if (!BARK_KEY) {
        log('⚠️ 未配置环境变量 LEOS_BARK_KEY，跳过通知');
        return Promise.resolve();
    }
    const keys = BARK_KEY.split(/[,\n@]/).map((s) => s.trim()).filter(Boolean);
    return Promise.all(keys.map((k) => new Promise((resolve) => {
        const base = /^https?:\/\//.test(k) ? k.replace(/\/+$/, '') : `https://api.day.app/${k}`;
        let link = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('萱子')}`;
        if (image) link += `&image=${encodeURIComponent(image)}`;
        const u = new URL(link);
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
        });
        req.on('error', (e) => {
            log(`⚠️ Bark通知异常: ${e.message}`);
            resolve();
        });
        req.end();
    })));
}

// 统一通知: 仅 Bark
function notify(message, image) {
    return sendBark(scriptName, htmlToText(message), image);
}

// 解析多账号: 账号#token, 用 @ 或换行分隔
function getAccounts(envName) {
    const str = (process.env[envName] || '').trim();
    if (!str) return [];
    const splitor = str.indexOf('@') > -1 ? '@' : '\n';
    return str.split(splitor).map((s) => s.trim()).filter(Boolean).map((line) => {
        const idx = line.indexOf('#');
        if (idx > -1) return { name: line.substring(0, idx) || '萱子', token: line.substring(idx + 1).trim() };
        return { name: '萱子', token: line };
    }).filter((a) => a.token);
}

// 轮换状态: 记录下次起始账号下标, 每次运行 +1
const ROTATE_FILE = path.join(__dirname, '.xuanzi_shop_rotate.json');

function loadRotateIndex() {
    try {
        return JSON.parse(fs.readFileSync(ROTATE_FILE, 'utf8')).index || 0;
    } catch {
        return 0;
    }
}

function saveRotateIndex(index) {
    try {
        fs.writeFileSync(ROTATE_FILE, JSON.stringify({ index }));
    } catch {}
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

    const accounts = getAccounts('XUANZI_WEIMOB');
    if (accounts.length === 0) {
        log('⚠️ 未配置环境变量 XUANZI_WEIMOB');
        await notify(`<b>${scriptName}</b>\n⚠️ 未配置环境变量 XUANZI_WEIMOB`);
        return;
    }

    // 轮换起始账号: 这次用一个, 下次用下一个
    const start = loadRotateIndex() % accounts.length;
    saveRotateIndex((start + 1) % accounts.length);
    log(`共 ${accounts.length} 个账号, 本次从第 ${start + 1} 个开始`);

    // 从起始账号起依次尝试, 直到某个 token 成功 (失效则自动换下一个)
    let res = null;
    let usedName = '';
    const failed = [];
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[(start + i) % accounts.length];
        let r;
        try {
            r = await httpPost(API_PATH, buildHeaders(acc.token), buildBody());
        } catch (e) {
            log(`【${acc.name}】请求异常: ${e.message}`);
            failed.push(`${acc.name}(异常)`);
            continue;
        }
        if (r && r.errcode === 0 && r.data) {
            res = r;
            usedName = acc.name;
            log(`【${acc.name}】拉取成功`);
            break;
        }
        const emsg = r && r.errmsg ? r.errmsg : JSON.stringify(r).slice(0, 120);
        log(`【${acc.name}】失败: ${emsg}`);
        failed.push(`${acc.name}(${emsg})`);
    }

    if (!res) {
        const hint = failed.some((f) => /登录|1041/.test(f)) ? '\n👉 x-wx-token 已失效，请打开小程序刷新后更新 XUANZI_WEIMOB' : '';
        await notify(`<b>${scriptName}</b>\n⚠️ 全部账号拉取失败:\n${failed.join('\n')}${hint}`);
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
        await notify(`<b>${scriptName}</b>\n⚠️ 未解析到商品，页面结构可能已变化，请检查`);
        return;
    }

    const prev = loadSnapshot();
    const nowSnap = { time: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), goods, image };

    // 首次运行：记录基线
    if (!prev || !prev.goods) {
        saveSnapshot(nowSnap);
        log('首次运行，已记录基线');
        await notify(`<b>${scriptName}</b>\n✅ 首次运行，已记录基线，当前 ${ids.length} 个商品\n后续有新上/下架会通知`);
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
    msg += `\n\n<i>数据账号: ${usedName}</i>`;

    log(msg);

    // 有新上时附装修图一起推送
    await notify(msg, added.length && image ? image : '');

    saveSnapshot(nowSnap);
    log('快照已更新');
})()
    .catch((e) => log(`⚠️ 脚本异常: ${e.message}`))
    .finally(() => process.exit(0));
