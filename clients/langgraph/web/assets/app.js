// Foundry LangGraph 客户端前端。
// 对话走 POST /api/chat 的 SSE 流（fetch + ReadableStream 手解 data: 行）。
// 审批闸门的 pending 单独渲染成审批卡片，批准成功后由服务端消票执行、结果回填。
// 后端契约：/api/config（含可切换身份列表）、/api/chat、/api/approvals。守卫/权限/审批全在网关执行，
// 本客户端零策略；连不上网关就走内置演示脚本（canned），可用身份段控预览工具面按角色收窄。

const $ = (id) => document.getElementById(id);
const thread = $("thread");
const empty = $("empty");
const input = $("input");
const send = $("send");

// ---- 状态 ----
let DEMO = true; // /api/config 成功即置 false
let approverEnabled = false; // 演示态允许审批闭环；真实态由 /api/config 决定
let busy = false;
let identities = []; // [{key,name,role,userId,tokenAlg,domain,tools:[]}]
let currentKey = "rep";
let model = "glm-4.6";

// 涉审写工具的角标；HIDDEN_BY_ROLE = 该角色看不到的工具（划掉展示，教学用——真实模式下网关本就不返回它们）
const ANNOT = {
  update_contact: "需审批", delete_contact: "需审批",
  update_opportunity_stage: "需审批", issue_refund: "分级审",
};
const HIDDEN_BY_ROLE = {
  sales_rep: [["get_pipeline_summary", "经理专属"], ["get_salary", "跨域"]],
  sales_manager_ro: [["get_salary", "跨域"]],
  sales_manager: [["get_salary", "跨域"]],
};
// 无后端预览用的演示身份（名字与 fixtures 的 owner 名一致，避免和盘点表里的负责人对不上）
const DEMO_IDENTITIES = [
  {
    key: "rep", name: "林哲", role: "sales_rep", userId: "e007", tokenAlg: "演示头", domain: "CRM · Twenty",
    tools: ["list_accounts", "get_account", "list_contacts", "get_contact", "list_opportunities",
      "get_opportunity", "create_contact", "update_contact", "delete_contact", "update_opportunity_stage", "issue_refund"],
  },
  {
    key: "manager", name: "何静", role: "sales_manager_ro", userId: "e005", tokenAlg: "演示头", domain: "CRM · Twenty",
    tools: ["list_accounts", "get_account", "list_contacts", "get_contact", "list_opportunities", "get_opportunity", "get_pipeline_summary"],
  },
];

// ---- thread_id：持久化在 localStorage（刷新保留服务端多轮记忆）；每身份各一份，切身份即换一段对话 ----
const THREAD_KEY = "foundry-threads";
function newThreadId() {
  return "web-" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
}
function readThreads() {
  try { return JSON.parse(localStorage.getItem(THREAD_KEY) || "{}"); } catch { return {}; }
}
function threadIdFor(key) {
  const map = readThreads();
  if (!map[key]) { map[key] = newThreadId(); try { localStorage.setItem(THREAD_KEY, JSON.stringify(map)); } catch {} }
  return map[key];
}
function resetThread(key) {
  const map = readThreads();
  map[key] = newThreadId();
  try { localStorage.setItem(THREAD_KEY, JSON.stringify(map)); } catch {}
}

// ---- 主题（记忆到 localStorage，默认跟随系统） ----
const savedTheme = localStorage.getItem("foundry-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("theme").addEventListener("click", () => {
  const isDark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = isDark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("foundry-theme", next);
});

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- 移动端侧栏抽屉 ----
const rail = $("rail");
const backdrop = $("rail-backdrop");
function openRail() {
  rail.classList.add("open"); backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add("on"));
  $("hamburger").setAttribute("aria-expanded", "true");
}
function closeRail() {
  rail.classList.remove("open"); backdrop.classList.remove("on");
  setTimeout(() => { if (!rail.classList.contains("open")) backdrop.hidden = true; }, 240);
  $("hamburger").setAttribute("aria-expanded", "false");
}
$("hamburger").addEventListener("click", () => rail.classList.contains("open") ? closeRail() : openRail());
$("rail-close").addEventListener("click", closeRail);
backdrop.addEventListener("click", closeRail);
addEventListener("keydown", (e) => { if (e.key === "Escape" && rail.classList.contains("open")) closeRail(); });

