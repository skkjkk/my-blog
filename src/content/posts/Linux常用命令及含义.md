---
title: Linux 有哪些常用的命令，分别是什么意思？
published: 2026-10-29
description: 按文件目录、内容查看、管道组合、进程、磁盘内存、网络、文本处理、权限与系统管理九类，说明 Linux 常用命令的用途与关键参数。
tags: [面试]
category: 操作系统
section: note
draft: false
---
Linux 常用命令按用途可分为**文件与目录、查看内容、管道与组合、进程管理、磁盘与内存、网络、文本处理、用户与权限、服务与系统管理**九类；回答这类问题要说清每类的代表命令、关键参数和典型场景，而不是背参数表。真正拉开差距的是**组合思维**：Linux 的威力在管道，把 `grep`、`awk`、`sort`、`uniq` 串起来，一条命令就能从日志里统计出 Top 错误来源。

## 九类命令的分类地图

先建立分类地图，面试时按类别讲，比从头背命令清单有效得多。

| 类别 | 代表命令 | 典型场景 |
| --- | --- | --- |
| 文件与目录 | `ls`、`cd`、`pwd`、`mkdir`、`rm`、`cp`、`mv`、`ln`、`find`、`locate`、`file` | 定位、整理、清理文件 |
| 查看内容 | `cat`、`less`、`head`、`tail`、`wc`、`grep`、`awk`、`sed` | 看日志、搜关键字、抽字段 |
| 管道与组合 | 管道符、重定向、`nohup`、`xargs`、`tee` | 把单条命令拼成处理流程 |
| 进程管理 | `ps`、`top`、`kill`、`pkill`、`jps`、`jstack`、`lsof`、`ss` | 找进程、看线程栈、查端口 |
| 磁盘与内存 | `df`、`du`、`lsblk`、`mount`、`dd`、`free`、`vmstat`、`iostat`、`sar` | 查空间与 IO 瓶颈 |
| 网络 | `ping`、`traceroute`、`telnet`、`curl`、`dig`、`ip`、`tcpdump`、`mtr` | 连通性、DNS、抓包 |
| 文本处理 | `grep`、`sed`、`awk`、`sort`、`uniq`、`cut`、`tr`、`join`、`column` | 日志统计与数据清洗 |
| 用户与权限 | `chmod`、`chown`、`useradd`、`passwd`、`su`、`sudo`、`id` | 授权、切换用户 |
| 系统管理与归档 | `systemctl`、`journalctl`、`crontab`、`uname`、`env`、`history`、`tar`、`rsync`、`scp` | 服务、定时、打包同步 |

## 文件、目录与查看内容

这一组是日常敲得最多的命令，重点记**能改变磁盘状态的**和**能快速定位问题的**。

- **`ls`** 列出目录内容：`-l` 详细信息、`-a` 含隐藏文件、`-h` 人类可读大小、`-t` 按修改时间排序。
- **`cd`** 切换目录、**`pwd`** 显示当前目录、**`mkdir -p a/b/c`** 递归创建多级目录。
- **`rm -rf`** 强制递归删除，⚠️ **极其危险，生产环境慎用**；**`cp -r src dst`** 递归复制；**`mv`** 移动或重命名；**`touch`** 创建空文件或更新时间戳；**`ln -s`** 创建软链接。
- **`find`** 按条件查找文件，例如 `find . -name "*.log" -mtime +7` 找七天前的日志；**`locate`** 查预建索引，快但**不实时**（新文件可能查不到）；**`file`** 按内容判断文件真实类型，不看扩展名。
- **`du -sh dir/*`** 递归统计目录**实际磁盘占用**；**`df -h`** 看文件系统剩余空间。⚠️ `du` 与 `ls -l` 的口径不同，前者按块统计占用，不能相互替代。
- **`cat`** 全文输出，适合小文件；**`less`** 分页查看（`q` 退出、`/keyword` 搜索、`G` 到末尾）；**`more`** 基础分页；**`head -n 100`** / **`tail -n 100`** 看头尾；**`wc -l`** 数行数。
- **`tail -f app.log`** ⭐ **实时跟踪日志**，生产排障第一命令；日志被轮转后普通 `-f` 会跟丢，改用 `tail -F`。
- **`grep`** 文本搜索：`-i` 忽略大小写、`-v` 反选、`-r` 递归、`-n` 显示行号、`-E` 扩展正则、`-C 3` 显示前后上下文。
- **`awk`** 按列处理，例如 `awk '{print $1}'` 取第一列；**`sed`** 流式编辑：`sed -n '10,20p'` 打印指定行、`sed -i 's/a/b/g'` 原地替换、`sed -i '$d'` 删除最后一行。

## 管道与文本处理的组合

管道是 Linux 的灵魂：每个命令只做一件事，串起来才是完整的能力。左边命令的标准输出接到右边命令的标准输入，就是**管道符**的作用。

