---
title: NIO 多路复用如何实现？
published: 2026-10-29
description: NIO 多路复用用一个 Selector 线程统一监视多个 Channel 的就绪事件，底层是 epoll、kqueue 或 IOCP。
tags: [基础, 面试]
category: Java
section: note
draft: false
---
NIO 多路复用的核心是：**用一个线程（Selector）去监视多个 I/O 通道（Channel）的就绪状态**，一旦某个通道有事件（可读/可写/连接就绪），就通知 CPU 调度该线程去处理 —— **用少量线程管理大量连接，避开 BIO 一个连接一个线程的模型**。

## 核心三个组件

- **`Channel`（通道）** —— 双向数据传输通道（`SocketChannel`、`ServerSocketChannel`、`FileChannel`）。**注意它与 BIO 的 `InputStream`/`OutputStream` 的区别：Channel 可读可写，且是异步的**。
- **`Selector`（选择器）** —— ⭐ **多路复用的核心**。一个 Selector 可以注册**多个 Channel**，并维护**就绪事件集合**。
- **`SelectionKey`（选择键）** —— Channel 与 Selector 的**注册关系**，同时携带**事件类型**（`OP_ACCEPT`/`OP_CONNECT`/`OP_READ`/`OP_WRITE`）与**附件（attachment）**（用于携带上下文，如连接对象）。

## 实现原理：三步注册-检测-处理

```
① 注册：channel.register(selector, OP_ACCEPT)
② 检测：selector.select() 阻塞直到有就绪事件
③ 处理：selector.selectedKeys() 取出就绪的 key，按事件类型分发处理

```
**核心机制是底层的多路复用系统调用**：
- **Linux → `epoll`**（epoll_create / epoll_ctl / epoll_wait）
- **macOS/BSD → `kqueue`**
- **Windows → `select` / `IOCP`**（Windows 上 NIO 的实现与 Unix 不同，是真正的异步 IO）

:::tip
**JDK 封装了差异，Java 层代码在三个平台写法一致** —— 这是 NIO 最大的价值之一。
:::

## `Selector` 的三种注册方式

- **单线程阻塞**：`selector.select()` 阻塞直到有事件（最常见）
- **单线程非阻塞**：`selectNow()` + 手动循环
- **多线程（⭐ 实际生产的高并发模型）**：**一个 acceptor 线程**独占 `ServerSocketChannel` 处理 `OP_ACCEPT`，**把 accepted 的 SocketChannel 注册给一个 worker Selector**（由 **N 个 worker 线程**竞争 `select()`）—— 每个连接**只会被一个 worker 处理**，避免竞争。

## 四种事件类型

- **`OP_ACCEPT`** —— 有新连接到达（**只有 ServerSocketChannel 能注册**）
- **`OP_CONNECT`** —— 连接建立完成
- **`OP_READ`** —— 通道可读（有数据可读 / 对端关闭）
- **`OP_WRITE`** —— 通道可写（**⚠️ 注意：几乎总是就绪，必须真正写完才取消注册，否则 CPU 空转 100%**）

## 四个关键 API

- **`selector.select()`** —— 阻塞直到有就绪事件；**返回就绪的 key 数量**
- **`selector.selectedKeys()`** —— 取出就绪的 `SelectionKey` 集合（**每次处理完必须 `iterator.remove()`**，否则下次会重复处理）
- **`selector.selectNow()`** —— 不阻塞，立即返回
- **`key.interestOps(...)`** —— **动态修改关注的事件**（如连接注册时只关心 `OP_READ`，写完再 `interestOps(OP_READ | OP_WRITE)`）

## 写事件的处理是 NIO 最大的坑

`OP_WRITE` **几乎永远处于就绪状态**（因为发送缓冲区通常是空的）。若注册了 `OP_WRITE` 却不真正写数据，**Selector 会不断返回该事件，导致 CPU 空转到 100%**。

:::tip
**正确做法**：**只在真正有数据要发时才注册 `OP_WRITE`，写完立刻取消**（`interestOps(interestOps & ~OP_WRITE)`）。或者**只在写事件回调中尝试写，写不完整时保留注册、写完再取消**。
:::

## 完整代码骨架

下面是最小可用的 Reactor 骨架：注册 `OP_ACCEPT` → `select()` 阻塞等待 → 遍历 `selectedKeys()` 按事件类型分发。读这段代码时盯住三处：通道必须先 `configureBlocking(false)`，每个 key 处理完要 `iterator.remove()`，`read()` 返回 `-1` 说明对端已关闭、要主动 `close()`。

```java
Selector selector = Selector.open();
ServerSocketChannel ssc = ServerSocketChannel.open();
ssc.bind(new InetSocketAddress(8080));
ssc.configureBlocking(false);                      // 必须设为非阻塞
ssc.register(selector, SelectionKey.OP_ACCEPT);

while (true) {
    selector.select();                              // 阻塞直到有事件
    Iterator<SelectionKey> it = selector.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        it.remove();                                // ⚠️ 必须移除
        if (key.isAcceptable()) {
            SocketChannel ch = ssc.accept();
            ch.configureBlocking(false);
            ch.register(selector, SelectionKey.OP_READ);
        } else if (key.isReadable()) {
            SocketChannel ch = (SocketChannel) key.channel();
            ByteBuffer buf = ByteBuffer.allocate(1024);
            int n = ch.read(buf);                    // ⚠️ 必须处理返回值
            if (n == -1) {                          // 对端关闭
                key.cancel();
                ch.close();
            } else {
                buf.flip();
                // 处理数据...
            }
        }
    }
}

```

