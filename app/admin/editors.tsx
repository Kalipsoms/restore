'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type { CatalogApp } from '../api-client';
import { CatalogIcon } from '../catalog-icon';
import { Icon } from '../icons';

export function readImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(new Error('Не удалось прочитать иконку.')));
    reader.readAsDataURL(file);
  });
}

export type AppDraft = {
  title: string; category: string; description: string; price: number; active: boolean; file: File | null;
};

function IconPicker({ existing, file, onChange, error, onError, disabled }: {
  existing?: string; file: File | null; onChange: (file: File | null) => void;
  error: string; onError: (error: string) => void; disabled: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ file: File; src: string } | null>(null);

  useEffect(() => {
    if (!file) return;
    let active = true;
    void readImage(file).then(src => { if (active) setPreview({ file, src }); }).catch(() => {
      if (active) onError('Не удалось прочитать иконку.');
    });
    return () => { active = false; };
  }, [file, onError]);

  function choose(next?: File) {
    if (!next || disabled) return;
    if (!next.size || next.size > 500 * 1024) {
      onError('Выберите файл размером от 1 байта до 500 КБ.');
      return;
    }
    if (!/\.(svg|png|jpe?g|webp)$/i.test(next.name) && !/^image\/(svg\+xml|png|jpeg|webp)$/.test(next.type)) {
      onError('Поддерживаются SVG, PNG, JPEG и WebP.');
      return;
    }
    onChange(next);
    onError('');
  }

  return <div className="full-field icon-field">
    <div className="admin-field-label">Иконка</div>
    <div className="icon-upload" data-dragging={dragging} data-disabled={disabled}
      onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }}>
      <label className="icon-upload-area">
        <input type="file" className="admin-sr-only" accept="image/svg+xml,image/png,image/jpeg,image/webp" disabled={disabled}
          aria-describedby={error ? 'icon-upload-error' : 'icon-upload-hint'} onChange={event => {
            choose(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}/>
        <span className="icon-upload-preview">
          {file && preview?.file === file ? <img src={preview.src} alt="" width="45" height="45"/>
            : existing ? <CatalogIcon url={existing}/> : <Icon name="upload" size={22}/>}
        </span>
        <span className="icon-upload-text"><strong>{file?.name || (existing ? 'Заменить иконку' : 'Выбрать иконку')}</strong>
          <small id="icon-upload-hint">{file ? `${Math.max(1, Math.ceil(file.size / 1024))} КБ` : 'SVG, PNG, JPEG, WebP до 500 КБ'}</small></span>
        <Icon name={file ? 'check' : 'upload'} className="icon-upload-action" size={19}/>
      </label>
      {file && <button type="button" className="icon-button" aria-label="Убрать выбранный файл" disabled={disabled} onClick={() => { onChange(null); onError(''); }}><Icon name="close" size={18}/></button>}
    </div>
    {error && <p id="icon-upload-error" className="form-error" role="alert">{error}</p>}
  </div>;
}

export function AppEditor({ current, categories, busy, save, close }: {
  current: CatalogApp | null; categories: string[]; busy: boolean;
  save: (draft: AppDraft) => void; close: () => void;
}) {
  const [category, setCategory] = useState(current?.category ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [error, setError] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const rubles = String(form.get('price') ?? '').trim().replace(',', '.');
    const price = Math.round(Number(rubles) * 100);
    setError('');
    if (!title || !category.trim()) {
      setError('Заполните название и категорию.');
      return;
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(rubles) || price < 1 || price > 99_999_999) {
      setError('Укажите цену от 0,01 до 999 999,99 ₽.');
      return;
    }
    if (!current && !file) {
      setFileError('Выберите иконку приложения.');
      return;
    }
    save({ title, category: category.trim(), description: String(form.get('description') ?? '').trim(),
      price, active: form.has('active'), file });
  }

  return <form className="panel admin-form" onSubmit={submit} noValidate>
    <h3>{current ? 'Редактировать приложение' : 'Новое приложение'}</h3>
    <div className="admin-fields">
      <label className="admin-field">Название<input name="title" maxLength={64} defaultValue={current?.title} required className="admin-input"/></label>
      <label className="admin-field">Категория<input name="category" maxLength={32} value={category} className="admin-input" autoComplete="off" required onChange={event => setCategory(event.target.value)}/></label>
      {!!categories.length && <div className="category-suggestions full-field" role="group" aria-label="Готовые категории">{categories.slice(0, 6).map(option =>
        <button key={option} type="button" aria-pressed={option === category} onClick={() => setCategory(option)}>{option}</button>)}</div>}
      <label className="admin-field full-field">Описание<input name="description" maxLength={140} defaultValue={current?.description} className="admin-input"/></label>
      <label className="admin-field">Цена в рублях<span className="admin-unit-field"><input name="price" inputMode="decimal" maxLength={10}
        className="admin-input" defaultValue={current ? String(current.price / 100).replace('.', ',') : '490'} required/><span aria-hidden="true">₽</span></span></label>
      <IconPicker existing={current?.icon} file={file} onChange={setFile} error={fileError} onError={setFileError} disabled={busy}/>
      <label className="admin-switch full-field"><span>Показывать в каталоге</span><input type="checkbox" name="active" className="admin-sr-only" role="switch" defaultChecked={!current || current.active === 1} disabled={busy}/><span className="switch-track" aria-hidden="true"/></label>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="referral-actions"><button className="button primary" disabled={busy}>Сохранить</button>
      <button type="button" className="button secondary" disabled={busy} onClick={close}>Отмена</button></div>
  </form>;
}

export function ReferralEditor({ initialPercent, busy, save }: { initialPercent: number; busy: boolean; save: (percent: number) => void }) {
  const [entry, setEntry] = useState(String(initialPercent));
  const [error, setError] = useState('');
  const percent = Math.min(100, Math.max(0, Number(entry) || 0));

  return <form className="panel admin-form referral-editor" noValidate onSubmit={event => {
    event.preventDefault();
    if (!/^\d{1,3}$/.test(entry) || Number(entry) > 100) {
      setError('Укажите целое число от 0 до 100.');
      return;
    }
    setError('');
    save(Number(entry));
  }}>
    <div className="referral-editor-heading">
      <div><h2 id="commission-title">Процент начисления</h2><p>Ставка применяется к новым заказам.</p></div>
      <label className="admin-unit-field referral-percent"><span className="admin-sr-only">Введите процент начисления</span>
        <input type="text" inputMode="numeric" className="admin-input" maxLength={3} value={entry} disabled={busy} onChange={event => {
          setEntry(event.target.value);
          setError('');
        }}/><span aria-hidden="true">%</span></label>
    </div>
    <input type="range" className="admin-range" aria-labelledby="commission-title" min={0} max={100} step={1}
      value={percent} aria-valuetext={`${percent}%`} disabled={busy} style={{ '--range-position': `${percent}%` } as CSSProperties}
      onChange={event => { setEntry(event.target.value); setError(''); }}/>
    <div className="range-labels" aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="button primary" disabled={busy || entry === String(initialPercent)}>Сохранить</button>
  </form>;
}
