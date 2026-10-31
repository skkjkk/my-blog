---
title: 如何使用 MySQL 的 EXPLAIN 语句进行查询分析？
published: 2026-10-23
description: EXPLAIN 用于查看一条 SQL 的执行计划，也就是优化器打算怎么执行这条语句，是 SQL 调优的第一诊断工具
tags: [面试]
category: 数据库
draft: false
---
`EXPLAIN` 用于查看一条 SQL 的**执行计划**，也就是优化器打算怎么执行这条语句，是 SQL 调优的第一诊断工具。

1) **基本用法**。在 SQL 前加 `EXPLAIN` 即可，例如 `EXPLAIN SELECT * FROM user WHERE id = 1`。MySQL 8.0 还支持 `EXPLAIN FORMAT=JSON` 输出 JSON 格式（含成本估算），以及 `EXPLAIN ANALYZE` —— 它会**真正执行**语句并输出每个执行节点的实际行数、耗时与循环次数，是定位"估算与实际不符"的最强工具（注意：它会真的跑，对写语句要小心）。

2) **重点看 type 列（访问类型）**，这是判断索引是否生效最直接的依据，性能从优到劣大致是：`system` > `const` > `eq_ref` > `ref` > `range` > `index` > `ALL`。其中 `ALL` 是**全表扫描**，通常意味着需要加索引；`index` 是扫描整棵索引树，也应尽量避免；`const` 和 `eq_ref` 表示优化效果最好。

3) **看 key 列**，它是**实际使用的索引**。如果为 `NULL`，说明这条 SQL 没有走索引；而 `possible_keys` 只是候选索引，两者不一致说明优化器放弃了更优的索引。

4) **看 rows 列**，它是**预估要扫描的行数**。这个值和实际扫描行数差距大，说明统计信息过期，需要 `ANALYZE TABLE` 重新收集。

5) **看 Extra 列**判断额外行为：`Using index` 表示**覆盖索引**，不用回表，是好信号；`Using where` 表示有额外过滤；`Using filesort` 表示**需要排序**，可能走临时文件；`Using temporary` 表示用到了临时表；`Using join buffer (Block Nested Loop)` 表示 join 时被驱动表用在了内存缓冲中。

6) **看 key_len 列**判断**索引的使用程度**。在联合索引中，key_len 越长说明用到的索引列越多（可据此验证最左前缀是否生效）。定长类型（int、char）长度为固定，varchar 还要加上长度字节。

7) **看 rows、filtered 和 Extra 组合判断扫描代价**。`filtered` 是过滤后剩余的百分比，rows 乘以 filtered 才是真正参与比较的数据量。三者结合能大致判断这条查询扫描的数据量级。

8) **与其他工具配合**。`EXPLAIN` 只看单条 SQL，而 `EXPLAIN ANALYZE` 能给出真实执行数据；对于复杂的 join 和子查询，还可以用 `optimizer_trace` 追踪优化器的决策过程；再配合慢查询日志与 `performance_schema` 定位问题 SQL。分析时要重点关注**实际扫描行数与预估行数的偏差**，这个偏差往往是优化器选错索引的根因。
