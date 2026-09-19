#!/usr/bin/env node
/**
 * score.mjs —— 面试评分与薪资推导（确定性）
 *
 * 为什么要有这个脚本：薪资结论是整份报告里最容易被随口编出来的部分。
 * 把加权、定档、映射全部固定在这里，两次面试的结论才可比，也才可审计。
 *
 * 用法：
 *   node score.mjs '{"depth":4,"design":3,"rigor":4,"comm":3.5,"boundary":4}'
 *   node score.mjs '<分数JSON>' --city 新一线
 *   node score.mjs '<分数JSON>' --evidence '{"depth":"他的原话…"}'
 *   node score.mjs --demo
 *
 * 参数：
 *   --city <档位>       一线（默认）/ 新一线 / 二线 / 其他
 *   --evidence <JSON>   各维度的候选人原话证据，缺失会在输出中标注
 *   --json              只输出 JSON，便于程序消费
 *
 * 退出码：0 正常；1 输入不合法（缺维度、分数越界）
 *
 * 本文件既可当命令行工具跑，也可被 import（dev-check.mjs 用它做回归测试）。
 */

import { pathToFileURL } from 'node:url';

export const DIMENSIONS = [
  { key: 'depth',    name: '技术深度',   weight: 0.30 },
  { key: 'design',   name: '系统设计',   weight: 0.25 },
  { key: 'rigor',    name: '工程严谨',   weight: 0.20 },
  { key: 'comm',     name: '表达与结构', weight: 0.15 },
  { key: 'boundary', name: '边界认知',   weight: 0.10 },
];

/**
 * 薪资档位。年薪总包，单位万元，一线城市口径。
 * 来源：https://juejin.cn/post/7568468727033823283 （公开数据整理）
 */
export const BANDS = [
  { min: 4.5, level: 'P8 / 3-1 / T7', title: '专家级',     low: 120, high: 180 },
  { min: 3.8, level: 'P7 / 2-2 / T6', title: '高级',       low: 70,  high: 120 },
  { min: 3.0, level: 'P6 / 2-1 / T5', title: '中级',       low: 45,  high: 70 },
  { min: 2.2, level: 'P5 / 1-2 / T4', title: '初级',       low: 30,  high: 45 },
  { min: -1,  level: '—',             title: '不建议推进', low: 0,   high: 0 },
];

/** 城市系数。经验值，非调研数据。 */
export const CITY_FACTOR = { '一线': 1.00, '新一线': 0.82, '二线': 0.68, '其他': 0.58 };

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = { scores: null, city: '一线', evidence: {}, json: false };

  if (argv.includes('--demo')) {
    out.scores = { depth: 4, design: 2.5, rigor: 4, comm: 3.5, boundary: 4.5 };
    out.evidence = { depth: '（示例）能说清为什么不用更简单的 baseline', rigor: '（示例）提到 eval 集和失败归因' };
    return out;
  }

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--city') out.city = argv[++i];
    else if (a === '--evidence') out.evidence = JSON.parse(argv[++i] || '{}');
    else positional.push(a);
  }

  if (positional.length === 0) {
    throw new Error('缺少分数参数。用法：node score.mjs \'{"depth":4,...}\'');
  }
  out.scores = JSON.parse(positional.join(' '));
  return out;
}

export function validate(scores) {
  const missing = DIMENSIONS.filter((d) => !(d.key in scores)).map((d) => d.key + '（' + d.name + '）');
  if (missing.length) {
    throw new Error(
      '缺少维度：' + missing.join('、') + '\n' +
      '五个维度都必须给分，不允许留空 —— 没测到的维度说明面试流程有问题，应该补测而不是跳过。'
    );
  }
  const bad = [];
  for (const d of DIMENSIONS) {
    const v = Number(scores[d.key]);
    if (!Number.isFinite(v) || v < 1 || v > 5) bad.push(d.key + '=' + scores[d.key]);
  }
  if (bad.length) {
    throw new Error('分数必须在 1-5 之间（可为小数）：' + bad.join('、'));
  }
}

// ---------------------------------------------------------------- 计算

