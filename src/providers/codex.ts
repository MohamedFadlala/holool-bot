import { Settings } from "../config/settings";
import type { ChatMessage } from "../storage/models";
import type { UsageReporter } from "../storage/usage";
import type { AIProvider, ImageDescription } from "./base";
import { codexCredentials, hasCodexProfile } from "./codex-auth";

export const codexModels = [
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" }
];
const endpoint = "https://chatgpt.com/backend-api/codex/responses";

interface OutputPart { type?: string; text?: string; refusal?: string }
interface CodexResponse {
    model?: string;
    status?: string;
    output?: Array<{ type?: string; content?: OutputPart[] }>;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    error?: { code?: string };
}
interface CodexEvent {
    type?: string;
    delta?: string;
    code?: string;
    error?: { code?: string };
    response?: CodexResponse;
}

function streamError(code: string | undefined) {
    const limited = code === "usage_limit_reached" || code === "rate_limit_exceeded";
    return Object.assign(new Error(limited ? "ChatGPT subscription usage is currently limited."
        : "ChatGPT did not complete the reply."), { status: limited ? 429 : 502 });
}

async function readReply(body: ReadableStream<Uint8Array>, model: string, report?: UsageReporter) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let deltas = "";
    function readEvent(frame: string) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") return;
        const event = JSON.parse(data) as CodexEvent;
        if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
            deltas += event.delta ?? "";
            if (deltas.length > 1000000) throw new Error("ChatGPT returned an oversized reply.");
        }
        if (!["response.completed", "response.done", "response.incomplete", "response.failed", "error"].includes(event.type ?? "")) return;

        const final = event.response;
        if (final?.usage || event.type === "response.completed" || event.type === "response.done") {
            report?.({
                provider: "openai", model: final?.model || model,
                inputTokens: final?.usage?.input_tokens, outputTokens: final?.usage?.output_tokens,
                totalTokens: final?.usage?.total_tokens, costBasis: "subscription"
            });
        }
        if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete" ||
            (final?.status && final.status !== "completed")) {
            throw streamError(event.code || event.error?.code || final?.error?.code);
        }
        const text = final?.output?.filter(item => item.type === "message")
            .flatMap(item => item.content ?? []).map(part => part.text || part.refusal || "").join("");
        return (text || deltas).trim();
    }

    try {
        for (;;) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";
            if (done && buffer) frames.push(buffer);
            for (const frame of frames) {
                const reply = readEvent(frame);
                if (reply !== undefined) {
                    if (!reply) throw new Error("ChatGPT returned an empty reply.");
                    return reply;
                }
            }
            if (done) throw new Error("ChatGPT ended the response before completing the reply.");
            if (buffer.length > 1000000) throw new Error("ChatGPT returned an oversized response event.");
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

export class CodexProvider implements AIProvider {
    private model = Settings.CODEX_CHAT_MODEL;

    async chat(messages: ChatMessage[], report?: UsageReporter): Promise<string> {
        const options = JSON.stringify({
            model: this.model,
            instructions: messages.filter(message => message.role === "system").map(message => message.content).join("\n\n")
                || "Respond helpfully to the customer.",
            input: messages.filter(message => message.role !== "system").map(message => ({
                type: "message", role: message.role,
                content: message.role === "assistant"
                    ? [{ type: "output_text", text: message.content, annotations: [] }]
                    : [{ type: "input_text", text: message.content }]
            })),
            stream: true,
            store: false,
            tools: []
        });
        const send = (auth: Awaited<ReturnType<typeof codexCredentials>>) => fetch(endpoint, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
            headers: {
                Authorization: "Bearer " + auth.access,
                "ChatGPT-Account-Id": auth.accountId,
                "OpenAI-Beta": "responses=experimental",
                "User-Agent": "holool-bot",
                originator: "holool-bot",
                "Content-Type": "application/json",
                Accept: "text/event-stream"
            },
            body: options
        });

        const auth = await codexCredentials();
        let result = await send(auth);
        if (result.status === 401) {
            await result.body?.cancel();
            result = await send(await codexCredentials(auth.access));
        }
        if (!result.ok || !result.body) {
            await result.body?.cancel();
            throw Object.assign(new Error("ChatGPT could not serve this reply."), { status: result.status });
        }
        return readReply(result.body, this.model, report);
    }

    async describeImage(): Promise<ImageDescription> {
        throw new Error("The ChatGPT plan provider is configured for text replies.");
    }

    async healthCheck(): Promise<boolean> {
        if (!hasCodexProfile()) return false;
        try {
            await this.chat([{ role: "user", content: "Reply with one word: ready." }]);
            return true;
        } catch {
            return false;
        }
    }
}
