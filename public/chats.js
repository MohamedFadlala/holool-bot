const $ = selector => document.querySelector(selector);
const range = $("#range");
const chatSort = $("#chat-sort");
const chartMetric = $("#trend-metric");
const dialog = $("#chat-dialog");
const integer = new Intl.NumberFormat();
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6
});
const providers = { groq: "Groq", gemini: "Gemini", openrouter: "OpenRouter", openai: "OpenAI", ollama: "Ollama" };
const kinds = { chat: "Chat", audio: "Transcription", image: "Image" };
let report;
let offset = 0;
let search = "";
let revision = 0;
let chatRevision = 0;
let chatId;
let before;

const count = value => value == null ? "—" : integer.format(value);
const cost = value => value == null ? "—" : value > 0 && value < 0.000001 ? "<$0.000001" : dollars.format(value);

function duration(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return count(Math.round(seconds)) + " s";
  const rounded = Math.round(seconds);
  return count(Math.floor(rounded / 60)) + " min " + (rounded % 60) + " s";
}

function formattedDate(value) {
  return new Date(value.replace(" ", "T") + "Z").toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "short"
  });
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function alertAt(selector, message) {
  const node = $(selector);
  node.textContent = message;
  node.hidden = !message;
}

async function get(route, params = {}) {
  const query = new URLSearchParams({ ...params, range: range.value });
  const response = await fetch("/api/" + route + "?" + query);
  if (!response.ok) throw new Error((await response.json()).message || "Could not load this report.");
  return response.json();
}

function costParts(row) {
  const notes = [];
  if (row.subscriptionRequests) notes.push(count(row.subscriptionRequests) + " on ChatGPT plan");
  if (row.estimated) notes.push(count(row.estimated) + " estimated");
  if (row.unknownCost) notes.push(count(row.unknownCost) + " unknown");
  return notes.join(" · ");
}

function costCell(row) {
  const cell = element("td", cost(row.costUsd));
  const note = costParts(row);
  if (note) cell.append(element("small", note));
  return cell;
}

function renderModels(target, rows) {
  const body = $(target);
  body.replaceChildren(...rows.map(model => {
    const row = element("tr");
    const name = element("td", model.model);
    name.append(element("small", (providers[model.provider] || model.provider) + " · " + kinds[model.kind]));
    const tokens = element("td", count(model.tokens));
    if (model.unknownTokens) tokens.append(element("small", count(model.unknownTokens) + " without counts"));
    row.append(name, element("td", count(model.requests)), element("td", count(model.inputTokens)),
      element("td", count(model.outputTokens)), tokens, element("td", duration(model.audioSeconds)), costCell(model));
    return row;
  }));
}

function renderReport() {
  const totals = report.totals;
  $("#total-cost").textContent = cost(totals.costUsd);
  $("#cost-caption").textContent = costParts(totals) || "USD";
  $("#total-requests").textContent = count(totals.requests);
  $("#total-tokens").textContent = count(totals.tokens);
  $("#token-caption").textContent = count(totals.inputTokens) + " input · " +
    count(totals.outputTokens) + " output" + (totals.unknownTokens ? " · " + count(totals.unknownTokens) + " without counts" : "");
  $("#total-audio").textContent = duration(totals.audioSeconds);
  $("#request-caption").textContent = report.otherRequests
    ? count(report.otherRequests) + " outside chats, including provider tests"
    : "Across providers";
  $("#models-empty").hidden = report.models.length > 0;
  $("#models-empty").textContent = "Model usage will appear here after the bot makes a request.";
  renderModels("#model-rows", report.models);
  renderTrend();
}

function renderTrend() {
  if (!report) return;
  const chart = $("#trend-chart");
  const empty = $("#trend-empty");
  const metric = chartMetric.value;
  const label = metric === "tokens" ? "tokens" : "API cost";
  const formatter = metric === "tokens" ? count : cost;
  const end = new Date();
  const lookback = Math.min(Number(range.value) || 31, 31);
  const days = new Map(report.daily.map(day => [day.day, day]));
  const period = Array.from({ length: lookback }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - lookback + 1 + index);
    const key = date.toISOString().slice(0, 10);
    return days.get(key) || { day: key, [metric]: 0 };
  });
  const found = period.some(day => days.has(day.day) && day[metric] != null);
  empty.hidden = found;
  chart.hidden = !found;
  if (!found) {
    empty.textContent = "No daily " + label + " to chart for this period.";
    chart.replaceChildren();
    return;
  }

  const largest = Math.max(...period.map(day => day[metric] || 0), 1e-12);
  chart.replaceChildren(...period.map(day => {
    const column = element("div", null, "chart-column");
    const shortDay = day.day.slice(5).replace("-", "/");
    column.setAttribute("role", "listitem");
    column.title = day.day + " · " + formatter(day[metric]) + " " + label;
    column.setAttribute("aria-label", column.title);
    const axis = element("div");
    const bar = element("span", null, "chart-fill");
    bar.style.setProperty("--bar-height", (100 * (day[metric] ?? 0) / largest) + "%");
    axis.append(bar);
    column.append(axis, element("small", shortDay));
    return column;
  }));
  $("#trend-caption").textContent = "Latest " + lookback + " days · UTC";
}

