// functions/src/index.ts
import { getApps, initializeApp } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import type { MulticastMessage, MessagingOptions } from "firebase-admin/messaging";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import {
  onDocumentCreated,
  type FirestoreEvent,
} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  // listFcmTokensForUsers, // ← ②方式では未使用
  listProjectMemberUids,
  markReminderSent,
  region,
  sendToTokens,
  wasReminderSent,
} from "./notify";
export { issueSuggestHttp } from "./issue-suggest";
export { refreshAnalyticsSummaryV2 } from "./analytics";
export { generateProgressReportDraft } from "./ai";
export { generateRecurringTasks } from "./recurrence";
import { addDays, formatYmd, getJstToday } from "./time";

if (!getApps().length) {
  initializeApp();
}

setGlobalOptions({ region });

export const ping = onRequest(async (_req, res) => {
  res.status(200).send("ok");
});

const firestore = getFirestore();

type CommentParams = {
  projectId: string;
  problemId: string;
  issueId?: string;
  taskId?: string;
  commentId: string;
};

type AttachmentParams = {
  projectId: string;
  problemId: string;
  issueId?: string;
  taskId?: string;
  attachmentId: string;
};

const openTaskStatuses = ["not_started", "in_progress"] as const;
type ReminderWindow = "1d" | "7d";
type Lang = "ja" | "en";

function determineScope(params: { issueId?: string; taskId?: string }): "problem" | "issue" | "task" {
  if (params.taskId) return "task";
  if (params.issueId) return "issue";
  return "problem";
}

/** Web Push で通知クリック時のリンク */
function buildDeepLink(
  projectId: string,
  _problemId?: string,
  _issueId?: string,
  _taskId?: string
): string {
  const base = `https://kensyu10121.web.app/project/${projectId}`;
  return base;
}

function withWebPushLink(
  payload: Omit<MulticastMessage, "tokens">,
  link: string
): Omit<MulticastMessage, "tokens"> & { webpush: NonNullable<MessagingOptions["webpush"]> } {
  return {
    ...payload,
    webpush: {
      ...(payload as any).webpush,
      fcmOptions: {
        ...((payload as any).webpush?.fcmOptions ?? {}),
        link,
      },
    },
  };
}

function uniqueTokens(input: string[]): string[] {
  const set = new Set<string>();
  for (const t of input) {
    const s = (t ?? "").trim();
    if (s) set.add(s);
  }
  return Array.from(set);
}

function normalizeLang(input?: string): Lang | undefined {
  if (!input) return undefined;
  const v = String(input).toLowerCase().replace("_", "-");
  if (v.startsWith("en")) return "en";
  if (v.startsWith("ja")) return "ja";
  return undefined;
}

/**
 * ②方式の要：ユーザー配下の fcmTokens サブコレクションから、
 * language が指定 lang のトークンだけを集める。
 * 保存スキーマ例: users/{uid}/fcmTokens/{docId} { token, language, platform, userAgent, ... }
 */
async function listTokensForUsersByLang(uids: string[], lang: Lang): Promise<string[]> {
  const db = getFirestore();
  const out: string[] = [];

  for (const uid of uids) {
    const snap = await db.collection(`users/${uid}/fcmTokens`).get();
    for (const d of snap.docs) {
      const data = d.data() as any;
      const token = String(data?.token ?? d.id ?? "");
      const l = normalizeLang(data?.language);
      if (token && l === lang) out.push(token);
    }
  }

  return uniqueTokens(out);
}

/** 言語別メッセージ文面 */
function commentNotificationByLang(lang: Lang, scope: "problem" | "issue" | "task") {
  const title = lang === "ja" ? "新しいコメント" : "New comment";
  const body =
    scope === "task"
      ? (lang === "ja" ? "タスクにコメントが追加されました" : "A comment was added to a task")
      : scope === "issue"
      ? (lang === "ja" ? "Issueにコメントが追加されました" : "A comment was added to an issue")
      : (lang === "ja" ? "Problemにコメントが追加されました" : "A comment was added to a problem");
  return { title, body };
}

