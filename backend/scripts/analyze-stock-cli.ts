#!/usr/bin/env npx ts-node --transpile-only
/**
 * analyze-stock-cli.ts (Batch AV, Task 3b + 3c)
 *
 * 个人版离线股票分析工具 — 不上线, 仅本地命令行使用.
 *
 * 设计:
 *   - 模式 1 (Claude-as-TA): 把 prod 上某只票的完整数据 (行情/因子/KOL/新闻/财报/北向/盘口) 打包成
 *     `analysis context` 文件 (markdown), 用户复制到 Claude 对话里, Claude 写研报式总结回填.
 *   - 模式 2 (引擎): 直接调本地新引擎 (analysisEngineService.analyzeStock) 输出 8 维 evidence.
 *   - 模式 3 (融合): 1+2 都跑, 把两份输出渲染成对比 markdown.
 *
 * Why CLI? 用户原话: "这个可不作为上线的功能, 是作为我个人使用的功能". 不挂前端 / 不挂 cron.
 *
 * Usage:
 *   # 模式 1: 导出 context 供 Claude 分析
 *   ./analyze-stock-cli.ts export sh.688008 --out /tmp/claude-input.md
 *
 *   # 模式 2: 直接跑新引擎
 *   ./analyze-stock-cli.ts engine sh.688008
 *
 *   # 模式 3: 融合 (引擎结果 + 引擎导出 context 给 Claude → 然后让用户粘贴 Claude 回复 → 渲染融合 md)
 *   ./analyze-stock-cli.ts fusion sh.688008 --claude-reply /tmp/claude-reply.md --out /tmp/report.md
 */

import * as path from 'path';
import * as fs from 'fs';

// CWD 自动 detect: 优先 STOCKS_BACKEND_CWD env, 否则当前 cwd, 否则 ./
// 让 CLI 在本地 (/Users/.../backend) 和 prod (/opt/stocks/current/backend) 都能跑
const CWD = process.env.STOCKS_BACKEND_CWD || (fs.existsSync(path.join(process.cwd(), 'package.json')) ? process.cwd() : path.join(__dirname, '..'));
const NM = path.join(CWD, 'node_modules');
process.env.NODE_PATH = NM;
require('module').Module._initPaths();
process.chdir(CWD);
require(path.join(NM, 'dotenv')).config({ path: path.join(CWD, '.env') });

// Lazy require to ensure dotenv loaded
import { sequelize } from '../src/config/database';
import '../src/models';
import { Stock } from '../src/models/Stock';
import { DailyBar } from '../src/models/DailyBar';
import { FactorScore } from '../src/models/FactorScore';
import { RealtimeQuote } from '../src/models/RealtimeQuote';
import { analysisEngineService } from '../src/services/analysis-engine/AnalysisEngineService';
import { Op } from 'sequelize';

interface AnalysisContext {
  stock: { code: string; name: string | null; industry: string | null };
  asOf: string;
  recent_bars: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    change_pct: number;
  }>;
  factors: Record<string, { z: number; p?: number }>;
  realtime: { price: number; volume: number | null; bid: number | null; ask: number | null } | null;
  industry_peers?: Array<{ code: string; name: string }>;
}

