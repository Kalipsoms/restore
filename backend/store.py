import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, time as midnight_time, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from . import config

SCHEMA = '''
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL, photo TEXT NOT NULL DEFAULT '',
  referrer TEXT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS balances (
  user_id TEXT NOT NULL REFERENCES users(id), currency TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0), PRIMARY KEY (user_id, currency)
);
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT NOT NULL, price INTEGER NOT NULL,
  icon BLOB NOT NULL, icon_type TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
  app_id INTEGER NOT NULL REFERENCES apps(id), request_id TEXT NOT NULL, ref TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), currency TEXT NOT NULL,
  method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', referral_percent INTEGER NOT NULL,
  offer_url TEXT NOT NULL, payment_url TEXT, payment_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT, installed_at TEXT,
  UNIQUE (user_id, request_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
  event TEXT NOT NULL, chat_id TEXT NOT NULL, text TEXT NOT NULL, button_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, delivered_at TEXT,
  UNIQUE (order_id, event, chat_id)
);
CREATE TABLE IF NOT EXISTS command_outbox (
  id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, button TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS command_outbox_due ON command_outbox(next_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS users_referrer ON users(referrer);
CREATE INDEX IF NOT EXISTS orders_user_recent ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS orders_paid_at ON orders(paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_open_crypto ON orders(id) WHERE method = 'crypto' AND status IN ('pending', 'verifying');
'''

APP_FIELDS = 'id, title, category, description, price, revision, active'
REPORT_ZONE = timezone(timedelta(hours=3), 'MSK')
DUPLICATE_BALANCE_WINDOW = 120
MAX_OPEN_CRYPTO_ORDERS = 5


