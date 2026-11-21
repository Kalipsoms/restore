import asyncio
import json
import uuid

import httpx
import pytest

from backend import integrations
from backend.ratelimit import RateLimiter
from backend.store import Store

from .conftest import ADMIN_ID, PNG, auth, order_body, sign

USER = 2002
FRIEND = 3003


def new_id():
    return str(uuid.uuid4())


# --- Launch data and sessions -------------------------------------------------

def test_bootstrap_requires_signed_launch_data(client):
    assert client.get('/api/bootstrap').status_code == 401
    forged = client.get('/api/bootstrap', headers=auth(USER, token='999:OTHER'))
    assert forged.status_code == 401
    assert forged.json()['detail']['expired'] is False


def test_expired_launch_data_is_reported_as_expired(client):
    response = client.get('/api/bootstrap', headers=auth(USER, age=86400 + 5))
    assert response.status_code == 401
    detail = response.json()['detail']
    assert detail['expired'] is True
    assert 'Сессия истекла' in detail['message']
    assert detail['botUrl'] == 'https://t.me/restore_bot'


def test_bootstrap_returns_profile_and_catalog(client, catalog):
    data = client.get('/api/bootstrap', headers=auth(USER)).json()
    assert data['user']['id'] == str(USER)
    assert [app['title'] for app in data['catalog']] == ['Spotify']
    assert data['methods'] == {'balance': True, 'crypto': True, 'sbp': False}
    assert data['isAdmin'] is False


def test_known_user_requests_do_not_write(client, store):
    client.get('/api/bootstrap', headers=auth(USER))
    before = store.changes()
    for _ in range(5):
        assert client.get('/api/bootstrap', headers=auth(USER)).status_code == 200
    assert store.changes() == before
    # A changed profile is still saved.
    client.get('/api/bootstrap', headers=auth(USER, name='Пётр'))
    assert store.one('SELECT name FROM users WHERE id = ?', str(USER))['name'] == 'Пётр'


def test_referrer_is_recorded_on_first_launch_only(client, store):
    client.get('/api/bootstrap', headers=auth(USER))
    client.get('/api/bootstrap', headers=auth(FRIEND, start_param=f'ref_{USER}'))
    client.get('/api/bootstrap', headers=auth(FRIEND, start_param=f'ref_{ADMIN_ID}'))
    assert store.one('SELECT referrer FROM users WHERE id = ?', str(FRIEND))['referrer'] == str(USER)
    assert client.get('/api/bootstrap', headers=auth(USER)).json()['invited'] == 1


# --- Icons --------------------------------------------------------------------

def test_icons_are_cacheable_and_private(client, catalog):
    assert client.get(f'/api/icons/{catalog}?v=1').status_code == 401
    response = client.get(f'/api/icons/{catalog}?v=1', headers=auth(USER))
    assert response.content == PNG
    assert response.headers['content-type'] == 'image/png'
    assert response.headers['cache-control'] == 'private, max-age=31536000, immutable'
    cached = client.get(f'/api/icons/{catalog}?v=1', headers={**auth(USER), 'If-None-Match': response.headers['etag']})
    assert cached.status_code == 304
    assert cached.content == b''
    stale = client.get(f'/api/icons/{catalog}?v=99', headers=auth(USER))
    assert stale.headers['cache-control'] == 'private, no-cache'


def test_other_api_responses_are_not_cached(client):
    assert client.get('/api/bootstrap', headers=auth(USER)).headers['cache-control'] == 'no-store'


# --- Orders paid from the bonus balance ----------------------------------------

def test_balance_order_is_charged_once_per_request(client, store, catalog):
    client.get('/api/bootstrap', headers=auth(USER))
    store.credit(str(USER), 'RUB', 100000)
    body = order_body(catalog, 'balance')
    first = client.post('/api/orders', headers=auth(USER), json=body)
    assert first.status_code == 200 and first.json()['status'] == 'paid'
    retry = client.post('/api/orders', headers=auth(USER), json=body)
    assert retry.json()['id'] == first.json()['id']
    assert store.balance(str(USER), 'RUB') == 51000


