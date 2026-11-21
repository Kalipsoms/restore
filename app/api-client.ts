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
  onEvent?: (event: 'fullscreenFailed' | 'themeChanged', handler: () => void) => void;
  offEvent?: (event: 'fullscreenFailed' | 'themeChanged', handler: () => void) => void;
  colorScheme?: 'light' | 'dark';
  close?: () => void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
  BackButton?: { show?: () => void; hide?: () => void; onClick?: (handler: () => void) => void };
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

const themeBackground = { dark: '#101017', light: '#f5f3fa' };

function applyTheme() {
  const webApp = telegram();
  if (!webApp?.initData) return;
  const theme = webApp.colorScheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    webApp.setHeaderColor?.(themeBackground[theme]);
    webApp.setBackgroundColor?.(themeBackground[theme]);
    webApp.setBottomBarColor?.(themeBackground[theme]);
  } catch {
    // Older clients may only offer theme colors.
  }
}

let telegramReady = false;

export function initTelegram() {
  const webApp = telegram();
  webApp?.ready?.();
  if (!webApp?.initData) return;
  webApp.expand?.();
  applyTheme();
  if (!telegramReady) webApp.onEvent?.('themeChanged', applyTheme);
  telegramReady = true;
}

function supports(version: string) {
  const webApp = telegram();
  return !!webApp?.initData && webApp.isVersionAtLeast?.(version) !== false;
}

// Telegram's native back button. The most recently registered handler receives the press.
const backHandlers: (() => void)[] = [];
let backBound = false;

function syncBackButton() {
  const button = supports('6.1') ? telegram()?.BackButton : undefined;
  if (!button) return;
  if (!backBound) {
    button.onClick?.(() => backHandlers.at(-1)?.());
    backBound = true;
  }
  if (backHandlers.length) button.show?.();
  else button.hide?.();
}

export function registerBack(handler: () => void) {
  backHandlers.push(handler);
  syncBackButton();
  return () => {
    const index = backHandlers.lastIndexOf(handler);
    if (index >= 0) backHandlers.splice(index, 1);
    syncBackButton();
  };
}

// Counters let nested screens request the same protection without undoing each other.
let swipeLocks = 0;
let closeGuards = 0;

export function lockSwipes() {
  if (!supports('7.7')) return () => {};
  if (swipeLocks++ === 0) telegram()?.disableVerticalSwipes?.();
  return () => { if (--swipeLocks === 0) telegram()?.enableVerticalSwipes?.(); };
}

export function guardClosing() {
  if (!supports('6.2')) return () => {};
  if (closeGuards++ === 0) telegram()?.enableClosingConfirmation?.();
  return () => { if (--closeGuards === 0) telegram()?.disableClosingConfirmation?.(); };
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
  constructor(readonly status: number, message: string, readonly botUrl = '', readonly expired = false) {
    super(message);
  }
}

const unauthorizedEvent = 'restore:unauthorized';

/** Calls the listener when any request is rejected because the Telegram session is no longer valid. */
export function onUnauthorized(listener: (error: ApiError) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<ApiError>).detail);
  window.addEventListener(unauthorizedEvent, handle);
  return () => window.removeEventListener(unauthorizedEvent, handle);
}

export function apiRequest(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  const initData = telegram()?.initData;
  if (initData) headers.set('X-Telegram-Init-Data', initData);
  if (options.body) headers.set('Content-Type', 'application/json');
  return fetch(`/api${path}`, { cache: 'no-store', ...options, headers });
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiRequest(path, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.detail;
    const message = typeof detail === 'string' ? detail : detail?.message;
    const error = new ApiError(response.status, message || 'Не удалось связаться с ReStore. Попробуйте ещё раз.',
      detail?.botUrl, detail?.expired === true);
    if (response.status === 401) window.dispatchEvent(new CustomEvent(unauthorizedEvent, { detail: error }));
    throw error;
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
