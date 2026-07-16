import React from 'react';
import { Button } from 'antd';

export type FilterChipOption<V> = {
  value: V;
  label: string;
  ariaLabel: string;
  count?: number;
  disabled?: boolean;
};

export type FilterChipProps<V> = {
  options: FilterChipOption<V>[];
  value: V[];
  onChange: (next: V[]) => void;
  mode: 'single' | 'multi';
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
};

export function FilterChip<V extends string | number>({
  options,
  value,
  onChange,
  mode,
  ariaLabel,
  disabled,
  className,
}: FilterChipProps<V>) {
  const handleClick = (optValue: V) => {
    if (disabled) return;
    if (mode === 'single') {
      onChange([optValue]);
      return;
    }
    const idx = value.indexOf(optValue);
    if (idx >= 0) {
      onChange(value.filter(v => v !== optValue));
    } else {
      onChange([...value, optValue]);
    }
  };

  return (
    <div role="group" aria-label={ariaLabel} className={className}>
      {options.map(opt => {
        const selected = value.includes(opt.value);
        return (
          <Button
            key={String(opt.value)}
            type="default"
            size="small"
            disabled={disabled || opt.disabled}
            onClick={() => handleClick(opt.value)}
            role="checkbox"
            aria-checked={selected}
            aria-label={opt.ariaLabel}
            className={selected ? 'catdesk-filter-chip is-selected' : 'catdesk-filter-chip'}
            style={{ marginRight: 4, marginBottom: 4 }}
          >
            {opt.label}
            {opt.count != null && (
              <span
                style={{
                  marginLeft: 4,
                  fontSize: 11,
                  opacity: 0.7,
                }}
              >
                ({opt.count})
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