def test_repeated_balance_purchase_with_new_request_id_is_rejected(client, store, catalog):
    client.get('/api/bootstrap', headers=auth(USER))
    store.credit(str(USER), 'RUB', 100000)
    assert client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'balance')).status_code == 200
    duplicate = client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'balance', new_id()))
    assert duplicate.status_code == 409
    assert store.balance(str(USER), 'RUB') == 51000
    assert store.one('SELECT count(*) FROM orders')[0] == 1
    # Outside the protection window a deliberate second purchase works again.
    store.run("UPDATE orders SET created_at = datetime('now', '-10 minutes')")
    assert client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'balance', new_id())).status_code == 200
    assert store.balance(str(USER), 'RUB') == 2000


def test_balance_order_needs_enough_bonuses_and_current_price(client, store, catalog):
    assert client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'balance')).status_code == 409
    wrong_price = client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'crypto', amount=100))
    assert wrong_price.status_code == 409
    assert store.one('SELECT count(*) FROM orders')[0] == 0


def test_sbp_is_rejected(client, catalog):
    assert client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'sbp')).status_code == 403


# --- Crypto orders and payment confirmation -----------------------------------

def create_crypto_order(client, store, catalog, user=USER, request_id=None):
    response = client.post('/api/orders', headers=auth(user), json=order_body(catalog, 'crypto', request_id or new_id()))
    assert response.status_code == 200, response.text
    order = response.json()
    return order, store.one('SELECT ref FROM orders WHERE id = ?', order['id'])['ref']


def post_webhook(client, payload, raw=None, headers=None):
    raw = raw if raw is not None else json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    return client.post('/api/webhooks/2328', content=raw, headers={'Content-Type': 'application/json', **(headers or {})})


def test_crypto_order_opens_invoice_and_is_idempotent(client, store, catalog, provider):
    request_id = new_id()
    order, ref = create_crypto_order(client, store, catalog, request_id=request_id)
    assert order['status'] == 'pending'
    assert order['paymentUrl'] == 'https://pay.2328.io/pay-1'
    again, _ = create_crypto_order(client, store, catalog, request_id=request_id)
    assert again['id'] == order['id']
    assert provider.calls.count('payment') == 1


def test_invoice_failure_keeps_order_recoverable(client, store, catalog, provider):
    provider.fail = True
    request_id = new_id()
    failed = client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'crypto', request_id))
    assert failed.status_code == 502
    provider.fail = False
    order, _ = create_crypto_order(client, store, catalog, request_id=request_id)
    assert order['paymentUrl']
    assert store.one('SELECT count(*) FROM orders')[0] == 1


def test_signed_webhook_settles_order_and_rewards_referrer_once(client, store, catalog, provider):
    client.get('/api/bootstrap', headers=auth(USER))
    order, ref = create_crypto_order(client, store, catalog, user=FRIEND)
    store.run('UPDATE users SET referrer = ? WHERE id = ?', str(USER), str(FRIEND))
    payload = provider.notification(ref)
    body = json.dumps(payload, separators=(',', ':')).encode()
    payload['sign'] = sign(body)
    for _ in range(2):
        assert post_webhook(client, payload).status_code == 200
    assert client.get(f'/api/orders/{order["id"]}', headers=auth(FRIEND)).json()['status'] == 'paid'
    assert store.balance(str(USER), 'RUB') == 4900
    events = [row['event'] for row in store.all('SELECT event FROM outbox ORDER BY id')]
    assert events == ['admin_paid', 'customer_paid']


@pytest.mark.parametrize('variant', ['raw_with_spaces', 'escaped_slashes', 'unicode_escapes', 'header'])
def test_webhook_signature_formats(client, store, catalog, provider, variant):
    order, ref = create_crypto_order(client, store, catalog)
    data = provider.notification(ref, description='Оплата https://restore.example/x', amount='490.00')
    headers = {}
    if variant == 'raw_with_spaces':
        signed = json.dumps(data, ensure_ascii=False).encode()
        raw = signed[:-1] + b', "sign": "' + sign(signed).encode() + b'"}'
    elif variant == 'escaped_slashes':
        signed = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode().replace(b'/', b'\\/')
        raw = signed[:-1] + b',"sign":"' + sign(signed).encode() + b'"}'
    elif variant == 'unicode_escapes':
        signed = json.dumps(data, ensure_ascii=True, separators=(',', ':')).encode()
        raw = json.dumps(dict(data, sign=sign(signed)), ensure_ascii=False, separators=(',', ':')).encode()
    else:
        raw = json.dumps(data, ensure_ascii=False, indent=1).encode()
        headers['Sign'] = sign(raw)
    assert post_webhook(client, None, raw, headers).status_code == 200
    assert store.one('SELECT status FROM orders WHERE id = ?', order['id'])['status'] == 'paid'


