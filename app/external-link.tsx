import type { ReactNode } from 'react';
import { openExternal } from './api-client';

export function ExternalLink({ url, children, className }: { url: string; children: ReactNode; className?: string }) {
  if (!url) return <button type="button" className={className} disabled>{children}</button>;
  return <a className={className} href={url} rel="noopener noreferrer" target="_blank" onClick={event => {
    event.preventDefault();
    openExternal(url);
  }}>{children}</a>;
}
