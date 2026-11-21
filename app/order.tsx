'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, money, openExternal, statusLabel, telegram } from './api-client';
import type { Bootstrap, CatalogApp, Method, Order } from './api-client';
import { CatalogIcon } from './catalog-icon';
import { ExternalLink } from './external-link';
import { Icon } from './icons';
import type { IconName } from './icons';
import { useCloseProtection, useTelegramBack } from './telegram-runtime';

const methodList: { key: Method; icon: IconName; title: string; disabledText: string }[] = [
  { key: 'balance', icon: 'wallet', title: 'Бонусный баланс', disabledText: 'Недоступно' },
  { key: 'crypto', icon: 'crypto', title: 'Криптовалюта', disabledText: 'Недоступно' },
  { key: 'sbp', icon: 'sbp', title: 'СБП', disabledText: 'Недоступно' },
];

// The request id is the idempotency key of an order. It is kept until the server gives a final
// answer, so a retry after a lost response returns the same order instead of charging twice.
function saveRequest(key: string, requestId: string | null) {
  try {
    if (requestId) sessionStorage.setItem(key, requestId);
    else sessionStorage.removeItem(key);
  } catch {
    // The in-memory key also survives reopening checkout while the page is open.
  }
}

export function Checkout({ data, app, initialOrder, pendingRequests, refresh, close }: {
  data: Bootstrap; app?: CatalogApp; initialOrder?: Order; pendingRequests: Map<string, string>;
  refresh: () => Promise<Bootstrap>; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef('');
  const [showMethods, setShowMethods] = useState(false);
  const [closing, setClosing] = useState(false);
  const amount = app?.price ?? 0;
  const available = (key: Method) => data.methods[key] && (key !== 'balance' || data.balance >= amount);
  const [method, setMethod] = useState<Method | null>(() => {
    const usable = methodList.filter(item => available(item.key));
    return usable.length === 1 ? usable[0].key : null;
  });
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const settled = order?.status === 'paid' || order?.status === 'installed';
  const pending = order?.status === 'pending' || order?.status === 'verifying';
  const orderId = order?.id;
  const updateOrder = useCallback((next: Order) => {
    setOrder(current => {
      if (current?.status === 'installed' || (current?.status === 'paid' && next.status !== 'installed')) return current;
      return next;
    });
  }, []);

  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    document.body.classList.add('modal-open');
    return () => { modal?.close(); document.body.classList.remove('modal-open'); };
  }, []);

  useEffect(() => {
    if (!orderId || !pending) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<Order>(`/orders/${orderId}`);
        if (cancelled) return;
        updateOrder(next);
        if (next.status !== 'pending' && next.status !== 'verifying') return;
      } catch { /* The explicit check can show connection errors. */ }
      if (!cancelled) timeout = setTimeout(poll, 2500);
    }
    timeout = setTimeout(poll, 1800);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [orderId, pending, updateOrder]);

  useEffect(() => {
    if (settled) {
      if (!initialOrder || initialOrder.status === 'pending' || initialOrder.status === 'verifying') {
        telegram()?.HapticFeedback?.notificationOccurred?.('success');
      }
      void refresh().catch(() => {});
    }
  }, [initialOrder, refresh, settled]);

  const check = useCallback(async () => {
    if (!orderId) return;
    setVerifying(true);
    setError('');
    setNotice('');
    try {
      const [next] = await Promise.all([
        api<Order>(`/orders/${orderId}/check`, { method: 'POST' }),
        new Promise(resolve => setTimeout(resolve, 650)),
      ]);
      updateOrder(next);
      if (next.status === 'pending') setNotice('Подтверждение пока не поступило. Статус обновится автоматически.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally { setVerifying(false); }
  }, [orderId, updateOrder]);

  function dismiss() {
    if (!busy) setClosing(true);
  }

  useTelegramBack(true, () => {
    if (busy) return;
    if (showMethods && !order) {
      setShowMethods(false);
      setError('');
    } else dismiss();
  });
  // Closing Telegram in the middle of a payment is confirmed first; the sheet itself cannot be swiped away.
  useCloseProtection(busy || pending);

  function pay() {
    if (order?.paymentUrl) openExternal(order.paymentUrl);
  }

  function selectMethod(next: Method) {
    if (next === method) return;
    request.current = '';
    setError('');
    setMethod(next);
  }

  async function submit() {
    if (!app || !method || busy) return;
    const requestKey = `${app.id}:${method}`;
    const storageKey = `restore:order-request:${data.user.id}:${requestKey}`;
    const forget = () => {
      pendingRequests.delete(requestKey);
      saveRequest(storageKey, null);
      request.current = '';
    };
    setBusy(true);
    setError('');
    try {
      let saved = pendingRequests.get(requestKey);
      if (!saved) {
        try { saved = sessionStorage.getItem(storageKey) ?? undefined; } catch { /* Storage is optional. */ }
      }
      request.current = saved ?? crypto.randomUUID();
      pendingRequests.set(requestKey, request.current);
      saveRequest(storageKey, request.current);
      const [next] = await Promise.all([
        api<Order>('/orders', { method: 'POST', body: JSON.stringify({ appId: app.id, method, amount,
          requestId: request.current, offerUrl: data.offerUrl }) }),
        new Promise(resolve => setTimeout(resolve, method === 'balance' ? 700 : 200)),
      ]);
      forget();
      setOrder(next);
    } catch (reason) {
      // A definite refusal means no order is in flight; anything else may still have been accepted.
      if (reason instanceof ApiError && [403, 409, 422].includes(reason.status)) {
        forget();
        if (reason.status === 409) void refresh().catch(() => {});
      }
      setError((reason as Error).message);
    } finally { setBusy(false); }
  }

  const title = order ? (settled ? (order.status === 'installed' ? 'Приложение установлено' : 'Заказ успешно оплачен') : statusLabel[order.status])
    : showMethods ? 'Подтверждение заказа' : 'Установка приложения';

  const stage = order?.status ?? (showMethods ? 'methods' : 'details');

  return <dialog ref={dialog} className="checkout" data-closing={closing} aria-labelledby="checkout-title" onCancel={event => {
    event.preventDefault();
    dismiss();
  }} onClick={event => { if (event.target === event.currentTarget) dismiss(); }} onAnimationEnd={event => {
    if (closing && event.target === event.currentTarget) close();
  }}>
    <div className="checkout-body">
      <div className="dialog-heading">
        {showMethods && !order && <button type="button" className="icon-button" aria-label="Назад" disabled={busy} onClick={() => { setShowMethods(false); setError(''); }}><Icon name="back" size={20}/></button>}
        <h2 id="checkout-title">{title}</h2>
        <button type="button" className="icon-button dialog-close" aria-label="Закрыть" disabled={busy} onClick={dismiss}><Icon name="close" size={20}/></button>
      </div>
      {!order && app && <div className="checkout-app"><CatalogIcon url={app.icon}/>
        <div><strong>{app.title}</strong><p>{app.category}</p></div><strong className="price">{money(amount, data.currency)}</strong></div>}
      {!order && app?.description && !showMethods && <p className="checkout-description">{app.description}</p>}
      <div className="checkout-stage" key={stage}>
      {order ? <>
        <div className="result" aria-live="polite">
          {settled ? <div className="result-mark success-mark"><Icon name="check" size={42}/></div> :
            verifying || order.status === 'verifying' ? <div className="result-mark verifying-mark"><Icon name="shield" size={36}/></div> :
              <div className="result-mark"><Icon name={pending ? 'wallet' : 'history'} size={34}/></div>}
          <p className="result-order">Заказ {order.number} · {order.title}</p>
          <strong>{money(order.amount, order.currency)}</strong>
          {settled && order.status !== 'installed' && <p>Для установки приложения напишите менеджеру. Номер заказа и название приложения уже будут в сообщении.</p>}
          {(verifying || order.status === 'verifying') && <p>Проверяем оплату. Это может занять несколько минут.</p>}
          {order.status === 'pending' && !verifying && <p>{order.paymentUrl ? 'Откройте счёт, чтобы оплатить заказ. После оплаты статус обновится здесь, а бот пришлёт сообщение.' : 'Откройте счёт повторно, чтобы продолжить оформление.'}</p>}
          {order.status === 'review' && <p>По этому платежу нужна дополнительная проверка. Напишите менеджеру и укажите номер заказа.</p>}
          {order.status === 'expired' && <p>Если вы успели отправить платёж, свяжитесь с менеджером и укажите номер заказа.</p>}
        </div>
        <div className="dialog-actions">
          {settled && order.status !== 'installed' && <ExternalLink url={order.managerUrl || ''} className="button primary wide">Написать менеджеру<Icon name="external" size={18}/></ExternalLink>}
          {pending && order.paymentUrl && <button type="button" className="button primary wide" onClick={pay}>Перейти к оплате<Icon name="external" size={18}/></button>}
          {pending && <button type="button" className="button secondary wide" disabled={verifying} onClick={() => void check()}>{verifying ? 'Проверяем заказ…' : order.status === 'pending' && !order.paymentUrl ? 'Восстановить счёт' : 'Проверить оплату'}</button>}
          {['review', 'expired'].includes(order.status) && <ExternalLink url={data.managerUrl} className="button secondary wide">Написать менеджеру<Icon name="external" size={18}/></ExternalLink>}
        </div>
      </> : app && <>
        {showMethods ? <>
          <fieldset className="payment-methods"><legend>Способ оплаты</legend>
            {methodList.map(item => {
              const enabled = available(item.key);
              const description = item.key === 'balance' ? (data.methods.balance ?
                (enabled ? `Доступно ${money(data.balance, data.currency)}` : `Недостаточно бонусов · ${money(data.balance, data.currency)}`) :
                item.disabledText) : item.key === 'crypto' ? (enabled ? '2328.io' : '2328.io · недоступно') :
                enabled ? 'Оплата в Telegram' : item.disabledText;
              return <label className="method" data-selected={method === item.key} key={item.key}>
                <input type="radio" value={item.key} name="method" checked={method === item.key} disabled={!enabled || busy} onChange={() => selectMethod(item.key)}/>
                <span className="small-tile"><Icon name={item.icon} size={19}/></span><span><strong>{item.title}</strong><small>{description}</small></span>
                <span className="radio-ring" aria-hidden="true"/>
              </label>;
            })}
          </fieldset>
          {data.checkoutError ? <p className="terms" role="status">{data.checkoutError}</p> :
            <p className="terms">Оплачивая заказ, вы принимаете <ExternalLink url={data.offerUrl} className="text-link">условия покупки</ExternalLink>.</p>}
          <button type="button" className="button primary wide" disabled={!method || !data.methods[method] || !data.offerUrl || busy} onClick={() => void submit()}>
            {busy ? <><span className="spinner"/> {method === 'balance' ? 'Проверяем оплату…' : 'Открываем счёт…'}</> : <>Подтвердить заказ<Icon name="arrow" size={19}/></>}
          </button>
        </> : <>
          <p className="app-order-note"><Icon name="headset" size={20}/>После оплаты менеджер подскажет, как установить приложение.</p>
          <button type="button" className="button primary wide" onClick={() => setShowMethods(true)}>Оформить установку<Icon name="arrow" size={19}/></button>
        </>}
      </>}
      </div>
      {notice && <p role="status" className="message">{notice}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </div>
  </dialog>;
}
