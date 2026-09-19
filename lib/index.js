/**
 * dsh-interviewer —— 主机侧（Node）
 *
 * 职责：挂一个 HTTP 路由，让浏览器里的面试面板能真的跟模型说话。
 *
 * 为什么走 HTTP 路由而不是 DSH 的 Remote：
 *   Remote 要接 typert 协议（host 侧和 client 侧各一份描述），而这里只需要
 *   一个"把消息发过去、把回复拿回来"的单向调用。路由更直接，也更好调试
 *   —— 出问题直接 curl 就能验，不用开浏览器。
 *
 * 模型怎么来的：
 *   不自己管密钥、不自己发 HTTP。直接注入 DSH 已经配好的 llm 服务，
 *   路由从 agentDefaultModel 读 settings.yaml 里的默认选择。
 *
 * ⚠ 关键约定：`@deepseek-ai/dsh-llm` 必须写在 package.json 的
 *   **peerDependencies** 里才解析得到。它不在依赖树里，是 DSH 的 loader
 *   用自己的解析器提供的 —— 这也是 dsh-better-sidebar 等插件的做法。
 *   用纯 Node 的 createRequire 试会 MODULE_NOT_FOUND，那是正常的。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BlockAssembler, createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { emptyState, splitState, mergeState, domainFromBrief } from './state.js';
import { resolveSopDir, buildTurnSystem } from './prompt.js';
import { registerInterviewerSkill, interviewerSkillDir } from './skill.js';

export const name = 'dsh-interviewer';

/**
 * 需要哪些主机服务。三个都必须在 —— 没有 llm 调不了模型，
 * 没有 webServer 挂不上路由，没有 skills 就注册不了面试技能。
 * 缺一个这个插件就没有意义，所以这里让它硬依赖，而不是静默降级。
 */
export const inject = ['llm', 'webServer', 'skills'];

/** 路由前缀。client 侧按这个地址发请求。 */
const ROUTE = '/interviewer/api';

/** 日志前缀，方便在启动输出里一眼看到。 */
const TAG = '[dsh-interviewer]';

/**
 * 输出额度上限。
 *
 * ⚠ 必须记住的一条事实：**推理（thinking）token 也计入 maxTokens。**
 *   所以这个数字不是"回复能有多长"，而是"想 + 说总共能有多长"。
 *   实测（同一段对话、同一个模型）：
 *     不带状态协议 → 1600 够
 *     带状态协议   → 有时 3000 都不够，思考把额度吃光，输出 0 字直接 max-tokens
 *   而模型的思考长度波动极大 —— 同样输入，有时 3 秒答完，有时 14 秒还没吐字。
 *   所以额度要留余量，并且失败要能重试（见 handleChat 里的第二次尝试）。
 */
const MAX_TOKEN_CEILING = 8192;

/** 重试时追加的一句。放最后 —— 模型对结尾的指令最敏感。 */
const RETRY_NUDGE = [
  '【注意】上一次尝试你想得太久，把输出额度用光了，结果一个字都没说出来。',
  '这次不要长篇推理。想清楚要问什么，**直接写那句话**，两三句以内。',
].join('\n');

/**
 * 跑一轮模型调用，把流收成一段文本。
 *
 * 抽出来是为了能重试：第一次失败之后要拿**完全相同**的入参再跑一遍，
 * 只是换额度。写在循环里做这件事很容易漏掉某个参数。
 */
async function runTurn(ctx, route, messages, system, maxTokens) {
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system,
      maxTokens,
    })) {
      assembler.push(chunk);
    }
  } catch (err) {
    return {
      error: err && err.message ? err.message : String(err),
      text: '', finishKind: 'error', detail: '调用异常', retried: false,
    };
  }

  const finish = assembler.finish;
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const finishKind = finish && finish.kind ? finish.kind : 'unknown';
  const detail = finish && finish.failure && finish.failure.message
    ? finish.failure.message
    : finishKind;

  return { error: null, text, finishKind, detail, retried: false };
}


// ---------------------------------------------------------------- HTTP 工具

/** 读请求体并解析 JSON。带上限，避免畸形请求把内存吃满。 */
async function readJson(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('请求体超过 ' + limitBytes + ' 字节');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length > 0 ? JSON.parse(text) : {};
}

/** 统一 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

// ---------------------------------------------------------------- 路由处理

/** 从 agentDefaultModel 读默认模型；读不到退到 config，再读不到返回 null。 */
function resolveRoute(ctx, config) {
  const svc = ctx.get('agentDefaultModel');
  if (svc && typeof svc.currentSelection === 'function') {
    try {
      const sel = svc.currentSelection();
      if (sel && sel.provider && sel.model) {
        return { provider: sel.provider, model: sel.model, from: 'agentDefaultModel' };
      }
    } catch {
      // 落到下面的兜底
    }
  }
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model, from: 'plugin config' };
  }
  return null;
}

