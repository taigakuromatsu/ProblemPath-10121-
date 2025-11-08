import { type MessagingOptions, type MulticastMessage } from "firebase-admin/messaging";
export declare const region = "asia-northeast1";
export type ReminderWindow = "1d" | "7d";
export type DueReminderMode = "none" | "1d" | "7d" | "1d7d";
export interface NotifyPrefs {
    instantComment: boolean;
    instantFile: boolean;
    dueReminderMode: DueReminderMode;
    dueReminderHour: number;
}
export declare const DEFAULT_NOTIFY_PREFS: NotifyPrefs;
export declare function getNotifyPrefsForUsers(uids: string[]): Promise<Map<string, NotifyPrefs>>;
export interface SendSummary {
    successCount: number;
    failureCount: number;
    attemptedTokens: number;
}
export declare function listProjectMemberUids(projectId: string): Promise<string[]>;
export declare function listFcmTokensForUsers(uids: string[]): Promise<string[]>;
export declare function sendToTokens(tokens: string[], message: Omit<MulticastMessage, "tokens">, options?: MessagingOptions): Promise<SendSummary>;
export declare function wasReminderSent(projectId: string, taskId: string, ymd: string, window: ReminderWindow, uid: string): Promise<boolean>;
export declare function markReminderSent(projectId: string, taskId: string, ymd: string, window: ReminderWindow, uid: string): Promise<void>;
