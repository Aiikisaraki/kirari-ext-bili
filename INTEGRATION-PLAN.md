# 子智能体集成计划（lead 用）

五个模块完成后按此接线：

## 1. bili-capture → lib/capture.cjs + commands/watch.cjs + lib/wbi.cjs
- server.cjs methods 加 watch(a)：调 commands/watch.cjs，返回 frames 图片路径数组
- bili-api.cjs 若 agent 建了 wbi.cjs，在 request() 里对 signedPaths 自动签名
- capability bili_explore 加 action 'watch'：返回 frames 路径，由 core 端 read_image 喂模型

## 2. bili-affect → lib/affect.cjs
- server.cjs methods 加 affect(a)：decayAll + 返回 state + buildAffectBlock
- explore/discover/round 开始时 addExperience(events)，结束时再取一次
- capability 返回里带 affectBlock，核心端拼进 system prompt（和 presence 同位）

## 3. bili-diary → lib/diary.cjs
- server.cjs methods：diaryAddEvent / diaryBuildPrompt / diaryCommit / diaryShow
- capability 加 action 'diary'：子动作 list/build/commit/show
- 模型生成正文流程：capability diaryBuildPrompt → 模型在同轮生成 → diaryCommit

## 4. bili-scheduler → lib/scheduler.cjs + lib/biolock.cjs
⚠ 挂载点在 core 的 capability 层（不是 sidecar）：sidecar 进程空闲退出，撑不起常驻调度
- 新建 core services/biliScheduler.js：用 lib/scheduler.cjs 的逻辑（移植成 JS），60s 巡检
- 到点触发：调扩展 service.call discover（走已验证链路），结果写记忆
- app.js 启动时 start，health 暴露 lastTickAt

## 5. bili-memory-audit → lib/memory-store.cjs + commands/notes.cjs
- server.cjs methods：notesAdd / notesRecall / notesStats
- capability explore/discover/round 写记忆时改调 notesAdd（带来源），并保留写 self:: 池

## 发版
- 扩展包 0.3.0 + core/desktop capability 同步 + 169 部署 + selftest 全绿