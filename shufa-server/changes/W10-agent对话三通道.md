# W10：agent 对话三通道——打断 / 排队 / 引导（对齐 DSH 内核）

日期：2026-09-27 ｜ 前序：W7b（前台续聊）｜ 类型：内核能力接线

## 1. 背景（Owner 需求 2026-09-27）

Owner 指令：围绕 DSH 内核改进 agent 对话支持——内核应支持打断会话、发送
消息到队列、发送消息到引导。**核实结论：三件全支持**（dsh-agent `Agent`
接口，node_modules 类型实证）：

- `cancel({kind:'user'}, {keepInbox:true})`——中止当前轮；keepInbox 保排队
  消息（cancel 后内核自动跑下一轮排队项）；`interruptedBlocks()` 把被打断
  的流安全收尾为前缀帧
- `followup(msg)`——运行中投递自动进 `next-turn` inbox（排队，本轮结束
  自动开下一轮）；idle 时直接开新轮
- `steer(msg)`——运行中的 driver 在下一 step 边界消费（影响当前轮）；
  idle 时等价开新轮
- 附赠：`inject(msg)`（不唤醒上下文注入）、`inbox`（排队可见性）、
  `whenIdle()`

接线现状与缺口：

| 能力 | 内核 | daemon | webui |
|---|---|---|---|
| 打断 | ✅ cancel | ⚠️ 仅 tasks.cancel（**终态取消**，cancelled 任务不可续聊） | ❌ 无停止按钮（api.cancelTask 零调用） |
| 排队 | ✅ followup 天然排队 | ✅ followup running 时排队投递 | ⚠️ 发送不禁但无排队反馈 |
| 引导 | ✅ steer | ❌ 未暴露 | ❌ 未暴露 |

关键语义区分：**打断 ≠ 取消任务**。打断=中止当前轮、任务回 done（idle
等待输入、可续聊）；取消=终态（既有 tasks.cancel 保持，管理面用）。

## 2. 范围

| 面 | 变更 |
|---|---|
| contracts tasks.ts | TaskFollowupInput + `mode: 'followup'\|'steer'`（缺省 followup）；新增 TaskStopInput/Output（TaskItem） |
| daemon sessions.ts | 新增 `steer(sessionId, text)`：live 投递 entry.agent.steer（消息构造与 followup 同构，createUserMessage + source user；/ 与 $ 分流不进 steer——面板语义属于整轮对话） |
| daemon tasks/service.ts | `stop()`：live cancel(keepInbox:true) + 任务置 done（error 清空）+ status 帧；对非 running 任务 no-op 返回现值。`followup(mode)`：steer 时改调 sessions.steer（复活逻辑共用） |
| daemon rpc.ts | tasksStop 端点 |
| webui api/stores | stopTask 封装；sendPrompt(mode) 透传；停止乐观置 done |
| webui ComposerCard | running 态按钮三态：空输入=停止（Square）；有输入=发送（Enter=排队）+ 引导按钮（Zap，点击=steer 发送）；非 running=原发送。running 发送成功 inline 提示「已排队，本轮结束后送达」/「已引导当前轮」 |

## 3. 验收

- [ ] running 时点停止：当前轮中止（turn-end cancelled 帧落下）、任务回
      done、输入框可立即续聊（followup 正常）；排队中的消息不被吞
      （keepInbox）
- [ ] running 时 Enter 发送：不报错、提示已排队；本轮 turn-end 后自动开
      下一轮消费排队消息
- [ ] running 时点引导：消息走 steer，agent 在下一步边界响应（不新开轮
      的排队气泡语义）
- [ ] cancelled（终态取消）行为不变：不可续聊、不可 stop
- [ ] daemon 测试全绿 + 新增 stop/steer 用例；svelte-check + build 全绿

## 4. 实施记录（2026-09-27）

### W10a 三通道（同日首轮）

- contracts：`TaskStopInput/Output`（打断=回 done 可续聊，区别于终态 cancel）；
  `TaskFollowupInput + mode: 'followup'|'steer'`
- sessions：`steer(sessionId, text)`（裸文本投递，/ 与 $ 分流不进 steer）；AgentLike
  收窄面 +steer/inject
