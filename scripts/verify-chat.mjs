// 用 Chrome DevTools Protocol 验证 AI 浮窗（无第三方依赖，Node 24 自带 WebSocket）
const PORT = 9222;
const TARGET_URL = process.argv[2] ?? "http://127.0.0.1:8787/";
const OUT = process.argv[3] ?? "D:/06-Agentworkspace/my-blog/.test-chat.png";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("找不到 Chrome 调试端口");
}

function createClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const messageId = ++id;
      ws.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

const wsUrl = await getPageTarget();
const client = createClient(wsUrl);
await client.ready;

await client.send("Page.enable");
await client.send("Runtime.enable");
await client.send("Page.navigate", { url: TARGET_URL });
await sleep(4000);

const consoleErrors = [];
await client.send("Log.enable").catch(() => {});

const step1 = await client.send("Runtime.evaluate", {
  expression: `(() => {
    const fab = document.getElementById('ai-chat-toggle');
    if (!fab) return 'no-fab';
    fab.click();
    const panel = document.getElementById('ai-chat-panel');
    return panel && !panel.hidden ? 'panel-open' : 'panel-closed';
  })()`,
  returnByValue: true,
});
console.log("打开浮窗:", step1.result.value);

const step2 = await client.send("Runtime.evaluate", {
  expression: `(() => {
    const input = document.getElementById('ai-chat-input');
    const form = document.getElementById('ai-chat-form');
    if (!input || !form) return 'missing';
    input.value = '这个博客写了什么？';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 'sent';
  })()`,
  returnByValue: true,
});
console.log("发送问题:", step2.result.value);

// 等接口返回
let answer = "";
for (let i = 0; i < 20; i++) {
  await sleep(2000);
  const check = await client.send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('#ai-chat-messages .ai-msg')).map(n => n.className + '::' + n.textContent).join('\\n')`,
    returnByValue: true,
  });
  answer = check.result.value ?? "";
  if (!answer.includes("正在")) break;
}
console.log("--- 对话记录 ---");
console.log(answer);

const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs/promises");
await fs.writeFile(OUT, Buffer.from(screenshot.data, "base64"));
console.log("截图已保存:", OUT);

client.close();
