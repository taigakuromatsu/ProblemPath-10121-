import { getApps, initializeApp } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import type { MulticastMessage, MessagingOptions } from "firebase-admin/messaging";
import { onRequest, type Request, type Response } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import {
  onDocumentCreated,
  type FirestoreEvent,
} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  DEFAULT_NOTIFY_PREFS,
  getNotifyPrefsForUsers,
  listProjectMemberUids,
  markReminderSent,
  region,
  sendToTokens,
  wasReminderSent,
  type SendSummary,
} from "./notify";
import type { DueReminderMode, NotifyPrefs, ReminderWindow } from "./notify";
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
type Lang = "ja" | "en";

interface NotificationTitles {
  problemTitle?: string;
  issueTitle?: string;
  taskTitle?: string;
}

function sanitizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function fallbackTitle(
  title: string | undefined,
  lang: Lang,
  fallbackJa: string,
  fallbackEn: string
): string {
  if (title && title.trim()) return title.trim();
  return lang === "ja" ? fallbackJa : fallbackEn;
}

function assignIfDefined(target: Record<string, string>, key: string, value?: string) {
  if (value) {
    target[key] = value;
  }
}

function isReminderEnabled(mode: DueReminderMode, window: ReminderWindow): boolean {
  if (mode === "none") return false;
  if (mode === "1d7d") return true;
  return mode === window;
}

function getCurrentJstHour(): number {
  const now = new Date();
  return (now.getUTCHours() + 9) % 24;
}

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