- service：`stop()`（live cancel(keepInbox) + 任务回 done + status 帧；非 running
  幂等；cancelled 拒绝）；`followup(mode)` 分流（复活逻辑共用）
- rpc：`tasks.stop`
- webui：composer running 三态——空输入=停止（Square，红 hover）、有输入=
  发送（Enter=排队）+ 引导按钮（Zap，steer 发送）；通道反馈条（已排队/已引导，
  3s 自清）；store stopPrompt/sendPrompt(mode)

### W10b 队列面板（Owner 设计，同日二轮）

内核 inbox 读写面实证：`nextTurn/nextStep`（读）、`remove/replace/splice`
（改）——队列面板全部语义内核原生支持。

- contracts：TaskQueueMode（queue/steer/inject）+ 六端点
  （queueList/queueEdit/queueEditConfirm/queueEditCancel/queueRemove/
  queueSetMode）
- sessions：`queueView`（两桶视图+mode 记录）/`queueFreeze`（该条及其后 splice
  暂离）/`queueUnfreeze`（按原序逐条 followup 放回——冻结段必为队尾连续段，
  append 无损；idle 时首条唤醒）/`queueRemove`/`queueSetMode`（三高层方法重投，
  新消息 id 记 queueModes 辨 steer/inject——next-step 两模式同桶不可辨）
- service/rpc：六端点薄封装（权限+live 前置；不在册 queueList 返回空）
- webui：QueuePanel（行=文本+模式徽标+编辑/改模式/删除；编辑仅排队条目）；
  ComposerCard 编辑态（editingDraft 回填、发送变确认、Enter 确认/Esc 取消、
  draftLength 供页面校验「输入框有内容拒绝编辑」）；帧驱动队列刷新
  （user-text/turn-end 到达且非编辑中）

### W10c 队列抽屉重做（Owner 反馈二轮，2026-09-27）

Owner 设计落地：抽屉形态（手风琴：收起=预览条「投递队列（N）· 下一条：…」，
展开=完整列表）、行布局 status+单行文本+actions、status 位=锁定（点击主动
锁定：禁操作/不可拖/重排固定原位）、整行拖动排序（拖动开始即全面板锁定：
actions 禁用+暂停帧驱动刷新防抖动，drop 一次性提交新序）。

- 契约/sessions/service/rpc：queueReorder（next-turn 全量 splice 重排；
  集合不一致=并发消费拒绝，前端刷新重试）
- QueueDrawer.svelte 替代 QueuePanel（紧贴 composer 顶部的抽屉造型：
  rounded-t 无下边框）；Svelte 5 props 不可反写——reordering 经回调置 store
- 编辑/删除/改模式按钮在锁定与拖动态禁用；锁定为会话级 UI 态（内存，
  切任务复位）

### W10d 立刻发送 + 抽屉不显示修复（Owner 反馈三轮，2026-09-27）

- 立刻发送（actions 第四按钮，排队条目）：该条提到队头 + `cancel{kind:'user'}
  +keepInbox`——内核在被打断轮收敛后自动开新一轮消费队头（DSH 原生语义，
  无自造机制）；链路 queueSendNow 四层直通。
- 抽屉从不出现根因修复：排队消息内核开轮前不落 session log（无
  user/message 事件）→ 无 user-text 帧 → 帧驱动的 refreshQueue 永不触发
  → 队列视图恒空 → 抽屉整条隐藏。修复：sendPrompt/stopPrompt 成功后主动
  拉队列（sendQueueNow 同样）。
- 排队消息对话面板不可见（乐观帧刷新即消失）仍在待修清单——需 queued
  补帧或乐观帧保留至消费帧到达。

### W10e~g 走查基建与实测反馈修复（Owner 三/四/五轮，2026-09-27）

- W10e 立刻发送（actions 第四按钮）：排队条提队头 + cancel{user}+keepInbox
  （内核收敛后自动消费队头）；URL ?demoDelay=<ms> 走查开关（daemon 内置
  DemoAgent：同构内存 inbox + 定时消费产演示帧，零真实 LLM）；demo 豁免
  模型路由门控；agent-browser 全流程走查通过
