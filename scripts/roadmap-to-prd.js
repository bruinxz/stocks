#!/usr/bin/env node
/**
 * 把 docs/trader-system/99_implementation_roadmap.md 里的 user story 表格
 * 转成 ralph/prd.json
 *
 * 用法: node scripts/roadmap-to-prd.js
 */

const fs = require('fs');
const path = require('path');

const ROADMAP = path.join(__dirname, '..', 'docs', 'trader-system', '99_implementation_roadmap.md');
const OUT = path.join(__dirname, '..', 'ralph', 'prd.json');

const text = fs.readFileSync(ROADMAP, 'utf-8');

// 解析所有形如 "| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |" 行
// 标题行: | ID | 标题 | ...
// 分隔行: |---|---|...
// 数据行: | OPS-001 | env 校验脚本 | ... | P0 | — | ... |

const rows = [];
const lines = text.split('\n');
let inTable = false;
let layer = 'Unknown';
for (const line of lines) {
  const layerMatch = line.match(/^### Layer (\d+) — ([^（(]+)/);
  if (layerMatch) {
    layer = `L${layerMatch[1]}-${layerMatch[2].trim()}`;
    continue;
  }
  if (line.match(/^\|\s*ID\s*\|/)) { inTable = true; continue; }
  if (line.match(/^\|---/)) continue;
  if (line.match(/^\s*$/)) { inTable = false; continue; }
  if (!inTable) continue;
  if (!line.startsWith('|')) { inTable = false; continue; }
  // split, trim, drop first/last empty
  const cols = line.split('|').slice(1, -1).map(s => s.trim());
  if (cols.length < 6) continue;
  const [id, title, desc, prio, deps, accept] = cols;
  if (!id || !id.match(/^[A-Z][A-Z0-9-]+-\d+$/)) continue;
  rows.push({ id, title, desc, prio, deps, accept, layer });
}

console.error(`Parsed ${rows.length} stories`);

// 按优先级排序: P0 → P1 → P2 → 未标; 同优先级按 layer (L0→L8)
function prioRank(p) {
  if (p === 'P0') return 0;
  if (p === 'P1') return 1;
  if (p === 'P2') return 2;
  return 3;
}
function layerNum(l) {
  const m = l.match(/L(\d+)-/);
  return m ? parseInt(m[1], 10) : 99;
}
rows.sort((a, b) => {
  const r = prioRank(a.prio) - prioRank(b.prio);
  if (r !== 0) return r;
  const l = layerNum(a.layer) - layerNum(b.layer);
  if (l !== 0) return l;
  return a.id.localeCompare(b.id);
});

// 生成 userStories
const userStories = rows.map((r, idx) => {
  // 把 acceptance 拆成 1-3 条
  let crits = r.accept.split(/[；;]\s*|\s*\+\s*/).map(s => s.trim()).filter(Boolean);
  if (crits.length === 0) crits = [r.accept || '完成实施'];
  // 必加 typecheck
  if (!crits.some(c => /typecheck|tsc/i.test(c))) crits.push('Typecheck passes');
  if (!crits.some(c => /test/i.test(c))) crits.push('Relevant unit tests pass');
  // 前端 story 加 browser verify
  if (r.id.startsWith('FE-') || /UI|前端|workspace|modal|dashboard|panel|card|tab/i.test(r.title)) {
    if (!crits.some(c => /browser|dev-browser/i.test(c))) {
      crits.push('Verify in browser using dev-browser skill (or describe manual smoke if no browser env)');
    }
  }
  return {
    id: `US-${String(idx + 1).padStart(3, '0')}`,
    originalId: r.id,
    layer: r.layer,
    title: `[${r.id}] ${r.title}`,
    description: `As a 量化操盘手 / 系统用户, I want ${r.title}, so that ${r.desc}`,
    acceptanceCriteria: crits,
    priority: idx + 1,
    passes: false,
    notes: r.deps && r.deps !== '—' ? `依赖: ${r.deps}` : '',
  };
});

const prd = {
  project: 'TraderSystem-AShare-Production',
  branchName: 'ralph/trader-system-prod',
  description: '把"高级操盘手"做成生产级自动化系统 — 基于 docs/trader-system/ 下 54 份模块设计文档 + 99 路线图 (210 user story), 按 9 层依赖 (Ops 基础 → Data → Factor → Strategy → Portfolio/Risk → Execution → AI → Frontend → Postmortem) 推进. 目标: 模拟盘 sharpe ≥ 1.5, 30 日 dd ≤ 12%, 每笔交易 ≥ 3 条 AI evidence, 全链路 fail-closed. 当前已完成 Batch AI 闭环审计 + 多维分析引擎 v1 (Mar AI commit dd88cad). 本 prd 是 v2 完整落地. 总 story: ' + userStories.length + '. ralph 自主推进; 任何触实盘/触 secrets/触部署的改动跳过并写 notes 等用户.',
  userStories,
};

fs.writeFileSync(OUT, JSON.stringify(prd, null, 2));
console.error(`Wrote ${OUT} — ${userStories.length} stories`);
console.error('P0:', userStories.filter(s => prioRank(rows[parseInt(s.id.slice(3))-1]?.prio) === 0).length);
