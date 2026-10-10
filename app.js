// Pocket Casper: a chat app whose model runs on the phone itself (WebLLM on WebGPU), offline once downloaded.
import { WebWorkerMLCEngine, prebuiltAppConfig, hasModelInCache, deleteModelAllInfoInCache } from "./vendor/web-llm.js";

const $ = (s) => document.querySelector(s);
const VERSION = "1.3.0";

// iOS gives a web page far less memory than an app (Safari kills the tab above roughly 1.5 GB, which shows up as
// "A problem repeatedly occurred"). On iOS: a smaller context window (less memory for the conversation) and
// the light models first.
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ||
  localStorage.getItem("pc.forceIOS") === "1";  // lets a desktop browser test the iPhone behaviour
const CONTEXT_TOKENS = IS_IOS ? 2048 : 4096;
const REPLY_TOKENS = IS_IOS ? 600 : 1024;

// ---------------------------------------------------------------- models (curated for an iPhone's memory)
// Measured in a browser on the PC's RTX 3060 (GPU otherwise idle): Llama 3.2 1B 109 tok/s, Qwen 3 1.7B 61,
// Llama 3.2 3B 55, Qwen 3.5 2B 50. A phone GPU has roughly 1/6 of that memory bandwidth, so expect ~8–20 tok/s.
// Memory (WebLLM's estimate at a 4K context): Llama 1B 0.9 GB, Qwen 3 1.7B 2.0 GB, Qwen 3.5 2B and Llama 3B
// 2.2 GB, Qwen 3.5 4B 3.9 GB. On an iPhone 16, Qwen 3.5 2B crashed Safari ("A problem repeatedly occurred").
// Left out: Qwen 3.5 0.8B (too weak: rambled off-topic in tests) and Qwen 3 0.6B (needs more memory than Llama 1B).
const MODELS = [
  { key: "llama32-1b", base: "Llama-3.2-1B-Instruct", name: "Llama 3.2 · 1B", note: "Fast and reliable; good at simple maths, forgets details sooner", rec: true, tag: "Works on iPhone 16" },
  // Gemma 3's prebuilt config sets a 4K context AND a 512-token sliding window, which WebLLM rejects; using only
  // the sliding window (as the model was built) fixes it. In tests it followed conversations best of the 1B models.
  { key: "gemma3-1b", base: "gemma3-1b-it", name: "Gemma 3 · 1B", note: "Best conversationalist that fits; weaker at maths",
    tag: "Best for chatting", chatOpts: { context_window_size: -1, attention_sink_size: 0 } },
  { key: "qwen3-1.7b", base: "Qwen3-1.7B", name: "Qwen 3 · 1.7B", note: "Smarter, can think first. Close other apps before using it", think: true, big: true },
  { key: "qwen35-2b", base: "Qwen3.5-2B", name: "Qwen 3.5 · 2B", note: "Newest, but crashed on an iPhone 16 (too little memory for web apps)", big: true },
  { key: "llama32-3b", base: "Llama-3.2-3B-Instruct", name: "Llama 3.2 · 3B", note: "Natural writer; likely too big for an iPhone", big: true },
  { key: "qwen35-4b", base: "Qwen3.5-4B", name: "Qwen 3.5 · 4B", note: "Smartest; too big for phones (computers only)", big: true },
  { key: "smollm2-360m", base: "SmolLM2-360M-Instruct", name: "SmolLM2 · 360M", note: "Tiny (0.4 GB of memory): basic chat, for when the others crash", f16only: true },
];
let gpuInfo = "";
let showBig = false;  // iPhone: models too big for Safari's memory limit are hidden until asked for  // shown in Settings to help diagnose phones
let f16 = true;  // whether the GPU supports 16-bit floats (faster, smaller); otherwise use the f32 builds
const modelId = (m) => `${m.base}-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
const record = (m) => prebuiltAppConfig.model_list.find((r) => r.model_id === modelId(m));
const available = () => MODELS.filter((m) => record(m));

// ---------------------------------------------------------------- persistent state
const DEFAULT_SYSTEM = "You are Casper, a friendly, concise assistant running privately on the user's phone. " +
  "Answer clearly and briefly; use short paragraphs or lists when they help.";
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast("Couldn't save: storage is full"); } };
const settings = Object.assign({ model: null, think: false, temp: 0.7, system: DEFAULT_SYSTEM }, load("pc.settings", {}));
let chats = load("pc.chats", []);            // [{id, title, updated, messages: [{role, content, think?, stats?}]}]
let current = null;                          // the open chat
const sizes = load("pc.sizes", {});          // model id -> download size in bytes

// ---------------------------------------------------------------- engine
let engine = null, loadedId = null, loading = null, loadingCached = false, busy = false;

function setModelStatus(state, label) {
  $("#model-dot").className = "dot " + state;
  $("#model-name").textContent = label;
}

function status(text, progress) {
  const box = $("#status");
  if (text === null) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = "";
  box.append(text);
  if (progress !== undefined) {
    const bar = document.createElement("div");
    bar.className = "progress";
    bar.innerHTML = `<i style="width:${Math.round(progress * 100)}%"></i>`;
    box.append(bar);
  }
}

async function loadModel(m) {
  const id = modelId(m);
  if (loadedId === id && engine) return;
  if (loading) return loading;
  loading = (async () => {
    const cached = await hasModelInCache(id).catch(() => false);
    loadingCached = cached;
    setModelStatus("loading", m.name);
    status(cached ? "Loading the model into memory…" : "Downloading the model…", 0);
    try {
      if (!engine) {
        engine = new WebWorkerMLCEngine(new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
          { initProgressCallback: (p) => {
            if (!loading) return;  // a late message from the worker after loading finished
            if (p.progress >= 1) status(null); else status(progressText(p.text, loadingCached), p.progress);
          } });
      }
      markRisky("load", m);  // if Safari kills the page now, the next start knows why (see start())
      await engine.reload(id, m.chatOpts || (IS_IOS ? { context_window_size: CONTEXT_TOKENS } : undefined));
      clearRisky();
      loadedId = id;
      settings.model = m.key;
      save("pc.settings", settings);
      setModelStatus("ready", m.name);
      status(null);
      if (!cached) {
        persistStorage();
        toast(`${m.name} is downloaded. It now works offline.`);
      }
    } catch (e) {
      console.error(e);
      clearRisky();
      loadedId = null;
      setModelStatus("error", m.name);
      status(friendlyError(e));
      throw e;
    } finally {
      loading = null;
      if ($("#models").classList.contains("hidden") === false) renderModels();
    }
  })();
  return loading;
}

// ---------------------------------------------------------------- crash guard
// When a page uses too much memory, iOS kills it and Safari reloads it; no JavaScript runs to report it. So we
// note what we're about to do, and if the next start finds that note, the last attempt crashed. This also stops
// the crash loop that would come from loading the same model again automatically.
function markRisky(what, m) { save("pc.inflight", { what, model: m.key, at: Date.now() }); }
function clearRisky() { try { localStorage.removeItem("pc.inflight"); } catch (e) { /* storage blocked */ } }
const crashes = load("pc.crashes", {});  // model key -> times it crashed the page

function progressText(text, cached) {
  // WebLLM reports e.g. "Fetching param cache[12/38]: 640MB fetched. 34% completed, 21 secs elapsed..."
  const mb = /([\d.]+)MB fetched/.exec(text || "");
  const pct = /(\d+)% completed/.exec(text || "");
  if (/fetch|download/i.test(text) && mb && !cached) return `Downloading… ${mb[1]} MB${pct ? ` (${pct[1]}%)` : ""} · keep this screen open`;
  if (/shader|compil/i.test(text)) return "Preparing the GPU (first time only)…";
  if (/from cache/i.test(text)) return "Loading the model into memory…";
  return cached ? "Loading the model into memory…" : (text || "Downloading…").split(".")[0];
}

function friendlyError(e) {
  const s = String(e && (e.message || e));
  if (/out of memory|OOM|device was lost|DeviceLost|allocation/i.test(s))
    return "The phone ran out of memory for this model. Pick a smaller one under Models.";
  if (/fetch|network|Failed to load/i.test(s))
    return "Couldn't download the model. Check the connection and try again.";
  return "Something went wrong: " + s.slice(0, 160);
}

// ---------------------------------------------------------------- chat rendering
marked.setOptions({ gfm: true, breaks: true });
const md = (t) => DOMPurify.sanitize(marked.parse(t || ""));

function splitThinking(text) {
  // Qwen thinking arrives as "<think>…</think>answer"; while streaming the closing tag may not be there yet.
  const m = /^\s*<think>([\s\S]*?)(<\/think>|$)([\s\S]*)$/.exec(text);
  if (!m) return { think: "", answer: text, thinking: false };
  return { think: m[1].trim(), answer: m[3].trim(), thinking: !m[2] };
}

function renderMessage(msg) {
  const el = document.createElement("div");
  el.className = "msg " + (msg.role === "user" ? "user" : msg.error ? "bot error" : "bot");
  if (msg.role === "user") { el.textContent = msg.content; return el; }
  if (msg.error) { el.textContent = msg.content; return el; }
  fillBot(el, msg.content, msg.stats, false);
  return el;
}

function fillBot(el, raw, stats, live) {
  const { think, answer, thinking } = splitThinking(raw);
  el.innerHTML = "";
  if (think) {
    const d = document.createElement("details");
    d.className = "think";
    d.innerHTML = `<summary>${thinking ? "Thinking…" : "Thought it through ›"}</summary><div></div>`;
    d.querySelector("div").textContent = think;
    el.append(d);
  }
  const t = document.createElement("div");
  t.className = "text";
  if (answer) t.innerHTML = md(answer);
  else if (live) t.innerHTML = '<span class="typing"></span>';
  el.append(t);
  if (!live && answer) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.onclick = () => navigator.clipboard.writeText(answer).then(() => toast("Copied"));
    meta.append(copy);
    if (stats) meta.append(Object.assign(document.createElement("span"), { textContent: stats }));
    el.append(meta);
  }
}

function renderChat() {
  const box = $("#messages");
  box.innerHTML = "";
  const msgs = current ? current.messages : [];
  $("#welcome").classList.toggle("hidden", msgs.length > 0);
  for (const m of msgs) box.append(renderMessage(m));
  scrollDown(true);
}

function scrollDown(force) {
  const c = $("#chat");
  if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 200) c.scrollTop = c.scrollHeight;
}

// ---------------------------------------------------------------- sending
const approxTokens = (s) => Math.ceil((s || "").length / 3.5) + 4;

function promptMessages() {
  // Keep the newest messages that fit in the model's 4K context (leaving room for the reply).
  let budget = CONTEXT_TOKENS - REPLY_TOKENS - approxTokens(settings.system) - 64;
  const out = [];
  for (const m of [...current.messages].reverse()) {
    if (m.error) continue;
    const content = m.role === "assistant" ? splitThinking(m.content).answer : m.content;
    const cost = approxTokens(content);
    if (cost > budget && out.length) break;
    out.unshift({ role: m.role, content: content.slice(-Math.max(200, budget * 3)) });
    budget -= cost;
  }
  return [{ role: "system", content: settings.system || DEFAULT_SYSTEM }, ...out];
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  const m = MODELS.find((x) => x.key === settings.model);
  if (!m) { openModels(); toast("Pick a model to download first"); return; }
  if (!current) newChat(false);
  current.messages.push({ role: "user", content: text });
  if (current.messages.length === 1) current.title = text.slice(0, 48);
  persist();
  $("#input").value = "";
  autosize();
  renderChat();

  const bot = { role: "assistant", content: "" };
  const el = document.createElement("div");
  el.className = "msg bot";
  fillBot(el, "", null, true);
  $("#messages").append(el);
  scrollDown(true);
  setBusy(true);
  try {
    await loadModel(m);
    const started = performance.now();
    markRisky("reply", m);  // generating needs extra memory too
    const stream = await engine.chat.completions.create({
      messages: promptMessages(), stream: true, temperature: settings.temp, max_tokens: REPLY_TOKENS,
      stream_options: { include_usage: true },
      ...(m.think ? { extra_body: { enable_thinking: !!settings.think } } : {}),
    });
    let usage = null, lastPaint = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) bot.content += delta;
      if (chunk.usage) usage = chunk.usage;
      const now = performance.now();
      if (now - lastPaint > 60) { fillBot(el, bot.content, null, true); scrollDown(); lastPaint = now; }
    }
    clearRisky();
    const secs = (performance.now() - started) / 1000;
    const tps = usage?.extra?.decode_tokens_per_s;
    bot.stats = `${secs.toFixed(1)}s` + (tps ? ` · ${tps.toFixed(1)} tok/s` : "");
    if (!splitThinking(bot.content).answer) bot.content += bot.content ? "\n\n(Stopped.)" : "(No reply.)";
    current.messages.push(bot);
    fillBot(el, bot.content, bot.stats, false);
  } catch (e) {
    console.error(e);
    clearRisky();
    const err = { role: "assistant", error: true, content: friendlyError(e) };
    current.messages.push(err);
    el.replaceWith(renderMessage(err));
  } finally {
    setBusy(false);
    persist();
    scrollDown();
  }
}

function setBusy(b) {
  busy = b;
  $("#send").classList.toggle("stop", b);
  $("#send").innerHTML = icon(b ? "stop" : "up");
  $("#send").setAttribute("aria-label", b ? "Stop" : "Send");
  refreshSend();
}

function refreshSend() {
  $("#send").classList.toggle("ready", !busy && $("#input").value.trim().length > 0);
}

function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
  refreshSend();
}

// ---------------------------------------------------------------- chats
function persist() {
  if (current) {
    current.updated = Date.now();
    if (!chats.includes(current)) chats.unshift(current);
  }
  chats = chats.filter((c) => c.messages.length).sort((a, b) => b.updated - a.updated).slice(0, 100);
  save("pc.chats", chats);
  save("pc.current", current ? current.id : null);
  renderChatList();
}

function newChat(focus = true) {
  if (busy) return;
  current = { id: Date.now().toString(36), title: "New chat", updated: Date.now(), messages: [] };
  renderChat();
  closeDrawer();
  if (focus) $("#input").focus();
}

function renderChatList() {
  const list = $("#chat-list");
  list.innerHTML = "";
  if (!chats.length) { list.innerHTML = '<div class="chat-empty">No chats yet.</div>'; return; }
  for (const c of chats) {
    const row = document.createElement("div");
    row.className = "chat-item" + (current && c.id === current.id ? " active" : "");
    row.innerHTML = `<span></span><button class="del" aria-label="Delete">${icon("trash")}</button>`;
    row.querySelector("span").textContent = c.title;
    row.onclick = () => { if (busy) return; current = c; renderChat(); renderChatList(); closeDrawer(); };
    row.querySelector(".del").onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${c.title}"?`)) return;
      chats = chats.filter((x) => x !== c);
      if (current === c) { current = null; renderChat(); }
      persist();
    };
    list.append(row);
  }
}

