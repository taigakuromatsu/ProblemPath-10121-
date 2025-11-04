// functions/src/recurrence.ts
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { addDays, compareDate, formatYmd, getJstToday, parseYmdToUtc } from './time';

type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY';
type RecurrenceRule = { freq: RecurrenceFreq; interval?: number };
type Occurrence = { dueDate: string; index: number };

// --- Admin 初期化 ---
if (!getApps().length) initializeApp();
const firestore = getFirestore();

const MAX_ITERATIONS = 5000;

/**
 * 00:05 JST に1日1回起動。
 * 生成タイミング規則:
 * - DAILY: 「期限日の前日」に該当 occurrence を作成
 * - WEEKLY: 「前回期限日の翌日」に次回を作成（例: 11/04 が期限 → 11/05 に次回(11/11 期限)を作成）
 * - MONTHLY(間隔 ≤ 6): 「前回期限日の翌日」に次回を作成
 * - MONTHLY(間隔 ≥ 7): 「次回期限日の 6 ヶ月前」に作成
 */
export const generateRecurringTasks = onSchedule(
  { schedule: '5 0 * * *', timeZone: 'Asia/Tokyo' },
  async () => {
    const today = getJstToday();
    const todayYmd = formatYmd(today);

    console.log('[recurrence] start', JSON.stringify({ today: todayYmd }));

    const parentsSnap = await firestore
      .collectionGroup('tasks')
      .where('recurrenceTemplate', '==', true)
      .where('softDeleted', '==', false)
      .get();

    let processed = 0;
    let createdTotal = 0;

    for (const parentDoc of parentsSnap.docs) {
      processed += 1;
      try {
        const parent = (parentDoc.data() ?? {}) as FirebaseFirestore.DocumentData;
        const rule = (parent.recurrenceRule ?? null) as RecurrenceRule | null;
        const anchorYmd = (parent.recurrenceAnchorDate ?? parent.dueDate ?? null) as string | null;

        if (!rule || !anchorYmd) {
          console.warn('[recurrence] skip parent - missing rule/anchor', parentDoc.ref.path);
          continue;
        }

        if (!parseYmdToUtc(anchorYmd)) {
          console.warn('[recurrence] skip parent - bad anchor date', parentDoc.ref.path, anchorYmd);
          continue;
        }

        let endYmd = (parent.recurrenceEndDate ?? null) as string | null;
        if (endYmd && !parseYmdToUtc(endYmd)) {
          console.warn('[recurrence] ignore bad end date', parentDoc.ref.path, endYmd);
          endYmd = null;
        }

        const occurrences = generateOccurrences(rule, anchorYmd, today, today, endYmd);
        if (!occurrences.length) {
          continue;
        }

        // パス情報（projectId / problemId / issueId）
        const pathInfo = extractPath(parentDoc.ref.path);
        const projectId = (parent.projectId ?? pathInfo.projectId) as string | undefined;
        const problemId = (parent.problemId ?? pathInfo.problemId) as string | undefined;
        const issueId = (parent.issueId ?? pathInfo.issueId) as string | undefined;

        if (!projectId || !problemId || !issueId) {
          console.warn('[recurrence] skip parent - missing ids', parentDoc.ref.path);
          continue;
        }

        for (const occ of occurrences) {
          // ロック + 子作成（冪等）
          const lockId = `${parentDoc.id}_${occ.dueDate}`;
          const lockRef = firestore.doc(`projects/${projectId}/recurrenceLocks/${lockId}`);
          const childCollection = parentDoc.ref.parent;

          const created = await firestore
            .runTransaction(async (tx: FirebaseFirestore.Transaction) => {
              const lockSnap = await tx.get(lockRef) as unknown as FirebaseFirestore.DocumentSnapshot;
              if (lockSnap.exists) return false;

              const childRef = childCollection.doc();
              const payload = buildChildPayload({
                parent,
                parentId: parentDoc.id,
                projectId,
                problemId,
                issueId,
                occurrence: occ,
                anchorYmd,
              });

              tx.create(childRef, payload);
              tx.create(lockRef, {
                parentId: parentDoc.id,
                dueDate: occ.dueDate,
                recurrenceInstanceIndex: occ.index,
                createdAt: FieldValue.serverTimestamp(),
              });
              return true;
            })
            .catch((err: unknown) => {
              console.error('[recurrence] transaction error', parentDoc.ref.path, occ, err);
              return false;
            });

          if (created) {
            createdTotal += 1;
            console.log(
              '[recurrence] created',
              JSON.stringify({
                parentId: parentDoc.id,
                projectId,
                issueId,
                dueDate: occ.dueDate,
                index: occ.index,
              }),
            );
          }
        }
      } catch (err: unknown) {
        console.error('[recurrence] parent error', parentDoc.ref.path, err);
      }
    }

    console.log('[recurrence] complete', JSON.stringify({ processed, createdTotal, today: todayYmd }));
  },
);

