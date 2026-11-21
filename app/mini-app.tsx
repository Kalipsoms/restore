'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, money, onUnauthorized, statusLabel, telegram } from './api-client';
import type { Bootstrap, CatalogApp, Order } from './api-client';
import { CatalogIcon } from './catalog-icon';
import { ExternalLink } from './external-link';
import { Brand, Icon } from './icons';
import type { IconName } from './icons';
import { Checkout } from './order';
import { LaunchScreen, useTelegramBack, useTelegramSettled } from './telegram-runtime';

type Tab = 'catalog' | 'faq' | 'profile';

const tabs: { id: Tab; title: string; icon: IconName }[] = [
  { id: 'catalog', title: 'Главная', icon: 'home' },
  { id: 'faq', title: 'FAQ', icon: 'faq' },
  { id: 'profile', title: 'Профиль', icon: 'user' },
];

const categoryIcons: Record<string, IconName> = { Финансы: 'bank', Музыка: 'music', Видео: 'play', Общение: 'chat' };

const questions = [
  ['Как установить приложение?', 'Выберите приложение в каталоге, подтвердите заказ и оплатите установку. После оплаты напишите менеджеру через кнопку в заказе. Он проверит совместимость и подскажет дальнейшие шаги.'],
  ['На какие устройства можно установить?', 'ReStore помогает с установкой на iPhone. Совместимость зависит от приложения, модели и версии iOS. Уточните её у менеджера перед оплатой.'],
  ['Как я узнаю, что заказ оплачен?', 'Статус обновится в ReStore, а бот пришлёт номер заказа и кнопку для связи с менеджером. Все заказы можно посмотреть в профиле.'],
  ['Как работают реферальные бонусы?', 'Отправьте другу ссылку из профиля. Когда он впервые откроет бота по ней, мы учтём приглашение. За его подтверждённые платежи начислятся бонусы, которыми можно оплатить установки.'],
  ['Что делать, если возникла проблема?', 'Напишите менеджеру и укажите название приложения и номер заказа, если он уже есть.'],
];

function appCount(count: number) {
  const last = count % 10;
  const ending = count % 100;
  const noun = ending >= 11 && ending <= 14 ? 'приложений' : last === 1 ? 'приложение' : last >= 2 && last <= 4 ? 'приложения' : 'приложений';
  return `${count} ${noun}`;
}

export function Support({ url }: { url: string }) {
  return <aside className="support-card">
    <span className="small-tile"><Icon name="headset" size={22}/></span>
    <div><h3>Столкнулись с проблемой?</h3><p>Менеджер поможет с заказом и установкой.</p></div>
    <ExternalLink url={url} className="button secondary"><span>Написать менеджеру</span><Icon name="external" size={17}/></ExternalLink>
  </aside>;
}

function Catalog({ data, selected }: { data: Bootstrap; selected: (app: CatalogApp) => void }) {
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const categories = useMemo(() => Array.from(new Set(data.catalog.map(app => app.category))), [data.catalog]);
  const term = query.trim().toLocaleLowerCase('ru');
  const shown = data.catalog.filter(app => (!category || app.category === category) &&
    (!term || [app.title, app.category, app.description].some(text => text.toLocaleLowerCase('ru').includes(term))));

  return <>
    <section className="hero" aria-labelledby="hero-title">
      <picture className="hero-art">
        <source media="(max-width: 620px)" srcSet="/hero-compact.svg"/>
        <img src="/hero.svg" alt="" fetchPriority="high"/>
      </picture>
      <div className="hero-content">
        <h1 id="hero-title">Верните нужные <span>приложения.</span></h1>
        <p>Выберите приложение, которое пропало из App Store. Менеджер поможет с установкой.</p>
      </div>
    </section>
    <section className="catalog-section" aria-labelledby="catalog-title">
      <div className="section-heading"><h2 id="catalog-title">Каталог приложений</h2><span className="catalog-count" aria-live="polite">{appCount(shown.length)}</span></div>
      <div className="search-box">
        <Icon name="search" size={23}/><input ref={input} value={query} onChange={event => setQuery(event.target.value)}
          type="search" placeholder="Найти приложение…" aria-label="Поиск приложений" autoComplete="off"/>
        {query && <button className="icon-button" type="button" aria-label="Очистить поиск" onClick={() => { setQuery(''); input.current?.focus(); }}><Icon name="close" size={18}/></button>}
      </div>
      <div className="category-list" aria-label="Категории приложений">
        {[['', 'Все приложения'], ...categories.map(value => [value, value])].map(([value, label]) =>
          <button type="button" key={value} aria-pressed={category === value} className="category" onClick={() => setCategory(value)}>
            <Icon name={categoryIcons[value] || 'grid'} size={16}/>{label}
          </button>)}
      </div>
      {shown.length ? <div className="app-grid">
        {shown.map(app => <button type="button" className="app-card" key={app.id} onClick={() => selected(app)}>
          <CatalogIcon url={app.icon}/>
          <span className="app-text"><strong>{app.title}</strong><small>{app.description || app.category}</small></span>
          <span className="price">{money(app.price, data.currency)}</span>
          <Icon className="card-arrow" name="chevron" size={16}/>
        </button>)}
      </div> : <div className="empty-state"><span className="small-tile"><Icon name={term || category ? 'search' : 'grid'}/></span>
        <h3>{term || category ? 'Ничего не нашли' : 'Каталог пока пуст'}</h3>
        <p>{term || category ? 'Попробуйте другой запрос или выберите другую категорию.' : 'Доступные приложения появятся здесь.'}</p>
        {(term || category) && <button type="button" className="button secondary" onClick={() => { setQuery(''); setCategory(''); }}>Сбросить фильтры</button>}
      </div>}
    </section>
  </>;
}

