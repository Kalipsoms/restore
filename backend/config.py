import os
import re
from urllib.parse import quote, urlsplit

from dotenv import load_dotenv

load_dotenv()


def https_url(value: str) -> str:
    try:
        url = urlsplit(value)
        if url.scheme == 'https' and url.hostname and not (url.username or url.password):
            return value
    except ValueError:
        pass
    return ''


def username(value: str) -> str:
    value = value.lstrip('@')
    return value if re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]{3,31}', value) else ''


def ids(value: str, allow_groups: bool = False) -> tuple[str, ...]:
    pattern = r'-?\d{1,16}' if allow_groups else r'\d{1,16}'
    return tuple(dict.fromkeys(item for raw in value.split(',') if re.fullmatch(pattern, item := raw.strip())))


def public_origin(value: str) -> str:
    url = urlsplit(https_url(value.strip()))
    return f'https://{url.netloc}' if url.netloc else ''


BOT_TOKEN = os.getenv('BOT_TOKEN', '').strip()
BOT_USERNAME = username(os.getenv('BOT_USERNAME', ''))
PUBLIC_URL = public_origin(os.getenv('PUBLIC_URL', ''))
ADMIN_IDS = ids(os.getenv('ADMIN_IDS', ''))
ADMIN_CHATS = ids(os.getenv('ADMIN_CHAT_IDS', ''), True) or ADMIN_IDS
MANAGER_USERNAME = username(os.getenv('MANAGER_USERNAME', ''))
OFFER_URL = https_url(os.getenv('OFFER_URL', '').strip())
DATABASE_PATH = os.getenv('DATABASE_PATH') or 'data/restore.sqlite'
DEPLOY_GATE = os.getenv('RESTORE_DEPLOY_GATE', '')
PAY2328_PROJECT = os.getenv('PAY2328_PROJECT', '').strip()
PAY2328_API_KEY = os.getenv('PAY2328_API_KEY', '').strip()
try:
    REFERRAL_PERCENT = max(0, min(100, int(os.getenv('REFERRAL_PERCENT', '10'))))
except ValueError:
    REFERRAL_PERCENT = 10


def manager_link(text: str = 'Здравствуйте, у меня проблема: ') -> str:
    return f'https://t.me/{MANAGER_USERNAME}?text={quote(text, safe="")}' if MANAGER_USERNAME else ''


def order_number(order_id: int) -> str:
    return f'#{order_id:06d}'


def order_manager_link(order) -> str:
    return manager_link(f'Номер заказа: {order_number(order["id"])}\n\nНеобходимо установить: {order["title"]}')