async function loadContext(stockCode: string, asOf: string): Promise<AnalysisContext> {
  const stock = await Stock.findOne({ where: { symbol: stockCode } });
  if (!stock) throw new Error(`Stock ${stockCode} not found`);

  const end = new Date(`${asOf}T23:59:59.999Z`);
  const bars = await DailyBar.findAll({
    where: {
      stock_id: (stock as any).id,
      time: { [Op.lte]: end },
    },
    attributes: ['time', 'open', 'high', 'low', 'close', 'volume'],
    order: [['time', 'DESC']],
    limit: 30,
    raw: true,
  });

  const code6 = stockCode.replace(/\./g, '').replace(/^(sh|sz|bj)/, '');
  const factorRows = await FactorScore.findAll({
    where: { stock_code: code6, trade_date: { [Op.lte]: asOf } },
    attributes: ['factor_name', 'z_score', 'percentile', 'trade_date'],
    order: [['trade_date', 'DESC']],
    limit: 200,
    raw: true,
  });
  const factors: Record<string, { z: number; p?: number }> = {};
  for (const r of factorRows as any[]) {
    if (factors[r.factor_name] !== undefined) continue;
    factors[r.factor_name] = { z: Number(r.z_score), p: r.percentile ? Number(r.percentile) : undefined };
  }

  const rt: any = await RealtimeQuote.findOne({
    where: { symbol: stockCode },
    order: [['updated_at', 'DESC']],
    raw: true,
  });

  const reversedBars = bars.slice().reverse();
  return {
    stock: { code: stockCode, name: (stock as any).name, industry: (stock as any).industry },
    asOf,
    recent_bars: reversedBars.map((b: any, i: number) => {
      const prevClose = i > 0 ? Number(reversedBars[i - 1].close) : Number(b.close);
      const close = Number(b.close);
      return {
        time: typeof b.time === 'string' ? b.time.slice(0, 10) : new Date(b.time).toISOString().slice(0, 10),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close,
        volume: Number(b.volume),
        change_pct: prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0,
      };
    }),
    factors,
    realtime: rt
      ? {
          price: Number(rt.current_price),
          volume: rt.volume ? Number(rt.volume) : null,
          bid: rt.raw_payload?.bid1_price ?? rt.raw_payload?.bid1 ?? rt.raw_payload?.bid ?? null,
          ask: rt.raw_payload?.ask1_price ?? rt.raw_payload?.ask1 ?? rt.raw_payload?.ask ?? null,
        }
      : null,
  };
}

function renderContextMd(ctx: AnalysisContext): string {
  const lines: string[] = [];
  lines.push(`# ${ctx.stock.name || ctx.stock.code} (${ctx.stock.code}) 分析包`);
  lines.push(`\n截止日: ${ctx.asOf} | 行业: ${ctx.stock.industry || '未知'}`);
  lines.push(`\n## 你的任务\n请基于下列数据, 写一份分析报告. 5 维度结构必须有:`);
  lines.push(`- **基本面**: 估值 / 成长 / 质量\n- **技术面**: 趋势 / RSI/MACD / 量价\n- **资金面**: 北向 / 主力 / 内部增减持 / 融资余额\n- **新闻消息面**: 公告 / KOL / 热门概念\n- **情绪面**: 股吧 / 散户关注度 / 大盘环境`);
  lines.push(`\n最后给出: action (strong_buy/buy/add/hold/reduce/sell/strong_sell) + 置信度 [0,1] + 建议仓位 % + 入场区间 + 止损 + 止盈 + key_reasons[] + risk_warnings[].`);
  lines.push(`\n输出 JSON 块包在 \`\`\`json ... \`\`\` 里 (我会解析).\n`);
  lines.push(`\n---\n\n## 近 30 日 K 线`);
  lines.push('| 日期 | 开 | 高 | 低 | 收 | 涨跌% | 成交量(万股) |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const b of ctx.recent_bars.slice(-30)) {
    lines.push(`| ${b.time} | ${b.open.toFixed(2)} | ${b.high.toFixed(2)} | ${b.low.toFixed(2)} | ${b.close.toFixed(2)} | ${b.change_pct.toFixed(2)} | ${(b.volume / 10000).toFixed(0)} |`);
  }
  lines.push(`\n## 因子分 (z-score, 标准化截面排名, 22 因子 prod factor_scores)`);
  lines.push('| 因子 | z | 百分位 |');
  lines.push('|---|---|---|');
  for (const [name, v] of Object.entries(ctx.factors)) {
    lines.push(`| ${name} | ${v.z.toFixed(3)} | ${v.p ? (v.p * 100).toFixed(0) + '%' : '—'} |`);
  }
  if (ctx.realtime) {
    lines.push(`\n## 实时行情`);
    lines.push(`- 最新价: ${ctx.realtime.price}`);
    lines.push(`- bid1 / ask1: ${ctx.realtime.bid || '—'} / ${ctx.realtime.ask || '—'}`);
    lines.push(`- 成交量: ${ctx.realtime.volume || '—'}`);
  }
  return lines.join('\n');
}

async function modeExport(stockCode: string, asOf: string, outPath: string) {
  console.log(`▶ 加载 ${stockCode} 数据...`);
  const ctx = await loadContext(stockCode, asOf);
  const md = renderContextMd(ctx);
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`✓ 写入 ${outPath} (${md.length} 字符)`);
  console.log(`\n下一步: 复制 ${outPath} 内容到 Claude 对话, 让 Claude 输出分析 JSON, 保存到一个文件 (例如 /tmp/claude-reply.md), 然后:`);
  console.log(`  ./analyze-stock-cli.ts fusion ${stockCode} --claude-reply /tmp/claude-reply.md --out /tmp/report.md`);
}

