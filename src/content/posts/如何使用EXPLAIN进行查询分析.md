---
title: 如何使用 MySQL 的 EXPLAIN 语句进行查询分析？
published: 2026-10-23
description: EXPLAIN 让优化器交出执行计划而不真正执行 SQL，输出访问类型、实际使用的索引、预估扫描行数与额外行为，是 SQL 调优的第一诊断工具。
tags: [面试]
category: 数据库
section: note
draft: false
---
`EXPLAIN` 是 SQL 调优的第一诊断工具，它不执行语句，只让优化器交出一份执行计划：这条查询打算用哪个索引、按什么顺序访问表、预估扫多少行。分析时按固定顺序看三件事——先用 `type` 和 `key` 判断索引到底有没有用上，再用 `rows` 和 `filtered` 判断扫描量级、判断统计信息是否过期，最后用 `Extra` 判断有没有回表、排序和临时表；怀疑预估不准，就换 `EXPLAIN ANALYZE` 对比实际执行数据。

## 怎么用：一条语句拿到执行计划

在 SQL 前面加 `EXPLAIN` 即可，语句本身不会被真正执行。输出是一行行执行计划，每行对应一个表或一个访问节点，关键列有 `id`（查询序号）、`select_type`、`table`、`type`、`possible_keys`、`key`、`key_len`、`ref`、`rows`、`filtered`、`Extra`。

```sql
EXPLAIN SELECT * FROM user WHERE id = 1;
-- MySQL 8.0 起还可以输出更详细的计划
EXPLAIN FORMAT=JSON SELECT * FROM user WHERE id = 1;   -- JSON 格式，含成本估算
EXPLAIN ANALYZE SELECT * FROM user WHERE id = 1;       -- 真正执行，给出实际数据
```

`FORMAT=JSON` 多出来的价值是能看到优化器估算的成本；`EXPLAIN ANALYZE` 则会真正执行语句，并输出每个执行节点的实际行数、耗时与循环次数，是定位「估算与实际不符」的最强工具。也正因为它会真的跑，对写语句（`UPDATE`、`DELETE`）要格外小心。

## 先看 type：访问类型决定扫描方式

`type` 是判断索引是否生效最直接的依据。性能从优到劣大致是 `system` > `const` > `eq_ref` > `ref` > `range` > `index` > `ALL`：

| type | 含义 | 典型场景 |
| --- | --- | --- |
| system | 表里只有一行，最理想的访问类型 | 系统表、只有一行的中间结果 |
| const | 通过主键或唯一索引等值定位，最多命中一行 | `WHERE id = 1` |
| eq_ref | join 时被驱动表按主键或唯一索引匹配，每次只取一行 | 主键关联查询 |
| ref | 用非唯一索引等值匹配，可能命中多行 | `WHERE name = 'x'` |
| range | 索引上的范围扫描 | `BETWEEN`、`>`、`IN` |
| index | 扫描整棵索引树，即全索引扫描 | 覆盖索引但没有过滤条件 |
| ALL | 全表扫描 | 没有可用索引 |

看到 `ALL` 通常意味着需要加索引；`index` 虽然走的是索引，但等于把整棵索引树扫一遍，也应尽量避免；`const` 和 `eq_ref` 表示优化效果最好。

## 再看 key 与 possible_keys：索引到底用没用上

`key` 是这条 SQL **实际使用的索引**，如果为 `NULL`，说明没有走索引。`possible_keys` 只是优化器考虑过的候选索引，两者不一致时，往往说明优化器估算后放弃了看起来更合适的索引——这时候要回头看 `rows`、`filtered` 和统计信息，而不是急着再加索引。

## rows 与 filtered：估算扫描量级，判断统计信息是否过期

`rows` 是优化器**预估要扫描的行数**，不是实际值。如果它和实际扫描行数差距很大，通常说明统计信息过期，需要 `ANALYZE TABLE` 重新收集。`filtered` 是走完索引条件后剩余的百分比，`rows` 乘以 `filtered` 才是真正参与后续比较的数据量。把两者和 `Extra` 合起来看，就能大致判断这条查询扫描的数据量级。

