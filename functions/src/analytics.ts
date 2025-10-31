import { getFirestore } from "firebase-admin/firestore";
// @ts-ignore - firebase-functions/v2/httpsの型定義の問題を回避
import { onCall, HttpsError } from "firebase-functions/v2/https";
// @ts-ignore
import type { CallableRequest } from "firebase-functions/v2/https";
// @ts-ignore - firebase-functions/v2/schedulerの型定義の問題を回避
import { onSchedule } from "firebase-functions/v2/scheduler";

// TODO: Firestore Security Rules では
// analytics/currentSummary へのwriteはFunctionsのみ許可、
// クライアントはreadのみ許可する予定。

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_TIME_ZONE = "Asia/Tokyo";

type QueryDocumentSnapshotLike = {
  data(): Record<string, any>;
  get(fieldPath: string): any;
  ref: { collection: (path: string) => { get(): Promise<{ docs: QueryDocumentSnapshotLike[] }> } };
};

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

export const computeAndWriteAnalytics = async (projectId: string) => {
  const firestore = getFirestore();
  // TODO: 各taskドキュメントに projectId フィールド前提。ただし存在しない場合は今後付与予定
  const tasksSnapshot = await firestore
    .collectionGroup("tasks")
    .where("projectId", "==", projectId)
    .get();

  const knownStatuses: Array<{ value: string; label: string }> = [
    { value: "not_started", label: "未着手" },
    { value: "in_progress", label: "対応中" },
    { value: "review_wait", label: "レビュー中" },
    { value: "fixing", label: "手直し" },
    { value: "review", label: "レビュー中" },
    { value: "done", label: "完了" },
  ];
  const statusCounts: Record<string, number> = {};
  let completedTasksCount = 0;
  let completedTasks7d = 0;
  let hasCompletedAt = false;
  const leadTimes: number[] = [];
  // TODO: completedAt が保存されるようになったら、リードタイム算出を厳密化する
  let dueWindowTaskCount = 0;
  let overdueInWindowCount = 0;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_IN_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_IN_MS);
  const todayYmd = formatYmdInTimeZone(now, ANALYTICS_TIME_ZONE);
  const todayUtcDate = parseYmdToUtcDate(todayYmd);
  const dayOfWeek = todayUtcDate.getUTCDay();
  const diffFromMonday = (dayOfWeek + 6) % 7;
  const windowStartUtc = new Date(todayUtcDate.getTime() - diffFromMonday * DAY_IN_MS);
  const windowEndUtc = new Date(windowStartUtc.getTime() + 6 * DAY_IN_MS);
  const windowStartYmd = formatYmdUtc(windowStartUtc);
  const windowEndYmd = formatYmdUtc(windowEndUtc);

  tasksSnapshot.forEach((doc: QueryDocumentSnapshotLike) => {
    const data = doc.data() ?? {};
    if (data.softDeleted) {
      return;
    }
    const status = (data.status as string) ?? "not_started";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === "done") {
      completedTasksCount += 1;
      const completedAt = toDate((data as any).completedAt);
      if (completedAt) {
        hasCompletedAt = true;
        if (completedAt >= sevenDaysAgo && completedAt <= now) {
          completedTasks7d += 1;
        }
        if (completedAt >= thirtyDaysAgo && completedAt <= now) {
          const createdAt = toDate((data as any).createdAt);
          if (createdAt) {
            const leadTimeMs = completedAt.getTime() - createdAt.getTime();
            if (leadTimeMs >= 0) {
              leadTimes.push(leadTimeMs / DAY_IN_MS);
            }
          }
        }
      }
    }

    const dueDateRaw = data.dueDate;
    if (typeof dueDateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)) {
      if (dueDateRaw >= windowStartYmd && dueDateRaw <= windowEndYmd) {
        dueWindowTaskCount += 1;
        if (status !== "done" && dueDateRaw < todayYmd) {
          overdueInWindowCount += 1;
        }
      }
    }
  });

  const statusBreakdownMap = new Map<string, { label: string; count: number }>();
  knownStatuses.forEach(({ value, label }) => {
    if (!statusBreakdownMap.has(value)) {
      statusBreakdownMap.set(value, { label, count: statusCounts[value] ?? 0 });
    }
  });

  Object.entries(statusCounts).forEach(([status, count]) => {
    if (!statusBreakdownMap.has(status)) {
      statusBreakdownMap.set(status, { label: status, count });
    } else if (!knownStatuses.some((known) => known.value === status)) {
      statusBreakdownMap.set(status, { label: status, count });
    }
  });

  const statusBreakdown = Array.from(statusBreakdownMap.values());

  if (!hasCompletedAt) {
    // TODO: completedAt 導入後に7日フィルタへ切り替える
    completedTasks7d = completedTasksCount;
  }

  const avgLeadTime30dDays = leadTimes.length === 0
    ? 0 // UI側には「30日以内の完了タスクが存在しない場合は 0」を想定してもらう
    : Math.round((leadTimes.reduce((sum, days) => sum + days, 0) / leadTimes.length) * 10) / 10;

  const lateRateThisWeekPercent = dueWindowTaskCount === 0
    ? 0
    : Math.round(((overdueInWindowCount / dueWindowTaskCount) * 100) * 10) / 10;

  const problemsSnapshot = await firestore
    .collection(`projects/${projectId}/problems`)
    .get();

  const problemProgress = await Promise.all(
    problemsSnapshot.docs.map(async (problemDoc: QueryDocumentSnapshotLike) => {
      // 1. この Problem の配下の Issue を全部読む
      const issuesSnap = await problemDoc.ref.collection("issues").get();

      let totalTasks = 0;
      let doneTasks = 0;

      // 2. 各 Issue の配下の tasks をすべて集計
      for (const issueDoc of issuesSnap.docs as QueryDocumentSnapshotLike[]) {
        const tasksSnap = await issueDoc.ref.collection("tasks").get();

        for (const taskDoc of tasksSnap.docs as QueryDocumentSnapshotLike[]) {
          const data = taskDoc.data() ?? {};
          if (data.softDeleted) continue;

          totalTasks += 1;

          const status = taskDoc.get("status");
          if (status === "done") {
            doneTasks += 1;
          }
        }
      }

      // 3. 完了率を算出
      const percent =
        totalTasks === 0
          ? 0
          : Math.round((doneTasks / totalTasks) * 100);

      const title = (problemDoc.get("title") as string) ?? "";

      return { title, percent };
    })
  );


  const summaryRef = firestore.doc(`projects/${projectId}/analytics/currentSummary`);
  await summaryRef.set(
    {
      completedTasks7d,
      // TODO: completedAt 導入後に正確な過去7日フィルタ/リードタイム計算へ切り替える
      avgLeadTime30dDays,
      lateRateThisWeekPercent,
      statusBreakdown,
      problemProgress,
      updatedAt: new Date().toISOString(),
      // TODO: 負荷とコスト次第で指標追加予定
    },
    { merge: true }
  );
};

