import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Phase 12 — 工作区 Hero 组件
 *
 * 用法: 在工作区顶部渲染 hero (大标题 + KPI 大数字), 放进 WorkspaceLayout
 * 的 `hero` slot. 与 KPI bar 同时存在: hero 讲故事 + 大数字 (mount 一次, 不动);
 * KPI bar 是实时数字 (随 refresh 走). 不重复.
 *
 *  ┌── Hero ────────────────────────────────────────────────┐
 *  │ EYEBROW            ┌─KPI──┐ ┌─KPI──┐ ┌─KPI──┐         │
 *  │ TITLE              │ 1.2B │ │ +3.5%│ │  124 │         │
 *  │ subtitle           │ Total│ │ Today│ │ Open │         │
 *  └────────────────────────────────────────────────────────┘
 */
export interface WorkspaceHeroMetric {
  label: string;
  value: React.ReactNode;
  unit?: React.ReactNode;
  /** 颜色取向: up=A股红 / down=A股绿 / undefined=默认渐变白 */
  tone?: 'up' | 'down';
  /** 是否使用 48px 超大字号 (主指标用, 一个 hero 通常 1 个) */
  emphasis?: boolean;
}

export interface WorkspaceHeroProps {
  eyebrow: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  metrics?: WorkspaceHeroMetric[];
  /** 配色 — violet (默认普通用户) / admin (深灰) */
  variant?: 'violet' | 'admin';
  /** 自定义右侧 (覆盖 metrics, 给完全自定义内容用) */
  rightSlot?: React.ReactNode;
}

const WorkspaceHero: React.FC<WorkspaceHeroProps> = ({
  eyebrow,
  title,
  subtitle,
  metrics,
  variant = 'violet',
  rightSlot,
}) => {
  const reduceMotion = useReducedMotion();
  const variantClass = variant === 'admin' ? 'ws-hero--admin' : 'ws-hero--violet';

  const enter = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
      };

  return (
    <motion.section className={`ws-hero ${variantClass}`} {...enter}>
      <div className="ws-hero__inner">
        <div className="ws-hero__left">
          <span className="ws-hero__eyebrow">{eyebrow}</span>
          <h1 className="ws-hero__title">{title}</h1>
          {subtitle ? <p className="ws-hero__subtitle">{subtitle}</p> : null}
        </div>
        {rightSlot ? (
          <div className="ws-hero__right">{rightSlot}</div>
        ) : metrics && metrics.length > 0 ? (
          <div className="ws-hero__right">
            {metrics.map((m, i) => {
              const valueClass = [
                'ws-hero__metric-value',
                m.emphasis ? 'ws-hero__metric-value--lg' : '',
                m.tone === 'up' ? 'ws-hero__metric-value--up' : '',
                m.tone === 'down' ? 'ws-hero__metric-value--down' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <motion.div
                  key={i}
                  className="ws-hero__metric"
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.4,
                    delay: 0.1 + i * 0.06,
                    ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
                  }}
                >
                  <span className="ws-hero__metric-label">{m.label}</span>
                  <span className={valueClass}>
                    {m.value}
                    {m.unit ? <span className="ws-hero__metric-unit">{m.unit}</span> : null}
                  </span>
                </motion.div>
              );
            })}
          </div>
        ) : null}
      </div>
    </motion.section>
  );
};

export default WorkspaceHero;
