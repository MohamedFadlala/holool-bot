const $ = (selector, parent = document) => parent.querySelector(selector);
const names = { openrouter: "OpenRouter Free", groq: "Groq Free plan", gemini: "Gemini Free tier", openai: "OpenAI · ChatGPT plan" };
const promptForm = $("#prompt");
const providerForm = $("#provider");
const prompt = $("#system-prompt");
const model = $("#model");
const apiKey = $("#api-key");
const freeConfirmed = $("#free-confirmed");
const drafts = new Map();
let catalog;
const previewResult = $("#prompt-preview-result");
let settings;
let chosen;
let codexPoll;
let codexRevision = 0;

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
  if (path === "whatsapp") options.signal = AbortSignal.timeout(10000);
  const response = await fetch("/api/" + path, options);
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.message || "The server returned HTTP " + response.status + ".");
  return result;
}

function feedback(form, message, failed = false) {
  const status = $(".feedback", form);
  status.textContent = message;
  status.classList.toggle("error", failed);
}

function updateSummary() {
  $("#prompt-state").textContent = settings.prompt ? "Ready" : "Needs instructions";
  const active = settings.providers[settings.activeProvider];
  const activeModel = settings.activeModel || active?.model;
  const providerName = names[settings.activeProvider] || settings.activeProvider;
  const modelName = catalog?.[settings.activeProvider]?.find(option => option.id === activeModel)?.name || activeModel;
  const activeLabel = providerName + " · " + modelName;
  $("#provider-state").textContent = active?.hasKey ? activeLabel : settings.activeProvider === "openai" ? "Connect ChatGPT" : "API key needed";
  $("#active-model-name").textContent = activeLabel;
  $("#active-model-id").textContent = activeModel || "";
  const note = $("#active-model-note");
  note.textContent = !active?.hasKey
    ? (settings.activeProvider === "openai" ? "Connect ChatGPT to enable replies." : "Add a key to enable replies.")
    : activeModel === "openrouter/free" ? "Automatic routes each request to an available free model." : "";
  note.hidden = !note.textContent;
  updateDraft();
  $("#voice-status").textContent = settings.voiceConfigured
    ? "Voice transcription is configured with Groq Whisper."
    : "For voice transcription, save a Free-plan Groq key. You can keep your current chat provider.";
}

function updateDraft() {
  $("#model-draft").hidden = !chosen ||
    (settings.activeProvider === chosen && settings.activeModel === model.value && !apiKey.value.trim());
}

function selectProvider(name) {
  chosen = name;
  const saved = settings.providers[name];
  const draft = drafts.get(name);
  for (const button of providerForm.querySelectorAll("[data-provider]")) {
    button.setAttribute("aria-pressed", String(button.dataset.provider === name));
  }
  const choices = name === "openai" ? [] : catalog[name];
  const options = choices.map(option => new Option(option.name, option.id));
  const preferred = draft?.model || saved.model;
  if (name !== "openai" && preferred && !choices.some(option => option.id === preferred)) {
    options.unshift(new Option(preferred + " (saved, outside catalog)", preferred));
  }
  model.replaceChildren(...options);
  if (options.some(option => option.value === preferred)) model.value = preferred;
  apiKey.value = draft?.key ?? "";
  apiKey.placeholder = saved.hasKey ? "Saved · enter a new key to replace" : "Enter API key";
  const usesCodex = name === "openai";
  $("#provider-key-field").hidden = usesCodex;
  $("#codex-connection").hidden = !usesCodex;
  apiKey.required = !usesCodex && !saved.hasKey;
  $("#activate-provider").disabled = usesCodex;
  model.disabled = usesCodex;
  $("#refresh-codex-models").hidden = true;
  const needsConfirmation = name === "groq" || name === "gemini";
  $("#free-plan").hidden = !needsConfirmation;
  $("#save-voice").hidden = name !== "groq";
  freeConfirmed.required = needsConfirmation;
  freeConfirmed.checked = draft?.freePlanConfirmed ??
    (name === "groq" ? settings.groqFreePlanConfirmed : settings.geminiFreePlanConfirmed);
  $("#free-plan-label").textContent = name === "groq"
    ? "This key belongs to a Groq Free-plan organization."
    : "This key belongs to a Gemini Free-tier project.";
  const hints = {
    openai: "Connect ChatGPT to load the models available to your account.",
    groq: "Check your organization’s plan in Groq Console → Settings → Billing.",
    gemini: "Use an API key from a Free-tier project in Google AI Studio.",
    openrouter: catalog.catalogUnavailable
      ? "The model catalog is temporarily unavailable. You can still use the Free Models Router."
      : "OpenRouter free models have usage limits. Automatic picks an available free model."
  };
  $("#provider-hint").textContent = hints[name];
  updateDraft();
  cancelCodexPoll();
  if (usesCodex) void refreshCodexStatus(codexRevision);
}

function cancelCodexPoll() {
  clearTimeout(codexPoll);
  ++codexRevision;
}

