import React from 'react';

const DISCLAIMER_MAP: Record<string, string> = {
  size_hint_advisory: '仅参考·非下单 binding · 不构成投资建议',
};

interface DisclaimerFooterProps {
  disclaimerKey?: string;
}

export function DisclaimerFooter({ disclaimerKey = 'size_hint_advisory' }: DisclaimerFooterProps) {
  const text = DISCLAIMER_MAP[disclaimerKey] ?? '';
  if (!text) return null;

  return (
    <footer
      style={{
        padding: '8px 16px',
        textAlign: 'center',
        color: 'var(--cd-text-secondary)',
        fontSize: 11,
        borderTop: '1px solid var(--cd-border)',
      }}
    >
      {text}
    </footer>
  );
}
