/**
 * dev-check.mjs —— dsh-interviewer 插件自检
 *
 *   node dev-check.mjs
 *
 * 这个插件最大的风险不是逻辑写错，而是**槽位名或 id 拼错**：
 * SlotCore.register 遇到未声明的槽位会直接抛错，而那一刻是在浏览器里、
 * 需要你重启 DSH 之后才发生。所以这里在 Node 里把插件**真的跑一遍** ——
 * 用桩替换 window.__ModuleLoader__ 和 ctx，抓取它实际发出的注册调用，
 * 再逐条核对。
 *
 * 这是能在无浏览器环境下做到的最强验证：不是"看起来对"，是"真的执行了"。
 */
'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const problems = [];
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');

/**
 * 已声明的槽位白名单 —— 从随 DSH 发布的 UI 包类型定义里提取。
 * 注册到不在表里的槽位会抛错，所以这张表就是"能不能注册"的唯一依据。
 * 来源：@deepseek-ai/dsh-client-ui-layout / -sidebar / -conversation 的
 *       lib/types/client/contract/slots.d.ts
 */
const KNOWN_SLOTS = new Set([
  // layout
  'sidebar', 'main', 'rightbar', 'shell.overlay',
  // sidebar
  'sidebar.brand.mark', 'sidebar.brand.name', 'sidebar.panellist',
  'sidebar.workspaces', 'sidebar.settings', 'sidebar.footer.action',
  // conversation
  'main.conversation', 'conversation.session', 'conversation.session.header',
  'conversation.session.header.lineage', 'conversation.session.header.actions',
  'conversation.session.header.utilities', 'conversation.session.header.corner',
  'conversation.view', 'conversation.composer', 'conversation.hero.workspace',
  'conversation.hero.brand.mark', 'conversation.hero.agentPreset',
  'conversation.input.dock', 'conversation.input.overlay',
  'conversation.composer.dock', 'conversation.input.left',
  'conversation.input.right', 'conversation.composer.bar',
  'conversation.input.attachments', 'conversation.input.plan',
  'conversation.input.model', 'conversation.chat.node',
]);

// ---------------------------------------------------------------- 1. 清单

console.log('--- 包清单 ---');

const pkg = JSON.parse(read('package.json'));
const checks = [
  ['main', pkg.main === 'lib/index.js'],
  ['type=module', pkg.type === 'module'],
  ['exports["./client"]', pkg.exports && pkg.exports['./client']],
  ['dsh.bundle.patch', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch],
  ['dsh.client.platform', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'],
];
for (const [label, ok] of checks) {
  if (!ok) problems.push('package.json 缺少或写错：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

const entryFile = 'lib/index.js';
const clientFile = 'lib/client.js';
for (const f of [entryFile, clientFile, pkg.dsh?.bundle?.patch]) {
  if (f && !existsSync(join(HERE, f))) problems.push('文件不存在：' + f);
}

// ---------------------------------------------------------------- 2. patch 层

console.log('\n--- cordis.patch.yml ---');

const patch = read(pkg.dsh.bundle.patch);
const patchName = /name:\s*'?([\w@/.-]+)'?/.exec(patch);
const patchId = /id:\s*([\w-]+)/.exec(patch);
if (!/- insert:/.test(patch)) problems.push('patch 里没有 insert 段');
if (!patchName || patchName[1] !== pkg.name) {
  problems.push('patch 里的 name（' + (patchName ? patchName[1] : '无') + '）与包名（' + pkg.name + '）不一致');
}
console.log('  insert 行  id=%s  name=%s', patchId ? patchId[1] : '?', patchName ? patchName[1] : '?');

// ---------------------------------------------------------------- 3. 真跑一遍

console.log('\n--- 执行浏览器侧模块 ---');

const source = read(clientFile);

// 桩：React 只需要插件真正用到的 API。
// 桩缺了插件用到的成员，会在渲染那条代码路径走到时才炸 —— 那时已经离改动很远了。
// 每加一个 Hook，这里就要跟着加一个。
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init === undefined ? null : init }),
  // 副作用在桩里不执行 —— 它们会发网络请求，测里不该真发
  useEffect: () => {},
};

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (def) => { loaded = def; },
    },
  },
  console,
  // 浏览器才有的东西要在沙箱里补上，否则这里跑得过、浏览器里炸，
  // 或者反过来 —— 上次就因为漏了 setTimeout，自检直接报 "setTimeout is not defined"。
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
  // 状态条那一段加了一个走时钟的计时器（让"已用多少分钟"在面板上真的动）。
  // useEffect 在桩里不执行，所以这两个目前不会真被调到 —— 但补上，
  // 免得哪天桩改成执行副作用就在这里炸。
  setInterval: () => 0,
  clearInterval: () => {},
};
vm.createContext(sandbox);