// ---- 工具面渲染（真实模式 = 网关按身份收窄后的 tools/list；演示模式 = 内置画像） ----
function renderSurface(identity) {
  $("id-domain").textContent = identity.domain || "CRM · Twenty";
  const box = $("tool-surface");
  box.textContent = "";
  const visible = new Set(identity.tools || []);
  for (const name of identity.tools || []) {
    const gated = ANNOT[name];
    const row = el("div", "tool-item" + (gated ? " gated" : ""));
    row.appendChild(el("span", "d"));
    row.appendChild(el("span", "name", name));
    if (gated) row.appendChild(el("span", "flag", gated));
    box.appendChild(row);
  }
  for (const [name, flag] of HIDDEN_BY_ROLE[identity.role] || []) {
    if (visible.has(name)) continue;
    const row = el("div", "tool-item hidden-tool");
    row.appendChild(el("span", "d"));
    row.appendChild(el("span", "name", name));
    row.appendChild(el("span", "flag", flag));
    box.appendChild(row);
  }
}

function roleLabel(idn) {
  const isMgr = idn.role === "sales_manager_ro" || idn.role === "sales_manager";
  return (isMgr ? "经理" : "销售") + " · " + (idn.name || idn.userId || idn.key);
}

function buildSwitcher() {
  const seg = $("id-seg");
  seg.textContent = "";
  for (const idn of identities) {
    const b = el("button", idn.key === currentKey ? "on" : null, roleLabel(idn));
    b.type = "button";
    b.dataset.key = idn.key;
    seg.appendChild(b);
  }
  // 只有 >1 个身份（配了只读经理）才显示段控
  $("id-switch").hidden = identities.length < 2;
}

function applyIdentity(key) {
  const identity = identities.find((i) => i.key === key) || identities[0];
  if (!identity) return;
  currentKey = identity.key;
  $("id-name").textContent = identity.name || identity.userId || "身份";
  $("id-role").textContent = identity.role || "";
  $("id-token").textContent = identity.tokenAlg || "signed";
  $("chip-identity").textContent = "身份 " + (identity.name || "") + (identity.role ? " · " + identity.role : "");
  $("chip-model").textContent = "模型 " + model;
  renderSurface(identity);
  document.querySelectorAll("#id-seg button").forEach((b) => b.classList.toggle("on", b.dataset.key === key));
}

// 切身份 = 新对话：清空线程 + 换 threadId（记忆不串）
$("id-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-key]");
  if (!b || busy || b.dataset.key === currentKey) return;
  applyIdentity(b.dataset.key);
  thread.textContent = "";
  thread.hidden = true;
  empty.hidden = false;
  resetThread(b.dataset.key);
  closeRail();
});

// ---- 载入网关身份/模型；未接后端则进入演示态 ----
(async () => {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error();
    const cfg = await r.json();
    if (!cfg || !Array.isArray(cfg.identities) || cfg.identities.length === 0) throw new Error();
    DEMO = false;
    identities = cfg.identities;
    model = cfg.model || model;
    approverEnabled = !!cfg.approverEnabled;
    currentKey = cfg.current || identities[0].key;
    $("hint-text").textContent = "守卫在网关执行 · 本客户端零策略代码";
  } catch {
    DEMO = true;
    identities = DEMO_IDENTITIES;
    approverEnabled = true;
    currentKey = "rep";
    $("hint-text").textContent = "演示数据 · 切换身份看守卫如何按角色收窄工具面";
  }
  buildSwitcher();
  applyIdentity(currentKey);
})();

// ---- textarea 自增高 + 回车发送 ----
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  input.style.height = "auto";
  ask(text, false);
});
document.querySelectorAll("#prompts-read, #prompts-write").forEach((g) =>
  g.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-q]");
    if (btn && !busy) ask(btn.dataset.q, true);
  }),
);

function addMessage(role, text) {
  empty.hidden = true;
  thread.hidden = false;
  const msg = el("div", "msg " + role);
  msg.appendChild(el("div", "who", role === "user" ? "你" : "助手"));
  const bubble = el("div", "bubble");
  if (text != null) bubble.textContent = text;
  msg.appendChild(bubble);
  thread.appendChild(msg);
  scrollDown(true);
  return { msg, bubble };
}

function nearBottom() {
  const m = $("main");
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}
// 仅当用户本就贴在底部时才自动跟随——否则往上翻看历史不会被拽回
function scrollDown(force) {
  const m = $("main");
  if (force || nearBottom()) m.scrollTop = m.scrollHeight;
}

