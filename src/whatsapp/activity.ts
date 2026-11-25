export interface BotActivity {
    state: "unverified" | "received" | "processing" | "replied" | "error" | "ignored";
    lastReceivedAt?: string;
    lastReplyAt?: string;
    lastEventAt?: string;
    lastEventType?: string;
    message?: string;
}

class ActivityTracker {
    private sessions = new Map<string, BotActivity>();

    reset(sessionId: string) { this.sessions.delete(sessionId); }

    get(sessionId: string): BotActivity {
        return { ...(this.sessions.get(sessionId) ?? { state: "unverified" }) };
    }

    observeEvent(sessionId: string, type: string) {
        const activity = this.get(sessionId);
        activity.lastEventAt = new Date().toISOString();
        activity.lastEventType = type;
        this.sessions.set(sessionId, activity);
    }

    update(sessionId: string, state: BotActivity["state"], message?: string) {
        const activity = this.get(sessionId);
        activity.state = state;
        activity.message = message;
        if (state === "received") activity.lastReceivedAt = new Date().toISOString();
        if (state === "replied") activity.lastReplyAt = new Date().toISOString();
        this.sessions.set(sessionId, activity);
    }
}

export const botActivity = new ActivityTracker();
