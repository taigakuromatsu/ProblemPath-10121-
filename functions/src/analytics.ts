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

type Agg = {
  statusCounts: Record<string, number>;
  completedTasksCount: number;
  completedTasks7d: number;
  hasCompletedAt: boolean;
  leadTimes: number[];
  dueWindowTaskCount: number;
  overdueInWindowCount: number;
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

  const knownStatuses: Array<{ value: string; label: string }> = [
    { value: "not_started", label: "未着手" },
    { value: "in_progress", label: "対応中" },
    { value: "done", label: "完了" },
  ];

  // プロジェクト全体用
  const statusCounts: Record<string, number> = {};
  let completedTasksCount = 0;
  let completedTasks7d = 0;
  let hasCompletedAt = false;
  const leadTimes: number[] = [];
  let dueWindowTaskCount = 0;
  let overdueInWindowCount = 0;

  // 個人集計（uid -> Agg）
  const byUser = new Map<string, Agg>();

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
    if (data.softDeleted) return;

    const status = (data.status as string) ?? "not_started";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    // ---- per-user 対象ユーザー抽出 ----
    const assignees: string[] = Array.isArray((data as any).assignees) ? (data as any).assignees : [];
    const userTargets = assignees.filter(Boolean);

    // ---- 完了系 ----
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

    // ---- 週内遅延計算 ----
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
      agg.statusCounts[status] = (agg.statusCounts[status] ?? 0) + 1;

      if (status === "done") {
        agg.completedTasksCount += 1;
        const completedAt = toDate((data as any).completedAt);
        if (completedAt) {
          agg.hasCompletedAt = true;
          if (completedAt >= sevenDaysAgo && completedAt <= now) {
            agg.completedTasks7d += 1;
          }
          if (completedAt >= thirtyDaysAgo && completedAt <= now) {
            const createdAt = toDate((data as any).createdAt);
            if (createdAt) {
              const leadTimeMs = completedAt.getTime() - createdAt.getTime();
              if (leadTimeMs >= 0) agg.leadTimes.push(leadTimeMs / DAY_IN_MS);
            }
          }
        }
      }

      if (typeof dueDateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)) {
        if (dueDateRaw >= windowStartYmd && dueDateRaw <= windowEndYmd) {
          agg.dueWindowTaskCount += 1;
          if (status !== "done" && dueDateRaw < todayYmd) {
            agg.overdueInWindowCount += 1;
          }
        }
      }
    }
  });

  // ステータス内訳（全体）
  const statusBreakdownMap = new Map<string, { label: string; count: number }>();
  knownStatuses.forEach(({ value, label }) => {
    if (!statusBreakdownMap.has(value)) {
      statusBreakdownMap.set(value, { label, count: statusCounts[value] ?? 0 });
    }
  });
  Object.entries(statusCounts).forEach(([status, count]) => {
    if (!statusBreakdownMap.has(status)) {
      statusBreakdownMap.set(status, { label: status, count });
    } else if (!knownStatuses.some((k) => k.value === status)) {
      statusBreakdownMap.set(status, { label: status, count });
    }
  });
  const statusBreakdown = Array.from(statusBreakdownMap.values());

  if (!hasCompletedAt) {
    completedTasks7d = completedTasksCount; // completedAt 未導入プロジェクト向けフォールバック
  }

  const avgLeadTime30dDays =
    leadTimes.length === 0 ? 0 : Math.round((leadTimes.reduce((s, d) => s + d, 0) / leadTimes.length) * 10) / 10;

  const lateRateThisWeekPercent =
    dueWindowTaskCount === 0 ? 0 : Math.round(((overdueInWindowCount / dueWindowTaskCount) * 100) * 10) / 10;

  // Problem別進捗（既存）
  const problemsSnapshot = await firestore.collection(`projects/${projectId}/problems`).get();
  const problemProgress = await Promise.all(
    problemsSnapshot.docs.map(async (problemDoc: QueryDocumentSnapshotLike) => {
      const issuesSnap = await problemDoc.ref.collection("issues").get();
      let progressSum = 0;
      let progressCount = 0;
      for (const issueDoc of issuesSnap.docs as QueryDocumentSnapshotLike[]) {
        const tasksSnap = await issueDoc.ref.collection("tasks").get();
        for (const taskDoc of tasksSnap.docs as QueryDocumentSnapshotLike[]) {
          const data = taskDoc.data() ?? {};
          if (data.softDeleted) continue;
          let p = data.progress;
          if (typeof p !== "number" || isNaN(p) || p < 0 || p > 100) {
            const st = (data.status as string) ?? "not_started";
            if (st === "done") p = 100;
            else if (st === "in_progress") p = 50;
            else p = 0;
          }
          progressSum += p;
          progressCount += 1;
        }
      }
      const avgProgress = progressCount === 0 ? 0 : (progressSum / progressCount);
      const percent = Math.round(avgProgress);
      const title = (problemDoc.get("title") as string) ?? "";
      return { title, percent };
    })
  );

  // 書き込み（全体）
  const summaryRef = firestore.doc(`projects/${projectId}/analytics/currentSummary`);
  await summaryRef.set(
    {
      completedTasks7d,
      avgLeadTime30dDays,
      lateRateThisWeekPercent,
      statusBreakdown,
      problemProgress,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  // === per-user 書き込み ===
  const userWrites = Array.from(byUser.entries()).map(async ([uid, agg]) => {
    // ステータス内訳
    const perMap = new Map<string, { label: string; count: number }>();
    knownStatuses.forEach(({ value, label }) => {
      perMap.set(value, { label, count: agg.statusCounts[value] ?? 0 });
    });
    Object.entries(agg.statusCounts).forEach(([st, c]) => {
      if (!perMap.has(st)) perMap.set(st, { label: st, count: c });
    });
    const perStatus = Array.from(perMap.values());

    if (!agg.hasCompletedAt) {
      agg.completedTasks7d = agg.completedTasksCount;
    }
    const myLead =
      agg.leadTimes.length === 0 ? 0 : Math.round((agg.leadTimes.reduce((s, d) => s + d, 0) / agg.leadTimes.length) * 10) / 10;

    const myLate =
      agg.dueWindowTaskCount === 0 ? 0 : Math.round(((agg.overdueInWindowCount / agg.dueWindowTaskCount) * 100) * 10) / 10;
      
    const ref = firestore.doc(`projects/${projectId}/analyticsPerUser/${uid}`);


    await ref.set(
      {
        completedTasks7d: agg.completedTasks7d,
        avgLeadTime30dDays: myLead,
        lateRateThisWeekPercent: myLate,
        statusBreakdown: perStatus,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  });

  await Promise.all(userWrites);
};

// Callable
type RequestData = { projectId: string };

export const refreshAnalyticsSummaryV2 = onCall<RequestData, { ok: boolean }>(
  { region: "asia-northeast1" },
  async (request: { data: RequestData }) => {
    const { projectId } = request.data ?? {};
    if (!projectId) {
      throw new HttpsError("invalid-argument", "projectId is required");
    }
    try {
      await computeAndWriteAnalytics(projectId);
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
    for (const projectDoc of projectsSnapshot.docs) {
      const projectId = projectDoc.id;
      await computeAndWriteAnalytics(projectId);
    }
  }
);
