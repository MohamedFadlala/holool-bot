import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { toBuffer } from "qrcode";
import { sessionManager } from "../whatsapp/session-manager";
import { Settings } from "../config/settings";
import { getProvider } from "../providers";
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
        providers: Object.fromEntries(Object.entries(providers).map(([name, fields]) => [
            name, { model: Settings[fields.model], hasKey: Boolean(Settings[fields.key]) }
        ]))
    };
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
            if (!apiKey && provider !== "ollama") throw new HttpError(400, "Enter an API key for this provider.");
            saveProvider({ provider, model, apiKey });
            break;
        }
        case "/api/whatsapp/connect":
            void sessionManager.startSession(whatsappSessionId);
            return json(res, whatsappStatus(), 202);
        case "/api/provider/test":
            if (!await getProvider().healthCheck()) throw new HttpError(502, "Provider check failed. Check the saved credentials and model.");
            return json(res, { message: "The active AI provider responded successfully." });
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