const TOOL_VERDICT = { ok: "已完成", refusal: "被守卫拒绝", error: "出错", running: "执行中…" };
const STREAM_IDLE_MS = 45000; // 无新帧 45s 视为卡死 → abort，避免 busy 永久锁死

async function ask(text, fromPrompt) {
  busy = true;
  send.disabled = true;
  addMessage("user", text);
  const { bubble } = addMessage("ai", null);
  const toolsBox = el("div", "tools");
  bubble.parentElement.insertBefore(toolsBox, bubble);
  const toolRows = [];
  const answerNode = document.createTextNode(""); // 专用文本节点，逐 token appendData（避免整串重写的 O(n²)）
  bubble.appendChild(answerNode);
  const cursor = el("span", "cursor");
  bubble.appendChild(cursor);
  // 从空态起（点了 starter prompt）把焦点移到回答区，键盘/读屏不至于掉到 <body>
  if (fromPrompt) { try { thread.focus({ preventScroll: true }); } catch {} }

  let answer = "";
  let hadError = false;
  let errorMessage = "";
  const ctx = {
    bubble, cursor, answerNode, toolsBox, toolRows,
    addAnswer: (t) => (answer += t),
    markError: (m) => { hadError = true; if (m) errorMessage = m; },
  };

  const ctrl = new AbortController();
  let idle = null;
  const bumpIdle = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), STREAM_IDLE_MS); };

  try {
    if (DEMO) {
      await demoStream(text, ctx);
    } else {
      bumpIdle();
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, threadId: threadIdFor(currentKey), identity: currentKey }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error("stream failed");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bumpIdle();
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() || "";
        for (const frame of frames) {
          // SSE 规范：一帧可有多行 data:，须用 \n 拼接；坏帧 try/catch 跳过，不撕整条流
          const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data) continue;
          try { handleEvent(JSON.parse(data), ctx); } catch {}
        }
      }
    }
    cursor.remove();
    if (hadError) appendInterrupted(bubble, answer, errorMessage);
    else if (answer) bubble.innerHTML = renderMarkdown(answer);
  } catch {
    cursor.remove();
    appendInterrupted(bubble, answer, errorMessage);
  } finally {
    clearTimeout(idle);
    cursor.remove();
    busy = false;
    send.disabled = false;
  }
}

function appendInterrupted(bubble, answer, message) {
  bubble.innerHTML = answer ? renderMarkdown(answer) : "";
  const e = el("div", "stream-error");
  e.setAttribute("role", "alert");
  const label = message || "回答被中断，请重试";
  e.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20z"></path><path d="M12 9v5"></path><path d="M12 17.5v.01"></path></svg>';
  e.appendChild(el("span", null, label));
  bubble.appendChild(e);
}

function firstRunning(rows, name) {
  return rows.find((r) => r.name === name && r.running) || null;
}

function handleEvent(evt, ctx) {
  if (evt.type === "token") {
    ctx.addAnswer(evt.text);
    ctx.answerNode.appendData(evt.text);
    scrollDown();
  } else if (evt.type === "tool_start") {
    const dom = el("div", "tool-row running");
    dom.appendChild(el("span", "dot"));
    dom.appendChild(el("span", "name", evt.tool));
    dom.appendChild(el("span", "verdict", "· " + TOOL_VERDICT.running));
    ctx.toolsBox.appendChild(dom);
    ctx.toolRows.push({ name: evt.tool, dom, running: true });
    scrollDown();
  } else if (evt.type === "tool_end") {
    const row = firstRunning(ctx.toolRows, evt.tool);
    if (row) {
      row.running = false;
      row.dom.className = "tool-row " + evt.kind;
      row.dom.querySelector(".verdict").textContent = "· " + (TOOL_VERDICT[evt.kind] || evt.kind);
    }
  } else if (evt.type === "pending") {
    const row = firstRunning(ctx.toolRows, evt.tool);
    if (row) {
      row.running = false;
      row.dom.className = "tool-row pending";
      row.dom.querySelector(".verdict").textContent = "· 待审批";
    }
    renderApprovalCard(evt);
  } else if (evt.type === "error") {
    ctx.markError(evt.message);
  }
}

