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
  width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#101017', colorScheme: 'dark',
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>
    <TelegramRuntime>{children}</TelegramRuntime>
  </body></html>;
}