function Faq({ data }: { data: Bootstrap }) {
  const [openQuestion, setOpenQuestion] = useState<number | null>(null);
  return <section className="inner-page" aria-labelledby="faq-title">
    <div className="page-heading"><span className="small-tile"><Icon name="faq"/></span><h1 id="faq-title">Частые вопросы</h1><p>Об установке, заказах и бонусах ReStore.</p></div>
    <div className="accordions">{questions.map(([question, answer], index) => {
      const expanded = openQuestion === index;
      const id = `faq-answer-${index}`;
      return <div className="accordion" data-open={expanded} key={question}>
        <h2><button className="accordion-toggle" type="button" aria-expanded={expanded} aria-controls={id}
          onClick={() => setOpenQuestion(expanded ? null : index)}>{question}<Icon name="down" size={20}/></button></h2>
        <div className="disclosure" id={id} data-open={expanded} inert={!expanded}><div><p>{answer}</p></div></div>
      </div>;
    })}</div>
    <Support url={data.managerUrl}/>
  </section>;
}

function Profile({ data, openOrder }: { data: Bootstrap; openOrder: (order: Order) => void }) {
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState(true);
  const initials = data.user.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();

  async function copyReferral() {
    try {
      await navigator.clipboard.writeText(data.referralUrl);
      setNotice('Ссылка скопирована');
    } catch {
      setNotice('Не удалось скопировать ссылку. Используйте кнопку «Пригласить»');
    }
  }

  const share = data.referralUrl && `https://t.me/share/url?url=${encodeURIComponent(data.referralUrl)}&text=${encodeURIComponent('ReStore помогает установить приложения на iPhone.')}`;

  return <section className="inner-page" aria-labelledby="profile-title">
    <div className="page-heading"><h1 id="profile-title">Профиль</h1></div>
    <div className="profile-card panel">
      <span className="avatar">
        {initials || <Icon name="user" size={28}/>}
        {data.user.photo && <img src={data.user.photo} alt="" onError={event => { event.currentTarget.hidden = true; }}/>}
      </span>
      <div className="profile-person"><h2>{data.user.name}</h2>{data.user.username && <p>@{data.user.username}</p>}</div>
      <div className="profile-balance"><small>Бонусный баланс</small><strong>{money(data.balance, data.currency)}</strong></div>
    </div>
    <section className="referral-card panel" aria-labelledby="referral-title">
      <div className="row-heading"><span className="small-tile"><Icon name="gift"/></span><div><h2 id="referral-title">Реферальная программа</h2>
        <p>{data.referralPercent ? `Получайте ${data.referralPercent}% с платежей друзей. Бонусы можно потратить на установку приложений.` : 'Начисление бонусов сейчас приостановлено.'}</p></div></div>
      <p className="referral-count">Приглашено друзей <strong>{data.invited}</strong></p>
      <div className="referral-actions"><ExternalLink url={share} className="button primary"><Icon name="link" size={18}/>Пригласить</ExternalLink>
        <button className="button secondary" type="button" disabled={!data.referralUrl} onClick={copyReferral}><Icon name="copy" size={18}/>Скопировать ссылку</button></div>
      {notice && <p className="message" role="status">{notice}</p>}
    </section>
    <section className="panel history-card" aria-labelledby="history-title">
      <h2 id="history-title"><button type="button" className="history-toggle" aria-expanded={history} aria-controls="profile-orders" onClick={() => setHistory(value => !value)}><Icon name="history" size={22}/>Мои заказы<Icon name="down" size={18}/></button></h2>
      <div id="profile-orders" className="disclosure" data-open={history} inert={!history}><div>{data.orders.length ? <div className="orders-list">{data.orders.map(order => <button type="button" className="history-order" key={order.id} onClick={() => openOrder(order)}>
        <span><strong>{order.title}</strong><small>{order.number} · {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(order.createdAt))}</small></span>
        <span className="order-tag" data-status={order.status}>{statusLabel[order.status]}</span><Icon name="chevron" size={16}/>
      </button>)}</div> : <p className="history-empty">Здесь появятся ваши заказы.</p>}</div></div>
    </section>
    <ExternalLink url={data.offerUrl} className="panel offer-row"><Icon name="file" size={21}/>Публичная оферта<Icon name="external" size={18}/></ExternalLink>
    {data.isAdmin && <Link href="/admin" className="panel offer-row"><Icon name="settings" size={21}/>Админка<Icon name="chevron" size={18}/></Link>}
    <Support url={data.managerUrl}/>
  </section>;
}

