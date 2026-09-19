/**
 * state-run.mjs —— 状态机版模拟面试：行为回归测试
 *
 *   node state-run.mjs
 *
 * 为什么必须有这个测试：
 *   state-test.mjs / dev-check.mjs 验的是**结构**（函数写对了、接线接上了）。
 *   但这一轮改动的真正命题是行为：**面试官会不会还在同一个话题上追 5 轮？**
 *   结构全对而行为错是完全可能的 —— 上一次就是这样：SOP 明明写着"最多追 2 次"，
 *   它照样追了 5 轮。所以这里必须真跑一场。
 *
 *   （原型对照：同目录 transcript.md 是无状态版的实录，那里「多出来的 1.5 秒」
 *     在 4 个轮次里被反复重问 —— 那就是要修掉的病。）
 *
 * 怎么跑：
 *   走面板那条真实路由 /interviewer/api/chat，候选人是脚本扮演的，面试官是真实模型。
 *   状态机用**和面板侧同一份** lib/state.js。
 *
 * ⚠ 当前 DSH 进程里跑的还是改动前的 lib/index.js（Node 把模块缓存住了）。
 *   所以不指望主机侧帮我们管状态 —— 改成把协议和状态块**塞进 brief**，
 *   让主机侧原样拼到提示词后面，我们自己在外部跑 splitState / mergeState。
 *   重启之后主机侧会原生做这件事，这个脚本仍然有效（brief 里那两段变成冗余但无害）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  emptyState, splitState, mergeState, buildStateBlock, stateProtocolBlock,
  nextTopic, MAX_ASKS_PER_TOPIC,
} from '../lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:3080/interviewer/api/chat';

const BRIEF_HEAD = [
  '本轮设定：',
  '- 目标方向：Java 后端',
  '- 目标职级：高级',
  '- 面试轮次：技术一面',
  '- 面试官风格：务实工程',
  '',
  '风格决定问法和压力，不改变铁律。',
].join('\n');

const RESUME = readFileSync(join(HERE, 'resume.md'), 'utf8');

/** 和 run.mjs 用同一套台词 —— 只有候选人一样，两场才有可比性。 */
const CANDIDATE = [
  ['开场', '开始面试'],
  ['给简历', '简历如下：\n' + RESUME],
  ['自我介绍（结构化）',
    '好。我叫陈屿，7 年 Java 后端，现在在甲科技做本地生活平台的交易履约。'
    + '最近两年主要做两件事：一是订单创建链路的性能治理，把午高峰 P99 从 2.4 秒压到 380 毫秒；'
    + '二是订单库分库分表，单表 4.2 亿行拆成 32 库 128 表。'
    + '之前在一家企业服务公司做多租户工单系统，也做过一次 Kafka 消息积压治理。'],
  ['强回答：具体数字 + 取舍',
    '拆 RPC 是我主导的。原来订单创建要串行调 7 个下游：风控、库存、优惠、会员、地址、'
    + '支付预下单、日志，每个平均 120 毫秒，加起来就 800 多毫秒。'
    + '我先做了依赖分析，发现 4 个可以并行、3 个能挪到异步。风控和库存必须同步，'
    + '其余全部异步化，接口里只留 2 次同步 RPC。'],
  ['中等回答：一致性说得含糊',
    '缓存一致性我们用 Caffeine 做本地一级，Redis 二级。'
    + '更新的时候先删 Redis 再删本地，本地设 5 秒过期兜底。'],
  ['边界：坦承参与不深',
    '多实例本地缓存的一致性……这个问题当时是我们组另一个同事主做的，我了解得没那么细。'
    + '我知道最后是用 Redis 的 pub/sub 广播失效，但怎么保证广播不丢、重启期间怎么办，我没深入看。'],
  ['不知道：明确说没想过',
    '如果 Redis 整个挂了……说实话我没仔细想过这个场景。'
    + '我们当时只做了主从和哨兵，没做降级方案。'],
  ['强回答：复盘有洞察',
    '最大的坑是分库分表那次数据迁移，原计划两周，拖了一个半月。'
    + '问题出在我们一开始只校验主键，没校验业务字段。切流到 10% 才发现一批订单金额对不上，'
    + '原因是迁移脚本里 decimal 转换丢了一点精度。后来补了全字段比对，又加了灰度回滚才敢继续。'
    + '现在回头看，那次的问题不是技术难，是我们把"数据一致"当成了可以抽查的东西。'],
  ['弱回答：JVM 含糊',
    'JVM 这块处理过 Full GC 频繁的问题，当时加了 GC 日志分析，调过堆大小和一些参数，后来就好了。'],
  ['更弱：记不清细节',
    '具体哪个参数……我记得调过 -Xmx 和新生代比例，还有那个……CMS 还是 G1 我记不太清了，'
    + '是运维同事帮忙一起看的。'],
  ['主动结束', '面试到此结束，我想听听你的评价。'],
];

/** 每轮发给主机侧的 brief：设定 + 状态协议 + 状态块。 */
function briefFor(state) {
  return BRIEF_HEAD
    + '\n\n---\n\n' + stateProtocolBlock(state)
    + '\n\n---\n\n' + buildStateBlock(state);
}

async function ask(messages, brief) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, brief, maxTokens: 2000 }),
  });
  return res.json();
}

