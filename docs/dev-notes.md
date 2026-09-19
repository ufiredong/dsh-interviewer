# 开发笔记

面向想改这个插件的人（包括我自己）。用户文档看 [`../README.md`](../README.md)。

---

## README 开头为什么是散文，不是列表

DSH 市场抓 **README 前约 1200 字符**做卡片简介（数据里的 `readmeSummary` 字段）。
校准依据：`dsh-deepresearch` 的 `readmeSummary` 实际长度 1174 字符，`ruflo` 是 1201。

问题在于，那段摘要是**把 markdown 压平成一行**再存的。所以：

- 引用块 `>` 会剩一个光秃秃的 `>` 挂在句子里
- 列表会剩下 `- `，而且多项挤在同一行
- 表格会变成一堆 `| --- |`

翻市场里那些写得好的插件（`dsh-save-money`、`dsh-force-compact`、`dsh-design-qa`、
`dsh-resume-expert`），开头**清一色是连续散文**，没有一个用列表。这不是巧合。

所以这个 README 的头两段是散文，把「是什么 + 给谁用 + 凭什么是它」用连续的句子说完；
徽章紧跟标题（即使压平，核心句也很快出现）；列表和表格一律排在后面。

**改 README 时请保住这个约束。** 想让开头加一条信息，就把它写进那两段散文里，
不要加列表项。改完跑一下：

```bash
node docs/readme-preview.mjs
```

它会把压平后的效果打出来，并断言开头 500 字符里没有列表/引用/表格符号。

---

## 崩溃复盘（2026-09-19）

### 发生了什么

装完插件重启之后，`dsh web` 崩了。

### 能证明的

| 事实 | 证据 |
|---|---|
| **插件代码不是直接原因** | 崩溃后重启，`GET /interviewer/api/health` 返回 200，模型路由、provider、SOP 全部正常 |
| **本次崩溃没写启动失败日志** | `~/.dsh/dsh-safe/last-failure-web.log` 仍是 9/17 的，说明大概率不是启动阶段失败 |
| **同一类错误两天前就发生过** | 9/17 的日志是 `Mismatched native Koffi modules`，`dsh-subprocess-local` 和 `dsh-sandbox-local` 两个条目加载失败 —— **那时这个插件根本还不存在** |
| **`@deepseek-ai/dsh-llm` 的 peer 解析成立** | health 路由正常返回，说明主机侧的 import 成功了 |

### 推断的（没坐实）

`dsh plugin add` 会在 profile 目录里**跑一次 pnpm install**。这个动作会动 `node_modules`，
而这个 DSH 安装用的是**自定义原生插件加载器**（`node-addon-require-builtin` /
`@deepseek-ai/node-addon-system`）。原生模块被扰动后，下次启动就可能报
`Mismatched native Koffi modules`。

也就是说：**触发动作是安装指令，但崩的不是插件代码。** 这是机器层面的老问题，
9/17 已经发生过一次。

### 当时做错的三件事

1. **改了两次 `package.json`，导致装了两次插件。** 第一次装完才想到要加
   `peerDependencies`。每多跑一次 `dsh plugin add`，就多一次扰动 `node_modules` 的机会。
   **正确做法是 `package.json` 定稿之后再装。**
2. **拿正在用的 `web` profile 当试验田。** 应该一开始就建一个一次性 profile 测插件，
   成了再装进 `web`。
3. **没有在最开始就备份 profile。** 出事之后才补，为时已晚。

### 以后怎么避免

**装之前先备份**（用仓库里的 `safe-plugin.ps1`）：

```powershell
.\safe-plugin.ps1 install D:\ai\dsh-interviewer   # 自动先备份再装
.\safe-plugin.ps1 restore                         # 出事一条命令回滚
.\safe-plugin.ps1 status                          # 看当前 bundles 和备份
```

**认准这个失败签名** —— 看到它就知道不是插件的问题：

```
Error: Mismatched native Koffi modules
  failed to import loader entry subprocess (@deepseek-ai/dsh-subprocess-local)
  failed to import loader entry sandbox    (@deepseek-ai/dsh-sandbox-local)
```

