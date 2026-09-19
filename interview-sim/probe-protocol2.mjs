/**
 * probe-protocol2.mjs —— 把样本量加上去，只比 V1（JSON）和 V3（一行标记）
 *
 * 上一轮 probe-protocol.mjs 是 3 样本，噪声大到不足以做决定
 * （V2 和 V1 在同一个 maxTokens 上连"回复 62 字"都一模一样，
 *   说明那一次失败是模型自己的波动，不是协议造成的）。
 *
 * 这一次：每个协议 × 同一个场景跑 5 次，固定 maxTokens=1600（面板当前的值）。
 * 只看两个数：成功几轮、吐标记几轮。
 *
 * 另外加一组"不带任何状态协议"做基线 —— 上一轮我漏了这个对照，
 * 所以"带协议更贵"这个结论其实混了另一个变量：状态块本身也在提示词里。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { emptyState, buildStateBlock } from '../lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:3080/interviewer/api/chat';
const RESUME = readFileSync(join(HERE, 'resume.md'), 'utf8');
const ROUNDS = 5;
const MAXTOK = 1600;

const BRIEF_HEAD = [
  '本轮设定：',
  '- 目标方向：Java 后端',
  '- 目标职级：高级',
  '- 面试轮次：技术一面',
  '- 面试官风格：务实工程',
].join('\n');

const P_JSON = [
  '', '---', '',
  '【每轮结束必须附带状态块】',
  '在你回复的**最后**，另起一行输出一个 HTML 注释形式的状态块。候选人看不到它：',
  '',
  '<!--state {"topic":"这一轮聊的话题","done":false,"boundary":"","note":""} -->',
  '',
  '字段：',
  '- `topic`：这一轮在聊什么。**和上一轮同一个话题就填一模一样的字**；换话题了才换名字。',
  '- `done`：这个话题是否已经聊透（true/false）',
  '- `boundary`：候选人明确说"不懂/不是我做/记不清"的地方。没有就填空字符串。',
  '- `note`：这一轮值得记下的一条观察。没有就填空字符串。',
  '- `plan`：**只在第一次看到简历那一轮填**，4 项左右的数组。',
  '',
  '⚠ 这个状态块**不会展示给候选人**，所以不要用自然语言描述状态。',
].join('\n');

const P_LINE = [
  '', '---', '',
  '【每轮最后加一行标记】',
  '在你回复的最后，另起一行，原样输出这一行（把话题名换掉）：',
  '',
  '<!--topic: 分库分表-->',
  '',
  '- 还是上一轮那件事 → 填**和上一轮完全一样**的字。换新话题了 → 填新名字。',
  '- 4 到 8 个字，不要标点，不要解释。',
  '- **另外**，只在第一次拿到简历的那一轮，在这行前面再加一行面试计划：',
  '  `<!--plan: 订单链路 | 缓存一致性 | 分库分表 | JVM-->`',
  '  以后不要再输出 plan 行。',
  '- 这一行不会展示给候选人，不要用自然语言描述它。',
].join('\n');

const STATE = {
  ...emptyState({ budgetMin: 45 }),
  plan: [{ topic: '订单创建链路' }, { topic: '库存预扣一致性' }, { topic: '分库分表' }, { topic: 'JVM' }],
  topic: '缓存一致性',
  turnsOnTopic: 2,
};

function scenario() {
  return [
    { role: 'user', text: '开始面试' },
    { role: 'assistant', text: 'Java 后端，高级，技术一面。简历先给我。' },
    { role: 'user', text: '简历如下：\n' + RESUME },
    { role: 'assistant', text: '订单创建那条链路先聊。7 次 RPC 拆完之后，哪几块是你亲手写的？' },
    { role: 'user', text: '拆 RPC 是我主导的。原来串行调 7 个下游，每个平均 120 毫秒。'
      + '我先做了依赖分析，发现 4 个可以并行、3 个能挪到异步。接口里只留 2 次同步 RPC。' },
    { role: 'assistant', text: '缓存那块呢？' },
    { role: 'user', text: '缓存一致性我们用 Caffeine 做本地一级，Redis 二级。先删 Redis 再删本地。' },
    { role: 'assistant', text: '多实例呢？' },
    { role: 'user', text: '多实例本地缓存的一致性……这个问题当时是我们组另一个同事主做的，'
      + '我知道最后是用 Redis 的 pub/sub 广播失效，但怎么保证广播不丢，我没深入看。' },
  ];
}

async function ask(messages, brief, maxTokens) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, brief, maxTokens }),
  });
  return res.json();
}

const VARIANTS = [
  ['A 基线：无协议 + 无状态块', (s) => BRIEF_HEAD, null],
  ['B 只加状态块（无协议）', (s) => BRIEF_HEAD + '\n\n---\n\n' + buildStateBlock(s), null],
  ['C 状态块 + JSON 协议', (s) => BRIEF_HEAD + '\n\n---\n\n' + P_JSON + '\n\n---\n\n' + buildStateBlock(s),
    /<!--\s*state\s+([\s\S]*?)-->/i],
  ['D 状态块 + 一行标记协议', (s) => BRIEF_HEAD + '\n\n---\n\n' + P_LINE + '\n\n---\n\n' + buildStateBlock(s),
    /<!--\s*topic\s*:\s*(.+?)\s*-->/i],
];

async function main() {
  console.log('每格 ' + ROUNDS + ' 次，maxTokens=' + MAXTOK + '（面板当前值）\n');
  console.log('  变体'.padEnd(30) + '成功   吐标记   平均耗时   失败时的耗时');

  const summary = [];
  for (const [label, build, re] of VARIANTS) {
    let ok = 0;
    let emitted = 0;
    let totalMs = 0;
    const failMs = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t0 = Date.now();
      let data;
      try {
        data = await ask(scenario(), build(STATE), MAXTOK);
      } catch (e) {
        data = { ok: false, error: String(e.message || e) };
      }
      const ms = Date.now() - t0;
      totalMs += ms;
      if (data.ok) {
        ok++;
        if (re && re.test(data.text)) emitted++;
      } else {
        failMs.push(ms);
      }
      const mark = !data.ok ? '✗' : (re && re.test(data.text) ? '✓' : '·');
      process.stdout.write('  ' + mark + ' ' + label + ' #' + (i + 1) + '  ' + ms + 'ms\n');
    }
    summary.push({ label, ok, emitted, avg: Math.round(totalMs / ROUNDS), failMs, needsMarker: !!re });
    console.log('');
  }

  console.log('--- 汇总（' + ROUNDS + ' 次/格）---');
  for (const s of summary) {
    console.log('  ' + s.label.padEnd(28)
      + ' 成功 ' + s.ok + '/' + ROUNDS
      + '  吐标记 ' + (s.needsMarker ? s.emitted + '/' + ROUNDS : '—')
      + '  平均 ' + s.avg + 'ms'
      + (s.failMs.length ? '  失败耗时 [' + s.failMs.join(', ') + ']' : ''));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