async function modeEngine(stockCode: string, asOf: string) {
  console.log(`▶ 跑新分析引擎 ${stockCode} as-of=${asOf}...`);
  const r = await analysisEngineService.analyzeStock(stockCode, { as_of: asOf });
  console.log(`\n action: ${r.action} | 置信度: ${((r.overall_confidence || 0) * 100).toFixed(0)}% | 仓位: ${((r.suggested_position_pct || 0) * 100).toFixed(1)}%`);
  console.log(` 数据质量: ${r.data_quality?.level}`);
  if (r.entry_zone) console.log(` 入场: [${r.entry_zone[0]}, ${r.entry_zone[1]}] | 止损: ${r.stop_loss} | 止盈: ${r.take_profit}`);
  console.log('\n▶ 8 维度:');
  for (const dim of r.per_dimension || []) {
    const score = dim.score?.toFixed(1) ?? 'N/A';
    const conf = dim.confidence !== undefined ? (dim.confidence * 100).toFixed(0) : '?';
    console.log(`  ${dim.analyzer_key.padEnd(20)} score=${String(score).padStart(7)} conf=${String(conf).padStart(3)}%`);
    for (const ev of (dim.evidence || []).slice(0, 4)) {
      const arrow = ev.direction === 'bullish' ? '↑' : ev.direction === 'bearish' ? '↓' : '·';
      console.log(`    ${arrow} ${ev.label}${ev.detail ? ' — ' + ev.detail.substring(0, 100).replace(/\n/g, ' ') : ''}`);
    }
  }
  if (r.key_reasons?.length) {
    console.log('\n▶ Top 关键理由:');
    for (const x of r.key_reasons) console.log('  • ' + x);
  }
  if (r.risk_warnings?.length) {
    console.log('\n▶ 风险提示:');
    for (const w of r.risk_warnings) console.log('  ⚠️ ' + w);
  }
}

