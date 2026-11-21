'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { ApiError, guardClosing, initTelegram, lockSwipes, registerBack, telegram } from './api-client';
import { Brand, Icon } from './icons';

const Runtime = createContext<'loading' | 'ready' | 'error'>('loading');

export function useTelegramSettled() {
  return useContext(Runtime) !== 'loading';
}

/** Shows Telegram's native back button while `active` and routes presses to `handler`. */
export function useTelegramBack(active: boolean, handler: () => void) {
  const settled = useTelegramSettled();
  const latest = useRef(handler);
  useEffect(() => { latest.current = handler; });
  useEffect(() => {
    if (active && settled) return registerBack(() => latest.current());
  }, [active, settled]);
}

/** Keeps a sheet from being swiped away, and optionally asks before the Mini App is closed. */
export function useCloseProtection(confirmClose: boolean) {
  useEffect(() => lockSwipes(), []);
  useEffect(() => { if (confirmClose) return guardClosing(); }, [confirmClose]);
}

export function LaunchScreen({ error, retry }: { error?: Error | null; retry?: () => void }) {
  const sdkFailed = useContext(Runtime) === 'error';
  const problem = error ?? (sdkFailed ? new Error('Не удалось подключиться к Telegram.') : null);
  const tryAgain = sdkFailed ? () => window.location.reload() : retry;
  const denied = problem instanceof ApiError && problem.status === 401;
  const expired = denied && problem.expired;
  const insideTelegram = !!telegram()?.initData;
  return <main className="splash" aria-busy={!problem}>
    <div className="launch-panel">
      <Brand className="splash-brand"/>
      {denied ? <div className="launch-message">
        <h1>{expired ? 'Сессия истекла' : 'Откройте ReStore в Telegram'}</h1>
        <p>{problem.message}</p>
        {expired && insideTelegram ? <button type="button" className="button primary" onClick={() => telegram()?.close?.()}>Закрыть ReStore</button>
          : problem.botUrl && <a className="button primary" href={problem.botUrl}>Открыть бота<Icon name="external" size={17}/></a>}
        {sdkFailed && tryAgain && <button type="button" className="button secondary" onClick={tryAgain}>Попробовать ещё раз</button>}
      </div> : problem ? <div className="launch-message">
        <p role="alert">{problem.message}</p>
        {tryAgain && <button type="button" className="button secondary" onClick={tryAgain}>Попробовать ещё раз</button>}
      </div> : <div className="launch-progress" role="status" aria-label="Загружаем ReStore"><div className="loading-track"><span/></div></div>}
    </div>
  </main>;
}

export function TelegramRuntime({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  return <Runtime.Provider value={state}>
    {/* The SDK writes viewport variables to the document element. */}
    <Script src="https://telegram.org/js/telegram-web-app.js?65" strategy="afterInteractive"
      onReady={() => { initTelegram(); setState('ready'); }} onError={() => setState('error')}/>
    {children}
  </Runtime.Provider>;
}
