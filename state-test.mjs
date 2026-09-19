/**
 * state-test.mjs —— 面试状态机的单元测试
 *
 *   node state-test.mjs
 *
 * state.js 是纯函数、不依赖 DSH，所以这里能真正跑断言，不是静态检查。
 * 要验的核心是四件事：
 *
 *   1. 话题没换 → 计数 +1；话题换了 → 计数归 1
 *   2. 追到上限时，注入的状态块里**必须点名换到下一个话题**（抽象地说"换个话题"没用）
 *   3. **模型不吐标记时，状态机不能卡死** —— 要能自己把计划推下去（"乐观前进"）
 *   4. 模型一直不给计划时，要装兜底骨架，否则广度的推进无处可去
 *
 * 第 2 条是上一场面试失败的直接原因。
 * 第 3、4 条是实测定出来的：模型吐标记的命中率只有 20%~50%，
 * 换措辞、挪位置都救不回来 —— 所以状态机的正确性**不能依赖模型配合**。
 */
'use strict';

import {
  emptyState, splitState, mergeState, buildStateBlock, stateProtocolBlock,
  elapsedMin, nextTopic, planForDomain, domainFromBrief,
  MAX_ASKS_PER_TOPIC, GENERIC_PLAN,
} from './lib/state.js';

const problems = [];
let passed = 0;

function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ %s', label); }
  else {
    problems.push(label + (detail ? '  —— ' + detail : ''));
    console.log('  ✗ %s%s', label, detail ? '  —— ' + detail : '');
  }
}

// ---------------------------------------------------------------- 1. 拆标记

console.log('\n--- 拆状态标记 ---');

const withTopic = splitState('简历先给我。\n<!--topic: 开场-->');
ok('回复和标记被拆开', withTopic.reply === '简历先给我。', JSON.stringify(withTopic.reply));
ok('解析出 topic', withTopic.delta && withTopic.delta.topic === '开场');
ok('标记了 hadState', withTopic.hadState === true);

const noMarker = splitState('简历先给我。');
ok('没有标记时不报错', noMarker.delta === null && noMarker.hadState === false);
ok('没有标记时回复原样保留', noMarker.reply === '简历先给我。');

const empty = splitState('');
ok('空字符串不炸', empty.reply === '' && empty.delta === null);

// plan 行：模型可能一次给两行（topic + plan）
const both = splitState('看到了。\n<!--plan: 订单链路 | 缓存一致性 | 分库分表-->\n<!--topic: 订单链路-->');
ok('同时解析 topic 和 plan', both.delta.topic === '订单链路' && both.delta.plan.length === 3);
ok('正文里两行都摘干净了', both.reply === '看到了。', JSON.stringify(both.reply));

const onlyPlan = splitState('先看看简历。\n<!--plan: A | B | C | D-->');
ok('只有 plan 行也能解析', onlyPlan.delta && onlyPlan.delta.plan.length === 4 && !onlyPlan.delta.topic);

// 模型爱加装饰：反引号、星号、引号
const decorated = splitState('好的\n<!--topic: **分库分表**-->');
ok('话题名洗掉装饰符', decorated.delta.topic === '分库分表', JSON.stringify(decorated.delta.topic));

// 话题名过长要截断 —— 防模型把一整句话塞进来
const tooLong = splitState('好的\n<!--topic: 这是一个非常非常长的话题名字长到离谱超过二十四个字了已经-->');
ok('过长的话题名被截断', tooLong.delta.topic.length <= 24, String(tooLong.delta.topic.length));

// 标记写坏了（没闭合）不能让正文被吃掉
const broken = splitState('说话\n<!--topic: 开场');
ok('标记没闭合时正文保留', broken.reply.includes('说话'), JSON.stringify(broken.reply));

// ---------------------------------------------------------------- 2. 话题计数

console.log('\n--- 话题计数（核心）---');

let s = emptyState({ plan: ['订单链路', '缓存一致性', 'JVM'] });

s = mergeState(s, { topic: '订单链路' });
ok('第一次进入话题 → 计数 1', s.turnsOnTopic === 1 && s.topic === '订单链路');
ok('计划用给定的那份', s.plan.length === 3);

s = mergeState(s, { topic: '订单链路' });
ok('同一话题再问 → 计数 2', s.turnsOnTopic === 2);

s = mergeState(s, { topic: '订单链路' });
ok('第三次 → 计数 3', s.turnsOnTopic === 3);

s = mergeState(s, { topic: '缓存一致性' });
ok('换话题 → 计数归 1', s.turnsOnTopic === 1 && s.topic === '缓存一致性');
ok('旧话题进已完成', s.done.includes('订单链路'));

// 模型没吐标记时不能整轮失败
let s2 = mergeState(emptyState({ plan: ['A', 'B'] }), { topic: 'A' });
s2 = mergeState(s2, null);
ok('缺标记 → 按同话题计数（兜底）', s2.turnsOnTopic === 2 && s2.topic === 'A');

