import { getConnection } from "./database";
import { Logger } from "../utils/logger";

export interface ModelUsage {
    provider: string;
    model: string;
    kind?: "chat" | "audio" | "image";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    audioSeconds?: number;
    costUsd?: number;
    costBasis?: "reported" | "free" | "estimate";
}

export type UsageReporter = (event: ModelUsage) => void;

function measured(value: number | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function usageReporter(chatId: string | null, name = ""): UsageReporter {
    return event => {
        try {
            const db = getConnection();
            if (chatId) {
                db.prepare("INSERT OR IGNORE INTO users (user_id, first_name) VALUES (?, ?)").run(chatId, name);
            }
            const input = measured(event.inputTokens);
            const output = measured(event.outputTokens);
            const total = measured(event.totalTokens) ?? (input !== null && output !== null ? input + output : null);
            const cost = measured(event.costUsd);
            db.prepare(`
                INSERT INTO model_usage
                  (chat_id, provider, model, kind, input_tokens, output_tokens, total_tokens, audio_seconds, cost_usd, cost_basis)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(chatId, event.provider, event.model, event.kind ?? "chat", input, output, total,
                measured(event.audioSeconds), cost, cost !== null ? event.costBasis ?? "estimate" : "unknown");
        } catch {
            Logger.error("Could not record model usage.");
        }
    };
}

const totals = `
    COUNT(u.id) AS requests,
    SUM(u.input_tokens) AS inputTokens,
    SUM(u.output_tokens) AS outputTokens,
    SUM(u.total_tokens) AS tokens,
    SUM(u.audio_seconds) AS audioSeconds,
    SUM(u.cost_usd) AS costUsd,
    COUNT(CASE WHEN u.cost_usd IS NULL THEN u.id END) AS unknownCost,
    COUNT(CASE WHEN u.cost_basis = 'estimate' THEN u.id END) AS estimated,
    COUNT(CASE WHEN u.kind <> 'audio' AND u.total_tokens IS NULL THEN u.id END) AS unknownTokens
`;

export function usageSummary(since: string, chatId: string | null = null) {
    const db = getConnection();
    const filter = chatId === null ? "u.created_at >= ?" : "u.created_at >= ? AND u.chat_id = ?";
    const args = chatId === null ? [since] : [since, chatId];
    return {
        totals: db.prepare(`SELECT ${totals} FROM model_usage u WHERE ${filter}`).get(...args),
        models: db.prepare(`
            SELECT u.provider, u.model, u.kind, ${totals}
            FROM model_usage u WHERE ${filter}
            GROUP BY u.provider, u.model, u.kind
            ORDER BY costUsd DESC, tokens DESC, requests DESC, u.model
        `).all(...args),
        ...(chatId === null ? {
            daily: db.prepare(`
                SELECT date(u.created_at) AS day, ${totals}
                FROM model_usage u WHERE ${filter}
                GROUP BY day ORDER BY day DESC LIMIT 31
            `).all(...args).reverse(),
            otherRequests: (db.prepare(`
                SELECT COUNT(*) AS total FROM model_usage WHERE chat_id IS NULL AND created_at >= ?
            `).get(since) as { total: number }).total
        } : {})
    };
}

export function listChats(since: string, search: string, offset: number, sort: string) {
    const db = getConnection();
    const match = "%" + search.replace(/[!_%]/g, value => "!" + value) + "%";
    const order = sort === "cost" ? "costUsd DESC, " : sort === "tokens" ? "tokens DESC, " : "";
    const rows = db.prepare(`
        SELECT c.user_id AS id, c.first_name AS name, c.last_seen AS lastSeen, ${totals}
        FROM users c
        LEFT JOIN model_usage u ON u.chat_id = c.user_id AND u.created_at >= ?
        WHERE c.user_id LIKE ? ESCAPE '!' OR c.first_name LIKE ? ESCAPE '!'
        GROUP BY c.user_id
        ORDER BY ${order}c.last_seen DESC, c.user_id
        LIMIT 26 OFFSET ?
    `).all(since, match, match, offset);
    return { chats: rows.slice(0, 25), hasMore: rows.length > 25 };
}

export function chatDetail(chatId: string, since: string, before: number) {
    const db = getConnection();
    const chat = db.prepare("SELECT user_id AS id, first_name AS name FROM users WHERE user_id = ?").get(chatId);
    if (!chat) return;
    const rows = db.prepare(`
        SELECT id, role, content, created_at AS createdAt
        FROM chat_history WHERE user_id = ? AND id < ?
        ORDER BY id DESC LIMIT 51
    `).all(chatId, before) as { id: number }[];
    const messages = rows.slice(0, 50).reverse();
    return {
        chat, messages, before: rows.length > 50 ? messages[0].id : null,
        usage: usageSummary(since, chatId)
    };
}
