# @pid/checkpoints

运行前给 git 工作区拍快照（不动真实的暂存区），以便回退。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- 在 `agent/before-start` 时拍快照，有效权限为只读时跳过。快照记为 `custom` 事件 `pid-checkpoints`：`{ userSeq, checkpoint }`。
- `checkpointsOf`、`checkpointFor`、`diffCheckpoint`、`restoreCheckpoint` 供 Host 的 `checkpoint.*` RPC 方法使用。
- git 部分（`git.ts`）取自 Pi 引擎的 `pidesktop-checkpoints.ts`（已在 P6c 随 Pi 移除），沿用 `refs/pidesktop/checkpoints` 命名空间，最多保留 250 个快照。