export function compute(scores, city) {
  const rows = DIMENSIONS.map((d) => {
    const score = Number(scores[d.key]);
    return {
      key: d.key,
      name: d.name,
      weight: d.weight,
      score,
      contribution: score * d.weight,
    };
  });

  const raw = rows.reduce((s, r) => s + r.contribution, 0);

  // 浮点坑：五个 3.8 分求和得到的是 3.7999999999999994，不是 3.8。
  // 直接拿去和档位阈值比，正好卡在边界上的候选人会被错误地降一档。
  // 先归一到 3 位小数（权重两位 × 分数一位，三位足够精确），
  // 再在比较时留一个极小容差兜底。
  const EPS = 1e-9;
  const weighted = Math.round(raw * 1000) / 1000;

  const band = BANDS.find((b) => weighted >= b.min - EPS);
  const factor = CITY_FACTOR[city];
  if (factor === undefined) {
    throw new Error('未知城市档位：' + city + '。可选：' + Object.keys(CITY_FACTOR).join(' / '));
  }

  const low = Math.round(band.low * factor);
  const high = Math.round(band.high * factor);

  return { rows, weighted, band, city, factor, low, high };
}

// ---------------------------------------------------------------- 输出

export function render(result, evidence) {
  const { rows, weighted, band, city, factor, low, high } = result;
  const L = [];

  L.push('## 评分明细');
  L.push('');
  L.push('| 维度 | 权重 | 得分 | 加权贡献 | 证据 |');
  L.push('|---|---|---|---|---|');
  for (const r of rows) {
    const ev = evidence[r.key];
    const evText = ev ? '有' : '**缺失**';
    L.push('| ' + r.name + ' | ' + (r.weight * 100) + '% | ' + r.score + ' | '
      + r.contribution.toFixed(3) + ' | ' + evText + ' |');
  }
  L.push('| **合计** | 100% | — | **' + weighted.toFixed(2) + '** | |');
  L.push('');

  const noEvidence = rows.filter((r) => !evidence[r.key]).map((r) => r.name);
  if (noEvidence.length) {
    L.push('> ⚠ **以下维度没有候选人原话作为证据：' + noEvidence.join('、') + '**');
    L.push('> 没有证据的分数不算数，请回到对话记录补上原话，或把该维度标为「未测到」。');
    L.push('');
  }

  L.push('## 定档');
  L.push('');
  L.push('- 加权分：**' + weighted.toFixed(2) + ' / 5.00**');
  L.push('- 职级对标：**' + band.level + '**（' + band.title + '）');

  if (band.title === '不建议推进') {
    L.push('- 薪资：**不给出**。这个分数段给薪资区间会误导人。');
  } else {
    L.push('- 城市档位：' + city + '（系数 ' + factor.toFixed(2) + '）');
    L.push('- 年薪总包：**' + low + ' - ' + high + ' 万**');
    if (factor !== 1) {
      L.push('  （一线口径 ' + band.low + ' - ' + band.high + ' 万 × ' + factor.toFixed(2) + '）');
    }
    L.push('');
    L.push('> 这是**总包**，不是 Base。跳槽时主要看 Base —— 若目标总包 ' + low + '-' + high
      + ' 万，按常规 Base 占总包 60%~70% 反推，Base 至少要谈到 '
      + Math.round(low * 0.60) + '-' + Math.round(high * 0.70) + ' 万。');
  }
  L.push('');
  L.push('> 模拟面试 ≠ 真实定级。真实结果还受城市、公司、团队缺口、轮次表现和议价能力影响。');

  return L.join('\n');
}

// ---------------------------------------------------------------- 入口

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    validate(args.scores);
  } catch (err) {
    console.error('✗ ' + err.message);
    process.exit(1);
  }

  let result;
  try {
    result = compute(args.scores, args.city);
  } catch (err) {
    console.error('✗ ' + err.message);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify({
      weighted: Number(result.weighted.toFixed(3)),
      level: result.band.level,
      title: result.band.title,
      city: result.city,
      factor: result.factor,
      salaryLowWan: result.low,
      salaryHighWan: result.high,
      dimensions: result.rows,
      missingEvidence: result.rows.filter((r) => !args.evidence[r.key]).map((r) => r.key),
    }, null, 2));
    return;
  }

  console.log(render(result, args.evidence));
}

// 只有被当成命令直接执行时才跑 main；被 import 时（dev-check.mjs）不跑。
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
