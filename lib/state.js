/**
 * state.js —— 面试状态机（纯函数，不依赖 DSH，所以能单独测）
 *
 * 为什么要有它：原来的实现是**无状态**的 —— 每轮把整份对话丢给模型问"下一句问什么"。
 * 结果它在同一个话题上死磕了 5 轮（SOP 只允许 2 轮），而且因为注意力被占满，
 * 放掉了别处一段教科书级的含糊回答。
 *
 * 根因不是提示词写得不好，是**模型没有工作记忆**：它每轮都要从零推导"该问什么"，
 * 而最近上下文里最显眼的就是"他刚才没回答我"，所以它会一直拉那根线。
 *
 * 真实面试官不这么工作。他脑子里有：面试计划、当前追到第几次、还剩多少时间、
 * 一路记下的观察。这个模块就是把这四样**显式化**。
 *
 * 分工：
 *   模型负责"判断这一轮在聊什么话题"（它擅长这个）
 *   状态机负责"数它追了几次、该不该换、还剩多少时间"（机械计数，不该交给模型）
 *
 * ⚠ 一条重要的设计教训（实测定出来的）：
 *   让模型每轮吐一个标记，**命中率只有 20%~50%**，而且换措辞、挪位置都救不回来。
 *   所以状态机**不能依赖模型配合才能正确**。没有标记时它必须自己把计划推下去
 *   （见 mergeState 的"乐观前进"和 buildStateBlock 的点名换话题）。
 *   追问能力很强但不知道什么时候停，等于没有追问能力；
 *   而一个"模型不配合就卡死"的状态机，等于没有状态机。
 */

/** 每轮末尾的话题标记。用 HTML 注释，候选人看不见。 */
const TOPIC_RE = /<!--\s*topic\s*:\s*([^\n]*?)\s*-->/i;

/** 计划标记。只在还没拿到计划时要，拿到就不再要。 */
const PLAN_RE = /<!--\s*plan\s*:\s*([^\n]*?)\s*-->/i;

/** 把回复里的所有标记摘掉（给候选人看的正文不能带这些）。 */
const ALL_MARKERS_RE = /<!--\s*(?:topic|plan)\s*:[^\n]*?-->/gi;

/** 同一个话题追到几次就必须换。SOP 的规定是 2 次。 */
export const MAX_ASKS_PER_TOPIC = 2;

/**
 * 要几轮计划还没给，就装兜底计划。
 *
 * 为什么要这个上限：广度机制（点名换话题）依赖计划里有"下一个话题"。
 * 模型要是一直不给计划，点名就无处可点，机制空转。
 * 而"最早会用到计划"是在第一个话题追满 2 次时 —— 也就是第 3 轮。
 * 所以这里定 2，保证第 3 轮之前计划一定就位。
 */
export const PLAN_ASK_LIMIT = 2;

/** 话题名上限，防模型把一整句话当话题名塞进来。 */
const TOPIC_MAX_LEN = 24;

/**
 * 按方向给的兜底计划。
 *
 * 只在模型不给计划时用。它不追求"贴合简历"，追求的是**广度骨架存在** ——
 * 这样即使模型完全不配合，面试也不会整场只聊一个话题。
 * 具体问什么仍然由模型根据简历决定，计划只决定"什么时候该挪窝"。
 */
const DOMAIN_PLANS = [
  [/大模型|Agent|LLM|RAG|AI/i, ['项目与架构', '数据与检索', '评测与效果', '工程落地与成本']],
  [/Java|后端|服务端|中间件/i, ['项目与链路', '一致性与缓存', '数据库与扩展', 'JVM 与线上问题']],
  [/算法|推荐|搜索|风控|数据挖掘/i, ['项目与建模', '特征与数据', '模型与调优', '线上效果与迭代']],
  [/HR|人力|招聘/i, ['履历与动机', '团队协作', '冲突与失败', '职业规划']],
  [/前端|客户端|移动/i, ['项目与架构', '性能与体验', '工程化与协作', '线上问题与复盘']],
];

/** 认不出方向时的通用骨架。 */
export const GENERIC_PLAN = ['项目经历', '技术深度', '工程与协作', '复盘与成长'];

/** 按方向取兜底计划。认不出就用通用骨架（宁可泛，也不能没有）。 */
export function planForDomain(domain) {
  const d = typeof domain === 'string' ? domain : '';
  for (const [re, plan] of DOMAIN_PLANS) {
    if (re.test(d)) return plan.slice();
  }
  return GENERIC_PLAN.slice();
}

