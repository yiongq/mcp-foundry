// Foundry LangGraph 客户端前端。
// 对话走 POST /api/chat 的 SSE 流（fetch + ReadableStream 手解 data: 行）。
// 审批闸门的 pending 单独渲染成审批卡片，批准成功后由服务端消票执行、结果回填。
// 后端契约：/api/config、/api/chat、/api/approvals。守卫/权限/审批全在网关执行，
// 本客户端零策略；连不上网关就显式标「网关未就绪」，绝不臆造数据。

const $ = (id) => document.getElementById(id);
const thread = $("thread");
const empty = $("empty");
const input = $("input");
const send = $("send");
const threadId = "web-" + Math.random().toString(36).slice(2, 10);

let approverEnabled = false;
let busy = false;

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

// ---- 每个已知角色的工具面（与 config/rbac.twenty.yaml 一致，供守卫栏可视化） ----
// gated: 涉审写；hidden: 该身份看不到（越权/跨域），演示「工具面在 LLM 看到前就收窄」。
const ROLE_SURFACE = {
  sales_rep: {
    domain: "CRM · Twenty",
    tools: [
      { n: "list_accounts" }, { n: "get_account" },
      { n: "list_contacts" }, { n: "get_contact" },
      { n: "list_opportunities" }, { n: "get_opportunity" },
      { n: "create_contact" },
      { n: "update_contact", gated: true },
      { n: "delete_contact", gated: true },
      { n: "update_opportunity_stage", gated: true },
      { n: "issue_refund", gated: "分级" },
      { n: "get_pipeline_summary", hidden: "经理专属" },
      { n: "get_salary", hidden: "跨域" },
    ],
  },
  sales_manager: {
    domain: "CRM · Twenty",
    tools: [
      { n: "list_accounts" }, { n: "get_account" }, { n: "list_contacts" },
      { n: "get_contact" }, { n: "list_opportunities" }, { n: "get_opportunity" },
      { n: "get_pipeline_summary" }, { n: "create_contact" },
      { n: "update_contact" }, { n: "delete_contact" },
      { n: "update_opportunity_stage" }, { n: "issue_refund" },
      { n: "get_salary", hidden: "跨域" },
    ],
    approver: true,
  },
};

function roleFrom(identityLabel) {
  const s = String(identityLabel || "").toLowerCase();
  if (s.includes("sales_manager")) return "sales_manager";
  if (s.includes("sales_rep")) return "sales_rep";
  return "sales_rep";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderSurface(role) {
  const spec = ROLE_SURFACE[role] || ROLE_SURFACE.sales_rep;
  $("id-domain").textContent = spec.domain;
  const box = $("tool-surface");
  box.textContent = "";
  for (const t of spec.tools) {
    const row = el("div", "tool-item" + (t.gated ? " gated" : "") + (t.hidden ? " hidden-tool" : ""));
    row.appendChild(el("span", "d"));
    row.appendChild(el("span", "name", t.n));
    if (t.hidden) row.appendChild(el("span", "flag", t.hidden));
    else if (t.gated) row.appendChild(el("span", "flag", t.gated === "分级" ? "分级审" : "需审批"));
    box.appendChild(row);
  }
}

// ---- 载入网关身份/模型信息（失败→显式「网关未就绪」，不臆造） ----
(async () => {
  let cfg;
  try {
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error();
    cfg = await r.json();
  } catch {
    $("chip-identity").textContent = "网关未就绪";
    $("chip-model").textContent = "模型 —";
    $("id-name").textContent = "网关未就绪";
    $("id-role").textContent = "—";
    return;
  }
  const role = roleFrom(cfg.identity);
  const parts = String(cfg.identity).split("·").map((s) => s.trim());
  $("id-name").textContent = parts[0] || cfg.identity;
  $("id-role").textContent = role;
  $("chip-identity").textContent = "身份 " + cfg.identity;
  $("chip-model").textContent = "模型 " + cfg.model;
  approverEnabled = !!cfg.approverEnabled;
  renderSurface(role);
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
  ask(text);
});
document.querySelectorAll("#prompts-read, #prompts-write").forEach((g) =>
  g.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-q]");
    if (btn && !busy) ask(btn.dataset.q);
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
  scrollDown();
  return { msg, bubble };
}

function scrollDown() {
  $("main").scrollTop = $("main").scrollHeight;
}

const TOOL_VERDICT = { ok: "已完成", refusal: "被守卫拒绝", error: "出错", running: "执行中…" };

