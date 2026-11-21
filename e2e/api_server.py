"""API server for the browser tests: a throwaway database, seeded data and no outbound jobs."""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.update(
    BOT_TOKEN='123456:E2E', BOT_USERNAME='restore_e2e_bot', PUBLIC_URL='https://restore.example',
    ADMIN_IDS='1001', MANAGER_USERNAME='restore_manager', OFFER_URL='https://restore.example/offer',
    DATABASE_PATH=str(Path(tempfile.mkdtemp(prefix='restore-e2e-')) / 'e2e.sqlite'),
    PAY2328_PROJECT='', PAY2328_API_KEY='', RESTORE_DEPLOY_GATE='',
)

import uvicorn  # noqa: E402

from backend import config, integrations  # noqa: E402
from backend.main import app  # noqa: E402
from backend.store import Store  # noqa: E402


async def idle(self, *args, **kwargs):
    await asyncio.Event().wait()


for job in ('poll', 'deliver_messages', 'reconcile_payments'):
    setattr(integrations.Integrations, job, idle)

APPS = [
    ('СберБанк Онлайн', 'Финансы', 'Переводы, платежи и карты в одном приложении. Актуальная версия с поддержкой оплаты по QR.', 149000, 'sber'),
    ('Альфа-Банк', 'Финансы', 'Мобильный банк', 129000, 'alfa'),
    ('Т-Банк', 'Финансы', 'Банк, инвестиции и кэшбэк', 129000, 'tbank'),
    ('Spotify', 'Музыка', 'Музыка и подкасты', 49000, 'spotify'),
    ('YouTube', 'Видео', 'Видео без ограничений', 39000, 'youtube'),
    ('Discord', 'Общение', 'Голосовые чаты и сообщества', 39000, 'discord'),
]
ORDERS = [(1, 'paid', 'crypto'), (2, 'pending', 'crypto'), (3, 'review', 'crypto'),
          (4, 'installed', 'balance'), (5, 'expired', 'crypto'), (6, 'verifying', 'crypto')]


def seed():
    store = Store(config.DATABASE_PATH)
    for title, category, description, price, icon in APPS:
        data = (ROOT / 'public' / 'icons' / f'{icon}.svg').read_bytes()
        store.save_app(None, (title, category, description, price, True), (data, 'image/svg+xml'))
    store.register_user({'id': 1001, 'first_name': 'Иван', 'last_name': 'Тестов', 'username': 'tester'})
    store.credit('1001', 'RUB', 52000)
    for number, (app_id, status, method) in enumerate(ORDERS):
        store.run("""INSERT INTO orders (user_id, app_id, request_id, ref, title, amount, currency, method, status,
                                         referral_percent, offer_url, payment_url, created_at, paid_at)
                     SELECT '1001', id, ?, ?, title, price, 'RUB', ?, ?, 10, 'x', ?, datetime('now', '-1 hour'),
                            CASE WHEN ? IN ('paid', 'installed') THEN datetime('now', '-1 hour') END
                     FROM apps WHERE id = ?""",
                  f'seed-{number}', f'seed-ref-{number}', method, status,
                  'https://pay.2328.io/seed' if status == 'pending' else None, status, app_id)
    store.db.close()


if __name__ == '__main__':
    seed()
    uvicorn.run(app, host='127.0.0.1', port=8000, log_level='warning')