// ---------------------------------------------------------------- 构造

/**
 * 开一场新的面试。
 *
 * @param {object} [opts]
 * @param {number} [opts.budgetMin]   时间预算（分钟）
 * @param {string} [opts.domain]      目标方向，用来取兜底计划
 * @param {string[]} [opts.plan]      直接给定计划（优先于兜底）
 */
export function emptyState(opts) {
  const o = opts || {};
  const given = Array.isArray(o.plan) ? o.plan.filter((t) => typeof t === 'string' && t.length > 0) : [];
  return {
    startedAt: Date.now(),
    budgetMin: Number.isFinite(o.budgetMin) ? o.budgetMin : 45,
    /** 面试计划：[{ topic }]。模型给就用模型的，否则用兜底。 */
    plan: given.map((topic) => ({ topic })),
    /** 模型一直不给计划时装的骨架。 */
    fallbackPlan: planForDomain(o.domain),
    /** 已经要过几轮计划。 */
    planAsked: 0,
    /** 当前话题。 */
    topic: null,
    /** 当前话题已经问了几轮。 */
    turnsOnTopic: 0,
    /** 聊完的话题。 */
    done: [],
    /** 他明确表示不懂 / 不是他做的地方。 */
    boundaries: [],
    /** 逐条观察，给最后评分用。 */
    notes: [],
  };
}