def test_forged_webhook_cannot_settle_an_order(client, store, catalog, provider):
    order, ref = create_crypto_order(client, store, catalog)
    payload = dict(provider.notification(ref), sign='0' * 64)
    # The provider still reports the invoice as unpaid, so the forged "paid" is ignored.
    assert post_webhook(client, payload).status_code == 200
    assert store.one('SELECT status FROM orders WHERE id = ?', order['id'])['status'] == 'pending'
    assert provider.calls.count('payment/info') == 1
    # Repeated forgeries are throttled instead of hammering the provider.
    assert post_webhook(client, payload).status_code == 429
    assert provider.calls.count('payment/info') == 1
    unknown = dict(payload, order_id='missing')
    assert post_webhook(client, unknown).status_code == 401
    assert post_webhook(client, None, b'not json').status_code == 400


def test_unverifiable_webhook_is_confirmed_through_provider_api(client, store, catalog, provider):
    order, ref = create_crypto_order(client, store, catalog)
    provider.status[ref] = 'paid'
    payload = dict(provider.notification(ref), sign='f' * 64)
    assert post_webhook(client, payload).status_code == 200
    assert store.one('SELECT status FROM orders WHERE id = ?', order['id'])['status'] == 'paid'


def test_webhook_with_wrong_amount_is_rejected(client, store, catalog, provider):
    order, ref = create_crypto_order(client, store, catalog)
    payload = provider.notification(ref, amount='1.00')
    payload['sign'] = sign(json.dumps(payload, separators=(',', ':')).encode())
    assert post_webhook(client, payload).status_code == 409
    assert store.one('SELECT status FROM orders WHERE id = ?', order['id'])['status'] == 'pending'


def test_manual_check_confirms_payment_and_reports_provider_errors(client, store, catalog, provider):
    order, ref = create_crypto_order(client, store, catalog)
    assert client.post(f'/api/orders/{order["id"]}/check', headers=auth(USER)).json()['status'] == 'pending'
    provider.fail = True
    assert client.post(f'/api/orders/{order["id"]}/check', headers=auth(USER)).status_code == 502
    provider.fail = False
    provider.status[ref] = 'paid'
    assert client.post(f'/api/orders/{order["id"]}/check', headers=auth(USER)).json()['status'] == 'paid'
    assert client.get(f'/api/orders/{order["id"]}', headers=auth(FRIEND)).status_code == 404


def test_expired_invoice_can_still_be_settled_by_admin_check(client, store, catalog, provider):
    order, ref = create_crypto_order(client, store, catalog)
    provider.status[ref] = 'cancel'
    assert client.post(f'/api/orders/{order["id"]}/check', headers=auth(USER)).json()['status'] == 'expired'
    provider.status[ref] = 'paid'
    assert client.post(f'/api/admin/orders/{order["id"]}/check', headers=auth(USER)).status_code == 403
    assert client.post(f'/api/admin/orders/{order["id"]}/check', headers=auth(ADMIN_ID)).json()['status'] == 'paid'