/** GET /interviewer/api/health —— 面板用它探测主机侧是否就绪。 */
function handleHealth(ctx, config, res) {
  const route = resolveRoute(ctx, config);
  let providers = [];
  try {
    providers = ctx.llm.listProviders().map((p) => p.provider ?? p.id ?? String(p));
  } catch {
    // 拿不到就留空，不影响健康检查的结论
  }
  const sopDir = resolveSopDir(config);
  sendJson(res, 200, {
    ok: true,
    route,
    providers,
    sopDir,
    hasSop: existsSync(join(sopDir, 'SKILL.md')),
    // 面板据此显示"提示词从哪儿读的"。发布之后这一点很重要：
    // 包内 vs 用户目录读出来的 SOP 可能不是同一份，不说清楚没法排查。
    sopDirBundled: sopDir === interviewerSkillDir(),
  });
}

/** POST /interviewer/api/chat —— 把对话发出去，拿回复。 */
async function handleChat(ctx, config, req, res) {
  const body = await readJson(req);

  const turns = Array.isArray(body.messages) ? body.messages : [];
  if (turns.length === 0) {
    sendJson(res, 400, { ok: false, error: 'messages 不能为空' });
    return;
  }

  const route = resolveRoute(ctx, config);
  if (route === null) {
    sendJson(res, 503, {
      ok: false,
      error: '没有可用的模型路由：agentDefaultModel 没读到，插件 config 里也没配 provider/model',
    });
    return;
  }

  // 用官方工厂造消息。DSH 的消息是带 brand 的不可变对象 —— 品牌类型在运行时
  // 就是字符串，但用工厂能保证字段形状和校验不被绕过。
  const messages = turns
    .filter((t) => t && typeof t.text === 'string' && t.text.length > 0)
    .map((t) => (t.role === 'assistant'
      ? createAssistantMessage({
        content: [{ type: 'text', text: t.text }],
        source: { provider: route.provider, model: route.model },
      })
      : createUserMessage({
        content: [{ type: 'text', text: t.text }],
        source: { kind: 'plugin', plugin: 'dsh-interviewer' },
      })));

  if (messages.length === 0) {
    sendJson(res, 400, { ok: false, error: 'messages 里没有有效的文本轮次' });
    return;
  }

  // 本轮的方向/职级/轮次，由面板传上来，拼在 SOP 后面
  const brief = typeof body.brief === 'string' && body.brief.length > 0 ? body.brief : '';

  // 面试状态由面板持有、每轮回传 —— 主机侧是无状态的纯函数。
  // 这样状态不会因为 DSH 重启而丢，也不需要服务端会话。
  //
  // 新开一场时要带上面板选的方向：状态机据此取一份兜底计划骨架。
  // 模型一直不给计划时就用它，保证广度机制（点名换话题）不会空转。
  const state = body.state && typeof body.state === 'object'
    ? body.state
    : emptyState({
      budgetMin: Number(config.budgetMin) || 45,
      domain: domainFromBrief(brief),
    });

  // 提示词装配整个交给 prompt.js（纯 Node，离线可测）。
  // 顺序：环境声明 + SOP + 自查 + 状态协议 → 本轮设定 → 面试状态。
  // 最后那个状态块是本轮最需要被看见的东西 ——「你已经在这个话题上追了 2 次了」。
  const system = buildTurnSystem(config, brief, state);

  const asked = Number(body.maxTokens);
  const maxTokens = Number.isFinite(asked) && asked > 0
    ? Math.max(64, Math.min(8192, asked))
    : (Number.isFinite(Number(config.maxTokens)) ? Number(config.maxTokens) : 2048);

  const started = Date.now();

  // ---- 第一次尝试 ----
  let attempt = await runTurn(ctx, route, messages, system, maxTokens);
  if (attempt.error !== null) {
    ctx.logger?.warn?.(TAG + ' 模型调用失败：' + attempt.error);
    sendJson(res, 502, { ok: false, error: '模型调用失败：' + attempt.error, route });
    return;
  }

  // ---- 第二次尝试 ----
  //
  // 为什么要有这一步：实测下来，"推理 token 也计入 maxTokens"，而模型的思考长度
  // 波动很大。同一段对话同一个额度，有时候 3 秒就答完，有时候思考 14 秒还没吐出
  // 一个字 —— 于是整轮回 502，面板上直接出现一个断掉的话轮。
  //
  // 真实面试官不会因为他想久了就失声。所以这里退一步：额度翻倍再来一次，
  // 并在提示词末尾加一句"别想了直接说"。
  //
  // 只在**没有产出任何内容**时重试。已经写出半句话的情况不重试 ——
  // 那时重试会得到一个和前半句不连贯的答案，比截断更糟。
  const retryWorthy = attempt.text.trim().length === 0;
  if (retryWorthy && maxTokens < MAX_TOKEN_CEILING) {
    const retryTokens = Math.min(MAX_TOKEN_CEILING, maxTokens * 2);
    ctx.logger?.info?.(
      TAG + ' 本轮没有产出内容（finish=' + attempt.finishKind + '），'
      + '额度 ' + maxTokens + ' → ' + retryTokens + ' 重试一次'
    );
    const nudged = system + '\n\n' + RETRY_NUDGE;
    const second = await runTurn(ctx, route, messages, nudged, retryTokens);
    if (second.error === null && second.text.trim().length > 0) {
      attempt = second;
      attempt.retried = true;
      attempt.firstFinish = attempt.finishKind;
    } else if (second.error === null) {
      attempt = second;   // 还是空的，走下面的空内容分支
    }
    // second.error !== null 时保留第一次的结果（失败原因更有信息量）
  }

  // 非正常终止要说清楚，否则面板会显示一段截断的话，让人以为是模型答得怪
  if (attempt.finishKind !== 'stop' && attempt.text.trim().length === 0) {
    sendJson(res, 502, {
      ok: false,
      error: '模型未正常结束（' + attempt.detail + '）',
      partial: attempt.text,
      route,
    });
    return;
  }

  // 把状态块从回复里摘掉（那是给状态机的，不该让候选人看到），并合并进状态
  const { reply, delta } = splitState(attempt.text);
  const nextState = mergeState(state, delta);

  // 空回复不能当成功。2026-09-20 那场模拟面试里出现过一轮：finish=stop 但 text 为空，
  // 结果空字符串被当成正常回答写进了对话历史，污染了后续上下文。
  if (reply.trim().length === 0) {
    ctx.logger?.warn?.(TAG + ' 模型返回了空内容（finish=' + attempt.finishKind + '），按失败处理');
    sendJson(res, 502, { ok: false, error: '模型返回了空内容，请重试', route });
    return;
  }

  ctx.logger?.info?.(
    TAG + ' 话题=' + (nextState.topic || '（未进入）')
    + ' 本轮第 ' + nextState.turnsOnTopic + ' 次'
    + ' 已用 ' + Math.floor((Date.now() - nextState.startedAt) / 60000) + ' 分钟'
    + (delta ? '' : ' ⚠ 本轮没拿到状态标记（已兜底计数）')
    + (attempt.retried ? ' ↻ 重试过（首次 ' + attempt.firstFinish + '）' : '')
  );

  sendJson(res, 200, {
    ok: true,
    text: reply,
    state: nextState,
    hadState: delta !== null,
    route,
    finish: attempt.finishKind,
    retried: attempt.retried === true,
    ms: Date.now() - started,
    turns: messages.length,
  });
}

