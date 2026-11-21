'use client';

import { useEffect, useState } from 'react';
import { apiRequest } from './api-client';
import { Icon } from './icons';

// Icon URLs carry the catalog revision, so one download per URL is enough for the whole session.
// The HTTP cache keeps them between launches.
const icons = new Map<string, Promise<string>>();

function loadIcon(url: string) {
  let pending = icons.get(url);
  if (!pending) {
    pending = apiRequest(url.slice('/api'.length), { cache: 'default' }).then(async response => {
      if (!response.ok) throw new Error('icon');
      const blob = await response.blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('icon'));
        reader.onerror = () => reject(new Error('icon'));
        reader.readAsDataURL(blob);
      });
    });
    icons.set(url, pending);
    pending.catch(() => { if (icons.get(url) === pending) icons.delete(url); });
  }
  return pending;
}

export function CatalogIcon({ url }: { url: string }) {
  const [image, setImage] = useState<{ url: string; source: string }>();

  useEffect(() => {
    let active = true;
    loadIcon(url).then(source => { if (active) setImage({ url, source }); }).catch(() => {});
    return () => { active = false; };
  }, [url]);

  return image?.url === url ? <img className="app-icon" width="54" height="54" src={image.source} alt="" draggable={false}/>
    : <span className="app-icon icon-placeholder"><Icon name="grid" size={22}/></span>;
}
