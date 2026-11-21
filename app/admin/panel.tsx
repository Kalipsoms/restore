'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, expandDesktopAdmin, money, onUnauthorized, statusLabel } from '../api-client';
import type { CatalogApp, Order } from '../api-client';
import { CatalogIcon } from '../catalog-icon';
import { Brand, Icon } from '../icons';
import type { IconName } from '../icons';
import { LaunchScreen, useTelegramBack, useTelegramSettled } from '../telegram-runtime';
import { Dashboard } from './dashboard';
import { AppEditor, readImage, ReferralEditor } from './editors';
import type { AppDraft } from './editors';

type AdminOrder = Order & { userName: string; userUsername: string };
type Summary = { catalog: CatalogApp[]; referralPercent: number };
type OrdersPage = { orders: AdminOrder[]; nextBefore: number | null };

type Section = 'dashboard' | 'catalog' | 'orders' | 'referral';
const sections: { id: Section; text: string; icon: IconName }[] = [
  { id: 'dashboard', text: 'Обзор', icon: 'chart' },
  { id: 'catalog', text: 'Приложения', icon: 'grid' },
  { id: 'orders', text: 'Заказы', icon: 'history' },
  { id: 'referral', text: 'Рефералы', icon: 'gift' },
];

export function Admin() {
  const telegramSettled = useTelegramSettled();
  const [data, setData] = useState<Summary | null>(null);
  const [page, setPage] = useState<Section>('dashboard');
  const [editing, setEditing] = useState<CatalogApp | 'new' | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [orders, setOrders] = useState<OrdersPage | null>(null);
  const [orderSearch, setOrderSearch] = useState('');
  const [orderStatus, setOrderStatus] = useState('');
  const [orderCursors, setOrderCursors] = useState<number[]>([]);
  const [ordersVersion, setOrdersVersion] = useState(0);
  const authorized = data !== null;
  const router = useRouter();

  useEffect(() => onUnauthorized(reason => {
    setData(null);
    setError(reason);
  }), []);
  useTelegramBack(true, () => {
    if (busy) return;
    if (editing) setEditing(null);
    else router.push('/');
  });

  useEffect(() => {
    if (page !== 'orders' || !authorized) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    const before = orderCursors.at(-1);
    if (before) params.set('before', String(before));
    if (orderSearch) params.set('order_id', orderSearch);
    else if (orderStatus) params.set('status', orderStatus);
    setOrders(null);
    void api<OrdersPage>(`/admin/orders?${params}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setOrders(result);
    }).catch((reason: Error) => {
      if (!controller.signal.aborted) setError(reason);
    });
    return () => controller.abort();
  }, [authorized, orderCursors, orderSearch, orderStatus, ordersVersion, page]);


  const load = useCallback(async () => {
    const summary = await api<Summary>('/admin');
    setData(summary);
  }, []);

  const start = useCallback(() => {
    setError(null);
    void load().catch((reason: Error) => setError(reason));
  }, [load]);

  useEffect(() => { if (telegramSettled) start(); }, [start, telegramSettled]);
  useEffect(() => { if (authorized) return expandDesktopAdmin(); }, [authorized]);
  useEffect(() => {
    if (editing && page === 'catalog') editor.current?.scrollIntoView({ block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [editing, page]);

  async function run(operation: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await operation();
      setNotice(message);
      if (page === 'orders') setOrdersVersion(version => version + 1);
      else await load();
    } catch (reason) {
      setError(reason as Error);
    } finally { setBusy(false); }
  }

  function saveApp({ file, ...draft }: AppDraft) {
    void run(async () => {
      const icon = file ? await readImage(file) : null;
      await api(current ? `/admin/apps/${current.id}` : '/admin/apps', {
        method: current ? 'PUT' : 'POST', body: JSON.stringify({ ...draft, icon }),
      });
      setEditing(null);
    }, 'Приложение сохранено.');
  }

  function saveReferral(percent: number) {
    void run(() => api('/admin/referral', { method: 'PUT', body: JSON.stringify({ percent }) }), 'Процент начисления сохранён.');
  }

  if (!data) return <LaunchScreen error={error} retry={start}/>;

  const current = editing && editing !== 'new' ? editing : null;
  const categories = Array.from(new Set(data.catalog.map(app => app.category)));

  return <>
    <header className="topbar admin-topbar"><div className="shell topbar-inner"><Link href="/" aria-label="ReStore, главная"><Brand/></Link><Link href="/" className="button secondary"><Icon name="back" size={17}/>Каталог</Link></div></header>
    <main className="shell main-shell admin-shell" aria-label="Админка ReStore">
      <nav className="admin-nav" aria-label="Разделы админки">{sections.map(section => <button key={section.id} type="button"
        aria-current={page === section.id ? 'page' : undefined} disabled={busy} onClick={() => {
          if (page === section.id) return;
          setPage(section.id);
          setNotice('');
          setError(null);
        }}><Icon name={section.icon} size={17}/><span>{section.text}</span></button>)}</nav>
      {error && <p role="alert" className="error-text">{error.message}</p>}
      {notice && <p role="status" className="message">{notice}</p>}
      <div className="admin-view" key={page}>
        {page === 'dashboard' && <Dashboard/>}
        {page === 'catalog' && <section className="admin-section">
          <div className="section-heading"><h1>Приложения</h1><button className="button primary" type="button" onClick={() => setEditing('new')} disabled={busy || editing === 'new'}><Icon name="plus" size={18}/>Добавить</button></div>
          {editing && <div ref={editor}><AppEditor key={current?.id ?? 'new'} current={current}
            categories={categories} busy={busy} save={saveApp} close={() => setEditing(null)}/></div>}
          <div className="admin-list">{data.catalog.map(app => <div className="panel admin-item" key={app.id}>
            <CatalogIcon url={app.icon}/>
            <div><strong>{app.title}</strong><p>{app.category}{app.active ? '' : ' · Скрыто'}</p></div>
            <span className="app-price">{money(app.price, 'RUB')}</span>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(app)}>Изменить</button>
          </div>)}</div>
          {!data.catalog.length && !editing && <p className="history-empty">В каталоге пока нет приложений.</p>}
        </section>}
        {page === 'orders' && <section className="admin-section">
          <div className="section-heading"><h1>Заказы</h1><button type="button" className="button secondary" disabled={busy}
            onClick={() => { setError(null); setOrdersVersion(version => version + 1); }}>Обновить</button></div>
          <form className="panel admin-form" onSubmit={event => {
            event.preventDefault();
            const raw = String(new FormData(event.currentTarget).get('number') ?? '').trim().replace(/^#/, '');
            if (raw && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)) {
              setError(new Error('Введите номер заказа.'));
              return;
            }
            setError(null);
            setOrderSearch(raw ? String(Number(raw)) : '');
            setOrderCursors([]);
          }}>
            <label className="admin-field">Номер заказа<input name="number" inputMode="numeric" className="admin-input" placeholder="#000123"/></label>
            <button className="button secondary" disabled={busy}>Найти</button>
            <label className="admin-field">Статус<select className="admin-input" value={orderSearch ? '' : orderStatus} disabled={busy} onChange={event => {
              setOrderStatus(event.target.value);
              setOrderSearch('');
              setOrderCursors([]);
              setError(null);
            }}>
              <option value="">Все статусы</option>
              {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            {orderSearch && <button type="reset" className="button secondary" disabled={busy} onClick={() => {
              setOrderSearch('');
              setOrderCursors([]);
              setError(null);
            }}>Сбросить поиск</button>}
          </form>
          <div className="admin-list">{orders?.orders.map(order => <div className="panel admin-item admin-order" key={order.id}>
            <div><strong>{order.number} · {order.title}</strong><p>{order.userName}{order.userUsername ? ` (@${order.userUsername})` : ''}</p></div>
            <span className="order-tag" data-status={order.status}>{statusLabel[order.status]}</span>
            {order.status === 'paid' && <button type="button" className="button secondary" disabled={busy} onClick={() => void run(
              () => api(`/admin/orders/${order.id}/install`, { method: 'POST' }), `Заказ ${order.number} отмечен как установленный.`)}>Установлено</button>}
            {order.method === 'crypto' && order.status !== 'paid' && order.status !== 'installed' &&
              <button type="button" className="button secondary" disabled={busy} onClick={() => void run(
                () => api(`/admin/orders/${order.id}/check`, { method: 'POST' }), `Статус заказа ${order.number} сверён с 2328.io.`)}>Сверить оплату</button>}
          </div>)}</div>
          {orders?.orders.length === 0 && <p className="history-empty">Заказы не найдены.</p>}
          {(orderCursors.length > 0 || orders?.nextBefore) && <div className="section-heading">
            <button type="button" className="button secondary" disabled={busy || !orderCursors.length}
              onClick={() => setOrderCursors(cursors => cursors.slice(0, -1))}>Назад</button>
            <button type="button" className="button secondary" disabled={busy || !orders?.nextBefore} onClick={() => {
              const next = orders?.nextBefore;
              if (next) setOrderCursors(cursors => [...cursors, next]);
            }}>Далее</button>
          </div>}
        </section>}
        {page === 'referral' && <section className="admin-section">
          <div className="section-heading"><h1>Реферальная программа</h1></div>
          <ReferralEditor key={data.referralPercent} initialPercent={data.referralPercent} busy={busy} save={saveReferral}/>
        </section>}
      </div>
    </main>
  </>;
}
