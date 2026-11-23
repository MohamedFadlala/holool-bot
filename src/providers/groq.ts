import Groq from "groq-sdk";
import type { UsageReporter } from "../storage/usage";
import { Settings } from "../config/settings";
import { ChatMessage, toDict } from "../storage/models";
import { AIProvider, ImageDescription } from "./base";

export const groqModels = [
    { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B" },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B" },
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B" }
];

export class GroqProvider implements AIProvider {
    private client: Groq;
    private model = Settings.GROQ_CHAT_MODEL;

    constructor() {
        if (!Settings.GROQ_FREE_PLAN_CONFIRMED || !Settings.GROQ_CHAT_API_KEY ||
            !groqModels.some(model => model.id === this.model)) {
            throw new Error("Configure Groq with a key from a Free-plan organization.");
        }
        this.client = new Groq({ apiKey: Settings.GROQ_CHAT_API_KEY, timeout: 45000, maxRetries: 0 });
    }

    async chat(messages: ChatMessage[], reportUsage?: UsageReporter): Promise<string> {
        const model = this.model;
        const reply = await this.client.chat.completions.create({
            model,
            messages: messages.map(toDict) as Groq.Chat.ChatCompletionMessageParam[],
            max_completion_tokens: 800
        });
        reportUsage?.({
            provider: "groq", model: reply.model || model, inputTokens: reply.usage?.prompt_tokens,
            outputTokens: reply.usage?.completion_tokens, totalTokens: reply.usage?.total_tokens,
            costUsd: 0, costBasis: "free"
        });
        const content = reply.choices[0]?.message.content?.trim();
        if (!content) throw new Error("Groq returned an empty reply.");
        return content;
    }

    async describeImage(): Promise<ImageDescription> {
        throw new Error("The selected Groq model only supports text.");
    }

    async healthCheck(): Promise<boolean> {
        try {
            await this.chat([{ role: "user", content: "Reply with one word: ready." }]);
            return true;
        } catch {
            return false;
        }
    }
}
