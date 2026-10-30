// CDP 截图：登录后台并按指定视口截图（桌面/手机）
const PORT = 9222;
const URL_ = process.argv[2] ?? "http://127.0.0.1:8787/admin/";
const PASSWORD = process.argv[3] ?? "";
const WIDTH = Number(process.argv[4] ?? 1440);
const HEIGHT = Number(process.argv[5] ?? 1000);
const OUT = process.argv[6] ?? "D:/06-Agentworkspace/my-blog/.shot.png";
const DARK = (process.argv[7] ?? "light") === "dark";
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
await c.send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: WIDTH < 600,
});
await c.send("Page.navigate", { url: URL_ });
await sleep(2500);

if (DARK) {
  await c.send("Runtime.evaluate", {
    expression: `document.documentElement.classList.add('dark')`,
  });
  await sleep(600);
}

if (PASSWORD) {
  await c.send("Runtime.evaluate", {
    expression: `(() => {
      const gate = document.getElementById('gate');
      if (gate && !gate.hidden) {
        const input = document.getElementById('password');
        const form = document.getElementById('login-form');
        input.value = ${JSON.stringify(PASSWORD)};
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return 'login-submitted';
      }
      return 'already-in';
    })()`,
    returnByValue: true,
  });
  for (let i = 0; i < 20; i++) {
    await sleep(1200);
    const state = await c.send("Runtime.evaluate", {
      expression: `document.getElementById('console') && !document.getElementById('console').hidden ? 'ready' : 'waiting'`,
      returnByValue: true,
    });
    if (state.result.value === "ready") break;
  }
}

await sleep(2200);
const info = await c.send("Runtime.evaluate", {
  expression: `(() => {
    const items = Array.from(document.querySelectorAll('.ledger-item')).map(d => d.textContent.replace(/\\s+/g,' ').trim());
    return JSON.stringify({
      ledger: items,
      rankRows: document.querySelectorAll('#ranking li').length,
      logRows: document.querySelectorAll('#log li').length,
      ring: document.getElementById('ring-value')?.textContent,
      stamp: document.getElementById('stamp')?.textContent,
    });
  })()`,
  returnByValue: true,
});
console.log(info.result.value);

const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
const fs = await import("node:fs/promises");
await fs.writeFile(OUT, Buffer.from(shot.data, "base64"));
console.log("截图:", OUT);
c.close();
