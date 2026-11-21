import type { CSSProperties } from 'react';

export function Segments<T extends string | number>({ options, value, onChange, label }: {
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const index = options.findIndex(([option]) => option === value);
  return <div className="admin-segments" role="group" aria-label={label}
    style={{ '--segments': options.length, '--segment-index': index } as CSSProperties}>
    <span className="segment-indicator" aria-hidden="true"/>
    {options.map(([option, text]) => <button type="button" key={option} aria-pressed={value === option} onClick={() => onChange(option)}>{text}</button>)}
  </div>;
}