async function main() {
  const messages = [];
  const log = [];
  let state = emptyState({ budgetMin: 45, domain: 'Java 后端' });
  let failures = 0;
  let withMarker = 0;
  let asked = 0;

  console.log('面试状态机 · 行为回归');
  console.log('同一话题上限 = ' + MAX_ASKS_PER_TOPIC + ' 次');
  console.log('兜底计划骨架 = ' + state.fallbackPlan.join(' / ') + '\n');

  for (const [label, text] of CANDIDATE) {
    messages.push({ role: 'user', text });
    asked++;

    let data;
    try {
      data = await ask(messages, briefFor(state));
    } catch (e) {
      data = { ok: false, error: String(e.message || e) };
    }

    if (!data.ok) {
      messages.pop();
      failures++;
      console.log('  ✗ ' + label + ' 请求失败：' + data.error);
      log.push({ label, answer: text, question: null, topic: state.topic, asks: state.turnsOnTopic, marker: false });
      continue;
    }

    // 和主机侧同一套解析：摘出标记，合进状态
    const { reply, delta, hadState } = splitState(data.text);
    if (hadState) withMarker++;
    const before = state.topic;
    state = mergeState(state, delta);

    messages.push({ role: 'assistant', text: reply });

    const capped = state.turnsOnTopic >= MAX_ASKS_PER_TOPIC;
    console.log('  ' + (hadState ? '✓' : '·') + ' ' + label.padEnd(22)
      + ' → 「' + (state.topic || '未进入') + '」第 ' + state.turnsOnTopic + ' 问'
      + (before !== state.topic ? '  ← 换话题' : '')
      + (capped ? '  ⚠到上限' : ''));

    log.push({
      label, answer: text, question: reply,
      topic: state.topic, asks: state.turnsOnTopic, marker: hadState,
    });
  }

  // ---------------------------------------------------------------- 判定

  const topics = [...new Set(log.map((r) => r.topic).filter(Boolean))];
  const overLimit = log.filter((r) => r.asks > MAX_ASKS_PER_TOPIC);
  const plan = state.plan.map((p) => p.topic);
  // 只数计划内的完成项 —— 模型会顺手聊计划外的话题（"开场准备"），
  // 直接看 done.length 会算出「5 / 4」这种读不通的数。
  const planDone = plan.filter((t) => state.done.includes(t)).length;
  const hitRate = Math.round((withMarker / Math.max(1, asked)) * 100);

  console.log('\n--- 判定 ---');
  console.log('  ' + (failures === 0 ? '✓' : '✗') + ' 无失败轮次：' + failures);
  console.log('  · 标记命中率：' + withMarker + ' / ' + asked + '（' + hitRate + '%）'
    + '（没命中时靠状态机乐观前进兜底）');
  console.log('  ' + (overLimit.length === 0 ? '✓' : '✗')
    + ' 没有话题超过 ' + MAX_ASKS_PER_TOPIC + ' 问（超限 ' + overLimit.length + ' 轮）');
  console.log('  · 走过的不同话题 ' + topics.length + ' 个：' + topics.join(' / '));
  console.log('  · 面试计划 ' + plan.length + ' 项：' + plan.join(' / '));
  console.log('  · 计划推进 ' + planDone + ' / ' + plan.length
    + (nextTopic(state) ? '，下一个：' + nextTopic(state) : ''));
  console.log('  · 记下的边界 ' + state.boundaries.length + ' 条，观察 ' + state.notes.length + ' 条');

  // ---------------------------------------------------------------- 存档

  const out = [];
  out.push('# 状态机版模拟面试实录 · Java 后端 · 高级');
  out.push('');
  out.push('> 面试官：真实模型，走 `dsh-interviewer` 的 `/interviewer/api/chat`。');
  out.push('> 候选人：脚本扮演（与无状态版 `transcript.md` 同一套台词）。');
  out.push('> 状态机：`../lib/state.js`（和面板侧同一份代码）。');
  out.push('');
  out.push('| 轮次 | 面试官问到的话题 | 该话题第几问 | 模型吐了标记 |');
  out.push('| --- | --- | --- | --- |');
  for (const r of log) {
    out.push('| ' + r.label + ' | ' + (r.topic || '—') + ' | '
      + (r.asks === null ? '—' : r.asks) + ' | ' + (r.marker ? '是' : '否') + ' |');
  }
  out.push('');
  out.push('**统计**：失败 ' + failures + ' 轮 · 标记命中 ' + withMarker + '/' + asked
    + '（' + hitRate + '%）· 超限 ' + overLimit.length + ' 轮 · 走过话题 ' + topics.length + ' 个');
  out.push('');
  out.push('---');
  out.push('');
  for (const r of log) {
    out.push('### 候选人：' + r.label);
    out.push('');
    out.push('**回答**');
    out.push('');
    out.push('> ' + r.answer.split('\n').join('\n> '));
    out.push('');
    out.push('**面试官**');
    out.push('');
    out.push(r.question || '（这一轮请求失败）');
    out.push('');
    out.push('---');
    out.push('');
  }

  writeFileSync(join(HERE, 'transcript-state.md'), out.join('\n'), 'utf8');
  console.log('\n实录已写入 transcript-state.md');

  if (overLimit.length > 0 || failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