let runtimeError = null;
try {
  vm.runInContext(source, sandbox, { filename: clientFile });
} catch (err) {
  runtimeError = err;
}
if (runtimeError) {
  problems.push('执行 client.js 抛错：' + runtimeError.message);
  console.error('\n✗ ' + runtimeError.message);
  process.exit(1);
}

if (!loaded) {
  console.error('✗ client.js 没有调用 window.__ModuleLoader__.load');
  process.exit(1);
}
console.log('  模块 id    %s', loaded.id);
console.log('  factory    %s', typeof loaded.factory);

if (loaded.id !== pkg.name) {
  problems.push('__ModuleLoader__ 的 id（' + loaded.id + '）与包名（' + pkg.name + '）不一致');
}

// 用桩 require 调 factory
const requires = [];
const stubRequire = (name) => {
  requires.push(name);
  if (name === 'react') return reactStub;
  throw new Error('模块 ' + name + ' 不在桩里。浏览器里能解析不代表这里能，' +
    '请把它加进 dev-check 的桩，或确认 dsh.client.inject 声明了它。');
};

let mod = null;
try {
  mod = loaded.factory(stubRequire);
} catch (err) {
  problems.push('factory 抛错：' + err.message);
}

if (mod) {
  console.log('  require    %s', requires.join(', ') || '（无）');
  console.log('  exports    %s', Object.keys(mod).join(', '));
  if (typeof mod.apply !== 'function') problems.push('浏览器侧模块没有导出 apply');
  if (!Array.isArray(mod.inject)) problems.push('浏览器侧模块没有导出 inject 数组');
}

// ---------------------------------------------------------------- 4. 抓注册调用

console.log('\n--- 实际发出的注册调用 ---');

const registrations = [];
const ctx = {
  slots: {
    // 真环境里这是"等槽位被声明后再回调"，桩里立即回调即可
    inject: (name, cb) => { cb(); return () => {}; },
    register: (opts, component) => {
      registrations.push({ opts, component });
      return () => {};
    },
    // 回读诊断用的两个查询。桩必须按槽位名过滤，否则三条注册会互相串味，
    // 输出看起来"每条槽位都有 3 个条目"，其实是桩的问题。
    entries: (name) => registrations.filter((r) => r.opts.name === name).map((r) => ({ options: r.opts })),
    entriesOfSlot: (name) => registrations.filter((r) => r.opts.name === name).map((r) => ({ options: r.opts })),
  },
};

let applyError = null;
try {
  mod.apply(ctx);
} catch (err) {
  applyError = err;
}
if (applyError) {
  problems.push('apply() 抛错：' + applyError.message);
}

for (const r of registrations) {
  const o = r.opts;
  const kind = o.key !== undefined ? 'key=' + o.key : (o.id !== undefined ? 'id=' + o.id : '');
  console.log('  → %s  %s  %s', o.name, kind, o.label ? 'label=' + o.label : '');
  if (!KNOWN_SLOTS.has(o.name)) {
    problems.push('注册到了未声明的槽位 "' + o.name + '" —— 运行时会抛错');
  }
  if (typeof r.component !== 'function') {
    problems.push(o.name + ' 的组件不是函数');
  }
}

// ---------------------------------------------------------------- 5. 接线核对

console.log('\n--- 接线核对 ---');

// 现在只有一个入口：shell.overlay 里的悬浮窗口。
// main / sidebar.panellist 都撤了 —— main 是全屏接管（用户出不来），
// sidebar.panellist 注册成功但侧边栏就是不渲染它。
const overlay = registrations.find((r) => r.opts.name === 'shell.overlay');

if (!overlay) {
  problems.push('没有注册 shell.overlay —— 面板将完全没有入口');
} else {
  console.log('  ✓ 入口：shell.overlay  id=%s', overlay.opts.id);
}

// 收起态和展开态应该是同一个组件渲染出来的，所以只注册一次。
const overlayCount = registrations.filter((r) => r.opts.name === 'shell.overlay').length;
if (overlayCount > 1) {
  problems.push('shell.overlay 注册了 ' + overlayCount + ' 次，会渲染出多个悬浮窗');
}

// 撤掉的那两个不该再出现，否则会同时存在全屏面板和悬浮窗两套入口
for (const gone of ['main', 'sidebar.panellist']) {
  if (registrations.some((r) => r.opts.name === gone)) {
    problems.push('又注册了 ' + gone + '，但它已经不该存在了（会多出一套入口）');
  }
}