/** 路由总入口。 */
async function route(ctx, config, req, res) {
  const path = (req.url || '').split('?')[0].slice(ROUTE.length) || '/';

  try {
    if (path === '/health' && req.method === 'GET') {
      handleHealth(ctx, config, res);
      return;
    }
    if (path === '/chat' && req.method === 'POST') {
      await handleChat(ctx, config, req, res);
      return;
    }
    sendJson(res, 404, { ok: false, error: '未知路径：' + path });
  } catch (err) {
    const msg = err && err.stack ? err.stack : String(err);
    ctx.logger?.warn?.(TAG + ' 路由处理异常：' + msg);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------- 插件体

export function apply(ctx, config = {}) {
  const options = config && typeof config === 'object' ? config : {};

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => route(ctx, options, req, res),
    }),
    'dsh-interviewer: api route'
  );

  // 把面试 SOP 注册成运行时技能 —— 这样装插件的用户不用另外去装技能，
  // 在主会话里 `skill interviewer` 也能用同一份 SOP。
  // 单个文件缺失只告警，不弄崩宿主启动（技能注册失败不该让 DSH 起不来）。
  let skillState = '已注册';
  try {
    ctx.effect(() => registerInterviewerSkill(ctx), 'dsh-interviewer: skill');
  } catch (err) {
    skillState = '注册失败：' + (err && err.message ? err.message : String(err));
    ctx.logger?.warn?.(TAG + ' 技能' + skillState);
  }

  const resolved = resolveRoute(ctx, options);
  const sopDir = resolveSopDir(options);

  ctx.logger?.info?.(
    TAG + ' 主机侧已加载。API=' + ROUTE + '  模型='
    + (resolved
      ? resolved.provider + '/' + resolved.model + '（来自 ' + resolved.from + '）'
      : '未解析到 ← 面板会报 503')
  );

  // 这两行是给"装完之后不好用"准备的排查线索：
  // 提示词从哪个目录读、技能注册成没成，一眼就能看到。
  ctx.logger?.info?.(
    TAG + ' SOP 目录=' + sopDir
    + (sopDir === interviewerSkillDir() ? '（包内）' : '（外部目录）')
  );
  ctx.logger?.info?.(TAG + ' 技能 ' + skillState + '（名字：interviewer）');
}
