"""
cron: 50 7 * * *
环境变量: NODESEEK  格式: 账号描述#完整Cookie字符串  多账号用 @ 或换行分隔
示例: 账号1#session=2U6g...; pjwt=eyJp...; smac=1792...
      (至少包含 session、pjwt、smac, 登录后有效期约30天; cf_clearance 可不带)
可选环境变量: NODESEEK_UA  请求使用的User-Agent, 默认为 iPhone Chrome
可选环境变量: NODESEEK_IMPERSONATE  curl_cffi 模拟的TLS指纹, 默认 safari260_ios
可选环境变量: NODESEEK_REFRACT_VERSION  站点 sw.js 版本, 默认 0.3.34
可选环境变量: NODESEEK_PROXY  备用代理, 如 http://127.0.0.1:7890 或 socks5h://user:pass@host:1080
             默认直连; Cloudflare 偶尔按出口IP拦截(签到榜返回 Just a moment), 被拦时自动改走该代理重试
依赖: curl_cffi (青龙 -> 依赖管理 -> python3 添加 curl_cffi)
TG通知环境变量: LEOS_TG_BOT_TOKEN, LEOS_TG_CHAT_ID
new Env('NodeSeek签到')
"""

import hashlib
import json
import os
import random
import re
import time
import urllib.parse
import urllib.request

SCRIPT_NAME = 'NodeSeek签到'
TG_BOT_TOKEN = os.environ.get('LEOS_TG_BOT_TOKEN', '')
TG_CHAT_ID = os.environ.get('LEOS_TG_CHAT_ID', '')

BASE = 'https://www.nodeseek.com'
DEFAULT_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 '
              '(KHTML, like Gecko) CriOS/152.0.7977.151 Mobile/15E148 Safari/604.1')
USER_AGENT = os.environ.get('NODESEEK_UA') or DEFAULT_UA
IMPERSONATE = os.environ.get('NODESEEK_IMPERSONATE') or 'safari260_ios'
PROXY = (os.environ.get('NODESEEK_PROXY') or '').strip()

# refract 协议 (还原自 www.nodeseek.com/sw.js): 所有请求都要带签名头, 否则返回 403 Forbiden
REFRACT_VERSION = os.environ.get('NODESEEK_REFRACT_VERSION') or '0.3.34'
REFRACT_INIT_KEY = 'CHICZkKViFoZmVbIH1Y6'
REFRACT_MAX_RETRY = 3


# ============ 工具函数 ============

def log(msg):
    print(msg, flush=True)


def send_telegram(message):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        log('⚠️ 未配置TG环境变量，跳过通知')
        return
    try:
        query = urllib.parse.urlencode({'chat_id': TG_CHAT_ID, 'text': message, 'parse_mode': 'HTML'})
        url = f'https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage?{query}'
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if not data.get('ok'):
                log(f"⚠️ TG通知发送失败: {data.get('description')}")
    except Exception as e:
        log(f'⚠️ TG通知发送异常: {e}')


def notify(msg):
    send_telegram(f'<b>{SCRIPT_NAME}</b>\n{msg}')


def get_accounts(env_name, splitors=('@', '\n')):
    raw = os.environ.get(env_name, '')
    if not raw:
        log(f'⚠️ 未配置环境变量: {env_name}')
        return []
    splitor = splitors[0]
    for sp in splitors:
        if sp in raw:
            splitor = sp
            break
    accounts = [a for a in raw.split(splitor) if a.strip()]
    log(f'共 {len(accounts)} 个账号')
    return accounts


# ============ refract 客户端 ============

class RefractClient:
    def __init__(self, cookie, user_agent, proxy=''):
        from curl_cffi import requests as cffi_requests

        proxies = {'http': proxy, 'https': proxy} if proxy else None
        self.session = cffi_requests.Session(impersonate=IMPERSONATE, proxies=proxies)
        self.cookie = cookie
        self.user_agent = user_agent
        self.key = REFRACT_INIT_KEY

    # refract-sign = SHA1(method \n\n url \n\n UA \n\n body \n\n key)
    def sign(self, method, url, body):
        raw = '\n\n'.join([method, url, self.user_agent, body, self.key])
        return hashlib.sha1(raw.encode('utf-8')).hexdigest()

    def request(self, method, path, body=''):
        url = BASE + path
        resp = None
        for _ in range(REFRACT_MAX_RETRY):
            headers = {
                'accept': '*/*',
                'accept-language': 'zh-CN,zh-Hans;q=0.9',
                'cookie': self.cookie,
                'origin': BASE,
                'referer': f'{BASE}/sw.js?v={REFRACT_VERSION}',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'user-agent': self.user_agent,
                'refract-version': REFRACT_VERSION,
                'refract-key': self.key,
                'refract-sign': self.sign(method, url, body),
            }
            if method == 'POST':
                headers['content-type'] = 'text/plain;charset=UTF-8'

            resp = self.session.request(method, url, headers=headers,
                                        data=body.encode('utf-8') if method == 'POST' else None,
                                        timeout=20)

            # 服务端用 refract-key-update 下发新 key; 旧 key 请求会被 403, 换 key 后重试
            key_update = resp.headers.get('refract-key-update')
            if key_update and key_update != self.key:
                self.key = key_update
                if resp.status_code == 403:
                    continue
            return resp
        return resp

    # 用初始 key 请求 /edge-cgi/ping 换取会话 key
    def init(self):
        self.request('GET', '/edge-cgi/ping')
        return self.key != REFRACT_INIT_KEY