- W10f 「分析中」轮间空转修复：turn-end completed 且 inbox 双桶空
  → onSessionIdle → 任务回 done（等待输入）；队列非空保持 running
- W10g Owner 三反馈：①通道提示改 toast（新增 ui/toast 零依赖组件）；
  ②改引导「顺序乱」=视图掩盖时序——抽屉拆两组如实表达（即将生效 ·
  当前轮下一步 / 排队 · 按序生效），预览条同步，改模式 toast 告知；
  拖动收窄到排队组；③三态锁（解锁/主动/被动——主动锁后全部连带锁定，
  被动锁点击=边界上移，store 单主动锁互斥）
- WS 首发竞态根修（走查中抓到）：刷新后首个 RPC 在 WS open 前发出被
  原生层静默丢弃（demo.setDelay 从未到达）——api.ensureRpcReady() 就绪门，
  刷新后关键请求前置等待

### W10h~i 锁定语义重做 + 专业 dnd（Owner 六/七轮，2026-09-27~28）

- W10h 锁定四轮收敛（Owner「做减法」定稿）：锁=只是不再自动发送，其它
  都能做。daemon 持久化锁定段（lockedQueue 暂离内核 inbox + 边界条
  lockBoundaryId）；锁定段内全功能开放（编辑/删除/改模式/拖动/立刻发送
  ——改 steer/inject=脱离段立即投递，立刻发送=先解锁放回再提队头打断
  开轮）；跨段拖动全局重排按边界重切。单测 16 用例（含拖动期
  DemoAgent 暂停消费零丢失）
- W10i 引入 svelte-dnd-action（实时插入预览；HTML5 手写 DnD 弃用）：
  根因=consider 回调未开拖动态，$effect 以 props 回灌 dndItems 当场抹掉
  预览序——首次 consider 即 onreordering(true)（daemon 暂停消费+停止
  回灌）；CDP 真实输入序列验证重排生效（合成 PointerEvent
  isTrusted=false 对 dnd-action 无效）

### W10j 拖动浮影被动锁（Owner 复测反馈「拖动中的元素没有上锁」，2026-09-28）

- 根因：svelte-dnd-action 拖动时克隆被拖行（id=dnd-action-dragged-el、
  position:fixed 跟随鼠标，原行 visibility:hidden 留位）。克隆发生在拖动
  起始帧——早于 reordering=true 的重渲染，浮影永远冻结在「灰开锁+按钮
  未禁用」的拖动前渲染；列表内静态行则已正确琥珀闭锁。视觉判读（像素
  采样）实证：浮影锁灰开、按钮正常，其余行琥珀闭锁+禁用。
- 修复（QueueDrawer.svelte）：锁图标改双渲染（开/闭 SVG 常驻 DOM，
  data-lock 属性 CSS 切换——克隆体里两图标都在）；浮影 CSS 覆盖
  （#dnd-action-dragged-el：闭锁图标+琥珀色+操作按钮禁用观感+抓取
  浮层阴影）。图标类在 lucide 子组件 svg 上，作用域规则一律 :global()
  （svelte-check「Unused CSS selector」教训）。
- 验证：本机 8299 + 可见标签页（无头隐藏页 svelte css 过渡动画瞬间结束
  在 0 态，slide 卡死属环境伪影非产品 BUG）CDP 真实拖动：浮影 DOM
  computed=琥珀 rgba(217,119,6,.55)/闭锁显示/按钮 opacity .3/阴影；
  像素判读三条全员琥珀闭锁（含浮影）；松手重排提交（下一条=浮影乙）。
- 走查注意：浏览器可能缓存旧 bundle（dropSourceStyle 警告为旧版指纹）
  ——复测前强刷/加 cache-bust 参数。

### W10k 统一队列模型重做（Owner 指示「做减法」，ZCode×Codex 设计讨论定稿，2026-09-28）

- Owner 指出 BUG：W10g 把引导（next-step 桶）与排队（next-turn 桶）分两组
  展示/消费是错的——真实语义是交错单序列：引导1→队列2→引导3→队列4→
  引导5，引导3 跟随队列2 一起发出（该轮补充）。要求：几条正交规则实现，
  不堆定制能力。
