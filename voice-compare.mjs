/**
 * voice-compare.mjs —— 四种面试官风格对比
 *
 *   node voice-compare.mjs
 *
 * 目的：验证「风格」是真的改变了问法，还是只是四个换汤不换药的名字。
 *
 * 做法：**同样的候选回答，四种风格各跑一遍**，然后横向比。
 * 剧本三轮：
 *
 *   1. 开始面试      → 面试官该问要素（简历）
 *   2. 给简历        → 面试官该问第一个真问题
 *   3. 含糊回答      → 面试官该追问。**这一轮最见功力**，也是风格差异最大的地方
 *
 * 风格标记只是观察，不当通过/失败判定 —— 自然语言没法机械化断言，
 * 硬判会得出假结论。真正要看的，是同一条候选回答下四种问法是否**确实不同**。
 */
'use strict';

const ENDPOINT = 'http://127.0.0.1:3080/interviewer/api/chat';

const STYLES = ['温和引导', '务实工程', '冷峻压测', '学术严谨'];

/** 三种风格各自最该出现的措辞特征。**只留作参考，不再用作指标** —— 见文件末尾的说明。 */
const MARKERS = {
  '温和引导': /不急|按你的思路|我大概明白|先说说|继续|展开/,
  '务实工程': /线上|压测|挂了|还在跑|扛得住|真实|实际/,
  '冷峻压测': /^数字|^继续|我问的是|哪来|谁做的|具体/,
  '学术严谨': /定义|前提|假设|边界|哪种|先确认|成立/,
};

const RESUME = `张明，高级 Java 后端，2018 年本科毕业。
2021.06 至今 A 公司（电商中台）高级后端工程师，负责交易域核心链路，带 3 人小组。
项目一：订单中心高并发改造。大促期间订单创建接口 P99 从 800ms 飙到 3s。
我负责订单创建接口重构 + 缓存层设计。做法是热点数据加本地缓存（Caffeine）做一级，
Redis 做二级；订单表按用户 ID 分 64 库。结果 P99 降到 200ms 以内，峰值 1.2 万 QPS。
技能：Java / Spring Boot / MySQL / Redis / Kafka / RocketMQ。`;

/** 三轮剧本。第三轮刻意埋了「大概」「挺明显」这类含糊词，必须触发追问。 */
const SCRIPT = [
  { label: '① 开场', text: '开始面试' },
  { label: '② 给简历', text: '简历如下：\n' + RESUME },
  { label: '③ 含糊回答', text: '主要是做了缓存优化，用了 Redis，性能提升挺明显的，大概快了不少吧。' },
];

const FORBIDDEN = [
  { re: /这个回答(很)?(好|不错)|答得(很好|不错)|说得很好/, why: '评价' },
  { re: /没关系|不要紧|你已经很棒|别紧张|放松/, why: '安慰' },
  { re: /你是不是想说|你的意思是不是|你是想表达/, why: '替候选人组织语言' },
  { re: /正确答案是|应该是这样|我来解释一下|简单来说就是/, why: '讲解' },
];

function countQuestions(t) {
  return (t.match(/[？?]/g) || []).length;
}

function violations(t) {
  return FORBIDDEN.filter((f) => f.re.test(t)).map((f) => f.why);
}

async function ask(messages, voice) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      brief: [
        '本轮设定：',
        '- 目标方向：Java 后端',
        '- 目标职级：高级',
        '- 面试轮次：技术一面',
        '- 面试官风格：' + voice,
        '',
        '风格决定问法和压力，不改变铁律。四种风格的定义与范例见 SOP 里的 voices 一节。',
      ].join('\n'),
      // 1600 不是随便写的：推理 token 也计入 maxTokens，给小了模型会一个字的答案都吐不出来
      maxTokens: 1600,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data.text;
}

/** 跑完一个风格的完整剧本。 */
async function runStyle(voice) {
  const messages = [];
  const turns = [];
  const failures = [];

  for (const step of SCRIPT) {
    messages.push({ role: 'user', text: step.text });
    let reply;
    try {
      reply = await ask(messages, voice);
    } catch (e) {
      messages.pop();
      failures.push(step.label + '：' + e.message);
      turns.push({ label: step.label, reply: null });
      continue;
    }
    messages.push({ role: 'assistant', text: reply });
    turns.push({ label: step.label, reply });
  }

  return { voice, turns, failures };
}

