import { setTimeout as delay } from "node:timers/promises";
import { getConnection } from "../storage/database";

// Codex device-code contract used by OpenClaw's openai-chatgpt-device-code flow.
const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const tokenEndpoint = issuer + "/oauth/token";
const expiryMs = 15 * 60 * 1000;
const storageKey = "openaiCodexSession";

interface Profile {
    access: string;
    refresh: string;
    expires: number;
    accountId: string;
}

interface LoginAttempt {
    controller: AbortController;
    expiresAt: number;
    userCode?: string;
}

let login: LoginAttempt | undefined;
let loginError: string | undefined;
let refreshOperation: { profile: Profile; result: Promise<Profile> } | undefined;

function profile() {
    const row = getConnection().prepare("SELECT value FROM holool_settings WHERE name = ?")
        .get(storageKey) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Profile : undefined;
}

function saveProfile(next: Profile) {
    getConnection().prepare(`
        INSERT INTO holool_settings (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `).run(storageKey, JSON.stringify(next));
}

function stringField(value: unknown) {
    return typeof value === "string" && value.trim() ? value : undefined;
}

async function oauth(url: string, body: URLSearchParams | Record<string, string>, signal?: AbortSignal) {
    const form = body instanceof URLSearchParams;
    const timeout = AbortSignal.timeout(15000);
    return fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
            "User-Agent": "holool-bot",
            originator: "holool-bot"
        },
        body: form ? body : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error"
    });
}

async function exchange(fields: Record<string, string>, signal?: AbortSignal, previous?: Profile): Promise<Profile> {
    const result = await oauth(tokenEndpoint, new URLSearchParams({ ...fields, client_id: clientId }), signal);
    if (!result.ok) {
        await result.body?.cancel();
        const revoked = result.status === 400 || result.status === 401 || result.status === 403;
        throw Object.assign(new Error(revoked ? "ChatGPT authorization expired or was refused. Sign in again."
            : "ChatGPT could not complete sign-in. Try again later."), { status: revoked ? 401 : result.status });
    }
    const response = await result.json();
    const access = stringField(response.access_token);
    const refresh = stringField(response.refresh_token) ?? previous?.refresh;
    if (!access || !refresh) throw new Error("ChatGPT returned incomplete sign-in credentials.");
    const payload = JSON.parse(Buffer.from(access.split(".")[1] || "", "base64url").toString("utf8"));
    const accountId = stringField(payload["https://api.openai.com/auth"]?.chatgpt_account_id);
    const jwtExpiry = Number(payload.exp) * 1000;
    const seconds = Number(response.expires_in);
    const expires = Math.min(jwtExpiry || Infinity, seconds > 0 ? Date.now() + seconds * 1000 : Infinity);
    if (!accountId || !Number.isFinite(expires) || expires <= Date.now() ||
        (previous && previous.accountId !== accountId)) {
        throw new Error("ChatGPT returned an invalid account session. Sign in again.");
    }
    return { access, refresh, expires, accountId };
}

export function codexStatus() {
    if (login) return { state: login.userCode ? "pending" : "starting",
        ...(login.userCode ? { userCode: login.userCode, verificationUrl: issuer + "/codex/device", expiresAt: login.expiresAt } : {}) };
    if (profile()) return { state: "connected" };
    return loginError ? { state: "error", message: loginError } : { state: "disconnected" };
}

export function hasCodexProfile() {
    return Boolean(profile());
}

export function isCurrentCodexAccess(access: string) {
    return profile()?.access === access;
}

export function disconnectCodex() {
    login?.controller.abort();
    login = undefined;
    loginError = undefined;
    getConnection().prepare("DELETE FROM holool_settings WHERE name = ?").run(storageKey);
}