export function MiniApp() {
  const telegramSettled = useTelegramSettled();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tab, setTab] = useState<Tab>('catalog');
  const pendingRequests = useRef(new Map<string, string>());
  const [checkout, setCheckout] = useState<{ app?: CatalogApp; order?: Order } | null>(null);

  const refresh = useCallback(async () => {
    const result = await api<Bootstrap>('/bootstrap');
    if (!result?.user) throw new ApiError(401, 'Откройте чат с ботом и нажмите «Открыть ReStore».');
    setData(result);
    return result;
  }, []);

  const load = useCallback(() => {
    setError(null);
    void refresh().catch((reason: Error) => setError(reason));
  }, [refresh]);

  useEffect(() => { if (telegramSettled) load(); }, [load, telegramSettled]);
  // An expired Telegram session cannot be renewed in place, so every screen gives way to the notice.
  useEffect(() => onUnauthorized(reason => {
    setCheckout(null);
    setData(null);
    setError(reason);
  }), []);
  useTelegramBack(!!data && tab !== 'catalog', () => navigate('catalog'));

  function navigate(next: Tab) {
    if (next === tab) return;
    setTab(next);
    window.scrollTo(0, 0);
    if (next === 'profile') void refresh().catch(() => {});
  }

  function select(app: CatalogApp) {
    telegram()?.HapticFeedback?.impactOccurred?.('light');
    setCheckout({ app });
  }

  if (!data) return <LaunchScreen error={error} retry={load}/>;

  return <div className="mini-shell">
    <header className="topbar">
      <div className="shell topbar-inner">
        <button type="button" className="brand-button" onClick={() => navigate('catalog')} aria-label="ReStore, главная"><Brand/></button>
        <div className="header-actions">
          <button className="header-help" type="button" onClick={() => navigate('faq')} aria-label="Помощь"><Icon name="headset" size={19}/><span>Помощь</span></button>
          <button className="balance-pill" type="button" onClick={() => navigate('profile')} aria-label={`Бонусный баланс ${money(data.balance, data.currency)}`}><Icon name="wallet" size={19}/>{money(data.balance, data.currency)}</button>
        </div>
      </div>
    </header>
    <main className="shell main-shell view-stage">
      <div className="view-panel" data-active={tab === 'catalog'} inert={tab !== 'catalog'}><Catalog data={data} selected={select}/></div>
      <div className="view-panel" data-active={tab === 'faq'} inert={tab !== 'faq'}><Faq data={data}/></div>
      <div className="view-panel" data-active={tab === 'profile'} inert={tab !== 'profile'}><Profile data={data} openOrder={order => setCheckout({ order })}/></div>
    </main>
    <div className="nav-fade" aria-hidden="true"/>
    <nav className="bottom-nav" data-page={tab} aria-label="Основная навигация">
      <span className="nav-slider" aria-hidden="true"/>
      {tabs.map(item => <button type="button" key={item.id} aria-label={item.title} aria-current={tab === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
        <Icon name={item.icon} size={22}/>
      </button>)}
    </nav>
    {checkout && <Checkout data={data} app={checkout.app} initialOrder={checkout.order} pendingRequests={pendingRequests.current} refresh={refresh} close={() => setCheckout(null)}/>}
  </div>;
}