async function ask(text) {
  busy = true;
  send.disabled = true;
  addMessage("user", text);
  const { bubble } = addMessage("ai", null);
  const toolsBox = el("div", "tools");
  bubble.parentElement.insertBefore(toolsBox, bubble);
  const toolRows = [];
  let answer = "";
  const cursor = el("span", "cursor");
  bubble.appendChild(cursor);

  const finish = () => {
    cursor.remove();
    busy = false;
    send.disabled = false;
  };

  let hadError = false;
  const ctx = {
    bubble, cursor, toolsBox, toolRows,
    addAnswer: (t) => (answer += t),
    markError: () => (hadError = true),
  };

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, threadId }),
    });
    if (!resp.ok || !resp.body) throw new Error("stream failed");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
        if (!line) continue;
        handleEvent(JSON.parse(line.slice(5).trim()), ctx);
      }
    }
    cursor.remove();
    if (hadError) appendInterrupted(bubble, answer);
    else if (answer) bubble.innerHTML = renderMarkdown(answer);
  } catch {
    cursor.remove();
    appendInterrupted(bubble, answer);
  } finally {
    finish();
  }
}

function appendInterrupted(bubble, answer) {
  bubble.innerHTML = answer ? renderMarkdown(answer) : "";
  const e = el("div", "stream-error");
  e.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20z"></path><path d="M12 9v5"></path><path d="M12 17.5v.01"></path></svg><span>回答被中断，请重试</span>';
  bubble.appendChild(e);
}

function firstRunning(rows, name) {
  return rows.find((r) => r.name === name && r.running) || null;
}

function handleEvent(evt, ctx) {
  if (evt.type === "token") {
    ctx.addAnswer(evt.text);
    ctx.cursor.remove();
    ctx.bubble.textContent = (ctx.bubble.textContent || "") + evt.text;
    ctx.bubble.appendChild(ctx.cursor);
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
    ctx.cursor.remove();
    ctx.bubble.textContent = evt.message;
    ctx.markError();
  }
}

// ---- 极简安全 markdown（先转义再处理表格/加粗/代码/段落） ----
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
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

const ICON = {
  clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5V12l3 1.8"></path></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
};

function renderApprovalCard(evt) {
  const card = el("div", "approval");
  const head = el("div", "head");
  const icon = el("span", "ic");
  icon.innerHTML = ICON.clock;
  const headTitle = el("span", "htxt", "需人工审批");
  const badge = el("span", "badge", "pending · 无 data");
  head.append(icon, headTitle, badge);
  card.appendChild(head);

  const meta = el("div", "meta");
  const add = (k, v) => { meta.appendChild(el("span", "k", k)); meta.appendChild(el("span", "v", v)); };
  add("工具", evt.tool);
  add("单号", evt.approvalId.slice(0, 8));
  add("命中规则", evt.rule || "high-risk write");
  card.appendChild(meta);

  card.appendChild(el("div", "why", evt.why ||
    "写操作在 adapter.execute 之前被挂起——挂起分支无 data 字段,结构上不夹带业务数据。批准后同参重试消票执行(一单一次,防重放)。"));

  const actions = el("div", "actions");
  const approve = el("button", "btn approve", "同意并执行");
  const deny = el("button", "btn deny", "拒绝");
  actions.append(approve, deny);
  actions.appendChild(el("span", "actor", "审批人 · 何静 sales_manager"));
  card.appendChild(actions);
  thread.appendChild(card);
  scrollDown();

  if (!approverEnabled) {
    approve.disabled = true;
    deny.disabled = true;
    card.appendChild(el("div", "why", "本部署未配置审批人身份——须在网关侧或飞书卡片批复(发起人无法自批)。"));
    return;
  }

  const decide = async (decision) => {
    approve.disabled = true;
    deny.disabled = true;
    try {
      const resp = await fetch("/api/approvals/" + evt.approvalId, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        card.classList.add("decided");
        headTitle.textContent = "批复失败：" + (body.error || "请重试");
        return;
      }
      if (decision === "approve") {
        card.classList.add("decided", "approved");
        icon.innerHTML = ICON.check;
        const exec = body.execution || {};
        if (exec.kind === "ok") headTitle.textContent = "已批准并执行完成";
        else if (exec.kind === "refusal") headTitle.textContent = "已批准，但执行被守卫拒绝（" + (exec.reason || "") + "）";
        else headTitle.textContent = "已批准（" + (exec.message || "执行结果见对话") + "）";
        badge.textContent = "consumed · 已消票";
      } else {
        card.classList.add("decided", "denied");
        icon.innerHTML = ICON.x;
        headTitle.textContent = "已拒绝，操作不会执行";
        badge.textContent = "denied";
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
