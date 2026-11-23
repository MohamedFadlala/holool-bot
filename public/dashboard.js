const $ = (selector, parent = document) => parent.querySelector(selector);
const names = { openrouter: "OpenRouter Free", groq: "Groq Free plan" };
const promptForm = $("#prompt");
const providerForm = $("#provider");
const prompt = $("#system-prompt");
const model = $("#model");
const apiKey = $("#api-key");
const groqFree = $("#groq-free");
const drafts = new Map();
let catalog;
let settings;
let chosen;

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
  const response = await fetch("/api/" + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message);
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
  $("#provider-state").textContent = active?.hasKey ? names[settings.activeProvider] : "API key needed";
}

function selectProvider(name) {
  chosen = name;
  const saved = settings.providers[name];
  const draft = drafts.get(name);
  for (const button of providerForm.querySelectorAll("[data-provider]")) {
    button.setAttribute("aria-pressed", String(button.dataset.provider === name));
  }
  const choices = catalog[name];
  model.replaceChildren(...choices.map(option => new Option(option.name, option.id)));
  const preferred = draft?.model || saved.model;
  if (choices.some(option => option.id === preferred)) model.value = preferred;
  apiKey.value = draft?.key ?? "";
  apiKey.placeholder = saved.hasKey ? "Saved · enter a new key to replace" : "Enter API key";
  apiKey.required = !saved.hasKey;
  $("#groq-plan").hidden = name !== "groq";
  groqFree.required = name === "groq";
  groqFree.checked = draft?.freePlanConfirmed ?? settings.groqFreePlanConfirmed;
  $("#provider-hint").textContent = name === "groq"
    ? "Check your organization’s plan in Groq Console → Settings → Billing."
    : catalog.catalogUnavailable
      ? "The model catalog is temporarily unavailable. You can still use the Free Models Router."
      : "OpenRouter free models have usage limits. Automatic picks an available free model.";
}

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
promptForm.addEventListener("submit", event => {
  event.preventDefault();
  action(promptForm, async () => {
    settings = await request("prompt", { prompt: prompt.value });
    prompt.value = settings.prompt;
    countPrompt();
    updateSummary();
    return "System prompt saved.";
  });
});

for (const button of providerForm.querySelectorAll("[data-provider]")) {
  button.addEventListener("click", () => {
    drafts.set(chosen, { model: model.value, key: apiKey.value, freePlanConfirmed: groqFree.checked });
    selectProvider(button.dataset.provider);
    feedback(providerForm, "");
  });
}

providerForm.addEventListener("submit", event => {
  event.preventDefault();
  action(providerForm, async () => {
    settings = await request("provider", {
      provider: chosen,
      model: model.value,
      apiKey: apiKey.value,
      freePlanConfirmed: chosen === "groq" && groqFree.checked
    });
    drafts.delete(chosen);
    selectProvider(chosen);
    updateSummary();
    return names[chosen] + " is active.";
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
  error: "Connection failed"
};
let whatsappActionPending = false;

function showWhatsApp(status) {
  const label = whatsappLabels[status.state];
  const statusText = $("#pairing-status");
  $("#whatsapp-state").textContent = label;
  const message = status.message || {
    disconnected: "No WhatsApp device is linked.",
    connecting: "Connecting to WhatsApp…",
    disconnecting: "Removing the saved WhatsApp session…",
    pairing: "Waiting for you to scan the QR code.",
    connected: "WhatsApp is linked and ready to receive messages."
  }[status.state];
  if (statusText.textContent !== message) statusText.textContent = message;
  statusText.classList.toggle("error", status.state === "error");
  connectButton.hidden = !["disconnected", "error"].includes(status.state);
  connectButton.disabled = whatsappActionPending;
  disconnectButton.hidden = status.state === "disconnected" || (status.state === "error" && !status.hasLinkedDevice);
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
    if (!whatsappActionPending) showWhatsApp({ state: "error", message: "Could not check WhatsApp. Retrying…" });
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
    status = { state: "error", message: error.message };
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

Promise.all([request("settings"), request("provider/models")]).then(([result, choices]) => {
  settings = result;
  catalog = choices;
  prompt.value = settings.prompt;
  countPrompt();
  selectProvider(Object.hasOwn(names, settings.activeProvider) ? settings.activeProvider : "openrouter");
  updateSummary();
  for (const fields of document.querySelectorAll("fieldset")) fields.disabled = false;
}).catch(error => {
  const status = $("#load-error");
  status.textContent = "Could not load settings. " + error.message;
  status.hidden = false;
});
