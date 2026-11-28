# 在对话里切换模型（T-59 第二部分）设计说明

目标：用户可以直接在聊天里说「把主模型换成 X」「加一个 Y 作为备用」「去掉 Opus 备用」「回滚刚才的模型修改」，不用打开设置页。
这份说明先于实现提交，实现见同一 PR 的下一个 commit。

## 1. 改的是什么

改的是 **RokBot 平台自己的模型路由配置**，和管理后台「模型服务」页、`scenarioRoutes` 用的是同一份存储，**不是 Magpie 网关**。

- 存储：`ROKBOT_MODEL_ENV`（镜像内 `/data/model.env`）里的 `ROKBOT_MODEL_ROUTING` JSON。
  读写入口是 `host/server/models.mjs` 的 `Models`（`current()` / `save()`），校验用 `host/runtime/model-routing.mjs` 的 `validateModelRouting`。
  runtime 启动时用 `host/runtime/config.mjs` 的 `loadModelConfig()` 读进 `modelConfig.modelRouting`，再由 `host-extensions.mjs` 的 `createInference` 在每次新建会话时取路由（`modelRouteForAgent` / `modelRouteForScenario`）。
- 对话里能改的范围（刻意收窄）：
  - 只改**当前 Bot 实际生效的对话路由**：这个 Bot 有 `botRoutes[agentId]` 就改它，否则改 `defaultRoute`。卡片上写明是哪一个。
  - 只能改**主 profile** 和**备用链**（`fallbacks`，增、删、整体替换）。
  - 只能在**已经配置好的 profile** 之间选。不能在对话里新增 provider、填 URL 或 API Key，也不能改 `scenarioRoutes`、`adaptiveRouting`、上下文或 effort 设置。
  - 开着自适应路由（`adaptiveRouting.enabled`）或还是旧版单模型配置时，直接拒绝，引导到设置页。
- 写入走现成的 `Models.save()`，校验、写文件、写 `model-reload-request.json` 都和设置页保存完全一样。

## 2. 权限模型

原则：**发起**和**生效**是两道独立的门，都在代码里判断，不依赖提示词自律。

### 2.1 发起门（工具 `ProposeModelChange`，只会生成确认卡片）

工具在下面任一条件不满足时直接拒绝，不生成卡片：

1. **当前运行是用户本人发起的可见回合。** `createRunnerForSession` 包一层 `runner.run`，用 `AsyncLocalStorage` 记下本次运行的来源。要求：
   - `options.hidden !== true`；
   - `options.requestSource === 'turn'`，也就是用户发消息。automation、event、agent 消息、后台唤醒、表单回执、group 成员回合都不算；
   - 不是 group 回合（`groupTurn` 为空），也不是 `inAutomationRun`；
   - 工具调用发生在这个运行的异步上下文里。上下文丢了就当作不满足。
2. **这句话是客户端发来的。** 运行开始时，transcript 里最新的用户消息必须带 `clientNonce`（只有客户端经 `/api/sendPrompt` 发消息才会带），而且它的内容就是这次运行的 prompt。Host 内部的 `sendPrompt` 调用（比如资源删除卡片的回执摘要、往 group 代发）不带 `clientNonce`，会被拒绝。
3. **要动的每个模型，用户在这句话里亲口提到过。** 工具参数里每个名字（新主模型、要加的、要删的、整体替换里的每一项）都必须出现在第 2 条那条用户原文里（不区分大小写），并且能唯一解析到一个已配置的 profile（按 profile id、model id、profile 名匹配）。网页内容、工具结果或其他 Bot 的消息即使注入了「切到 evil-model」，只要用户没打出这个名字，就拒绝。回滚没有模型名，只受第 1、2 条约束。
4. **确认通道可用。** 拦截表单提交的钩子必须已经装好（见 2.2）。装不上就拒绝，并告诉用户去设置页改，绝不退化成「直接改」。

### 2.2 生效门（确认卡片 + 表单提交通道）

- 工具生成一张标准 `user-form` 卡片（和 `RequestUserForm` 同一种消息，`formRequestId` 是 Host 生成的一次性 nonce，`randomUUID`）。卡片标题和说明由 Host 根据解析好的改动生成，内容是改前和改后的主模型与备用链，不使用模型给的任何自由文本。卡片上有一个必勾的确认项。
- Host 在内存里登记这次提案 `nonce → { agentId, 作用范围, 改前路由, 改后路由, 过期时间 }`。nonce 不出现在工具结果里，模型看不到。
- **只有用户提交这张卡片才会生效。** 提交链路是客户端 `/api/submitUserForm` → 内核 `UserFormResponses.submitUserForm`。我们在 runtime 包住这个方法：transcript 条目的 `formRequestId` 命中登记的 nonce，就由我们处理，不进内核原来的「填进 box 浏览器」流程。生效前依次检查：
  - 提交的 `agentId` 和提案一致，条目属于该 Bot 的会话；
  - nonce 未使用、未过期（15 分钟），检查通过后立即作废，只能用一次；
  - 确认项的值为真；
  - 当前文件里的路由和提案里的「改前」完全一致，期间有人在设置页改过就拒绝，请用户重新发起。
- 关闭卡片（`dismissUserForm`）就作废提案，什么都不改。
- 模型的工具结果、Bot 发的任何文字、`RequestUserForm` 自己生成的卡片（它的 requestId 是另一个随机值）都无法满足这个条件。整个 runtime 里没有任何工具会调用 `submitUserForm`。

### 2.3 能做到严密的和做不到的