// ---------------------------------------------------------------- 3. 乐观前进（新）

console.log('\n--- 乐观前进：模型不吐标记也不能卡死 ---');
console.log('    （实测标记命中率只有 20%~50%，所以这条是降级路径的主干）');

let sc = emptyState({ plan: ['A', 'B', 'C'] });
sc = mergeState(sc, { topic: 'A' });   // 1
sc = mergeState(sc, null);             // 2
ok('追到上限前不前进', sc.topic === 'A' && sc.turnsOnTopic === 2);

// 这一轮的提示词已经点名"换到 B"。假设模型照做了但没吐标记：
sc = mergeState(sc, null);
ok('★ 无标记到上限 → 自动前进到计划里的下一个', sc.topic === 'B', sc.topic);
ok('★ 前进后计数归 0（新话题从下一轮算第 1 问）', sc.turnsOnTopic === 0, String(sc.turnsOnTopic));
ok('旧话题进已完成', sc.done.includes('A'));

sc = mergeState(sc, null);
ok('新话题开始计数', sc.turnsOnTopic === 1);
sc = mergeState(sc, null);
ok('新话题计到 2', sc.turnsOnTopic === 2);
sc = mergeState(sc, null);
ok('★ 再次到上限 → 继续前进到 C', sc.topic === 'C', sc.topic);

// 计划聊完：没有下一个了
sc = mergeState(sc, null);   // C: 1
sc = mergeState(sc, null);   // C: 2
sc = mergeState(sc, null);   // 超限，但无路可走
ok('计划聊完时不再前进', sc.topic === 'C', sc.topic);
ok('★ 计数停在上限不再增长（否则会一直刷"必须换话题"）',
  sc.turnsOnTopic === MAX_ASKS_PER_TOPIC, String(sc.turnsOnTopic));
ok('C 也进了已完成', sc.done.includes('C'));

// nextTopic 自身
const probe = { plan: [{ topic: 'A' }, { topic: 'B' }, { topic: 'C' }], topic: 'A', done: ['A'] };
ok('nextTopic 跳过当前和已聊', nextTopic(probe) === 'B', String(nextTopic(probe)));
ok('全都聊完时 nextTopic 返回 null',
  nextTopic({ plan: [{ topic: 'A' }], topic: 'A', done: ['A'] }) === null);

// ---------------------------------------------------------------- 4. 计划兜底

console.log('\n--- 计划兜底：模型一直不给计划时 ---');

const named = emptyState({ domain: 'Java 后端' });
ok('Java 后端拿到后端骨架', named.fallbackPlan.includes('JVM 与线上问题'), named.fallbackPlan.join('/'));
ok('大模型方向拿到 AI 骨架', planForDomain('大模型 / Agent').length === 4);
ok('认不出的方向给通用骨架', planForDomain('未知方向').join() === GENERIC_PLAN.join());

let sf = emptyState({ domain: 'Java 后端' });
for (let i = 0; i < 3; i++) sf = mergeState(sf, null);
ok('★ 连续要不到计划 → 装兜底骨架', sf.plan.length === 4, 'plan=' + sf.plan.length);
ok('装骨架后广度机制才有地方可去', nextTopic({ ...sf, topic: '项目与链路', done: [] }) !== null);

// 模型给了计划就别用兜底
let sg = mergeState(emptyState({ domain: 'Java 后端' }), { topic: 'X', plan: ['模型给的1', '模型给的2'] });
ok('模型给了计划就用模型的', sg.plan.map((p) => p.topic).join() === '模型给的1,模型给的2');
let sg2 = mergeState(sg, { topic: 'X', plan: ['后来想改的'] });
ok('计划只认第一次，不被后续覆盖', sg2.plan.map((p) => p.topic).join() === '模型给的1,模型给的2');

// 从 brief 里抠方向
ok('能从 brief 里抠出方向',
  domainFromBrief('本轮设定：\n- 目标方向：Java 后端\n- 目标职级：高级') === 'Java 后端');
ok('brief 里没有方向时返回空串', domainFromBrief('随便什么') === '');

// ---------------------------------------------------------------- 5. 注入块

console.log('\n--- 注入的状态块 ---');

const now = Date.now();
const base = Date.now() - 10 * 60000;   // 已过 10 分钟

let st = {
  ...emptyState({ plan: ['订单链路', '缓存一致性'] }),
  startedAt: base, plan: [{ topic: '订单链路' }, { topic: '缓存一致性' }],
  topic: '订单链路', turnsOnTopic: 1,
};
const block1 = buildStateBlock(st, now);
ok('块里写了已用/预算时间', /已用 10 \/ 45 分钟/.test(block1), block1.split('\n')[1]);
ok('未达上限时不喊换话题', !/必须换/.test(block1));
ok('未达上限时说明这是第几次提问', /本轮是第 2 次提问/.test(block1));

