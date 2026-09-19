/**
 * probe-protocol.mjs —— 状态块的**协议形式**该长什么样
 *
 * 背景：probe-tokens.mjs 测出来一件事 ——
 *   不带状态协议：1600 token 就够。
 *   带现在的 JSON 状态协议：**3000 都不够**（推理 token 全烧光，输出 0 字），要 5000 才行。
 *
 * 这个代价太大了。1600 → 5000 不只是贵，是"每轮都可能挂"——state-run 里 11 轮挂了 5 轮。
 *
 * 猜测：让模型每轮产一段 JSON（还要 plan 数组、还要保证 topic 字符串逐字一致）
 *       会把它拖进很长的推理。**协议越轻，它越不需要想。**
 *
 * 所以这里比三种协议，只看两件事：能不能吐出来（合规率）、要多少 token 才稳。
 *   V1 现状：HTML 注释里塞 JSON
 *   V2 一行话题标记 <!--topic: X-->
 *   V3 V2 + 只在第一次给简历时输出一行 <!--plan: A | B | C-->
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { emptyState, buildStateBlock } from '../lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:3080/interviewer/api/chat';
const RESUME = readFileSync(join(HERE, 'resume.md'), 'utf8');

const BRIEF_HEAD = [
  '本轮设定：',
  '- 目标方向：Java 后端',
  '- 目标职级：高级',
  '- 面试轮次：技术一面',
  '- 面试官风格：务实工程',
].join('\n');

// ---------------------------------------------------------------- 三种协议

const P_JSON = [
  '',
  '---',
  '',
  '【每轮结束必须附带状态块】',
  '在你回复的**最后**，另起一行输出一个 HTML 注释形式的状态块。候选人看不到它：',
  '',
  '<!--state {"topic":"这一轮聊的话题","done":false,"boundary":"","note":""} -->',
  '',
  '字段：',
  '- `topic`：这一轮在聊什么。**和上一轮同一个话题就填一模一样的字**；换话题了才换名字。',
  '- `done`：这个话题是否已经聊透（true/false）',
  '- `boundary`：候选人明确说"不懂/不是我做/记不清"的地方。没有就填空字符串。',
  '- `note`：这一轮值得记下的一条观察（最后评分要用）。没有就填空字符串。',
  '- `plan`：**只在第一次看到简历那一轮填**，4 项左右的数组。',
  '',
  '⚠ 这个状态块**不会展示给候选人**，所以不要用自然语言描述状态。',
  '⚠ `topic` 只由你判断；**"追了几次""还剩多少时间"由系统数，不用你算**。',
].join('\n');

const P_LINE = [
  '',
  '---',
  '',
  '【每轮最后加一行标记】',
  '在你回复的最后，另起一行，原样输出这一行（把话题名换掉）：',
  '',
  '<!--topic: 分库分表-->',
  '',
  '- 还是上一轮那件事 → 填**和上一轮完全一样**的字。换新话题了 → 填新名字。',
  '- 4 到 8 个字，不要标点，不要解释。',
  '- 这一行不会展示给候选人，不要用自然语言描述它。',
  '- "追了几次""还剩多少时间"由系统数，不用你算。',
].join('\n');

const P_LINE_PLAN = P_LINE + [
  '',
  '- **另外**，只在第一次拿到简历的那一轮，在这行前面再加一行面试计划：',
  '  `<!--plan: 订单链路 | 缓存一致性 | 分库分表 | JVM-->`',
  '  4 项左右，用 ` | ` 分隔。以后不要再输出 plan 行。',
].join('\n');

const PROTOCOLS = [
  ['V1 现状：JSON 状态块', P_JSON, /<!--\s*state\s+([\s\S]*?)-->/i],
  ['V2 一行话题标记', P_LINE, /<!--\s*topic\s*:\s*(.+?)\s*-->/i],
  ['V3 V2 + 一次性 plan 行', P_LINE_PLAN, /<!--\s*topic\s*:\s*(.+?)\s*-->/i],
];

// ---------------------------------------------------------------- 场景

/** 复现 state-run 里那几轮失败的位置：中段，已有计划、已在第二个话题上。 */
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

const STATE = {
  ...emptyState({ budgetMin: 45 }),
  plan: [{ topic: '订单创建链路' }, { topic: '库存预扣一致性' }, { topic: '分库分表' }, { topic: 'JVM' }],
  topic: '缓存一致性',
  turnsOnTopic: 2,
};

async function ask(messages, brief, maxTokens) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, brief, maxTokens }),
  });
  return res.json();
}

async function main() {
  console.log('同一个场景、同一段对话，只换协议。判据：吐没吐出标记 / 要多少 token\n');

  const results = [];

  for (const [label, proto, re] of PROTOCOLS) {
    const brief = BRIEF_HEAD + '\n\n---\n\n' + proto + '\n\n---\n\n' + buildStateBlock(STATE);
    for (const maxTokens of [1600, 2500, 4000]) {
      const t0 = Date.now();
      const data = await ask(scenario(), brief, maxTokens);
      const ms = Date.now() - t0;
      let verdict;
      if (!data.ok) {
        verdict = '✗ ' + data.error;
      } else {
        const m = re.exec(data.text);
        verdict = m ? '✓ 标记="' + m[1].slice(0, 40) + '"' : '· 没吐标记（回复 ' + data.text.length + ' 字）';
      }
      const row = { label, maxTokens, ok: data.ok, emitted: data.ok && re.test(data.text), ms, verdict };
      results.push(row);
      console.log('  ' + (row.emitted ? '✓' : (row.ok ? '·' : '✗')) + ' ' + label.padEnd(26)
        + ' maxTokens=' + String(maxTokens).padEnd(5) + ' ' + String(ms).padEnd(6) + 'ms  ' + verdict);
    }
    console.log('');
  }

  console.log('--- 汇总 ---');
  for (const [label] of PROTOCOLS) {
    const rows = results.filter((r) => r.label === label);
    const emitted = rows.filter((r) => r.emitted).length;
    const ok = rows.filter((r) => r.ok).length;
    const minOK = rows.filter((r) => r.ok).map((r) => r.maxTokens);
    console.log('  ' + label + '：成功 ' + ok + '/3，吐出标记 ' + emitted + '/3'
      + (minOK.length ? '，最低可用 maxTokens=' + Math.min(...minOK) : '，全部失败'));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
