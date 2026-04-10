/***********************************************
> 应用名称：菜鸟净化[原菜鸟裹裹]
> 脚本作者：@ddgksf2013
> 微信账号：墨鱼手记
> 更新时间：2025-04-07
> 通知频道：https://t.me/ddgksf2021
> 特别提醒：如需转载请注明出处，谢谢合作！
***********************************************/

const version = 'V1.0.21';

const ddgksf2013 = JSON.parse($response.body);
const url = $request.url;

if (url.indexOf("mtop.cainiao.nbpresentation.protocol.homepage.get.cn") !== -1) {
    // 首页惊喜福利推广
    if (ddgksf2013.data?.result?.dataList?.length > 0) {
        ddgksf2013.data.result.dataList = ddgksf2013.data.result.dataList.filter(
            a => !(a.type === "big_banner_area_v870" || a.type === "todo_list_v860")
        );
    }
} else if (url.indexOf("mtop.cainiao.app.e2e.engine") !== -1) {
    // 我的页面去除推广
    const keysToRemove = ["banner", "activity", "asset", "vip", "wallet"];
    for (const key of keysToRemove) {
        if (ddgksf2013.data?.data?.[key]) {
            delete ddgksf2013.data.data[key];
        }
    }
} else if (url.indexOf("mtop.cainiao.nbpresentation.homepage.merge.get.cn") !== -1) {
    // 首页中部的问邻居推广
    for (let i = 0; i < 4; i++) {
        const key = `mtop.cainiao.nbpresentation.protocol.homepage.get.cn@${i}`;
        if (ddgksf2013.data?.[key]?.data?.result?.dataList?.length > 0) {
            ddgksf2013.data[key].data.result.dataList = ddgksf2013.data[key].data.result.dataList.filter(
                a => !(a.type === "big_banner_area_v870" || a.type === "todo_list_v860")
            );
        }
    }
} else if (url.indexOf("mtop.cainiao.guoguo.nbnetflow.ads.mshow") !== -1) {
    // 通用广告mshow
    if (ddgksf2013.data["1308"]) delete ddgksf2013.data["1308"];
    if (ddgksf2013.data["1275"]) delete ddgksf2013.data["1275"];
    if (ddgksf2013.data["205"]) delete ddgksf2013.data["205"];
} else if (url.indexOf("mtop.cainiao.guoguo.nbnetflow.ads.index.cn") !== -1) {
    // 通用广告index
    if (ddgksf2013.data?.result) {
        ddgksf2013.data.result = [{}];
    }
} else if (url.indexOf("mtop.cainiao.adkeyword") !== -1) {
    // 搜索框今日好物
    if (ddgksf2013.data?.result?.adHotKeywords) {
        ddgksf2013.data.result.adHotKeywords = [];
    }
}

const body = JSON.stringify(ddgksf2013);
$done({ body });