st = { ...st, turnsOnTopic: MAX_ASKS_PER_TOPIC };
const block2 = buildStateBlock(st, now);
ok('★ 追到上限 → 块里要求换话题', /够深了/.test(block2));
ok('★ 而且**点名**换到哪个话题（抽象指令模型不会动）',
  /本轮换到下一个话题：缓存一致性/.test(block2), block2.split('【本轮必须做的事】')[1]);
ok('★ 并说明理由（防止模型忽略硬规则）', /追问能力很强但不知道什么时候停/.test(block2));
ok('给了可操作的换法', /不要生硬地宣布/.test(block2));

// 计划聊完 → 进反问
const allDone = {
  ...emptyState({ plan: ['A'] }),
  startedAt: base, plan: [{ topic: 'A' }], topic: 'A',
  turnsOnTopic: MAX_ASKS_PER_TOPIC, done: ['A'],
};
ok('计划聊完 → 提示进反问环节', /反问环节/.test(buildStateBlock(allDone, now)));

// 边界注入
const stBound = {
  ...st, turnsOnTopic: 1,
  boundaries: ['多实例缓存一致性（坦承是同事主做）'],
};
const block3 = buildStateBlock(stBound, now);
ok('已记边界会注入，且明确说别再问', /不要再回头问这些/.test(block3) && /同事主做/.test(block3));
ok('★ 边界资料排在本轮动作之前（结尾只放动作）',
  block3.indexOf('不要再回头问这些') < block3.indexOf('【本轮必须做的事】'));

// 时间提醒
const nearEnd = {
  ...emptyState({ plan: ['A', 'B'] }),
  startedAt: Date.now() - 42 * 60000, topic: 'A', turnsOnTopic: 1,
};
ok('剩 5 分钟内 → 提醒进入反问', /停止提问，进入反问环节/.test(buildStateBlock(nearEnd, now)));

const half = {
  ...emptyState({ plan: ['A', 'B'] }),
  startedAt: Date.now() - 25 * 60000, topic: 'A', turnsOnTopic: 1, done: [],
};
ok('过半且有计划未聊完 → 提醒控制深度', /已过半/.test(buildStateBlock(half, now)));

const noPlan = { ...emptyState(), startedAt: base, plan: [] };
ok('没有计划时也不炸', buildStateBlock(noPlan, now).length > 0);

// ---------------------------------------------------------------- 6. 协议块

console.log('\n--- 状态标记协议 ---');

const protoNoPlan = stateProtocolBlock(emptyState());
ok('协议块给出 topic 行的样子', /<!--topic:/.test(protoNoPlan));
ok('还没计划时索要 plan 行', /<!--plan:/.test(protoNoPlan));
ok('协议块说明计数不用模型算', /由系统数，不用你算/.test(protoNoPlan));
ok('协议块说明标记不展示给候选人', /候选人看不到/.test(protoNoPlan));

const withPlan = stateProtocolBlock({ ...emptyState(), plan: [{ topic: 'A' }] });
ok('★ 拿到计划后不再索要 plan 行（每轮少一个要求，命中率就高一点）',
  !/<!--plan:/.test(withPlan));
ok('但有计划时仍然要 topic 行', /<!--topic:/.test(withPlan));

// ---------------------------------------------------------------- 7. 其它

console.log('\n--- 其它 ---');

ok('elapsedMin 算得对', elapsedMin({ startedAt: Date.now() - 3 * 60000 }, Date.now()) === 3);
ok('elapsedMin 不会为负', elapsedMin({ startedAt: Date.now() + 60000 }, Date.now()) === 0);

let s4 = mergeState(emptyState({ plan: ['A'] }), { topic: 'A' });
s4 = mergeState(s4, { topic: 'A', boundary: '边界1', note: '观察1' });
s4 = mergeState(s4, { topic: 'A', note: '观察2' });
ok('boundaries 逐条累积', s4.boundaries.length === 1 && s4.boundaries[0] === '边界1');
ok('notes 逐条累积', s4.notes.length === 2);
ok('空字符串的 boundary/note 不入账',
  mergeState(s4, { topic: 'A', boundary: '', note: '   ' }).notes.length === 2);

// mergeState 不能改原对象（面板侧要用旧状态做 diff）
const frozen = emptyState({ plan: ['A', 'B'] });
const before = JSON.stringify(frozen);
mergeState(frozen, { topic: 'A' });
ok('mergeState 不改原状态（纯函数）', JSON.stringify(frozen) === before);

// ---------------------------------------------------------------- 结论

console.log('');
if (problems.length) {
  console.error('✗ 状态机测试未通过：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('✓ 状态机测试通过（%d 项断言）', passed);