// 组件能不能真的渲染出东西 —— 用桩 React 跑一遍
if (overlay && typeof overlay.component === 'function') {
  try {
    const tree = overlay.component({});
    const ok = tree !== null && tree !== undefined;
    console.log('  %s 悬浮窗组件能渲染（收起态）', ok ? '✓' : '✗');
    if (!ok) problems.push('悬浮窗组件渲染返回空');
  } catch (err) {
    problems.push('悬浮窗组件渲染抛错：' + err.message);
    console.log('  ✗ 悬浮窗组件渲染抛错：%s', err.message);
  }
}

// 拖拽是这次的核心交互，静态确认它真的挂上了指针事件
const clientSrc = read(clientFile);
const dragChecks = [
  ['标题栏挂了 onPointerDown', /onPointerDown:\s*onDragDown/.test(clientSrc)],
  ['挂了 onPointerMove', /onPointerMove:\s*onDragMove/.test(clientSrc)],
  ['挂了 onPointerUp', /onPointerUp:\s*onDragUp/.test(clientSrc)],
  ['拖动位置做了视口钳制', /const clamp = /.test(clientSrc)],
  ['窗口可收起（回到 closed 阶段）', /if \(stage === 'closed'\)/.test(clientSrc)],
];
for (const [label, ok] of dragChecks) {
  if (!ok) problems.push('拖拽/收起缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// 语音输入。这条路径依赖浏览器内置 API，跑不起来时**必须报出原因**而不是静默不动，
// 否则用户分不清是"没识别到"还是"根本用不了"。
const voiceChecks = [
  ['检测浏览器语音识别 API', /window\.SpeechRecognition/.test(clientSrc)],
  ['错误码翻译成人话', /function speechErrorHint/.test(clientSrc)],
  ['麦克风按钮 + 启停逻辑', /const toggleMic = /.test(clientSrc)],
  ['识别结果追加进草稿（不自动发送）', /setDraft\(\(d\) =>/.test(clientSrc)],
  ['中文识别', /rec\.lang = 'zh-CN'/.test(clientSrc)],
  ['network 错误有专门提示（国内最常见）', /case 'network':/.test(clientSrc)],
];
for (const [label, ok] of voiceChecks) {
  if (!ok) problems.push('语音输入缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// ---------------------------------------------------------------- 6. 主机侧
//
// 主机侧**没法在这里真的执行** —— 它 import 的 `@deepseek-ai/dsh-llm`
// 在纯 Node 下是 MODULE_NOT_FOUND（那个包不在依赖树里，是 DSH 的 loader
// 用自己的解析器提供的，所以它才必须写在 peerDependencies 里）。
//
// 要真验主机侧只有两条路：
//   1. 插件配置文件里用 Node 的 loader hook 把那个模块替换成桩
//   2. 起一个 DSH 实例，打 /interviewer/api/health
//
// 这里只做静态检查，抓最关键的三处低级错误：导出名、inject 声明、路由前缀。

console.log('\n--- 主机侧（静态检查）---');

const host = read(entryFile);

const hostChecks = [
  ['导出 apply', /export\s+function\s+apply/.test(host)],
  ['导出 name', /export\s+const\s+name\s*=/.test(host)],
  ['inject 含 llm', /inject\s*=\s*\[[^\]]*'llm'/.test(host)],
  ['inject 含 webServer', /inject\s*=\s*\[[^\]]*'webServer'/.test(host)],
  ['注册了 webServer 路由', /webServer\.register\s*\(/.test(host)],
  ['路由用 prefix 类型', /kind:\s*'prefix'/.test(host)],
];
for (const [label, ok] of hostChecks) {
  if (!ok) problems.push('主机侧缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// 路由前缀必须和 client 侧请求的地址一致，否则面板永远 404
const routeMatch = /const\s+ROUTE\s*=\s*'([^']+)'/.exec(host);
const clientFetches = [...read(clientFile).matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
if (routeMatch) {
  const prefix = routeMatch[1];
  const mismatched = clientFetches.filter((u) => !u.startsWith(prefix));
  console.log('  %s 路由前缀 %s，client 侧请求 %d 处，%d 处不匹配',
    mismatched.length === 0 ? '✓' : '✗', prefix, clientFetches.length, mismatched.length);
  if (clientFetches.length === 0) {
    problems.push('client 侧没有任何 fetch，面板不会调主机');
  } else if (mismatched.length > 0) {
    problems.push('client 侧请求的地址不在主机路由前缀下：' + mismatched.join(', '));
  }
} else {
  problems.push('主机侧没有定义 ROUTE 常量');
}

// ---------------------------------------------------------------- 7. 提示词
//
// 这一组是回归断言，不是"锦上添花"。
//
// 第一版提示词只塞了 SKILL.md，而 SOP 里写满了「见 references/xx.md」。
// 模型就去找那些文件了 —— 输出的第一条回复是 `<｜DSML｜> invoke name="Bash">
// find / -name "SKILL.md"`，全是垃圾，第二轮直接 max-tokens 挂掉。
//
// 这个 bug 逻辑检查抓不到、语法检查抓不到、渲染冒烟也抓不到，只有真跑才暴露。
// 所以把"必须声明没有工具"和"必须把被引用的文件一起给全"钉在这里。

console.log('\n--- 系统提示词 ---');

// 提示词装配现在住在 lib/prompt.js（纯 Node，不碰 DSH），所以这里不再是
// "正则扫源码"那么弱 —— 直接把它 import 进来，把真的拼一遍看结果。
const promptSrc = existsSync(join(HERE, 'lib/prompt.js')) ? read('lib/prompt.js') : '';
if (promptSrc.length === 0) problems.push('lib/prompt.js 不存在 —— 提示词装配没拆出来');

const promptChecks = [
  ['声明了没有文件访问 / 没有工具',
    /没有文件系统访问权限/.test(promptSrc) && /不要输出工具调用语法/.test(promptSrc)],
  ['环境声明拼在最前面',
    /return\s+ENV_PREAMBLE\s*\+/.test(promptSrc)],
  ['被引用的 references 默认读进来',
    /DEFAULT_SOP_FILES[\s\S]{0,600}?references\/03-question-ladders\.md/.test(promptSrc)],
  ['风格库（05-voices）也读进来了',
    /DEFAULT_SOP_FILES[\s\S]{0,600}?references\/05-voices\.md/.test(promptSrc)],
  ['结尾有"回复前自查"清单', /每次回复前自查/.test(promptSrc)],
  ['兜底提示词要求"说话要像人"', /说话要像人/.test(promptSrc)],
  ['每轮系统提示词由 buildTurnSystem 装配', /export\s+function\s+buildTurnSystem/.test(promptSrc)],
  ['路由用 buildTurnSystem（不再自己拼）', /buildTurnSystem\(config,\s*brief,\s*state\)/.test(host)],
];
for (const [label, ok] of promptChecks) {
  if (!ok) problems.push('系统提示词缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// 真的把提示词拼一遍。**顺序是有意义的**：状态块必须在最后 ——
// 模型对结尾的指令最敏感，而这句「你已经追了 2 次了」正是上次失败的地方。
// 后面几段（自包含、技能注册）还要用这个模块，所以声明在外层作用域。
// 第一版写在 if 块里，结果新加的断言直接 ReferenceError —— 块级作用域。
let promptMod = null;
if (promptSrc.length > 0) {
  try {
    promptMod = await import('./lib/prompt.js');
  } catch (err) {
    problems.push('import lib/prompt.js 失败：' + err.message);
  }

  if (promptMod) {
    const capped = {
      startedAt: Date.now() - 3 * 60000, budgetMin: 45,
      plan: [{ topic: '订单链路' }, { topic: '缓存一致性' }],
      topic: '订单链路', turnsOnTopic: 2, done: [], boundaries: ['没做过降级'], notes: [],
    };
    const sys = promptMod.buildTurnSystem({}, '本轮设定：- 目标方向：Java 后端', capped);

    const orderChecks = [
      ['拼出来的提示词里含 SOP 正文', sys.includes('你是面试考官') || sys.includes('面试')],
      ['含状态标记协议', sys.includes('每轮最后加一行标记')],
      ['协议里给了 topic 行的样子', sys.includes('<!--topic:')],
      ['含本轮设定', sys.includes('本轮设定：- 目标方向：Java 后端')],
      ['含状态机的硬上限警告', sys.includes('本轮换到下一个话题')],
      ['★ 到上限时点名了下一个话题（不是抽象地说"换个话题"）',
        sys.includes('本轮换到下一个话题：缓存一致性')],
      ['含已记下的边界（不回头问）', sys.includes('没做过降级')],
      ['状态块在整段的最后（模型对结尾更敏感）',
        sys.trimEnd().endsWith('**追问能力很强但不知道什么时候停，等于没有追问能力。**')
        || /【本轮必须做的事】[\s\S]*$/.test(sys)],
      ['边界清单排在本轮动作之前（结尾只放动作，不放资料）',
        sys.indexOf('不要再回头问这些') < sys.indexOf('【本轮必须做的事】')],
      ['状态协议在自查清单之后', sys.indexOf('每次回复前自查') < sys.indexOf('每轮最后加一行标记')],
      ['环境声明在整段最前', sys.trimStart().startsWith('【运行环境】')],
    ];
    for (const [label, ok] of orderChecks) {
      if (!ok) problems.push('提示词装配顺序不对：' + label);
      console.log('  %s %s', ok ? '✓' : '✗', label);
    }
    console.log('  · 实测长度 %d 字符', sys.length);
  }
}

// 设置与面试分离：点按钮先进设置弹窗，确认后才进面试窗口。
// 这一组是流程断言 —— 曾经的结构是"点一下直接开聊"，那样用户没机会选方向/职级/风格。
const flowChecks = [
  ['client 侧有风格选项', /const VOICES = \[/.test(clientSrc)],
  ['有设置弹窗组件', /function SetupModal/.test(clientSrc)],
  ['弹窗含四个设置字段',
    /field\('目标方向'/.test(clientSrc) && /field\('面试官风格'/.test(clientSrc)],
  ['三阶段状态机（closed / setup / open）',
    /stage === 'closed'/.test(clientSrc) && /stage === 'setup'/.test(clientSrc)],
  ['点按钮进设置，不直接进面板',
    /onClick: \(\) => setStage\('setup'\)/.test(clientSrc)],
  ['配置通过 props 传给面板', /props\.config \|\| DEFAULT_CONFIG/.test(clientSrc)],
  ['换配置会 remount 面板（清空对话）', /key: configKey\(/.test(clientSrc)],
  ['风格进了 brief（会发给主机）', /面试官风格：' \+ config\.voice/.test(clientSrc)],
];
for (const [label, ok] of flowChecks) {
  if (!ok) problems.push('设置流程缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// 旧结构不该有残留，否则会同时存在两套配置入口
for (const stale of ['h(Selectors', 'setOpen(', 'setDomain', 'onReset']) {
  if (clientSrc.includes(stale)) {
    problems.push('还有旧结构残留：' + stale + '（会出现两套配置入口）');
  }
}

// ---------------------------------------------------------------- 7b. 面试状态机
//
// 这一组是 2026-09-20 那场模拟面试之后加的回归断言。
//
// 那场面试官问出了全场最好的一个问题（自己算出 7×120ms 给不出 P99 2.4s 并抓住矛盾），
// 但在**同一个话题上追了 5 轮**，而 SOP 只允许 2 轮。代价是它没余力接别的话题，
// 放掉了一段教科书级的含糊回答（"JVM 调过一些参数，后来就好了"）。
//
// 根因不是提示词，是**架构**：无状态设计每轮都要从零推导"该问什么"，
// 而最近上下文里最抢眼的就是"他刚才没回答我"，于是它一直拉那根线。
//
// 修法是给面试官一个显式的工作记忆（lib/state.js）。下面钉住三件事：
//   1. 状态真的在流转（不是写了个没人调的函数）
//   2. 状态块真的拼进了系统提示词
//   3. 状态条真的能渲染，并且到上限时会报警

console.log('\n--- 面试状态机 ---');

const stateSrc = existsSync(join(HERE, 'lib/state.js')) ? read('lib/state.js') : '';
if (stateSrc.length === 0) problems.push('lib/state.js 不存在 —— 状态机没落地');

const stateWiring = [
  ['主机侧 import 了 state.js', /from\s+'\.\/state\.js'/.test(host)],
  ['提示词侧 import 了 state.js', /from\s+'\.\/state\.js'/.test(promptSrc)],
  ['系统提示词挂了状态标记协议', /stateProtocolBlock\(state\)/.test(promptSrc)],
  ['每轮把状态拼进 system', /buildStateBlock\(state\)/.test(promptSrc)],
  ['从回复里摘出标记（候选人看不到）', /splitState\(attempt\.text\)/.test(host)],
  ['状态增量合并回状态', /mergeState\(state,\s*delta\)/.test(host)],
  ['响应体里回传 state（面板要接着传）', /state:\s*nextState/.test(host)],
  ['计数由状态机做，不由模型报', /next\.turnsOnTopic = state\.turnsOnTopic \+ 1/.test(stateSrc)],
  ['同一话题上限是 2 次', /MAX_ASKS_PER_TOPIC = 2/.test(stateSrc)],
  ['缺标记时不整轮失败（返回 null 让人兜底）', /delta: null, hadState: false/.test(stateSrc)],
  ['★ 到上限时点名下一个话题', /本轮换到下一个话题：/.test(stateSrc)],
  ['★ 没标记时会乐观前进（模型不配合也不能卡死）', /乐观前进/.test(stateSrc)],
  ['★ 前进后计数归 0（新话题从下一轮算第 1 问）', /next\.turnsOnTopic = 0;/.test(stateSrc)],
  ['计划聊完时不再无限刷"必须换话题"', /next\.turnsOnTopic = state\.turnsOnTopic;/.test(stateSrc)],
  ['计划要不到就装兜底骨架',
    /PLAN_ASK_LIMIT/.test(stateSrc) && /fallbackPlan/.test(stateSrc)],
  ['计划只认第一次，不被后续覆盖', /next\.plan\.length === 0 && hasDelta/.test(stateSrc)],
];
for (const [label, ok] of stateWiring) {
  if (!ok) problems.push('状态机接线缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// client 侧：状态必须真的在面板和主机之间跑一个来回
const stateClient = [
  ['面板持有面试状态', /const \[istate, setIstate\] = React\.useState\(null\)/.test(clientSrc)],
  ['每轮把状态回传主机', /state:\s*istate/.test(clientSrc)],
  ['收下主机返回的新状态', /setIstate\(data\.state\)/.test(clientSrc)],
  ['面板上有状态条', /stateStrip\(istate, clock\)/.test(clientSrc)],
];
for (const [label, ok] of stateClient) {
  if (!ok) problems.push('状态回传缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// 状态条真的能渲染 —— 拿三份 state 直接调它。
// 这是"我看不到界面"的替代方案：至少证明它不抛错、且把关键信号显示出来了。
if (mod && mod.__internals && typeof mod.__internals.stateStrip === 'function') {
  const strip = mod.__internals.stateStrip;
  // ⚠ 这里要能处理嵌套数组：插件里写的是 h('div', {…}, [子节点…])，
  // 而 createElement 桩收了 rest 参数，children 会是 [[…]]。第一版漏了这个，
  // 结果四个用例全部拿到空串 —— 看着像插件坏了，其实是取值函数没写对。
  const flat = (node) => {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(flat).join(' ');
    return [].concat(node.children || []).map(flat).join(' ');
  };

  const cases = [
    ['第一轮还没回来时不占位', strip(null, Date.now()), (t) => t === ''],
    ['正常一轮显示话题和次数',
      strip({ startedAt: Date.now() - 60000, budgetMin: 45, plan: [{ topic: 'A' }, { topic: 'B' }],
        topic: '订单链路', turnsOnTopic: 1, done: [] }, Date.now()),
      (t) => t.includes('订单链路') && t.includes('第 1 问') && t.includes('已用 1 / 45')],
    ['★ 追满时点名要换到下一个话题',
      strip({ startedAt: Date.now() - 60000, budgetMin: 45, plan: [{ topic: '订单链路' }, { topic: '缓存一致性' }],
        topic: '订单链路', turnsOnTopic: 2, done: [] }, Date.now()),
      (t) => t.includes('已追满') && t.includes('缓存一致性')],
    ['★ 乐观前进后计数为 0 时显示「即将开始」（不能显示第 0 问）',
      strip({ startedAt: Date.now() - 60000, budgetMin: 45, plan: [{ topic: 'A' }, { topic: 'B' }],
        topic: 'B', turnsOnTopic: 0, done: ['A'] }, Date.now()),
      (t) => t.includes('即将开始') && !t.includes('第 0 问')],
    ['计划聊完时点名反问环节',
      strip({ startedAt: Date.now() - 60000, budgetMin: 45, plan: [{ topic: 'A' }],
        topic: 'A', turnsOnTopic: 2, done: ['A'] }, Date.now()),
      (t) => t.includes('已追满') && t.includes('反问环节')],
    ['★ 计划外的话题不计入计划进度（否则会显示「计划 5 / 4」）',
      strip({ startedAt: Date.now() - 60000, budgetMin: 45, plan: [{ topic: 'A' }, { topic: 'B' }],
        topic: 'B', turnsOnTopic: 1, done: ['开场准备', 'A'] }, Date.now()),
      (t) => t.includes('计划 1 / 2')],
    ['时间快到时提醒进反问',
      strip({ startedAt: Date.now() - 42 * 60000, budgetMin: 45, plan: [{ topic: 'A' }],
        topic: 'A', turnsOnTopic: 1, done: [] }, Date.now()),
      (t) => t.includes('反问')],
  ];
  for (const [label, node, expect] of cases) {
    let text = '';
    let threw = null;
    try { text = flat(node); } catch (e) { threw = e; }
    const ok = threw === null && expect(text);
    if (!ok) problems.push('状态条渲染不对：' + label + (threw ? '（抛错 ' + threw.message + '）' : '（得到 "' + text + '"）'));
    console.log('  %s 状态条：%s', ok ? '✓' : '✗', label);
  }
} else {
  problems.push('client.js 没有导出 __internals.stateStrip，状态条无法被验证');
}

// ---------------------------------------------------------------- 8. 自包含
//
// 这一组是为了"发布"加的，是这个插件从"本机能跑"变成"别人能用"的分界线。
//
// 原来 SOP 只住在 `~/.dsh/skills/interviewer/`，lib/prompt.js 按那个绝对路径读。
// 作者本机有那个目录，所以一切正常 —— 但**别人装了插件没有那个目录**，
// 读不到就静默降级到短版 FALLBACK_SOP：面试官质量掉一档，而且不报错，
// 装的人只会觉得"这插件不好用"，查不到原因。
//
// 所以下面钉死两件事：
//   1. SOP 真的在包里（skills/interviewer/），且默认就读包内那份
//   2. 包真的会被分发（package.json 的 files / exports 没漏掉 skills）
//
// 这类 bug 的可怕之处在于**本机永远复现不了**，只能靠断言。

console.log('\n--- 自包含（发布前必查）---');

const pkgForFiles = JSON.parse(read('package.json'));
const skillMod = await import('./lib/skill.js').catch((err) => {
  problems.push('import lib/skill.js 失败：' + err.message);
  return null;
});

if (skillMod) {
  const bundledDir = skillMod.interviewerSkillDir();
  const relBundled = bundledDir.replace(HERE, '').replace(/^[\\/]/, '').replace(/\\/g, '/');

  console.log('  · 包内技能目录 %s', relBundled);

  const selfChecks = [
    ['包内有 SKILL.md', existsSync(join(bundledDir, 'SKILL.md'))],
    ['包内 5 份 SOP 全在', promptMod
      ? promptMod.DEFAULT_SOP_FILES.every((f) => existsSync(join(bundledDir, f)))
      : false],
    ['默认读的就是包内那份', promptMod ? promptMod.resolveSopDir({}) === bundledDir : false],
    ['显式 sopDir 能覆盖包内', promptMod ? promptMod.resolveSopDir({ sopDir: 'X:/tmp' }) === 'X:/tmp' : false],
    ['frontmatter 解析出 name', skillMod.parseSkillFile(read('skills/interviewer/SKILL.md')).name === 'interviewer'],
    ['frontmatter 解析出 description',
      skillMod.parseSkillFile(read('skills/interviewer/SKILL.md')).description.length > 40],
    ['注册用 resourceBase 指向包内目录',
      /resourceBase:\s*\{\s*kind:\s*'directory'/.test(read('lib/skill.js'))],
  ];
  for (const [label, ok] of selfChecks) {
    if (!ok) problems.push('自包含缺少：' + label);
    console.log('  %s %s', ok ? '✓' : '✗', label);
  }

  // 包会被真的分发出去吗 —— files 漏了 skills 的话，npm/打包会把 SOP 丢掉
  const distChecks = [
    ['package.json files 含 skills', (pkgForFiles.files || []).includes('skills')],
    ['package.json files 含 LICENSE', (pkgForFiles.files || []).includes('LICENSE')],
    ['exports 暴露 ./skills/*', Boolean(pkgForFiles.exports && pkgForFiles.exports['./skills/*'])],
    ['LICENSE 文件真的存在', existsSync(join(HERE, 'LICENSE'))],
    ['repository 字段已填（市场靠它识别仓库）',
      Boolean(pkgForFiles.repository && /github\.com/.test(pkgForFiles.repository.url || ''))],
    ['keywords 含 dsh-plugin', (pkgForFiles.keywords || []).includes('dsh-plugin')],
  ];
  for (const [label, ok] of distChecks) {
    if (!ok) problems.push('分发包缺少：' + label);
    console.log('  %s %s', ok ? '✓' : '✗', label);
  }

  // ---- 发布一致性：README 的安装命令 vs package.json 的仓库地址 ----
  //
  // 这条是踩出来的：仓库实际在 ufiredong/dsh-interviewer，而 README 和 package.json
  // 里先写成了 ufire/dsh-interviewer。**本机怎么测都是好的** —— 本地装插件走的是目录路径，
  // 根本不经过 GitHub。但市场是从 README 抓安装命令给别人的，owner 写错那条命令直接 404，
  // 而且装的人只会看到一句 "repository not found"，不知道是作者笔误。
  // 这类错只有发出去才会暴露，所以在这里对一下。
  const installOwner = (() => {
    const m = /add\s+github:([^\s`'"]+)/.exec(read('README.md'));
    return m ? m[1].replace(/\.git$/, '') : null;
  })();
  const repoOwner = (() => {
    const url = (pkgForFiles.repository || {}).url || '';
    const m = /github\.com\/([^/\s]+\/[^/\s#]+?)(?:\.git)?(?:#|$)/.exec(url);
    return m ? m[1] : null;
  })();

  const consistencyChecks = [
    ['README 里有 github: 形式的安装命令', installOwner !== null],
    ['package.json 的 repository 指向 GitHub', repoOwner !== null],
    ['★ 两处的 owner/repo 一致（不一致别人装不上）',
      installOwner !== null && installOwner === repoOwner],
  ];
  for (const [label, ok] of consistencyChecks) {
    if (!ok) {
      problems.push('发布一致性：' + label
        + '（README 安装命令 = ' + installOwner + '；package.json = ' + repoOwner + '）');
    }
    console.log('  %s %s', ok ? '✓' : '✗', label);
  }
  console.log('  · README 安装命令   github:%s', installOwner);
  console.log('  · package.json 仓库  %s', repoOwner);

  // ---- README 引用的本地图片必须真的存在 ----
  //
  // 同一个道理：路径写错在本机毫无征兆，推到 GitHub 上就是一张破图，
  // 而且只有点开仓库的人会看到 —— alt 文本写得再好也白写，那里只有个裂图标。
  const imgRefs = [...read('README.md').matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)]
    .map((m) => m[1])
    .filter((p) => !/^https?:/i.test(p));
  if (imgRefs.length === 0) {
    console.log('  · README 没有引用本地图片');
  }
  for (const rel of imgRefs) {
    const ok = existsSync(join(HERE, rel));
    if (!ok) problems.push('README 引用了不存在的图片：' + rel);
    console.log('  %s README 图片 %s', ok ? '✓' : '✗', rel);
  }

  // 技能真的能注册进 DSH 吗 —— 用桩 ctx 跑一遍 registerInterviewerSkill
  let registered = null;
  try {
    const disposer = skillMod.registerInterviewerSkill({
      skills: { register: (s) => { registered = s; return () => {}; } },
    });
    if (typeof disposer !== 'function') problems.push('技能注册没有返回 disposer');
  } catch (err) {
    problems.push('技能注册抛错：' + err.message);
  }
  const regChecks = [
    ['注册了名为 interviewer 的技能', registered !== null && registered.name === 'interviewer'],
    ['带了描述（DSH 技能列表要用）', registered !== null && registered.description.length > 40],
    ['带了正文（去掉 frontmatter）', registered !== null && !registered.content.startsWith('---')],
    ['source 标为 runtime', registered !== null && registered.source === 'runtime'],
  ];
  for (const [label, ok] of regChecks) {
    if (!ok) problems.push('技能注册缺少：' + label);
    console.log('  %s %s', ok ? '✓' : '✗', label);
  }
}

// 主机侧要声明 skills 服务，否则 ctx.skills 拿不到（cordis 会直接抛）
const skillWiring = [
  ["inject 声明了 'skills'", /inject\s*=\s*\[[^\]]*'skills'/.test(host)],
  ['apply 里调用了技能注册', /registerInterviewerSkill\(ctx\)/.test(host)],
  ['技能注册失败只告警不弄崩宿主',
    /try\s*\{[\s\S]{0,200}?registerInterviewerSkill\(ctx\)[\s\S]{0,300}?catch/.test(host)],
  ['启动日志打印实际 SOP 目录（装完不好用时能排查）', /SOP 目录=/.test(host)],
];
for (const [label, ok] of skillWiring) {
  if (!ok) problems.push('技能接线缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// ---------------------------------------------------------------- 9. 单轮健壮性
//
// maxTokens 这件事踩过坑：**推理 token 也计入 maxTokens**，而模型的思考长度波动极大。
// 同一段对话同一个额度，有时 3 秒答完，有时思考 14 秒一个字没吐直接 max-tokens。
// 面板那边就出现一个断掉的话轮 —— 真实面试官不会因为他想久了就失声。
// 所以必须有"没产出就翻倍重试一次"。

console.log('\n--- 单轮健壮性 ---');

const retryChecks = [
  ['抽出了 runTurn（能重试的前提）', /async function runTurn\(/.test(host)],
  ['空产出才重试（半句话不重试）', /const retryWorthy = attempt\.text\.trim\(\)\.length === 0/.test(host)],
  ['重试时额度翻倍', /Math\.min\(MAX_TOKEN_CEILING, maxTokens \* 2\)/.test(host)],
  ['有额度上限常量', /const MAX_TOKEN_CEILING = \d+/.test(host)],
  ['重试时追加"别想了直接说"', /RETRY_NUDGE/.test(host)],
  ['响应里带 retried 标记', /retried: attempt\.retried === true/.test(host)],
  ['面板提示词额度不低于 1600', /maxTokens:\s*(1[6-9]\d\d|[2-9]\d\d\d)/.test(clientSrc)],
];
for (const [label, ok] of retryChecks) {
  if (!ok) problems.push('单轮健壮性缺少：' + label);
  console.log('  %s %s', ok ? '✓' : '✗', label);
}

// ---------------------------------------------------------------- 结论

if (problems.length) {
  console.error('\n✗ 检查未通过：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log('\n✓ 全部检查通过');
console.log('  下一步：dsh plugin --profile web add %s，然后重启 dsh web', HERE);