async function main() {
  const results = [];

  for (const voice of STYLES) {
    process.stdout.write('跑「' + voice + '」… ');
    let r;
    try {
      r = await runStyle(voice);
    } catch (e) {
      console.log('失败：' + e.message);
      results.push({ voice, turns: [], failures: [e.message] });
      continue;
    }
    const probing = r.turns.find((t) => t.label.includes('含糊'));
    console.log(probing && probing.reply ? '完成（追问 ' + countQuestions(probing.reply) + ' 问）' : '完成（有失败轮）');
    results.push(r);
  }

  // ---------------------------------------------------------------- 逐风格展开

  for (const r of results) {
    console.log('\n' + '═'.repeat(74));
    console.log('风格：' + r.voice);
    console.log('═'.repeat(74));

    for (const t of r.turns) {
      console.log('\n【' + t.label + '】');
      if (!t.reply) { console.log('  ✗ 这一轮失败'); continue; }
      console.log(t.reply.split('\n').map((l) => '  ' + l).join('\n'));
      const qs = countQuestions(t.reply);
      const vs = violations(t.reply);
      const note = [];
      if (qs > 1) note.push('⚠ 问号 ' + qs + ' 个（超过一问）');
      if (vs.length) note.push('⚠ 违规：' + vs.join('、'));
      if (note.length) console.log('  ' + note.join('  '));
    }

    if (r.failures.length) {
      console.log('\n  失败轮：' + r.failures.join('；'));
    }
  }

  // ---------------------------------------------------------------- 横向对比

  console.log('\n' + '═'.repeat(74));
  console.log('横向对比');
  console.log('═'.repeat(74));

  console.log('\n【第 3 轮 · 面对同一句含糊回答，四种风格各自怎么追】\n');
  for (const r of results) {
    const p = r.turns.find((t) => t.label.includes('含糊'));
    console.log('── ' + r.voice + ' ' + '─'.repeat(Math.max(2, 60 - r.voice.length)));
    if (!p || !p.reply) { console.log('  （该轮失败）\n'); continue; }
    console.log(p.reply.split('\n').map((l) => '  ' + l).join('\n'));
    console.log('');
  }

  // ---------------------------------------------------------------- 指标

  console.log('═'.repeat(74));
  console.log('指标');
  console.log('═'.repeat(74));
  console.log('');
  // 刻意不列"风格标记命中"那一列。
  //
  // 试过，但它是**假信号**：我按自己的想象给每种风格写了几个关键词（务实工程 →
  // 命中「线上/压测/挂了」），结果它答「订单创建是个写链路」——同样很务实，
  // 但一个关键词都没命中，表上显示"—"，看起来像失败。**实际是标记写得太窄。**
  //
  // 真正有意义的指标是**互不相同**：同一条候选回答下，四种风格如果给出四个
  // 不一样的追问，说明风格确实进了模型的行为。关键词命中只会误导。
  console.log('  风格      追问轮字数  问号数  违规');
  let allDistinct = true;
  const probes = [];

  for (const r of results) {
    const p = r.turns.find((t) => t.label.includes('含糊'));
    const text = p && p.reply ? p.reply : '';
    probes.push(text);
    const vs = violations(text);
    console.log('  %s %s %s %s',
      r.voice.padEnd(8),
      String(text.length).padStart(8),
      String(countQuestions(text)).padStart(6),
      (vs.length ? vs.join('、') : '无').padStart(6));
  }

  // 四条追问如果两两完全相同，说明风格没起作用
  const uniq = new Set(probes.filter(Boolean));
  if (uniq.size < probes.filter(Boolean).length) {
    allDistinct = false;
  }

  console.log('');
  console.log('  %s 四种风格的追问互不相同（风格真的改变了问法）',
    allDistinct ? '✓' : '✗');
  if (!allDistinct) {
    console.log('     → 有风格产出了完全相同的回答，说明风格没进入模型的实际行为');
  }

  const totalViolations = results.reduce(
    (n, r) => n + r.turns.reduce((m, t) => m + (t.reply ? violations(t.reply).length : 0), 0),
    0
  );
  console.log('  %s 铁律违规合计 %d 处', totalViolations === 0 ? '✓' : '⚠', totalViolations);
}

main().catch((e) => {
  console.error('测试失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
