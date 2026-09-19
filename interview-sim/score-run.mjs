/**
 * score-run.mjs —— 对刚才那场模拟面试评分
 *
 * 直接 import 技能里的 score.mjs，绕开命令行 JSON 转义那堆麻烦。
 * 分数是我作为面试官打的，**每个维度都必须挂候选人的原话** ——
 * 没有原话支撑的分数不算数（见 references/04-scoring.md）。
 */
import { compute, validate, render } from 'file:///C:/Users/ufire/.dsh/skills/interviewer/scripts/score.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 我打的五个维度分。不用整数 —— 这项强那项弱，整数抹掉了差别。 */
const SCORES = {
  depth: 3.5,
  design: 3.0,
  rigor: 3.5,
  comm: 4.0,
  boundary: 3.5,
};

/** 每个维度的证据：直接引候选人原话。 */
const EVIDENCE = {
  depth: '「7 个下游平均 120 毫秒，我先做了依赖分析，发现 4 个可以并行、3 个能挪到异步」——取舍理由清楚。'
    + '但被问到 JVM 时只说「调过堆大小和一些参数，后来就好了」。',
  design: '「库存扣减改为 Redis Lua 原子预扣 + 异步落库」说得出。'
    + '但被追问「异步落库失败这笔扣减怎么办」时没答上来；Redis 全挂也说「没仔细想过，没做降级方案」。',
  rigor: '自己复盘说「原计划两周拖了一个半月」「一开始只校验主键，没校验业务字段」'
    + '「把数据一致当成了可以抽查的东西」——栽过跟头并且想明白了。',
  comm: '自我介绍与项目讲述都是结构化的：问题 → 分析 → 做法 → 结果。复盘那段有完整叙事和结论。',
  boundary: '「这个问题当时是我们组另一个同事主做的，我了解得没那么细」——边界标得很准。'
    + '但 JVM 那里用「调过一些参数后来就好了」盖过去了，没有同样标注边界。',
};

const CITY = '新一线';

validate(SCORES);
const result = compute(SCORES, CITY);
const table = render(result, EVIDENCE);

console.log(table);

// 顺手把结论落一份，给报告用
writeFileSync(join(HERE, 'score-output.md'), table, 'utf8');
console.log('\n（已写入 score-output.md）');
