import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { downloadContentFromMessage, WAMessage } from "@whiskeysockets/baileys";
import Groq from "groq-sdk";
import type { UsageReporter } from "../storage/usage";
import { Settings } from "../config/settings";
import { Logger } from "./logger";

const MIME_TO_EXT: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mp4": "m4a",
    "audio/aac": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm"
};

export function isAudioMessage(msg: WAMessage): boolean {
    return Boolean(msg.message?.audioMessage);
}

export async function transcribeAudio(msg: WAMessage, reportUsage?: UsageReporter): Promise<string> {
    const audio = msg.message?.audioMessage;
    if (!audio) throw new Error("The WhatsApp message has no audio.");
    const apiKey = Settings.groqVoiceKey;
    const freePlan = Settings.GROQ_FREE_PLAN_CONFIRMED && apiKey === Settings.GROQ_CHAT_API_KEY;
    const model = Settings.GROQ_MODEL;
    if (!apiKey) throw new Error("Configure a Groq API key for voice transcription.");

    const mime = audio.mimetype?.split(";", 1)[0].trim().toLowerCase();
    const extension = (mime && MIME_TO_EXT[mime]) || "ogg";
    const directory = await mkdtemp(join(tmpdir(), "holool-voice-"));
    const audioPath = join(directory, `voice.${extension}`);
    try {
        const stream = await downloadContentFromMessage(audio, "audio");
        await pipeline(stream, createWriteStream(audioPath, { mode: 0o600 }));

        const groq = new Groq({ apiKey, timeout: 45000, maxRetries: 1 });
        const transcript = await groq.audio.transcriptions.create({
            file: createReadStream(audioPath),
            model,
            temperature: 0,
            response_format: "verbose_json"
        });
        const duration = (transcript as { duration?: number }).duration ?? audio.seconds ?? undefined;
        const hourlyRate = model === "whisper-large-v3-turbo" ? 0.04 : model === "whisper-large-v3" ? 0.111 : undefined;
        const costUsd = freePlan ? 0
            : hourlyRate != null && duration != null ? Math.max(10, duration) * hourlyRate / 3600 : undefined;
        reportUsage?.({
            provider: "groq", model, kind: "audio", audioSeconds: duration, costUsd,
            costBasis: freePlan ? "free" : "estimate"
        });
        return transcript.text.trim();
    } finally {
        try {
            await unlink(audioPath).catch(error => {
                if (error.code !== "ENOENT") throw error;
            });
            await rmdir(directory);
        } catch {
            Logger.warn("Could not clean up a temporary WhatsApp audio file.");
        }
    }
}