做到了（代码保证）：
- 非用户回合（hidden、automation、agent 消息、event、后台唤醒、表单回执、group）调用工具会被拒绝。
- 没有用户本人对这张卡片的提交，配置不会变。工具调用本身只生成卡片。
- 确认和那一次具体的改动绑定（一次性 nonce + 改前快照比对），不能重放，也不能套用到别的改动上。
- 对话里只能在已配置的 profile 之间切换，碰不到密钥、URL 和 provider。

做不到、或只做到部分：
- **同一个用户回合内部的来源。** 用户确实发了消息、也打出了模型名，但真正让模型决定调用工具的，可能是本回合里读到的网页或工具结果，甚至是这个回合派出的 subagent（它和主回合共享异步上下文）。第 3 条的「用户原文里有这个名字」和必须点卡片确认，是这里的缓解手段，不是证明。
- **「客户端发来」靠 `clientNonce` 判断。** 现有的 Host 内部调用都不带它。以后如果新增内部调用并转发了 nonce，这条判断就会失效。
- **持有配对设备凭据的人都能提交卡片。** Host 认的是设备凭据，不是具体某个人。客户端被攻破、或用户被诱导去点确认，都不在代码能防的范围内。卡片上明确写出改动内容，是这里唯一的防线。
- **和设置页同时保存的竞态。** 两个进程（管理服务和 Host runtime）都可能写 `model.env`。`Models.save` 的串行队列只在单个进程内有效。我们在写入前比对改前快照，把窗口缩到一次读写之间，但不是跨进程锁。

### 2.4 审计与回滚

- 每次生效都向 `<dataDir>/model-change-audit.jsonl` 追加一行：时间、agentId、动作（`change` / `rollback`）、作用范围（`default` 或 `bot`）、改前和改后的路由（只有 profile id、effort、顺序）以及对应的模型 ID 和 profile 名。
- **不记录**任何 API Key、baseUrl、token，也不记录 provider 对象。写入前从路由对象里只挑出白名单字段，测试会检查审计文件里没有密钥和 URL。
- **一键回滚**：用户说「回滚」，工具用 `action: "rollback"` 取这个作用范围最近一次生效记录的「改前」路由，同样生成确认卡片，点一次确认即可恢复。回滚本身也会写一条审计。只有当前路由等于那条记录的「改后」时才允许回滚，否则拒绝，以免覆盖之后在设置页做的修改。

## 3. 热加载

现有的保存路径**不是热加载**：`Models.save()` 写完 `model.env` 后写 `model-reload-request.json`，`host/deploy/host-supervisor.mjs` 等 Host 空闲（`isBusy === false`，再经 `/prepare-upgrade` 确认没有运行中的回合）后自动重启 Host 子进程。不需要人工重启，但确实会在空闲时重启一次进程。

本实现在此之外再加一层**进程内切换**：生效后立即把同一个 `modelConfig.modelRouting` 对象替换成新路由（`createInference` 每次新建会话都从这里读）。所以即使 Host 一直很忙、supervisor 还没轮到重启，下一轮对话也已经用新模型。
因为只在已有 profile 之间切换，provider 集合不变，`installHostNetworkBoundary` 的出网白名单不受影响。

仍然要等那次空闲重启才更新的：
- PR #16 的「Model configuration」身份说明。它在启动时由 `modelIdentityDirective(model)` 渲染进 base prompt，措辞不改，只是内容在重启前还是旧值。准确的当前值以 `CurrentModel` 为准，见第 5 节；
- auto-review 使用的全局主路由（`loadModelConfig` 的顶层 `model` / `baseUrl`）。

## 4. 当前回合不变，下一轮生效

- 用户点确认时，发起提案的那一轮已经结束：工具只生成卡片，回合随之结束。
- 正在进行的会话在创建时就固定了路由，进程内替换只影响之后新建的会话。所以「当前回合用旧模型，下一轮用新模型」由构造保证。
- 生效后 Host 在对话里发一条说明：改前和改后各是什么、从下一轮起生效、可以说「回滚」撤销。

## 5. 单一事实来源

新增 `createLiveModelRouting(config)`，包住 `createInference` 用的那个 `config` 对象，提供三个方法：
- `routing()`：当前路由，含密钥，只在 Host 内部使用；
- `summary(agentId)`：不含密钥的摘要（作用范围、主模型、备用链）；
- `replace(next)`：进程内替换。

它挂在 `inference` 扩展上（`inferenceExt.liveModelRouting`）。
- 第一部分的 `CurrentModel` 除了报告「实际应答的模型」（来自会话记录），现在还会报告「新回合将使用的配置路由」，数据来自 `summary(agentId)`；
- `ProposeModelChange` 的「改前」、确认后生效、`createInference` 选路由，三者读写的都是这一个对象。改完之后下一轮问 `CurrentModel` 得到的就是新路由。

## 6. 与 PR #24（fix/user-form-submit）的关系

PR #24 修的是「表单提交后，本地 1:1 Bot 没有被唤醒继续回合」（`wakeFormAuthor` 只唤醒群成员）。本设计**不依赖它**：
- 提交本身在 main 上就能到达 `UserFormResponses.submitUserForm`，PR #24 的说明里核对过这条链路，断点只在之后的唤醒；
- 我们在 `submitUserForm` 这一层拦截自己的卡片，直接生效，并由 Host 自己往对话里发结果说明，不需要唤醒 Bot 继续回合；
- PR #24 合并后，它包的是 `wakeFormAuthor`，而我们的卡片根本不会走到那里，两者不冲突。

保险起见：如果某个内核版本上 `submitUserForm` 钩子装不上，工具就拒绝发起（第 2.1 节第 4 条），不会退化成「不确认直接改」。这一点有测试覆盖。
