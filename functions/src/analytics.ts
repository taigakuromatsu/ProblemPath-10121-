import { getFirestore } from "firebase-admin/firestore";
// @ts-ignore
import { onCall, HttpsError } from "firebase-functions/v2/https";
// @ts-ignore
import type { CallableRequest } from "firebase-functions/v2/https";
// @ts-ignore
import { onSchedule } from "firebase-functions/v2/scheduler";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_TIME_ZONE = "Asia/Tokyo";

type QueryDocumentSnapshotLike = {
  id: string;
  data(): Record<string, any>;
  get(fieldPath: string): any;
  ref: {
    collection: (path: string) => { get(): Promise<{ docs: QueryDocumentSnapshotLike[] }> };
    delete(): Promise<void>;
  };
};

// ==== i18n方針 ====
// Firestore には翻訳済みの文言を保存しない。
// 「翻訳キー」を保存し、クライアントで ngx-translate によって表示言語へ変換する。
const statusLabelKey = (status: string) => `status.${status}`;

// 既知ステータス → 翻訳キー
const KNOWN_STATUSES: Array<{ value: string; label: string }> = [
  { value: "not_started", label: statusLabelKey("not_started") },
  { value: "in_progress", label: statusLabelKey("in_progress") },
  { value: "done",        label: statusLabelKey("done") },
];

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && typeof (value as any)?.toDate === "function") {
    try {
      const converted = (value as { toDate: () => Date }).toDate();
      if (converted instanceof Date && !isNaN(converted.getTime())) {
        return converted;
      }
    } catch (err) {
      console.warn("[analytics] Failed to convert value via toDate", err);
    }
  }
  if (typeof value === "number") {
    const asDate = new Date(value);
    return isNaN(asDate.getTime()) ? null : asDate;
  }
  if (typeof value === "string") {
    const asDate = new Date(value);
    return isNaN(asDate.getTime()) ? null : asDate;
  }
  return null;
};

const formatYmdUtc = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatYmdInTimeZone = (date: Date, timeZone: string): string => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

const parseYmdToUtcDate = (ymd: string): Date => {
  const [yearStr, monthStr, dayStr] = ymd.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  return new Date(Date.UTC(year, month - 1, day));
};

type Agg = {
  statusCounts: Record<string, number>;
  completedTasksCount: number;
  completedTasks7d: number;
  hasCompletedAt: boolean;
  leadTimes: number[];
  dueWindowTaskCount: number;
  overdueInWindowCount: number;
  completedTaskTitlesThisWeek: Set<string>; // ★ 今週完了タスク名（JST週）
};