export async function startCodexLogin() {
    if (login || profile()) return codexStatus();
    const attempt: LoginAttempt = { controller: new AbortController(), expiresAt: Date.now() + expiryMs };
    const signal = attempt.controller.signal;
    login = attempt;
    loginError = undefined;
    try {
        const result = await oauth(issuer + "/api/accounts/deviceauth/usercode", { client_id: clientId }, signal);
        if (!result.ok) {
            await result.body?.cancel();
            throw new Error(result.status === 404
                ? "ChatGPT device-code sign-in is unavailable. Check your Codex device-code settings."
                : "Could not request a ChatGPT sign-in code. Try again.");
        }
        const body = await result.json();
        const id = stringField(body.device_auth_id);
        const userCode = stringField(body.user_code) ?? stringField(body.usercode);
        if (!id || !userCode) throw new Error("ChatGPT did not return a sign-in code.");
        if (login !== attempt) return codexStatus();

        attempt.userCode = userCode;
        attempt.expiresAt = Date.now() + expiryMs;
        const interval = Math.max(1000, Number(body.interval) * 1000 || 5000);
        void pollCodexLogin(attempt, id, userCode, interval);
    } catch (error) {
        if (login === attempt) {
            login = undefined;
            loginError = error instanceof Error && /^(ChatGPT|Could not)/.test(error.message)
                ? error.message : "Could not reach ChatGPT to start sign-in. Try again.";
        }
    }
    return codexStatus();
}

async function pollCodexLogin(attempt: LoginAttempt, id: string, userCode: string, interval: number) {
    const signal = attempt.controller.signal;
    try {
        while (Date.now() < attempt.expiresAt) {
            await delay(Math.min(interval, attempt.expiresAt - Date.now()), undefined, { signal });
            if (Date.now() >= attempt.expiresAt) break;
            const result = await oauth(issuer + "/api/accounts/deviceauth/token", {
                device_auth_id: id, user_code: userCode
            }, signal);
            if (result.status === 403 || result.status === 404) {
                await result.body?.cancel();
                continue;
            }
            if (!result.ok) {
                await result.body?.cancel();
                throw new Error("ChatGPT did not approve the device sign-in.");
            }
            const body = await result.json();
            const code = stringField(body.authorization_code);
            const verifier = stringField(body.code_verifier);
            if (!code || !verifier) throw new Error("ChatGPT returned an incomplete device authorization.");
            const next = await exchange({
                grant_type: "authorization_code", code, code_verifier: verifier,
                redirect_uri: issuer + "/deviceauth/callback"
            }, signal);
            if (login === attempt) saveProfile(next);
            return;
        }
        throw new Error("ChatGPT sign-in code expired. Start again for a new code.");
    } catch (error) {
        if (login === attempt) loginError = error instanceof Error && error.message.startsWith("ChatGPT")
            ? error.message : "ChatGPT sign-in did not finish. Try again.";
    } finally {
        if (login === attempt) login = undefined;
    }
}

export async function codexCredentials(rejectedAccess?: string): Promise<Profile> {
    const current = profile();
    if (!current) throw Object.assign(new Error("Connect ChatGPT in the dashboard first."), { status: 401 });
    if (current.expires > Date.now() + 60000 && (!rejectedAccess || rejectedAccess !== current.access)) return current;
    if (refreshOperation?.profile.access === current.access && refreshOperation.profile.refresh === current.refresh) {
        return refreshOperation.result;
    }

    const result = (async () => {
        try {
            const next = await exchange({ grant_type: "refresh_token", refresh_token: current.refresh }, undefined, current);
            const saved = profile();
            if (saved?.access !== current.access || saved?.refresh !== current.refresh) {
                throw Object.assign(new Error("ChatGPT connection changed. Retry the request."), { status: 401 });
            }
            saveProfile(next);
            return next;
        } catch (error) {
            const saved = profile();
            if ((error as { status?: number }).status === 401 &&
                saved?.access === current.access && saved?.refresh === current.refresh) {
                disconnectCodex();
                loginError = "ChatGPT authorization expired or was revoked. Connect again.";
            }
            throw error;
        }
    })();
    refreshOperation = { profile: current, result };
    try {
        return await result;
    } finally {
        if (refreshOperation?.result === result) refreshOperation = undefined;
    }
}
