import * as admin from 'firebase-admin';
import { setGlobalOptions } from 'firebase-functions/v2';
import {
  onDocumentWritten,
  onDocumentCreated,
} from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall } from 'firebase-functions/v2/https';

export const ping = onCall(() => ({ ok: true }));

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// すべての関数のデフォルト地域を設定
setGlobalOptions({ region: 'asia-northeast1' });

/* =========================================
 *  共通：監査ログ（既存）
 * ========================================= */

/** 監査ログを書き込む（追記のみ） */
async function writeAudit(
  projectId: string,
  entity: 'problem' | 'issue' | 'task',
  entityId: string,
  action: 'create' | 'update' | 'delete',
  by?: string | null
) {
  const col = db.collection(`projects/${projectId}/auditLogs`);
  await col.add({
    entity,
    entityId,
    action,
    by: by ?? null,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** 差分から action と by を推定 */
function actionAndBy(
  before: FirebaseFirestore.DocumentData | null,
  after: FirebaseFirestore.DocumentData | null
) {
  let action: 'create' | 'update' | 'delete';
  if (!before && after) action = 'create';
  else if (before && !after) action = 'delete';
  else action = 'update';
  const by =
    (after?.updatedBy ??
      before?.updatedBy ??
      after?.createdBy ??
      before?.createdBy) ?? null;
  return { action, by };
}

/** Problems onWrite -> auditLogs 追記 */
export const auditProblemsOnWrite = onDocumentWritten(
  'projects/{projectId}/problems/{problemId}',
  async (event) => {
    const { projectId, problemId } = event.params as {
      projectId: string;
      problemId: string;
    };
    const before = event.data?.before.exists ? event.data.before.data()! : null;
    const after = event.data?.after.exists ? event.data.after.data()! : null;
    const { action, by } = actionAndBy(before, after);
    await writeAudit(projectId, 'problem', problemId, action, by);
  }
);

/** Issues onWrite -> auditLogs 追記 */
export const auditIssuesOnWrite = onDocumentWritten(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}',
  async (event) => {
    const { projectId, issueId } = event.params as {
      projectId: string;
      issueId: string;
    };
    const before = event.data?.before.exists ? event.data.before.data()! : null;
    const after = event.data?.after.exists ? event.data.after.data()! : null;
    const { action, by } = actionAndBy(before, after);
    await writeAudit(projectId, 'issue', issueId, action, by);
  }
);

/** Tasks onWrite -> auditLogs 追記 */
export const auditTasksOnWrite = onDocumentWritten(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}',
  async (event) => {
    const { projectId, taskId } = event.params as {
      projectId: string;
      taskId: string;
    };
    const before = event.data?.before.exists ? event.data.before.data()! : null;
    const after = event.data?.after.exists ? event.data.after.data()! : null;
    const { action, by } = actionAndBy(before, after);
    await writeAudit(projectId, 'task', taskId, action, by);
  }
);

/* =========================================
 *  共通：通知ユーティリティ
 * ========================================= */

/** プロジェクトの全メンバーUID（viewer含む）を取得 */
async function listProjectMemberUids(projectId: string): Promise<string[]> {
  const snap = await db.collection(`projects/${projectId}/members`).get();
  return snap.docs.map((d) => d.id);
}

/** ユーザーのFCMトークン一覧（users/{uid}/fcmTokens/* の doc.id） */
async function listUserTokens(uid: string): Promise<string[]> {
  const snap = await db.collection(`users/${uid}/fcmTokens`).get();
  return snap.docs.map((d) => d.id);
}

/** 指定 uid 集合に通知を送りつつ、無効トークンを削除 */
async function notifyUsers(
  uids: string[],
  payload: { title: string; body?: string; data?: Record<string, string> }
): Promise<void> {
  // uid -> tokens
  const mapTokens = new Map<string, string[]>();
  await Promise.all(
    uids.map(async (uid) => {
      const tks = await listUserTokens(uid);
      if (tks.length > 0) mapTokens.set(uid, tks);
    })
  );

  const allTokens: string[] = Array.from(mapTokens.values()).flat();
  if (allTokens.length === 0) return;

  const res = await messaging.sendEachForMulticast({
    tokens: allTokens,
    notification: { title: payload.title, body: payload.body ?? '' },
    data: payload.data ?? {},
  });

  // 無効トークンの掃除（uid単位で確実に削除）
  const invalid: string[] = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code ?? '';
      if (
        code.includes('registration-token-not-registered') ||
        code.includes('invalid-argument') ||
        code.includes('messaging/invalid-argument') ||
        code.includes('messaging/registration-token-not-registered')
      ) {
        const tok = allTokens[i]!; // responses.length === tokens.length 前提で non-null
        invalid.push(tok);
      }
    }
  });

  if (invalid.length > 0) {
    const batch = db.batch();
    for (const [uid, tokens] of mapTokens) {
      for (const t of tokens) {
        if (invalid.includes(t)) {
          batch.delete(db.doc(`users/${uid}/fcmTokens/${t}`));
        }
      }
    }
    await batch.commit().catch(() => {});
  }
}

