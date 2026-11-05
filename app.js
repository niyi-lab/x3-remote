/* X3 Remote: phone app for the DIY remote start. Talks MQTT over secure WebSockets to the car's
   private server. The login lives only in this phone's storage; nothing secret is in this code. */
"use strict";

const VERSION = "1.0.0";
const HOLD_START_MS = 1500;
const HOLD_STOP_MS = 1000;
const REPLY_TIMEOUT_MS = 20000;
const WS_PORT = 8084;
const DEFAULTS = { host: "", user: "", pass: "", topic: "x3", lat: 53.55, lon: -113.49, runMin: 15, demo: false };

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem("x3." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("x3." + k, JSON.stringify(v)); } catch { /* private mode: keep in memory */ } },
  del(k) { try { localStorage.removeItem("x3." + k); } catch { /* ignore */ } },
};

const cfg = Object.assign({}, DEFAULTS, store.get("cfg", {}));
const state = {
  conn: "idle",          // idle | connecting | connected | error
  connError: "",
  car: null,             // "online" | "offline" | null (unknown)
  status: null,          // JSON from <topic>/status
  tempC: null,
  pending: null,         // { what, timer }
  log: store.get("log", []),
};
let client = null;

// ---------- setup link: index.html#host=...&user=... fills the form, then leaves the address bar ----------
(function readSetupLink() {
  if (!location.hash.includes("host=")) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("host")) cfg.host = p.get("host").trim();
  if (p.get("user")) cfg.user = p.get("user").trim();
  if (p.get("topic")) cfg.topic = p.get("topic").trim();
  store.set("cfg", cfg);
  history.replaceState(null, "", location.pathname + location.search);
})();

// ---------- helpers ----------
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}
function buzz(ms) { if (navigator.vibrate) navigator.vibrate(ms); }
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + time;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}
function addLog(text, mine = false) {
  state.log.unshift({ t: Date.now(), text, mine });
  state.log = state.log.slice(0, 40);
  store.set("log", state.log);
  renderLog();
}
function topic(name) { return cfg.topic + "/" + name; }

// ---------- MQTT ----------
function connect() {
  disconnect();
  if (cfg.demo) { startDemo(); return; }
  if (!cfg.host || !cfg.user || !cfg.pass) { show("setup"); return; }
  state.conn = "connecting"; state.connError = ""; render();
  client = mqtt.connect(`wss://${cfg.host}:${WS_PORT}/mqtt`, {
    username: cfg.user,
    password: cfg.pass,
    clientId: "x3-app-" + Math.random().toString(16).slice(2, 10),
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 4000,
    connectTimeout: 12000,
  });
  client.on("connect", () => {
    state.conn = "connected"; state.connError = "";
    client.subscribe([topic("state"), topic("status"), topic("log")], { qos: 1 });
    send("status", { quiet: true });
    render();
  });
  client.on("reconnect", () => { if (state.conn !== "error") { state.conn = "connecting"; render(); } });
  client.on("close", () => { if (state.conn === "connected") { state.conn = "connecting"; render(); } });
  client.on("error", (err) => {
    const msg = String((err && err.message) || err);
    if (/not authori[sz]ed|bad user ?name or password|code 4|code 5/i.test(msg)) {
      state.conn = "error"; state.connError = "The server refused the login. Check the username and password in Settings.";
      client.end(true);
    }
    render();
  });
  client.on("message", onMessage);
}
function disconnect() {
  stopDemo();
  if (client) { client.removeAllListeners(); client.end(true); client = null; }
  state.conn = "idle";
}
function send(cmd, { quiet = false } = {}) {
  if (cfg.demo) { demoCommand(cmd); return true; }
  if (!client || state.conn !== "connected") { if (!quiet) toast("Not connected to the server yet"); return false; }
  client.publish(topic("cmd"), cmd, { qos: 1 });
  return true;
}
function onMessage(t, payload) {
  const text = payload.toString();
  if (t === topic("state")) { state.car = text.trim() === "online" ? "online" : "offline"; }
  else if (t === topic("status")) { try { state.status = JSON.parse(text); } catch { /* ignore a malformed status */ } }
  else if (t === topic("log")) { addLog(text); settlePending(); }
  render();
}