- **重定向**：`>` 覆盖写文件、`>>` 追加写文件。⚠️ `>` 会先把文件清空，写错目标就丢数据。
- **执行控制**：`&&` 前一条成功才执行后一条、`||` 前一条失败才执行后一条、`;` 无条件顺序执行。
- **后台运行**：`&` 后台运行，**`nohup cmd > log 2>&1 &`** ⭐ **脱离终端常驻运行**；`2>&1` 把 stderr 合并进 stdout，`> /dev/null` 丢弃输出。
- **参数传递**：`xargs` 把输入转成命令参数，例如 `cat f | xargs -I{} rm {}`；**`tee`** 边输出到屏幕边写文件。
- **命令替换**：`$(...)` 与反引号把一条命令的输出当成另一条命令的参数，例如 `kill -15 $(pgrep -f xxx)`；嵌套时优先用 `$(...)`，反引号不好嵌套。
- **观察与回顾**：`watch -n 1 cmd` 周期执行观察指标变化；`history | grep xxx` 翻历史命令。
- **文本处理三剑客**：**`grep`（找）**、**`sed`（改）**、**`awk`（取列）**；再配 **`sort`（排序）**、**`uniq`（去重）**、**`cut`（切列）**、**`tr`（转换）**、**`paste`（合并）**、**`comm`/`join`（集合运算）**、**`column`（对齐）**。

典型组合，日常排障里出现频率极高：

```bash
grep ERROR app.log | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head
```

上面这条命令做四件事：按冒号切出第一列、排序去重计数、按次数倒序、取前 10 条，从而统计出 Top 错误来源。其中 `-F:` 与 `$1` 要按实际日志格式调整——分隔符和字段号决定你抽出来的到底是不是「来源」。

另一个高频用法是实时过滤日志并保留上下文：

```bash
tail -F app.log | grep -C 3 ERROR
```

## 进程、端口与线上排障

排障第一步永远是「谁在跑、占了多少、卡在哪」。

- **看进程**：`ps aux`（或 `ps -ef`）列出进程，`ps aux | grep xxx` 是最常见的定位方式。
- **看资源**：`top` / `htop` 实时资源占用，`top` 里按 `P` 按 CPU 排序、按 `M` 按内存排序。
- **杀进程**：`kill -15 <pid>`（默认 TERM，给进程清理收尾的机会）、`kill -9 <pid>`（SIGKILL 强制杀死，⚠️ 不给清理机会，可能留下临时文件与断开的连接）；`killall <name>` 按进程名杀、`pkill -f "keyword"` 按完整命令行匹配。
- **Java 排障工具**：`jps` ⭐ **列出本机 Java 进程**（带 PID 与主类）、`jstack <pid>` ⭐ **打印线程栈**（排查死锁必备）、`jmap` 看堆信息与生成 dump、`jstat -gcutil` 看 GC 实时统计。
- **任务控制**：`nohup`、`jobs`、`bg`、`fg` 管理前台与后台任务。
- **端口与连接**：`lsof -i:8080` ⭐ 查端口被谁占用；`netstat -tunlp` / `ss -tunlp` 看监听端口与连接（`ss` 属 iproute2，输出更快，新系统优先用它）。
- **线上排障黄金组合**：看进程 `ps aux | grep xxx`、`jps`；看端口 `lsof -i:8080`、`ss -tunlp`；看日志 `tail -f`、`grep -C 5 ERROR`；看资源 `top`、`free -h`、`df -h`、`vmstat 1`、`iostat -x 1`；看网络 `curl -v`、`telnet`、`tcpdump`；看 Java `jstack`、`jstat -gcutil`、`jmap -histo:live`；看文件 `du -sh`、`find -mtime`；看定时 `crontab -l`。

## 磁盘、内存与 IO 指标

容量类命令看「还有多少」，指标类命令看「瓶颈在哪」。

- **`df -h`** 各文件系统空间使用；**`du -sh dir`** 单个目录占用，`du -h --max-depth=1 /` 逐个一级目录比大小，用来找「谁把盘吃满了」。
- **`lsblk`** 看块设备与挂载点；**`fdisk -l`** 看分区表；**`mount`** / **`umount`** 挂载与卸载；**`fsck`** 检查修复文件系统（需先卸载）。
- **`dd if=... of=... bs=...`** 块级拷贝，⚠️ **写错 `of` 会直接毁盘**。
- **`free -h`** 内存使用，重点看 `available` 而不是 `free`，因为 page cache 占的内存可被回收。
- **`swapon`** / `swapoff` 管理交换分区。
- **`vmstat 1`** ⭐ 资源综合指标：`r` 看运行队列、`si`/`so` 看 swap 换入换出、`wa` 看 IO 等待。
- **`iostat -x 1`** ⭐ 磁盘 IO 饱和度，重点看 `%util` 与 `await`。
- **`sar`** 历史性能归档，用于事后回溯某个时间点的 CPU、内存、IO 曲线。

## 网络排查

网络问题按「通不通 → 端口通不通 → 应用层对不对 → 数据包丢在哪」逐层往下走。

