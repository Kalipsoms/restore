'use client';

import { useEffect, useId, useState } from 'react';
import type { PointerEvent } from 'react';
import { api, money } from '../api-client';
import type { Currency } from '../api-client';
import { CatalogIcon } from '../catalog-icon';
import { Icon } from '../icons';
import { Segments } from './segments';

type Period = 7 | 30 | 90;
type Metric = 'orders' | 'revenue';
type Day = { day: string; orders: number; revenue: number };
type Report = {
  currency: Currency;
  users: number;
  buyers: number;
  paidOrders: number;
  revenue: number;
  series: Day[];
  funnel: { created: number; paid: number; installed: number };
  topApps: { id: number; title: string; icon: string; orders: number }[];
};

const periods = [[7, '7 дней'], [30, '30 дней'], [90, '90 дней']] as const;
const metrics = [['orders', 'Заказы'], ['revenue', 'Выручка']] as const;
const count = new Intl.NumberFormat('ru-RU');
const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayDate = (day: string) => shortDate.format(new Date(`${day}T00:00:00Z`));

function PaymentChart({ series, currency, metric, setMetric }: {
  series: Day[]; currency: Currency; metric: Metric; setMetric: (metric: Metric) => void;
}) {
  const gradient = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const values = series.map(day => day[metric]);
  const peak = Math.max(...values);
  const factor = 10 ** Math.floor(Math.log10(Math.max(1, peak / 4)));
  const ceiling = Math.ceil(Math.max(1, peak / 4) / factor) * factor * 4;
  const points = values.map((value, i) => ({ x: i * 100 / (values.length - 1), y: 100 - value * 94 / ceiling }));
  const line = points.reduce((path, point, i) => {
    if (i === 0) return `M ${point.x} ${point.y}`;
    const previous = points[i - 1];
    const middle = (previous.x + point.x) / 2;
    return `${path} C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }, '');
  const ticks = [0, 1, 2, 3, 4];
  const labels = ticks.map(tick => series[Math.round(tick * (series.length - 1) / 4)]);
  const cursor = selected === null ? null : points[selected];
  const day = selected === null ? null : series[selected];
  const chartColor = metric === 'orders' ? 'var(--chart-violet)' : 'var(--chart-mint)';

  function pointAt(event: PointerEvent<HTMLDivElement>) {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - left) / width));
    setSelected(Math.round(ratio * (series.length - 1)));
  }

  function axisLabel(value: number) {
    if (metric === 'orders') return count.format(value);
    return compact.format(currency === 'RUB' ? value / 100 : value);
  }

  return <section className="panel dashboard-card chart-card" aria-labelledby="payments-heading" style={{ color: chartColor }}>
    <div className="dashboard-card-heading">
      <div><h2 id="payments-heading">Динамика оплат</h2><p>{metric === 'orders' ? 'Подтверждённые заказы по дням' : 'Внешние платежи по дням, ₽'}</p></div>
      <Segments options={metrics} value={metric} onChange={setMetric} label="Показатель графика"/>
    </div>
    <div className="chart-frame">
      <div className="chart-axis-y" aria-hidden="true">{ticks.map(tick => <span key={tick} style={{ top: `${tick * 23.5 + 6}%` }}>{axisLabel(ceiling * (4 - tick) / 4)}</span>)}</div>
      <div className="chart-body">
        <div className="chart-plot" tabIndex={peak ? 0 : undefined} role="group"
          aria-label="График по дням. Стрелки влево и вправо выбирают дату."
          onPointerMove={event => { if (peak && event.pointerType === 'mouse') pointAt(event); }}
          onPointerDown={event => { if (peak) pointAt(event); }}
          onPointerLeave={event => { if (event.pointerType === 'mouse') setSelected(null); }}
          onFocus={() => setSelected(point => point ?? series.length - 1)} onBlur={() => setSelected(null)}
          onKeyDown={event => {
            const current = selected ?? series.length - 1;
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? series.length - 1
              : current + (event.key === 'ArrowLeft' ? -1 : 1);
            setSelected(Math.max(0, Math.min(series.length - 1, next)));
          }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="chart-graphic" aria-hidden="true">
            <defs><linearGradient id={gradient} x2="0" y2="1">
              <stop stopColor="currentColor" stopOpacity=".27"/><stop offset="1" stopColor="currentColor" stopOpacity=".018"/>
            </linearGradient></defs>
            {ticks.map(tick => <path key={tick} d={`M 0 ${tick * 23.5 + 6} H 100`} className="chart-gridline" vectorEffect="non-scaling-stroke"/>)}
            {!!peak && <>
              <path d={`${line} L 100 100 H 0 Z`} fill={`url(#${gradient})`}/>
              <path d={line} className="chart-line" vectorEffect="non-scaling-stroke"/>
            </>}
          </svg>
          {!peak && <p className="chart-empty">За этот период пока нет {metric === 'orders' ? 'оплат' : 'внешних платежей'}</p>}
          {!!peak && cursor && day && <>
            <span className="chart-cursor" style={{ left: `${cursor.x}%` }} aria-hidden="true"/>
            <span className="chart-marker" style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }} aria-hidden="true"/>
            <div className="chart-tooltip" style={{ left: `${cursor.x}%` }} data-side={cursor.x > 57 ? 'left' : 'right'}>
              <small>{dayDate(day.day)}</small><strong>{metric === 'orders' ? count.format(day.orders) : money(day.revenue, currency)}</strong>
            </div>
          </>}
        </div>
        <div className="chart-axis-x" aria-hidden="true">{labels.map(label => <span key={label.day}>{dayDate(label.day)}</span>)}</div>
      </div>
    </div>
    <span className="admin-sr-only" aria-live="polite">{day && `${dayDate(day.day)}, ${metric === 'orders' ? `${count.format(day.orders)} оплат` : money(day.revenue, currency)}`}</span>
  </section>;
}