// ---------------------------------------------------------------- models sheet
async function modelSize(m) {
  const id = modelId(m);
  if (sizes[id]) return sizes[id];
  for (const index of ["tensor-cache.json", "ndarray-cache.json"]) {  // newer models / older models
    try {
      const r = await fetch(`${record(m).model}/resolve/main/${index}`);
      if (!r.ok) continue;
      const j = await r.json();
      sizes[id] = j.records.reduce((a, x) => a + (x.nbytes || 0), 0);
      save("pc.sizes", sizes);
      return sizes[id];
    } catch (e) { /* offline or not found: try the next name */ }
  }
  return null;
}
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

async function renderModels() {
  const list = $("#model-list");
  list.innerHTML = "";
  const hidden = IS_IOS && !showBig ? available().filter((m) => m.big) : [];
  for (const m of available().filter((x) => !hidden.includes(x))) {
    const id = modelId(m);
    const cached = await hasModelInCache(id).catch(() => false);
    const isCurrent = settings.model === m.key;
    const card = document.createElement("div");
    card.className = "model" + (isCurrent ? " current" : "");
    card.innerHTML = `<div class="model-top"><b></b>${m.tag ? `<span class="tag${m.rec ? " rec" : ""}">${m.tag}</span>` : ""}` +
      `${cached ? '<span class="tag">Downloaded</span>' : ""}${IS_IOS && m.big ? '<span class="tag warn">May crash</span>' : ""}</div>` +
      `<small class="note"></small><small class="size"></small><small class="crashed"></small>` +
      `<div class="model-actions"></div>`;
    card.querySelector("b").textContent = m.name;
    card.querySelector(".note").textContent = m.note;
    const sizeEl = card.querySelector(".size");
    const mem = record(m).vram_required_MB * (IS_IOS ? 0.9 : 1);  // a bit less with the iPhone's 2K context
    modelSize(m).then((b) => {
      sizeEl.textContent = (b ? `${cached ? "Stored" : "Download"}: ${gb(b)} · ` : "") + `needs about ${(mem / 1000).toFixed(1)} GB of memory`;
    });
    if (crashes[m.key]) card.querySelector(".crashed").textContent = `Crashed on this phone ${crashes[m.key]}×`;
    const actions = card.querySelector(".model-actions");
    const use = document.createElement("button");
    use.className = "btn" + (isCurrent && loadedId === id ? "" : " primary");
    use.textContent = isCurrent && loadedId === id ? "In use" : cached ? "Use" : "Download";
    use.disabled = (isCurrent && loadedId === id) || !!loading || busy;
    use.onclick = async () => {
      settings.model = m.key;
      save("pc.settings", settings);
      closeSheets();
      try { await loadModel(m); } catch (e) { /* shown in the status line */ }
    };
    actions.append(use);
    if (cached) {
      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "Delete";
      del.disabled = loadedId === id || !!loading;
      del.onclick = async () => {
        if (!confirm(`Delete ${m.name} from this phone? You can download it again later.`)) return;
        await deleteModelAllInfoInCache(id);
        if (settings.model === m.key) { settings.model = null; save("pc.settings", settings); setModelStatus("", "No model"); }
        renderModels();
      };
      actions.append(del);
    }
    list.append(card);
  }
  if (hidden.length) {
    const more = document.createElement("button");
    more.className = "btn show-big";
    more.textContent = `Show ${hidden.length} bigger models (they crash on iPhone)`;
    more.onclick = () => { showBig = true; renderModels(); };
    list.append(more);
  }
  showStorage();
}