async function modeFusion(stockCode: string, asOf: string, claudeReplyPath: string, outPath: string) {
  console.log(`▶ 融合模式: 引擎 + Claude-as-TA`);
  const ctx = await loadContext(stockCode, asOf);
  const engineResult = await analysisEngineService.analyzeStock(stockCode, { as_of: asOf });
  let claudeReply = '';
  try {
    claudeReply = fs.readFileSync(claudeReplyPath, 'utf8');
  } catch {
    claudeReply = '(未找到 Claude 回复文件, 跳过)';
  }
  // Batch BA-4 (2026-06-22): 真 parse Claude 回复里的 JSON 块, 渲染对照表
  const claudeStructured = parseClaudeJsonBlock(claudeReply);

  const lines: string[] = [];
  lines.push(`# ${ctx.stock.name || ctx.stock.code} (${ctx.stock.code}) 融合分析报告`);
  lines.push(`截止: ${asOf}\n`);

  if (claudeStructured) {
    lines.push(`## A vs B 对照 (引擎 vs Claude)`);
    lines.push('');
    lines.push('| 维度 | 新引擎 | Claude (as TA) |');
    lines.push('|---|---|---|');
    const enginePosPct = ((engineResult.suggested_position_pct || 0) * 100).toFixed(1) + '%';
    const claudePos = claudeStructured.position_pct != null ? `${claudeStructured.position_pct}%` : '—';
    lines.push(`| action | **${engineResult.action}** | **${claudeStructured.action || '—'}** |`);
    lines.push(`| 置信度 | ${((engineResult.overall_confidence || 0) * 100).toFixed(0)}% | ${claudeStructured.confidence != null ? (claudeStructured.confidence * 100).toFixed(0) + '%' : '—'} |`);
    lines.push(`| 建议仓位 | ${enginePosPct} | ${claudePos} |`);
    lines.push(`| 入场区间 | ${engineResult.entry_zone ? `${engineResult.entry_zone[0]}-${engineResult.entry_zone[1]}` : '—'} | ${claudeStructured.entry_zone ? `${claudeStructured.entry_zone[0]}-${claudeStructured.entry_zone[1]}` : '—'} |`);
    lines.push(`| 止损 | ${engineResult.stop_loss ?? '—'} | ${claudeStructured.stop_loss ?? '—'} |`);
    lines.push(`| 止盈 | ${engineResult.take_profit ?? '—'} | ${claudeStructured.take_profit ?? '—'} |`);
    lines.push('');
    // 一致性判定
    const actionAgree = engineResult.action === claudeStructured.action;
    const sameDir = (a: string | undefined, b: string | undefined): boolean => {
      const bulls = ['strong_buy', 'buy', 'add'];
      const bears = ['strong_sell', 'sell', 'reduce'];
      if (!a || !b) return false;
      if (bulls.includes(a) && bulls.includes(b)) return true;
      if (bears.includes(a) && bears.includes(b)) return true;
      if (a === 'hold' && b === 'hold') return true;
      return false;
    };
    const directionAgree = sameDir(engineResult.action, claudeStructured.action);
    lines.push(`**一致性**: ${actionAgree ? '✅ 完全一致' : directionAgree ? '⚠️ 方向一致, 强度不同' : '❌ 显著分歧 — 重点关注'}\n`);
  }

  lines.push(`## A. 新引擎 (多维分析引擎 v2)\n`);
  lines.push(`**action**: ${engineResult.action} | **置信度**: ${((engineResult.overall_confidence || 0) * 100).toFixed(0)}% | **仓位**: ${((engineResult.suggested_position_pct || 0) * 100).toFixed(1)}%\n`);
  if (engineResult.entry_zone) lines.push(`- 入场区间: ${engineResult.entry_zone[0]} - ${engineResult.entry_zone[1]}`);
  if (engineResult.stop_loss) lines.push(`- 止损: ${engineResult.stop_loss}`);
  if (engineResult.take_profit) lines.push(`- 止盈: ${engineResult.take_profit}`);
  lines.push(`\n### 8 维度评分`);
  for (const dim of engineResult.per_dimension || []) {
    lines.push(`- **${dim.analyzer_key}** (conf ${((dim.confidence || 0) * 100).toFixed(0)}%): score=${dim.score?.toFixed(1)}`);
    for (const ev of (dim.evidence || []).slice(0, 3)) {
      lines.push(`  - ${ev.direction === 'bullish' ? '↑' : ev.direction === 'bearish' ? '↓' : '·'} ${ev.label}`);
    }
  }
  lines.push(`\n### 引擎关键理由`);
  for (const r of engineResult.key_reasons || []) lines.push(`- ${r}`);
  lines.push(`\n### 引擎风险提示`);
  for (const w of engineResult.risk_warnings || []) lines.push(`- ⚠️ ${w}`);

  lines.push(`\n---\n\n## B. Claude-as-TradingAgents 分析\n`);
  if (claudeStructured) {
    lines.push(`### 解析后字段`);
    lines.push('```json');
    lines.push(JSON.stringify(claudeStructured, null, 2));
    lines.push('```');
    if (claudeStructured.key_reasons?.length) {
      lines.push(`\n### Claude 关键理由`);
      for (const r of claudeStructured.key_reasons) lines.push(`- ${r}`);
    }
    if (claudeStructured.risk_warnings?.length) {
      lines.push(`\n### Claude 风险提示`);
      for (const w of claudeStructured.risk_warnings) lines.push(`- ⚠️ ${w}`);
    }
    lines.push(`\n### Claude 原文 (markdown)`);
  }
  lines.push(claudeReply);

  lines.push(`\n---\n\n## C. 融合建议\n`);
  lines.push(`引擎是**量化结果**, Claude 是**研报式叙述**. 一致则信号强, 冲突则用 Claude 的 narrative 解释为什么引擎数字背后藏着风险.`);
  lines.push(`\n**操作建议** (你自己拍板): 引擎 ${engineResult.action} + Claude ${claudeStructured?.action || '?'} → 综合决定.`);

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`✓ 融合报告写入 ${outPath}`);
}

/**
 * Batch BA-4: 从 Claude 回复 markdown 里提 ```json ... ``` 代码块并 parse.
 * 支持 (a) 标 ```json 的块 (b) 没标 lang 但内容是 JSON 的块.
 * 返 null 如果找不到或 parse 失败.
 */