export function Dashboard() {
  const [period, setPeriod] = useState<Period>(30);
  const [metric, setMetric] = useState<Metric>('orders');
  const [result, setResult] = useState<{ period: Period; data: Report } | null>(null);
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<Report>(`/admin/dashboard?days=${period}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResult({ period, data });
    }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [period, attempt]);

  const report = result?.period === period ? result.data : null;
  const funnel = report?.funnel;
  const topCount = report?.topApps[0]?.orders || 1;

  return <section className="dashboard" aria-labelledby="dashboard-title" aria-busy={!report && !error}>
    <div className="dashboard-heading">
      <div><h1 id="dashboard-title">Обзор</h1>
        <p><Icon name="calendar" size={16}/>{report ? `${dayDate(report.series[0].day)} — ${dayDate(report.series.at(-1)!.day)} · МСК` : 'Продажи и пользователи ReStore'}</p></div>
      <Segments options={periods} value={period} onChange={setPeriod} label="Период отчёта"/>
    </div>
    {error && <div className="panel dashboard-error"><p role="alert">{error}</p><button type="button" className="button secondary" onClick={() => retry(value => value + 1)}>Повторить</button></div>}
    {(!error || report) && <>
      <div className="metric-grid">
        <article className="panel metric-card" data-tone="lavender"><h2><span className="metric-icon"><Icon name="users" size={17}/></span>Пользователи</h2><strong>{report ? count.format(report.users) : '—'}</strong><p>За всё время</p></article>
        <article className="panel metric-card" data-tone="mint"><h2><span className="metric-icon"><Icon name="bag" size={17}/></span>Покупатели</h2><strong>{report ? count.format(report.buyers) : '—'}</strong><p>Уникальные за период</p></article>
        <article className="panel metric-card" data-tone="blue"><h2><span className="metric-icon"><Icon name="check" size={17}/></span>Оплачено</h2><strong>{report ? count.format(report.paidOrders) : '—'}</strong><p>Заказов за период</p></article>
        <article className="panel metric-card" data-tone="gold"><h2><span className="metric-icon"><Icon name="wallet" size={17}/></span>Выручка</h2><strong>{report ? money(report.revenue, report.currency) : '—'}</strong><p>Внешние платежи</p></article>
      </div>
      {report && funnel ? <>
        <div className="dashboard-graphs">
          <PaymentChart key={period} series={report.series} currency={report.currency} metric={metric} setMetric={setMetric}/>
          <section className="panel dashboard-card ranking-card" aria-labelledby="ranking-title">
            <div className="dashboard-card-heading"><div><h2 id="ranking-title">Популярные приложения</h2><p>По числу оплаченных заказов</p></div></div>
            {report.topApps.length ? <ul className="ranking-list">{report.topApps.map(app => <li key={app.id}>
              <CatalogIcon url={app.icon}/>
              <div><strong>{app.title}</strong><span className="ranking-track" aria-hidden="true"><span style={{ width: `${app.orders / topCount * 100}%` }}/></span></div>
              <span className="ranking-count">{count.format(app.orders)}</span>
            </li>)}</ul> : <p className="ranking-empty">Приложения появятся после первой оплаты</p>}
          </section>
        </div>
        <section className="panel dashboard-card" aria-labelledby="funnel-title">
          <div className="dashboard-card-heading"><div><h2 id="funnel-title">От заказа до установки</h2><p>Заказы, созданные за выбранный период</p></div>
            {funnel.created > 0 && <span className="funnel-badge">{Math.round(funnel.paid / funnel.created * 100)}% оплатили</span>}</div>
          <div className="funnel-steps">{([['Создано', funnel.created], ['Оплачено', funnel.paid], ['Установлено', funnel.installed]] as const).map(([label, value], index) =>
            <div className="funnel-step" key={label} data-step={index}>
              <span>{label}</span><strong>{count.format(value)}</strong>
              <div className="funnel-track" aria-hidden="true"><span style={{ width: `${value / Math.max(funnel.created, 1) * 100}%` }}/></div>
            </div>)}</div>
        </section>
      </> : <div className="panel dashboard-card dashboard-loading" role="status">Загружаем статистику…</div>}
    </>}
  </section>;
}