async function showStorage() {
  if (!navigator.storage?.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  $("#storage").textContent = `Using ${gb(usage)} of the ${gb(quota)} this app may store.`;
}

async function persistStorage() {
  // Ask iOS to keep the downloaded model instead of clearing it when space runs low.
  try { return await navigator.storage?.persist?.(); } catch (e) { return false; }
}

// ---------------------------------------------------------------- sheets, drawer, settings
function openModels() { closeDrawer(); $("#models").classList.remove("hidden"); renderModels(); }
async function openSettings() {
  closeDrawer();
  $("#s-think").checked = settings.think;
  $("#s-temp").value = settings.temp;
  $("#s-temp-v").textContent = settings.temp;
  $("#s-system").value = settings.system;
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $("#s-persist").textContent = persisted ? "Protected: iOS won't clear the downloaded model"
    : "Not protected yet: add the app to the Home Screen so iOS keeps the model";
  $("#s-about").textContent = `Pocket Casper ${VERSION} · runs on this device with WebGPU${f16 ? "" : " (32-bit mode)"}. Chats never leave the phone. ${gpuInfo}`;
  $("#settings").classList.remove("hidden");
}
function closeSheets() { document.querySelectorAll(".sheet").forEach((s) => s.classList.add("hidden")); }
function openDrawer() { document.body.classList.add("drawer-open"); $("#scrim").classList.remove("hidden"); renderChatList(); }
function closeDrawer() { document.body.classList.remove("drawer-open"); $("#scrim").classList.add("hidden"); }

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

// ---------------------------------------------------------------- icons
const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  new: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;
const LOGO = '<svg viewBox="18 18 64 64"><defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#a8cdf0"/></linearGradient>' +
  '<mask id="pm"><circle cx="50" cy="50" r="31" fill="#fff"/><circle cx="64" cy="37.5" r="26.5" fill="#000"/></mask></defs>' +
  '<circle cx="50" cy="50" r="31" fill="url(#pg)" mask="url(#pm)"/></svg>';

// ---------------------------------------------------------------- start
async function start() {
  document.querySelectorAll("[data-icon]").forEach((e) => (e.innerHTML = icon(e.dataset.icon)));
  document.querySelectorAll("[data-logo]").forEach((e) => (e.innerHTML = LOGO));
  wire();
  renderChatList();
  const lastId = load("pc.current", null);
  current = chats.find((c) => c.id === lastId) || null;
  renderChat();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) toast("Updated. Close and reopen the app to use the new version.");
        });
      });
    }).catch((e) => console.warn("service worker", e));
  }

  if (!navigator.gpu) return noWebGPU("This browser can't run AI models (no WebGPU).");
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  if (!adapter) return noWebGPU("Couldn't access the GPU.");
  f16 = adapter.features.has("shader-f16");
  gpuInfo = `GPU: ${adapter.info?.vendor || "?"} ${adapter.info?.architecture || ""} · 16-bit: ${f16 ? "yes" : "no"} · ` +
    `max buffer ${Math.round(adapter.limits.maxBufferSize / 1048576)} MB · storage binding ${Math.round(adapter.limits.maxStorageBufferBindingSize / 1048576)} MB`;

  // Did the last load or reply crash the page? (See markRisky.)
  const crashed = load("pc.inflight", null);
  clearRisky();
  if (crashed && Date.now() - crashed.at < 30 * 60 * 1000) {
    crashes[crashed.model] = (crashes[crashed.model] || 0) + 1;
    save("pc.crashes", crashes);
    const cm = MODELS.find((x) => x.key === crashed.model);
    if (settings.model === crashed.model) { settings.model = null; save("pc.settings", settings); }  // don't crash again on the next message
    showCrash(cm);
  }

  const m = MODELS.find((x) => x.key === settings.model && record(x));
  if (!m) {
    setModelStatus("", "No model");
    showSetup();
    return;
  }
  // The model loads on the first message, not at start: if it's too big for this phone, the app still opens.
  const cached = await hasModelInCache(modelId(m)).catch(() => false);
  setModelStatus(cached ? "" : "error", m.name);
}

