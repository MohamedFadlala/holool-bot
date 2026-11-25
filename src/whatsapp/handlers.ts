import { WASocket, WAMessage, normalizeMessageContent } from "@whiskeysockets/baileys";
import { usageReporter } from "../storage/usage";
import { ChatRepository } from "../storage/repository";
import { getProvider } from "../providers";
import { Logger } from "../utils/logger";
import { Settings } from "../config/settings";
import { systemPrompt, systemPromptRevision } from "../admin/config";
import { ChatMessage } from "../storage/models";
import { isAudioMessage, transcribeAudio } from "../utils/transcription";
import { isImageMessage, downloadImage } from "../utils/image-utils";
import { messageBuffer } from "./message-buffer";
import { handoffInstructions, INVALID_REPLY, parseHandoffReply, phoneFromJid, sendHandoff } from "./handoffs";
import { botActivity } from "./activity";

const chatRepo = new ChatRepository();

/**
 * Track whether a user's pending buffer contains a bank transaction image.
 * This is checked when the buffer flushes to decide what text to store in history.
 */
const bankTransactionFlags = new WeakMap<WASocket, Set<string>>();

async function optionalWhatsAppUpdate(update: () => Promise<unknown>, label: string) {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            update(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Update timed out")), 2000); })
        ]);
    } catch {
        Logger.warn(`Could not send WhatsApp ${label}; continuing with the reply.`);
    } finally {
        clearTimeout(timer);
    }
}

