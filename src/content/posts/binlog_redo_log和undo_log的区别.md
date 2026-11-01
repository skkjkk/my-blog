---
title: binlog、redo log 和 undolog 的区别？
published: 2026-10-29
description: "redo log 管崩溃恢复、undo log 管事务回滚与 MVCC、binlog 管主从复制与数据同步，三者分层不同、职责完全不同。"
tags: [面试]
category: 数据库
section: note
draft: false
---
三者是 MySQL 的三种日志，**分属不同的层、解决完全不同的问题**：**redo log 是 InnoDB 引擎层的物理日志，管崩溃恢复，保证持久性（D）；undo log 是 InnoDB 引擎层的逻辑日志，管事务回滚和 MVCC 旧版本，保证原子性（A）；binlog 是 Server 层的逻辑日志，管主从复制、CDC 与数据同步。** 面试真正要答的不是三段定义，而是「为什么 redo log 和 binlog 必须用两阶段提交绑定在一起」。

## 三者定位对比

| | redo log | undo log | binlog |
|---|---|---|---|
| **所在层** | **InnoDB 引擎层** | **InnoDB 引擎层** | **MySQL Server 层** |
| **内容** | 物理变更（改了什么页的哪个偏移） | 逻辑相反操作（反向 SQL） | **逻辑变更（SQL 语句 / 行事件）** |
| **写入方式** | **循环写、覆盖写**（固定大小） | 写在 undo 表空间 | **追加写、无限增长** |
| **用途** | **崩溃恢复（持久性）** | **事务回滚 + MVCC 快照** | **主从复制 + CDC + 数据同步** |
| **提交时机** | 事务提交时（两阶段） | 事务提交后延迟清理 | 事务提交时写入 |

这张表是回答的骨架：**层不同决定了能力边界** —— 引擎层日志跟着存储引擎走，Server 层日志与存储引擎无关，所以只有 binlog 能跨实例、跨版本重放。

## redo log —— 崩溃恢复（持久性的核心）

- **WAL（Write-Ahead Logging）**：先写日志再改数据页 → 宕机后用日志重放恢复
- **⚠️ 关键特性：循环写、空间固定、满了就覆盖旧的**
  → 所以 redo log **不是完整的数据副本**，只是"最近一段时间的变更日志"
  → **checkpoint** 标记已刷盘的数据页位置，checkpoint 之前的日志可被覆盖
- **刷盘策略**：`innodb_flush_log_at_trx_commit`
  - **1**（默认）：每次提交都写进 OS 缓存**并立即 fsync**（**不丢已提交事务，最安全**）
  - **2**：提交时只写进 OS 缓存、不 fsync，由后台每秒 fsync（**进程崩溃不丢，宕机丢 1 秒**）
  - **0**：提交时连 OS 缓存都不写，后台每秒写并 fsync（**进程崩溃和宕机都丢 1 秒**）
- **为什么需要两阶段提交**：redo log 与 binlog 分属两个模块，**必须保证两个日志的写入结果一致**，否则主从数据会不一致 → **prepare → 写 binlog → commit**

## undo log —— 回滚与 MVCC 的版本链

- **记录逻辑相反操作**：`INSERT` 的 undo 是 `DELETE`；`UPDATE` 的 undo 是恢复旧值
- **两大用途**：① 事务回滚（`ROLLBACK`）；② **MVCC 的版本链**（通过 undo log 找到历史版本供其他事务读）
- **⚠️ `purge` 线程负责清理** —— 当没有任何活跃事务需要某个历史版本时，才删除对应的 undo log
- **⚠️ 长事务的危害**：长事务持有旧版本 → undo log 无法清理 → **undo 表空间暴涨**（默认是独立的 `undo_001` / `undo_002`，只有没开独立 undo 表空间时才会撑大 `ibdata1`）→ 同时阻碍 purge、导致表空间无法回收

## binlog —— 复制与同步

- **Server 层的逻辑日志**，记录**做了什么变更**（statement/row/mixed 三种格式）
- **用途**：主从复制、**CDC（数据变更订阅）**、数据同步到 ES/数仓、**订阅 binlog 实现最终一致**
- **⭐ 与 redo log 的本质区别**：redo log 是**物理日志**（记的是数据页的字节改动，不能用来做主从复制，因为主库和从库的数据格式、页结构可能不一致）；binlog 是**逻辑日志**（可跨实例、跨版本）
- **格式选择**：默认 `ROW`（推荐）—— 保证数据一致性；`STATEMENT` 效率高但有**主从不一致风险**（如 `NOW()`、`UUID()`、`LIMIT` 无序）

## 两阶段提交（2PC）—— 保证 redo 与 binlog 一致

```
① 执行更新 → 写 undo log → 改内存数据页 → 写 redo log（prepare 状态）
② 写 binlog 并标记 commit
③ 写 redo log（commit 状态）→ 释放锁
```

**崩溃恢复规则**：
- **崩溃在 ① 后** → redo 停在 prepare、binlog 还没写 → **回滚**（事务视为未提交）
- **崩溃在 ② 后、③ 前** → **redo 已 prepare + binlog 已完整** → **自动提交**（保证主从一致）
- **binlog 不完整** → **回滚**