function showCrash(m) {
  const name = m ? m.name : "The model";
  const lighter = m && m.key !== "llama32-1b" ? " Try Llama 3.2 · 1B, the lightest one." : " Close other apps and try again.";
  const note = document.createElement("div");
  note.className = "crash-note";
  note.innerHTML = `<b></b><span></span><button class="btn">Choose a model</button>`;
  note.querySelector("b").textContent = `${name} needed more memory than iOS allows a web app, so the app was restarted.`;
  note.querySelector("span").textContent = lighter;
  note.querySelector("button").onclick = () => { note.remove(); openModels(); };
  $("#welcome").after(note);
}

function showSetup() {
  $("#welcome-sub").textContent = "Private AI that runs on this phone. Download a model once on Wi-Fi, then chat anywhere, even offline.";
  const b = document.createElement("button");
  b.className = "btn primary";
  b.textContent = "Choose a model";
  b.onclick = openModels;
  $("#welcome").append(b);
}

function noWebGPU(why) {
  setModelStatus("error", "Not supported");
  $("#welcome-sub").innerHTML = `${why}<br><br>On iPhone this needs <b>iOS 26 or newer</b> in Safari ` +
    "(or the app added to the Home Screen from Safari). On a computer, use a recent Chrome or Edge.";
  $("#input").disabled = true;
}

