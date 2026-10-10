# 更新日志

本项目的所有重大变更都记录在此文件中。

## [1.0.1] - 2026-10-10 — 🐛 补导出：`reportTelemetry` / `reportExperience`

> **性质：缺陷修复（配合 `dsh-motor-ai-l0@0.3.1`）。**

### 根因
- l0 抽 core 重构时，`index.mjs` 的 re-export 块漏导出 `reportTelemetry`（`lib/telemetry.mjs:205`）与 `reportExperience`（`lib/experience-upload.mjs:295`）。
- l0@0.3.0 入口残留 3 处本地 `./lib` 动态 import → 发布物缺 lib → DSH 启动崩溃；修复方案把 l0 的 3 处动态 import repoint 到本包，但本包未导出这两个函数会导致功能静默失效。

### 变更
- `index.mjs` re-export 块补齐 `reportTelemetry`（telemetry 块）与 `reportExperience`（experience-upload 块）。

### 影响
- 纯导出补充，无破坏性变更；`^1.0.0` 消费者自动覆盖。