function parseClaudeJsonBlock(text: string): {
  action?: string;
  confidence?: number;
  position_pct?: number;
  entry_zone?: [number, number];
  stop_loss?: number;
  take_profit?: number;
  key_reasons?: string[];
  risk_warnings?: string[];
} | null {
  if (!text) return null;
  // 尝试 ```json ... ``` 块
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) {
    try {
      return normalizeClaudeJson(JSON.parse(fenceMatch[1]));
    } catch {
      // 落到下面 fallback
    }
  }
  // fallback: 整段是 JSON
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return normalizeClaudeJson(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeClaudeJson(j: any) {
  if (!j || typeof j !== 'object') return null;
  const ezRaw = j.entry_zone || j.entryZone || j.buy_zone;
  let entryZone: [number, number] | undefined;
  if (Array.isArray(ezRaw) && ezRaw.length === 2) {
    entryZone = [Number(ezRaw[0]), Number(ezRaw[1])];
  }
  return {
    action: j.action || j.recommendation || undefined,
    confidence: typeof j.confidence === 'number' ? j.confidence :
      typeof j.confidence === 'string' ? Number(j.confidence) : undefined,
    position_pct: j.position_pct != null ? Number(j.position_pct) :
      j.suggested_position_pct != null ? Number(j.suggested_position_pct) * 100 : undefined,
    entry_zone: entryZone,
    stop_loss: j.stop_loss != null ? Number(j.stop_loss) : undefined,
    take_profit: j.take_profit != null ? Number(j.take_profit) : undefined,
    key_reasons: Array.isArray(j.key_reasons) ? j.key_reasons :
      Array.isArray(j.reasons) ? j.reasons : undefined,
    risk_warnings: Array.isArray(j.risk_warnings) ? j.risk_warnings :
      Array.isArray(j.risks) ? j.risks : undefined,
  };
}

/**
 * Batch BA-4: 批量模式 — 对多个 stock 跑 engine, 输出汇总 markdown table.
 * symbols 输入: --symbols=sh.688008,sz.300054 或 --symbols-file=path.txt (每行一个).
 */
async function modeBatch(symbols: string[], asOf: string, outPath: string) {
  console.log(`▶ 批量模式: ${symbols.length} 只票 as-of=${asOf}`);
  const results: Array<{ symbol: string; name?: string | null; ok: boolean; action?: string; conf?: number; pos?: number; entry?: [number, number] | null; sl?: number | null; tp?: number | null; dq?: string; top_reasons?: string[]; error?: string }> = [];
  for (const sym of symbols) {
    try {
      console.log(`  [${results.length + 1}/${symbols.length}] ${sym}...`);
      const stock = await Stock.findOne({ where: { symbol: sym }, attributes: ['name'] });
      const r = await analysisEngineService.analyzeStock(sym, { as_of: asOf });
      results.push({
        symbol: sym,
        name: stock ? (stock as any).name : null,
        ok: true,
        action: r.action,
        conf: r.overall_confidence,
        pos: r.suggested_position_pct,
        entry: r.entry_zone,
        sl: r.stop_loss,
        tp: r.take_profit,
        dq: r.data_quality?.level,
        top_reasons: (r.key_reasons || []).slice(0, 3),
      });
    } catch (e: any) {
      results.push({ symbol: sym, ok: false, error: e?.message ?? String(e) });
    }
  }

  const lines: string[] = [];
  lines.push(`# 批量分析报告 — ${symbols.length} 只票`);
  lines.push(`截止: ${asOf} | 生成时间: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n`);
  lines.push(`## 汇总表`);
  lines.push('| # | 股票 | 名称 | action | 置信 | 仓位 | 入场区间 | 止损 | 止盈 | 数据质量 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    if (!r.ok) {
      lines.push(`| ${i + 1} | ${r.symbol} | — | ❌ ${r.error?.substring(0, 30)} | | | | | | |`);
      return;
    }
    const confStr = r.conf != null ? `${(r.conf * 100).toFixed(0)}%` : '—';
    const posStr = r.pos != null ? `${(r.pos * 100).toFixed(1)}%` : '—';
    const entryStr = r.entry ? `${r.entry[0]}-${r.entry[1]}` : '—';
    lines.push(`| ${i + 1} | ${r.symbol} | ${r.name || '—'} | ${r.action} | ${confStr} | ${posStr} | ${entryStr} | ${r.sl ?? '—'} | ${r.tp ?? '—'} | ${r.dq || '—'} |`);
  });

  lines.push(`\n## 按 action 分组`);
  const byAction = new Map<string, typeof results>();
  for (const r of results) {
    if (!r.ok) continue;
    const act = r.action || 'unknown';
    if (!byAction.has(act)) byAction.set(act, []);
    byAction.get(act)!.push(r);
  }
  const actionOrder = ['strong_buy', 'buy', 'add', 'hold', 'reduce', 'sell', 'strong_sell'];
  for (const act of actionOrder) {
    const list = byAction.get(act);
    if (!list || list.length === 0) continue;
    lines.push(`\n### ${act} (${list.length} 只)`);
    for (const r of list) {
      lines.push(`- **${r.symbol}** ${r.name || ''} (置信 ${r.conf ? (r.conf * 100).toFixed(0) : '?'}%)`);
      for (const reason of r.top_reasons || []) {
        lines.push(`  - ${reason}`);
      }
    }
  }

  // 失败的票
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    lines.push(`\n## 分析失败 (${failed.length} 只)`);
    for (const r of failed) {
      lines.push(`- **${r.symbol}**: ${r.error}`);
    }
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`✓ 批量报告写入 ${outPath} (${results.filter(r => r.ok).length} 成功 / ${failed.length} 失败)`);
}

