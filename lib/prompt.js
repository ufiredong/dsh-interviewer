/**
 * prompt.js —— 系统提示词装配（纯 Node，不碰 DSH）
 *
 * 为什么把它从 index.js 拆出来：原来这段逻辑和路由、模型调用缠在一起，
 * 想验一下"拼出来的提示词到底长什么样"就得先把 DSH 起起来。
 * 拆开之后它只依赖 node:fs / node:path 和 state.js —— 离线就能跑，
 * 也能让 live-test.mjs 用**同一份代码**拼提示词，而不是抄一遍（抄一遍必然漂移）。
 *
 * 结构（顺序是有讲究的）：
 *
 *   ENV_PREAMBLE      环境声明。必须最前 —— 先立规矩。
 *   SOP 正文          SKILL.md + 被它引用的 references/*.md，全部内联。
 *   自查清单          收尾的硬约束。模型对**结尾**的指令更敏感。
 *   状态块格式说明     告诉模型怎么吐 <!--state ...-->。
 *   --- 本轮设定       面板传来的方向/职级/轮次/风格。
 *   --- 面试状态       状态机算出来的"追了几次、还剩多少时间"。
 *
 * 后面三段是每轮都在变的，所以单独拼，不塞进 buildSystemPrompt 里（那样会被缓存住）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { interviewerSkillDir } from './skill.js';
import { buildStateBlock, stateProtocolBlock } from './state.js';

/**
 * 老布局：SOP 放在用户的技能目录里。
 * 保留它只是为了让**本机上已经存在的那份**还能被显式指定（config.sopDir），
 * 不再是默认值 —— 因为发布出去的插件不能依赖用户磁盘上恰好有这个东西。
 */
export const USER_SOP_DIR = join(homedir(), '.dsh', 'skills', 'interviewer');

/**
 * SOP 目录怎么定。
 *
 * 顺序：显式配置 > 包内 > 用户技能目录。
 *
 * ⚠ **包内优先于用户目录**是刻意的，不是疏忽。
 *   反过来的话，作者本机因为恰好有 `~/.dsh/skills/interviewer/`，永远走不到包内那份，
 *   于是"包里的 SOP 到底全不全"在本机永远测不出来 —— 而这个 bug 只在别人机器上炸。
 *   想让自己的目录生效，用 config.sopDir 显式写出来（明确表达意图），
 *   而不是靠"碰巧存在一个同名目录"。dev-check 另外单独校验包内 SOP 文件齐全。
 */
export function resolveSopDir(config) {
  const cfg = config || {};
  if (typeof cfg.sopDir === 'string' && cfg.sopDir.length > 0) return cfg.sopDir;

  const bundled = interviewerSkillDir();
  if (existsSync(join(bundled, 'SKILL.md'))) return bundled;

  return USER_SOP_DIR;
}

/**
 * 系统提示词要读哪些文件。
 *
 * ⚠ 这里踩过一个必须记下来的坑：
 *
 *   第一版只读了 SKILL.md，因为"全塞进去每轮多几万 token，不划算"。
 *   结果第一次真跑，模型的第一句回复是：
 *
 *     <｜DSML｜> calls> <｜DSML｜> invoke name="Bash">
 *       find / -name "SKILL.md" -path "*interviewer*"
 *
 *   它在**试图调用工具去找那些被引用的文件** —— 而面板里没有任何工具，
 *   工具调用语法就直接当纯文本漏了出来。第二轮 max-tokens 挂掉。
 *
 *   根因：SOP 里写满了「见 references/01-rounds.md」这类指引，但文件不在
 *   提示词里，模型只好自己去"找"。
 *
 * 所以：**要么把被引用的内容给全，要么明确告诉模型它没有文件访问权。**
 * 这里两件都做了。省 token 不能省到这个地步。
 */
export const DEFAULT_SOP_FILES = [
  'SKILL.md',
  'references/01-rounds.md',
  'references/02-personas.md',
  'references/03-question-ladders.md',
  'references/05-voices.md',
];

/**
 * 系统提示词的最前面必须挂这段。
 *
 * 没有它，模型会去读文件、查目录、尝试调用工具 —— 在这个面板里全都是
 * 不存在的动作，产出就是一堆垃圾。
 */
export const ENV_PREAMBLE = [
  '【运行环境】',
  '你运行在一个纯对话面板里。**你没有文件系统访问权限，也没有任何工具可以调用。**',
  '不要尝试读取文件、不要输出工具调用语法（如 Bash / Read / 函数调用）、',
  '不要去查找 SKILL.md 或 references/ 目录 —— 那些动作在这里不存在，输出了就是坏的。',
  '下面给出的就是你能用的全部资料。SOP 里提到的那些文件名，内容都已经包含在下方。',
  '',
].join('\n');

