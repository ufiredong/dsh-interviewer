/**
 * run.mjs —— 跑一场完整的模拟面试
 *
 *   node run.mjs
 *
 * 面试官走真实模型（面板那条 /interviewer/api/chat 路由），候选人由脚本扮演。
 *
 * ⚠ 候选人答案**刻意做好了坏的分布**：
 *   - 有带具体数字和取舍理由的强回答
 *   - 有一知半解的中等回答（该被追问）
 *   - 有明确的「不知道」（该暴露边界）
 *   - 有含糊其辞的（该被抓）
 *
 * 全是好答案的话，评出来的分没有信息量 —— 那不是在测面试官，是在演戏。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:3080/interviewer/api/chat';

const BRIEF = [
  '本轮设定：',
  '- 目标方向：Java 后端',
  '- 目标职级：高级',
  '- 面试轮次：技术一面',
  '- 面试官风格：务实工程',
  '',
  '风格决定问法和压力，不改变铁律。',
].join('\n');

const RESUME = readFileSync(join(HERE, 'resume.md'), 'utf8');

/** 候选人台词。每一条左边的注释是我自己的设计意图，不会发出去。 */
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

async function ask(messages) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, brief: BRIEF, maxTokens: 1600 }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data.text;
}

async function main() {
  const messages = [];
  const log = [];
  let failures = 0;

  for (const [label, text] of CANDIDATE) {
    messages.push({ role: 'user', text });
    let reply;
    try {
      reply = await ask(messages);
    } catch (e) {
      messages.pop();
      failures++;
      console.log('  ✗ ' + label + ' 轮失败：' + e.message);
      log.push({ label, question: null, answer: text });
      continue;
    }
    messages.push({ role: 'assistant', text: reply });
    log.push({ label, question: reply, answer: text });
    console.log('  ✓ ' + label + ' → 面试官问：' + reply.replace(/\n/g, ' ').slice(0, 60));
  }

  // ---------------------------------------------------------------- 存档

  const out = [];
  out.push('# 模拟面试实录 · Java 后端 · 高级 · 实务工程型');
  out.push('');
  out.push('> 面试官：真实模型，走 `dsh-interviewer` 插件的 `/interviewer/api/chat` 路由。');
  out.push('> 候选人：脚本扮演（答案刻意有好有坏）。');
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
    if (r.question) {
      out.push(r.question);
    } else {
      out.push('（这一轮请求失败）');
    }
    out.push('');
    out.push('---');
    out.push('');
  }

  writeFileSync(join(HERE, 'transcript.md'), out.join('\n'), 'utf8');
  console.log('\n实录已写入 transcript.md（' + log.length + ' 轮，失败 ' + failures + ' 轮）');
}

main().catch((e) => {
  console.error('失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