export async function handleIncomingMessage(sock: WASocket, msg: WAMessage, sessionId: string, isActive = () => true) {
    try {
        if (!isActive() || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === "status@broadcast") return;
        if (msg.key.fromMe) return;
        // Every direct sender, including staff, can use and test the bot. The
        // fromMe check above prevents replies to our own handoff summaries.
        if (!remoteJid.endsWith("@s.whatsapp.net") && !remoteJid.endsWith("@lid")) return;
        botActivity.update(sessionId, "received");
        // Disappearing/view-once messages contain the actual content inside a wrapper.
        msg = { ...msg, message: normalizeMessageContent(msg.message) };
        if (!msg.message) return;

        const pushName = msg.pushName || "User";
        const reportUsage = usageReporter(remoteJid, pushName);

        // Detect message type and extract text
        let text = "";
        let isBankTransaction = false;

        // Handle audio messages — transcribe to text first
        if (isAudioMessage(msg)) {
            Logger.info(`[${sessionId}] Received audio message from ${remoteJid}, transcribing...`);

            // Mark as read early since audio processing takes time
            await optionalWhatsAppUpdate(() => sock.readMessages([msg.key]), "read receipt");

            try {
                text = await transcribeAudio(msg, reportUsage);
                Logger.info(`[${sessionId}] Transcription result: "${text}"`);
            } catch (transcribeError: any) {
                if (isActive()) botActivity.update(sessionId, "error", "Voice transcription failed. Check the Groq voice key or send a text message.");
                Logger.error(`[${sessionId}] Transcription failed: ${transcribeError.message}`);
                const fallbackMsg = "عذراً، لم أتمكن من فهم الرسالة الصوتية. ممكن تكتب الرسالة؟";
                if (!isActive()) return;
                await sock.sendMessage(remoteJid, { text: fallbackMsg }, { quoted: msg });
                return;
            }

            // If transcription returned unclear/empty, ask user to type
            if (!text || text === "[unclear]") {
                const unclearMsg = "عذراً، الصوت مش واضح كفاية. ممكن تعيد التسجيل أو تكتب الرسالة؟";
                if (!isActive()) return;
                await sock.sendMessage(remoteJid, { text: unclearMsg }, { quoted: msg });
                return;
            }
        }
        // Handle image messages — analyze via vision model (separate instance from main chat)
        else if (isImageMessage(msg)) {
            Logger.info(`[${sessionId}] Received image message from ${remoteJid}, analyzing...`);

            // Mark as read early since image analysis takes time
            await optionalWhatsAppUpdate(() => sock.readMessages([msg.key]), "read receipt");

            try {
                const { buffer, mimeType } = await downloadImage(msg);
                // Create a SEPARATE provider instance for image description
                // (distinct from the main chat instance used in the buffer callback)
                const visionProvider = getProvider();
                const result = await visionProvider.describeImage(buffer, mimeType, reportUsage);

                text = result.description;
                isBankTransaction = result.isBankTransaction;
                Logger.info(`[${sessionId}] Image analysis result (bank tx: ${isBankTransaction}): "${text.substring(0, 100)}..."`);
            } catch (imageError: any) {
                if (isActive()) botActivity.update(sessionId, "error", "The selected provider could not process an image. Try a text message.");
                Logger.error(`[${sessionId}] Image analysis failed: ${imageError.message}`);
                const fallbackMsg = "عذراً، ما قادر أقرا الصورة دي. ممكن ترسلها تاني أو تكتب الرسالة؟";
                if (!isActive()) return;
                await sock.sendMessage(remoteJid, { text: fallbackMsg }, { quoted: msg });
                return;
            }

            if (!text) {
                botActivity.update(sessionId, "ignored", "The latest incoming message type does not contain supported text, audio, or an image.");
                return;
            }
        }
        // Handle text messages
        else {
            // Extract text from text messages
            text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            
            if (!text) {
                botActivity.update(sessionId, "ignored", "The latest incoming message type does not contain supported text, audio, or an image.");
                return;
            }

            // Mark as read immediately (for text messages — audio/image already marked above)
            await optionalWhatsAppUpdate(() => sock.readMessages([msg.key]), "read receipt");
        }

        if (!isActive()) return;
        Logger.info(`[${sessionId}] Received message from ${remoteJid}: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`);

        // Upsert user record on first contact
        chatRepo.upsertUser(remoteJid, pushName, "");

        // Store bank transaction flag for this user before pushing to buffer
        let flags = bankTransactionFlags.get(sock);
        if (!flags) {
            flags = new Set();
            bankTransactionFlags.set(sock, flags);
        }
        if (isBankTransaction) flags.add(remoteJid);

        // Instead of processing immediately, push to the debounce buffer.
        // The bot will wait for DEBOUNCE_SECONDS after the user's last message to see
        // if more messages come in. No typing indicator is shown during this wait.
        messageBuffer.push(remoteJid, text, msg, sock, async (jid, combinedText, lastMsg, wsock) => {
            try {
                // Determine what text to store in chat history:
                // - If a bank transaction image was detected → store the special token
                // - Otherwise → store the combined text (image descriptions, transcriptions, etc.)
                if (!isActive()) return;
                const hasBankTransaction = flags.delete(jid);

                let historyText: string;
                if (hasBankTransaction) {
                    historyText = "{bank transaction complet}";
                } else {
                    historyText = combinedText;
                }

                // Add the user message to history (text only — no images stored)
                chatRepo.addMessage(jid, "user", historyText);

                botActivity.update(sessionId, "processing");
                await optionalWhatsAppUpdate(() => wsock.sendPresenceUpdate("composing", jid), "typing indicator");
                if (!isActive()) return;

                // Read the active provider and prompt together after the last await before generation.
                const promptRevision = systemPromptRevision;
                const history = chatRepo.getHistory(jid, Settings.MAX_HISTORY_MESSAGES, promptRevision);
                const phone = phoneFromJid(jid) ?? phoneFromJid(lastMsg.key.remoteJidAlt);
                const messagesForProvider: ChatMessage[] = [
                    { role: "system", content: systemPrompt + "\n\n" + handoffInstructions(jid, phone) },
                    ...history
                ];
                let aiResponse = "";
                let providerFailed = false;
                
                try {
                    const raw = await getProvider().chat(messagesForProvider, reportUsage);
                    const response = parseHandoffReply(raw, history);
                    if (!isActive()) return;
                    aiResponse = response.handoff
                        ? await sendHandoff(wsock, jid, lastMsg.key.id ?? "", response.handoff, isActive,
                            !/[\u0600-\u06ff]/.test(combinedText))
                        : response.reply;
                } catch (error: any) {
                    if (!isActive()) return;
                    Logger.error(`[${sessionId}] AI Provider Error: ${error.message}`);
                    providerFailed = true;
                    botActivity.update(sessionId, "error", "The AI provider or its response failed. Use Test active provider in AI provider settings and check the service logs.");
                    aiResponse = INVALID_REPLY;
                }

                if (!isActive()) return;
                await optionalWhatsAppUpdate(() => wsock.sendPresenceUpdate("paused", jid), "typing indicator");
                if (!isActive()) return;
                const sent = await wsock.sendMessage(jid, { text: aiResponse }, { quoted: lastMsg });
                if (!sent?.key?.id) throw new Error("WhatsApp did not confirm the reply submission");
                if (!providerFailed) botActivity.update(sessionId, "replied");
                chatRepo.addMessage(jid, "assistant", aiResponse, promptRevision);

            } catch (error) {
                if (isActive()) botActivity.update(sessionId, "error", "The bot could not complete or send a reply. Check the WhatsApp connection and service logs.");
                Logger.error(`[${sessionId}] Error in buffered response: ${error}`);
            }
        });

    } catch (error) {
        if (isActive()) botActivity.update(sessionId, "error", "An incoming message could not be processed. Check the service logs.");
        Logger.error(`[${sessionId}] Error handling message: ${error}`);
    }
}
