import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { toBuffer } from "qrcode";
import { sessionManager } from "../whatsapp/session-manager";
import { Settings } from "../config/settings";
import { getProvider } from "../providers";
import { groqModels } from "../providers/groq";
import { freeRouter, isFreeOpenRouterModel, listFreeOpenRouterModels } from "../providers/openrouter";
import { isAxiosError } from "axios";
import { applyPrompt, providers, ProviderName, saveProvider, saveSetting, systemPrompt } from "./config";
import { HttpError, readBody } from "./http";
const whatsappSessionId = "default";

function whatsappStatus() {
    const status = sessionManager.getStatus(whatsappSessionId);
    return status.state === "pairing" ? { state: status.state, qrId: status.qrId } : status;
}

const assets: Record<string, string> = {
    "/": "index.html",
    "/dashboard.css": "dashboard.css",
    "/dashboard.js": "dashboard.js",
    "/assets/holool-mark.webp": "assets/holool-mark.webp",
    "/assets/holool-logo.webp": "assets/holool-logo.webp",
    "/assets/holool-city.webp": "assets/holool-city.webp"
};
const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    webp: "image/webp"
};

function json(res: ServerResponse, result: object, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
}

function errorResponse(res: ServerResponse, error: unknown) {
    if (error instanceof HttpError) return json(res, { message: error.message }, error.status);
    if (error instanceof SyntaxError) return json(res, { message: "Invalid JSON." }, 400);
    console.error("holool-bot request failed:", error instanceof Error ? error.name : "UnknownError");
    json(res, { message: "The request failed. Check the service and try again." }, 500);
}

function snapshot() {
    return {
        prompt: systemPrompt,
        activeProvider: Settings.AI_PROVIDER,
        groqFreePlanConfirmed: Settings.GROQ_FREE_PLAN_CONFIRMED,
        providers: Object.fromEntries(Object.entries(providers).map(([name, fields]) => [
            name, { model: Settings[fields.model], hasKey: Boolean(Settings[fields.key]) }
        ]))
    };
}

async function modelChoices() {
    try {
        return { openrouter: await listFreeOpenRouterModels(), groq: groqModels };
    } catch {
        return { openrouter: [freeRouter], groq: groqModels, catalogUnavailable: true };
    }
}

async function testProvider() {
    const label = Settings.AI_PROVIDER === "groq" ? "Groq" : "OpenRouter";
    const configured = Settings.AI_PROVIDER === "groq" ? Settings.GROQ_CHAT_API_KEY : Settings.OPENROUTER_API_KEY;
    if (!configured) throw new HttpError(400, `Save an API key for ${label} first.`);
    try {
        await getProvider().chat([{ role: "user", content: "Reply with one word: ready." }]);
        return { message: `${label} generated a test reply.` };
    } catch (error) {
        const status = isAxiosError(error) ? error.response?.status : (error as { status?: number })?.status;
        if (status === 401 || status === 403) throw new HttpError(502, `${label} rejected the key or model access. Check your key and account.`);
        if (status === 402) throw new HttpError(502, `${label} declined this request because of its billing or credit rules.`);
        if (status === 429) throw new HttpError(429, `${label} is rate-limiting this model. Try again later or select another free model.`);
        if (status === 404) throw new HttpError(502, `${label} could not serve this model. Select another free model.`);
        throw new HttpError(502, `${label} could not generate a test reply. Try another free model.`);
    }
}

async function editSettings(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
        throw new HttpError(415, "Expected application/json.");
    }
    const data = JSON.parse((await readBody(req)).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Invalid settings.");
    const field = (key: string) => typeof data[key] === "string" ? data[key].trim() as string : "";

    switch (path) {
        case "/api/prompt": {
            const prompt = field("prompt");
            if (!prompt || prompt.length > 32000) throw new HttpError(400, "Enter a system prompt of up to 32,000 characters.");
            saveSetting("prompt", prompt, applyPrompt);
            break;
        }
        case "/api/provider": {
            const name = field("provider");
            if (!Object.hasOwn(providers, name)) throw new HttpError(400, "Choose an AI provider.");
            const provider = name as ProviderName;
            const model = field("model");
            if (!model || model.length > 256) throw new HttpError(400, "Enter a valid model ID.");
            const apiKey = field("apiKey") || Settings[providers[provider].key];
            if (!apiKey) throw new HttpError(400, "Enter an API key for this provider.");
            const freePlanConfirmed = data.freePlanConfirmed === true;
            if (provider === "groq") {
                if (!groqModels.some(option => option.id === model)) throw new HttpError(400, "Choose a Groq Free-plan model.");
                if (!freePlanConfirmed) throw new HttpError(400, "Confirm that this Groq key belongs to a Free-plan organization.");
            } else if (!isFreeOpenRouterModel(model)) {
                throw new HttpError(400, "Choose a free OpenRouter model.");
            }
            saveProvider({ provider, model, apiKey, freePlanConfirmed });
            break;
        }
        case "/api/whatsapp/connect":
            void sessionManager.startSession(whatsappSessionId);
            return json(res, whatsappStatus(), 202);
        case "/api/provider/test":
            return json(res, await testProvider());
        default:
            throw new HttpError(404, "Page not found.");
    }
    json(res, snapshot());
}

export function startDashboard() {
    const port = Number(process.env.HOLOOL_PORT || 3000);
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const root = resolve(__dirname, "../../public");

    const dashboard = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        try {
            const host = req.headers.host || "";
            const origin = req.headers.origin;
            if (!allowedHosts.includes(host) || (origin && origin !== `http://${host}`) ||
                req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Open the dashboard locally.");
            const url = new URL(req.url || "/", "http://localhost");
            const path = url.pathname;
            if (req.method === "GET" && path === "/api/settings") return json(res, snapshot());
            if (req.method === "GET" && path === "/api/provider/models") return json(res, await modelChoices());
            if (req.method === "GET" && path === "/api/whatsapp") return json(res, whatsappStatus());
            if (req.method === "GET" && path === "/api/whatsapp/qr.png") {
                const status = sessionManager.getStatus(whatsappSessionId);
                if (status.state !== "pairing" || status.qrId !== url.searchParams.get("id")) {
                    throw new HttpError(404, "This QR code has expired.");
                }
                const png = await toBuffer(status.qr, { width: 270, margin: 4 });
                res.setHeader("Content-Type", "image/png");
                return res.end(png);
            }
            if (req.method === "POST" && path.startsWith("/api/")) return await editSettings(req, res, path);
            if (req.method === "GET" && Object.hasOwn(assets, path)) {
                const file = assets[path];
                res.setHeader("Content-Type", types[file.split(".").at(-1)!]);
                return res.end(readFileSync(resolve(root, file)));
            }
            throw new HttpError(404, "Page not found.");
        } catch (error) {
            errorResponse(res, error);
        }
    });
    dashboard.listen(port, process.env.HOLOOL_BIND_HOST || "127.0.0.1", () => console.log(`holool-bot dashboard: http://127.0.0.1:${port}`));
}