# ============ 签到逻辑 ============

def parse_json(resp):
    try:
        return resp.json()
    except Exception:
        return None


def is_cloudflare_challenge(resp):
    text = resp.text if resp is not None else ''
    return 'cf_chl' in text or 'Just a moment' in text


def mask_proxy(proxy):
    return re.sub(r'//[^@/]*@', '//***@', proxy)


def describe_failure(resp):
    if resp is None:
        return '无响应'
    if is_cloudflare_challenge(resp):
        if PROXY:
            return 'Cloudflare 人机验证拦截\n直连和 NODESEEK_PROXY 代理都被拦, 请更换代理节点'
        return ('Cloudflare 人机验证拦截\n'
                '青龙服务器出口IP被拦, 可配置 NODESEEK_PROXY 作为被拦时的备用代理')
    if resp.status_code == 403:
        return f'refract 校验失败 (403)\n站点 sw.js 可能已升级, 请检查 refract 版本 (当前 {REFRACT_VERSION})'
    data = parse_json(resp)
    if data and data.get('message'):
        return data['message']
    return f'HTTP {resp.status_code}: {resp.text.strip()[:100]}'


def get_attendance_board(client):
    resp = client.request('GET', '/api/attendance/board?page=1')
    log(f'签到榜响应: HTTP {resp.status_code} {resp.text[:200]}')
    return resp


def has_signed_today(board):
    return bool(board and board.get('record') and board['record'].get('id'))


def format_board_info(board):
    if not board or not board.get('record'):
        return ''
    parts = []
    if board['record'].get('gain') is not None:
        parts.append(f"今日收益: {board['record']['gain']} 个鸡腿")
    if board.get('order') is not None:
        parts.append(f"排名: {board['order']}")
    if board.get('total') is not None:
        parts.append(f"总人数: {board['total']}")
    return '\n'.join(parts)


def open_session(cookie, proxy):
    client = RefractClient(cookie, USER_AGENT, proxy)
    if client.init():
        log('refract 会话 key 获取成功')
    else:
        log('⚠️ 未获取到 refract 会话 key, 将直接尝试请求')
    return client, get_attendance_board(client)


def do_sign(name, cookie, index):
    log(f'======== 【{index}】 {name} ========')
    try:
        # 1. 查询签到榜, 判断今天是否已签到; 直连被 Cloudflare 拦时改走备用代理
        client, before_resp = open_session(cookie, '')
        if is_cloudflare_challenge(before_resp) and PROXY:
            log(f'⚠️ 直连被 Cloudflare 拦截, 改走代理 {mask_proxy(PROXY)} 重试')
            client, before_resp = open_session(cookie, PROXY)

        if is_cloudflare_challenge(before_resp) or before_resp.status_code == 403:
            msg = f'⚠️ {name} 查询签到榜失败: {describe_failure(before_resp)}'
            log(msg)
            notify(msg)
            return

        before_board = parse_json(before_resp)
        if has_signed_today(before_board):
            board_info = format_board_info(before_board)
            msg = f'ℹ️ {name} 今天已签到' + (f'\n{board_info}' if board_info else '')
            log(msg)
            notify(msg)
            return

        time.sleep(1)

        # 2. 签到
        sign_resp = client.request('POST', '/api/attendance?random=false')
        log(f'签到响应: HTTP {sign_resp.status_code} {sign_resp.text[:200]}')
        result = parse_json(sign_resp)

        if result and result.get('success'):
            board_info = ''
            try:
                time.sleep(1)
                board_info = format_board_info(parse_json(get_attendance_board(client)))
            except Exception as e:
                log(f'⚠️ 签到后查询榜单失败: {e}')
            msg = f"✅ {name} 签到成功!\n{result.get('message', '')}\n当前鸡腿: {result.get('current')}"
            if board_info:
                msg += f'\n{board_info}'
        elif result and result.get('message'):
            msg = f"ℹ️ {name} {result['message']}"
        else:
            msg = f'⚠️ {name} 签到失败: {describe_failure(sign_resp)}'
    except Exception as e:
        msg = f'⚠️ {name} 请求异常: {e}'

    log(msg)
    notify(msg)


# ============ 主流程 ============

def main():
    log(f'🔔 {SCRIPT_NAME}, 开始!')
    start = time.time()

    try:
        import curl_cffi  # noqa: F401
    except ImportError:
        msg = '⚠️ 缺少依赖 curl_cffi, 请在青龙 依赖管理 -> python3 中添加 curl_cffi'
        log(msg)
        notify(msg)
        return

    accounts = get_accounts('NODESEEK')
    if not accounts:
        notify('⚠️ 未配置环境变量 NODESEEK')
        return

    for i, account in enumerate(accounts):
        if '#' not in account:
            log(f'⚠️ 【{i + 1}】 格式错误，需要: 账号描述#Cookie字符串')
            continue
        name, cookie = account.split('#', 1)
        name, cookie = name.strip(), cookie.strip()
        if not name or not cookie:
            log(f'⚠️ 【{i + 1}】 格式错误，需要: 账号描述#Cookie字符串')
            continue

        do_sign(name, cookie, i + 1)

        if i < len(accounts) - 1:
            delay = random.uniform(2, 5)
            log(f'等待 {delay:.1f} 秒...')
            time.sleep(delay)

    log(f'\n🔔 {SCRIPT_NAME}, 结束! 🕛 {time.time() - start:.1f} 秒')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f'⚠️ 脚本异常: {e}')
        notify(f'⚠️ 脚本异常: {e}')
