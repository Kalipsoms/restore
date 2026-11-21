export type Currency = 'RUB';
export type Method = 'balance' | 'crypto' | 'sbp';
export type OrderStatus = 'pending' | 'verifying' | 'paid' | 'installed' | 'expired' | 'review';

export type CatalogApp = {
  id: number; title: string; category: string; description: string;
  price: number; icon: string; active: number;
};

export type Order = {
  id: number; number: string; title: string; amount: number; currency: Currency;
  method: Method; status: OrderStatus; createdAt: string;
  paymentUrl: string | null; managerUrl: string | null;
};

export type Bootstrap = {
  catalog: CatalogApp[]; currency: Currency;
  user: { id: string; name: string; username: string; photo: string };
  balance: number; invited: number; orders: Order[]; isAdmin: boolean;
  referralPercent: number; referralUrl: string; managerUrl: string; offerUrl: string;
  checkoutError: string; methods: Record<Method, boolean>;
};

type TelegramApp = {
  initData?: string;
  platform?: string;
  isExpanded?: boolean;
  isFullscreen?: boolean;
  isVersionAtLeast?: (version: string) => boolean;
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  onEvent?: (event: 'fullscreenFailed', handler: () => void) => void;
  offEvent?: (event: 'fullscreenFailed', handler: () => void) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string) => void;
  HapticFeedback?: { impactOccurred?: (style: string) => void; notificationOccurred?: (type: string) => void };
};

export function telegram() {
  if (typeof window !== 'undefined') return (window as Window & { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
}

export function initTelegram() {
  const webApp = telegram();
  webApp?.ready?.();
  if (webApp?.initData) {
    webApp.expand?.();
    try {
      webApp.setHeaderColor?.('#101017');
      webApp.setBackgroundColor?.('#101017');
      webApp.setBottomBarColor?.('#101017');
    } catch {
      // Older clients may only offer theme colors.
    }
  }
}

function isDesktopTelegram(platform: string) {
  if (['tdesktop', 'macos', 'unigram'].includes(platform)) return true;
  if (!['web', 'weba', 'webk'].includes(platform)) return false;
  const { userAgent, maxTouchPoints } = navigator;
  return /Windows NT|Macintosh|X11|Linux|CrOS/i.test(userAgent)
    && !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
    && (maxTouchPoints < 2 || (!/Macintosh/i.test(userAgent) && window.matchMedia('(any-pointer: fine)').matches));
}

export function expandDesktopAdmin() {
  const webApp = telegram();
  if (!webApp?.initData || !isDesktopTelegram(webApp.platform ?? '') || webApp.isFullscreen) return;

  if (!webApp.isExpanded) webApp.expand?.();
  if (!webApp.requestFullscreen || webApp.isVersionAtLeast?.('8.0') === false) return;

  let requested = true;
  const fullscreenFailed = () => { requested = false; };
  webApp.onEvent?.('fullscreenFailed', fullscreenFailed);
  try {
    webApp.requestFullscreen();
  } catch {
    webApp.offEvent?.('fullscreenFailed', fullscreenFailed);
    return;
  }

  return () => {
    webApp.offEvent?.('fullscreenFailed', fullscreenFailed);
    if (requested) webApp.exitFullscreen?.();
  };
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly botUrl = '') {
    super(message);
  }
}

export function apiRequest(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  const initData = telegram()?.initData;
  if (initData) headers.set('X-Telegram-Init-Data', initData);
  if (options.body) headers.set('Content-Type', 'application/json');
  return fetch(`/api${path}`, { ...options, headers, cache: 'no-store' });
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiRequest(path, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.detail;
    const message = typeof detail === 'string' ? detail : detail?.message;
    throw new ApiError(response.status, message || 'Не удалось связаться с ReStore. Попробуйте ещё раз.', detail?.botUrl);
  }
  return payload as T;
}

export function openExternal(url: string) {
  const tg = telegram();
  if (tg?.initData && new URL(url).hostname === 't.me' && tg.openTelegramLink) tg.openTelegramLink(url);
  else if (tg?.initData && tg.openLink) tg.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export function money(amount: number, _currency: Currency) {
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount / 100);
  return `${number}\u00a0₽`;
}

export const statusLabel: Record<OrderStatus, string> = {
  pending: 'Ожидает оплаты', verifying: 'Проверяется', paid: 'Оплачен', installed: 'Установлено',
  expired: 'Счёт истёк', review: 'На проверке',
};