function attachmentNotificationByLang(lang: Lang, scope: "problem" | "issue" | "task") {
  const title = lang === "ja" ? "ファイルが追加されました" : "File added";
  const body =
    scope === "task"
      ? (lang === "ja" ? "タスクにファイルが追加されました" : "A file was added to a task")
      : scope === "issue"
      ? (lang === "ja" ? "Issueにファイルが追加されました" : "A file was added to an issue")
      : (lang === "ja" ? "Problemにファイルが追加されました" : "A file was added to a problem");
  return { title, body };
}

function reminderNotificationByLang(lang: Lang, window: ReminderWindow) {
  const title = lang === "ja" ? "期限リマインド" : "Due reminder";
  const body =
    window === "1d"
      ? (lang === "ja" ? "タスク期限が明日に迫っています" : "Task is due tomorrow")
      : (lang === "ja" ? "タスク期限まで1週間です" : "Task is due in one week");
  return { title, body };
}

/** コメント作成時通知（自己通知抑止 + 言語別トークン送信） */
async function handleCommentCreated(
  event: FirestoreEvent<any, CommentParams>
) {
  const { projectId, problemId, issueId, taskId, commentId } = event.params;
  const scope = determineScope(event.params);

  // 自己通知抑止
  const authorId: string | undefined = event.data?.data()?.authorId;

  const allMemberUids = await listProjectMemberUids(projectId);
  const targetUids = authorId ? allMemberUids.filter(uid => uid !== authorId) : allMemberUids;

  const dataBase: Record<string, string> = {
    type: "comment_created",
    projectId,
    scope,
    problemId,
    commentId,
  };
  if (issueId) dataBase.issueId = issueId;
  if (taskId)  dataBase.taskId  = taskId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  const sums = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();

  for (const lang of ["ja", "en"] as const) {
    const tokensRaw = await listTokensForUsersByLang(targetUids, lang);
    const tokens = tokensRaw.filter(t => !sent.has(t));
    if (!tokens.length) continue;

    const notification = commentNotificationByLang(lang, scope);
    const data = { ...dataBase, lang };
    const payload = withWebPushLink({ notification, data }, link);
    const result = await sendToTokens(tokens, payload);

    sums.successCount += Number((result as any)?.successCount ?? 0);
    sums.failureCount += Number((result as any)?.failureCount ?? 0);
    sums.attemptedTokens += tokens.length;

    tokens.forEach(t => sent.add(t));
  }

  console.log(
    "[notify] Comment created (by token language)",
    JSON.stringify({
      projectId, problemId, issueId, taskId, commentId, authorId,
      targetUids: targetUids.length,
      sent: sums
    })
  );

  const auditRef = firestore
    .collection(`projects/${projectId}/auditLogs`)
    .doc("events")
    .collection("notifications")
    .doc();

  await auditRef.set({
    type: "comment_created",
    scope,
    projectId,
    problemId,
    issueId: issueId ?? null,
    taskId: taskId ?? null,
    commentId,
    authorId: authorId ?? null,
    sentAt: FieldValue.serverTimestamp(),
    result: sums,
  });

  return sums;
}

