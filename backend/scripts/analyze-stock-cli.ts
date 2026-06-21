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

  const lines: string[] = [];
  lines.push(`# ${ctx.stock.name || ctx.stock.code} (${ctx.stock.code}) 融合分析报告`);
  lines.push(`截止: ${asOf}\n`);
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
  lines.push(claudeReply);

  lines.push(`\n---\n\n## C. 融合建议\n`);
  lines.push(`引擎是**量化结果**, Claude 是**研报式叙述**. 一致则信号强, 冲突则用 Claude 的 narrative 解释为什么引擎数字背后藏着风险.`);
  lines.push(`\n**操作建议** (你自己拍板): 引擎 ${engineResult.action} + Claude 怎么说 → 综合决定.`);

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`✓ 融合报告写入 ${outPath}`);
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

  if (!cmd || !stockCode) {
    console.error('Usage:');
    console.error('  ./analyze-stock-cli.ts export <stock> [--as-of=YYYY-MM-DD] [--out=path.md]');
    console.error('  ./analyze-stock-cli.ts engine <stock> [--as-of=YYYY-MM-DD]');
    console.error('  ./analyze-stock-cli.ts fusion <stock> --claude-reply=path.md [--as-of=YYYY-MM-DD] [--out=report.md]');
    process.exit(1);
  }

  try {
    if (cmd === 'export') await modeExport(stockCode, asOf, outArg);
    else if (cmd === 'engine') await modeEngine(stockCode, asOf);
    else if (cmd === 'fusion') {
      if (!claudeReplyArg) throw new Error('fusion 模式需要 --claude-reply=path.md');
      await modeFusion(stockCode, asOf, claudeReplyArg, outArg);
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
