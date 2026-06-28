/**
 * Phase 16 — LiveIndicator
 *
 * sc-datav 借鉴: 大屏里那种"实时数据"小圆点 — 我们用浅色 + 绿点 + ring 脉冲
 * 实现, 不引入新依赖. 盘中 (周一~周五 09:30-15:00) 绿点 + 脉冲 + "实时";
 * 盘后/非交易日 灰点 + 静态 + "盘后".
 *
 * 用法:
 *   <LiveIndicator /> — 自动判断
 *   <LiveIndicator force="live|after" /> — 强制态 (测试用)
 *
 * 设计契约:
 *   - 不依赖后端时间 (用 Date.now() — 客户端时区为准, A 股市场不存在跨时区版本)
 *   - 字号 11px, 字重 600, 全大写 — 与 sectionDivider 同款 micro-label
 *   - prefers-reduced-motion: 脉冲自动停止 (CSS @media)
 */
import React from 'react';

export type LiveTone = 'live' | 'after';

function detectTone(now: Date): LiveTone {
  const dow = now.getDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return 'after';
  const m = now.getHours() * 60 + now.getMinutes();
  // 09:30 - 11:30 + 13:00 - 15:00 A 股盘中. 简化: 09:30-15:00 一律视为"实时".
  if (m >= 9 * 60 + 30 && m <= 15 * 60) return 'live';
  return 'after';
}

export interface LiveIndicatorProps {
  /** 强制态, 不传则按当前时间自动判断. */
  force?: LiveTone;
  /** 自定义文字; 不传则 live → '实时', after → '盘后'. */
  label?: string;
}

const LiveIndicator: React.FC<LiveIndicatorProps> = ({ force, label }) => {
  const tone = force ?? detectTone(new Date());
  const text = label ?? (tone === 'live' ? '实时' : '盘后');
  return (
    <span className={`live-indicator live-indicator--${tone}`}>
      <span className="live-dot" aria-hidden />
      {text}
    </span>
  );
};

export default LiveIndicator;