/** 添付作成時通知（自己通知抑止 + 言語別トークン送信） */
async function handleAttachmentCreated(
  event: FirestoreEvent<any, AttachmentParams>
) {
  const { projectId, problemId, issueId, taskId, attachmentId } = event.params;
  const scope = determineScope(event.params);

  const createdBy: string | undefined = event.data?.data()?.createdBy;

  const allMemberUids = await listProjectMemberUids(projectId);
  const targetUids = createdBy ? allMemberUids.filter(uid => uid !== createdBy) : allMemberUids;

  const dataBase: Record<string, string> = {
    type: "attachment_created",
    projectId,
    scope,
    problemId,
    attachmentId,
  };
  if (issueId) dataBase.issueId = issueId;
  if (taskId)  dataBase.taskId  = taskId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  const sums = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();

  for (const lang of ["ja", "en"] as const) {
    const tokensRaw = await listTokensForUsersByLang(targetUids, lang);
    const tokens = tokensRaw.filter(t => !sent.has(t));
    if (!tokens.length) continue;

    const notification = attachmentNotificationByLang(lang, scope);
    const data = { ...dataBase, lang };
    const payload = withWebPushLink({ notification, data }, link);
    const result = await sendToTokens(tokens, payload);

    sums.successCount += Number((result as any)?.successCount ?? 0);
    sums.failureCount += Number((result as any)?.failureCount ?? 0);
    sums.attemptedTokens += tokens.length;

    tokens.forEach(t => sent.add(t));
  }

  console.log(
    "[notify] Attachment created (by token language)",
    JSON.stringify({
      projectId, problemId, issueId, taskId, attachmentId, createdBy,
      targetUids: targetUids.length,
      sent: sums
    })
  );

  const auditRef = firestore
    .collection(`projects/${projectId}/auditLogs`)
    .doc("events")
    .collection("notifications")
    .doc();

  await auditRef.set({
    type: "attachment_created",
    scope,
    projectId,
    problemId,
    issueId: issueId ?? null,
    taskId: taskId ?? null,
    attachmentId,
    createdBy: createdBy ?? null,
    sentAt: FieldValue.serverTimestamp(),
    result: sums,
  });

  return sums;
}

function extractPathParams(ref: DocumentReference) {
  const segments = ref.path.split("/");
  const projectIndex = segments.indexOf("projects");
  const problemIndex = segments.indexOf("problems");
  const issueIndex = segments.indexOf("issues");
  const taskIndex = segments.indexOf("tasks");

  const projectId = projectIndex >= 0 ? segments[projectIndex + 1] : undefined;
  const problemId = problemIndex >= 0 ? segments[problemIndex + 1] : undefined;
  const issueId = issueIndex >= 0 ? segments[issueIndex + 1] : undefined;
  const taskId = taskIndex >= 0 ? segments[taskIndex + 1] : undefined;

  return { projectId, problemId, issueId, taskId };
}

/** 期限リマインド（言語別トークン送信 + プロジェクト内キャッシュ） */
async function notifyTaskReminder(
  params: {
    projectId: string;
    problemId?: string;
    issueId?: string;
    taskId: string;
  },
  dueDate: string,
  window: ReminderWindow,
  cache: Map<string, Record<Lang, string[]>>
) {
  const { projectId, problemId, issueId, taskId } = params;

  // プロジェクト単位で ja/en トークンをキャッシュ
  let tokensByLang = cache.get(projectId);
  if (!tokensByLang) {
    const memberUids = await listProjectMemberUids(projectId);
    const jaTokens = await listTokensForUsersByLang(memberUids, "ja");
    const enTokens = await listTokensForUsersByLang(memberUids, "en");
    tokensByLang = { ja: jaTokens, en: enTokens };
    cache.set(projectId, tokensByLang);
  }

  const totalTokens = (tokensByLang.ja?.length ?? 0) + (tokensByLang.en?.length ?? 0);
  if (!totalTokens) {
    console.log(
      "[notify] No tokens for reminder (by token language)",
      JSON.stringify({ projectId, taskId, window, dueDate })
    );
    await markReminderSent(projectId, taskId, dueDate, window);
    return;
  }

  const dataBase: Record<string, string> = {
    type: "task_due_soon",
    projectId,
    dueDate,
    window,
    taskId,
  };
  if (problemId) dataBase.problemId = problemId;
  if (issueId)   dataBase.issueId   = issueId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  const sums = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();

  for (const lang of ["ja", "en"] as const) {
    const raw = tokensByLang[lang] ?? [];
    const tokens = raw.filter(t => !sent.has(t));
    if (!tokens.length) continue;

    const notification = reminderNotificationByLang(lang, window);
    const data = { ...dataBase, lang };
    const payload = withWebPushLink({ notification, data }, link);

    const result = await sendToTokens(tokens, payload);
    sums.successCount += Number((result as any)?.successCount ?? 0);
    sums.failureCount += Number((result as any)?.failureCount ?? 0);
    sums.attemptedTokens += tokens.length;

    tokens.forEach(t => sent.add(t));
  }

  console.log(
    "[notify] Reminder notification result (by token language)",
    JSON.stringify({ projectId, taskId, window, dueDate, sent: sums })
  );

  await markReminderSent(projectId, taskId, dueDate, window);
}