function renderCodexStatus(result, revision) {
  if (revision !== codexRevision || chosen !== "openai") return;
  const active = result.state === "connected";
  const waiting = ["starting", "pending"].includes(result.state);
  settings.providers.openai.hasKey = active;
  $("#refresh-codex-models").hidden = !active;
  if (!active) {
    catalog.openai = [];
    model.replaceChildren();
    model.disabled = true;
    $("#activate-provider").disabled = true;
    $("#provider-hint").textContent = "Connect ChatGPT to load the models available to your account.";
  }
  $("#connect-codex").hidden = active || waiting;
  $("#disconnect-codex").hidden = !active && !waiting;
  $("#disconnect-codex").textContent = waiting ? "Cancel sign-in" : "Disconnect ChatGPT";
  $("#codex-device").hidden = !result.userCode;
  $("#codex-code").textContent = result.userCode || "";
  $("#codex-status").textContent = result.message || ({
    connected: "ChatGPT is connected.",
    disconnected: "Connect a ChatGPT account to use its Codex allowance.",
    starting: "Requesting a device code…",
    pending: "Waiting for you to approve sign-in."
  })[result.state];
  updateSummary();
  if (active) void refreshCodexModels(revision);
  if (waiting) codexPoll = setTimeout(() => void refreshCodexStatus(revision), 2000);
}

async function refreshCodexStatus(revision) {
  try {
    renderCodexStatus(await request("openai"), revision);
  } catch (error) {
    if (revision === codexRevision) $("#codex-status").textContent = error.message;
  }
}

async function refreshCodexModels(revision, force = false) {
  const refresh = $("#refresh-codex-models");
  const hint = $("#provider-hint");
  refresh.disabled = true;
  hint.textContent = "Loading models from your ChatGPT account…";
  try {
    const { models } = await request("openai/models" + (force ? "?refresh=1" : ""));
    if (revision !== codexRevision || chosen !== "openai") return;
    const saved = settings.providers.openai.model;
    const preferred = model.value || drafts.get("openai")?.model || saved;
    catalog.openai = models;
    const options = models.map(option => new Option(option.name, option.id));
    if (saved && !models.some(option => option.id === saved)) {
      options.unshift(new Option(saved + " (saved model)", saved));
    }
    model.replaceChildren(...options);
    if (options.some(option => option.value === preferred)) model.value = preferred;
    hint.textContent = models.length
      ? models.length + (models.length === 1 ? " model" : " models") + " available through your ChatGPT/Codex allowance."
      : "ChatGPT returned no available text models for this account.";
    updateSummary();
  } catch (error) {
    if (revision === codexRevision) hint.textContent = error.message;
  } finally {
    if (revision === codexRevision) {
      refresh.disabled = false;
      model.disabled = !model.options.length;
      $("#activate-provider").disabled = model.disabled;
    }
  }
}

async function changeCodexConnection(command) {
  cancelCodexPoll();
  const revision = codexRevision;
  await action(providerForm, async () => {
    const result = await request("openai/" + command, {});
    renderCodexStatus(result, revision);
    return "";
  });
}

$("#refresh-codex-models").addEventListener("click", () => void refreshCodexModels(codexRevision, true));
$("#connect-codex").addEventListener("click", () => void changeCodexConnection("connect"));
$("#disconnect-codex").addEventListener("click", () => void changeCodexConnection("disconnect"));

function countPrompt() {
  $("#prompt-length").textContent = prompt.value.length.toLocaleString() + " characters";
}

async function action(form, run) {
  const fields = $("fieldset", form);
  fields.disabled = true;
  feedback(form, "Working…");
  try {
    feedback(form, await run());
  } catch (error) {
    feedback(form, error.message, true);
  } finally {
    fields.disabled = false;
  }
}

prompt.addEventListener("input", countPrompt);
model.addEventListener("change", updateDraft);
apiKey.addEventListener("input", updateDraft);
promptForm.addEventListener("submit", event => {
  event.preventDefault();
  action(promptForm, async () => {
    const result = await request("prompt", { prompt: prompt.value });
    settings.prompt = result.prompt;
    prompt.value = result.prompt;
    previewResult.hidden = true;
    countPrompt();
    updateSummary();
    return "System prompt saved. New replies use these instructions.";
  });
});

$("#preview-prompt").addEventListener("click", () => {
  const sample = $("#preview-message").value.trim();
  if (!sample) {
    feedback(promptForm, "Enter a customer message to test the saved prompt.", true);
    $("#preview-message").focus();
    return;
  }
  previewResult.hidden = true;
  action(promptForm, async () => {
    const result = await request("prompt/preview", { sample });
    previewResult.textContent = result.reply;
    previewResult.hidden = false;
    return result.message;
  });
});

for (const button of providerForm.querySelectorAll("[data-provider]")) {
  button.addEventListener("click", () => {
    drafts.set(chosen, { model: model.value, key: apiKey.value, freePlanConfirmed: freeConfirmed.checked });
    selectProvider(button.dataset.provider);
    feedback(providerForm, "");
  });
}

