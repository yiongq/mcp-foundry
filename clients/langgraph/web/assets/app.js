// Foundry LangGraph 客户端前端。
// 对话走 POST /api/chat 的 SSE 流（fetch + ReadableStream 手解 data: 行——
// POST 用不了 EventSource）。审批闸门的 pending 单独渲染成审批卡片，
// 批准成功后自动重发原消息触发网关的「重试消票执行」续跑语义。

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

// ---- 载入网关身份/模型信息 ----
(async () => {
  try {
    const cfg = await (await fetch("/api/config")).json();
    $("chip-identity").textContent = "身份 " + cfg.identity;
    $("chip-model").textContent = "模型 " + cfg.model;
    approverEnabled = !!cfg.approverEnabled;
  } catch {
    $("chip-identity").textContent = "网关未就绪";
  }
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
$("prompts").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-q]");
  if (btn && !busy) ask(btn.dataset.q);
});

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

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

const TOOL_VERDICT = {
  ok: "已完成",
  refusal: "被守卫拒绝",
  error: "出错",
  running: "执行中…",
};

async function ask(text) {
  busy = true;
  send.disabled = true;
  addMessage("user", text);
  const { bubble } = addMessage("ai", null);
  const toolsBox = el("div", "tools");
  bubble.parentElement.insertBefore(toolsBox, bubble);
  const toolRows = []; // 列表而非按名去重——同名工具多次调用各占一行
  let answer = "";
  const cursor = el("span", "cursor");
  bubble.appendChild(cursor);

  const finish = () => {
    cursor.remove();
    busy = false;
    send.disabled = false;
  };

  let hadError = false;
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
      // SSE 事件分隔符可能是 \r\n\r\n（sse-starlette 默认）或 \n\n——用正则兼容两者，
      // 且容忍分隔符被拆在两次读之间（未匹配就继续缓冲，下次再切）
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
        if (!line) continue;
        const evt = JSON.parse(line.slice(5).trim());
        handleEvent(evt, {
          bubble,
          cursor,
          toolsBox,
          toolRows,
          addAnswer: (t) => (answer += t),
          markError: () => (hadError = true),
        });
      }
    }
    cursor.remove();
    // 出错时：不要用半截答案覆盖掉错误信息（否则 demo 会把"出错"显示成"已完成"）
    if (hadError) {
      appendInterrupted(bubble, answer);
    } else if (answer) {
      bubble.innerHTML = renderMarkdown(answer); // 正常结束：整段 markdown 渲染
    }
  } catch {
    // 网络中断/流失败：残答不能冒充成功，明确标"被中断"
    cursor.remove();
    appendInterrupted(bubble, answer);
  } finally {
    finish();
  }
}

// 中断态：有残答就渲染出来但标明未完成，无残答就纯提示——都带红色"被中断"条
function appendInterrupted(bubble, answer) {
  bubble.innerHTML = answer ? renderMarkdown(answer) : "";
  const note = el("div", "stream-error", "⚠ 回答被中断，请重试");
  bubble.appendChild(note);
}

// 找最早一个仍在「执行中」且同名的行——匹配 start/end，兼容同名工具多次调用
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
      row.dom.querySelector(".verdict").textContent =
        "· " + (TOOL_VERDICT[evt.kind] || evt.kind);
    }
  } else if (evt.type === "pending") {
    const row = firstRunning(ctx.toolRows, evt.tool);
    if (row) {
      row.running = false;
      row.dom.querySelector(".verdict").textContent = "· 待审批";
    }
    renderApprovalCard(evt);
  } else if (evt.type === "error") {
    ctx.cursor.remove();
    ctx.bubble.textContent = evt.message;
    ctx.markError(); // 标记出错，流末不要用半截答案覆盖
  }
}

// 极简安全 markdown：先转义 HTML（内容来自 LLM/网关，必须防注入），再处理
// 管道表格、**加粗**、`代码`、段落与换行。不引第三方库。
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
function renderTable(lines) {
  const cells = (row) =>
    row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = cells(lines[0]);
  const bodyRows = lines.slice(2).map(cells); // 第 2 行是 |---| 分隔线
  const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
  const trs = bodyRows
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="tbl-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}
function renderMarkdown(md) {
  const blocks = md.trim().split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.length >= 2 && lines[0].includes("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1])) {
        return renderTable(lines);
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

function renderApprovalCard(evt) {
  const card = el("div", "approval");
  const head = el("div", "head");
  head.appendChild(document.createTextNode("🛂 需人工审批"));
  card.appendChild(head);
  card.appendChild(el("div", "sub", `${evt.tool} · 单号 ${evt.approvalId.slice(0, 8)} · ${evt.rule}`));
  const actions = el("div", "actions");
  const approve = el("button", "btn approve", "同意并执行");
  const deny = el("button", "btn deny", "拒绝");
  actions.append(approve, deny);
  card.appendChild(actions);
  thread.appendChild(card);
  scrollDown();

  if (!approverEnabled) {
    approve.disabled = true;
    deny.disabled = true;
    card.appendChild(el("div", "sub", "（本部署未配置审批人身份，需在网关侧或飞书批复）"));
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
        head.textContent = "⚠️ " + (body.error || "批复失败");
        return;
      }
      if (decision === "approve") {
        card.classList.add("decided", "approved");
        // 服务端批准后已直接消票执行，body.execution 是网关的执行结果
        const exec = body.execution || {};
        if (exec.kind === "ok") {
          head.textContent = "✅ 已批准并执行完成";
        } else if (exec.kind === "refusal") {
          head.textContent = `✅ 已批准，但执行被守卫拒绝（${exec.reason || ""}）`;
        } else {
          head.textContent = "✅ 已批准（" + (exec.message || "执行结果见对话") + "）";
        }
      } else {
        card.classList.add("decided", "denied");
        head.textContent = "❌ 已拒绝，操作不会执行";
      }
    } catch {
      approve.disabled = false;
      deny.disabled = false;
      head.textContent = "🛂 需人工审批（网络出错，重试）";
    }
  };
  approve.addEventListener("click", () => decide("approve"));
  deny.addEventListener("click", () => decide("deny"));
}