(async () => {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const stockCode = args[1];
  const asOfArg = args.find(a => a.startsWith('--as-of='))?.split('=')[1];
  const asOf = asOfArg || '2026-06-18';
  const outArg = args.find(a => a.startsWith('--out='))?.split('=')[1] ||
    args[args.indexOf('--out') + 1] ||
    `/tmp/${stockCode || 'analysis'}-${cmd}.md`;
  const claudeReplyArg = args.find(a => a.startsWith('--claude-reply='))?.split('=')[1] ||
    args[args.indexOf('--claude-reply') + 1];
  // Batch BA-4: batch mode args
  const symbolsArg = args.find(a => a.startsWith('--symbols='))?.split('=')[1];
  const symbolsFileArg = args.find(a => a.startsWith('--symbols-file='))?.split('=')[1];

  if (!cmd || (cmd !== 'batch' && !stockCode) || (cmd === 'batch' && !symbolsArg && !symbolsFileArg)) {
    console.error('Usage:');
    console.error('  ./analyze-stock-cli.ts export <stock> [--as-of=YYYY-MM-DD] [--out=path.md]');
    console.error('  ./analyze-stock-cli.ts engine <stock> [--as-of=YYYY-MM-DD]');
    console.error('  ./analyze-stock-cli.ts fusion <stock> --claude-reply=path.md [--as-of=YYYY-MM-DD] [--out=report.md]');
    console.error('  ./analyze-stock-cli.ts batch (--symbols=sh.X,sz.Y | --symbols-file=path.txt) [--as-of=YYYY-MM-DD] [--out=path.md]');
    process.exit(1);
  }

  try {
    if (cmd === 'export') await modeExport(stockCode, asOf, outArg);
    else if (cmd === 'engine') await modeEngine(stockCode, asOf);
    else if (cmd === 'fusion') {
      if (!claudeReplyArg) throw new Error('fusion 模式需要 --claude-reply=path.md');
      await modeFusion(stockCode, asOf, claudeReplyArg, outArg);
    } else if (cmd === 'batch') {
      let symbols: string[] = [];
      if (symbolsArg) {
        symbols = symbolsArg.split(',').map(s => s.trim()).filter(s => s.length > 0);
      } else if (symbolsFileArg) {
        const fileContent = fs.readFileSync(symbolsFileArg, 'utf8');
        symbols = fileContent.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#'));
      }
      if (symbols.length === 0) throw new Error('batch 模式需要至少 1 个 symbol');
      const batchOut = outArg.includes('/analysis-') ? `/tmp/batch-${asOf}.md` : outArg;
      await modeBatch(symbols, asOf, batchOut);
    } else throw new Error(`未知 cmd: ${cmd}`);
    process.exit(0);
  } catch (e: any) {
    console.error('ERR:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exit(1);
  } finally {
    try { await sequelize.close(); } catch {}
  }
})();