- Codex（gpt-6-sol xhigh，herdr workspace zcode-shufa-w10k-queue-model）讨论
  收敛，与 ZCode 独立推演一致，定稿规则集：
  1. 单一有序序列；每条 kind ∈ {anchor（开轮）/ attach（补充）}，inject 降
     为 attach.effect（不再是第三类）
  2. attach 绑定前方最近 anchor；序列头部 attach 绑定当前运行轮
  3. 投递只有两个事件：轮内下一 step 边界（投当前轮 attach 组）、轮结束
     （承认下一 anchor，turn/start 后其 attach 组随之 steer 进该轮）
  4. daemon 单一事实源（统一序列 + SQLite task_queue 表落库，重启恢复+
     装配时收养内核 inbox 遗留）；内核 inbox 退化为瞬时投递缓冲
  5. 单航次投递（pump 游标）：一次最多一个 admitted anchor；忙期不承认
  6. idle+steer attach 开新轮；idle+inject 不唤醒保持 pending
  7. 锁=位置派生后缀（边界条及其后），只是不自动投递；编辑/删除/改模式/
     拖动/立刻发送全开放且与锁正交（改模式不再越过锁）
  8. 在途条目可锁/可排（撤回内核 inbox 再操作）；立刻发送 anchor=组语义
     （带后续 attach 组越过锁定）；取消轮=已交付 attach 随轮终结不重放
- 实现：sessions.ts 重写队列核心（W10kQueueItem/pumpQueue/onQueueTurnStart/
  onQueueTurnEnd/withdrawAdmitted；条目 id 永稳+kernelId 旁车寻址内核）；
  DemoAgent 对齐（idle steer 开轮、turn-start 批先行、nextStep 轮内吸收为
  补充帧）；DB 迁移 v6（task_queue 表+tasks.queue_lock_boundary）；前端
  QueueDrawer 单列表重做（attach 缩进+本轮徽标+绑定全由顺序派生，拖动重排
  即重绑定）；修「引导当前轮」按钮 mode 丢失（ListDetailPage onsend 接线）；
  删 slide 过渡（JS 过渡冻结在 0 高 0 透明态→内容与输入框重叠、拖拽失效，
  实测两次）。
- 验证：daemon 165/165（tasks-queue 重写 15 用例：交错序列核心场景/idle
  steer 开轮+inject 不唤醒/锁定撤回在途/删锚重绑/改模式正交/组立刻发送/
  重排撤回承认/持久化恢复/demo 引导同轮呈现/拖动暂停）+ tsc + svelte-check
  + build 全绿；本机走查：交错序列渲染（引导跟随最近开轮条）、被动锁全员
  琥珀、DB 持久化行实证。遗留：拖动松手提交在无头浏览器今日未复现成功
  （浮影/影子/consider/finalize 均工作但库输出原序——环境退化嫌疑，交
  Owner 真实浏览器复测）。

- W10k 二轮（Codex 复核 NEEDS-WORK 6.4/10 → 六个 P1 全修，2026-09-28）：
  ① 撤回统一 kernelId ?? id + remove 返回值检查（撤不回=已消费随轮移除）；
  ② 锁定撤回整个后缀在途（不只边界条——inflight attach 锁定后仍会执行）；
  ③ 删除 admitted 清游标 + 立即续泵；④ task_queue 加 state 列（恢复只回填
  queued，admitted/inflight 走内核收养防双投）+ anchor 开轮消费无条件落库；
  ⑤ 迁移 v7 重建 task_queue 外键 ON DELETE CASCADE（删任务/用户不再被阻断）；
  ⑥ 前端 attach 行开放立刻发送/编辑（去掉仅排队条件）。附带修 pump 头部
  attach 连续段跳过 inflight（多条引导不再被首条阻断）。回归 +5 用例
  （sendNow 撤回无残留/锁后缀全撤/删 admitted 续泵/恢复跳过非 queued/
  开轮不复活）+ DB 层 2 用例（state 读写/级联删除）。172/172 绿。

