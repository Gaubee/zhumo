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
