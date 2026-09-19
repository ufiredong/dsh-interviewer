/**
 * probe-tokens.mjs —— 查"加了状态块之后为什么 max-tokens 挂掉"
 *
 * 现象：state-run.mjs 里 11 轮有 5 轮以 `模型未正常结束（max-tokens）` 失败，
 *       而同样的台词在无状态版（run.mjs）里只是偶尔失败。
 *
 * 猜测：状态协议让模型多写一段 JSON，加上推理 token 也计入 maxTokens，
 *       1600 这条线被顶穿了。
 *
 * 验法：同一段对话，分别用 1600 / 3000 / 5000 各发一次，看在哪一档开始稳。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  emptyState, buildStateBlock, stateProtocolBlock,
} from '../lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:3080/interviewer/api/chat';

const BRIEF_HEAD = [
  '本轮设定：',
  '- 目标方向：Java 后端',
  '- 目标职级：高级',
  '- 面试轮次：技术一面',
  '- 面试官风格：务实工程',
].join('\n');

const RESUME = readFileSync(join(HERE, 'resume.md'), 'utf8');

/** 复现失败那一轮之前的全部对话（前 5 轮 + 边界回答）。 */
const BEFORE = [
  '开始面试',
  '简历如下：\n' + RESUME,
  '好。我叫陈屿，7 年 Java 后端，现在在甲科技做本地生活平台的交易履约。'
  + '最近两年主要做两件事：一是订单创建链路的性能治理，把午高峰 P99 从 2.4 秒压到 380 毫秒；'
  + '二是订单库分库分表，单表 4.2 亿行拆成 32 库 128 表。',
  '拆 RPC 是我主导的。原来订单创建要串行调 7 个下游，每个平均 120 毫秒，加起来就 800 多毫秒。',
  '缓存一致性我们用 Caffeine 做本地一级，Redis 二级。',
  '多实例本地缓存的一致性……这个问题当时是我们组另一个同事主做的，我了解得没那么细。',
];

async function ask(messages, brief, maxTokens) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, brief, maxTokens }),
  });
  return res.json();
}

async function main() {
  const state = {
    ...emptyState({ budgetMin: 45 }),
    plan: [{ topic: '订单创建链路' }, { topic: '库存预扣一致性' }, { topic: '分库分表' }, { topic: 'JVM' }],
    topic: '分库分表',
    turnsOnTopic: 1,
  };

  const messages = [];
  for (let i = 0; i < BEFORE.length; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: BEFORE[i] });
  }
  // 确保最后一条是 user
  if (messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', text: '我知道最后是用 Redis 的 pub/sub 广播失效，但怎么保证广播不丢，我没深入看。' });
  }

  const brief = BRIEF_HEAD
    + '\n\n---\n\n' + stateProtocolBlock()
    + '\n\n---\n\n' + buildStateBlock(state);

  console.log('提示词里状态协议 + 状态块 共 ' + (stateProtocolBlock().length + buildStateBlock(state).length) + ' 字符\n');

  for (const [label, withBlock] of [['带状态协议', true], ['不带状态协议', false]]) {
    for (const maxTokens of [1600, 3000, 5000]) {
      const b = withBlock ? brief : BRIEF_HEAD;
      const t0 = Date.now();
      const data = await ask(messages, b, maxTokens);
      const head = data.ok
        ? (data.text || '').replace(/\n/g, ' ').slice(0, 70)
        : ('✗ ' + data.error + ' | partial=' + String(data.partial || '').replace(/\n/g, ' ').slice(-90));
      console.log('  ' + (data.ok ? '✓' : '✗') + ' ' + label + ' maxTokens=' + maxTokens
        + '  ' + (Date.now() - t0) + 'ms  ' + (data.ok ? '长度 ' + (data.text || '').length + ' ' : '') + head);
    }
  }

  // 带状态块时，模型到底吐了多少字？直接看一次完整输出
  console.log('\n--- 带状态协议的完整输出（maxTokens=5000）---');
  const full = await ask(messages, brief, 5000);
  console.log(full.ok ? full.text : ('✗ ' + full.error));
}

main().catch((e) => { console.error(e); process.exit(1); });