- W10k 三轮（Codex 复评 7.6/10 剩余两 P1 全修，2026-09-28）：A①统一撤回
  原语 withdrawItem（remove 返回值检查：withdrawn=取回/consumed=随轮移除），
  setMode/sendNow/reorder 三处全走原语——setMode 目标已消费拒绝、sendNow
  组员已消费剔除（目标已消费拒绝）、reorder 先撤回再校验（漂移如实拒绝）；
  B②迁移 v8 kernel_id 落库 + 恢复去重（kernelId 精确匹配 + v6 旧行
  kind/text 兜底——内核收养为准，DB 行剔除防双投）。回归 +2 用例（撤回
  失败三路径 / 恢复去重不双投）。174/174 绿。

- W10k 四轮（Codex 终审 8.0/10 剩余两窄口全修，2026-09-28）：①三处「撤回
  后拒绝」路径（setMode/sendNow/reorder）先 persistQueueState 落库清理结果
  再抛错——防进程重启从旧 DB 行复活已消费条目；②恢复文本兜底收窄：仅
  kernelId 为空的 v6 旧行走兜底（v8 行只做 kernelId 精确匹配），且计数制
  ——每条收养消息只抵扣一条同文本旧行（合法重复行保留，不丢消息）。
  回归 +2 用例（拒绝路径落库快照 / 兜底计数制恰三条）。176/176 绿。

### 已定位待修（Owner 指示下一步处理）

- 排队消息不出现在对话面板：内核只在消息被消费（开轮）时落 session log
  并发 user/message 事件（sessions.ts 投影 user-text 帧的唯一来源）——
  inbox 暂存期无帧，乐观帧成为唯一显示，selectTask 重拉/刷新即消失。
  修复方向：queueView 驱动的 queued 补帧（或乐观帧保留至消费帧到达）。
- 「变成插入方式发送」待复现定位。

### 验证

- daemon 158/158（新增：sessions 队列九用例——含 queueReorder/queueSendNow——视图/冻结/放回（改与不改）/
  删除/模式切换/不在册；service stop（打断≠取消回归）/steer 分流两用例）
  + tsc + svelte-check + build 全绿
- FakeAgent 扩 inbox 内存实现（followup/steer/inject 入桶+remove/replace/
  splice），与真实内核持久 inbox 同构

## W10l 体验修复二轮（Codex 日曜三体验评审 3/10 → 批次落地，2026-09-29）

### 评审结论（Codex 日曜三 32 分钟）

- 现状做减法 3/10：语义能力完整，但同一件事多入口、低频能力占主行、状态藏
  tooltip/toast/三态图标。按重设计清单预计 8/10。
- P1×2：①队列操作错误对用户不可见（refreshQueue 静默 catch + tasks.error
  不渲染）；②dndItems 只比 id——同 id 编辑/改模式后渲染旧文本（=Owner
  「改了内容队列还是旧的」BUG 确切根因）。
- P2×8 + 触屏专项 7 条 + 转录呈现决策（乐观帧 + queued 标记 ✓ 已做方向）。

### 本轮修复（已全部浏览器复验）

- 【根因·daemon】WS 帧流「连接开着却永不推送」：帧订阅绑在 live entry 上，
  resume/makeEntry 替换条目即孤儿化订阅者；会话不在册时 subscribe 静默
  no-op。修：订阅提升为 sessionId 键的模块级 Map（跨 entry 替换/不在册
  窗口存活，WS 关闭退订，dispose 清空）。回归 +2（跨 resume 存活 /
  disposeLive 后订阅→复活送达）。**这是 Owner「队列旧的/要手动刷新/
  消息不出现」家族的共同根因**——178/178 绿。
- 【P1①】编辑/撤回路径错误进 queue.error 内联错误条（原写 tasks.error
  详情页不可见）；queueOpFailed 对「队列中没有该条目」（本地视图证实
  过期）也自动刷新队列。
- 【P1②】QueueDrawer 渲染源分离：rowItems（props 直派生，非拖动期渲染）
  与 dndItems（拖动预览专用）——修同 id 旧文本渲染。
- 【P2】停止按钮常驻（不与发送互斥，主操作位稳定）；toast 短文案
  （已排队/已安排引导）；delayTouchStart: 120 触屏拖动保护。
- 【自纠】重连改造时误写 `&token=`（带 token 启动即 RPC 死屏）→ `?token=`。

### 复验记录（demo 10s，agent-browser）