## Extra：回表、排序、临时表这些信号

`Extra` 记录执行时的额外行为，几个常见取值的含义是：

- `Using index`：用到了**覆盖索引**，不需要回表，是好信号。
- `Using where`：在存储引擎取回数据后还有额外过滤条件。
- `Using filesort`：需要额外排序，可能落到临时文件上，通常要为排序用到的列建立合适的索引。
- `Using temporary`：用到了临时表，常见于 `GROUP BY`、`DISTINCT` 和某些子查询。
- `Using join buffer (Block Nested Loop)`：join 时被驱动表的数据被放进了内存 join buffer，说明被驱动表的关联列缺少可用索引。

## key_len：验证联合索引的最左前缀

`key_len` 反映**索引的使用程度**。在联合索引中，`key_len` 越长说明用到的索引列越多，因此可以拿它验证最左前缀是否生效。长度的计算和列类型有关：定长类型（`int`、`char`）是固定长度，`varchar` 还要额外加上长度字节，允许 `NULL` 的列也要多算一位。用实际 `key_len` 和索引定义反推，就知道索引被用到了第几列。

## 和 EXPLAIN ANALYZE、optimizer_trace、慢日志配合

`EXPLAIN` 只看单条 SQL 的估算计划，`EXPLAIN ANALYZE` 能给出真实执行数据，两者对照就能看出偏差落在哪个节点。对于复杂的 join 和子查询，还可以用 `optimizer_trace` 追踪优化器选择索引和执行顺序的决策过程；再配合慢查询日志和 `performance_schema` 找出真正需要分析的问题 SQL，而不是凭感觉挑语句。整个分析过程里最值得盯的是**实际扫描行数与预估行数的偏差**，这个偏差往往就是优化器选错索引的根因。

## 常见追问

**Q：`EXPLAIN` 会真的执行 SQL 吗？**

A：不会，它只输出优化器给出的执行计划。会真正执行的是 `EXPLAIN ANALYZE`，所以对写语句要先确认影响范围，或者放到事务里执行后回滚。

**Q：`type` 是 `ALL`，就一定要加索引吗？**

A：不一定。表很小、或者查询本身就要返回大部分行时，全表顺序扫描可能比走索引加回表更划算，先看 `rows` 和 `filtered` 再决定。

**Q：明明建了索引，`key` 却还是 `NULL`，为什么？**

A：常见原因是列被函数或运算包裹、参数类型与列类型不一致导致隐式转换、违反联合索引最左前缀，或者优化器估算走索引成本更高。

**Q：`rows` 和实际扫描行数差得远，怎么处理？**

A：先用 `ANALYZE TABLE` 更新统计信息，再用 `EXPLAIN ANALYZE` 看真实行数落在哪个节点；如果偏差仍然很大，再检查是否有多列之间的相关性、索引是否被用错了列。

## 易错点

- 「`EXPLAIN` 会把 SQL 跑一遍」——错，它只出计划；真正执行的是 `EXPLAIN ANALYZE`。
- 「`key` 有值就说明索引用得没问题」——错，还要看 `key_len` 用到了第几列、`rows` 是否可接受、`Extra` 里有没有回表、排序和临时表。
- 「`possible_keys` 为空就是没建索引」——错，可能是建了但用不上，比如列被函数包裹、类型隐式转换或最左前缀断裂。
- 「`type` 排序靠前就一定更好」——不完全对，要结合数据分布和返回行数看，返回大量行时 `range` 未必优于其他方式。
- 「`rows` 是实际扫描行数」——错，那是估算值，实际值要靠 `EXPLAIN ANALYZE` 拿到。

## 一句话记住

:::tip
EXPLAIN 不执行只出计划：先看 type 和 key，再核 rows 与 Extra。
:::
