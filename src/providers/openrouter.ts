import axios from "axios";
import { AIProvider, ImageDescription } from "./base";
import { Settings } from "../config/settings";
import { ChatMessage, toDict } from "../storage/models";

export const freeRouter = { id: "openrouter/free", name: "Automatic — Free Models Router" };

export function isFreeOpenRouterModel(id: string) {
    return id === freeRouter.id || /^[a-z0-9_.-]+\/[a-z0-9_.-]+:free$/i.test(id);
}

interface CatalogModel {
    id: string;
    name: string;
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
    pricing?: { prompt?: string; completion?: string };
}

export async function listFreeOpenRouterModels() {
    const { data } = await axios.get<{ data: CatalogModel[] }>("https://openrouter.ai/api/v1/models", {
        timeout: 7000,
        maxRedirects: 0
    });
    const models = data.data.filter(model =>
        model.id !== freeRouter.id && isFreeOpenRouterModel(model.id) &&
        model.architecture?.input_modalities?.includes("text") &&
        model.architecture?.output_modalities?.includes("text") &&
        model.pricing?.prompt != null && Number(model.pricing.prompt) === 0 &&
        model.pricing?.completion != null && Number(model.pricing.completion) === 0
    ).map(({ id, name }) => ({ id, name }));
    return [freeRouter, ...models.sort((a, b) => a.name.localeCompare(b.name))];
}

export class OpenRouterProvider implements AIProvider {
    private apiKey: string;
    private model: string;
    private baseUrl = "https://openrouter.ai/api/v1/chat/completions";

    constructor() {
        this.apiKey = Settings.OPENROUTER_API_KEY;
        if (!isFreeOpenRouterModel(Settings.OPENROUTER_MODEL)) throw new Error("Choose a free OpenRouter model.");
        this.model = Settings.OPENROUTER_MODEL;
        console.log(`OpenRouterProvider initialized (model=${this.model})`);
    }

    async chat(messages: ChatMessage[]): Promise<string> {
        const payload = {
            model: this.model,
            messages: messages.map(toDict)
        };

        const response = await axios.post(this.baseUrl, payload, {
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            timeout: 60000
        });

        const content = response.data.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error("OpenRouter returned an empty reply.");
        return content;
    }

    async describeImage(_imageBuffer: Buffer, _mimeType: string): Promise<ImageDescription> {
        throw new Error("Image description not supported with OpenRouter provider. Use Ollama provider instead.");
    }

    async healthCheck(): Promise<boolean> {
        try {
            const payload = {
                model: this.model,
                messages: [{ role: "user", content: "ping" }],
                max_tokens: 5
            };
            
            const response = await axios.post(this.baseUrl, payload, {
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                timeout: 10000
            });
            
            return response.status === 200;
        } catch {
            return false;
        }
    }
}
