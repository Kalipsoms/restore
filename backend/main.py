import asyncio
import base64
import binascii
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from uuid import UUID
from xml.etree import ElementTree

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from . import config
from .integrations import Integrations, UpstreamError, check_init_data, update_crypto, valid_crypto_webhook
from .ratelimit import RateLimiter
from .store import Store

log = logging.getLogger('restore')


def deployment_pending():
    return bool(config.DEPLOY_GATE and Path(config.DEPLOY_GATE).is_file())


async def start_telegram_job(job):
    while deployment_pending():
        await asyncio.sleep(1)
    await job()


@asynccontextmanager
async def lifespan(app):
    store = app.state.store = Store(config.DATABASE_PATH)
    app.state.limiter = RateLimiter()
    async with httpx.AsyncClient(transport=getattr(app.state, 'transport', None)) as client:
        integrations = app.state.integrations = Integrations(client, store)
        background = []
        if config.BOT_TOKEN:
            background += [integrations.poll, integrations.deliver_messages]
        if crypto_enabled():
            background.append(integrations.reconcile_payments)
        jobs = [asyncio.create_task(start_telegram_job(job)) for job in background]
        try:
            yield
        finally:
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            store.db.close()


app = FastAPI(title='ReStore', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# (limit, window in seconds) per scope
LIMITS = {
    'api': ((300, 60),),
    'order': ((6, 60), (30, 3600)),
    'check': ((10, 60),),
    'webhook': ((120, 60),),
    'verify': ((1, 30),),
}


def throttle(request, scope, key):
    for limit, window in LIMITS[scope]:
        wait = request.app.state.limiter.retry_after((scope, window, key), limit, window)
        if wait:
            raise HTTPException(429, f'Слишком много запросов. Повторите через {wait} с.',
                                headers={'Retry-After': str(wait)})


def require_launch(request):
    status, result = check_init_data(request.headers.get('x-telegram-init-data', ''))
    if not result:
        expired = status == 'expired'
        raise HTTPException(401, {
            'message': ('Сессия истекла. Закройте ReStore и откройте его заново из чата с ботом.' if expired
                        else 'Откройте чат с ботом и нажмите «Открыть ReStore».'),
            'expired': expired,
            'botUrl': f'https://t.me/{config.BOT_USERNAME}' if config.BOT_USERNAME else '',
        })
    return result


def current_user(request):
    user, referral = require_launch(request)
    throttle(request, 'api', user['id'])
    return request.app.state.store.register_user(user, referral)


async def admin_only(request: Request):
    user = current_user(request)
    if user['id'] not in config.ADMIN_IDS:
        raise HTTPException(403, 'Доступ разрешён администраторам ReStore.')
    return user


def checkout_unavailable():
    if not config.OFFER_URL:
        return 'Оформление пока недоступно. Условия покупки ещё не опубликованы.'
    if not (config.BOT_TOKEN and config.PUBLIC_URL and config.MANAGER_USERNAME and config.ADMIN_CHATS):
        return 'Оформление заказа временно недоступно.'
    return ''


def crypto_enabled():
    return bool(config.PAY2328_PROJECT and config.PAY2328_API_KEY)


def order_view(row):
    settled = row['status'] in ('paid', 'installed')
    return {
        'id': row['id'], 'number': config.order_number(row['id']), 'title': row['title'], 'amount': row['amount'],
        'currency': row['currency'], 'method': row['method'], 'status': row['status'],
        'createdAt': row['created_at'].replace(' ', 'T') + 'Z',
        'paymentUrl': row['payment_url'] if row['status'] == 'pending' else None,
        'managerUrl': config.order_manager_link(row) if settled else None,
    }


@app.middleware('http')
async def response_headers(request, call_next):
    deployment_probe = request.method == 'GET' and (
        request.url.path == '/api/internal/deploy-ready'
        or (request.url.path == '/api/bootstrap' and not request.headers.get('x-telegram-init-data'))
    )
    if deployment_pending() and not deployment_probe:
        response = Response(status_code=503)
    else:
        response = await call_next(request)
    if 'cache-control' not in response.headers:
        response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.get('/api/bootstrap')
async def bootstrap(request: Request):
    user = current_user(request)
    store = request.app.state.store
    currency = 'RUB'
    checkout_error = checkout_unavailable()
    can_checkout = not checkout_error
    catalog = store.catalog()
    return {
        'catalog': catalog, 'currency': currency,
        'user': {'id': user['id'], 'name': user['name'], 'username': user['username'], 'photo': user['photo']},
        'balance': store.balance(user['id'], currency),
        'invited': store.invited_count(user['id']),
        'orders': [order_view(order) for order in store.orders(user['id'])],
        'referralPercent': store.referral_percent(),
        'referralUrl': f'https://t.me/{config.BOT_USERNAME}?start=ref_{user["id"]}' if config.BOT_USERNAME else '',
        'managerUrl': config.manager_link(), 'offerUrl': config.OFFER_URL,
        'isAdmin': user['id'] in config.ADMIN_IDS,
        'checkoutError': checkout_error,
        'methods': {'balance': can_checkout,
                    'crypto': can_checkout and crypto_enabled(), 'sbp': False},
    }


@app.get('/api/internal/deploy-ready')
async def deploy_ready(request: Request):
    if not deployment_pending():
        raise HTTPException(404)
    if not config.BOT_TOKEN:
        raise HTTPException(503, 'Telegram bot is not configured.')
    try:
        # An offset of zero leaves existing updates unacknowledged.
        updates = await request.app.state.integrations.telegram(
            'getUpdates', {'offset': 0, 'timeout': 0, 'limit': 1, 'allowed_updates': ['message']}, timeout=3,
        )
        if not isinstance(updates, list):
            raise UpstreamError('Unexpected Telegram getUpdates response')
    except UpstreamError:
        raise HTTPException(503, 'Telegram getUpdates is unavailable.') from None
    return {'ok': True}


class OrderInput(BaseModel):
    appId: int = Field(gt=0, le=2**53 - 1)
    requestId: UUID
    method: Literal['balance', 'crypto', 'sbp']
    amount: int = Field(gt=0, le=99_999_999)
    offerUrl: str = Field(min_length=1, max_length=2048)


@app.post('/api/orders')
async def start_order(request: Request, body: OrderInput):
    user = current_user(request)
    throttle(request, 'order', user['id'])
    if reason := checkout_unavailable():
        raise HTTPException(403, reason)
    if body.method == 'sbp' or (body.method == 'crypto' and not crypto_enabled()):
        raise HTTPException(403, 'Этот способ оплаты сейчас недоступен.')
    store = request.app.state.store
    currency = 'RUB'
    try:
        order = store.create_order(user['id'], body.appId, str(body.requestId), body.method, currency, body.amount, body.offerUrl)
        if order['method'] != 'balance':
            order = await request.app.state.integrations.invoice(order)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    except UpstreamError:
        raise HTTPException(502, 'Не удалось открыть счёт. Попробуйте ещё раз.') from None
    return order_view(order)


def own_order(request, order_id):
    user = current_user(request)
    order = request.app.state.store.order(order_id, user['id'])
    if not order:
        raise HTTPException(404, 'Заказ не найден.')
    return order


@app.get('/api/orders/{order_id}')
async def order_status(request: Request, order_id: int):
    return order_view(own_order(request, order_id))


@app.post('/api/orders/{order_id}/check')
async def check_order(request: Request, order_id: int):
    order = own_order(request, order_id)
    throttle(request, 'check', order['user_id'])
    integrations = request.app.state.integrations
    try:
        if order['method'] == 'crypto' and order['status'] == 'pending' and not order['payment_url']:
            if not config.PUBLIC_URL or not crypto_enabled():
                raise HTTPException(503, 'Восстановление счёта временно недоступно.')
            order = await integrations.invoice(order)
        elif order['method'] == 'crypto' and order['status'] in ('pending', 'verifying'):
            order = await integrations.refresh_crypto(order)
    except UpstreamError:
        log.warning('Не удалось сверить криптосчёт заказа %s', order_id)
        raise HTTPException(502, 'Не удалось проверить счёт. Попробуйте ещё раз.') from None
    return order_view(order)


@app.post('/api/webhooks/2328')
async def crypto_webhook(request: Request):
    throttle(request, 'webhook', request.client.host if request.client else '')
    raw = await request.body()
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(400, 'Invalid payload') from None
    store = request.app.state.store
    if not valid_crypto_webhook(payload, raw, request.headers.get('sign', '')):
        # The notification is not trusted, but it may still be a real one whose signature
        # format differs. Ask the provider directly instead of taking the payload on faith.
        ref = payload.get('order_id') if isinstance(payload, dict) else None
        order = store.by_ref(ref) if isinstance(ref, str) and crypto_enabled() else None
        if not order or order['method'] != 'crypto' or order['status'] in ('paid', 'installed'):
            raise HTTPException(401, 'Invalid signature')
        throttle(request, 'verify', order['id'])
        log.warning('Подпись уведомления 2328.io не подтверждена, сверяем заказ %s через API', order['id'])
        try:
            await request.app.state.integrations.refresh_crypto(order)
        except UpstreamError:
            raise HTTPException(502, 'Payment could not be verified') from None
        return {'ok': True}
    if not update_crypto(store, payload):
        log.warning('Получено уведомление 2328.io без подходящего заказа')
        raise HTTPException(409, 'Payment does not match an order')
    return {'ok': True}


@app.get('/api/icons/{app_id}')
async def icon(request: Request, app_id: int):
    require_launch(request)
    row = request.app.state.store.one('SELECT icon, icon_type, revision FROM apps WHERE id = ?', app_id)
    if not row:
        raise HTTPException(404)
    # Catalog links carry the revision, so a matching URL never changes and can be kept by the client.
    versioned = request.query_params.get('v') == str(row['revision'])
    etag = f'"{app_id}-{row["revision"]}"'
    headers = {
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        'Cache-Control': 'private, max-age=31536000, immutable' if versioned else 'private, no-cache',
        'ETag': etag,
    }
    if etag in request.headers.get('if-none-match', ''):
        return Response(status_code=304, headers=headers)
    return Response(row['icon'], media_type=row['icon_type'], headers=headers)


class AdminApp(BaseModel):
    title: str = Field(min_length=1, max_length=64)
    category: str = Field(min_length=1, max_length=32)
    description: str = Field(max_length=140)
    price: int = Field(gt=0, le=99_999_999)
    active: bool
    icon: str | None = Field(default=None, max_length=700000)


class ReferralInput(BaseModel):
    percent: int = Field(ge=0, le=100)


def decode_icon(encoded):
    try:
        data = base64.b64decode(encoded.partition(',')[2], validate=True)
        if data.startswith(b'\x89PNG\r\n\x1a\n'):
            return data, 'image/png'
        if data.startswith(b'\xff\xd8\xff'):
            return data, 'image/jpeg'
        if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
            return data, 'image/webp'
        svg = data.decode('utf-8-sig')
        if '<!doctype' not in svg.lower() and ElementTree.fromstring(svg).tag == '{http://www.w3.org/2000/svg}svg':
            return data, 'image/svg+xml'
    except (binascii.Error, UnicodeError, ElementTree.ParseError):
        pass
    raise HTTPException(422, 'Выберите корректную иконку SVG, PNG, JPEG или WebP.')


@app.get('/api/admin', dependencies=[Depends(admin_only)])
async def admin_summary(request: Request):
    store = request.app.state.store
    return {'catalog': store.catalog(admin=True), 'referralPercent': store.referral_percent()}


@app.get('/api/admin/orders', dependencies=[Depends(admin_only)])
async def admin_orders(request: Request,
                       status: Literal['pending', 'verifying', 'review', 'expired', 'paid', 'installed'] | None = None,
                       before: int | None = Query(None, gt=0, le=2**53 - 1),
                       order_id: int | None = Query(None, gt=0, le=2**53 - 1)):
    limit = 50
    rows = request.app.state.store.admin_orders(status, before, order_id, limit + 1)
    return {
        'orders': [dict(order_view(row), userName=row['user_name'], userUsername=row['user_username'])
                   for row in rows[:limit]],
        'nextBefore': rows[limit - 1]['id'] if len(rows) > limit else None,
    }


@app.post('/api/admin/orders/{order_id}/check', dependencies=[Depends(admin_only)])
async def admin_check_order(request: Request, order_id: int):
    order = request.app.state.store.admin_order(order_id)
    if not order or order['method'] != 'crypto':
        raise HTTPException(404, 'Криптозаказ не найден.')
    if order['status'] not in ('paid', 'installed'):
        try:
            order = await request.app.state.integrations.refresh_crypto(order)
        except UpstreamError:
            raise HTTPException(502, 'Не удалось сверить счёт с 2328.io. Попробуйте ещё раз.') from None
    return order_view(order)


@app.get('/api/admin/dashboard', dependencies=[Depends(admin_only)])
async def admin_dashboard(request: Request, days: int = Query(30, ge=7, le=90)):
    currency = 'RUB'
    return request.app.state.store.dashboard(days, currency)


def save_catalog_item(request, app_id, body):
    title, category = body.title.strip(), body.category.strip()
    if not title or not category:
        raise HTTPException(422, 'Заполните название и категорию.')
    if not app_id and not body.icon:
        raise HTTPException(422, 'Добавьте иконку приложения.')
    icon_data = decode_icon(body.icon) if body.icon else None
    values = title, category, body.description.strip(), body.price, body.active
    saved = request.app.state.store.save_app(app_id, values, icon_data)
    if not saved:
        raise HTTPException(404, 'Приложение не найдено.')
    return {'id': saved}


@app.post('/api/admin/apps', dependencies=[Depends(admin_only)])
async def create_app(request: Request, body: AdminApp):
    return save_catalog_item(request, None, body)


@app.put('/api/admin/apps/{app_id}', dependencies=[Depends(admin_only)])
async def edit_app(request: Request, app_id: int, body: AdminApp):
    return save_catalog_item(request, app_id, body)


@app.put('/api/admin/referral', dependencies=[Depends(admin_only)])
async def edit_referral(request: Request, body: ReferralInput):
    request.app.state.store.set_setting('referral_percent', body.percent)
    return {'ok': True}


@app.post('/api/admin/orders/{order_id}/install', dependencies=[Depends(admin_only)])
async def installed(request: Request, order_id: int):
    if not request.app.state.store.install(order_id):
        raise HTTPException(404, 'Оплаченный заказ не найден.')
    return {'ok': True}