/** 从面板拼的 brief 里抠出目标方向。 */
export function domainFromBrief(brief) {
  const m = /目标方向[：:]\s*(.+)/.exec(typeof brief === 'string' ? brief : '');
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------- 解析

/** 话题名洗一下：去掉模型爱加的装饰，截断过长的。 */
function cleanTopic(raw) {
  const s = String(raw).replace(/[`*"'“”【】\[\]]/g, '').trim();
  return s.slice(0, TOPIC_MAX_LEN);
}

/**
 * 把模型回复拆成「给候选人看的话」和「状态增量」。
 *
 * 拆不出来不算错 —— 模型不按格式输出是常事（实测命中率只有 20%~50%）。
 * 这时返回 delta = null，由调用方按"还在同一个话题"兜底计数。
 * **不能因为格式没跟上就整轮失败。**
 */
export function splitState(text) {
  const raw = typeof text === 'string' ? text : '';

  const topicM = TOPIC_RE.exec(raw);
  const planM = PLAN_RE.exec(raw);

  const reply = raw.replace(ALL_MARKERS_RE, '').replace(/\n{3,}/g, '\n\n').trim();

  if (topicM === null && planM === null) {
    return { reply, delta: null, hadState: false };
  }

  const delta = {};
  if (topicM !== null) {
    const t = cleanTopic(topicM[1]);
    if (t.length > 0) delta.topic = t;
  }
  if (planM !== null) {
    const plan = planM[1].split('|').map((s) => cleanTopic(s)).filter((s) => s.length > 0);
    if (plan.length > 0) delta.plan = plan;
  }

  return {
    reply,
    delta: Object.keys(delta).length > 0 ? delta : null,
    hadState: true,
  };
}

// ---------------------------------------------------------------- 计划

/**
 * 计划里下一个还没聊的话题。没有就返回 null。
 * "还没聊"= 不在 done 里，且不是当前话题。
 */
export function nextTopic(state) {
  for (const p of state.plan) {
    if (p.topic !== state.topic && !state.done.includes(p.topic)) return p.topic;
  }
  return null;
}

// ---------------------------------------------------------------- 合并

/**
 * 合并状态增量。
 *
 * ⚠ 关键设计一：**turnsOnTopic 由这里数，不由模型报。**
 *   让模型自己数"我追了几次"是不可靠的（它连数没数都未必知道）；
 *   而"这一轮的话题和上一轮是不是同一个"是机械判断，交给状态机才对。
 *
 * ⚠ 关键设计二：**没有标记时不能卡死，要"乐观前进"。**
 *   模型不吐 topic 标记时，计数就一直涨，涨到上限后提示词会点名"换到下一个话题：X"。
 *   下一轮如果还是没标记，这里就**假定它照做了**，把话题指针推到 X。
 *   不这么做的话，模型一旦不配合，状态就永远停在"已达上限"，计划形同虚设。
 *   代价是可能错标一轮（它其实没换），但比起"广度机制彻底失效"，这个代价可以接受。
 */
export function mergeState(state, delta) {
  const next = {
    ...state,
    plan: state.plan.slice(),
    done: state.done.slice(),
    boundaries: state.boundaries.slice(),
    notes: state.notes.slice(),
  };
  next.planAsked = (state.planAsked || 0) + 1;

  const hasDelta = delta !== null && typeof delta === 'object';

  // ---- 计划：先认模型的，一直不给就装兜底骨架 ----
  if (next.plan.length === 0 && hasDelta && Array.isArray(delta.plan) && delta.plan.length > 0) {
    next.plan = delta.plan.map((topic) => ({ topic }));
  }
  if (next.plan.length === 0 && next.planAsked > PLAN_ASK_LIMIT) {
    next.plan = (state.fallbackPlan || GENERIC_PLAN).map((topic) => ({ topic }));
  }

  // ---- 话题 ----
  const modelTopic = hasDelta && typeof delta.topic === 'string' && delta.topic.length > 0
    ? delta.topic
    : null;

  if (modelTopic !== null) {
    if (modelTopic !== state.topic) {
      // 换了话题：旧话题记进已完成，新话题从第 1 轮开始
      if (state.topic !== null && !next.done.includes(state.topic)) next.done.push(state.topic);
      next.topic = modelTopic;
      next.turnsOnTopic = 1;
    } else {
      next.topic = modelTopic;
      next.turnsOnTopic = state.turnsOnTopic + 1;
    }
  } else if (state.topic === null) {
    // 还没进入正式提问，无从计数
    next.turnsOnTopic = 0;
  } else if (state.turnsOnTopic + 1 > MAX_ASKS_PER_TOPIC) {
    // ---- 乐观前进 ----
    // 上一轮的提示词已经明确点名"本轮换到下一个话题：X"，所以按它已经换了处理。
    if (!next.done.includes(state.topic)) next.done.push(state.topic);
    const nxt = nextTopic(next);
    if (nxt !== null) {
      next.topic = nxt;
      // 设 0 而不是 1：这一轮的问题很可能还是上一个话题的，
      // 新话题从**下一轮**算第 1 问。设 1 会让每换一次话题就少问一轮。
      next.turnsOnTopic = 0;
    } else {
      // 计划聊完了。停在上限值，不再增长 —— 否则会一直刷"必须换话题"却没有地方可换。
      next.turnsOnTopic = state.turnsOnTopic;
    }
  } else {
    next.turnsOnTopic = state.turnsOnTopic + 1;
  }

  // ---- 可选的边界 / 观察（模型给不给都行）----
  if (hasDelta && typeof delta.boundary === 'string' && delta.boundary.trim().length > 0) {
    next.boundaries.push(delta.boundary.trim());
  }
  if (hasDelta && typeof delta.note === 'string' && delta.note.trim().length > 0) {
    next.notes.push(delta.note.trim());
  }

  return next;
}

// ---------------------------------------------------------------- 渲染

/** 已用分钟数。 */
export function elapsedMin(state, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.max(0, Math.floor((now - state.startedAt) / 60000));
}

/**
 * 生成注入提示词的状态块。
 *
 * 这是整个设计的核心：**把"我追了几次"和"剩多少时间"变成模型看得见的字面事实**，
 * 而不是指望它自己记住。上一场面试失败就失败在这里。
 *
 * ⚠ 结构上有一条硬要求：**「本轮必须做的事」永远是整段的最后**。
 * 一开始我把边界清单放在末尾，结果 dev-check 一验就发现 —— 模型最后读到的是
 * 「- 多实例一致性（同事主做）」，而真正该照做的「必须换话题」被夹在中间。
 * 模型对结尾的指令最敏感，所以结尾只能放动作，不能放资料。
 *
 * ⚠ 第二件事：到上限时**点名下一个话题**。
 * "换个话题"是抽象指令，模型大概率继续追问；"换到「数据库与扩展」"它才动得起来。
 * 这也是模型不吐标记时，状态机唯一能把计划推下去的手段。
 */
export function buildStateBlock(state, nowMs) {
  const elapsed = elapsedMin(state, nowMs);
  const left = Math.max(0, state.budgetMin - elapsed);
  const capped = state.topic !== null && state.turnsOnTopic >= MAX_ASKS_PER_TOPIC;
  const nxt = nextTopic(state);
  const L = [];

  // ---- 资料部分 ----
  L.push('【面试状态 · 每轮更新 · 你必须据此决定下一句】');
  L.push('已用 ' + elapsed + ' / ' + state.budgetMin + ' 分钟（剩 ' + left + ' 分钟）');

  if (state.plan.length > 0) {
    L.push('');
    L.push('面试计划：');
    state.plan.forEach((p, i) => {
      const isDone = state.done.includes(p.topic);
      const isCur = p.topic === state.topic;
      const mark = isDone ? '✓ 已聊' : (isCur ? '← 当前' : '· 待聊');
      L.push('  ' + (i + 1) + '. ' + p.topic + '   ' + mark);
    });
  }

  L.push('');
  if (state.topic !== null) {
    L.push(capped
      ? '当前话题：' + state.topic + '（已经追问 ' + state.turnsOnTopic + ' 次，够深了）'
      : '当前话题：' + state.topic + '　本轮是第 ' + (state.turnsOnTopic + 1) + ' 次提问');
  } else {
    L.push('当前话题：尚未进入正式提问');
  }

  if (state.boundaries.length > 0) {
    L.push('');
    L.push('已记下的边界（**不要再回头问这些**）：');
    state.boundaries.slice(-5).forEach((b) => L.push('  - ' + b));
  }

  // ---- 动作部分（永远在最后）----
  const must = [];

  if (capped) {
    must.push('**「' + state.topic + '」已经追了 ' + state.turnsOnTopic + ' 次，够深了。**');
    if (nxt !== null) {
      must.push('**本轮换到下一个话题：' + nxt + '。**');
      must.push('换法：从他刚才的回答里挑一个能接上去的点切进去，不要生硬地宣布"我们换个话题"。');
    } else {
      must.push('**计划里的话题都聊过了 —— 本轮开始收尾，问他有没有想问你的（反问环节）。**');
    }
    must.push('这不是建议。继续追会挤掉其它话题的考察时间，而那正是上一场面试失败的原因：');
    must.push('面试官在一个话题上追了 5 轮，结果把别处一段明显的含糊回答整个放过去了。');
    must.push('**追问能力很强但不知道什么时候停，等于没有追问能力。**');
  }

  if (left <= 5) {
    must.push('**只剩 ' + left + ' 分钟 —— 停止提问，进入反问环节（「你有什么想问我的？」）。**');
  } else if (left <= state.budgetMin * 0.2) {
    must.push('时间不多。把剩余话题压到最浅一层，确保每个都碰到 —— 别再深挖当前话题。');
  } else if (elapsed >= state.budgetMin * 0.5
    && state.plan.some((p) => !state.done.includes(p.topic))) {
    must.push('已过半。控制当前话题的深度，确保计划里每个话题都碰到。');
  }

  if (must.length === 0) {
    must.push('继续当前话题可以，但记住上限是 ' + MAX_ASKS_PER_TOPIC + ' 次。');
  }

  L.push('');
  L.push('【本轮必须做的事】');
  must.forEach((m) => L.push(m));

  return L.join('\n');
}

/**
 * 状态标记的输出格式说明。挂在系统提示词末尾。
 *
 * 只用**一行纯文本标记**，不用 JSON —— 实测下来让模型每轮产一段 JSON
 * （还要 plan 数组、还要保证 topic 字符串逐字一致）会明显更容易漏。
 * 字段越少，越可能被照做。
 *
 * plan 只在还没有计划时要。一旦拿到就不再提 —— 每轮多一个要求，
 * 命中率就掉一截，而计划是"给一次就够"的东西。
 */
export function stateProtocolBlock(state) {
  const needPlan = !state || !Array.isArray(state.plan) || state.plan.length === 0;

  const L = [
    '',
    '---',
    '',
    '【每轮最后加一行标记】',
    '在你回复的最后，另起一行，原样输出这一行（把话题名换掉）：',
    '',
    '<!--topic: 分库分表-->',
    '',
    '- 还是上一轮那件事 → 填**和上一轮完全一样**的字；换新话题了 → 填新名字。',
    '- 4 到 8 个字，不要标点，不要解释，不要用自然语言描述它。',
    '- 这一行候选人看不到，但每次都要有。',
    '- "追了几次""还剩多少时间"由系统数，不用你算。',
  ];

  if (needPlan) {
    L.push('');
    L.push('**另外**，如果你已经看到候选人的简历了：在上面那行之前再加一行面试计划，');
    L.push('4 项左右，用 ` | ` 分隔，例如：');
    L.push('');
    L.push('<!--plan: 订单链路 | 缓存一致性 | 分库分表 | JVM-->');
    L.push('');
    L.push('只给这一次，以后不要再输出 plan 行。还没看到简历就不用给。');
  }

  return L.join('\n');
}
