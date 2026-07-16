export const CATALYST_LABELS: Record<string, string> = {
  earnings: '财报业绩',
  upgrade_downgrade: '评级调整',
  ma_activity: '并购重组',
  sector_move: '板块异动',
  regulator: '监管政策',
  geo_macro: '宏观事件',
  product: '产品进展',
  leadership: '管理层变动',
  unclassified: '其他事件',
};

export const RATING_LABELS: Record<string, string> = {
  A: 'A · 优秀',
  B: 'B · 良好',
  C: 'C · 中性',
  D: 'D · 偏弱',
  F: 'F · 较弱',
};

export const CONVICTION_LABELS: Record<string, string> = {
  HIGH: '高确信',
  MED: '中确信',
  LOW: '低确信',
};

export const RISK_GATE_LABELS: Record<string, string> = {
  GREEN: '风险通过',
  YELLOW: '谨慎观察',
  RED: '风险阻断',
};

export const MARKET_SCOPE_LABELS: Record<string, string> = {
  cn_a: '中国A股',
  us: '美国市场',
  jp: '日本市场',
  kr: '韩国市场',
  A: 'A股',
  US: '美股',
  JP: '日本',
  KR: '韩国',
};

export const PROFILE_LABELS: Record<string, string> = {
  us_preferred: '优选策略',
  multibagger: '高倍潜力策略',
  japan_blue_chip: '日本蓝筹策略',
  korea_semiconductor_chain: '韩国半导体链策略',
  japan_multibagger: '日本高倍潜力策略',
  korea_multibagger: '韩国高倍潜力策略',
};

export const GENERATION_STATUS_LABELS: Record<string, string> = {
  queued: '已排队',
  running: '生成中',
  completed: '已完成',
  failed: '生成失败',
};

export const SIZE_HINT_LABELS: Record<string, string> = {
  TIER_5: '五档仓位',
  TIER_3: '三档仓位',
  TIER_2: '二档仓位',
  TIER_1: '一档仓位',
  SKIP: '暂不参与',
};
