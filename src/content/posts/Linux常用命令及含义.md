---
title: Linux 有哪些常用的命令，分别是什么意思？
published: 2026-10-29
description: Linux 命令可按用途分为九类。下面列出面试与日常开发中最常用的一批，重点说明用途与常见用法，而不是罗列参数
tags: [面试]
category: 操作系统
section: note
draft: false
---
Linux 命令可按用途分为九类。下面列出面试与日常开发中最常用的一批，重点说明**用途与常见用法**，而不是罗列参数。

1) **文件与目录操作**。**`ls`** 列出目录内容（`-l` 详细信息、`-a` 含隐藏文件、`-h` 人类可读大小、`-t` 按时间排序）。**`cd`** 切换目录。**`pwd`** 显示当前目录。**`mkdir -p a/b/c`** 递归创建目录。**`rm -rf`** 强制递归删除（⚠️ **极其危险，生产慎用**）。**`cp -r src dst`** 递归复制。**`mv`** 移动或重命名。**`touch`** 创建空文件或更新时间戳。**`ln -s`** 创建软链接。**`find`** 按条件查找文件（`find . -name "*.log" -mtime +7`）。**`locate`** 查数据库索引（快但不实时）。**`file`** 判断文件类型。**`du -sh dir/*`** 查目录占用（⚠️ 与 `ls -l` 不同，`du` 递归统计实际磁盘占用）。**`df -h`** 查磁盘空间。

2) **查看文件内容**。**`cat`** 全文输出（适合小文件）。**`less`** 分页查看（`q` 退出、`/keyword` 搜索、`G` 到末尾）。**`more`** 基础分页。**`head -n 100`** / **`tail -n 100`** 看头尾。**`tail -f app.log`** ⭐ **实时跟踪日志**（生产排障第一命令）。**`wc -l`** 数行数。**`grep`** 文本搜索（`-i` 忽略大小写、`-v` 反选、`-r` 递归、`-n` 显示行号、`-E` 扩展正则、`-C 3` 显示上下文）。**`awk`** 按列处理（`awk '{print $1}'`）。**`sed`** 流式编辑（`sed -n '10,20p'` 打印行、`sed -i 's/a/b/g'` 替换、`sed -i '$d'` 删最后一行）。

3) **管道与组合（Linux 的灵魂）**。**`|`** 把左边 stdout 接到右边 stdin。**`>`** 覆盖写文件，**`>>`** 追加。**`&&`** 前一条成功才执行后一条，**`||`** 前一条失败才执行后一条，**`;`** 无条件顺序执行。**`&`** 后台运行，**`nohup cmd &`** ⭐ **脱离终端常驻运行**（配合 `> log 2>&1` 重定向）。**`xargs`** 把输入转成命令参数（`cat f | xargs -I{} rm {}`）。**`tee`** 边输出边写文件。

4) **进程管理**。**`ps aux`**（或 `ps -ef`）查看进程。**`top`** / **`htop`** 实时资源占用（按 `P` 按 CPU 排序）。**`kill -9 <pid>`** 强制杀进程（⚠️ `-15` 给个机会更稳妥）。**`killall <name>`** 按名字杀。**`pkill -f "keyword"`** 按命令行匹配。**`jps`** ⭐ **列出本机 Java 进程**（带 PID 与主类）。**`jstack <pid>`** ⭐ **打印 Java 线程栈**（排查死锁必备）。**`jmap`**（堆信息、dump）。**`jstat -gcutil`**（GC 实时统计）。**`nohup`、`jobs`、`bg`、`fg`** 任务控制。**`lsof -i:8080`** ⭐ 查端口占用。**`netstat -tunlp` / `ss -tunlp`** 看网络连接与监听端口。

5) **磁盘与文件系统**。**`df -h`** 空间使用。**`du -sh`** 目录占用。**`lsblk`** 看块设备与挂载点。**`mount`** / **`umount`** 挂载卸载。**`fdisk -l`** / **`lsblk`** 看分区。**`fsck`** 检查文件系统。**`dd if=... of=... bs=...`** 块级拷贝（⚠️ 危险）。**`free -h`** 内存使用。**`swapon`** 交换分区。**`vmstat 1`** ⭐ 资源综合指标（`si/so` 看 swap、`r` 看运行队列、`wa` 看 IO 等待）。**`iostat -x 1`** ⭐ 磁盘 IO 饱和度（`%util`）。**`sar`** 历史性能归档。