async function fetchNotificationTitles(params: {
  projectId: string;
  problemId?: string;
  issueId?: string;
  taskId?: string;
}): Promise<NotificationTitles> {
  const { projectId, problemId, issueId, taskId } = params;
  const titles: NotificationTitles = {};
  const promises: Promise<void>[] = [];

  if (problemId) {
    promises.push(
      firestore
        .doc(`projects/${projectId}/problems/${problemId}`)
        .get()
        .then((snap: FirebaseFirestore.DocumentSnapshot) => {
          if (snap.exists) {
            const data = snap.data() as any;
            titles.problemTitle = sanitizeTitle(data?.title);
          }
        })
        .catch(() => undefined)
    );
  }

  if (problemId && issueId) {
    promises.push(
      firestore
        .doc(`projects/${projectId}/problems/${problemId}/issues/${issueId}`)
        .get()
        .then((snap: FirebaseFirestore.DocumentSnapshot) => {
          if (snap.exists) {
            const data = snap.data() as any;
            titles.issueTitle = sanitizeTitle(data?.title);
          }
        })
        .catch(() => undefined)
    );
  }

  if (problemId && issueId && taskId) {
    promises.push(
      firestore
        .doc(
          `projects/${projectId}/problems/${problemId}/issues/${issueId}/tasks/${taskId}`
        )
        .get()
        .then((snap: FirebaseFirestore.DocumentSnapshot) => {
          if (snap.exists) {
            const data = snap.data() as any;
            titles.taskTitle = sanitizeTitle(data?.title);
          }
        })
        .catch(() => undefined)
    );
  }

  await Promise.all(promises);
  return titles;
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

/** 言語別メッセージ文面（コメント） */
function commentNotificationByLang(
  lang: Lang,
  scope: "problem" | "issue" | "task",
  titles: NotificationTitles
) {
  const title = lang === "ja" ? "新しいコメント" : "New comment";
  let body: string;

  if (scope === "task") {
    const taskLabel = fallbackTitle(titles.taskTitle, lang, "タスク", "task");
    body =
      lang === "ja"
        ? `タスク「${taskLabel}」に新しいコメントが追加されました`
        : `New comment on task "${taskLabel}"`;
  } else if (scope === "issue") {
    const issueLabel = fallbackTitle(titles.issueTitle, lang, "Issue", "issue");
    body =
      lang === "ja"
        ? `「${issueLabel}」に新しいコメントが追加されました`
        : `New comment on "${issueLabel}"`;
  } else {
    const problemLabel = fallbackTitle(titles.problemTitle, lang, "Problem", "problem");
    body =
      lang === "ja"
        ? `「${problemLabel}」に新しいコメントが追加されました`
        : `New comment on "${problemLabel}"`;
  }

  return { title, body };
}

/** 言語別メッセージ文面（添付） */
function attachmentNotificationByLang(
  lang: Lang,
  scope: "problem" | "issue" | "task",
  titles: NotificationTitles
) {
  const title = lang === "ja" ? "ファイルが追加されました" : "File added";
  let body: string;

  if (scope === "task") {
    const taskLabel = fallbackTitle(titles.taskTitle, lang, "タスク", "task");
    body =
      lang === "ja"
        ? `タスク「${taskLabel}」にファイルが追加されました`
        : `New file added to task "${taskLabel}"`;
  } else if (scope === "issue") {
    const issueLabel = fallbackTitle(titles.issueTitle, lang, "Issue", "issue");
    body =
      lang === "ja"
        ? `「${issueLabel}」にファイルが追加されました`
        : `New file added to "${issueLabel}"`;
  } else {
    const problemLabel = fallbackTitle(titles.problemTitle, lang, "Problem", "problem");
    body =
      lang === "ja"
        ? `「${problemLabel}」にファイルが追加されました`
        : `New file added to "${problemLabel}"`;
  }

  return { title, body };
}

/** 言語別メッセージ文面（期限リマインド） */
function reminderNotificationByLang(
  lang: Lang,
  window: ReminderWindow,
  titles: NotificationTitles,
  dueDate: string
) {
  const title =
    window === "1d"
      ? (lang === "ja" ? "明日が期限です" : "Due tomorrow")
      : (lang === "ja" ? "1週間前のリマインド" : "Due in one week");
  const taskLabel = fallbackTitle(titles.taskTitle, lang, "タスク", "task");
  const body =
    lang === "ja"
      ? `期限が近いタスク「${taskLabel}」があります（${dueDate} 締切）`
      : `Task "${taskLabel}" is due soon (${dueDate})`;
  return { title, body };
}

/** コメント作成時通知（自己通知抑止 + 言語別トークン送信） */
async function handleCommentCreated(
  event: FirestoreEvent<any, CommentParams>
) {
  const { projectId, problemId, issueId, taskId, commentId } = event.params;
  const scope = determineScope(event.params);

  const authorId: string | undefined = event.data?.data()?.authorId;

  const allMemberUids = await listProjectMemberUids(projectId);
  const uniqueMemberUids = Array.from(new Set(allMemberUids.filter((uid) => !!uid)));
  const prefsMap = await getNotifyPrefsForUsers(uniqueMemberUids);
  const targetUids = uniqueMemberUids.filter((uid) => {
    if (!uid) return false;
    if (authorId && uid === authorId) return false;
    const prefs = prefsMap.get(uid) ?? DEFAULT_NOTIFY_PREFS;
    return prefs.instantComment === true;
  });

  const titles = await fetchNotificationTitles({ projectId, problemId, issueId, taskId });

  const dataBase: Record<string, string> = {
    type: "comment_created",
    kind: "comment",
    projectId,
    scope,
    problemId,
    commentId,
  };
  if (issueId) dataBase.issueId = issueId;
  if (taskId)  dataBase.taskId  = taskId;
  assignIfDefined(dataBase, "problemTitle", titles.problemTitle);
  assignIfDefined(dataBase, "issueTitle", titles.issueTitle);
  assignIfDefined(dataBase, "taskTitle", titles.taskTitle);

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  const sums: SendSummary = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();

  for (const lang of ["ja", "en"] as const) {
    const tokensRaw = await listTokensForUsersByLang(targetUids, lang);
    const tokens = tokensRaw.filter(t => !sent.has(t));
    if (!tokens.length) continue;

    const notification = commentNotificationByLang(lang, scope, titles);
    const data = { ...dataBase, lang };
    const payload = withWebPushLink({ notification, data }, link);
    const result = await sendToTokens(tokens, payload);

    sums.successCount += result.successCount;
    sums.failureCount += result.failureCount;
    sums.attemptedTokens += result.attemptedTokens;

    tokens.forEach(t => sent.add(t));
  }

  console.log(
    "[notify] Comment created (by token language)",
    JSON.stringify({
      projectId, problemId, issueId, taskId, commentId, authorId,
      targetUids: targetUids.length,
      sent: sums,
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
  const uniqueMemberUids = Array.from(new Set(allMemberUids.filter((uid) => !!uid)));
  const prefsMap = await getNotifyPrefsForUsers(uniqueMemberUids);
  const targetUids = uniqueMemberUids.filter((uid) => {
    if (!uid) return false;
    if (createdBy && uid === createdBy) return false;
    const prefs = prefsMap.get(uid) ?? DEFAULT_NOTIFY_PREFS;
    return prefs.instantFile === true;
  });

  const titles = await fetchNotificationTitles({ projectId, problemId, issueId, taskId });

  const dataBase: Record<string, string> = {
    type: "attachment_created",
    kind: "file",
    projectId,
    scope,
    problemId,
    attachmentId,
  };
  if (issueId) dataBase.issueId = issueId;
  if (taskId)  dataBase.taskId  = taskId;
  assignIfDefined(dataBase, "problemTitle", titles.problemTitle);
  assignIfDefined(dataBase, "issueTitle", titles.issueTitle);
  assignIfDefined(dataBase, "taskTitle", titles.taskTitle);

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  const sums: SendSummary = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();

  for (const lang of ["ja", "en"] as const) {
    const tokensRaw = await listTokensForUsersByLang(targetUids, lang);
    const tokens = tokensRaw.filter(t => !sent.has(t));
    if (!tokens.length) continue;

    const notification = attachmentNotificationByLang(lang, scope, titles);
    const data = { ...dataBase, lang };
    const payload = withWebPushLink({ notification, data }, link);
    const result = await sendToTokens(tokens, payload);

    sums.successCount += result.successCount;
    sums.failureCount += result.failureCount;
    sums.attemptedTokens += result.attemptedTokens;

    tokens.forEach(t => sent.add(t));
  }

  console.log(
    "[notify] Attachment created (by token language)",
    JSON.stringify({
      projectId, problemId, issueId, taskId, attachmentId, createdBy,
      targetUids: targetUids.length,
      sent: sums,
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

/** 期限リマインド（送信サマリ返却版） */
async function notifyTaskReminder(
  params: {
    projectId: string;
    problemId?: string;
    issueId?: string;
    taskId: string;
  },
  dueDate: string,
  window: ReminderWindow,
  targetUids: string[],
  titles: NotificationTitles
): Promise<SendSummary> {
  const { projectId, problemId, issueId, taskId } = params;

  if (!targetUids.length) {
    console.log(
      "[notify] No recipients for reminder",
      JSON.stringify({ projectId, taskId, window, dueDate })
    );
    return { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  }

  const dataBase: Record<string, string> = {
    type: "task_due_soon",
    kind: "due",
    projectId,
    dueDate,
    window,
    taskId,
  };
  if (problemId) dataBase.problemId = problemId;
  if (issueId) dataBase.issueId = issueId;
  assignIfDefined(dataBase, "problemTitle", titles.problemTitle);
  assignIfDefined(dataBase, "issueTitle", titles.issueTitle);
  assignIfDefined(dataBase, "taskTitle", titles.taskTitle);

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  const sums: SendSummary = {
    successCount: 0,
    failureCount: 0,
    attemptedTokens: 0,
  };
  const sent = new Set<string>();

  for (const lang of ["ja", "en"] as const) {
    const tokensRaw = await listTokensForUsersByLang(targetUids, lang);
    const tokens = tokensRaw.filter((t) => !sent.has(t));
    if (!tokens.length) continue;

    const notification = reminderNotificationByLang(lang, window, titles, dueDate);
    const data = { ...dataBase, lang };
    const payload = withWebPushLink({ notification, data }, link);

    const result = await sendToTokens(tokens, payload);

    sums.successCount += result.successCount;
    sums.failureCount += result.failureCount;
    sums.attemptedTokens += result.attemptedTokens;

    tokens.forEach((t) => sent.add(t));
  }

  console.log(
    "[notify] Reminder notification result",
    JSON.stringify({
      projectId,
      taskId,
      window,
      dueDate,
      recipients: targetUids.length,
      sent: sums,
    })
  );

  await Promise.all(
    targetUids.map((uid) => markReminderSent(projectId, taskId, dueDate, window, uid))
  );

  return sums;
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

// ======== Scheduler 共通ロジック ========

async function runTaskDueReminderJob(
  baseYmd?: string,
  hourOverride?: number
): Promise<{
  baseYmd: string;
  hour: number;
  checks: {
    window: ReminderWindow;
    targetDate: string;
    foundTasks: number;
    candidateUsers: number;
    targetUsers: number;
    notifiedTasks: number;
  }[];
}> {
  // baseYmd があればそれを JST の「今日」として解釈
  const baseDate =
    baseYmd && /^\d{4}-\d{2}-\d{2}$/.test(baseYmd)
      ? new Date(
          Date.UTC(
            Number(baseYmd.slice(0, 4)),
            Number(baseYmd.slice(5, 7)) - 1,
            Number(baseYmd.slice(8, 10))
          )
        )
      : getJstToday();

  const baseYmdStr = formatYmd(baseDate);

  const hour =
    typeof hourOverride === "number" &&
    Number.isInteger(hourOverride) &&
    hourOverride >= 0 &&
    hourOverride <= 23
      ? hourOverride
      : getCurrentJstHour();

  const windows: { window: ReminderWindow; offset: number }[] = [
    { window: "1d", offset: 1 },
    { window: "7d", offset: 7 },
  ];

  const memberCache = new Map<string, string[]>();
  const prefsCache = new Map<string, Map<string, NotifyPrefs>>();
  type ParentInfo = { title?: string } | null;
  const problemCache = new Map<string, ParentInfo>();
  const issueCache = new Map<string, ParentInfo>();

  const getMemberUidsForProject = async (projectId: string): Promise<string[]> => {
    if (!memberCache.has(projectId)) {
      const uids = await listProjectMemberUids(projectId);
      memberCache.set(
        projectId,
        Array.from(new Set(uids.filter((uid) => typeof uid === "string" && uid)))
      );
    }
    return memberCache.get(projectId) ?? [];
  };

  const getPrefsForProject = async (
    projectId: string,
    uids: string[]
  ): Promise<Map<string, NotifyPrefs>> => {
    const cached = prefsCache.get(projectId);
    if (cached && uids.every((uid) => cached.has(uid))) {
      return cached;
    }
    const map = await getNotifyPrefsForUsers(uids);
    prefsCache.set(projectId, map);
    return map;
  };

  const loadProblemInfo = async (
    projectId: string,
    problemId: string
  ): Promise<ParentInfo> => {
    const key = `${projectId}:${problemId}`;
    if (!problemCache.has(key)) {
      try {
        const snap = await firestore.doc(`projects/${projectId}/problems/${problemId}`).get();
        if (!snap.exists) {
          problemCache.set(key, null);
        } else {
          const data = snap.data() as any;
          if (data?.softDeleted) {
            problemCache.set(key, null);
          } else {
            problemCache.set(key, { title: sanitizeTitle(data?.title) });
          }
        }
      } catch {
        problemCache.set(key, null);
      }
    }
    return problemCache.get(key) ?? null;
  };

  const loadIssueInfo = async (
    projectId: string,
    problemId: string,
    issueId: string
  ): Promise<ParentInfo> => {
    const key = `${projectId}:${problemId}:${issueId}`;
    if (!issueCache.has(key)) {
      try {
        const snap = await firestore
          .doc(`projects/${projectId}/problems/${problemId}/issues/${issueId}`)
          .get();
        if (!snap.exists) {
          issueCache.set(key, null);
        } else {
          const data = snap.data() as any;
          if (data?.softDeleted) {
            issueCache.set(key, null);
          } else {
            issueCache.set(key, { title: sanitizeTitle(data?.title) });
          }
        }
      } catch {
        issueCache.set(key, null);
      }
    }
    return issueCache.get(key) ?? null;
  };

  const checks: {
    window: ReminderWindow;
    targetDate: string;
    foundTasks: number;
    candidateUsers: number;
    targetUsers: number;
    notifiedTasks: number;
  }[] = [];

  for (const { window, offset } of windows) {
    // 「今日(baseYmdStr)」からオフセットした期限日
    const targetDate = formatYmd(addDays(baseDate, offset));
    const check = {
      window,
      targetDate,
      foundTasks: 0,
      candidateUsers: 0,
      targetUsers: 0,
      notifiedTasks: 0,
    };

    console.log("[notify] Checking reminders", JSON.stringify({ window, targetDate }));

    const snapshot = await firestore
      .collectionGroup("tasks")
      .where("softDeleted", "==", false)
      .where("status", "in", Array.from(openTaskStatuses))
      .where("dueDate", "==", targetDate)
      .get();

    check.foundTasks = snapshot.docs.length;

    for (const doc of snapshot.docs) {
      const taskId = doc.id;
      const { projectId, problemId, issueId } = extractPathParams(doc.ref);
      if (!projectId || !problemId) {
        console.warn("[notify] Could not determine project for task", doc.ref.path);
        continue;
      }

      try {
        const taskData = (doc.data() as any) ?? {};
        if (taskData?.softDeleted) continue;

        const problemInfo = await loadProblemInfo(projectId, problemId);
        if (!problemInfo) continue;

        let issueInfo: ParentInfo = null;
        if (issueId) {
          issueInfo = await loadIssueInfo(projectId, problemId, issueId);
          if (!issueInfo) continue;
        }

        const memberUids = await getMemberUidsForProject(projectId);
        if (!memberUids.length) continue;

        const prefsMap = await getPrefsForProject(projectId, memberUids);
        const candidateUids = memberUids.filter((uid) => {
          if (!uid) return false;
          const prefs = prefsMap.get(uid) ?? DEFAULT_NOTIFY_PREFS;
          if (!isReminderEnabled(prefs.dueReminderMode, window)) return false;
          return prefs.dueReminderHour === hour;
        });

        check.candidateUsers += candidateUids.length;
        if (!candidateUids.length) continue;

        const sendChecks = await Promise.all(
          candidateUids.map(async (uid) => ({
            uid,
            alreadySent: await wasReminderSent(projectId, taskId, targetDate, window, uid),
          }))
        );

        const targetUids = sendChecks
          .filter((entry) => !entry.alreadySent)
          .map((entry) => entry.uid);

        check.targetUsers += targetUids.length;
        if (!targetUids.length) continue;

        const titles: NotificationTitles = {
          problemTitle: problemInfo?.title,
          issueTitle: issueInfo?.title,
          taskTitle: sanitizeTitle(taskData?.title),
        };

        const summary = await notifyTaskReminder(
          { projectId, problemId, issueId, taskId },
          targetDate,
          window,
          targetUids,
          titles
        );

        if (summary.attemptedTokens > 0) {
          check.notifiedTasks += 1;
        }
      } catch (e) {
        console.error(
          "[notify] taskDueReminder item error",
          { projectId, taskId, window, targetDate },
          e
        );
      }
    }

    checks.push(check);
  }

  const summary = { baseYmd: baseYmdStr, hour, checks };
  console.log("[notify] taskDueReminder summary", JSON.stringify(summary));
  return summary;
}

// 本番用スケジューラ
export const taskDueReminder = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "Asia/Tokyo",
  },
  async () => {
    await runTaskDueReminderJob();
  }
);

// デバッグ用 HTTP エンドポイント（挙動確認用）
// デバッグ用 HTTP エンドポイント（そのまま本番に置いておいてOK）
export const taskDueReminderDebug = onRequest(async (req, res) => {
  try {
    // v2 の型まわりで req が unknown 扱いされる問題を避けるため any キャストに寄せる
    const q = (req as any).query || {};

    const ymdParam =
      typeof q.ymd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.ymd)
        ? q.ymd
        : undefined;

    const hourParam =
      typeof q.hour === "string" && q.hour !== ""
        ? Number(q.hour)
        : undefined;

    const result = await runTaskDueReminderJob(ymdParam, hourParam);

    // Response 型に .json が無いと言われる環境向けに send + JSON.stringify で返す
    res.status(200).send(JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error("[notify] taskDueReminderDebug error", e);
    res.status(500).send(`error: ${e?.message ?? String(e)}`);
  }
});