// ---------- commands ----------
function requestStart() {
  if (!carReady()) { toast(state.car === "offline" ? "The car is offline" : "Not connected yet"); return; }
  const temp = state.tempC === null ? "" : " " + Math.round(state.tempC);
  if (!send(`start ${cfg.runMin}${temp}`)) return;
  addLog(`You asked to start, ${cfg.runMin} min` + (state.tempC === null ? "" : `, ${Math.round(state.tempC)}° outside`), true);
  setPending("start");
}
function requestStop() {
  if (!send("stop")) return;
  addLog("You asked to stop the engine", true);
  setPending("stop");
}
function setPending(what) {
  clearTimeout(state.pending && state.pending.timer);
  state.pending = { what, timer: setTimeout(() => { state.pending = null; toast("No answer from the car yet"); render(); }, REPLY_TIMEOUT_MS) };
  render();
}
function settlePending() { if (state.pending) { clearTimeout(state.pending.timer); state.pending = null; } }
function carReady() { return cfg.demo || (state.conn === "connected" && state.car === "online"); }

// ---------- hold-to-act buttons ----------
// A timer decides when the hold is complete; animation frames only draw the progress.
function holdButton(el, ms, onProgress, onDone) {
  let start = 0, raf = 0, timer = 0, active = false;
  const tick = () => {
    if (!active) return;
    onProgress(Math.min((performance.now() - start) / ms, 1));
    raf = requestAnimationFrame(tick);
  };
  const complete = () => {
    if (!active) return;
    active = false; cancelAnimationFrame(raf); el.classList.remove("pressing");
    onProgress(1); buzz(35); onDone();
  };
  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (el.dataset.locked === "1" || active) return;
    active = true; start = performance.now(); el.classList.add("pressing"); buzz(8);
    clearTimeout(timer); timer = setTimeout(complete, ms);
    tick();
  };
  const up = () => {
    el.classList.remove("pressing");
    if (!active) return;
    active = false; clearTimeout(timer); cancelAnimationFrame(raf); onProgress(0);
  };
  el.addEventListener("pointerdown", down);
  ["pointerup", "pointerleave", "pointercancel"].forEach((n) => el.addEventListener(n, up));
  el.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); down(e); } });
  el.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") up(); });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ---------- weather: outside temperature, sent with each start ----------
