import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const BOT_TOKEN = '123456:E2E';
const DAY = 86_400;

function initData(userId: number, ageSeconds = 0) {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
    query_id: 'AAA',
    user: JSON.stringify({ id: userId, first_name: 'Иван', last_name: 'Тестов', username: 'tester' }),
  };
  const message = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  fields.hash = createHmac('sha256', secret).update(message).digest('hex');
  return new URLSearchParams(fields).toString();
}

type TelegramState = {
  back: boolean; closeConfirmation: boolean; swipes: boolean; closed: boolean; header: string;
  pressBack: () => void; setInitData: (value: string) => void;
};

/** Replaces Telegram's SDK with a recording stand-in, as if the page ran inside a Telegram client. */
async function openInTelegram(page: Page, path = '/', options: { userId?: number; age?: number; scheme?: 'light' | 'dark' } = {}) {
  const launch = { initData: initData(options.userId ?? 1001, options.age), scheme: options.scheme ?? 'dark' };
  await page.route('**/telegram-web-app.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `(() => {
      const launch = ${JSON.stringify(launch)};
      const state = window.__tg = { back: false, closeConfirmation: false, swipes: true, closed: false, header: '', handlers: [] };
      state.pressBack = () => state.handlers.forEach(handler => handler());
      state.setInitData = value => { window.Telegram.WebApp.initData = value; };
      window.Telegram = { WebApp: {
        initData: launch.initData, platform: 'ios', colorScheme: launch.scheme,
        isVersionAtLeast: () => true, ready() {}, expand() {}, onEvent() {}, offEvent() {},
        setHeaderColor(color) { state.header = color; }, setBackgroundColor() {}, setBottomBarColor() {},
        close() { state.closed = true; },
        enableClosingConfirmation() { state.closeConfirmation = true; },
        disableClosingConfirmation() { state.closeConfirmation = false; },
        disableVerticalSwipes() { state.swipes = false; },
        enableVerticalSwipes() { state.swipes = true; },
        openLink() {}, openTelegramLink() {},
        BackButton: {
          show() { state.back = true; }, hide() { state.back = false; },
          onClick(handler) { state.handlers.push(handler); },
        },
      } };
    })();`,
  }));
  await page.goto(path);
}

function telegramState(page: Page) {
  return page.evaluate(() => {
    const { back, closeConfirmation, swipes, closed, header } = (window as unknown as { __tg: TelegramState }).__tg;
    return { back, closeConfirmation, swipes, closed, header };
  });
}

function pressBack(page: Page) {
  return page.evaluate(() => (window as unknown as { __tg: TelegramState }).__tg.pressBack());
}

const dialog = (page: Page) => page.locator('dialog.checkout');
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('button', { name });

test('catalog loads and each icon is downloaded once', async ({ page }) => {
  const iconRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/icons/')) iconRequests.push(request.url()); });
  await openInTelegram(page);
  await expect(page.locator('.app-card')).toHaveCount(6);
  await expect(page.locator('.app-card img.app-icon')).toHaveCount(6);

  // Opening an app and the profile reuses the icons that are already loaded.
  await page.locator('.app-card').first().click();
  await expect(dialog(page).locator('img.app-icon')).toBeVisible();
  await expect(dialog(page).getByText('Актуальная версия с поддержкой оплаты по QR.')).toBeVisible();
  expect(new Set(iconRequests).size).toBe(6);
  expect(iconRequests).toHaveLength(6);
});

test('icons are served with long-lived private caching', async ({ page }) => {
  const response = await page.request.get('/api/icons/1?v=1', { headers: { 'X-Telegram-Init-Data': initData(1001) } });
  expect(response.headers()['cache-control']).toBe('private, max-age=31536000, immutable');
});

test('follows the Telegram colour scheme', async ({ page }) => {
  await openInTelegram(page, '/', { scheme: 'light' });
  await expect(page.locator('.app-card')).toHaveCount(6);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 243, 250)');
  expect((await telegramState(page)).header).toBe('#f5f3fa');

  await openInTelegram(page, '/', { scheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(16, 16, 23)');
});

test('native back button follows navigation', async ({ page }) => {
  await openInTelegram(page);
  await expect(page.locator('.app-card')).toHaveCount(6);
  expect((await telegramState(page)).back).toBe(false);

  await tab(page, 'Профиль').click();
  await expect.poll(async () => (await telegramState(page)).back).toBe(true);
  await pressBack(page);
  await expect(tab(page, 'Главная')).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => (await telegramState(page)).back).toBe(false);

  await page.locator('.app-card').first().click();
  await expect.poll(async () => (await telegramState(page)).back).toBe(true);
  await dialog(page).getByRole('button', { name: 'Оформить установку' }).click();
  await expect(dialog(page).getByText('Способ оплаты')).toBeVisible();
  await pressBack(page);
  await expect(dialog(page).getByRole('button', { name: 'Оформить установку' })).toBeVisible();
  await pressBack(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => (await telegramState(page)).back).toBe(false);
});

test('checkout sheet is protected from accidental closing', async ({ page }) => {
  await openInTelegram(page);
  await tab(page, 'Профиль').click();
  expect((await telegramState(page)).swipes).toBe(true);

  await page.locator('.history-order', { hasText: 'Ожидает оплаты' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Перейти к оплате' })).toBeVisible();
  await expect.poll(() => telegramState(page)).toMatchObject({ swipes: false, closeConfirmation: true });

  await dialog(page).getByRole('button', { name: 'Закрыть' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => telegramState(page)).toMatchObject({ swipes: true, closeConfirmation: false });

  // A finished order needs no confirmation, only the swipe lock while the sheet is open.
  await page.locator('.history-order', { hasText: 'Установлено' }).click();
  await expect.poll(() => telegramState(page)).toMatchObject({ swipes: false, closeConfirmation: false });
});

test('order statuses are visually distinct', async ({ page }) => {
  await openInTelegram(page);
  await tab(page, 'Профиль').click();
  const colours = new Set<string>();
  for (const status of ['pending', 'verifying', 'paid', 'review', 'expired']) {
    const tag = page.locator(`.history-order .order-tag[data-status=${status}]`).first();
    await expect(tag).toBeVisible();
    colours.add(await tag.evaluate(element => getComputedStyle(element).backgroundColor));
  }
  expect(colours.size).toBe(5);
});

test('bottom navigation does not cover the end of the page', async ({ page }) => {
  await openInTelegram(page);
  await tab(page, 'Профиль').click();
  const last = page.locator('.view-panel[data-active=true] .support-card');
  await last.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const nav = await page.locator('.bottom-nav').boundingBox();
  const card = await last.boundingBox();
  expect(card!.y + card!.height).toBeLessThanOrEqual(nav!.y);
});

test('bonus payment is charged once', async ({ page }) => {
  await openInTelegram(page);
  await expect(page.locator('.balance-pill')).toContainText('520');
  await page.locator('.app-card', { hasText: 'Discord' }).click();
  await dialog(page).getByRole('button', { name: 'Оформить установку' }).click();
  // Only the bonus balance is available in this setup, so it is selected already.
  await expect(dialog(page).getByRole('radio', { name: /Бонусный баланс/ })).toBeChecked();
  await dialog(page).getByRole('button', { name: 'Подтвердить заказ' }).click();
  await expect(dialog(page).getByText('Заказ успешно оплачен')).toBeVisible();
  await expect(page.locator('.balance-pill')).toContainText('130');
  await dialog(page).getByRole('button', { name: 'Закрыть' }).click();

  // An immediate second attempt for the same app is refused and the balance is untouched.
  const duplicate = await page.request.post('/api/orders', {
    headers: { 'X-Telegram-Init-Data': initData(1001) },
    data: { appId: 6, requestId: crypto.randomUUID(), method: 'balance', amount: 39000, offerUrl: 'https://restore.example/offer' },
  });
  expect(duplicate.status()).toBe(409);
  const profile = await page.request.get('/api/bootstrap', { headers: { 'X-Telegram-Init-Data': initData(1001) } });
  expect((await profile.json()).balance).toBe(13000);
});

test('expired session shows a clear notice', async ({ page }) => {
  await openInTelegram(page, '/', { age: DAY + 60 });
  await expect(page.getByRole('heading', { name: 'Сессия истекла' })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть ReStore' }).click();
  expect((await telegramState(page)).closed).toBe(true);
});

test('session expiring during use replaces the app with the notice', async ({ page }) => {
  await openInTelegram(page);
  await expect(page.locator('.app-card')).toHaveCount(6);
  const expired = initData(1001, DAY + 60);
  await page.evaluate(value => (window as unknown as { __tg: TelegramState }).__tg.setInitData(value), expired);
  await tab(page, 'Профиль').click();
  await expect(page.getByRole('heading', { name: 'Сессия истекла' })).toBeVisible();
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
});

test('outside Telegram the app asks to open the bot', async ({ page }) => {
  await page.route('**/telegram-web-app.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Откройте ReStore в Telegram' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть бота' })).toHaveAttribute('href', 'https://t.me/restore_e2e_bot');
});

test('admin panel opens for administrators and back returns to the catalog', async ({ page }) => {
  await openInTelegram(page, '/admin');
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Разделы админки' }).getByRole('button', { name: 'Заказы' }).click();
  await expect(page.locator('.admin-order').first()).toBeVisible();
  await expect.poll(async () => (await telegramState(page)).back).toBe(true);
  await pressBack(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.app-card')).toHaveCount(6);
});

test('admin panel is closed to other users', async ({ page }) => {
  await openInTelegram(page, '/admin', { userId: 2002 });
  await expect(page.getByText('Доступ разрешён администраторам ReStore.')).toBeVisible();
});
