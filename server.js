// 行动提醒 · 推送 + 跨设备同步后端
// 单个用户多设备：schedule / statuses 全局共享，所有设备订阅后都能收到到点 Web Push。
const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data.json");
const VAPID_FILE = path.join(__dirname, ".vapid.json");

// ---- VAPID 密钥（首次启动生成并落地）----
let vapid = {};
try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); } catch (e) {}
if (!vapid.publicKey || !vapid.privateKey) {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid));
}
webpush.setVapidDetails("mailto:action-reminder@example.com", vapid.publicKey, vapid.privateKey);

// ---- 共享存储 ----
function load() {
  try { return JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) {
    return { subs: [], schedule: [], statuses: {} };
  }
}
function save(s) { try { fs.writeFileSync(DATA, JSON.stringify(s)); } catch (e) {} }
let store = load();

const app = express();
app.use(express.json());
// 允许跨域（PWA 在 cloudstudio 域名下，后端在另一域名）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const dsOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

// 给所有订阅设备发推送
function sendAll(title, body, url) {
  const payload = JSON.stringify({ title, body, url: url || "/" });
  let n = 0;
  store.subs.forEach((s) => {
    webpush.sendNotification(s.sub, payload).then(
      () => { n++; },
      (err) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          store.subs = store.subs.filter((x) => x.endpoint !== s.endpoint);
          save(store);
        }
      }
    );
  });
  return n;
}

app.get("/api/vapid", (req, res) => res.json({ publicKey: vapid.publicKey }));

app.post("/api/subscribe", (req, res) => {
  const sub = req.body && req.body.sub;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "no sub" });
  const name = (req.body && req.body.name) || "设备";
  const i = store.subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (i >= 0) store.subs[i] = Object.assign(store.subs[i], { sub, name, at: Date.now() });
  else store.subs.push({ sub, name, at: Date.now() });
  save(store);
  res.json({ ok: true, devices: store.subs.length });
});

app.post("/api/unsubscribe", (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (ep) store.subs = store.subs.filter((s) => s.endpoint !== ep);
  save(store);
  res.json({ ok: true });
});

app.get("/api/sync", (req, res) => res.json({ schedule: store.schedule, statuses: store.statuses }));

// 客户端上报：合并 schedule（最新覆盖）与 statuses（done/skip 一旦任一设备设置即保留）
app.post("/api/sync", (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body.schedule)) store.schedule = body.schedule;
  if (body.statuses && typeof body.statuses === "object") {
    for (const k in body.statuses) {
      const v = body.statuses[k];
      const cur = store.statuses[k];
      if (v === "done" || v === "skip" || !cur) store.statuses[k] = v;
    }
  }
  save(store);
  res.json({ schedule: store.schedule, statuses: store.statuses });
});

// 手动推送（测试 / 主动催）
app.post("/api/push", (req, res) => {
  const b = req.body || {};
  const n = sendAll(b.title || "提醒", b.body || "", b.url);
  res.json({ ok: true, sent: n });
});

// 服务端定时：到点给所有设备发提醒（关掉网页也能收到，前提是装成 PWA 且给了通知权限）
setInterval(() => {
  if (!store.schedule || !store.schedule.length) return;
  const now = new Date();
  const ds = dsOf(now);
  const cur = now.getHours() * 60 + now.getMinutes();
  store.schedule.forEach((t) => {
    const p = (t.time || "0:0").split(":");
    const tm = (+p[0]) * 60 + (+p[1] || 0);
    if (Math.abs(cur - tm) <= 1) {
      const key = t.id + "|" + ds;
      const st = store.statuses[key];
      if (st !== "done" && st !== "skip") {
        const stamp = ds + cur;
        if (t._last !== stamp) {
          t._last = stamp;
          sendAll("到点了：" + (t.title || "该干活了"), t.step || "现在就开始这一件。");
        }
      }
    }
  });
}, 30000);

app.listen(PORT, () => console.log("[action-server] 监听 " + PORT));