// ---- 极简安全 markdown（先转义再处理表格/列表/加粗/代码/段落） ----
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
function renderTable(lines) {
  const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = cells(lines[0]);
  const bodyRows = lines.slice(2).map(cells);
  const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
  const trs = bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="tbl-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}
function renderMarkdown(md) {
  return md.trim().split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    if (lines.length >= 2 && lines[0].includes("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1])) {
      return renderTable(lines);
    }
    if (lines.length && lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return "<ul>" + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("") + "</ul>";
    }
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

const ICON = {
  clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5V12l3 1.8"></path></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
};

function renderApprovalCard(evt) {
  const card = el("div", "approval");
  const head = el("div", "head");
  const icon = el("span", "ic");
  icon.innerHTML = ICON.clock;
  const headTitle = el("span", "htxt", "需人工审批");
  const badge = el("span", "badge", "待审批 · 无数据载荷");
  head.append(icon, headTitle, badge);
  card.appendChild(head);

  const meta = el("div", "meta");
  const add = (k, v) => { meta.appendChild(el("span", "k", k)); meta.appendChild(el("span", "v", v)); };
  add("工具", evt.tool);
  add("单号", String(evt.approvalId || "").slice(0, 8));
  add("命中规则", evt.rule || "高危写操作");
  card.appendChild(meta);

  card.appendChild(el("div", "why", evt.why ||
    "写操作在 adapter.execute 之前被挂起——挂起分支无 data 字段,结构上不夹带业务数据。批准后同参重试消票执行(一单一次,防重放)。"));

  const actions = el("div", "actions");
  const approve = el("button", "btn approve", "同意并执行");
  const deny = el("button", "btn deny", "拒绝");
  actions.append(approve, deny);
  actions.appendChild(el("span", "actor", "审批经飞书 · 发起人无法自批"));
  card.appendChild(actions);
  thread.appendChild(card);
  scrollDown(true);

  if (!approverEnabled) {
    approve.disabled = true;
    deny.disabled = true;
    card.appendChild(el("div", "why", "本页未配置就地审批人（公开演示不放审批令牌）——审批走飞书卡片,由独立审批人批复后网关自动续跑。"));
    return;
  }

  const decide = async (decision) => {
    approve.disabled = true;
    deny.disabled = true;
    try {
      let body;
      if (DEMO) {
        await sleep(620);
        body = decision === "approve" ? { execution: { kind: "ok" } } : {};
      } else {
        const resp = await fetch("/api/approvals/" + evt.approvalId, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        body = await resp.json();
        if (!resp.ok) {
          card.classList.add("decided");
          headTitle.textContent = "批复失败：" + (body.error || "请重试");
          // 非终态失败（如网络/暂时性）允许重试；终态（已消费/已决）保持禁用即可
          if (resp.status >= 500 || resp.status === 409) { approve.disabled = false; deny.disabled = false; }
          return;
        }
      }
      if (decision === "approve") {
        card.classList.add("decided", "approved");
        icon.innerHTML = ICON.check;
        const exec = body.execution || {};
        if (exec.kind === "ok") headTitle.textContent = "已批准并执行完成";
        else if (exec.kind === "refusal") headTitle.textContent = "已批准，但执行被守卫拒绝（" + (exec.reason || "") + "）";
        else headTitle.textContent = "已批准（" + (exec.message || "执行结果见对话") + "）";
        badge.textContent = "已消费 · 消票执行";
      } else {
        card.classList.add("decided", "denied");
        icon.innerHTML = ICON.x;
        headTitle.textContent = "已拒绝，操作不会执行";
        badge.textContent = "已拒绝";
      }
    } catch {
      approve.disabled = false;
      deny.disabled = false;
      headTitle.textContent = "需人工审批 · 网络出错，重试";
    }
  };
  approve.addEventListener("click", () => decide("approve"));
  deny.addEventListener("click", () => decide("deny"));
}

// ================= 内置演示脚本（未接后端时的静态预览） =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function typeOut(md, ctx) {
  const toks = md.match(/[\s\S]{1,2}/g) || [];
  for (const t of toks) { handleEvent({ type: "token", text: t }, ctx); await sleep(20); }
}
async function toolRun(name, kind, ctx) {
  handleEvent({ type: "tool_start", tool: name }, ctx);
  await sleep(520);
  handleEvent({ type: "tool_end", tool: name, kind }, ctx);
  await sleep(150);
}
async function demoStream(text, ctx) {
  const q = text;
  const isMgr = currentKey === "manager";
  const gated = /改|删|退款|refund|update|delete|职务|阶段/.test(q) && !/在苏州|金额|电话|盘点|哪些|看/.test(q);
  const crossOwner = /周涛/.test(q);

  if (crossOwner) {
    await toolRun("delete_contact", "refusal", ctx);
    await typeOut("联系人**周涛**归属另一个销售,不在你的可见行内——**写前归属校验**在执行与审批之前就 `row_denied` 了,连审批单都不会开。此次请求已记入审计。", ctx);
    return;
  }
  if (gated) {
    if (isMgr) {
      await typeOut("只读经理身份的工具面里没有写工具（改/删/退款都不在 `tools/list`）——切回**销售·林哲**才能发起写、走审批闸门。", ctx);
      return;
    }
    const isRefund = /退款|refund/.test(q);
    const tool = isRefund ? "issue_refund" : /删/.test(q) ? "delete_contact" : "update_contact";
    handleEvent({ type: "tool_start", tool }, ctx);
    await sleep(600);
    handleEvent({
      type: "pending", tool, approvalId: "ap_" + Math.random().toString(16).slice(2, 12),
      rule: isRefund ? "issue_refund · amount > ¥500" : tool + " · high-risk write",
      why: isRefund
        ? "退款 ¥1200 > ¥500,命中 policy-as-code 的分级放行条件——挂起等经理批。身份核验(订单号+邮箱+卡尾号)已通过,归属为你名下订单。"
        : "改/删是涉审写操作,在 adapter.execute 之前挂起成审批单(无 data 字段)。批准后同参重试消票执行,一单一次、防重放。",
    }, ctx);
    await typeOut("这是高危写操作,我已把它挂起成审批单,等**独立审批人**批复。批准后我会自动续跑并把结果回填到这里——发起人无法自批。", ctx);
    return;
  }
  if (/在苏州|哪些客户/.test(q)) {
    await toolRun("list_accounts", "ok", ctx);
    await toolRun("list_contacts", "ok", ctx);
    const phone = isMgr ? "13900001001" : "整列剔除(不返回)";
    await typeOut(
      `${isMgr ? "**苏州**的客户(经理跨销售可见)" : "你名下在**苏州**的客户(行级过滤后只含归你的行)"}:\n\n| 客户 | 城市 | 主要联系人 | 电话 |\n| --- | --- | --- | --- |\n| 华胜精密制造 | 苏州 | 陈建国 | ${phone} |\n\n${isMgr ? "经理身份不脱敏,电话可见。" : "销售身份下联系人电话在守卫出口整列剔除,邮箱可见。"}本次查询已记入审计。`,
      ctx,
    );
    return;
  }
  if (/华胜|金额|阶段/.test(q)) {
    await toolRun("list_opportunities", "ok", ctx);
    await toolRun("get_opportunity", "ok", ctx);
    await typeOut("**华胜精密制造**当前商机:\n\n| 商机 | 金额 | 阶段 |\n| --- | --- | --- |\n| 华胜产线扩建设备采购 | ¥480,000 | 方案评估 |\n\n金额钉死真库,改阶段属涉审写——若要改会走审批闸门。已记入审计。", ctx);
    return;
  }
  if (/电话|邮箱|陈建国/.test(q)) {
    await toolRun("get_contact", "ok", ctx);
    const phone = isMgr ? "电话 `13900001001`(经理可见)" : "电话**不在你的可见范围**(守卫出口整列剔除,不返回)";
    await typeOut(`**陈建国**(华胜精密制造 · 采购总监):\n\n${phone},邮箱 \`chenjianguo@huasheng.example.com\`(邮箱不脱敏)。字段规则在守卫出口执行,越权字段不进上下文。已记入审计。`, ctx);
    return;
  }
  if (isMgr && /盘点|盘子|pipeline|业绩|全员/.test(q)) {
    await toolRun("get_pipeline_summary", "ok", ctx);
    await typeOut("全团队本季度业绩盘(经理可见 `get_pipeline_summary`):\n\n| 销售 | 商机数 | 金额合计 |\n| --- | --- | --- |\n| 林哲 | 3 | ¥1,465,000 |\n| 罗宁 | 2 | ¥248,000 |\n\n此工具仅经理角色可见——销售身份的工具面里根本不出现。已记入审计。", ctx);
    return;
  }
  await toolRun("list_opportunities", "ok", ctx);
  await typeOut("你名下本季度商机盘点(行级过滤后):\n\n| 商机 | 金额 |\n| --- | --- |\n| 华胜产线扩建设备采购 | ¥480,000 |\n| 天工电站运维三年框架 | ¥720,000 |\n| 蓝川仓储管理系统年度合约 | ¥265,000 |\n\n看不到其他销售的盘子——全员业绩盘 `get_pipeline_summary` 是经理专属,不在你的工具面里。已记入审计。", ctx);
}
