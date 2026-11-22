import { randomUUID } from "node:crypto";
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, WASocket } from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import * as qrcode from "qrcode-terminal";
import pino from "pino";
import { Logger } from "../utils/logger";
import { clearAuthState, useSqliteAuthState } from "./auth-store";
import { handleIncomingMessage } from "./handlers";

type ConnectionStatus =
    | { state: "disconnected" | "connecting" | "connected" }
    | { state: "pairing"; qr: string; qrId: string }
    | { state: "error"; message: string };

class SessionManager {
    private sessions = new Map<string, WASocket>();
    private statuses = new Map<string, ConnectionStatus>();
    private starting = new Set<string>();
    private retries = new Map<string, number>();
    private logger = pino({ level: "silent" });

    getStatus(sessionId: string): ConnectionStatus {
        return this.statuses.get(sessionId) ?? { state: "disconnected" };
    }

    async startSession(sessionId: string, terminalQR = false, retry = false) {
        if (this.sessions.has(sessionId) || this.starting.has(sessionId)) return;
        if (!retry && this.getStatus(sessionId).state === "connecting") return;
        if (!retry) this.retries.delete(sessionId);

        this.starting.add(sessionId);
        this.statuses.set(sessionId, { state: "connecting" });
        try {
            const { state, saveCreds, getWriteErrorCount } = await useSqliteAuthState(sessionId);
            const webVersion = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10000) });
            const { version } = webVersion.isLatest
                ? webVersion
                : await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(10000) });
            const socket = makeWASocket({
                version,
                auth: state,
                logger: this.logger,
                browser: Browsers.ubuntu("Chrome"),
                generateHighQualityLinkPreview: true
            });
            this.sessions.set(sessionId, socket);

            socket.ev.on("connection.update", ({ connection, isNewLogin, lastDisconnect, qr }) => {
                if (this.sessions.get(sessionId) !== socket) return;
                if (qr) {
                    this.statuses.set(sessionId, { state: "pairing", qr, qrId: randomUUID() });
                    if (terminalQR) qrcode.generate(qr, { small: true });
                }
                if (isNewLogin) this.statuses.set(sessionId, { state: "connecting" });
                if (connection === "open") {
                    this.statuses.set(sessionId, { state: "connected" });
                    this.retries.delete(sessionId);
                    Logger.info(`[${sessionId}] WhatsApp linked device connected.`);
                }
                if (connection !== "close") return;

                this.sessions.delete(sessionId);
                const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
                Logger.info(`[${sessionId}] WhatsApp connection closed (code ${reason ?? "unknown"}).`);
                if (reason === DisconnectReason.loggedOut) {
                    try {
                        clearAuthState(sessionId);
                        this.statuses.set(sessionId, { state: "disconnected" });
                    } catch {
                        this.statuses.set(sessionId, { state: "error", message: "Could not clear the expired session. Check that the database is writable." });
                    }
                    return;
                }
                if (getWriteErrorCount() >= 3) {
                    this.statuses.set(sessionId, { state: "error", message: "Could not save the WhatsApp session. Check that the database is writable." });
                    return;
                }
                const attempts = (this.retries.get(sessionId) ?? 0) + 1;
                if (attempts > 5) {
                    this.statuses.set(sessionId, { state: "error", message: "WhatsApp closed the connection. Try connecting again." });
                    return;
                }

                this.retries.set(sessionId, attempts);
                this.statuses.set(sessionId, { state: "connecting" });
                const delay = reason === DisconnectReason.restartRequired ? 0 : 5000;
                setTimeout(() => void this.startSession(sessionId, terminalQR, true), delay);
            });

            socket.ev.on("creds.update", () => {
                if (this.sessions.get(sessionId) !== socket) return;
                try {
                    saveCreds();
                } catch {
                    Logger.error(`[${sessionId}] Could not save WhatsApp credentials.`);
                }
            });

            socket.ev.on("messages.upsert", async ({ type, messages }) => {
                if (type !== "notify" || this.sessions.get(sessionId) !== socket) return;
                for (const message of messages) {
                    await handleIncomingMessage(socket, message, sessionId);
                }
            });
        } catch (error) {
            Logger.error(`[${sessionId}] Could not start WhatsApp: ${error instanceof Error ? error.message : "Unknown error"}`);
            this.statuses.set(sessionId, { state: "error", message: "Could not start WhatsApp. Check the bot logs and try again." });
        } finally {
            this.starting.delete(sessionId);
        }
    }
}

export const sessionManager = new SessionManager();
