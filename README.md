# dsh-self-review — 隐式自检

> **English summary.** Holds the model's final answer before it reaches the browser, sends it to one
> independent, minimal-context model call for a second pass, and releases only the verified text —
> the draft is never shown. The review request carries the question, the draft and (optionally) a
> short digest of this turn's tool calls; the main conversation is not replayed. Any failure, timeout
> or unexpected reviewer output releases the draft unchanged. Costs one extra model request per
> reviewed answer and a few seconds before the text appears. Verified only against dsh `0.2.1-rc.2`
> (`engines.dsh` pins it).

把模型的**最终回答先扣住**，交给一次独立的二次调用复核，只把校验后的文本送到前端。
用户看不到草稿，也不需要把「问题 + 回答」重新塞回主上下文。

- 安装：`dsh plugin --profile web add dsh-self-review`，然后刷新页面。
- 卸载：`dsh plugin --profile web remove dsh-self-review`。
- 依赖：唯一运行时依赖 `@deepseek-ai/schemastery`（纯 JS、无构建步骤，安装不需要构建授权）；

## 兼容性（重要）

`package.json` 里 `engines.dsh` 是 **`=0.2.1-rc.2`**，也就是只在当前这个 dsh 版本上测过：

- 版本不满足时，`plugin_manager` **拒绝安装**并给出明确提示；
- 已经装了但 dsh 升级了，启动时该 bundle 会被**跳过**（其余插件照常启动），插件表现为“消失”；
- 市场卡片会显示不兼容。