发送→排队气泡→10s 轮消费→气泡转真帧、抽屉即时清空（帧推送根因修复生效）；
编辑流：点编辑→文本回填+编辑占位符+确认/取消按钮→改文→确认→行更新；
错误条：「队列中没有该条目」内联可关闭。demo 全局开关已退（client+daemon）。

### 待 Owner 拍板（重设计清单，删的是早期要的功能）

删 Zap 直达 / 删行内「立刻发送」主图标 / 锁显式「从这里暂停」/ 紧凑列表 /
状态流气泡（发送中→排队中→生效中→已送达/失败，id 去重，inflight=生效中）。

## W10m（2026-09-29，Owner「继续推进，包括小项」：Codex 评审 P2/重设计落地 + 小项三件）

### 小项

- 任务列表拉取失败重试：loadTasks 退避三轮（1.5s×n）——帧流/RPC/任务列表
  三处「失败即静默空态」病灶收口完毕。
- withdrawAdmitted 统一到 withdrawItem 原语（Codex 尾注）：删除重复的
  remove/splice 分叉，admitted anchor 是在途条目特例。
- 「变成插入方式发送」病因分析（未再复现）：最可能是行内 20px 模式按钮
  误触（两次点击=queue→steer→inject）+ 旧渲染 bug（dndItems 只比 id，模式
  变更不回灌）合力——模式改了 UI 不显示，看起来像「自己变了」。本轮
  双重加固：模式 popover 文案按运行态显式化（本轮补充/待活动轮）+
  rowItems 渲染分离 + 行级 pending 防抖。若再出现待复现。

### 状态流（Codex 转录呈现决策落地）

- daemon：followup/steer 返回队列条目稳定 id（TaskFollowupOutput+
  queue_item_id）；队列起源轮的第一条 user-text 帧盖 payload.queue_item
  戳（commitFrames 单点，真实内核/DemoAgent 两路共益；补充帧不盖）。
- webui：乐观帧带同 id——dropOptimistic id 主键去重（文本仅兜底）；
  displayFrames（乐观帧被队列条目接管即让位）+ pendingQueueItems（已消费
  不显示、inflight 显示「生效中」）——发送中→排队中→生效中→已送达全程
  可见，重复文案不误伤。live 验证：消费帧 STAMP 落盘、无双泡。

### P2/重设计（做减法）

- 删 Zap 直达引导按钮（引导/注入=队列行模式选择）；删行内「立刻发送」
  主图标（sendNow RPC 保留无 UI 入口）。输入面板收敛为 发送/停止。
- 暂停显式化：三态锁图标 → 「⏸ 暂停 / ▶ 恢复」文字钮（后缀「已暂停」
  纯展示不承担隐含点击）；锁语义文案同步（已暂停/已恢复）。
- 模式文案按运行态：queue=下一轮；steer=本轮补充（idle=新开一轮）；
  inject=本轮注入（idle=待活动轮）——与实际投递时点一致。
- 行级 pending：queue.pendingId 包裹五类 RPC，落定前行禁用防重复点击。
- 计数拆分「待发 N · 生效中 M」；队列非空自动展开（手动收起尊重到清空）；
  拖动抓手显式化 + .q-hit 触屏命中区外扩（图标 14px 视觉、≥30px 命中）。

### 教训（操作纪律）

- pkill -f "tsx src/index.ts" 不匹配真实 cmdline（preflight.cjs src/index.ts）
  ——旧 daemon 存活占端口，新进程 bind 失败静默退出，live 验证跑在旧代码
  上（stamp 缺失假阴性）。重启服务后必须以 PID+启动时间核对进程身份。

### 验证

- daemon 182/182（新增：demo 消费帧盖章、followup/steer 返回 id、盖章不
  覆盖补充帧）+ tsc 0；svelte-check 0 错；build ✓。
- live（8299，demo 10s）：盖章验证消费帧带戳无双泡；引导改模式→补充帧
  同轮交付；暂停→边界「恢复发送」→恢复回未锁；队列清空 chip 消失。

## W10n（2026-09-29，Codex 复核 7.0/10 NEEDS-WORK 四 P1 修复）

### 复核结论（codex-w10m，大地三 46 分钟）

