import asyncio
import base64
import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import config, integrations
from backend.main import app

BOT_TOKEN = '123456:TEST'
API_KEY = 'provider-secret'
ADMIN_ID = 1001
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16


def init_data(user_id, name='Иван', age=0, start_param='', token=BOT_TOKEN):
    fields = {'auth_date': str(int(time.time() - age)), 'query_id': 'AAA',
              'user': json.dumps({'id': user_id, 'first_name': name, 'username': f'user{user_id}'}, ensure_ascii=False)}
    if start_param:
        fields['start_param'] = start_param
    message = '\n'.join(f'{key}={fields[key]}' for key in sorted(fields)).encode()
    secret = hmac.digest(b'WebAppData', token.encode(), 'sha256')
    fields['hash'] = hmac.new(secret, message, hashlib.sha256).hexdigest()
    return urlencode(fields)


def auth(user_id, **options):
    return {'X-Telegram-Init-Data': init_data(user_id, **options)}


def sign(body: bytes):
    return hmac.new(API_KEY.encode(), base64.b64encode(body), hashlib.sha256).hexdigest()


class Provider:
    """Stand-in for 2328.io that remembers invoices and reports a configurable status."""

    def __init__(self):
        self.invoices = {}
        self.status = {}
        self.calls = []
        self.fail = False

    def handle(self, request: httpx.Request):
        route = request.url.path.removeprefix('/api/v1/')
        self.calls.append(route)
        if 'telegram' in request.url.host:
            return httpx.Response(200, json={'ok': True, 'result': []})
        if self.fail:
            return httpx.Response(500, json={'state': 1})
        body = json.loads(request.content)
        ref = body['order_id']
        if route == 'payment':
            self.invoices.setdefault(ref, {'uuid': f'pay-{len(self.invoices) + 1}', 'order_id': ref,
                                           'amount': body['amount'], 'currency': 'RUB'})
        invoice = self.invoices.get(ref)
        if not invoice:
            return httpx.Response(404, json={'state': 1})
        return httpx.Response(200, json={'state': 0, 'result': dict(
            invoice, payment_status=self.status.get(ref, 'check'), url=f'https://pay.2328.io/{invoice["uuid"]}')})

    def notification(self, ref, status='paid', **extra):
        return dict(self.invoices[ref], payment_status=status, **extra)


@pytest.fixture
def provider():
    return Provider()


@pytest.fixture
def client(tmp_path, monkeypatch, provider):
    for name, value in dict(
        BOT_TOKEN=BOT_TOKEN, BOT_USERNAME='restore_bot', PUBLIC_URL='https://restore.example',
        ADMIN_IDS=(str(ADMIN_ID),), ADMIN_CHATS=(str(ADMIN_ID),), MANAGER_USERNAME='manager',
        OFFER_URL='https://restore.example/offer', DATABASE_PATH=str(tmp_path / 'test.sqlite'),
        DEPLOY_GATE='', PAY2328_PROJECT='project', PAY2328_API_KEY=API_KEY, REFERRAL_PERCENT=10,
    ).items():
        monkeypatch.setattr(config, name, value)

    async def idle(self, *args, **kwargs):
        await asyncio.Event().wait()

    for job in ('poll', 'deliver_messages', 'reconcile_payments'):
        monkeypatch.setattr(integrations.Integrations, job, idle)
    app.state.transport = httpx.MockTransport(provider.handle)
    with TestClient(app) as test_client:
        yield test_client
    app.state.transport = None


class StoreProxy:
    """Runs store calls on the application thread, where the SQLite connection lives."""

    def __init__(self, test_client):
        self._client = test_client

    def __getattr__(self, name):
        method = getattr(self._client.app.state.store, name)
        return lambda *args: self._client.portal.call(method, *args)

    def changes(self):
        return self._client.portal.call(lambda: self._client.app.state.store.db.total_changes)


@pytest.fixture
def store(client):
    return StoreProxy(client)


@pytest.fixture
def catalog(client):
    """One active app priced at 490 ₽, created through the admin API."""
    icon = 'data:image/png;base64,' + base64.b64encode(PNG).decode()
    response = client.post('/api/admin/apps', headers=auth(ADMIN_ID), json={
        'title': 'Spotify', 'category': 'Музыка', 'description': 'Музыка и подкасты',
        'price': 49000, 'active': True, 'icon': icon})
    assert response.status_code == 200, response.text
    return response.json()['id']


def order_body(app_id, method='crypto', request_id='11111111-1111-4111-8111-111111111111', amount=49000):
    return {'appId': app_id, 'requestId': request_id, 'method': method, 'amount': amount,
            'offerUrl': 'https://restore.example/offer'}