// Callable Function: refresh analytics summary for a project.
type RequestData = { projectId: string };

export const refreshAnalyticsSummaryV2 = onCall<RequestData, { ok: boolean }>(
  { region: "asia-northeast1" },
  async (request: { data: RequestData }) => {
    const { projectId } = request.data ?? {};
    if (!projectId) {
      throw new HttpsError("invalid-argument", "projectId is required");
    }

    console.log("Refreshing analytics for", projectId);
    try {
      await computeAndWriteAnalytics(projectId);
      console.log("[analytics] manual refresh OK", projectId);
      return { ok: true };
    } catch (err) {
      console.error("[analytics] manual refresh failed", projectId, err);
      throw new HttpsError("internal", "Failed to refresh analytics");
    }
  }
);



export const refreshAllAnalyticsSummaries = onSchedule(
  { schedule: "every 1 hours", timeZone: "Asia/Tokyo" },
  async () => {
    const firestore = getFirestore();
    const projectsSnapshot = await firestore.collection("projects").get();
    // TODO: 将来的にはアクティブなプロジェクトだけに絞る
    for (const projectDoc of projectsSnapshot.docs) {
      const projectId = projectDoc.id;
      await computeAndWriteAnalytics(projectId);
    }
    // TODO: 課金・パフォーマンスを監視して間隔を調整する
  }
);