function displayName(chat) {
  return chat.id.endsWith("@g.us") ? "WhatsApp group" : chat.name || chat.id;
}

function renderChats(data) {
  const empty = $("#chats-empty");
  empty.hidden = data.chats.length > 0;
  empty.textContent = search ? "No chats match this search." : "Incoming WhatsApp conversations will appear here.";
  $("#chat-rows").replaceChildren(...data.chats.map(chat => {
    const row = element("tr");
    const name = element("td");
    const button = element("button", displayName(chat), "chat-open");
    button.type = "button";
    button.addEventListener("click", () => void openChat(chat));
    name.append(button, element("small", chat.id));
    row.append(name, element("td", formattedDate(chat.lastSeen)), element("td", count(chat.requests)),
      element("td", count(chat.tokens)), costCell(chat));
    return row;
  }));
  $("#previous").disabled = offset === 0;
  $("#next").disabled = !data.hasMore;
  $("#chat-page").textContent = data.chats.length ? (offset + 1) + "–" + (offset + data.chats.length) : "";
}

async function refresh(showReport = true) {
  const request = ++revision;
  alertAt("#report-error", "");
  $("#refresh").disabled = true;
  $("#previous").disabled = true;
  $("#next").disabled = true;
  try {
    const results = await Promise.all([get("chats", { q: search, offset, sort: chatSort.value }), showReport ? get("usage") : null]);
    if (request !== revision) return;
    renderChats(results[0]);
    if (results[1]) {
      report = results[1];
      renderReport();
    }
  } catch (error) {
    if (request === revision) alertAt("#report-error", error.message);
  } finally {
    if (request === revision) $("#refresh").disabled = false;
  }
}

function messageRow(message) {
  const row = element("li", null, message.role === "assistant" ? "assistant" : "customer");
  const content = element("p", message.content);
  content.dir = "auto";
  row.append(content, element("small", (message.role === "assistant" ? "Bot" : "Customer") + " · " + formattedDate(message.createdAt)));
  return row;
}

async function openChat(chat) {
  chatId = chat.id;
  before = null;
  $("#detail-title").textContent = displayName(chat);
  $("#detail-id").textContent = chat.id;
  $("#detail-totals").textContent = "Loading chat…";
  $("#transcript").replaceChildren();
  $("#detail-models").replaceChildren();
  $("#older").hidden = true;
  $("#empty-transcript").hidden = true;
  dialog.showModal();
  await loadChat(false);
}

async function loadChat(older) {
  const request = ++chatRevision;
  const loadOlder = $("#older");
  loadOlder.disabled = true;
  alertAt("#detail-error", "");
  try {
    const result = await get("chat", older ? { id: chatId, before } : { id: chatId });
    if (request !== chatRevision) return;
    before = result.before;
    loadOlder.hidden = before == null;
    $("#transcript").prepend(...result.messages.map(messageRow));
    $("#empty-transcript").hidden = $("#transcript").childElementCount > 0;
    const totals = result.usage.totals;
    const caption = costParts(totals);
    $("#detail-totals").textContent = totals.requests
      ? count(totals.requests) + " requests · " + count(totals.tokens) + " tokens · " + cost(totals.costUsd) +
        (caption ? " · " + caption : "")
      : "No model usage was recorded for this chat in the selected period.";
    renderModels("#detail-models", result.usage.models);
  } catch (error) {
    if (request === chatRevision) alertAt("#detail-error", error.message);
  } finally {
    if (request === chatRevision) loadOlder.disabled = false;
  }
}

dialog.addEventListener("close", () => { ++chatRevision; });
$("#older").addEventListener("click", () => void loadChat(true));
$("#refresh").addEventListener("click", () => void refresh());
range.addEventListener("change", () => { offset = 0; void refresh(); });
chartMetric.addEventListener("change", renderTrend);
chatSort.addEventListener("change", () => { offset = 0; void refresh(false); });
$("#search-form").addEventListener("submit", event => {
  event.preventDefault();
  search = $("#search").value.trim();
  offset = 0;
  void refresh();
});
$("#previous").addEventListener("click", () => { offset = Math.max(0, offset - 25); void refresh(false); });
$("#next").addEventListener("click", () => { offset += 25; void refresh(false); });
void refresh();