// ======== Firestore triggers ========

export const commentCreatedOnProblem = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/comments/{commentId}",
  async (event: FirestoreEvent<any, CommentParams>) => {
    try {
      if (!event.data) return;
      await handleCommentCreated(event);
    } catch (e) {
      console.error("[notify] commentCreatedOnProblem error", event.params, e);
    }
  }
);

export const commentCreatedOnIssue = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/comments/{commentId}",
  async (event: FirestoreEvent<any, CommentParams>) => {
    try {
      if (!event.data) return;
      await handleCommentCreated(event);
    } catch (e) {
      console.error("[notify] commentCreatedOnIssue error", event.params, e);
    }
  }
);

export const commentCreatedOnTask = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}/comments/{commentId}",
  async (event: FirestoreEvent<any, CommentParams>) => {
    try {
      if (!event.data) return;
      await handleCommentCreated(event);
    } catch (e) {
      console.error("[notify] commentCreatedOnTask error", event.params, e);
    }
  }
);

export const attachmentCreatedOnProblem = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/attachments/{attachmentId}",
  async (event: FirestoreEvent<any, AttachmentParams>) => {
    try {
      if (!event.data) return;
      await handleAttachmentCreated(event);
    } catch (e) {
      console.error("[notify] attachmentCreatedOnProblem error", event.params, e);
    }
  }
);

export const attachmentCreatedOnIssue = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/attachments/{attachmentId}",
  async (event: FirestoreEvent<any, AttachmentParams>) => {
    try {
      if (!event.data) return;
      await handleAttachmentCreated(event);
    } catch (e) {
      console.error("[notify] attachmentCreatedOnIssue error", event.params, e);
    }
  }
);

export const attachmentCreatedOnTask = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}/attachments/{attachmentId}",
  async (event: FirestoreEvent<any, AttachmentParams>) => {
    try {
      if (!event.data) return;
      await handleAttachmentCreated(event);
    } catch (e) {
      console.error("[notify] attachmentCreatedOnTask error", event.params, e);
    }
  }
);

// ======== Scheduler ========

export const taskDueReminder = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "Asia/Tokyo",
  },
  async () => {
    const today = getJstToday();
    const windows: { window: ReminderWindow; offset: number }[] = [
      { window: "1d", offset: 1 },
      { window: "7d", offset: 7 },
    ];

    const tokenCache = new Map<string, Record<Lang, string[]>>();

    for (const { window, offset } of windows) {
      const targetDate = formatYmd(addDays(today, offset));
      console.log("[notify] Checking reminders", JSON.stringify({ window, targetDate }));

      const snapshot = await firestore
        .collectionGroup("tasks")
        .where("softDeleted", "==", false)
        .where("status", "in", Array.from(openTaskStatuses))
        .where("dueDate", "==", targetDate)
        .get();

      for (const doc of snapshot.docs) {
        const taskId = doc.id;
        const { projectId, problemId, issueId } = extractPathParams(doc.ref);
        if (!projectId) {
          console.warn("[notify] Could not determine project for task", doc.ref.path);
          continue;
        }

        try {
          const alreadySent = await wasReminderSent(projectId, taskId, targetDate, window);
          if (alreadySent) {
            console.log(
              "[notify] Reminder already sent",
              JSON.stringify({ projectId, taskId, window, targetDate })
            );
            continue;
          }

          await notifyTaskReminder(
            { projectId, problemId, issueId, taskId },
            targetDate,
            window,
            tokenCache
          );
        } catch (e) {
          console.error("[notify] taskDueReminder item error", { projectId, taskId, window, targetDate }, e);
        }
      }
    }
  }
);


