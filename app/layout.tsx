import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/manrope';
import './globals.css';
import { TelegramRuntime } from './telegram-runtime';

export const metadata: Metadata = {
  title: 'ReStore — приложения для iPhone',
  description: 'Каталог приложений для iPhone и помощь с установкой.',
  icons: { icon: '/restore.svg' },
};

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#101017', colorScheme: 'dark light',
};

const themeScript = `(function(){try{var m=/tgWebAppThemeParams=([^&]+)/.exec(location.hash);if(!m)return;
var c=JSON.parse(decodeURIComponent(m[1])).bg_color;if(!/^#[0-9a-f]{6}$/i.test(c))return;var n=parseInt(c.slice(1),16);
document.documentElement.dataset.theme=.2126*(n>>16)+.7152*(n>>8&255)+.0722*(n&255)>140?'light':'dark'}catch(e){}})()`;

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" suppressHydrationWarning><body>
    {/* Runs before first paint so a light Telegram theme does not flash dark. */}
    <script dangerouslySetInnerHTML={{ __html: themeScript }}/>
    <TelegramRuntime>{children}</TelegramRuntime>
  </body></html>;
}
