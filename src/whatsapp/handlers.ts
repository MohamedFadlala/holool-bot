import { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { usageReporter } from "../storage/usage";
import { ChatRepository } from "../storage/repository";
import { getProvider } from "../providers";
import { Logger } from "../utils/logger";
import { Settings } from "../config/settings";
import { systemPrompt } from "../admin/config";
import { ChatMessage } from "../storage/models";
import { isAudioMessage, transcribeAudio } from "../utils/transcription";
import { isImageMessage, downloadImage } from "../utils/image-utils";
import { messageBuffer } from "./message-buffer";

const chatRepo = new ChatRepository();

/**
 * Track whether a user's pending buffer contains a bank transaction image.
 * This is checked when the buffer flushes to decide what text to store in history.
 */
const bankTransactionFlags = new WeakMap<WASocket, Set<string>>();

export async function handleIncomingMessage(sock: WASocket, msg: WAMessage, sessionId: string, isActive = () => true) {
    try {
        if (!isActive() || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === "status@broadcast") return;
        
        // Ignore messages sent by the bot itself
        if (msg.key.fromMe) return;

        const pushName = msg.pushName || "User";
        const reportUsage = usageReporter(remoteJid, pushName);

        // Detect message type and extract text
        let text = "";
        let isBankTransaction = false;

        // Handle audio messages — transcribe to text first
        if (isAudioMessage(msg)) {
            Logger.info(`[${sessionId}] Received audio message from ${remoteJid}, transcribing...`);

            // Mark as read early since audio processing takes time
            await sock.readMessages([msg.key]);

            try {
                text = await transcribeAudio(msg, reportUsage);
                Logger.info(`[${sessionId}] Transcription result: "${text}"`);
            } catch (transcribeError: any) {
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
            await sock.readMessages([msg.key]);

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
                Logger.error(`[${sessionId}] Image analysis failed: ${imageError.message}`);
                const fallbackMsg = "عذراً، ما قادر أقرا الصورة دي. ممكن ترسلها تاني أو تكتب الرسالة؟";
                if (!isActive()) return;
                await sock.sendMessage(remoteJid, { text: fallbackMsg }, { quoted: msg });
                return;
            }

            if (!text) return;
        }
        // Handle text messages
        else {
            // Extract text from text messages
            const messageType = Object.keys(msg.message)[0];
            
            if (messageType === "conversation") {
                text = msg.message.conversation || "";
            } else if (messageType === "extendedTextMessage") {
                text = msg.message.extendedTextMessage?.text || "";
            }
            
            if (!text) return;

            // Mark as read immediately (for text messages — audio/image already marked above)
            await sock.readMessages([msg.key]);
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

                // Fetch conversation history
                const history = chatRepo.getHistory(jid, Settings.MAX_HISTORY_MESSAGES);

                // Prepare provider messages with system prompt prepended
                const messagesForProvider: ChatMessage[] = [
                    { role: "system", content: systemPrompt },
                    ...history.map(h => ({
                        role: h.role as ChatMessage["role"],
                        content: h.content
                    }))
                ];

                // Show typing indicator now — debounce is done, user is about to get a reply
                await wsock.sendPresenceUpdate('composing', jid);

                if (!isActive()) return;
                const provider = getProvider();
                let aiResponse = "";
                
                try {
                    aiResponse = await provider.chat(messagesForProvider, reportUsage);
                } catch (error: any) {
                    Logger.error(`[${sessionId}] AI Provider Error: ${error.message}`);
                    aiResponse = "Sorry, I am having trouble processing your request right now. Please try again later.";
                }

                if (!isActive()) return;
                // Add assistant message to history
                chatRepo.addMessage(jid, "assistant", aiResponse);

                // Send reply
                await wsock.sendPresenceUpdate('paused', jid);
                if (!isActive()) return;
                await wsock.sendMessage(jid, { text: aiResponse }, { quoted: lastMsg });

            } catch (error) {
                Logger.error(`[${sessionId}] Error in buffered response: ${error}`);
            }
        });

    } catch (error) {
        Logger.error(`[${sessionId}] Error handling message: ${error}`);
    }
}