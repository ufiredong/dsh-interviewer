/**
 * skill.js —— 把面试 SOP 作为**运行时技能**注册进 DSH
 *
 * 为什么需要这个文件：插件原本**不自包含**。
 *
 *   SOP 一直住在 `~/.dsh/skills/interviewer/`，而 lib/prompt.js 按那个绝对路径读。
 *   本机跑得好好的，但**别人装了插件，他磁盘上没有这个目录** ——
 *   读不到就走 FALLBACK_SOP（一段压缩过的短提示词），面试官质量直接掉一档，
 *   而且不会有任何报错，装的人根本不知道为什么不好用。
 *
 *   发布前必须解决：SOP 要跟着包走。
 *
 * 两件事都要做，缺一不可：
 *
 *   1. 技能形态 —— 调 `ctx.skills.register()` 注册成运行时技能，
 *      这样用户在主会话里也能 `skill interviewer` 用同一份 SOP。
 *      做法照抄生态里的正例 dsh-ppt/lib/skill.js（SKILL.md 随包分发 + runtime 注册）。
 *
 *   2. 面板形态 —— lib/prompt.js 直接读包内文件当系统提示词。
 *      这条不走技能注册，是独立的一条读取路径，所以目录定位必须**只有一处定义**，
 *      就放在这里（interviewerSkillDir），prompt.js import 它。
 *      两处各写一份路径，早晚会漂移。
 *
 * 关于同名冲突：用户自己可能也有 `~/.dsh/skills/interviewer/`。
 * 查过 dsh-skill 的实现（lib/index.js register），同名是 **first-wins**：
 * 后来的只打一条 warn 然后拿到一个 no-op disposer，**不会抛错、不会崩宿主**。
 * 所以这里不需要额外做存在性检查，注册失败也只告警。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 技能名。和 SKILL.md frontmatter 里的 name 必须一致。 */
export const SKILL_NAME = 'interviewer';

/** 随包分发的技能根目录（`<包>/skills/`）。 */
export function bundledSkillsDir() {
  return join(HERE, '..', 'skills');
}

/**
 * 面试技能目录的绝对路径。**这是全插件唯一定义 SOP 位置的地方。**
 * lib/prompt.js 从这里拿目录去读提示词，技能注册也从这里读 SKILL.md。
 */
export function interviewerSkillDir() {
  return join(bundledSkillsDir(), SKILL_NAME);
}

// ---------------------------------------------------------------- frontmatter

/** 去掉 YAML 标量外面的引号，并还原转义。 */
function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
  }
  return trimmed;
}

/**
 * 解析 SKILL.md 的 frontmatter。
 *
 * 只认 name / description 两个单行字段 —— 这是 DSH 技能注册表要求的最小集。
 * 零依赖手写解析（不引 yaml 库），和 dsh-ppt 的做法一致：
 * 为一个两字段的头部装一个 YAML 解析器不划算。
 */
export function parseSkillFile(text) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/.exec(normalized);
  if (match === null) {
    return { name: '', description: '', content: normalized };
  }

  let name = '';
  let description = '';
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (kv === null) continue;
    if (kv[1] === 'name') name = unquoteYamlScalar(kv[2]);
    else if (kv[1] === 'description') description = unquoteYamlScalar(kv[2]);
  }

  return {
    name,
    description,
    content: normalized.slice(match[0].length).trimStart(),
  };
}

// ---------------------------------------------------------------- 注册

/**
 * 把面试 SOP 注册成运行时技能。
 *
 * `resourceBase` 指向包内技能目录 —— 这样技能正文里写的「见 references/03-…md」
 * 在装了插件的人机器上也能解析到，而不是让模型去找一个不存在的文件。
 * （早期就是因为这个吃了大亏：提示词里引用了 references，文件却不在，
 *   模型于是输出工具调用语法尝试 `find` 那些文件，整轮回复报废。）
 *
 * @returns cordis 的 effect disposer
 */
export function registerInterviewerSkill(ctx) {
  const dir = interviewerSkillDir();
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const parsed = parseSkillFile(text);

  if (parsed.name === '' || parsed.description === '' || parsed.content === '') {
    throw new Error(
      '技能 ' + SKILL_NAME + ' 的 frontmatter 不完整（name / description / content 都不能为空）：'
      + join(dir, 'SKILL.md')
    );
  }

  return ctx.skills.register({
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    resourceBase: { kind: 'directory', path: dir },
    source: 'runtime',
  });
}