providerForm.addEventListener("submit", event => {
  event.preventDefault();
  const voiceOnly = event.submitter?.value === "voice";
  action(providerForm, async () => {
    const result = await request("provider", {
      provider: chosen,
      model: model.value,
      apiKey: apiKey.value,
      freePlanConfirmed: freeConfirmed.checked,
      voiceOnly
    });
    settings = { ...result, prompt: settings.prompt };
    drafts.delete(chosen);
    selectProvider(chosen);
    updateSummary();
    return voiceOnly ? "Groq key saved for voice transcription." : "Active model saved: " + settings.activeModel + ".";
  });
});

$("[data-test]", providerForm).addEventListener("click", () =>
  action(providerForm, async () => (await request("provider/test", {})).message));

const connectButton = $("#connect-whatsapp");
const disconnectButton = $("#disconnect-whatsapp");
const qrImage = $("#whatsapp-qr");
const qrPanel = $(".pairing-code");
const whatsappLabels = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  disconnecting: "Disconnecting…",
  pairing: "Waiting for scan",
  connected: "Connected",
  error: "Disconnected — connection failed",
  unknown: "Connection unknown"
};
let whatsappActionPending = false;

function showWhatsApp(status) {
  const connection = window.showWhatsAppConnection(status);
  const label = status.state === "connected" ? connection.title : whatsappLabels[status.state] || whatsappLabels.unknown;
  const statusText = $("#pairing-status");
  $("#whatsapp-state").textContent = label;
  $("#whatsapp-state").dataset.state = status.state;
  const message = status.message || (status.state === "connected" ? connection.description : {
    disconnected: "WhatsApp is disconnected. The bot cannot receive messages, reply, or send team handoffs. Select Connect WhatsApp to resume.",
    connecting: "Connecting to WhatsApp…",
    disconnecting: "Removing the saved WhatsApp session…",
    pairing: "Waiting for you to scan the QR code.",
    connected: "WhatsApp is linked and ready to receive messages.",
    unknown: "Could not check WhatsApp. Connection status is unknown. Retrying…"
  }[status.state]);
  if (statusText.textContent !== message) statusText.textContent = message;
  statusText.classList.toggle("error", ["disconnected", "error", "unknown"].includes(status.state) || status.activity?.state === "error");
  connectButton.hidden = !["disconnected", "error"].includes(status.state);
  connectButton.disabled = whatsappActionPending;
  disconnectButton.hidden = ["disconnected", "unknown"].includes(status.state) || (status.state === "error" && !status.hasLinkedDevice);
  disconnectButton.disabled = whatsappActionPending || status.state === "disconnecting";
  $("#disconnect-hint").hidden = disconnectButton.hidden;
  connectButton.textContent = status.state === "error" ? "Try again" : "Connect WhatsApp";

  qrPanel.hidden = status.state !== "pairing";
  if (status.qrId) {
    const source = "/api/whatsapp/qr.png?id=" + encodeURIComponent(status.qrId);
    if (qrImage.getAttribute("src") !== source) qrImage.src = source;
  } else {
    qrImage.removeAttribute("src");
  }
}

async function refreshWhatsApp() {
  try {
    const status = await request("whatsapp");
    if (!whatsappActionPending) showWhatsApp(status);
  } catch {
    if (!whatsappActionPending) showWhatsApp({ state: "unknown" });
  } finally {
    setTimeout(refreshWhatsApp, 2000);
  }
}

async function changeWhatsAppConnection(action, state) {
  whatsappActionPending = true;
  showWhatsApp({ state });
  let status;
  try {
    status = await request("whatsapp/" + action, {});
  } catch (error) {
    status = { state: "unknown", message: "Could not confirm the WhatsApp connection. " + error.message };
  } finally {
    whatsappActionPending = false;
    showWhatsApp(status);
  }
}

connectButton.addEventListener("click", () => changeWhatsAppConnection("connect", "connecting"));
disconnectButton.addEventListener("click", () => changeWhatsAppConnection("disconnect", "disconnecting"));

void refreshWhatsApp();

function updateNavigation() {
  for (const link of document.querySelectorAll("nav a")) {
    const active = link.hash === (location.hash || "#overview");
    link.classList.toggle("current", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", updateNavigation);
updateNavigation();

const catalogRequest = request("provider/models").catch(() => ({
  catalogUnavailable: true, openrouter: [], groq: [], gemini: [], openai: []
}));
request("settings").then(async result => {
  settings = result;
  prompt.value = settings.prompt;
  countPrompt();
  updateSummary();
  $("fieldset", promptForm).disabled = false;
  catalog = await catalogRequest;
  selectProvider(Object.hasOwn(names, settings.activeProvider) ? settings.activeProvider : "openrouter");
  updateSummary();
  $("fieldset", providerForm).disabled = false;
}).catch(error => {
  const status = $("#load-error");
  status.textContent = "Could not load settings. " + error.message;
  status.hidden = false;
});