async function loadWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}&current=temperature_2m`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json();
    const v = j && j.current && j.current.temperature_2m;
    if (typeof v === "number") { state.tempC = v; render(); }
  } catch { /* offline: keep the last value */ }
}

// ---------- demo mode: made-up car, no server ----------
let demoTimer = 0;
function startDemo() {
  state.conn = "connected"; state.car = "online";
  state.status = { fw: "demo", engine: "off", rssi: -52, vbat: 12.6 };
  render();
}
function stopDemo() { clearTimeout(demoTimer); }
function demoCommand(cmd) {
  if (cmd.startsWith("start")) {
    demoTimer = setTimeout(() => {
      state.status = { fw: "demo", engine: "running", rssi: -55, vbat: 14.1, rpm: 720, coolant: 31, ends: Math.floor(Date.now() / 1000) + cfg.runMin * 60, runMin: cfg.runMin };
      addLog("Started on the first try (demo)"); settlePending(); render();
    }, 2200);
  } else if (cmd === "stop") {
    demoTimer = setTimeout(() => {
      state.status = { fw: "demo", engine: "off", rssi: -52, vbat: 12.5 };
      addLog("Engine off (demo)"); settlePending(); render();
    }, 1500);
  } else if (cmd === "status") {
    setTimeout(() => { addLog("Demo car: parked, all good"); }, 400);
  }
}

// ---------- rendering ----------
function show(which) {
  $("#app").hidden = which !== "app";
  $("#setup").hidden = which !== "setup";
}
function render() {
  const s = state.status || {};
  const running = s.engine === "running";

  // status chip and subtitle
  const chip = $("#chip"), chipText = $("#chip-text");
  let cls = "chip-wait", label = "Connecting";
  if (cfg.demo) { cls = "chip-demo"; label = running ? "Running (demo)" : "Demo"; }
  else if (state.conn === "error") { cls = "chip-bad"; label = "Login failed"; }
  else if (state.conn === "connected" && state.car === "online") { cls = running ? "chip-run" : "chip-ok"; label = running ? "Running" : "Online"; }
  else if (state.conn === "connected" && state.car === "offline") { cls = "chip-bad"; label = "Car offline"; }
  else if (state.conn === "connected") { cls = "chip-wait"; label = "Waiting for car"; }
  chip.className = "chip " + cls; chipText.textContent = label;

  let sub = "xDrive30i";
  if (state.conn === "error") sub = state.connError;
  else if (running) sub = "Warming up";
  else if (state.car === "online" || cfg.demo) sub = "xDrive30i · Parked";
  else if (state.car === "offline" && s.t) sub = "Last seen " + fmtTime(s.t * 1000);
  $("#sub").textContent = sub;

  // metrics
  $("#m-temp").textContent = state.tempC === null ? "—" : Math.round(state.tempC) + "°";
  const batt = typeof s.vbat === "number" ? s.vbat.toFixed(1) + " V" : "—";
  $("#m-batt").textContent = batt;
  $("#m-coolant").textContent = typeof s.coolant === "number" ? Math.round(s.coolant) + "°" : "—";
  $("#m-signal").textContent = typeof s.rssi !== "number" ? "—" : s.rssi > -60 ? "Good" : s.rssi > -75 ? "Fair" : "Weak";
  $("#m-rpm").textContent = typeof s.rpm === "number" ? s.rpm + " rpm" : "—";

  // hero
  $("#parked").hidden = running;
  $("#running").hidden = !running;
  const hold = $("#hold-start"), holdText = $("#hold-start-text");
  const ready = carReady();
  hold.classList.toggle("off", !ready);
  hold.dataset.locked = state.pending ? "1" : "0";
  if (state.pending && state.pending.what === "start") holdText.textContent = "Waiting for the car…";
  else if (!ready) holdText.textContent = state.conn === "connected" ? "Car offline" : "Connecting…";
  else holdText.textContent = "Hold to start";
  if (!state.pending) { hold.classList.remove("done"); setRing(0); }

  document.querySelectorAll("#runtime button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.min) === cfg.runMin)));
  $("#hold-stop-text").textContent = state.pending && state.pending.what === "stop" ? "Stopping…" : "Hold to stop engine";
  renderCountdown();
}
function setRing(p) { $("#hold-start .prog").style.strokeDashoffset = String(578.05 * (1 - p)); }
function renderCountdown() {
  const s = state.status || {};
  if (s.engine !== "running" || typeof s.ends !== "number") { $("#cd-time").textContent = "--:--"; return; }
  const left = Math.max(0, s.ends - Date.now() / 1000);
  const total = (s.runMin || cfg.runMin) * 60;
  const m = Math.floor(left / 60), sec = Math.floor(left % 60);
  $("#cd-time").textContent = `${m}:${String(sec).padStart(2, "0")}`;
  $("#cd-sub").textContent = `left of ${Math.round(total / 60)} min`;
  $("#cd-prog").style.strokeDashoffset = String(628.32 * (1 - Math.min(1, left / total)));
}
function renderLog() {
  const ol = $("#log");
  ol.replaceChildren(...state.log.slice(0, 20).map((e) => {
    const li = document.createElement("li");
    if (e.mine) li.className = "mine";
    const span = document.createElement("span"); span.textContent = e.text;
    const time = document.createElement("time"); time.textContent = fmtTime(e.t);
    li.append(span, time);
    return li;
  }));
  $("#log-empty").hidden = state.log.length > 0;
}

// ---------- settings and setup ----------
function openSettings() {
  $("#s-host").value = cfg.host; $("#s-user").value = cfg.user; $("#s-pass").value = "";
  $("#s-lat").value = cfg.lat; $("#s-lon").value = cfg.lon; $("#s-demo").checked = cfg.demo;
  $("#settings-error").textContent = "";
  $("#version").textContent = "X3 Remote " + VERSION;
  $("#settings").showModal();
}
function saveSettings(e) {
  const lat = parseFloat($("#s-lat").value), lon = parseFloat($("#s-lon").value);
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
    e.preventDefault(); $("#settings-error").textContent = "Enter a latitude from -90 to 90 and a longitude from -180 to 180."; return;
  }
  const demo = $("#s-demo").checked;
  const host = $("#s-host").value.trim().replace(/^\w+:\/\//, "").replace(/[:/].*$/, "");
  if (!demo && (!host || !$("#s-user").value.trim())) { e.preventDefault(); $("#settings-error").textContent = "Enter the server address and username."; return; }
  const pass = $("#s-pass").value;
  Object.assign(cfg, { host, user: $("#s-user").value.trim(), lat, lon, demo });
  if (pass) cfg.pass = pass;
  store.set("cfg", cfg);
  if (demo !== state.wasDemo) { state.status = null; state.car = null; }
  state.wasDemo = demo;
  loadWeather(); connect(); show(cfg.host || cfg.demo ? "app" : "setup");
}
function forget() {
  disconnect();
  Object.assign(cfg, { pass: "", demo: false });
  store.set("cfg", cfg); store.del("log"); state.log = []; state.status = null; state.car = null;
  $("#settings").close(); renderLog(); fillSetup(); show("setup");
}
function fillSetup() { $("#f-host").value = cfg.host; $("#f-user").value = cfg.user || "x3-phone"; $("#f-pass").value = ""; }
function submitSetup(e) {
  e.preventDefault();
  const host = $("#f-host").value.trim().replace(/^\w+:\/\//, "").replace(/[:/].*$/, "");
  const user = $("#f-user").value.trim(), pass = $("#f-pass").value;
  const err = $("#setup-error");
  if (!host || !user || !pass) { err.textContent = "Fill in all three fields."; return; }
  err.textContent = "";
  Object.assign(cfg, { host, user, pass, demo: false });
  store.set("cfg", cfg);
  show("app"); render(); loadWeather(); connect();
}

// ---------- wiring ----------
function init() {
  holdButton($("#hold-start"), HOLD_START_MS,
    (p) => { if (carReady()) setRing(p); },
    () => { if (!carReady()) { setRing(0); toast(state.car === "offline" ? "The car is offline" : "Not connected yet"); return; }
      $("#hold-start").classList.add("done"); requestStart(); });
  holdButton($("#hold-stop"), HOLD_STOP_MS,
    (p) => { $("#stop-fill").style.transform = `scaleX(${p})`; },
    () => { requestStop(); setTimeout(() => { $("#stop-fill").style.transform = "scaleX(0)"; }, 300); });

  document.querySelectorAll("#runtime button").forEach((b) => b.addEventListener("click", () => {
    cfg.runMin = Number(b.dataset.min); store.set("cfg", cfg); buzz(5); render();
  }));
  $("#refresh").addEventListener("click", () => { if (send("status")) toast("Asked the car for its status"); });
  $("#open-settings").addEventListener("click", openSettings);
  $("#s-save").addEventListener("click", saveSettings);
  $("#s-forget").addEventListener("click", forget);
  $("#settings").addEventListener("click", (e) => { if (e.target === $("#settings")) $("#settings").close(); });
  $("#setup-form").addEventListener("submit", submitSetup);
  $("#try-demo").addEventListener("click", () => { cfg.demo = true; store.set("cfg", cfg); state.wasDemo = true; show("app"); connect(); render(); loadWeather(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    loadWeather();
    if (state.conn === "connected") send("status", { quiet: true });
    else if (state.conn !== "error" && (cfg.demo || cfg.pass)) connect();
  });
  setInterval(renderCountdown, 1000);
  setInterval(loadWeather, 10 * 60 * 1000);

  state.wasDemo = cfg.demo;
  renderLog();
  if (cfg.demo || (cfg.host && cfg.user && cfg.pass)) { show("app"); render(); connect(); }
  else { fillSetup(); show("setup"); }
  loadWeather();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