- **`ping`** 测连通性（ICMP）；**`traceroute` / `tracepath`** 追踪路径。
- **`telnet <host> <port>`** ⭐ **测端口连通性**，生产最常用的土办法；`nc -zv <host> <port>` 等价且更明确。
- **`curl -v <url>`** 调试 HTTP（`-I` 只看响应头、`-o` 存文件）；**`wget`** 下载。
- **`nc` / `ncat`** 端口连通测试与端口转发。
- **`dig` / `nslookup` / `host`** 查 DNS 解析。
- **`ifconfig` / `ip addr`** 看网卡与 IP、**`ip route`** 看路由表、**`arp`** 看 ARP 缓存；其中 `ifconfig`、`arp` 属 net-tools，很多新发行版默认不装，等价写法是 `ip addr`、`ip neigh`。
- **`tcpdump`** 抓包，例如 `tcpdump -i any -nn port 8080`；**`mtr`** 持续 ping 加路由，能看出丢包发生在哪一跳。

## 权限、服务、定时与归档

- **权限位**：`ls -l` 的 `rwx` 三段依次是所有者、所属组、其他人；`chmod 755`（rwxr-xr-x）、`chmod 644`（rw-r--r--）、`chmod +x` 加执行权限；**`chown`** 改属主（`-R` 递归）；**`id`** 看当前用户与所属组。
- **用户与组**：`useradd` / `usermod` / `userdel` 管用户，`passwd` 改密码，`groupadd` 建组，`su` / `sudo` 用于切换与提权。
- **服务管理**：`systemctl start/stop/restart/status <svc>` ⭐ 管服务、`systemctl enable/disable` 管开机自启、`systemctl list-units` 看所有单元、`journalctl -u <svc> -f` ⭐ **实时看服务日志**。
- **定时任务**：`crontab -e` 编辑、`crontab -l` 查看；`at` 跑一次性任务。
- **系统信息**：`date`（`date -d` 解析时间）、`timedatectl` 管时区、`hostname`、`uname -a` 看内核版本与架构、`env` / `printenv` 看环境变量。
- **辅助命令**：`alias` 设别名、`history` 看历史（`!!` 上一条命令、`!$` 上一条命令的最后一个参数）、`which` / `type` / `command -v` 定位命令（`type` 还能区分别名、内建与外部命令）。
- **归档与传输**：`tar -czvf a.tar.gz dir/` 打包、`tar -xzvf` 解压；`zip` / `unzip`、`gzip` / `gunzip`；**`rsync -avz --delete`** ⭐ 增量同步，生产发布常用，⚠️ `--delete` 会删掉目标端多余文件，先加 `--dry-run` 看清单；`scp` 安全拷贝、`sftp` 交互式传输。

## 常见追问与面试怎么答

答题思路四步，比背命令清单有说服力：先给分类，再强调组合思维，然后落到线上排障实战，最后主动提醒危险命令（`rm -rf`、`dd`、`kill -9`）。

**Q1：`ls -l` 看到的文件大小和 `du` 统计出来的为什么不一样？**
A：`ls -l` 给的是文件逻辑长度，`du` 按磁盘块统计实际占用；稀疏文件、块对齐（小文件也占一个块）、目录自身开销都会让两者不同，排查磁盘满要用 `du`。

**Q2：端口被占用，怎么定位和处理？**
A：`ss -tunlp | grep 8080` 或 `lsof -i:8080` 拿到 PID，再用 `ps -f -p <pid>` 确认是哪个进程，先 `kill -15` 让它优雅退出，不行再 `kill -9`。

**Q3：`nohup` 起了服务，退出终端后还是断了，为什么？**
A：多数是输出没重定向，终端关闭后写标准输出报错退出；写成 `nohup cmd > app.log 2>&1 < /dev/null &` 三个流都处理掉，再用 `ps aux | grep` 确认进程还在。

**Q4：线上 CPU 打满，怎么一步步定位？**
A：`top` 找占用最高的进程，`top -Hp <pid>` 找具体线程，线程 ID 转十六进制后到 `jstack` 里对照栈；若 `wa` 高说明在等 IO，转 `iostat -x 1` 看是哪块盘被打满。

## 易错点

- **`ps aux | grep xxx` 会匹配到 grep 自己**：正确写法是 `ps aux | grep "[x]xx"`、`grep -v grep`，或者直接用 `pgrep -f xxx`。
- **`df` 显示磁盘满，`du` 加起来却不大**：典型原因是有文件已被删除但仍被进程打开，空间没释放，用 `lsof | grep deleted` 找出来重启对应进程即可。
- **`rm -rf $DIR/` 在变量为空时等于删根目录**：脚本里先判空，例如 `[ -n "$DIR" ] && rm -rf "$DIR"`，或开启 `set -u`。
- **用 `tail -f` 跟日志，轮转后不更新**：`-f` 跟的是文件描述符，日志被 rename 后就跟丢了，要改用 `tail -F`（按文件名重新打开）。

:::tip
Linux 的关键不是背命令，而是按场景选命令、用管道把它们串起来。
:::