在别的 dsh 版本上实测通过后再放宽，改法见 [PUBLISHING.md](PUBLISHING.md#4-版本限制怎么维护)。
放宽前请重跑 `node test.mjs`、`node test-client.mjs`，并人工确认「自检中」提示仍出现。

## 隐私与成本

- **隐私**：复核请求会把你这次的问题、模型草稿、以及最多 `digestChars` 个字符的工具调用摘要
  发给**同一个模型服务商**（或 `reviewModel` 指定的那个）。它和正常对话走同一条链路，
  但也确实是把“回答正文”又发了一次。不想这样就把 `enabled` 关掉。
- **成本**：每条被复核的回答多一次模型请求。输入 ≈ 问题 + 回答 + 证据摘要；输出在“没问题”时
  只有十几 token，真发现缺陷时才 ≈ 回答长度（要求复核模型给出完整修正稿）。
- **延迟**：最终回答在复核结束前不显示，通常多 2～12 秒；推理过程仍然实时流式。
- **状态路由**：`GET /dsh-self-review/state` 只返回 `{reviewing, startedAt, draftChars}`，
  仅接受本机回环 + 同源请求，不包含任何回答正文。

## 为什么不是 `agent/turn-stopping`

网上（包括豆包给的方案）常见的说法是监听 `agent/turn-stopping` 并改写 `turn.modelOutput`。
在 DSH 里这两个东西都不存在：

- `agent/turn-stopping` 的载荷只有 `{ agent, turn, signal }`，**拿不到本轮草稿**，也没有 `modelOutput` 字段；
- 它触发时本轮 `assistant/message` 已经提交并通过 `agent/assistant-stream` 实时推给了前端，改不动已经显示的内容。

真正能在「送达之前」截住字节的是 **`llm/stream` 瀑布**：模型流式调用的每一个 chunk 都要经过它，
而消费者（agent-loop / Web UI）只看到经过它之后的流。本插件就在这一层缓冲文本。

## 工作方式

```
模型流 ──► llm/stream 瀑布（本插件）
              │  reasoning / tool-call / 其它块：直接放行
              │  text 块：扣住
              ├─ 出现 tool-call ──► 立刻放行已扣文本，本步转为透传（不是最终回答）
              └─ finish=stop ────► 二次调用复核
                                     ├ ok   ──► 放行原草稿
                                     └ fix  ──► 放行修正稿（草稿从未发出）
```

- **判定为最终回答**：`finish.reason = stop`、没有 tool-call、只有一个文本块、长度在
  `minChars`～`maxChars` 之间。工具步骤在第一个 `tool-call-delta` 到达时就解冻，不额外等待。
- **复核上下文最小**：只发「用户请求 + 草稿 + 可选工具证据」，不发主会话的完整历史、系统提示或
  reasoning。这正是省 token 的关键：草稿不重生成，只被扣住；复核的输入约等于「问题 + 回答」。
- **只修不重写**：复核模型只在能指出具体缺陷时返回 `fix`，并要求保持原结构、措辞与细节；
  拿不准时返回 `ok`。任何异常、超时、协议不符都按 `ok` 处理（fail-open），草稿原样放行。
- **不会递归**：复核调用是手工构造的请求，没有 `sessionId`/`toolHistory`，插件的过滤器直接放行。

## 界面提示（自检中）

Host 半维护一张「当前被扣住的会话」表，并注册上面那条只读状态路由。

Client 半（[client.js](client.js)）注册在 `conversation.input.activity`（输入框工具行、模型选择器右侧），
在会话 `running` 期间每 350ms 轮询一次；一旦 Host 说正在复核，就显示一个旋转环 +「自检中」，
复核结束、回答放出后自动消失。会话不运行时完全不轮询。

## 配置

九个字段声明在插件的 schemastery `Config` 里：Host 校验配置、填默认值，并把它投影成可编辑的
表单数据。**表单本身由本包的客户端卡片渲染**（`plugins.row.config`，key
`dsh-self-review#self-review`，基于 `@deepseek-ai/dsh-client-ui-primitives` 的
`SettingsFormModel` / `SettingsForm` / `SettingsValueField`）——DSH 不提供 schema 直出表单的渲染器。

入口是两层：**Plugins 页 → `dsh-self-review` 包 → 它下面的 `self-review` 子组件 → 配置**。
（插件以 bundle 形式安装，bundle 里有一个同名 row；设置表单挂在 row 上，所以要多点一层。）
每个字段都是 `volatile`，因此：

- 改动写进 profile 的 `cordis.patch.yml`；
- **立即生效，不重启插件，也不打断正在被扣住的回答**；
- 默认值只存在于 schema 一处（包的 `cordis.patch.yml` 不再复制一份配置）。

字段标签跟随界面语言（中/英）；Host 投影的 schema 描述只有英文。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `minChars` | `120` | 短于此的回答不复核 |
| `maxChars` | `30000` | 长于此的回答原样放行（整段重写不可靠） |
| `reviewModel` | `''` | `"provider/model"`；空 = 与回答同路由 |
| `digestChars` | `4000` | 工具调用证据的字符预算，`0` 关闭 |
| `timeoutMs` | `60000` | 复核超时，超时放行草稿 |
| `subagents` | `false` | 是否也复核子代理的最终回答 |
| `debug` | `false` | 每次复核写一行 JSON 日志 |
| `debugFile` | 系统临时目录 `dsh-self-review.log` | 日志路径 |

没有表单的宿主（headless 等）照样读取同一份 schema，只是改配置要手写 profile patch。

## 代价与限制

- **没有逐字流式**：最终回答在复核结束前不显示。推理块仍然实时显示，所以观感是
  「思考 → 停顿几秒 → 整段回答」。这是「用户看不到草稿」的必然代价。
- **复核只做文本层面**：算术、逻辑、自相矛盾、忽略约束、编造事实这类错误命中率最高；
  需要跑代码/查外部资料才能确认的错误，它只能提出怀疑。
- **可能过度修正**：复核模型仍可能把对的改错。`verdict=fix` 才会替换，且提示词要求最小改动；
  如果观察到退化，把 `reviewModel` 换强一点，或调高 `minChars` 只复核长回答。
- **仍然在决策尾部**：它只能校验“已经生成的最终文本 + 工具证据”，撤不回链路中间已经发生的错误。

## 测试

以下脚本在仓库里，**不在 npm 包内**（`files` 只打包运行所需文件）：

```powershell
# 协议级单测（不需要模型）
node test.mjs

# 客户端半注册冒烟测试（不需要浏览器）
node test-client.mjs

# 真实模型端到端：在 headless 测试 profile 里跑
dsh plugin --profile headless add .
dsh headless --patch ./test-llm-patch.yml "解释一下哈希表"
Get-Content "$env:TEMP\dsh-self-review.log"
```

`test-llm-patch.yml` 只是临时覆盖层：重新启用 headless 里默认关闭的凭据服务、插入本插件。

## 发布

仓库根目录的 `PUBLISHING.md`（发布与市场收录步骤）和 `market-entry.yml`（条目模板）同样不随
npm 包分发。