这时**不要删插件**（删了也没用），走官方退路：

```powershell
dsh --profile rescue --from-default-profile web
```

**改动前想清楚**：`dsh plugin add` / `remove` 都会跑 pnpm install。如果只是改插件代码，
根本不需要重装 —— `lib/client.js` 改完刷新浏览器就可能生效，`lib/index.js` 改了重启就行。
**只有改 `package.json` 的依赖声明才需要重装。**

### 给救援脚本的一个教训

`safe-plugin.ps1` 第一版写了中文输出，结果 **PowerShell 按本地代码页读无 BOM 的
UTF-8 文件，中文全变乱码，乱码字节把字符串引号搞断，脚本直接解析失败**。

出故障时才用的脚本，不该依赖控制台代码页。**已改成纯 ASCII。**

---

## 主机侧为什么只能静态检查（一小部分）

`lib/index.js` import 的 `@deepseek-ai/dsh-llm` 在纯 Node 下是 `MODULE_NOT_FOUND` ——
那个包不在依赖树里，是 DSH 的 loader 用自己的解析器提供的（**所以它必须写在
`peerDependencies` 里**）。要真验主机侧只有两条路：

1. 用 Node 的 loader hook 把那个模块替换成桩
2. 起一个 DSH 实例打 `/interviewer/api/health`

所以离线自检对主机侧做静态检查 + 把不依赖 DSH 的部分（`prompt.js` / `state.js` /
`skill.js`）真的 import 进来跑断言。

---

## 模型是怎么接上的

**不碰密钥，不自己发 HTTP 请求。** 主机侧直接注入 DSH 已经配好的服务：

```js
export const inject = ['llm', 'webServer', 'skills'];

// 模型路由从 agentDefaultModel 读，也就是 settings.yaml 里的
// agent-default-model 那一段
const sel = ctx.agentDefaultModel.currentSelection();   // { provider, model }

const assembler = new BlockAssembler();
for await (const chunk of ctx.llm.stream({ provider, model, messages, system, maxTokens })) {
  assembler.push(chunk);
}
const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('');
```

---

## 提示词的一块伤疤：不要让模型去找文件

第一版系统提示词只内联了 `SKILL.md`，而 SOP 里写满了「见 `references/01-rounds.md`」。
模型于是**试图调用工具去找那些文件**，第一条回复是：

```
<｜DSML｜> calls> <｜DSML｜> invoke name="Bash">
  find / -name "SKILL.md" -path "*interviewer*"
```

面板里没有任何工具，工具调用语法就直接当纯文本漏了出来，第二轮 `max-tokens` 挂掉。

根因：**提示词引用了不在提示词里的文件**。

所以现在两件事都做了：

1. `ENV_PREAMBLE` 在最前面声明「你没有文件系统访问权限，也没有任何工具可以调用」
2. `DEFAULT_SOP_FILES` 把被引用的 `references/*.md` 全部内联

省 token 不能省到这个地步。这个 bug 逻辑检查抓不到、语法检查抓不到、渲染冒烟也抓不到，
只有真跑才暴露 —— 所以 `dev-check.mjs` 里钉了对应的回归断言。

---

## 面试状态机的调参记录

`MAX_ASKS_PER_TOPIC = 2` 是 SOP 的规定，不是拍的。调它之前先看
`interview-sim/state-run.mjs` 的实测结果，那是一个可重复的行为回归。

`PLAN_ASK_LIMIT = 2` 的推导：广度机制（点名换话题）依赖计划里有「下一个话题」。
最早会用到计划是在第一个话题追满 2 次时，也就是第 3 轮。所以定 2，
保证第 3 轮之前计划一定就位。

标记命中率实测约 50%（`probe-protocol2.mjs` / `probe-protocol3.mjs`，各 5 样本）。
样本量不大，结论只到「换措辞和挪位置都救不回来」这一层 —— 所以设计上直接不依赖它。
