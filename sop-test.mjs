/**
 * sop-test.mjs —— 面试官行为测试（打真实链路）
 *
 *   node sop-test.mjs
 *
 * 测什么：把 SKILL.md 当系统提示词送进模型，喂给它几轮**故意设计过的候选回答**，
 * 看它是不是按 SOP 的铁律行事。断言不了自然语言，所以这里只做两件事：
 *
 *   1. 打印完整对话，人来看
 *   2. 用几条能机械化判定的规则打分（一次只问一问 / 不讲课 / 不安慰 / 不评价）
 *
 * 为什么要有它：这套 SOP 的行为只能真跑才知道。评分脚本有回归测试，
 * 但"面试官够不够狠、会不会漏掉含糊回答"——那部分没有别的验证手段。
 */
'use strict';

const ENDPOINT = 'http://127.0.0.1:3080/interviewer/api/chat';
const BRIEF = [
  '本轮设定：',
  '- 目标方向：Java 后端',
  '- 目标职级：高级',
  '- 面试轮次：技术一面',
].join('\n');

const RESUME = `张明，高级 Java 后端，2018 年本科毕业。
2021.06 至今 A 公司（电商中台）高级后端工程师，负责交易域核心链路，带 3 人小组。
项目一：订单中心高并发改造。大促期间订单创建接口 P99 从 800ms 飙到 3s。
我负责订单创建接口重构 + 缓存层设计。做法是热点数据加本地缓存（Caffeine）做一级，
Redis 做二级；订单表按用户 ID 分 64 库。结果 P99 降到 200ms 以内，峰值 1.2 万 QPS。
项目二：分布式事务方案统一。改用 RocketMQ 事务消息 + 本地消息表兜底，
对账异常从日均 30+ 笔降到 2 笔以内。
技能：Java / Spring Boot / MySQL / Redis / Kafka / RocketMQ / Elasticsearch。`;

/**
 * 每一轮候选人的回答都刻意埋了东西：
 *   - 含糊词（「大概」「差不多」）→ 应该触发追问
 *   - 「不知道」→ 应该给一次换角度的机会
 *   - 说「我们」→ 应该追问"你"做了什么
 */
const TURNS = [
  { label: '开场', text: '开始面试' },
  { label: '给简历', text: '简历如下：\n' + RESUME },
  { label: '含糊回答（测追问）', text: '主要是做了缓存优化，用了 Redis，性能提升挺明显的，大概快了不少吧。' },
  { label: '不知长度（测边界）', text: 'QPS 具体多少我不太记得了，反正大促扛住了。' },
  { label: '「不知道」（测换角度）', text: '这个我不太清楚。' },
];

// ---------------------------------------------------------------- 机械化规则

/** 一次只问一个问题：一问一答，句子里不该出现多个问号。 */
function countQuestions(text) {
  return (text.match(/[？?]/g) || []).length;
}

const FORBIDDEN = [
  { re: /这个回答(很)?(好|不错)|答得(很好|不错)|说得很好/, why: '铁律 7：不评价' },
  { re: /没关系|不要紧|你已经很棒|别紧张|放松/, why: '铁律 7：不安慰' },
  { re: /你是不是想说|你的意思是不是|你是想表达/, why: '铁律 5：不替候选人组织语言' },
  { re: /正确答案是|应该是这样|我来解释一下|简单来说就是|你可以这样理解/, why: '铁律 2：不讲解' },
  { re: /^好的[，,]|^嗯[，,]|^明白[，,]/, why: '铁律 7：不铺垫（叠词开头）' },
];

function checkTurn(text) {
  const issues = [];
  for (const f of FORBIDDEN) {
    if (f.re.test(text)) issues.push(f.why + ' → 命中 /' + f.re.source + '/');
  }
  return issues;
}

// ---------------------------------------------------------------- 跑

async function ask(messages) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // 1600 不是随便写的：推理 token 也计入 maxTokens，给小了模型一个字的答案都吐不出来
    body: JSON.stringify({ messages, brief: BRIEF, maxTokens: 1600 }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data.text;
}

async function main() {
  const messages = [];
  const report = [];
  const failures = [];

  for (const turn of TURNS) {
    messages.push({ role: 'user', text: turn.text });

    let reply;
    try {
      reply = await ask(messages);
    } catch (e) {
      // 一轮失败不该让整个测试退出 —— 否则第一个问题就看不到后面几轮的表现了
      messages.pop();
      failures.push(turn.label + '：' + e.message);
      console.log('\n' + '─'.repeat(72));
      console.log('候选人【' + turn.label + '】');
      console.log('  ✗ 这一轮失败：' + e.message);
      continue;
    }
    messages.push({ role: 'assistant', text: reply });

    const qs = countQuestions(reply);
    const issues = checkTurn(reply);
    report.push({ label: turn.label, reply, qs, issues });

    console.log('\n' + '─'.repeat(72));
    console.log('候选人【' + turn.label + '】');
    console.log(turn.text.length > 200 ? turn.text.slice(0, 200) + ' …' : turn.text);
    console.log('\n面试官：');
    console.log(reply);
    console.log('\n  问号数 ' + qs + (qs > 1 ? '   ⚠ 超过一问' : '') +
      (issues.length ? '\n  ⚠ ' + issues.join('\n  ⚠ ') : '   ✓ 无违规命中'));
  }

  // ---------------------------------------------------------------- 汇总

  console.log('\n' + '═'.repeat(72));
  console.log('汇总');
  console.log('');

  let violations = 0;
  for (const r of report) {
    violations += r.issues.length;
    const flags = [];
    if (r.qs > 1) flags.push('多问');
    if (r.issues.length) flags.push('违规×' + r.issues.length);
    console.log('  %s  %s', r.label.padEnd(22), flags.length ? flags.join(' ') : 'ok');
  }
  for (const f of failures) console.log('  %s  ✗ 请求失败', f.split('：')[0].padEnd(22));

  console.log('');
  console.log('  违规命中合计：%d', violations);
  console.log('  多问轮次：%d', report.filter((r) => r.qs > 1).length);
  console.log('  请求失败：%d', failures.length);

  // 关键行为：含糊必须触发追问、「不知道」必须给一次换角度的机会
  const byLabel = (s) => report.find((r) => r.label.includes(s));
  const vague = byLabel('含糊');
  const dunno = byLabel('不知道');

  const vagueProbed = !!vague && /多少|具体|几|量级|从多少|怎么测|什么指标/.test(vague.reply);
  const dunnoReasked = !!dunno && countQuestions(dunno.reply) >= 1;

  console.log('');
  console.log('  %s 含糊回答触发了要数字的追问', vague ? (vagueProbed ? '✓' : '✗') : '—（该轮没跑成）');
  console.log('  %s 「不知道」后给了换角度的机会', dunno ? (dunnoReasked ? '✓' : '✗') : '—（该轮没跑成）');

  console.log('');
  if (failures.length === 0 && violations === 0 && vagueProbed && dunnoReasked) {
    console.log('  ✓ SOP 行为测试通过');
  } else {
    console.log('  ⚠ 有需要注意的地方，见上面逐轮标注');
  }
}

main().catch((e) => {
  console.error('测试失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
