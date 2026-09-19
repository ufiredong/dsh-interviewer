/**
 * dev-check.mjs —— 技能自检
 *
 *   node dev-check.mjs
 *
 * 技能最容易出的静默故障是**文件引用断裂**：SKILL.md 里写「见 references/xx.md」，
 * 但那个文件不存在或改了名。运行时不会报错，只会在真用的时候发现指令缺失。
 * 所以这里做静态引用检查。
 *
 * 第二件事是**评分数学的回归测试**。薪资数字是整份报告最容易被随口编出来的部分，
 * 固定住它的输入输出，改坏了立刻能发现。
 */
'use strict';

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compute, validate, DIMENSIONS, BANDS, CITY_FACTOR } from './scripts/score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const problems = [];
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');

// ---------------------------------------------------------------- 1. frontmatter

console.log('--- 技能入口 ---');

const skill = read('SKILL.md');
const fm = /^---[ \t]*\n([\s\S]*?)\n---/.exec(skill);
if (!fm) {
  problems.push('SKILL.md 缺少 frontmatter');
} else {
  const has = (k) => new RegExp('^' + k + ':', 'm').test(fm[1]);
  for (const key of ['name', 'description']) {
    if (!has(key)) problems.push('SKILL.md frontmatter 缺少 ' + key);
  }
  const name = /^name:[ \t]*(.+)$/m.exec(fm[1]);
  if (name && name[1].trim() !== 'interviewer') {
    problems.push('frontmatter name 是 "' + name[1].trim() + '"，但目录名是 interviewer');
  }
  const desc = /^description:[ \t]*(.+)$/m.exec(fm[1]);
  if (desc && desc[1].trim().length < 60) {
    problems.push('description 太短（' + desc[1].trim().length + ' 字符），技能可能不会被正确触发');
  }
}
console.log('SKILL.md  %d 行', skill.split('\n').length);

// ---------------------------------------------------------------- 2. 文件引用

console.log('\n--- 文件引用 ---');

const mentioned = new Set();
for (const m of skill.matchAll(/(?:references|templates|scripts)\/[\w.-]+/g)) {
  mentioned.add(m[0]);
}

let refOk = 0;
for (const rel of [...mentioned].sort()) {
  if (existsSync(join(HERE, rel))) {
    refOk++;
  } else {
    problems.push('SKILL.md 引用了 ' + rel + '，但文件不存在');
  }
}
console.log('SKILL.md 引用了 %d 个文件，%d 个存在', mentioned.size, refOk);

// 反向检查：references/ 下有文件但 SKILL.md 从没提过 —— 很可能是写了忘了接上
const refFiles = [];
for (const dir of ['references', 'templates']) {
  const p = join(HERE, dir);
  if (!existsSync(p)) continue;
  for (const f of readdirSync(p)) refFiles.push(dir + '/' + f);
}
for (const f of refFiles) {
  if (!mentioned.has(f)) {
    console.log('  · %s 没有被 SKILL.md 引用（孤儿文件）', f);
  }
}

// ---------------------------------------------------------------- 3. 评分回归

console.log('\n--- 评分回归 ---');

function near(a, b, eps = 0.005) { return Math.abs(a - b) < eps; }

