import { marked } from "/vendor/marked.js";

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const $ = (s) => document.querySelector(s);
const thread = $("#thread");
const input = $("#input");
const send = $("#send");
let conversationId = location.hash.slice(1) || null;
let busy = false;

// Model output is rendered as Markdown, but raw HTML in it is shown as text.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
marked.use({ renderer: { html: (t) => esc(t.text ?? t.raw ?? "") } });

function render(md, sources = []) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return marked.parse(md).replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
    const s = byId.get(Number(n));
    return s ? `<sup class="cite"><a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${n}</a></sup>` : `<sup class="cite"><a>${n}</a></sup>`;
  });
}

const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function addUser(text, at = Date.now()) {
  $("#empty")?.remove();
  const m = el("div", "msg user");
  const wrap = el("div");
  wrap.append(el("div", "bubble", esc(text)), el("div", "when", fmtTime(at)));
  m.append(wrap);
  thread.append(m);
}

function addAssistant() {
  const m = el("div", "msg assistant");
  const parts = { trace: el("div", "trace"), memory: el("details", "memory"), body: el("div", "body"), sources: el("div", "sources"), meta: el("div", "meta") };
  parts.memory.hidden = true;
  m.append(parts.trace, parts.memory, parts.body, parts.sources, parts.meta);
  thread.append(m);
  return parts;
}

function renderSources(container, sources) {
  container.innerHTML = "";
  for (const s of sources) {
    const a = el("a", null, `<b>${s.id}</b>${esc(s.title)} · ${esc(host(s.url))}${s.published ? " · " + esc(s.published) : ""}`);
    a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.title = s.url;
    container.append(a);
  }
}

const scrollDown = () => (thread.scrollTop = thread.scrollHeight);

async function loadConversations() {
  const list = await fetch("/api/conversations").then((r) => r.json());
  const nav = $("#conversations");
  nav.innerHTML = "";
  for (const c of list) {
    const a = el("a", c.id === conversationId ? "active" : "", `${esc(c.title)}<small>${fmtTime(c.updatedAt)}</small>`);
    a.href = "#" + c.id;
    nav.append(a);
  }
}

async function openConversation(id) {
  conversationId = id;
  thread.innerHTML = "";
  if (!id) {
    location.hash = "";
    thread.append(emptyState.cloneNode(true));
    bindSuggestions();
    return loadConversations();
  }
  const conv = await fetch(`/api/conversations/${id}`).then((r) => (r.ok ? r.json() : null));
  if (conv) {
    for (const x of conv.exchanges) {
      addUser(x.question, x.askedAt);
      const p = addAssistant();
      p.body.innerHTML = render(x.answer, x.sources);
      renderSources(p.sources, x.sources);
    }
  }
  scrollDown();
  loadConversations();
}

async function ask(text) {
  if (busy || !text.trim()) return;
  busy = true; send.disabled = true;
  addUser(text);
  const p = addAssistant();
  const status = el("span", "live", "Thinking…");
  p.trace.append(status);
  scrollDown();

  let md = "";
  let sources = [];
  let raf = 0;
  const paint = () => { raf = 0; p.body.innerHTML = render(md, sources); scrollDown(); };

  const handlers = {
    meta(e) {
      if (conversationId !== e.conversationId) { conversationId = e.conversationId; history.replaceState(null, "", "#" + e.conversationId); }
    },
    memory(e) {
      if (!e.items.length && !e.timeRefs.length) return;
      const refs = e.timeRefs.map((t) => `“${esc(t.text)}” → ${esc(t.label)}`).join(", ");
      p.memory.hidden = false;
      p.memory.innerHTML = `<summary>Recalled ${e.items.length} past exchange${e.items.length === 1 ? "" : "s"}${refs ? " · " + refs : ""}</summary><ul>${e.items
        .map((i) => `<li>${fmtTime(i.askedAt)} — ${esc(i.question.slice(0, 120))} <em>(${esc(i.why.join(", "))})</em></li>`)
        .join("")}</ul>`;
    },
    search(e) {
      status.textContent = `Searching: ${e.queries.join(" · ")}${e.since ? ` (since ${e.since})` : ""}`;
    },
    search_done(e) {
      const chip = el("span", null, `Searched · ${e.results} sources · ${(e.ms / 1000).toFixed(1)}s`);
      p.trace.insertBefore(chip, status);
      status.textContent = "Reading results…";
    },
    delta(e) {
      status.remove();
      md += e.text;
      if (!raf) raf = requestAnimationFrame(paint);
    },
    sources(e) { sources = e.sources; paint(); renderSources(p.sources, sources); },
    done(e) {
      status.remove();
      p.meta.textContent = `${(e.totalMs / 1000).toFixed(1)}s total${e.firstTokenMs != null ? ` · first token ${(e.firstTokenMs / 1000).toFixed(1)}s` : ""}${e.searchRounds ? ` · ${e.searchRounds} search round${e.searchRounds > 1 ? "s" : ""}` : " · no search needed"}`;
    },
    error(e) { status.remove(); p.body.append(el("p", "error", esc(e.message))); },
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversationId, tz }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (event && data && handlers[event]) handlers[event](JSON.parse(data));
      }
    }
  } catch (err) {
    handlers.error({ message: err.message });
  } finally {
    busy = false; send.disabled = false; input.focus();
    loadConversations();
  }
}

const emptyState = $("#empty").cloneNode(true);
function bindSuggestions() {
  document.querySelectorAll(".suggestions button").forEach((b) => (b.onclick = () => ask(b.textContent)));
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = ""; input.style.height = "auto";
  ask(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; });
$("#new-chat").onclick = () => openConversation(null);
window.addEventListener("hashchange", () => { const id = location.hash.slice(1) || null; if (id !== conversationId) openConversation(id); });

fetch("/api/health").then((r) => r.json()).then((h) => {
  if (h.missingKeys.length) $("#health").textContent = `Missing ${h.missingKeys.join(", ")} in .env`;
});
bindSuggestions();
if (conversationId) openConversation(conversationId); else loadConversations();
