import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import sqlite3
import time
from urllib.parse import parse_qsl, urlsplit

import httpx

from . import config

log = logging.getLogger('restore')


class UpstreamError(Exception):
    pass


INIT_DATA_TTL = 86400


def check_init_data(raw):
    """Return ('ok', (user, start_param)), ('expired', None) or ('invalid', None)."""
    if not config.BOT_TOKEN or not raw or len(raw) > 12000:
        return 'invalid', None
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True, max_num_fields=24)
        fields = dict(pairs)
        signature = fields.pop('hash', '')
        if len(pairs) != len(fields) + 1 or not re.fullmatch(r'[a-f0-9]{64}', signature):
            return 'invalid', None
        message = '\n'.join(f'{key}={fields[key]}' for key in sorted(fields)).encode()
        secret = hmac.digest(b'WebAppData', config.BOT_TOKEN.encode(), 'sha256')
        if not hmac.compare_digest(hmac.new(secret, message, hashlib.sha256).hexdigest(), signature):
            return 'invalid', None
        age = time.time() - int(fields['auth_date'])
        if age > INIT_DATA_TTL:
            return 'expired', None
        if age < -60:
            return 'invalid', None
        user = json.loads(fields['user'])
        if not isinstance(user['id'], int) or not 0 < user['id'] < 2**52:
            return 'invalid', None
        return 'ok', (user, fields.get('start_param', ''))
    except (KeyError, TypeError, ValueError):
        return 'invalid', None


def validate_init_data(raw):
    return check_init_data(raw)[1]