- P1×4：①盖章错配——真实内核 claim() 先取 next-step 再取 next-turn，attach
  事件先到，「首条 user-text」启发式会把 anchor 的戳盖到 attach 帧（DemoAgent
  先取 head 掩盖了此路径）；②发送空窗——RPC 成功到消费帧到达间，乐观帧
  被 displayFrames 隐藏、队列气泡又被自身乐观帧计入 consumedIds 过滤，
  消息整条消失；③attach 双泡——attach 帧不盖章但 inflight 气泡并存；
  ④边界上移竞态——passive 纯展示，「恢复→再暂停」两步间目标条目会被
  pump 消费。P2×3：文本兜底误删、pending 全局锁、previewText 静态文案。
- 另揪出提交卫生问题：9a80e70 把 Owner 并行改动中 service.ts 的
  buildTaskContext 依赖卷入而 prompts.ts 未入——main 构建断裂（已补齐
  e22129d）。

### 修复（全部 live 验证）

- 【P1①+③】盖章改按内核消息 id 精确配对：DemoAgent 帧直填 payload.mid、
  真实内核 user/message 投影带事件消息 id；commitFrames 以
  activeAnchorKernelId 回配已移出队列的 anchor、以队列 kernelId 命中
  attach——attach 消费帧盖自己的 id（前端气泡精确收回）。删除
  anchorStampPending 启发式。回归 +1（claim 先 next-step 顺序：attach
  先到不夺戳、各自盖各自）。
- 【P1②】pendingQueueItems consumedIds 排除乐观帧——只认真实 daemon 帧
  为消费证据。live：t+0.7s 消息可见（排队中），无空窗。
- 【P1④】原子边界移动：queueLock 边界深挪时释放前缀立即 pump（不等轮
  事件）；passive 行可点「把暂停边界移到这里」；恢复（null）也挂行级
  pending（边界行为标记）。回归 +1（深挪后前缀续投）。live：甲暂停→乙
  移边界→甲释放乙成边界，无消费竞态。
- 【P2】dropOptimistic 有 id 时严格 id-only（文本仅无 id 路径兜底）；
  rowBusy 改行级 pending（不再全队列锁死）；previewText 按运行态动态
  （idle steer=下一条（新开一轮））。

### 门禁

daemon 184/184 + tsc 0 + svelte-check 0 错 + build ✓；live：mid 盖章落盘
（seq 级验证）、发送无空窗、无双泡、边界移动往返。

## W10n 二轮修复（Codex 复核 8.0/10 剩余项，2026-09-29）

- 【P1·竞态回收】WS 真帧先于 RPC 响应到达时，乐观帧还没拿到 id——严格
  id-only 漏删致双显。dropOptimistic：id 命中优先；未命中且有戳时回收
  「最近一条·无 id·同文本」未认领乐观帧（每次发送恰一条，定位唯一）。
- 【P1·刷新代次】refreshQueue 加单调代次 + taskId 双校验——切任务/重连/
  帧驱动并发刷新时旧响应晚归不再覆盖当前队列视图。
- 【条件性·钩子分序】demo 帧包装器按帧型分序：turn-start 钩子先行（配对
  留存 activeAnchorKernelId，同批 turn-start+user-text 防御性不漏盖）、
  turn-end 钩子殿后（清扫 inflight 前让本批 attach 帧先盖到自己的戳）。
- 门禁：daemon 184/184 + tsc 0 + svelte-check 0 错 + build ✓；live 回归
  （无空窗/单泡/盖章落盘/chip 清空）。

## W10n 三轮收尾（Codex 9.0/10 后 live 深挖三修复，2026-09-29）

三轮复核 9.0/10 无 P0/P1；唯一 P2（拖动旧刷新写回）修复：进拖动态即提升
刷新代次；reorderQueue 接管 reordering 生命周期（松手→daemon 先恢复消费、
本地 reordering 保持到重排 RPC 落定）；无任务早退不悬挂。

live 复验深挖出三个真实缺陷（全部帧级证据定位+修复+回归）：

- 【停摆根因】DemoAgent cancel{keepInbox} 不发 turn-end——真实内核 cancel
  后发 turn/end(cancelled) 驱动 onQueueTurnEnd（清 turnRunning/清扫/pump
  续跑），demo 缺失 → entry.turnRunning 卡真、后续 anchor 永不承认。
  补齐同构 + 回归（停止后续跑不停摆）。