function generateOccurrences(
  rule: RecurrenceRule,
  anchorYmd: string,
  rangeStart: Date,
  rangeEnd: Date,
  endYmd: string | null,
): Occurrence[] {
  const anchorDate = parseYmdToUtc(anchorYmd);
  if (!anchorDate) return [];

  const endDate = endYmd ? parseYmdToUtc(endYmd) : null;
  const interval = Math.max(1, Number(rule.interval ?? 1));
  const anchorDay = anchorDate.getUTCDate();

  const occurrences: Occurrence[] = [];
  let current = anchorDate;
  let index = 0;
  let prevDue: Date | null = null;
  let guard = 0;

  while (guard < MAX_ITERATIONS) {
    if (endDate && compareDate(current, endDate) > 0) break;

    const creationDate = creationDateFor(rule, interval, current, prevDue, anchorDay);
    if (creationDate) {
      if (compareDate(creationDate, rangeEnd) > 0) break;
      if (compareDate(creationDate, rangeStart) >= 0) {
        occurrences.push({ dueDate: formatYmd(current), index });
      }
    }

    prevDue = current;
    const next = advance(rule, interval, current, anchorDay);
    if (compareDate(next, current) <= 0) break;
    current = next;
    index += 1;
    guard += 1;
  }

  return occurrences;
}

function creationDateFor(
  rule: RecurrenceRule,
  interval: number,
  due: Date,
  prevDue: Date | null,
  anchorDay: number,
): Date | null {
  if (rule.freq === 'DAILY') {
    return addDays(due, -1);
  }

  if (rule.freq === 'WEEKLY') {
    if (!prevDue) return null;
    return addDays(prevDue, 1);
  }

  if (rule.freq === 'MONTHLY') {
    if (interval <= 6) {
      if (!prevDue) return null;
      return addDays(prevDue, 1);
    }
    return subMonthsKeepingDay(due, 6);
  }

  return null;
}

function advance(
  rule: RecurrenceRule,
  interval: number,
  base: Date,
  anchorDay: number,
): Date {
  if (rule.freq === 'DAILY') {
    return addDays(base, interval);
  }
  if (rule.freq === 'WEEKLY') {
    return addDays(base, 7 * interval);
  }
  if (rule.freq === 'MONTHLY') {
    return addMonthsKeepingDay(base, interval, anchorDay);
  }
  return addDays(base, interval);
}

/** 月加算（アンカー日の“日付”をできるだけ維持、存在しない日は月末に丸め） */
function addMonthsKeepingDay(base: Date, months: number, anchorDay: number): Date {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, lastDay);
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
}

/** due の“日付”に合わせて 6ヶ月戻す（＝次回 due と同じ丸めルールで半年前を取る） */
function subMonthsKeepingDay(base: Date, months: number): Date {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const baseDay = base.getUTCDate(); // due 自体の「日」を基準にする
  const target = new Date(Date.UTC(year, month - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(baseDay, lastDay);
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
}

function extractPath(path: string) {
  const segments = path.split('/');
  const projectIndex = segments.indexOf('projects');
  const problemIndex = segments.indexOf('problems');
  const issueIndex = segments.indexOf('issues');
  return {
    projectId: projectIndex >= 0 ? segments[projectIndex + 1] : undefined,
    problemId: problemIndex >= 0 ? segments[problemIndex + 1] : undefined,
    issueId: issueIndex >= 0 ? segments[issueIndex + 1] : undefined,
  };
}

function buildChildPayload(args: {
  parent: FirebaseFirestore.DocumentData;
  parentId: string;
  projectId: string;
  problemId: string;
  issueId: string;
  occurrence: Occurrence;
  anchorYmd: string;
}) {
  const { parent, parentId, projectId, problemId, issueId, occurrence, anchorYmd } = args;
  const baseOrder = Number(parent.order ?? Date.now());
  const order = Number.isFinite(baseOrder)
    ? baseOrder + (occurrence.index + 1) / 1000
    : Date.now() + (occurrence.index + 1) / 1000;

  return {
    title: parent.title ?? 'Untitled Task',
    description: parent.description ?? '',
    status: 'not_started',
    progress: 0,
    boardColumnId: parent.boardColumnId ?? null,
    tags: Array.isArray(parent.tags) ? parent.tags : [],
    assignees: Array.isArray(parent.assignees) ? parent.assignees : [],
    order,
    dueDate: occurrence.dueDate,
    priority: parent.priority ?? 'mid',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    // 子はテンプレートではない
    recurrenceRule: null,
    recurrenceTemplate: false,
    // 親テンプレート情報
    recurrenceParentId: parentId,
    recurrenceInstanceIndex: occurrence.index,
    recurrenceAnchorDate: anchorYmd,
    // 所属
    projectId,
    problemId,
    issueId,
    softDeleted: false,
  };
}