/* =========================================
 *  即時通知：コメント & 添付ファイル 追加
 *  - プロジェクトのメンバー全員に通知
 * ========================================= */

// Problem コメント
export const notifyOnProblemComment = onDocumentCreated(
  'projects/{projectId}/problems/{problemId}/comments/{commentId}',
  async (event) => {
    const { projectId } = event.params as { projectId: string };
    const data = event.data?.data() as any;
    const uids = await listProjectMemberUids(projectId);

    const title = '新しいコメント（Problem）';
    const body = (data?.text ?? '').toString().slice(0, 80);
    await notifyUsers(uids, {
      title,
      body,
      data: { kind: 'comment', projectId, scope: 'problem' },
    });
  }
);

// Issue コメント
export const notifyOnIssueComment = onDocumentCreated(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}/comments/{commentId}',
  async (event) => {
    const { projectId } = event.params as { projectId: string };
    const data = event.data?.data() as any;
    const uids = await listProjectMemberUids(projectId);

    const title = '新しいコメント（Issue）';
    const body = (data?.text ?? '').toString().slice(0, 80);
    await notifyUsers(uids, {
      title,
      body,
      data: { kind: 'comment', projectId, scope: 'issue' },
    });
  }
);

// Task コメント
export const notifyOnTaskComment = onDocumentCreated(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}/comments/{commentId}',
  async (event) => {
    const { projectId } = event.params as { projectId: string };
    const data = event.data?.data() as any;
    const uids = await listProjectMemberUids(projectId);

    const title = '新しいコメント（Task）';
    const body = (data?.text ?? '').toString().slice(0, 80);
    await notifyUsers(uids, {
      title,
      body,
      data: { kind: 'comment', projectId, scope: 'task' },
    });
  }
);

// Problem 添付
export const notifyOnProblemAttachment = onDocumentCreated(
  'projects/{projectId}/problems/{problemId}/attachments/{attId}',
  async (event) => {
    const { projectId } = event.params as { projectId: string };
    const data = event.data?.data() as any;
    const uids = await listProjectMemberUids(projectId);

    const title = 'ファイルが追加されました（Problem）';
    const body = (data?.name ?? '').toString().slice(0, 80);
    await notifyUsers(uids, {
      title,
      body,
      data: { kind: 'attachment', projectId, scope: 'problem' },
    });
  }
);

// Issue 添付
export const notifyOnIssueAttachment = onDocumentCreated(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}/attachments/{attId}',
  async (event) => {
    const { projectId } = event.params as { projectId: string };
    const data = event.data?.data() as any;
    const uids = await listProjectMemberUids(projectId);

    const title = 'ファイルが追加されました（Issue）';
    const body = (data?.name ?? '').toString().slice(0, 80);
    await notifyUsers(uids, {
      title,
      body,
      data: { kind: 'attachment', projectId, scope: 'issue' },
    });
  }
);

