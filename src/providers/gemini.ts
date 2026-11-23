import { GoogleGenerativeAI, Content } from "@google/generative-ai";
import { AIProvider, ImageDescription } from "./base";
import type { UsageReporter } from "../storage/usage";
import { Settings } from "../config/settings";
import { ChatMessage } from "../storage/models";

export const geminiModels = [
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite" }
];

export class GeminiProvider implements AIProvider {
    private genai: GoogleGenerativeAI;
    private model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;
    private modelId = Settings.GEMINI_MODEL;

    constructor() {
        if (!Settings.GEMINI_API_KEY || !Settings.GEMINI_FREE_PLAN_CONFIRMED ||
            !geminiModels.some(model => model.id === this.modelId)) {
            throw new Error("Configure Gemini with a key from a Free-tier project.");
        }
        this.genai = new GoogleGenerativeAI(Settings.GEMINI_API_KEY);
        this.model = this.genai.getGenerativeModel({ model: this.modelId }, { timeout: 15000 });
        console.log(`GeminiProvider initialized (model=${Settings.GEMINI_MODEL})`);
    }

    async chat(messages: ChatMessage[], reportUsage?: UsageReporter): Promise<string> {
        const geminiMessages: Content[] = [];
        let systemContent = "";
        
        for (const msg of messages) {
            if (msg.role === "system") {
                systemContent = msg.content;
            } else if (msg.role === "assistant") {
                geminiMessages.push({ role: "model", parts: [{ text: msg.content }] });
            } else {
                geminiMessages.push({ role: "user", parts: [{ text: msg.content }] });
            }
        }

        const model = systemContent
            ? this.genai.getGenerativeModel({
                model: this.modelId,
                systemInstruction: systemContent
            }, { timeout: 60000 })
            : this.model;
        const lastMessage = geminiMessages.at(-1);
        if (!lastMessage) throw new Error("No message to send to Gemini.");
        // A bounded history can start on an assistant reply, which Gemini's chat SDK rejects.
        const firstUser = geminiMessages.findIndex(message => message.role === "user");
        const chat = model.startChat({ history: geminiMessages.slice(firstUser, -1) });
        const response = await chat.sendMessage(lastMessage.parts);
        const usage = response.response.usageMetadata as
            | (typeof response.response.usageMetadata & { thoughtsTokenCount?: number })
            | undefined;
        const outputTokens = usage?.totalTokenCount != null && usage.promptTokenCount != null
            ? Math.max(0, usage.totalTokenCount - usage.promptTokenCount)
            : usage?.candidatesTokenCount == null ? undefined
                : usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0);
        reportUsage?.({
            provider: "gemini", model: this.modelId, inputTokens: usage?.promptTokenCount,
            outputTokens, totalTokens: usage?.totalTokenCount, costUsd: 0, costBasis: "free"
        });
        const reply = response.response.text().trim();
        if (!reply) throw new Error("Gemini returned an empty reply.");
        return reply;
    }

    async describeImage(_imageBuffer: Buffer, _mimeType: string): Promise<ImageDescription> {
        throw new Error("Image description not supported with Gemini provider. Use Ollama provider instead.");
    }

    async healthCheck(): Promise<boolean> {
        try {
            await this.model.generateContent({
                contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                generationConfig: { maxOutputTokens: 5 }
            });
            return true;
        } catch {
            return false;
        }
    }
}
