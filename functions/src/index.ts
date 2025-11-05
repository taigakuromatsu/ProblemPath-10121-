// index.ts
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
  listFcmTokensForUsers,
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

function determineScope(params: { issueId?: string; taskId?: string }): "problem" | "issue" | "task" {
  if (params.taskId) return "task";
  if (params.issueId) return "issue";
  return "problem";
}

/** Web Push で通知クリック時に飛ばすリンクを生成（必要に応じて詳細化してください） */
function buildDeepLink(
  projectId: string,
  problemId?: string,
  issueId?: string,
  taskId?: string
): string {
  // 例: /project/:pid まで（必要なら問題/Issue/Task 詳細に拡張）
  const base = `https://kensyu10121.web.app/project/${projectId}`;
  // もし詳細導線を付けたいなら下記のように調整
  // if (taskId) return `${base}/tasks/${taskId}`;
  // if (issueId) return `${base}/issues/${issueId}`;
  // if (problemId) return `${base}/problems/${problemId}`;
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

// ===== functions/src/index.ts =====

type Lang = "ja" | "en";

function normalizeLang(input?: string): "ja" | "en" | undefined {
  if (!input) return undefined;
  const v = String(input).toLowerCase().replace("_", "-");
  if (v.startsWith("en")) return "en"; // en, en-us, en-gb など
  if (v.startsWith("ja")) return "ja"; // ja, ja-jp
  return undefined;
}

async function readUserLang(uid: string): Promise<Lang> {
  const db = getFirestore();

  // 1) users/{uid}/prefs/app
  try {
    const appSnap = await db.doc(`users/${uid}/prefs/app`).get();
    if (appSnap.exists) {
      const d = appSnap.data() as any;
      const n = normalizeLang(d?.lang ?? d?.locale);
      if (n) return n;
    }
  } catch {}

  // 2) users/{uid}/prefs
  try {
    const prefsSnap = await db.doc(`users/${uid}/prefs`).get();
    if (prefsSnap.exists) {
      const d = prefsSnap.data() as any;
      const n = normalizeLang(d?.lang ?? d?.locale);
      if (n) return n;
    }
  } catch {}

  // 3) users/{uid}
  try {
    const rootSnap = await db.doc(`users/${uid}`).get();
    if (rootSnap.exists) {
      const d = rootSnap.data() as any;
      const n = normalizeLang(d?.prefs?.lang ?? d?.lang ?? d?.locale);
      if (n) return n;
    }
  } catch {}

  // 最後の最後だけ日本語にフォールバック
  return "ja";
}


async function bucketUidsByLang(uids: string[]): Promise<Record<Lang, string[]>> {
  const buckets: Record<Lang, string[]> = { ja: [], en: [] };
  await Promise.all(
    uids.map(async (uid) => {
      const lang = await readUserLang(uid);
      buckets[lang].push(uid);
    })
  );

  // デバッグ（必要なら）：どのUIDがどの言語に入ったかをログ
  console.log("[notify] lang buckets", JSON.stringify(buckets));
  return buckets;
}


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



/** コメント作成時の通知（自己通知の抑止＋リンク付与） */
async function handleCommentCreated(
  event: FirestoreEvent<any, CommentParams>
) {
  const { projectId, problemId, issueId, taskId, commentId } = event.params;
  const scope = determineScope(event.params);

  // 送信者（authorId）を onCreate データから取得して自己通知を除外
  const authorId: string | undefined = event.data?.data()?.authorId;

  const allMemberUids = await listProjectMemberUids(projectId);
  const targetUids = authorId ? allMemberUids.filter(uid => uid !== authorId) : allMemberUids;

  // ✅ 言語別にUIDをバケット化
  const buckets = await bucketUidsByLang(targetUids);

  const data: Record<string, string> = {
    type: "comment_created",
    projectId,
    scope,
    problemId,
    commentId,
  };
  if (issueId) data.issueId = issueId;
  if (taskId)  data.taskId  = taskId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  // 送信結果を集計
  const sums = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();
  for (const lang of ["ja", "en"] as const) {
    if (!buckets[lang]?.length) continue;

    // 言語ごとにトークンを取得
    const tokensRaw = await listFcmTokensForUsers(buckets[lang]);
    const tokens = uniqueTokens(tokensRaw).filter(t => !sent.has(t)); 
    if (!tokens.length) continue;

    // 言語ごとの文面
    const notification = commentNotificationByLang(lang, scope);
    const dataWithLang = { ...data, lang };
    const payload = withWebPushLink({ notification, data: dataWithLang }, link);
    const result = await sendToTokens(tokens, payload);

    // 集計（sendToTokensの戻り値は環境により型が異なることがあるため防御的に）
    sums.successCount += Number((result as any)?.successCount ?? 0);
    sums.failureCount += Number((result as any)?.failureCount ?? 0);
    sums.attemptedTokens += tokens.length;

    tokens.forEach(t => sent.add(t));
  }

  console.log(
    "[notify] Comment created (multilang)",
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


/** 添付作成時の通知（自己通知の抑止＋リンク付与） */
async function handleAttachmentCreated(
  event: FirestoreEvent<any, AttachmentParams>
) {
  const { projectId, problemId, issueId, taskId, attachmentId } = event.params;
  const scope = determineScope(event.params);

  // 送信者（createdBy）を onCreate データから取得して自己通知を除外
  const createdBy: string | undefined = event.data?.data()?.createdBy;

  const allMemberUids = await listProjectMemberUids(projectId);
  const targetUids = createdBy ? allMemberUids.filter(uid => uid !== createdBy) : allMemberUids;

  // ✅ 言語別にUIDをバケット化
  const buckets = await bucketUidsByLang(targetUids);

  const data: Record<string, string> = {
    type: "attachment_created",
    projectId,
    scope,
    problemId,
    attachmentId,
  };
  if (issueId) data.issueId = issueId;
  if (taskId)  data.taskId  = taskId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  // 送信結果を集計
  const sums = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();
  for (const lang of ["ja", "en"] as const) {
    if (!buckets[lang]?.length) continue;

    // 言語ごとにトークンを取得
    const tokensRaw = await listFcmTokensForUsers(buckets[lang]);
    const tokens = uniqueTokens(tokensRaw).filter(t => !sent.has(t)); 
    if (!tokens.length) continue;

    // 言語ごとの文面
    const notification = attachmentNotificationByLang(lang, scope);
    const dataWithLang = { ...data, lang };
    const payload = withWebPushLink({ notification, data: dataWithLang }, link);
    const result = await sendToTokens(tokens, payload);

    // 集計
    sums.successCount += Number((result as any)?.successCount ?? 0);
    sums.failureCount += Number((result as any)?.failureCount ?? 0);
    sums.attemptedTokens += tokens.length;

    tokens.forEach(t => sent.add(t));
  }

  console.log(
    "[notify] Attachment created (multilang)",
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

  // 言語別トークンのキャッシュ取得 or 構築
  let tokensByLang = cache.get(projectId);
  if (!tokensByLang) {
    const memberUids = await listProjectMemberUids(projectId);
    const buckets = await bucketUidsByLang(memberUids);
    const jaTokens = buckets.ja.length ? await listFcmTokensForUsers(buckets.ja) : [];
    const enTokens = buckets.en.length ? await listFcmTokensForUsers(buckets.en) : [];
    tokensByLang = { ja: jaTokens, en: enTokens };
    cache.set(projectId, tokensByLang);
  }

  const totalTokens =
    (tokensByLang.ja?.length ?? 0) + (tokensByLang.en?.length ?? 0);

  if (!totalTokens) {
    console.log(
      "[notify] No tokens for reminder (multilang)",
      JSON.stringify({ projectId, taskId, window, dueDate })
    );
    await markReminderSent(projectId, taskId, dueDate, window);
    return;
  }

  const data: Record<string, string> = {
    type: "task_due_soon",
    projectId,
    dueDate,
    window,
    taskId,
  };
  if (problemId) data.problemId = problemId;
  if (issueId)   data.issueId   = issueId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);

  const sums = { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  const sent = new Set<string>();

  for (const lang of ["ja", "en"] as const) {
    const raw = tokensByLang[lang] ?? [];
    const tokens = raw.filter(t => !sent.has(t));
    if (!tokens.length) continue;

    const notification = reminderNotificationByLang(lang, window);
    const dataWithLang = { ...data, lang };
    const payload = withWebPushLink({ notification, data: dataWithLang }, link);

    const result = await sendToTokens(tokens, payload);
    sums.successCount += Number((result as any)?.successCount ?? 0);
    sums.failureCount += Number((result as any)?.failureCount ?? 0);
    sums.attemptedTokens += tokens.length;

    tokens.forEach(t => sent.add(t));

  }

  console.log(
    "[notify] Reminder notification result (multilang)",
    JSON.stringify({ projectId, taskId, window, dueDate, sent: sums })
  );

  await markReminderSent(projectId, taskId, dueDate, window);
}


// ======== Firestore triggers (自己通知抑止 & WebPushリンク 版) ========

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

// ======== Scheduler (既存のまま + WebPushリンク付与) ========

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

