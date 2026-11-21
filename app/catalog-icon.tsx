'use client';

import { useEffect, useState } from 'react';
import { apiRequest } from './api-client';
import { Icon } from './icons';

export function CatalogIcon({ url }: { url: string }) {
  const [image, setImage] = useState<{ url: string; source: string }>();

  useEffect(() => {
    const controller = new AbortController();
    const reader = new FileReader();
    reader.onload = () => {
      if (!controller.signal.aborted && typeof reader.result === 'string') {
        setImage({ url, source: reader.result });
      }
    };

    void apiRequest(url.slice('/api'.length), { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const blob = await response.blob();
      if (!controller.signal.aborted) reader.readAsDataURL(blob);
    }).catch(() => {});

    return () => { controller.abort(); reader.abort(); };
  }, [url]);

  return image?.url === url ? <img className="app-icon" width="54" height="54" src={image.source} alt="" draggable={false}/>
    : <span className="app-icon icon-placeholder"><Icon name="grid" size={22}/></span>;
}
