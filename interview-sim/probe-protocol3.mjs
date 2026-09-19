/**
 * probe-protocol3.mjs —— 标记为什么吐不出来？试"放到最末尾"
 *
 * probe-protocol2 的结论把上一轮的猜测推翻了：
 *   20 次调用**全部成功**，没有一次 max-tokens。
 *   所以之前那些失败是模型自己的波动，不是协议贵。
 *   但暴露出真正的问题：**吐标记只有 1/5** —— 协议写了，模型基本不理。
 *
 * 为什么？看 buildTurnSystem 的拼接顺序：
 *
 *   ENV + SOP + 自查 + [状态协议]  ← 格式要求在这里
 *   --- 本轮设定                   ← 又隔了一段
 *   --- 面试状态（【本轮必须做的事】）← 最后读到的又是动作，不是格式
 *
 * 格式要求被夹在中间了。模型对**结尾**最敏感，所以试：
 *   D 现状：协议在中间
 *   E      ：协议挪到整段的最后
 *   F      ：协议在最后 + 措辞更硬（"这一行必须是你回复的最后一行"）
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
const TOPIC_RE = /<!--\s*topic\s*:\s*(.+?)\s*-->/i;

const BRIEF_HEAD = [
  '本轮设定：',
  '- 目标方向：Java 后端',
  '- 目标职级：高级',
  '- 面试轮次：技术一面',
  '- 面试官风格：务实工程',
].join('\n');

const P_MID = [
  '', '---', '',
  '【每轮最后加一行标记】',
  '在你回复的最后，另起一行，原样输出这一行（把话题名换掉）：',
  '',
  '<!--topic: 分库分表-->',
  '',
  '- 还是上一轮那件事 → 填**和上一轮完全一样**的字。换新话题了 → 填新名字。',
  '- 4 到 8 个字，不要标点，不要解释。',
].join('\n');

const P_END = [
  '', '---', '',
  '【回复的最后一行】',
  '你这一轮的回复，必须以这样一行结束（把话题名换掉）：',
  '',
  '<!--topic: 分库分表-->',
  '',
  '- 还是上一轮那件事 → 填**和上一轮完全一样**的字；换新话题了 → 填新名字。',
  '- 4 到 8 个字，不要标点，不要解释，不要用自然语言描述它。',
].join('\n');

const P_END_HARD = [
  '', '---', '',
  '【硬要求：回复的最后一行】',
  '**不管这一轮你说了什么，回复的最后一行必须是下面这个格式，一行，放在最末尾：**',
  '',
  '<!--topic: 分库分表-->',
  '',
  '把 `分库分表` 换成这一轮实际聊的话题名（4–8 个字）。',
  '还是上一轮那件事 → 填和上一轮**完全一样**的字；换新话题了 → 填新名字。',
  '这一行候选人看不到。不要省略它，不要用自然语言替代它。',
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

const BLOCK = buildStateBlock(STATE);

const VARIANTS = [
  ['D 协议夹在中间（现状）', () => BRIEF_HEAD + '\n\n---\n\n' + P_MID + '\n\n---\n\n' + BLOCK],
  ['E 协议挪到最后', () => BRIEF_HEAD + '\n\n---\n\n' + BLOCK + '\n\n---\n\n' + P_END],
  ['F 挪到最后 + 措辞更硬', () => BRIEF_HEAD + '\n\n---\n\n' + BLOCK + '\n\n---\n\n' + P_END_HARD],
];

async function ask(messages, brief) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, brief, maxTokens: MAXTOK }),
  });
  return res.json();
}

async function main() {
  console.log('每格 ' + ROUNDS + ' 次，maxTokens=' + MAXTOK + '。只看"吐没吐出最后那行标记"\n');

  const summary = [];
  for (const [label, build] of VARIANTS) {
    let emitted = 0;
    let ok = 0;
    for (let i = 0; i < ROUNDS; i++) {
      let data;
      const t0 = Date.now();
      try {
        data = await ask(scenario(), build());
      } catch (e) {
        data = { ok: false, error: String(e.message || e) };
      }
      const ms = Date.now() - t0;
      if (data.ok) ok++;
      const m = data.ok ? TOPIC_RE.exec(data.text) : null;
      if (m) emitted++;
      // 看它把标记放在了哪里 —— 是不是真的在末尾
      const atEnd = m ? data.text.trimEnd().endsWith(m[0]) : false;
      console.log('  ' + (m ? (atEnd ? '✓' : '△') : (data.ok ? '·' : '✗')) + ' ' + label
        + ' #' + (i + 1) + '  ' + ms + 'ms  '
        + (m ? 'topic="' + m[1] + '"' + (atEnd ? '（在末尾）' : '（**不在末尾**）')
          : (data.ok ? '没吐（回复 ' + data.text.length + ' 字）' : data.error)));
    }
    summary.push({ label, emitted, ok });
    console.log('');
  }

  console.log('--- 汇总 ---');
  for (const s of summary) {
    console.log('  ' + s.label.padEnd(26) + ' 成功 ' + s.ok + '/' + ROUNDS + '   吐标记 ' + s.emitted + '/' + ROUNDS);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
