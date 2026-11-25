import { randomUUID } from "node:crypto";
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, WASocket } from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import * as qrcode from "qrcode-terminal";
import pino from "pino";
import { Logger } from "../utils/logger";
import { clearAuthState, hasLinkedDevice, useSqliteAuthState } from "./auth-store";
import { messageBuffer } from "./message-buffer";
import { handleIncomingMessage } from "./handlers";
import { botActivity } from "./activity";
import { phoneFromJid } from "./handoffs";

type ConnectionStatus =
    | { state: "disconnected"; message?: string }
    | { state: "connecting" | "connected" | "disconnecting" }
    | { state: "pairing"; qr: string; qrId: string }
    | { state: "error"; message: string };

export class SessionManager {
    private sessions = new Map<string, WASocket>();
    private statuses = new Map<string, ConnectionStatus>();
    private connections = new Map<string, AbortController>();
    private retryTimers = new Map<string, NodeJS.Timeout>();
    private retries = new Map<string, number>();
    private logger = pino({ level: "silent" });

    getStatus(sessionId: string): ConnectionStatus {
        const status = this.statuses.get(sessionId) ?? { state: "disconnected" as const };
        if (status.state === "connected" && !this.sessions.get(sessionId)?.ws.isOpen) {
            return { state: "error", message: "The WhatsApp socket is closed. Select Try again to reconnect the saved session." };
        }
        return status;
    }

    getLinkedPhone(sessionId: string) {
        return phoneFromJid(this.sessions.get(sessionId)?.user?.id);
    }

    async disconnectSession(sessionId: string) {
        if (this.getStatus(sessionId).state === "disconnecting") return;
        this.statuses.set(sessionId, { state: "disconnecting" });
        this.connections.get(sessionId)?.abort();
        this.connections.delete(sessionId);
        clearTimeout(this.retryTimers.get(sessionId));
        this.retryTimers.delete(sessionId);
        this.retries.delete(sessionId);

        const socket = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        if (socket) messageBuffer.cancel(socket);

        let remoteLogoutFailed = false;
        try {
            remoteLogoutFailed = hasLinkedDevice(sessionId) || Boolean(socket?.user);
            clearAuthState(sessionId);
            if (socket?.user) {
                try {
                    await socket.logout();
                    remoteLogoutFailed = false;
                } catch {
                    Logger.warn(`[${sessionId}] Could not send the logout request to WhatsApp.`);
                }
            }
            this.statuses.set(sessionId, remoteLogoutFailed
                ? { state: "disconnected", message: "Session removed from this bot. To remove the device from WhatsApp, open Linked devices on your phone." }
                : { state: "disconnected" });
            Logger.info(`[${sessionId}] WhatsApp session forgotten.`);
        } catch {
            this.statuses.set(sessionId, {
                state: "error",
                message: "Could not remove the saved session. Check that the database is writable and try again."
            });
        } finally {
            socket?.end(undefined);
        }
    }

    async startSession(sessionId: string, terminalQR = false, retry = false) {
        if (this.connections.has(sessionId)) {
            const socket = this.sessions.get(sessionId);
            if (this.statuses.get(sessionId)?.state !== "connected" || socket?.ws.isOpen) return;
            // Recover a dead socket even if its close event never reached us.
            this.sessions.delete(sessionId);
            this.connections.get(sessionId)?.abort();
            this.connections.delete(sessionId);
            socket?.end(new Error("Replacing a closed WhatsApp socket"));
        }
        const status = this.getStatus(sessionId).state;
        if (status === "disconnecting" || (!retry && status === "connecting")) return;
        if (!retry) this.retries.delete(sessionId);

        const controller = new AbortController();
        const signal = controller.signal;
        this.connections.set(sessionId, controller);
        botActivity.reset(sessionId);
        this.statuses.set(sessionId, { state: "connecting" });
        try {
            const { state, saveCreds, getWriteErrorCount } = await useSqliteAuthState(sessionId, signal);
            if (signal.aborted) return;
            const webVersion = await fetchLatestWaWebVersion({ signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
            if (signal.aborted) return;
            const { version } = webVersion.isLatest
                ? webVersion
                : await fetchLatestBaileysVersion({ signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
            if (signal.aborted) return;
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
                this.connections.delete(sessionId);
                controller.abort();
                messageBuffer.cancel(socket);
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
                this.retryTimers.set(sessionId, setTimeout(() => {
                    this.retryTimers.delete(sessionId);
                    void this.startSession(sessionId, terminalQR, true);
                }, delay));
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
                if (this.sessions.get(sessionId) !== socket || signal.aborted) return;
                botActivity.observeEvent(sessionId, type);
                Logger.info(`[${sessionId}] WhatsApp message event: ${type}, ${messages.length} message(s).`);
                if (type !== "notify") return;
                for (const message of messages) {
                    if (signal.aborted) break;
                    await handleIncomingMessage(socket, message, sessionId, () => !signal.aborted);
                }
            });
        } catch (error) {
            if (signal.aborted) return;
            this.connections.delete(sessionId);
            controller.abort();
            Logger.error(`[${sessionId}] Could not start WhatsApp: ${error instanceof Error ? error.message : "Unknown error"}`);
            this.statuses.set(sessionId, { state: "error", message: "Could not start WhatsApp. Check the bot logs and try again." });
        }
    }
}

export const sessionManager = new SessionManager();