// Task 添付
export const notifyOnTaskAttachment = onDocumentCreated(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}/attachments/{attId}',
  async (event) => {
    const { projectId } = event.params as { projectId: string };
    const data = event.data?.data() as any;
    const uids = await listProjectMemberUids(projectId);

    const title = 'ファイルが追加されました（Task）';
    const body = (data?.name ?? '').toString().slice(0, 80);
    await notifyUsers(uids, {
      title,
      body,
      data: { kind: 'attachment', projectId, scope: 'task' },
    });
  }
);

/* =========================================
 *  定期通知：締め切り 1 日前
 *  - JST 基準で「明日」の YYYY-MM-DD に一致する Task を対象
 *  - softDeleted は除外
 * ========================================= */

function ymdInJST(d: Date): string {
  // UTC→JST(+9) へ補正して YYYY-MM-DD 文字列
  const JST_OFFSET = 9 * 60; // minutes
  const utc = d.getTime();
  const jst = new Date(utc + JST_OFFSET * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const da = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

export const notifyDueTomorrow = onSchedule(
  { schedule: 'every day 09:00', timeZone: 'Asia/Tokyo' },
  async () => {
    // 明日（JST）の YYYY-MM-DD
    const now = new Date();
    const tomorrowUTC = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const targetYmd = ymdInJST(tomorrowUTC);

    // collectionGroup('tasks') で dueDate == targetYmd を検索
    // projectId フィールド前提
    const snap = await db
      .collectionGroup('tasks')
      .where('dueDate', '==', targetYmd)
      .get();

    // プロジェクト単位にまとめて通知
    const byProject: Map<string, Array<{ id: string; title?: string }>> =
      new Map();

    snap.docs.forEach((doc) => {
      const data = doc.data() as any;
      if (data?.softDeleted === true) return; // 削除扱いは除外
      const pid = String(data?.projectId ?? '');
      if (!pid) return;
      const arr = byProject.get(pid) ?? [];
      arr.push({ id: doc.id, title: data?.title });
      byProject.set(pid, arr);
    });

    for (const [projectId, tasks] of byProject) {
      const uids = await listProjectMemberUids(projectId);
      if (uids.length === 0) continue;

      const sample =
        tasks
          .map((t) => t.title)
          .filter(Boolean)
          .slice(0, 3)
          .join(' / ') || '';
      const more =
        tasks.length > 3 ? ` ほか ${tasks.length - 3} 件` : '';

      const title = '締め切りが近づいています（明日）';
      const body =
        (sample ? `${sample}` : '明日締め切りのタスクがあります') + more;

      await notifyUsers(uids, {
        title,
        body,
        data: { kind: 'due', projectId, date: targetYmd },
      });
    }
  }
);

/* =========================================
 *  ソフトデリート検出の DRY-RUN パージ（既存）
 * ========================================= */

/**
 * ソフトデリート検出の DRY-RUN パージ
 * - 実削除はしないでログ出力のみ（既存データへ無影響）
 * - 7日超経過した softDeleted ドキュメントを collectionGroup で拾う
 */
export const purgeSoftDeletedDryRun = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Asia/Tokyo' },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    );

    const collect = async (group: 'problems' | 'issues' | 'tasks') => {
      const snap = await db
        .collectionGroup(group)
        .where('softDeleted', '==', true)
        .where('deletedAt', '<=', cutoff)
        .get();
      console.log(`[DRY-RUN] ${group} purge candidates: ${snap.size}`);
      snap.docs.slice(0, 100).forEach((d) => {
        console.log(`[DRY-RUN] ${group} → ${d.ref.path}`);
      });
      if (snap.size > 100) {
        console.log(`[DRY-RUN] ${group} → ...and ${snap.size - 100} more`);
      }
    };

    await Promise.all(
      ['problems', 'issues', 'tasks'].map((g) => collect(g as any))
    );
    return;
  }
);

/* =========================================
 *  （任意）将来用：サーバエクスポートの骨子（既存）
 * ========================================= */

export const exportProjectCallable = onCall(async (request) => {
  const projectId = String(request.data?.projectId ?? '');
  if (!projectId) {
    const { HttpsError } = require('firebase-functions/v2/https');
    throw new HttpsError('invalid-argument', 'projectId is required');
  }
  return { ok: true, projectId };
});