class Store:
    def __init__(self, path: str):
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.remove_legacy_payments()

    def remove_legacy_payments(self):
        with self.transaction():
            if self.setting('legacy_payments_removed', ''):
                return
            legacy_orders = "SELECT id FROM orders WHERE method = 'stars' OR currency = 'XTR'"
            self.run(f'DELETE FROM outbox WHERE order_id IN ({legacy_orders})')
            self.run(f'DELETE FROM orders WHERE id IN ({legacy_orders})')
            self.run("DELETE FROM balances WHERE currency = 'XTR'")
            if any(column['name'] == 'stars' for column in self.all('PRAGMA table_info(apps)')):
                self.run('ALTER TABLE apps DROP COLUMN stars')
            if any(column['name'] == 'checkout_query' for column in self.all('PRAGMA table_info(orders)')):
                self.run('ALTER TABLE orders DROP COLUMN checkout_query')
            self.set_setting('legacy_payments_removed', '1')

    def one(self, sql, *values):
        return self.db.execute(sql, values).fetchone()

    def all(self, sql, *values):
        return self.db.execute(sql, values).fetchall()

    def run(self, sql, *values):
        return self.db.execute(sql, values)

    @contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def setting(self, key, default):
        row = self.one('SELECT value FROM settings WHERE key = ?', key)
        return row['value'] if row else default

    def set_setting(self, key, value):
        self.run('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, str(value))

    def referral_percent(self):
        return int(self.setting('referral_percent', config.REFERRAL_PERCENT))

    def register_user(self, user, referral=''):
        user_id = str(user['id'])
        match = re.fullmatch(r'ref_(\d{1,16})', referral)
        referrer = match[1] if match and match[1] != user_id else None
        if referrer and not self.one('SELECT id FROM users WHERE id = ?', referrer):
            referrer = None
        name = ' '.join(filter(None, (user.get('first_name'), user.get('last_name')))) or 'Пользователь Telegram'
        photo = config.https_url(user.get('photo_url') or '')
        username = user.get('username') or ''
        existing = self.one('SELECT * FROM users WHERE id = ?', user_id)
        if existing and (existing['name'], existing['username']) == (name, username) and photo in ('', existing['photo']):
            # Nothing changed: most requests come from known users, so skip the write.
            return existing
        self.run('''INSERT INTO users VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, username = excluded.username,
                    photo = coalesce(nullif(excluded.photo, ''), users.photo)''',
                 user_id, name, username, photo, referrer)
        return self.one('SELECT * FROM users WHERE id = ?', user_id)

    def invited_count(self, user_id):
        return self.one('SELECT count(*) FROM users WHERE referrer = ?', user_id)[0]

    def balance(self, user_id, currency):
        row = self.one('SELECT amount FROM balances WHERE user_id = ? AND currency = ?', user_id, currency)
        return row['amount'] if row else 0

    def credit(self, user_id, currency, amount):
        self.run('''INSERT INTO balances VALUES (?, ?, ?) ON CONFLICT(user_id, currency)
                    DO UPDATE SET amount = balances.amount + excluded.amount''', user_id, currency, amount)

    def catalog(self, admin=False):
        rows = self.all(f'SELECT {APP_FIELDS} FROM apps WHERE active = 1 OR ? = 1 ORDER BY id', admin)
        return [dict(row, icon=f'/api/icons/{row["id"]}?v={row["revision"]}') for row in rows]

    def save_app(self, app_id, values, icon):
        if not app_id:
            return self.run('''INSERT INTO apps (title, category, description, price, active, icon, icon_type)
                               VALUES (?, ?, ?, ?, ?, ?, ?)''', *values, *icon).lastrowid
        data, mime = icon or (None, None)
        changed = self.run('''UPDATE apps SET title = ?, category = ?, description = ?, price = ?, active = ?,
                             revision = revision + ?, icon = coalesce(?, icon), icon_type = coalesce(?, icon_type)
                             WHERE id = ?''', *values, bool(icon), data, mime, app_id).rowcount
        return app_id if changed else None

    def order(self, order_id, user_id):
        return self.one('SELECT * FROM orders WHERE id = ? AND user_id = ?', order_id, user_id)

    def by_ref(self, ref):
        return self.one('SELECT * FROM orders WHERE ref = ?', ref)

    def orders(self, user_id):
        return self.all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100', user_id)

    def admin_orders(self, status, before, order_id, limit):
        return self.all("""SELECT orders.*, users.name AS user_name, users.username AS user_username
                           FROM orders JOIN users ON users.id = orders.user_id
                           WHERE (? IS NULL OR orders.status = ?)
                             AND (? IS NULL OR orders.id < ?)
                             AND (? IS NULL OR orders.id = ?)
                           ORDER BY orders.id DESC LIMIT ?""",
                        status, status, before, before, order_id, order_id, limit)

    def open_crypto_orders(self):
        return self.all("""SELECT * FROM orders WHERE method = 'crypto' AND status IN ('pending', 'verifying')
                           AND payment_id IS NOT NULL AND created_at >= datetime('now', '-2 days')
                           ORDER BY id LIMIT 50""")

    def admin_order(self, order_id):
        return self.one('SELECT * FROM orders WHERE id = ?', order_id)

    def dashboard(self, days, currency):
        today = datetime.now(REPORT_ZONE).date()
        first_day = today - timedelta(days=days - 1)
        start = datetime.combine(first_day, midnight_time.min, REPORT_ZONE).astimezone(timezone.utc)
        end = start + timedelta(days=days)
        bounds = (start.strftime('%Y-%m-%d %H:%M:%S'), end.strftime('%Y-%m-%d %H:%M:%S'))

        users = self.one('SELECT count(*) FROM users')[0]
        buyers = self.one('''SELECT count(DISTINCT user_id) FROM orders
                             WHERE paid_at >= ? AND paid_at < ? AND status IN ('paid', 'installed')''', *bounds)[0]
        payments = self.all('''SELECT date(paid_at, '+3 hours') AS day, count(*) AS orders,
                                sum(CASE WHEN method <> 'balance' AND currency = ? THEN amount ELSE 0 END) AS revenue
                              FROM orders WHERE paid_at >= ? AND paid_at < ? AND status IN ('paid', 'installed')
                              GROUP BY day''', currency, *bounds)
        payments_by_day = {row['day']: dict(row) for row in payments}
        series = []
        for offset in range(days):
            day = (first_day + timedelta(days=offset)).isoformat()
            series.append(payments_by_day.get(day, {'day': day, 'orders': 0, 'revenue': 0}))

        funnel = self.one('''SELECT count(*) AS created, count(CASE WHEN status IN ('paid', 'installed') THEN 1 END) AS paid,
                              count(CASE WHEN status = 'installed' THEN 1 END) AS installed
                            FROM orders WHERE created_at >= ? AND created_at < ?''', *bounds)
        top_apps = self.all('''SELECT apps.id, apps.title, apps.revision, count(*) AS orders
                              FROM orders JOIN apps ON orders.app_id = apps.id
                              WHERE paid_at >= ? AND paid_at < ? AND orders.status IN ('paid', 'installed')
                              GROUP BY apps.id ORDER BY orders DESC, apps.id LIMIT 5''', *bounds)
        return {
            'currency': currency, 'users': users, 'buyers': buyers,
            'paidOrders': sum(row['orders'] for row in payments),
            'revenue': sum(row['revenue'] for row in payments),
            'series': series, 'funnel': dict(funnel),
            'topApps': [dict(row, icon=f'/api/icons/{row["id"]}?v={row["revision"]}') for row in top_apps],
        }

    def create_order(self, user_id, app_id, request_id, method, currency, expected_amount, offer):
        with self.transaction():
            existing = self.one('SELECT * FROM orders WHERE user_id = ? AND request_id = ?', user_id, request_id)
            if existing:
                if (existing['app_id'], existing['method'], existing['amount']) != (app_id, method, expected_amount):
                    raise ValueError('Параметры заказа изменились. Оформите заказ заново.')
                return existing
            if offer != config.OFFER_URL:
                raise ValueError('Публичная оферта обновилась. Откройте каталог заново.')
            item = self.one('SELECT price FROM apps WHERE id = ? AND active = 1', app_id)
            amount = item['price'] if item else 0
            if not amount or amount != expected_amount:
                raise ValueError('Цена или наличие изменились. Откройте каталог заново.')
            if method == 'balance':
                # A retry that lost its request id must not spend the bonuses twice.
                if self.one("""SELECT id FROM orders WHERE user_id = ? AND app_id = ? AND method = 'balance'
                               AND created_at >= datetime('now', ?)""", user_id, app_id, f'-{DUPLICATE_BALANCE_WINDOW} seconds'):
                    raise ValueError('Этот заказ уже оплачен бонусами. Проверьте историю заказов.')
                if self.balance(user_id, currency) < amount:
                    raise ValueError('На балансе недостаточно бонусов.')
            elif self.one("""SELECT count(*) FROM orders WHERE user_id = ? AND method = 'crypto' AND status = 'pending'
                             AND created_at >= datetime('now', '-1 day')""", user_id)[0] >= MAX_OPEN_CRYPTO_ORDERS:
                raise ValueError('У вас уже есть неоплаченные заказы. Оплатите их или дождитесь истечения счетов.')
            order_id = self.run('''INSERT INTO orders (user_id, app_id, request_id, ref, title, amount, currency,
                                   method, referral_percent, offer_url)
                                   SELECT ?, id, ?, ?, title, ?, ?, ?, ?, ? FROM apps WHERE id = ?''',
                                user_id, request_id, str(uuid4()), amount, currency, method, self.referral_percent(),
                                offer, app_id).lastrowid
            order = self.order(order_id, user_id)
            if method == 'balance':
                self.run('UPDATE balances SET amount = amount - ? WHERE user_id = ? AND currency = ?', amount, user_id, currency)
                return self._settle(order, None)
            return order

    def save_invoice(self, order, url, payment_id=None):
        self.run('''UPDATE orders SET payment_url = ?, payment_id = coalesce(payment_id, ?) WHERE id = ?
                    AND (? IS NULL OR payment_id IS NULL OR payment_id = ?)''', url, payment_id, order['id'], payment_id, payment_id)
        return self.order(order['id'], order['user_id'])

    def crypto_status(self, order, status, payment_id):
        self.run('''UPDATE orders SET status = ?, payment_id = coalesce(payment_id, ?) WHERE id = ?
                    AND status IN ('pending', 'verifying') AND (payment_id IS NULL OR payment_id = ?)
                    AND (status <> 'verifying' OR ? <> 'pending')''', status, payment_id, order['id'], payment_id, status)

    def settle_payment(self, ref, method, currency, amount, payment_id):
        with self.transaction():
            order = self.by_ref(ref)
            if (not order or (order['method'], order['currency'], order['amount']) != (method, currency, amount)
                    or order['payment_id'] not in (None, payment_id)):
                return None
            if order['status'] in ('paid', 'installed'):
                return order
            return self._settle(order, payment_id)

    def _settle(self, order, payment_id):
        self.run("UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP, payment_id = ? WHERE id = ?", payment_id, order['id'])
        user = self.one('SELECT * FROM users WHERE id = ?', order['user_id'])
        reward = order['amount'] * order['referral_percent'] // 100
        if order['method'] != 'balance' and user['referrer'] and reward:
            self.credit(user['referrer'], order['currency'], reward)
        number = config.order_number(order['id'])
        contact = f' (@{user["username"]})' if user['username'] else ''
        for admin in config.ADMIN_CHATS:
            self.queue(order, 'admin_paid', admin, f'Заказ {number} оплачен\n\nПриложение: {order["title"]}\n'
                       f'Покупатель: {user["name"]}{contact}\nTelegram ID: {user["id"]}')
        self.queue(order, 'customer_paid', order['user_id'], f'Заказ {number} успешно оплачен.\n\n'
                   f'Для установки приложения «{order["title"]}» напишите менеджеру.', config.order_manager_link(order))
        return self.order(order['id'], order['user_id'])

    def queue(self, order, event, chat_id, text, url=None):
        self.run('INSERT OR IGNORE INTO outbox (order_id, event, chat_id, text, button_url) VALUES (?, ?, ?, ?, ?)',
                 order['id'], event, chat_id, text, url)

    def queue_command(self, update_id, chat_id, text, button):
        self.run('INSERT OR IGNORE INTO command_outbox (id, chat_id, text, button) VALUES (?, ?, ?, ?)',
                 update_id, chat_id, text, button)

    def due_messages(self):
        return self.all("""SELECT id, chat_id, text, button_url, NULL AS button, attempts, 0 AS command
                           FROM outbox WHERE delivered_at IS NULL AND next_at <= ?
                           ORDER BY id LIMIT 20""", time.time())

    def due_commands(self):
        return self.all("""SELECT id, chat_id, text, NULL AS button_url, button, attempts, 1 AS command
                           FROM command_outbox WHERE delivered_at IS NULL AND next_at <= ?
                           ORDER BY id LIMIT 20""", time.time())

    def finish_message(self, message):
        table = 'command_outbox' if message['command'] else 'outbox'
        self.run(f'UPDATE {table} SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?', message['id'])

    def retry_message(self, message, attempts, delay):
        table = 'command_outbox' if message['command'] else 'outbox'
        self.run(f'UPDATE {table} SET attempts = ?, next_at = ? WHERE id = ?',
                 attempts, time.time() + delay, message['id'])

    def install(self, order_id):
        self.run("UPDATE orders SET status = 'installed', installed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'paid'", order_id)
        return self.one("SELECT * FROM orders WHERE id = ? AND status = 'installed'", order_id)
