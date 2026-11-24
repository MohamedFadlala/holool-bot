import { Settings } from "../config/settings";
import { isFreeOpenRouterModel, freeRouter } from "../providers/openrouter";
import { geminiModels } from "../providers/gemini";
import { groqModels } from "../providers/groq";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } from "../config/system-prompt";
import { getConnection } from "../storage/database";

export const providers = {
    openai: { key: null, model: "CODEX_CHAT_MODEL" },
    openrouter: { key: "OPENROUTER_API_KEY", model: "OPENROUTER_MODEL" },
    groq: { key: "GROQ_CHAT_API_KEY", model: "GROQ_CHAT_MODEL" },
    gemini: { key: "GEMINI_API_KEY", model: "GEMINI_MODEL" }
} as const;

export type ProviderName = keyof typeof providers;

export let systemPrompt = SYSTEM_PROMPT;
export let systemPromptRevision = 0;

function writeSetting(name: string, value: unknown) {
    getConnection().prepare(`
        INSERT INTO holool_settings (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `).run(name, JSON.stringify(value));
}

export function savePrompt(prompt: string) {
    if (prompt === systemPrompt) return;
    const revision = systemPromptRevision + 1;
    getConnection().transaction(() => {
        writeSetting("prompt", prompt);
        writeSetting("promptRevision", revision);
    })();
    systemPrompt = prompt;
    systemPromptRevision = revision;
}

export function applyProvider(value: { provider: ProviderName; model: string; apiKey: string; freePlanConfirmed?: boolean }) {
    const fields = providers[value.provider];
    Settings[fields.model] = value.model;
    if (fields.key) Settings[fields.key] = value.apiKey;
    if (value.provider === "groq") Settings.GROQ_FREE_PLAN_CONFIRMED = value.freePlanConfirmed === true;
    if (value.provider === "gemini") Settings.GEMINI_FREE_PLAN_CONFIRMED = value.freePlanConfirmed === true;
}

export function loadSettings() {
    getConnection().exec(`
        CREATE TABLE IF NOT EXISTS holool_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const rows = getConnection().prepare("SELECT name, value FROM holool_settings").all() as {name: string; value: string}[];
    const prompt = rows.find(row => row.name === "prompt");
    const revision = rows.find(row => row.name === "promptRevision");
    systemPrompt = prompt ? JSON.parse(prompt.value) : SYSTEM_PROMPT;
    // Older custom prompts have no revision. Exclude assistant replies whose prompt is unknown.
    systemPromptRevision = revision ? JSON.parse(revision.value) : systemPrompt === SYSTEM_PROMPT ? 0 : 1;
    // Install the requested prompt once on existing deployments too. Subsequent
    // dashboard edits remain authoritative until the next bundled prompt release.
    const bundledVersion = rows.find(row => row.name === "bundledPromptVersion");
    if (!bundledVersion || JSON.parse(bundledVersion.value) !== SYSTEM_PROMPT_VERSION) {
        const nextRevision = systemPromptRevision + 1;
        getConnection().transaction(() => {
            writeSetting("prompt", SYSTEM_PROMPT);
            writeSetting("promptRevision", nextRevision);
            writeSetting("bundledPromptVersion", SYSTEM_PROMPT_VERSION);
        })();
        systemPrompt = SYSTEM_PROMPT;
        systemPromptRevision = nextRevision;
    }
    for (const row of rows) {
        if (row.name.startsWith("provider:")) {
            const provider = row.name.slice("provider:".length);
            if (Object.hasOwn(providers, provider)) applyProvider(JSON.parse(row.value));
        }
    }
    const active = rows.find(row => row.name === "activeProvider");
    const selected = active ? JSON.parse(active.value) : Settings.AI_PROVIDER;
    Settings.AI_PROVIDER = "openrouter";
    if (selected === "openai") Settings.AI_PROVIDER = "openai";
    if (selected === "groq" && Settings.GROQ_CHAT_API_KEY && Settings.GROQ_FREE_PLAN_CONFIRMED &&
        groqModels.some(model => model.id === Settings.GROQ_CHAT_MODEL)) Settings.AI_PROVIDER = "groq";
    if (selected === "gemini" && Settings.GEMINI_API_KEY && Settings.GEMINI_FREE_PLAN_CONFIRMED &&
        geminiModels.some(model => model.id === Settings.GEMINI_MODEL)) Settings.AI_PROVIDER = "gemini";
    if (!geminiModels.some(model => model.id === Settings.GEMINI_MODEL)) Settings.GEMINI_MODEL = geminiModels[0].id;
    if (!isFreeOpenRouterModel(Settings.OPENROUTER_MODEL)) Settings.OPENROUTER_MODEL = freeRouter.id;
}

export function saveProvider(value: Parameters<typeof applyProvider>[0], activate = true) {
    getConnection().transaction(() => {
        writeSetting("provider:" + value.provider, value);
        if (activate) writeSetting("activeProvider", value.provider);
    })();
    applyProvider(value);
    if (activate) Settings.AI_PROVIDER = value.provider;
}
