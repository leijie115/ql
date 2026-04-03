/**
 * 皮皮虾 Feed 数据抓取
 * 拦截推荐流接口，自动拉取评论，上报到本地 ppx 服务器
 * 配合 ppx.plugin 使用，参数通过 [Argument] 配置
 */

const $ = {
  notify: (title, subtitle, body) => $notification.post(title, subtitle, body),
  done: () => $done({}),
  get: (opts) =>
    new Promise((resolve, reject) =>
      $httpClient.get(opts, (err, resp, data) =>
        err ? reject(err) : resolve({ status: resp.status, body: data })
      )
    ),
  post: (opts) =>
    new Promise((resolve, reject) =>
      $httpClient.post(opts, (err, resp, data) =>
        err ? reject(err) : resolve({ status: resp.status, body: data })
      )
    ),
};

function sendTG(botToken, chatId, text) {
  if (!botToken || !chatId) return Promise.resolve();
  return $.get({
    url: `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML`,
  }).catch(() => {});
}

(async () => {
  const serverUrl = $argument.server_url || '';
  const tgBotToken = $argument.tg_bot_token || '';
  const tgChatId = $argument.tg_chat_id || '';

  // 调试：确认脚本被触发
  $.notify('皮皮虾', '脚本触发 ✅', `serverUrl=${serverUrl}`);

  if (!serverUrl) {
    $.notify('皮皮虾', '配置缺失 ❌', '请在插件参数中填写服务器地址');
    return $.done();
  }

  try {
    const feedData = JSON.parse($response.body);
    const reqHeaders = $request.headers;

    // 从请求 URL 中提取设备参数，供评论接口使用
    const reqUrl = $request.url;
    const deviceId = (reqUrl.match(/device_id=([^&]+)/) || [])[1] || '';
    const aid = (reqUrl.match(/aid=([^&]+)/) || [])[1] || '1319';
    const versionCode = (reqUrl.match(/version_code=([^&]+)/) || [])[1] || '';

    const items = (feedData.data && feedData.data.data) || [];

    // 调试：显示数据量
    $.notify('皮皮虾', '数据解析 ✅', `共 ${items.length} 条，符合条件 ${items.filter(cell => cell.cell_type === 1 && cell.item && cell.item.stats && cell.item.stats.comment_count > 5 && cell.item.note && cell.item.note.multi_image && cell.item.note.multi_image.length > 0).length} 条`);

    // 只处理：图文帖(cell_type=1)、有多图、评论数 > 5
    const targets = items.filter(
      (cell) =>
        cell.cell_type === 1 &&
        cell.item &&
        cell.item.stats &&
        cell.item.stats.comment_count > 5 &&
        cell.item.note &&
        cell.item.note.multi_image &&
        cell.item.note.multi_image.length > 0
    );

    if (targets.length === 0) return $.done();

    let successCount = 0;
    let failCount = 0;

    for (const cell of targets) {
      const item = cell.item;
      try {
        // 拉取评论列表
        const commentUrl =
          `https://api5-hl.pipix.com/bds/cell/cell_comment/` +
          `?offset=0&cell_type=${cell.cell_type}&api_version=1` +
          `&cell_id=${cell.cell_id_str}` +
          `&device_id=${deviceId}&ac=wifi&aid=${aid}` +
          `&app_name=super&version_code=${versionCode}`;

        const commentResp = await $.get({ url: commentUrl, headers: reqHeaders });
        const commentData = JSON.parse(commentResp.body);
        const cellComments = (commentData.data && commentData.data.cell_comments) || [];

        const comments = cellComments
          .map((c) => ({
            id: c.comment_info.comment_id_str,
            text: c.comment_info.text,
          }))
          .filter((c) => c.text && c.text.indexOf('type=1') === -1);

        if (comments.length < 5) {
          $.notify('皮皮虾', '评论不足', `cell=${cell.cell_id_str} cellComments=${cellComments.length} filtered=${comments.length} raw=${commentResp.body.substring(0, 100)}`);
          continue;
        }

        const images = item.note.multi_image.map((m) => ({
          url:
            (m.download_list && m.download_list[0] && m.download_list[0].url) ||
            (m.url_list && m.url_list[0] && m.url_list[0].url) ||
            '',
          is_gif: m.is_gif,
        })).filter((m) => m.url);

        $.notify('皮皮虾', 'images调试', `第一条url前50: ${images[0] ? images[0].url.substring(0, 50) : '空'}`);

        await $.post({
          url: serverUrl + '/collect',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: item.item_id_str,
            images,
            comments,
          }),
        });

        successCount++;
      } catch (e) {
        failCount++;
        console.log(`[PPX] ${cell.cell_id_str} 失败: ${e.message || e}`);
      }
    }

    const msg = `上报 ${successCount} 条，失败 ${failCount} 条`;
    if (successCount > 0) {
      $.notify('皮皮虾', 'Feed 抓取完成 ✅', msg);
      await sendTG(tgBotToken, tgChatId, `皮皮虾 Feed 抓取\n${msg}`);
    }
  } catch (e) {
    $.notify('皮皮虾', '脚本异常 ❌', e.message || e);
    await sendTG(tgBotToken, tgChatId, `皮皮虾脚本异常: ${e.message || e}`);
  }

  $.done();
})();