6) **网络**。**`ping`** 连通性。**`traceroute` / `tracepath`** 路径追踪。**`telnet <host> <port>`** ⭐ **测端口连通性**（生产常用）。**`curl -v <url>`** 调试 HTTP（`-I` 只看头、`-o` 下载）。**`wget`** 下载。**`nc` / `ncat`** 端口连通与端口转发。**`dig` / `nslookup`** DNS 查询。**`host`** DNS 快速查询。**`ifconfig` / `ip addr`** 网卡与 IP。**`ip route`** 路由表。**`arp`** ARP 缓存。**`netstat` / `ss`** 连接统计。**`tcpdump`** 抓包（`tcpdump -i any -nn port 8080`）。**`mtr`** 持续 ping + 路由。

7) **文本处理三剑客**。**`grep`（找）**、**`sed`（改）**、**`awk`（取列）**。再配 **`sort`（排序）**、**`uniq`（去重）**、**`cut`（切列）**、**`tr`（转换）**、**`paste`（合并）**、**`comm`/`join`（集合运算）**、**`column`（对齐）**。**典型组合**：`grep ERROR app.log | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head` ⭐ **统计 Top 错误来源**，是排障高频组合。

8) **用户与权限**。**`ls -l` 的 `rwx`** 三位含义：所有者/所属组/其他人。**`chmod`** 改权限（`755` / `644`，或 `chmod +x`）。**`chown`** 改属主。**`useradd` / `usermod` / `userdel`** 用户管理。**`passwd`** 改密码。**`su` / `sudo`** 切换与提权。**`id`** 看当前用户与组。**`groupadd`** 建组。

9) **服务与系统管理（systemd）**。**`systemctl start/stop/restart/status <svc>`** ⭐ 服务管理。**`systemctl enable/disable`** 开机自启。**`journalctl -u <svc> -f`** ⭐ **实时看服务日志**。**`systemctl list-units`** 看所有单元。**`crontab -e`** 定时任务（`-l` 查看）。**`at`** 一次性任务。**`date`** 时间（`date -d` 解析、`timedatectl` 时区）。**`hostname`**、**`uname -a`** 内核版本与架构。**`env` / `printenv`** 环境变量。**`alias`** 命令别名。**`history`** 历史命令（`!!` 上一条、`!$` 上一条最后一个参数）。**`which` / `type` / `command -v`** 定位命令。

10) **归档与传输**。**`tar`** 打包（`tar -czvf a.tar.gz dir/`，`tar -xzvf` 解压）。**`zip` / `unzip`**。**`gzip` / `gunzip`**。**`rsync`** ⭐ 增量同步（`-avz --delete`，生产发布常用）。**`scp`** 安全拷贝。**`sftp`** 交互式传输。**`dd`** 块级复制。

11) **Shell 实用技巧（面试加分）**。**`&&` 短路**（`cmd1 && cmd2`）｜**`||` 兜底**（`cmd || fallback`）｜**`$(...)` 与反引号**做命令替换｜**管道组合**｜**`tee`**｜**`xargs`**｜**`&` 后台 + `nohup`**｜**`2>&1` 合并 stderr 到 stdout**｜**`/dev/null` 丢弃输出**｜**`grep -C` 带上下文**｜**`watch -n 1 cmd` 周期执行**（观察指标变化）｜**`history | grep`**。

12) **排查线上问题的"黄金组合"**。**看进程**：`ps aux | grep xxx`、`jps`｜**看端口**：`lsof -i:8080`、`ss -tunlp`｜**看日志**：`tail -f`、`grep -C 5 ERROR`｜**看资源**：`top`、`free -h`、`df -h`、`vmstat 1`、`iostat -x 1`｜**看网络**：`curl -v`、`telnet`、`tcpdump`｜**看 Java**：`jstack`、`jstat -gcutil`、`jmap -histo:live`｜**看文件**：`du -sh`、`find -mtime`｜**看定时**：`crontab -l`。

13) **面试答法建议**。不要罗列命令清单 —— 按**分类 + 典型场景 + 组合用法**来讲更有说服力。三点：**① 分类（文件/查看/进程/网络/磁盘/权限/系统管理）；② 强调"组合思维"** —— Linux 的威力在管道，`grep|awk|sort|uniq|head` 这类组合比单命令更有价值；**③ 落到线上排障实战**（`tail -f` 看日志、`jstack` 看线程、`lsof -i` 找端口占用、`vmstat`/`iostat` 看瓶颈），并提醒危险命令（`rm -rf`、`dd`、`kill -9`）。