function wire() {
  const input = $("#input");
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    // On phones Enter adds a line (send with the button); with a hardware keyboard Enter sends.
    if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(input.value); }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { engine?.interruptGenerate(); return; }
    send(input.value);
  });
  $("#menu-btn").onclick = openDrawer;
  $("#scrim").onclick = closeDrawer;
  $("#new-btn").onclick = () => newChat();
  $("#drawer-new").onclick = () => newChat();
  $("#model-btn").onclick = openModels;
  $("#open-models").onclick = openModels;
  $("#open-settings").onclick = openSettings;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheets));
  document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s) closeSheets(); }));
  $("#s-think").onchange = (e) => { settings.think = e.target.checked; save("pc.settings", settings); };
  $("#s-temp").oninput = (e) => { settings.temp = Number(e.target.value); $("#s-temp-v").textContent = settings.temp; save("pc.settings", settings); };
  $("#s-system").onchange = (e) => { settings.system = e.target.value.trim() || DEFAULT_SYSTEM; save("pc.settings", settings); };
  $("#s-clear").onclick = () => {
    if (!confirm("Delete every chat on this phone?")) return;
    chats = []; current = null; persist(); renderChat(); closeSheets();
  };
  $("#chat").addEventListener("scroll", () => document.body.classList.toggle("scrolled", $("#chat").scrollTop > 4));
  // Keep the newest message in view when the iOS keyboard opens.
  window.visualViewport?.addEventListener("resize", () => scrollDown(true));
}

start();