def compact_json(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()


def crypto_sign(data):
    return hmac.new(config.PAY2328_API_KEY.encode(), base64.b64encode(data), hashlib.sha256).hexdigest()


SIGN_MEMBER = re.compile(rb'"sign"\s*:\s*"[a-f0-9]{64}"')


def webhook_bodies(payload, raw):
    """Serialisations of the notification that the provider may have signed.

    Re-encoding parsed JSON can change number formatting and escaping, so the
    original bytes are tried first and the re-encoded forms cover providers that
    sign the document before adding the signature field.
    """
    data = {key: value for key, value in payload.items() if key != 'sign'}
    bodies = []
    if raw:
        bodies.append(raw)
        for pattern in (rb',\s*' + SIGN_MEMBER.pattern, SIGN_MEMBER.pattern + rb'\s*,', SIGN_MEMBER.pattern):
            stripped, count = re.subn(pattern, b'', raw, count=1)
            if count:
                bodies.append(stripped)
                break
    for ascii_only in (False, True):
        encoded = json.dumps(data, ensure_ascii=ascii_only, separators=(',', ':')).encode()
        bodies += [encoded, encoded.replace(b'/', b'\\/')]
    return list(dict.fromkeys(bodies))


def valid_crypto_webhook(payload, raw=b'', header_signature=''):
    if not config.PAY2328_API_KEY or not isinstance(payload, dict):
        return False
    signatures = [value.lower() for value in (payload.get('sign'), header_signature)
                  if isinstance(value, str) and re.fullmatch(r'[a-fA-F0-9]{64}', value)]
    if not signatures:
        return False
    expected = [crypto_sign(body) for body in webhook_bodies(payload, raw)]
    return any(hmac.compare_digest(signature, candidate) for signature in signatures for candidate in expected)


def rub_minor(value):
    match = re.fullmatch(r'(\d{1,9})(?:\.(\d{1,2})0*)?', str(value))
    if not match:
        return None
    return int(match[1]) * 100 + int((match[2] or '').ljust(2, '0'))


def update_crypto(store, payload):
    ref, payment_id = payload.get('order_id'), payload.get('uuid')
    if not isinstance(ref, str) or not isinstance(payment_id, str) or not payment_id:
        return False
    order = store.by_ref(ref)
    amount = rub_minor(payload.get('amount'))
    if (not order or order['method'] != 'crypto' or payload.get('currency') != order['currency']
            or amount != order['amount'] or order['payment_id'] not in (None, payment_id)):
        return False
    status = payload.get('payment_status')
    if status in ('paid', 'overpaid'):
        return bool(store.settle_payment(ref, 'crypto', 'RUB', amount, payment_id))
    states = {'awaiting_confirmation': 'verifying', 'underpaid_check': 'verifying', 'underpaid': 'review',
              'aml_lock': 'review', 'cancel': 'expired', 'fail': 'review'}
    if not isinstance(status, str):
        return False
    if status in states:
        store.crypto_status(order, states[status], payment_id)
        return True
    return status in ('pending', 'check', 'refund_process', 'refund_fail', 'refund_paid')


class Integrations:
    def __init__(self, client, store):
        self.client = client
        self.store = store

    async def telegram(self, method, data, timeout=12):
        try:
            response = await self.client.post(f'https://api.telegram.org/bot{config.BOT_TOKEN}/{method}', json=data, timeout=timeout)
            body = response.json()
            if (response.is_success and isinstance(body, dict) and body.get('ok') is True
                    and 'result' in body):
                return body['result']
        except (httpx.HTTPError, ValueError):
            pass
        raise UpstreamError(f'Telegram Bot API: {method}')

    async def discover_bot_settings(self):
        try:
            bot = await self.telegram('getMe', {}, timeout=5)
            name = bot.get('username') if isinstance(bot, dict) else None
            if isinstance(name, str) and (username := config.username(name)):
                config.BOT_USERNAME = username
        except UpstreamError:
            log.warning('Не удалось получить имя бота через getMe')

        if not config.PUBLIC_URL:
            try:
                menu = await self.telegram('getChatMenuButton', {}, timeout=5)
                web_app = menu.get('web_app') if isinstance(menu, dict) and menu.get('type') == 'web_app' else None
                url = web_app.get('url') if isinstance(web_app, dict) else None
                if isinstance(url, str):
                    config.PUBLIC_URL = config.public_origin(url)
            except UpstreamError:
                log.warning('Не удалось получить адрес Mini App из меню Telegram')

    async def crypto(self, route, data):
        raw = compact_json(data)
        try:
            response = await self.client.post(f'https://api.2328.io/api/v1/{route}', content=raw, headers={
                'Content-Type': 'application/json', 'Project': config.PAY2328_PROJECT,
                'Sign': crypto_sign(raw), 'User-Agent': 'ReStore/1.0',
            }, timeout=12)
            body = response.json()
            if (response.is_success and isinstance(body, dict) and body.get('state') == 0
                    and isinstance(body.get('result'), dict)):
                return body['result']
        except (httpx.HTTPError, ValueError):
            pass
        raise UpstreamError(f'2328.io: {route}')

    async def invoice(self, order):
        if order['method'] != 'crypto' or order['payment_url'] or order['status'] != 'pending':
            return order
        result = await self.crypto('payment', {
            'amount': f'{order["amount"] // 100}.{order["amount"] % 100:02d}', 'currency': 'RUB',
            'order_id': order['ref'], 'description': f'ReStore {config.order_number(order["id"])}',
            'url_callback': f'{config.PUBLIC_URL}/api/webhooks/2328',
        })
        raw_url = result.get('url')
        url = config.https_url(raw_url) if isinstance(raw_url, str) else ''
        host = urlsplit(url).hostname or ''
        if result.get('order_id') != order['ref'] or not url or (host != '2328.io' and not host.endswith('.2328.io')) or not update_crypto(self.store, result):
            raise UpstreamError('2328.io: invalid invoice response')
        return self.store.save_invoice(order, url, result['uuid'])

    async def refresh_crypto(self, order):
        result = await self.crypto('payment/info', {'order_id': order['ref']})
        if result.get('order_id') != order['ref'] or not update_crypto(self.store, result):
            raise UpstreamError('2328.io: payment does not match order')
        return self.store.order(order['id'], order['user_id'])

    async def reconcile_payments(self, interval=30, clock=time.monotonic):
        """Confirm crypto payments from the provider when a webhook is lost or rejected."""
        schedule = {}
        while True:
            try:
                now = clock()
                orders = self.store.open_crypto_orders()
                open_ids = {order['id'] for order in orders}
                for order_id in list(schedule):
                    if order_id not in open_ids:
                        del schedule[order_id]
                for order in orders:
                    attempts, due = schedule.get(order['id'], (0, now + 60))
                    if due > now:
                        schedule.setdefault(order['id'], (attempts, due))
                        continue
                    schedule[order['id']] = (attempts + 1, now + min(1800, 60 * 2 ** min(attempts, 5)))
                    try:
                        await self.refresh_crypto(order)
                    except UpstreamError:
                        log.warning('Не удалось сверить криптосчёт заказа %s', order['id'])
            except sqlite3.OperationalError:
                log.exception('Сверка криптоплатежей временно недоступна')
            except Exception as exc:
                log.warning('Ошибка сверки криптоплатежей: %s', type(exc).__name__)
            await asyncio.sleep(interval)

    async def send_message(self, chat_id, text, button=None):
        data = {'chat_id': chat_id, 'text': text}
        if button:
            data['reply_markup'] = {'inline_keyboard': [[button]]}
        return await self.telegram('sendMessage', data)

    def handle_update(self, update):
        message = update.get('message')
        if not message or message['chat']['type'] != 'private':
            return
        user, chat_id = message.get('from'), str(message['chat']['id'])
        command, _, parameter = message.get('text', '').partition(' ')
        command = command.split('@', 1)[0]
        if command == '/start' and user:
            self.store.register_user(user, parameter.strip())
            button = {'text': 'Открыть ReStore', 'web_app': {'url': config.PUBLIC_URL}} if config.PUBLIC_URL else None
            text = ('Добро пожаловать в ReStore. Поможем установить на iPhone приложения, которые пропали из App Store.\n\n'
                    'Откройте каталог, чтобы посмотреть доступные приложения.')
            if not button:
                text = 'Добро пожаловать в ReStore. Каталог скоро откроется.'
        elif command == '/admin' and user and str(user['id']) in config.ADMIN_IDS:
            button = {'text': 'Открыть админку', 'web_app': {'url': f'{config.PUBLIC_URL}/admin'}} if config.PUBLIC_URL else None
            text = 'Управление приложениями, реферальной программой и заказами ReStore.'
        elif command in ('/paysupport', '/help'):
            url = config.manager_link()
            button = {'text': 'Написать менеджеру', 'url': url} if url else None
            text = ('Если возник вопрос по оплате, укажите номер заказа в сообщении менеджеру.'
                    if url else 'Поддержка пока недоступна.')
        else:
            return
        self.store.queue_command(update['update_id'], chat_id, text, compact_json(button).decode() if button else None)

    async def poll(self):
        next_discovery = 0
        while True:
            try:
                if asyncio.get_running_loop().time() >= next_discovery:
                    await self.discover_bot_settings()
                    next_discovery = (asyncio.get_running_loop().time() + 60
                                      if not config.BOT_USERNAME or not config.PUBLIC_URL else float('inf'))
                offset = int(self.store.setting('telegram_offset', 0))
                updates = await self.telegram('getUpdates', {
                    'offset': offset, 'timeout': 25, 'allowed_updates': ['message'],
                }, timeout=32)
                for update in updates:
                    with self.store.transaction():
                        self.handle_update(update)
                        self.store.set_setting('telegram_offset', update['update_id'] + 1)
            except Exception as exc:
                log.warning('Ошибка обработки Telegram: %s', type(exc).__name__)
                await asyncio.sleep(3)

    async def deliver_messages(self):
        while True:
            try:
                messages = self.store.due_messages() + self.store.due_commands()
                for message in messages:
                    button = json.loads(message['button']) if message['button'] else None
                    if message['button_url']:
                        button = {'text': 'Написать менеджеру', 'url': message['button_url']}
                    try:
                        await self.send_message(message['chat_id'], message['text'], button)
                    except UpstreamError:
                        attempts = message['attempts'] + 1
                        self.store.retry_message(message, attempts, min(3600, 2**min(attempts, 12)))
                        log.warning('Повтор отправки сообщения Telegram %s', message['id'])
                    else:
                        while True:
                            try:
                                self.store.finish_message(message)
                                break
                            except sqlite3.OperationalError:
                                log.exception('Не удалось отметить отправку сообщения Telegram %s', message['id'])
                                await asyncio.sleep(3)
            except sqlite3.OperationalError:
                log.exception('Очередь Telegram временно недоступна')
                await asyncio.sleep(3)
            await asyncio.sleep(1)