:::tip
**这就是"为什么两阶段提交能保证主从一致"**：以 binlog 是否完整作为"该事务是否应该存在"的裁决依据。
:::

## binlog 的三种格式

- **STATEMENT**：记录 SQL 语句 → **文件小**，但含 `NOW()`/`UUID()`/`RAND()`/`LIMIT` 无序时会**主从不一致**
- **ROW**：记录**行变更前后的镜像** → **数据一致**，文件较大 → **MySQL 5.7 默认**
- **MIXED**：自动在两者间切换

## 三个日志的协作关系（完整链路）

```
UPDATE 执行
  → 写 undo log（可回滚 + 提供 MVCC 旧版本）
  → 改 Buffer Pool 中的数据页（内存里，脏页）
  → 写 redo log（prepare）→ 刷盘
  → 写 binlog → 刷盘
  → 写 redo log（commit）
  → 后台线程异步把脏页刷回磁盘（checkpoint 推进）
```

:::tip
**关键理解**：**redo log 的作用不是保证数据落盘，而是保证"宕机后能把没落盘的改动重放出来"** —— 真正的数据落盘由脏页刷写完成，checkpoint 就是"已安全落盘的位置"。
:::

## 实战相关的几个点

- **⚠️ 主从延迟的常见原因**：主库大事务（binlog 写得多）、从库回放能力不足（`slave_parallel_workers` 开并行，配合 `slave_parallel_type=LOGICAL_CLOCK`，较新版本这两个参数已改名为 `replica_parallel_workers` / `replica_parallel_type`）、从库**表没有主键**（ROW 格式回放要按主键定位行，无主键退化成全表扫描 → **加主键是解决主从延迟的通用手段**）
- **⚠️ 别把 `relay_log_recovery` 当并行回放开关**：它是崩溃后丢弃可能损坏的 relay log、重新从主库拉取的机制，和回放并发无关
- **⚠️ binlog 清理**：`binlog_expire_logs_seconds`（默认 30 天）自动清理；手动清大量 binlog 时用 `PURGE BINARY LOGS`
- **⚠️ undo log 暴涨**：优先排查**长事务**（`information_schema.innodb_trx`），而不是直接扩表空间

## 面试怎么答

1. 定位分工（redo = 引擎层物理日志管崩溃恢复、undo = 引擎层逻辑日志管回滚与 MVCC、binlog = Server 层逻辑日志管复制与 CDC）
2. redo 的两个关键特性（循环写覆盖 + WAL + 三种刷盘策略）
3. 核心机制 = 两阶段提交（以 binlog 是否完整裁决事务去留）
4. 实战关联（主从延迟常因从库表无主键、长事务导致 undo 暴涨）。第三点的两阶段提交最能体现对一致性的理解深度

## 常见追问

**Q：redo log 既然是日志，为什么不能直接拿它做从库同步，还要 binlog？**
A：redo log 记的是数据页偏移上的字节级物理改动，页结构和数据格式与版本、页大小强相关，从库未必能对上；而且它循环覆盖，历史增量留不住。binlog 是逻辑事件、追加写、可归档，才适合跨实例重放。

**Q：为什么 redo log 要循环写，不像 binlog 那样一直追加？**
A：redo log 只服务崩溃恢复，checkpoint 之后对应的脏页已经落盘，这段日志再留着也没用，覆盖写能换来固定磁盘占用和稳定的写延迟；binlog 要供从库和下游消费历史增量，所以只能追加。

**Q：两阶段提交里，崩溃恢复为什么以 binlog 是否完整为准？**
A：因为两阶段提交把 binlog 当作"事务是否应该存在"的唯一裁决依据：binlog 是能被从库和下游复制出去的那份记录。若 redo 已 commit 而 binlog 缺失，主库有数据从库没有，主从就永久不一致；反过来 binlog 完整而 redo 还是 prepare，补提交即可让主库追上从库。

**Q：长事务为什么会让 undo 表空间涨得很快？**
A：长事务的读视图一直停在一个很老的版本，purge 线程不敢删它之后的任何 undo 记录，undo 只增不减；等长事务结束、没有旧视图引用这些版本时，purge 才能回收。

## 易错点

- **「redo log 保证不丢数据，所以它就是数据文件的一部分」**：错。它只是最近一段时间的变更记录、循环覆盖，不是数据副本；真正落盘靠 Buffer Pool 脏页刷写，checkpoint 表示"已安全落盘到哪里"。
- **「`innodb_flush_log_at_trx_commit` 的 0 和 2 都是丢 1 秒」**：方向对但差别在崩溃类型 —— 2 提交时至少写进了 OS 缓存，只有机器宕机/断电才丢；0 提交时连 OS 缓存都不写，MySQL 进程自己崩了也会丢。
- **「binlog 是 InnoDB 的日志」**：错。binlog 在 Server 层，用 MyISAM 表也有 binlog；redo log 和 undo log 才是 InnoDB 引擎层的东西。
- **「从库延迟就调大并行回放参数」**：ROW 格式回放要靠主键定位行，从库表没主键会退化成全表扫描，加主键常常比调参更有效。

## 一句话记住

:::tip
redo 管恢复、undo 管回滚、binlog 管复制；三者一致靠两阶段提交。
:::
