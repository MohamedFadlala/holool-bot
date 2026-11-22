import { Settings } from "../config/settings";
import { SYSTEM_PROMPT } from "../config/system-prompt";
import { getConnection } from "../storage/database";

export const providers = {
    ollama: { key: "OLLAMA_API_KEY", model: "OLLAMA_MODEL" },
    openrouter: { key: "OPENROUTER_API_KEY", model: "OPENROUTER_MODEL" },
    gemini: { key: "GEMINI_API_KEY", model: "GEMINI_MODEL" }
} as const;

export type ProviderName = keyof typeof providers;

export let systemPrompt = SYSTEM_PROMPT;

function writeSetting(name: string, value: unknown) {
    getConnection().prepare(`
        INSERT INTO holool_settings (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `).run(name, JSON.stringify(value));
}

export function saveSetting<T>(name: string, value: T, apply: (value: T) => void) {
    writeSetting(name, value);
    apply(value);
}

export function applyPrompt(value: string) {
    systemPrompt = value;
}

export function applyProvider(value: { provider: ProviderName; model: string; apiKey: string }) {
    const fields = providers[value.provider];
    Settings[fields.model] = value.model;
    Settings[fields.key] = value.apiKey;
    Settings.AI_PROVIDER = value.provider;
}

export function loadSettings() {
    getConnection().exec(`
        CREATE TABLE IF NOT EXISTS holool_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const rows = getConnection().prepare("SELECT name, value FROM holool_settings").all() as {name: string; value: string}[];
    for (const row of rows) {
        if (row.name === "prompt") applyPrompt(JSON.parse(row.value));
        if (row.name.startsWith("provider:")) applyProvider(JSON.parse(row.value));
    }
    const active = rows.find(row => row.name === "activeProvider");
    if (active) Settings.AI_PROVIDER = JSON.parse(active.value);
}

export function saveProvider(value: Parameters<typeof applyProvider>[0]) {
    getConnection().transaction(() => {
        writeSetting("provider:" + value.provider, value);
        writeSetting("activeProvider", value.provider);
    })();
    applyProvider(value);
}