/** 读不到技能目录时的兜底。宁可提示词短一点，也不能让面板发不出话。 */
export const FALLBACK_SOP = [
  '你是面试考官，不是助教。任务是在有限时间里测出候选人的真实能力边界。',
  '',
  '铁律：',
  '1. 一次只问一个问题。不要列 1/2/3，不要给选项菜单。',
  '2. 不讲解、不纠正、不铺垫。候选人答错时记录，继续往下问。',
  '3. 含糊必追问。听到「大概」「差不多」「应该是」「我们」立刻追问具体数字或你的角色。',
  '4. 不放过「不知道」。给一次换角度的机会，仍不会才记录并推进。',
  '5. 不替候选人组织语言，不要说「你是不是想说……」。',
  '6. 不评价、不安慰、不鼓励。',
  '',
  '从简历上的事实出发，一层层往下钻：事实核查 → 技术选型 → 实现细节 → 反事实 → 复盘。',
  '追问四种武器：要数字、要因果、要边界、要取舍。',
  '',
  '说话要像人：',
  '- 用他的词接住再问（「分 64 库 —— 这个数字怎么定的？」），不要问「为什么这么设计」。',
  '- 单点提问比开放提问难糊弄：不问「提升在哪里」，问「P99 从多少到多少」。',
  '- 可以说出你自己在意什么（「我对那个 64 库比较感兴趣」），这不是评价。',
  '',
  '用中文。一次回复只问一个问题，提问本身控制在两三句以内 —— 但要接话、要有节奏，',
  '不要写成一条干巴巴的指令。',
].join('\n');

/**
 * 回复前自查清单。
 *
 * 第 4-7 条是 2026-09-20 那场模拟面试跑完之后补的。那场面试官问出了全场最好的
 * 一个问题（自己算出 7×120ms ≠ P99 2.4s 并抓住矛盾），但**在同一个话题上死磕了 5 轮**
 * —— 而 SOP 只允许追 2 次。代价是它没余力去接别的话题，放掉了一段教科书级的含糊回答。
 *
 * 根因是"追问能力很强，但不知道什么时候该停"。所以这几条都钉在"什么时候收手"上。
 *
 * ⚠ 第 4 条依赖状态机给的字面计数才成立。光写"到 2 次就换"没用 —— 模型自己数不清。
 */
export const SELF_CHECK = [
  '',
  '---',
  '',
  '【每次回复前自查】',
  '1. 我有没有输出工具调用语法或去读文件？有 → 删掉重来。',
  '2. 我这一条里有几个问号？超过一个 → 只留一个（同一话题的两小问除外）。',
  '3. 我有没有评价、安慰、或替候选人组织语言？有 → 删掉。',
  '4. **这个话题我已经追了几次？到 2 次还没问出来 → 记下边界，立刻换话题。**',
  '   不要把人逼死在同一处 —— 那样测不出广度。',
  '5. 我有没有复述问题、或者指出他没答对？有 → 删掉。直接换话题，或换个问法重问一遍。',
  '6. 我有没有用「是不是 X？」递答案？有 → 改成开放式但要数字的问法。',
  '7. 候选人说结束了吗？说了 → **只回一句「好，我整理一下」，不要输出报告**。',
  '   评分和报告是另外的步骤，不在对话里展开。',
].join('\n');

/**
 * 按配置读 SOP 文件拼成系统提示词；读不到就用兜底。
 * 这一份是**稳定的**（同一场面试里每轮都一样），变化的部分由 buildTurnSystem 追加。
 */
export function buildSystemPrompt(config) {
  const cfg = config || {};
  const dir = resolveSopDir(cfg);
  const files = Array.isArray(cfg.sopFiles) && cfg.sopFiles.length > 0
    ? cfg.sopFiles
    : DEFAULT_SOP_FILES;

  const parts = [];
  for (const rel of files) {
    try {
      const full = join(dir, rel);
      if (existsSync(full)) parts.push(readFileSync(full, 'utf8'));
    } catch {
      // 单份读失败不影响整体
    }
  }

  const body = parts.length > 0 ? parts.join('\n\n---\n\n') : FALLBACK_SOP;

  // 环境说明放最前面（先立规矩），自查清单放末尾（模型对结尾的指令更敏感）。
  // 状态标记协议**不在这里** —— 它依赖当前状态（计划拿到没有），所以放在 buildTurnSystem。
  return ENV_PREAMBLE + body + SELF_CHECK;
}

/**
 * 每一轮真正发出去的 system = 稳定提示词 + 本轮设定 + 状态协议 + 面试状态。
 *
 * brief 由面板给（方向/职级/轮次/风格），state 由状态机算。
 *
 * ⚠ 顺序是实测调出来的：
 *   状态协议（格式要求）放在状态块**之前**。曾经试过把协议挪到整段最末尾，
 *   希望模型最后读到格式要求 —— 结果命中率反而从 4/5 掉到 1/5。
 *   协议和状态块都在尾部就够了，不必抢最后一行。
 *   而状态块永远是**最后**的：它承载"你必须换话题"这个动作。
 */
export function buildTurnSystem(config, brief, state) {
  const base = buildSystemPrompt(config);
  const briefPart = typeof brief === 'string' && brief.length > 0
    ? '\n\n---\n\n' + brief
    : '';
  return base + briefPart
    + '\n\n---\n\n' + stateProtocolBlock(state)
    + '\n\n---\n\n' + buildStateBlock(state);
}
