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

### 验证

- daemon 156/156（新增：sessions 队列七用例——视图/冻结/放回（改与不改）/
  删除/模式切换/不在册；service stop（打断≠取消回归）/steer 分流两用例）
  + tsc + svelte-check + build 全绿
- FakeAgent 扩 inbox 内存实现（followup/steer/inject 入桶+remove/replace/
  splice），与真实内核持久 inbox 同构