const ensureAgg = (map: Map<string, Agg>, key: string): Agg => {
  if (!map.has(key)) {
    map.set(key, {
      statusCounts: {},
      completedTasksCount: 0,
      completedTasks7d: 0,
      hasCompletedAt: false,
      leadTimes: [],
      dueWindowTaskCount: 0,
      overdueInWindowCount: 0,
      completedTaskTitlesThisWeek: new Set<string>(),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return map.get(key)!;
};

export const computeAndWriteAnalytics = async (projectId: string) => {
  const firestore = getFirestore();
  const tasksSnapshot = await firestore
    .collectionGroup("tasks")
    .where("projectId", "==", projectId)
    .get();

  // 親の状態をキャッシュして無駄な読み取りを減らす
  const problemActiveCache = new Map<string, boolean>();
  const issueActiveCache = new Map<string, boolean>();

  const isProblemActive = async (problemId: string): Promise<boolean> => {
    const key = `${projectId}:${problemId}`;
    if (problemActiveCache.has(key)) return !!problemActiveCache.get(key);

    try {
      const snap = await firestore
        .doc(`projects/${projectId}/problems/${problemId}`)
        .get();

      if (!snap.exists) {
        problemActiveCache.set(key, false);
      } else {
        const d = snap.data() ?? {};
        // ツリーと同じ条件: softDeleted/visible=false は除外
        problemActiveCache.set(key, !d.softDeleted && d.visible !== false);
      }
    } catch {
      problemActiveCache.set(key, false);
    }
    return !!problemActiveCache.get(key);
  };

  const isIssueActive = async (problemId: string, issueId: string): Promise<boolean> => {
    const key = `${projectId}:${problemId}:${issueId}`;
    if (issueActiveCache.has(key)) return !!issueActiveCache.get(key);

    try {
      const snap = await firestore
        .doc(`projects/${projectId}/problems/${problemId}/issues/${issueId}`)
        .get();

      if (!snap.exists) {
        issueActiveCache.set(key, false);
      } else {
        const d = snap.data() ?? {};
        issueActiveCache.set(key, !d.softDeleted && d.visible !== false);
      }
    } catch {
      issueActiveCache.set(key, false);
    }
    return !!issueActiveCache.get(key);
  };

  const shouldCountTask = async (doc: QueryDocumentSnapshotLike, data: any): Promise<boolean> => {
    // タスク自身の条件
    if (data.softDeleted) return false;
    if (data.visible === false) return false;
    if (data.recurrenceTemplate) return false; // 繰り返しテンプレートは数えない

    // problemId / issueId はフィールドにあれば優先、なければパスから拾う
    let problemId = typeof data.problemId === "string" ? data.problemId : undefined;
    let issueId   = typeof data.issueId === "string" ? data.issueId : undefined;

    const path = (doc as any)?.ref?.path as string | undefined;
    if (path) {
      const segs = path.split("/");
      const pIndex = segs.indexOf("problems");
      const iIndex = segs.indexOf("issues");
      if (!problemId && pIndex >= 0 && segs[pIndex + 1]) {
        problemId = segs[pIndex + 1];
      }
      if (!issueId && iIndex >= 0 && segs[iIndex + 1]) {
        issueId = segs[iIndex + 1];
      }
    }

    // Problem 階層にぶら下がっていない（構造不正 or 古いゴミ）は除外
    if (!problemId) return false;

    if (!(await isProblemActive(problemId))) return false;
    if (issueId && !(await isIssueActive(problemId, issueId))) return false;

    return true;
  };

  // プロジェクト全体用
  const statusCounts: Record<string, number> = {};
  let completedTasksCount = 0;
  let completedTasks7d = 0;
  let hasCompletedAt = false;
  const leadTimes: number[] = [];
  let dueWindowTaskCount = 0;
  let overdueInWindowCount = 0;
  const completedTaskTitlesThisWeek = new Set<string>(); // ★ 週次成果用

  // 個人集計（uid -> Agg）
  const byUser = new Map<string, Agg>();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_IN_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_IN_MS);

  // JST基準 Mon–Sun の週
  const todayYmd = formatYmdInTimeZone(now, ANALYTICS_TIME_ZONE);
  const todayUtcDate = parseYmdToUtcDate(todayYmd);
  const dayOfWeek = todayUtcDate.getUTCDay(); // 0=Sun
  const diffFromMonday = (dayOfWeek + 6) % 7; // Mon=0
  const windowStartUtc = new Date(todayUtcDate.getTime() - diffFromMonday * DAY_IN_MS);
  const windowEndUtc = new Date(windowStartUtc.getTime() + 6 * DAY_IN_MS);
  const windowEndExclusiveUtc = new Date(windowEndUtc.getTime() + DAY_IN_MS); // [start, end+1day)
  const windowStartYmd = formatYmdUtc(windowStartUtc);
  const windowEndYmd = formatYmdUtc(windowEndUtc);

  for (const doc of tasksSnapshot.docs as QueryDocumentSnapshotLike[]) {
    const data = doc.data() ?? {};

    // 集計対象になるタスクかどうか判定
    const ok = await shouldCountTask(doc, data);
    if (!ok) continue;

    const status = (data.status as string) ?? "not_started";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    // ---- per-user 対象ユーザー抽出 ----
    const assignees: string[] = Array.isArray((data as any).assignees)
      ? (data as any).assignees
      : [];
    const userTargets = assignees.filter(Boolean);

    // ---- 完了系（全体）----
    if (status === "done") {
      completedTasksCount += 1;
      const completedAt = toDate((data as any).completedAt);
      if (completedAt) {
        hasCompletedAt = true;

        // 完了タスク (過去7日)
        if (completedAt >= sevenDaysAgo && completedAt <= now) {
          completedTasks7d += 1;
        }

        // リードタイム (30日内)
        if (completedAt >= thirtyDaysAgo && completedAt <= now) {
          const createdAt = toDate((data as any).createdAt);
          if (createdAt) {
            const leadTimeMs = completedAt.getTime() - createdAt.getTime();
            if (leadTimeMs >= 0) {
              leadTimes.push(leadTimeMs / DAY_IN_MS);
            }
          }
        }

        // ★ JST週内(Mon–Sun)に完了したタスク名を収集（プロジェクト全体）
        if (completedAt >= windowStartUtc && completedAt < windowEndExclusiveUtc) {
          const title = typeof data.title === "string" ? data.title.trim() : "";
          if (title) {
            completedTaskTitlesThisWeek.add(title);
          }
        }
      }
    }

    // ---- 週内遅延計算（全体）----
    const dueDateRaw = data.dueDate;
    if (typeof dueDateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)) {
      if (dueDateRaw >= windowStartYmd && dueDateRaw <= windowEndYmd) {
        dueWindowTaskCount += 1;
        if (status !== "done" && dueDateRaw < todayYmd) {
          overdueInWindowCount += 1;
        }
      }
    }

    // ===== 個人集計 =====
    for (const uid of userTargets) {
      const agg = ensureAgg(byUser, uid);

      // ステータスカウント
      agg.statusCounts[status] = (agg.statusCounts[status] ?? 0) + 1;

      // 完了タスク（個人）
      if (status === "done") {
        agg.completedTasksCount += 1;
        const completedAt = toDate((data as any).completedAt);
        if (completedAt) {
          agg.hasCompletedAt = true;

          // 完了タスク (過去7日・個人)
          if (completedAt >= sevenDaysAgo && completedAt <= now) {
            agg.completedTasks7d += 1;
          }

          // リードタイム (30日内・個人)
          if (completedAt >= thirtyDaysAgo && completedAt <= now) {
            const createdAt = toDate((data as any).createdAt);
            if (createdAt) {
              const leadTimeMs = completedAt.getTime() - createdAt.getTime();
              if (leadTimeMs >= 0) {
                agg.leadTimes.push(leadTimeMs / DAY_IN_MS);
              }
            }
          }

          // ★ JST週内に完了した個人タスク名
          if (completedAt >= windowStartUtc && completedAt < windowEndExclusiveUtc) {
            const title = typeof data.title === "string" ? data.title.trim() : "";
            if (title) {
              agg.completedTaskTitlesThisWeek.add(title);
            }
          }
        }
      }

      // 週内遅延（個人）
      if (typeof dueDateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)) {
        if (dueDateRaw >= windowStartYmd && dueDateRaw <= windowEndYmd) {
          agg.dueWindowTaskCount += 1;
          if (status !== "done" && dueDateRaw < todayYmd) {
            agg.overdueInWindowCount += 1;
          }
        }
      }
    }
  }

  // ステータス内訳（全体）：翻訳キーを保存
  const statusBreakdownMap = new Map<string, { label: string; count: number }>();
  KNOWN_STATUSES.forEach(({ value, label }) => {
    statusBreakdownMap.set(value, { label, count: statusCounts[value] ?? 0 });
  });
  Object.entries(statusCounts).forEach(([status, count]) => {
    if (!statusBreakdownMap.has(status)) {
      statusBreakdownMap.set(status, { label: statusLabelKey(status), count });
    }
  });
  const statusBreakdown = Array.from(statusBreakdownMap.values());

  if (!hasCompletedAt) {
    // completedAt 未導入プロジェクト向けフォールバック
    completedTasks7d = completedTasksCount;
  }

  const avgLeadTime30dDays =
    leadTimes.length === 0
      ? 0
      : Math.round(
          (leadTimes.reduce((s, d) => s + d, 0) / leadTimes.length) * 10
        ) / 10;

  const lateRateThisWeekPercent =
    dueWindowTaskCount === 0
      ? 0
      : Math.round(
          ((overdueInWindowCount / dueWindowTaskCount) * 100) * 10
        ) / 10;

    // Problem別進捗（削除/非表示 Problem は除外）
    const problemsSnapshot = await firestore
    .collection(`projects/${projectId}/problems`)
    .get();

  const activeProblemDocs = problemsSnapshot.docs.filter((problemDoc: QueryDocumentSnapshotLike) => {
    const data = problemDoc.data() ?? {};
    // UI と揃える:
    // - softDeleted が true のものは除外
    // - visible フィールドが false のものは除外
    if (data.softDeleted) return false;
    if (data.visible === false) return false;
    return true;
  });

  const problemProgress = await Promise.all(
    activeProblemDocs.map(async (problemDoc: QueryDocumentSnapshotLike) => {
      const issuesSnap = await problemDoc.ref.collection("issues").get();
      let progressSum = 0;
      let progressCount = 0;

      for (const issueDoc of issuesSnap.docs as QueryDocumentSnapshotLike[]) {
        const tasksSnap = await issueDoc.ref.collection("tasks").get();
        for (const taskDoc of tasksSnap.docs as QueryDocumentSnapshotLike[]) {
          const data = taskDoc.data() ?? {};
          if (data.softDeleted) continue; // ←既存のまま維持

          let p = data.progress;
          if (
            typeof p !== "number" ||
            isNaN(p) ||
            p < 0 ||
            p > 100
          ) {
            const st = (data.status as string) ?? "not_started";
            if (st === "done") p = 100;
            else if (st === "in_progress") p = 50;
            else p = 0;
          }

          progressSum += p;
          progressCount += 1;
        }
      }

      const avgProgress =
        progressCount === 0 ? 0 : progressSum / progressCount;
      const percent = Math.round(avgProgress);
      const rawTitle = (problemDoc.get("title") as string) ?? "";
      const title = rawTitle.trim();

      // タイトル空っぽのゴミデータは念のため弾く
      if (!title && percent === 0) {
        return null;
      }

      return { title, percent };
    })
  );

  // null を除外
  const normalizedProblemProgress = problemProgress.filter(
    (x): x is { title: string; percent: number } => !!x
  );


  // 書き込み（全体）
  const summaryRef = firestore.doc(
    `projects/${projectId}/analytics/currentSummary`
  );
  await summaryRef.set(
    {
      completedTasks7d,
      avgLeadTime30dDays,
      lateRateThisWeekPercent,
      statusBreakdown, // ← label は翻訳キー
      problemProgress: normalizedProblemProgress,
      // ★ 今週完了タスク名（週次レポートの「主な成果」用）
      completedTaskTitlesThisWeek: Array.from(
        completedTaskTitlesThisWeek
      ).slice(0, 50),
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  // === per-user 書き込み ===
  const userWrites = Array.from(byUser.entries()).map(
    async ([uid, agg]) => {
      const perMap = new Map<string, { label: string; count: number }>();
      KNOWN_STATUSES.forEach(({ value, label }) => {
        perMap.set(value, {
          label,
          count: agg.statusCounts[value] ?? 0,
        });
      });
      Object.entries(agg.statusCounts).forEach(([st, c]) => {
        if (!perMap.has(st)) {
          perMap.set(st, { label: statusLabelKey(st), count: c });
        }
      });
      const perStatus = Array.from(perMap.values());

      if (!agg.hasCompletedAt) {
        agg.completedTasks7d = agg.completedTasksCount;
      }

      const myLead =
        agg.leadTimes.length === 0
          ? 0
          : Math.round(
              (agg.leadTimes.reduce((s, d) => s + d, 0) /
                agg.leadTimes.length) *
                10
            ) / 10;

      const myLate =
        agg.dueWindowTaskCount === 0
          ? 0
          : Math.round(
              ((agg.overdueInWindowCount /
                agg.dueWindowTaskCount) *
                100) *
                10
            ) / 10;

      const ref = firestore.doc(
        `projects/${projectId}/analyticsPerUser/${uid}`
      );
      await ref.set(
        {
          completedTasks7d: agg.completedTasks7d,
          avgLeadTime30dDays: myLead,
          lateRateThisWeekPercent: myLate,
          statusBreakdown: perStatus, // ← label は翻訳キー
          // ★ 個人の今週完了タスク名
          completedTaskTitlesThisWeek: Array.from(
            agg.completedTaskTitlesThisWeek
          ).slice(0, 50),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    }
  );

  await Promise.all(userWrites);
  const perUserColRef = firestore.collection(
    `projects/${projectId}/analyticsPerUser`
  );
  const existingPerUserSnap = await perUserColRef.get();

  const cleanupWrites: Promise<unknown>[] = [];

  existingPerUserSnap.forEach((docSnap: QueryDocumentSnapshotLike) => {
    const uid = docSnap.id;
    if (!byUser.has(uid)) {
      // 全タスクが無くなった / 担当でなくなったユーザー
      // → ドキュメント削除（フロントは EMPTY_MY にフォールバックする）
      cleanupWrites.push(docSnap.ref.delete());
    }
  });

  if (cleanupWrites.length > 0) {
    await Promise.all(cleanupWrites);
  }
};

// Callable
type RequestData = { projectId: string };

export const refreshAnalyticsSummaryV2 = onCall<
  RequestData,
  { ok: boolean }
>(
  { region: "asia-northeast1" },
  async (request: { data: RequestData }) => {
    const { projectId } = request.data ?? {};
    if (!projectId) {
      throw new HttpsError(
        "invalid-argument",
        "projectId is required"
      );
    }
    try {
      await computeAndWriteAnalytics(projectId);
      return { ok: true };
    } catch (err) {
      console.error(
        "[analytics] manual refresh failed",
        projectId,
        err
      );
      throw new HttpsError(
        "internal",
        "Failed to refresh analytics"
      );
    }
  }
);

export const refreshAllAnalyticsSummaries = onSchedule(
  { schedule: "every 1 hours", timeZone: "Asia/Tokyo" },
  async () => {
    const firestore = getFirestore();
    const projectsSnapshot = await firestore
      .collection("projects")
      .get();
    for (const projectDoc of projectsSnapshot.docs) {
      const projectId = projectDoc.id;
      await computeAndWriteAnalytics(projectId);
    }
  }
);


