// 用 CDP 验证后台页面：登录 → 截图
const PORT = 9222;
const URL_ = process.argv[2] ?? "http://127.0.0.1:8787/admin/";
const PASSWORD = process.argv[3] ?? "";
const OUT = process.argv[4] ?? "D:/06-Agentworkspace/my-blog/.test-admin.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("找不到调试端口");
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

const c = client(await pageTarget());
await c.ready;
await c.send("Page.enable");
await c.send("Runtime.enable");
await c.send("Page.navigate", { url: URL_ });
await sleep(3500);

const state = await c.send("Runtime.evaluate", {
  expression: `(() => {
    const login = document.getElementById('admin-login');
    const dash = document.getElementById('admin-dashboard');
    return JSON.stringify({
      loginVisible: login ? !login.classList.contains('hidden') : null,
      dashVisible: dash ? !dash.classList.contains('hidden') : null,
    });
  })()`,
  returnByValue: true,
});
console.log("初始状态:", state.result.value);

if (PASSWORD) {
  await c.send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.getElementById('admin-password');
      const form = document.getElementById('admin-login-form');
      if (!input || !form) return 'no-form';
      input.value = ${JSON.stringify(PASSWORD)};
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return 'submitted';
    })()`,
    returnByValue: true,
  });
  console.log("已提交密码");

  for (let i = 0; i < 15; i++) {
    await sleep(1500);
    const check = await c.send("Runtime.evaluate", {
      expression: `document.getElementById('admin-dashboard') && !document.getElementById('admin-dashboard').classList.contains('hidden') ? 'ready' : 'waiting'`,
      returnByValue: true,
    });
    if (check.result.value === "ready") break;
  }
}

const summary = await c.send("Runtime.evaluate", {
  expression: `(() => {
    const kpis = Array.from(document.querySelectorAll('#admin-kpis > div')).map(d => d.textContent.replace(/\\s+/g,' ').trim());
    const err = document.getElementById('admin-login-error');
    return JSON.stringify({
      dashboard: document.getElementById('admin-dashboard') && !document.getElementById('admin-dashboard').classList.contains('hidden'),
      loginError: err && !err.classList.contains('hidden') ? err.textContent : null,
      kpis,
      trendBars: document.querySelectorAll('#admin-trend > div').length,
      topRows: document.querySelectorAll('#admin-top-pages > div').length,
      aiRecent: document.querySelectorAll('#admin-ai-recent > div').length,
    });
  })()`,
  returnByValue: true,
});
console.log("面板内容:", summary.result.value);

await sleep(800);
const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
const fs = await import("node:fs/promises");
await fs.writeFile(OUT, Buffer.from(shot.data, "base64"));
console.log("截图:", OUT);
c.close();