- 【僵尸条目】makeEntry 替换同 sessionId 条目时旧 agent 未失活——在途
  定时器继续产帧（seq 双写/双泡/幻视图；frameSubscribers 修复使其直达
  客户端后暴露）。替换即 dispose 旧 handle + 回归（无僵尸双写）。
- 【demo 丢单】restore 只回填 queued 态——stop→立即续聊触发 resume 时，
  在途消息随内存 inbox 销毁，DB 行被丢即丢单。改「未被收养的行一律回队
  queued」：真实内核 kernelId 收养去重不变（防双投语义保留），demo 销毁
  场景行被救回重投。回归改双向断言（无收养救回/有收养去重）。
- 另：setDemoDelay 失败不再静默（退开关+横幅——曾致 daemon 侧 demo 未
  生效、真实 LLM 被测试消息烧掉一轮）。

教训入档：①daemon 重启后 demo 必须先探针确认 daemon 侧生效（横幅≠证据，
本轮烧了一轮真实调用）；②UI textContent 探针在虚拟化下会假阴性，以帧
文件为权威；③「假设在内核 inbox」的丢弃逻辑对内存 inbox 的 demo 是丢单。

门禁：daemon 187/187 + tsc 0 + svelte-check 0 错 + build ✓。

## W10n 增量复核修复（Codex 7.5/10 两 P1 收窄，2026-09-29 四轮）

- 【P1·cancel 生命周期】turnOpen 门控：DemoAgent 仅在本轮 turn-start 已发
  且未 turn-end 时才发 cancelled 帧——未开轮的 cancel（timer 在途）无轮
  可断：不造孤立「本轮完成」、不清扫未开轮的在途 attach（keepInbox 下
  pending head 照常续跑）。entry.turnRunning 不能当守卫（deliverAttach
  会预先置真）。回归 +1（未开轮 cancel：帧数不变/条目在队/后续照常消费/
  无 cancelled 帧）。demo 轮为原子同步，turnOpen-true 的 cancel 实际不
  可达——门控兼为未来异步 demo 轮的防御。
- 【P1·审批收敛】makeEntry 替换旧条目前先以空答案释放 prev.pending（否则
  旧审批 Promise 永久挂起——Codex 探针实证）+ dispose 带错处理。
- 【P2】reorderQueue 的 daemon 恢复消费 RPC 改 await+失败面呈（不再
  fire-and-forget 吞错——否则 daemon 仍暂停而 UI 已解锁）。
- 条件性 P2（kernelId 重建不一致双投）记录在案：DSH 持久 inbox 正常保留
  消息 id，仅重建场景触发，暂不处理。

门禁：daemon 188/188 + tsc 0 + svelte-check 0 错 + build ✓；live 帧级
终链（stop→keepInbox 续跑甲→乙，无孤立帧/停摆/双写；demo 探针先证 daemon
侧生效）。

## W10n 五轮修复（Codex 8.0/10 P1+P2×2，2026-09-29）

- 【P1·dispose 围栏】makeEntry/makeDemoEntry 异步化：释放旧 pending →
  await prev.dispose() 完成后才 live.set/恢复/pump——真实内核 dispose 会
  abort 活跃轮并异步发 turn/end，先切换会让旧轮终结事件落在新条目上
  （onQueueTurnEnd 清扫新队列 inflight；Codex 延迟-dispose 探针复现）。
  回归 +1（延迟 dispose 发 turn/end：新条目 inflight 存活）。
- 【P2·cancel 重入】cancelRequested 标记：turn-start 回调内同步 cancel 已
  发 cancelled 帧时，consumeHead 批2 抑制 completed（防双「本轮完成」）；
  turnOpen 延迟到批后复位。
- 【P2·reorder 终止】恢复消费 RPC 失败即终止本次提交（不继续 reorder——
  否则 daemon 仍暂停时提交新序，界面恢复队列冻结）。

门禁：daemon 189/189 + tsc 0 + svelte-check 0 错 + build ✓；live 冒烟
（demo 探针先行，双发送消费、队列清空）。