## 易错点：三个必须记住的坑

- **直觉是「Selector 也能监视阻塞通道」** —— 错：**必须 `configureBlocking(false)`**，Selector 只支持非阻塞通道，忘了设会抛 `IllegalBlockingModeException`。
- **直觉是「处理完的 key 会自动消失」** —— 错：**`selectedKeys()` 必须 `iterator.remove()`**，否则下次 `select()` 会重复处理已经处理过的 key。
- **直觉是「`read()` 一次就能读完整条消息」** —— 错：**`read()` 的返回值必须检查**，**`-1` 表示对端已关闭连接**（这是很多 NIO 程序的 bug 来源）；而且 SocketChannel **单次 read 可能读不满**，需要**累积到完整消息**才能处理（**半包问题**，需自定义协议如长度前缀）。

## NIO 的三大组件

- **Channel**（通道）—— 双向、可异步
- **Buffer**（缓冲区）—— 数据容器，**必须配合 `flip()`/`clear()` 在读写模式间切换**（`flip()` 把写模式切换到读模式并重置 position）
- **Selector**（选择器）—— 多路复用核心

## NIO 的三个著名缺陷

- **① 著名的 epoll 空轮询 Bug（与 JDK 版本相关）**：Linux 上 `epoll_wait` 在某些内核版本下会**持续返回 0 却没有事件**，导致 CPU 100%。**JDK 的修复方案是统计 `select` 调用次数，当连续多次 `select` 返回 0 时重建 `Selector` 并把 Key 重新注册**，而 **Netty 等框架也自己实现了这套规避逻辑**。
- **② 管道文件传输** —— `FileChannel.transferTo` 在 Linux 上用零拷贝（`sendfile`），但**只能传文件、不能传 SocketChannel**；跨线程传输需用 `transferTo` + `WritableByteChannel`（且**仅当目标 Channel 实现了 `ScatteringByteChannel` 才真正零拷贝**）。
- **③ 一对多（FileChannel → 多 Socket）需要手动维护多个 Buffer**，JDK 未提供便捷实现（**Netty 用 `FileRegion` 封装了它**）。

## Netty 是 NIO 的封装与修正

**Netty 解决了 NIO 的上述缺陷**：内置**epoll 空轮询规避**（`io.netty.channel.epoll.EpollEventLoop`）、提供 **`FileRegion` 零拷贝**、提供**内存池（PooledByteBufAllocator）**避免频繁 GC、**Pipeline 与编解码器**简化协议开发、**Backpressure**（写缓冲满时暂停读取）。**生产环境的高并发网络服务基本都用 Netty 而不是裸 NIO。**

## 常见追问

**问：NIO 多路复用的核心是什么，底层靠什么系统调用实现？**
**答：** 三组件分工是 `Channel` 传数据、`Selector` 维护就绪事件集合、`SelectionKey` 记录注册关系与事件类型；底层在 Linux 是 `epoll`（epoll_create/epoll_ctl/epoll_wait）、macOS/BSD 是 `kqueue`、Windows 是 `select`/`IOCP`，JDK 封装差异，所以三个平台写法一致。

**问：生产环境真的只用一个线程处理所有连接吗？**
**答：** 不是。主流做法是一个 acceptor 线程独占 `ServerSocketChannel` 处理 `OP_ACCEPT`，把 accept 到的 `SocketChannel` 注册给 worker Selector，由 N 个 worker 线程竞争 `select()`；每个连接只会被一个 worker 处理，从而避免竞争。

**问：裸写 NIO 最容易踩哪些坑？**
**答：** 通道必须先 `configureBlocking(false)`（否则抛 `IllegalBlockingModeException`）、处理完的 key 必须 `iterator.remove()`、`read()` 返回 `-1` 表示对端关闭；另外 `OP_WRITE` 几乎总是就绪，注册了却不写会让 Selector 空转把 CPU 打到 100%，所以只在真有数据要发时才注册、写完立刻取消。

**问：既然 JDK 自带 NIO，为什么生产的高并发服务基本都用 Netty？**
**答：** 因为 NIO 自身有三个缺陷：Linux 上 epoll 空轮询会让 CPU 100%（Netty 内置规避逻辑）、`transferTo` 只能传文件、一对多传输要手动维护多个 Buffer（Netty 用 `FileRegion` 封装）。Netty 还额外提供内存池、Pipeline 与编解码器、Backpressure。

在面试里，第三、四点是区分度最高的部分 —— 只答「Selector 监听多个 Channel」是最浅的回答。

## 一句话记住

:::tip
Selector 一个线程管住所有连接，按就绪事件分发，写完就取消写事件。
:::