const CASES = [
  {
    name: '全 5 分',
    scores: { depth: 5, design: 5, rigor: 5, comm: 5, boundary: 5 },
    city: '一线',
    want: { weighted: 5, level: 'P8 / 3-1 / T7', low: 120, high: 180 },
  },
  {
    name: '全 1 分',
    scores: { depth: 1, design: 1, rigor: 1, comm: 1, boundary: 1 },
    city: '一线',
    want: { weighted: 1, level: '—', low: 0, high: 0 },
  },
  {
    name: '中位（全 3 分）',
    scores: { depth: 3, design: 3, rigor: 3, comm: 3, boundary: 3 },
    city: '一线',
    want: { weighted: 3, level: 'P6 / 2-1 / T5', low: 45, high: 70 },
  },
  {
    name: '档位边界 3.80',
    scores: { depth: 3.8, design: 3.8, rigor: 3.8, comm: 3.8, boundary: 3.8 },
    city: '一线',
    want: { weighted: 3.8, level: 'P7 / 2-2 / T6', low: 70, high: 120 },
  },
  {
    name: '档位边界 2.20',
    scores: { depth: 2.2, design: 2.2, rigor: 2.2, comm: 2.2, boundary: 2.2 },
    city: '一线',
    want: { weighted: 2.2, level: 'P5 / 1-2 / T4', low: 30, high: 45 },
  },
  {
    name: '新一线系数',
    scores: { depth: 4, design: 4, rigor: 4, comm: 4, boundary: 4 },
    city: '新一线',
    want: { weighted: 4, level: 'P7 / 2-2 / T6', low: Math.round(70 * 0.82), high: Math.round(120 * 0.82) },
  },
  {
    name: '加权不取整（权重生效）',
    scores: { depth: 5, design: 1, rigor: 1, comm: 1, boundary: 1 },
    city: '一线',
    want: { weighted: 2.2, level: 'P5 / 1-2 / T4', low: 30, high: 45 },
  },
];

for (const c of CASES) {
  validate(c.scores);
  const r = compute(c.scores, c.city);
  const okW = near(r.weighted, c.want.weighted);
  const okL = r.band.level === c.want.level;
  const okS = r.low === c.want.low && r.high === c.want.high;
  const ok = okW && okL && okS;
  if (!ok) {
    problems.push('评分回归失败 [' + c.name + ']：得到 ' + r.weighted.toFixed(3) + ' / '
      + r.band.level + ' / ' + r.low + '-' + r.high
      + '，期望 ' + c.want.weighted + ' / ' + c.want.level + ' / ' + c.want.low + '-' + c.want.high);
  }
  const salary = c.want.low === 0 ? '不给出' : (r.low + '-' + r.high + ' 万');
  console.log('  %s %s  %s  %s  %s',
    ok ? '✓' : '✗', c.name.padEnd(20), r.weighted.toFixed(3),
    r.band.level.padEnd(16), salary);
}

// 权重必须加起来等于 1，否则加权分会系统性偏移
const wSum = DIMENSIONS.reduce((s, d) => s + d.weight, 0);
if (Math.abs(wSum - 1) > 1e-9) {
  problems.push('维度权重之和是 ' + wSum + '，必须等于 1');
}
// 档位必须按 min 降序且最后一个是兜底，否则 find() 会选错
for (let i = 1; i < BANDS.length; i++) {
  if (BANDS[i].min >= BANDS[i - 1].min) {
    problems.push('档位表没有按 min 严格降序，find() 会选错档位');
    break;
  }
}
if (BANDS[BANDS.length - 1].min > 0) {
  problems.push('档位表最后一个的 min 不是 <= 0，低分候选人会找不到档位');
}

console.log('\n权重之和 %s，档位 %d 档，城市档位 %d 种',
  wSum.toFixed(2), BANDS.length, Object.keys(CITY_FACTOR).length);

// ---------------------------------------------------------------- 4. 错误分支

console.log('\n--- 错误分支 ---');

const NEGATIVE = [
  { name: '缺维度', fn: () => validate({ depth: 4 }), want: /缺少维度/ },
  { name: '分数越界', fn: () => validate({ depth: 9, design: 3, rigor: 3, comm: 3, boundary: 3 }), want: /1-5/ },
  { name: '未知城市', fn: () => compute({ depth: 3, design: 3, rigor: 3, comm: 3, boundary: 3 }, '超一线'), want: /未知城市/ },
];

for (const t of NEGATIVE) {
  let caught = null;
  try { t.fn(); } catch (e) { caught = e; }
  const ok = caught !== null && t.want.test(caught.message);
  if (!ok) problems.push('错误分支未按预期抛出 [' + t.name + ']');
  console.log('  %s %s', ok ? '✓' : '✗', t.name);
}

// ---------------------------------------------------------------- 结论

if (problems.length) {
  console.error('\n✗ 检查未通过：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log('\n✓ 全部检查通过');