def test_background_reconciliation_confirms_missed_payment(tmp_path, monkeypatch, provider):
    from backend import config
    monkeypatch.setattr(config, 'PAY2328_PROJECT', 'project')
    monkeypatch.setattr(config, 'PAY2328_API_KEY', 'provider-secret')
    monkeypatch.setattr(config, 'ADMIN_CHATS', ())
    store = Store(str(tmp_path / 'jobs.sqlite'))
    store.register_user({'id': USER, 'first_name': 'Иван'})
    app_id = store.save_app(None, ('Spotify', 'Музыка', '', 49000, True), (PNG, 'image/png'))
    clock = [0.0]

    def tick():
        clock[0] += 45
        return clock[0]

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider.handle)) as http:
            service = integrations.Integrations(http, store)
            order = store.create_order(str(USER), app_id, new_id(), 'crypto', 'RUB', 49000, config.OFFER_URL)
            order = await service.invoice(order)
            provider.status[order['ref']] = 'paid'
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(service.reconcile_payments(interval=0.01, clock=tick), 0.3)
            return store.admin_order(order['id'])

    assert asyncio.run(scenario())['status'] == 'paid'
    # Settled orders are no longer polled.
    assert store.open_crypto_orders() == []
    store.db.close()


# --- Rate limiting ------------------------------------------------------------

def test_rate_limiter_window():
    now = [0.0]
    limiter = RateLimiter(clock=lambda: now[0])
    assert [limiter.retry_after('k', 2, 10) for _ in range(3)] == [0, 0, 10]
    assert limiter.retry_after('other', 2, 10) == 0
    now[0] = 10.5
    assert limiter.retry_after('k', 2, 10) == 0


def test_order_creation_is_rate_limited(client, store, catalog):
    statuses = [client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'crypto', new_id())).status_code
                for _ in range(7)]
    # Five open invoices are allowed, the sixth is refused, the seventh hits the request limit.
    assert statuses == [200] * 5 + [409, 429]
    limited = client.post('/api/orders', headers=auth(USER), json=order_body(catalog, 'crypto', new_id()))
    assert int(limited.headers['retry-after']) > 0
    assert 'Слишком много запросов' in limited.json()['detail']
    assert store.one('SELECT count(*) FROM orders')[0] == 5
    # Other customers are not affected.
    assert client.post('/api/orders', headers=auth(FRIEND), json=order_body(catalog, 'crypto', new_id())).status_code == 200


def test_payment_checks_are_rate_limited(client, store, catalog, provider):
    order, _ = create_crypto_order(client, store, catalog)
    statuses = [client.post(f'/api/orders/{order["id"]}/check', headers=auth(USER)).status_code for _ in range(11)]
    assert statuses == [200] * 10 + [429]
    assert provider.calls.count('payment/info') == 10
    # Reading the stored status stays available while the provider check is throttled.
    assert client.get(f'/api/orders/{order["id"]}', headers=auth(USER)).status_code == 200


# --- Admin --------------------------------------------------------------------

def test_admin_area_is_restricted(client, catalog):
    assert client.get('/api/admin', headers=auth(USER)).status_code == 403
    assert client.get('/api/admin', headers=auth(ADMIN_ID)).json()['catalog'][0]['title'] == 'Spotify'
    assert client.get('/api/bootstrap', headers=auth(ADMIN_ID)).json()['isAdmin'] is True


def test_admin_marks_paid_order_installed(client, store, catalog, provider):
    order, ref = create_crypto_order(client, store, catalog)
    assert client.post(f'/api/admin/orders/{order["id"]}/install', headers=auth(ADMIN_ID)).status_code == 404
    provider.status[ref] = 'paid'
    client.post(f'/api/orders/{order["id"]}/check', headers=auth(USER))
    assert client.post(f'/api/admin/orders/{order["id"]}/install', headers=auth(ADMIN_ID)).status_code == 200
    listed = client.get('/api/admin/orders?status=installed', headers=auth(ADMIN_ID)).json()['orders']
    assert [item['id'] for item in listed] == [order['id']]


def test_hidden_app_cannot_be_ordered_and_icon_revision_changes(client, catalog):
    update = {'title': 'Spotify', 'category': 'Музыка', 'description': '', 'price': 49000, 'active': False,
              'icon': 'data:image/png;base64,iVBORw0KGgo='}
    assert client.put(f'/api/admin/apps/{catalog}', headers=auth(ADMIN_ID), json=update).status_code == 200
    assert client.get('/api/bootstrap', headers=auth(USER)).json()['catalog'] == []
    assert client.post('/api/orders', headers=auth(USER), json=order_body(catalog)).status_code == 409
    assert client.get('/api/admin', headers=auth(ADMIN_ID)).json()['catalog'][0]['icon'].endswith('?v=2')
