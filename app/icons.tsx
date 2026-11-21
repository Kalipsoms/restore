import type { ReactNode } from 'react';

const paths = {
  chart: <><path d="M4 4v14a2 2 0 0 0 2 2h14M8 14l4-4 3 2.5L20 7"/><path d="M16.5 7H20v3.5"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.8A4.2 4.2 0 0 1 7.7 13h2.6a4.2 4.2 0 0 1 4.2 4.2V19m1.1-14a3 3 0 0 1 0 6m3.9 8v-1.8a4.2 4.2 0 0 0-2.6-3.9"/></>,
  bag: <><path d="M6 8h12l2 11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1L6 8Zm3 1V7a3 3 0 0 1 6 0v2"/></>,
  upload: <><path d="M12 16V4m-4 4 4-4 4 4M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/></>,
  calendar: <><rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M8 3.5v4m8-4v4m-12 3h16"/></>,
  home: <><path d="m3.5 10 7.3-6.1a1.8 1.8 0 0 1 2.4 0l7.3 6.1"/><path d="M5.8 9.2v9.5c0 .8.7 1.5 1.5 1.5h9.4c.8 0 1.5-.7 1.5-1.5V9.2M10 20.2v-5.1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5.1"/></>,
  grid: <><rect x="3.5" y="3.5" width="6" height="6" rx="1.25"/><rect x="14.5" y="3.5" width="6" height="6" rx="1.25"/><rect x="3.5" y="14.5" width="6" height="6" rx="1.25"/><rect x="14.5" y="14.5" width="6" height="6" rx="1.25"/></>,
  faq: <><circle cx="12" cy="12" r="8.6"/><path d="M9.5 9a2.6 2.6 0 0 1 5.1.7c0 1.6-2.6 2-2.6 3.4m0 2.9h.01"/></>,
  user: <><circle cx="12" cy="8.3" r="3.4"/><path d="M5.2 20v-1.7a4.2 4.2 0 0 1 4.2-4.2h5.2a4.2 4.2 0 0 1 4.2 4.2V20"/></>,
  search: <><circle cx="10.6" cy="10.6" r="5.9"/><path d="m15 15 4.1 4.1"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  down: <path d="m6 9 6 6 6-6"/>,
  arrow: <><path d="M4.5 12h14.7m-5.8-5.8 5.8 5.8-5.8 5.8"/></>,
  external: <><path d="M7 17 17 7M7 7h10v10"/></>,
  wallet: <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M21 9h-5a3 3 0 0 0 0 6h5m-5-3h.01"/></>,
  phone: <><rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 6h2m-2 12h2"/></>,
  headset: <><path d="M4 13v-1a8 8 0 0 1 16 0v4a4 4 0 0 1-4 4h-3"/><rect x="3" y="12" width="5" height="6" rx="2"/><rect x="16" y="12" width="5" height="6" rx="2"/></>,
  bank: <><path d="m3 9 9-5 9 5v1H3V9Zm1 11h16M7 13v4m5-4v4m5-4v4"/></>,
  music: <><path d="M9 17V6l10-2v11M9 10l10-2"/><ellipse cx="6.5" cy="17.5" rx="2.5" ry="2"/><ellipse cx="16.5" cy="15.5" rx="2.5" ry="2"/></>,
  play: <><rect x="3.5" y="5.5" width="17" height="13" rx="3"/><path d="m10 9 5 3-5 3V9Z"/></>,
  chat: <path d="M20.5 11.5a7.8 7.8 0 0 1-8.1 7.5c-1 0-2-.2-2.8-.5l-4.2 1.3.8-3.6a7.1 7.1 0 0 1-1.9-4.7A7.8 7.8 0 0 1 12.4 4a7.8 7.8 0 0 1 8.1 7.5ZM8.9 11.5h.01m3.5 0h.01m3.5 0h.01"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  check: <path d="m5 12 4.3 4.3L19 6.7"/>,
  history: <><path d="M3.7 11a8.5 8.5 0 1 1 2.5 7.3M3.7 6.2V11h4.8M12 8v4l3 2"/></>,
  gift: <><rect x="4" y="9" width="16" height="4" rx="1"/><path d="M5.5 13v7h13v-7M12 9v11m0-11C4 9 7 1 12 9Zm0 0c8 0 5-8 0 0Z"/></>,
  link: <><path d="m10 14 4-4m-6.5 5.5-1 1a3 3 0 1 0 4.2 4.2l3-3a3 3 0 0 0 0-4.2m-3.4-3a3 3 0 0 1 0-4.2l3-3a3 3 0 1 1 4.2 4.2l-1 1"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/></>,
  file: <><path d="M6 3.5h8l4 4V20H6zM14 3.5V8h4m-9 4h6m-6 4h6"/></>,
  crypto: <><path d="M12 3v18M7 6h7a3 3 0 0 1 0 6H8m0 0h7a3 3 0 0 1 0 6H7"/></>,
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>,
  sbp: <><path d="m5 4 14 8-14 8V4Zm0 8h14m-14 0 6-4m-6 4 6 4"/></>,
  shield: <><path d="M12 3 5 6v5c0 4 2.8 7.7 7 10 4.2-2.3 7-6 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></>,
  download: <><path d="M12 4v11m-4-4 4 4 4-4M5 17v3h14v-3"/></>,
  back: <path d="m15 6-6 6 6 6"/>,
  plus: <path d="M12 5v14M5 12h14" />,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="17" r="2" fill="currentColor"/></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}

export function Brand({ className = '' }: { className?: string }) {
  return <span className={`brand ${className}`}><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
    <path fill="currentColor" d="M4.5 28V4h12.3C23.4 4 27.5 7.8 27.5 13c0 4.4-2.9 7.5-7.4 8.5L26 28h-7.2L9.9 18h6.7c3.4 0 5.1-1.7 5.1-4.1s-1.7-4-5.1-4h-6.5V28z"/>
  </svg><span>ReStore</span></span>;
}
