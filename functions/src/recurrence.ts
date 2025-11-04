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
 * - DAILY: 「前回期限日の翌日」= 次回タスクの期限日当日の 00:05 に作成（＝当日分を作成）
 * - WEEKLY: 「前回期限日の翌日」に次回を作成（例: 11/04 が期限 → 11/05 00:05 に次回(11/11 期限)を作成）
 * - MONTHLY(間隔 ≤ 6): 「前回期限日の翌日」に次回を作成
 * - MONTHLY(間隔 ≥ 7): 「次回期限日の 6 ヶ月前」に作成
 */
export const generateRecurringTasks = onSchedule(
  { schedule: '5 0 * * *', timeZone: 'Asia/Tokyo' },
  async () => {
    const today = getJstToday();
    const yesterday = addDays(today, -1);
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

        const anchorDate = parseYmdToUtc(anchorYmd);
        if (!anchorDate) {
          console.warn('[recurrence] skip parent - bad anchor date', parentDoc.ref.path, anchorYmd);
          continue;
        }

        const interval = Math.max(1, Number(rule.interval ?? 1));
        const anchorDay = anchorDate.getUTCDate();

        // 生成すべき Occurrence を規則に応じて 0〜1 件だけ算出
        const occ = decideOccurrenceToCreateToday({ rule, interval, anchorDate, anchorDay, today, yesterday });
        if (!occ) {
          // 今日は生成なし
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
      } catch (err: unknown) {
        console.error('[recurrence] parent error', parentDoc.ref.path, err);
      }
    }

    console.log('[recurrence] complete', JSON.stringify({ processed, createdTotal, today: todayYmd }));
  },
);

/** ルール別に「今日作るべき」Occurrence を 0〜1件返す */
function decideOccurrenceToCreateToday(args: {
  rule: RecurrenceRule;
  interval: number;
  anchorDate: Date;
  anchorDay: number;
  today: Date;
  yesterday: Date;
}): Occurrence | null {
  const { rule, interval, anchorDate, anchorDay, today, yesterday } = args;
  const todayYmd = formatYmd(today);

  // DAILY: 当日分を作る（= dueDate が今日）
  if (rule.freq === 'DAILY') {
    // anchor から今日まで日数を進めて index 計算
    const { hit, index } = reachExact(anchorDate, today, d => addDays(d, interval));
    if (!hit) return null;
    return { dueDate: todayYmd, index };
  }

  // WEEKLY: 「前回期限日の翌日」に次回を作る
  if (rule.freq === 'WEEKLY') {
    // 昨日がちょうどスケジュール日だったら、次（+7*interval日）を作る
    const prev = findLastDueOnOrBefore(anchorDate, yesterday, d => addDays(d, 7 * interval));
    if (!prev || compareDate(prev.date, yesterday) !== 0) return null;
    const next = addDays(prev.date, 7 * interval);
    return { dueDate: formatYmd(next), index: prev.index + 1 };
  }

  // MONTHLY: 間隔で分岐
  if (rule.freq === 'MONTHLY') {
    if (interval <= 6) {
      // 「前回期限日の翌日」に次回を作る
      const prev = findLastDueOnOrBefore(anchorDate, yesterday, d => addMonthsKeepingDay(d, interval, anchorDay));
      if (!prev || compareDate(prev.date, yesterday) !== 0) return null;
      const next = addMonthsKeepingDay(prev.date, interval, anchorDay);
      return { dueDate: formatYmd(next), index: prev.index + 1 };
    } else {
      // 「次回期限日の 6 ヶ月前」に作る
      // current（= 候補の due）を anchor から進めつつ、(due - 6ヶ月) が今日と一致するものを探す
      let current = new Date(anchorDate);
      let idx = 0;
      let guard = 0;
      while (guard < MAX_ITERATIONS) {
        const creationDate = subMonthsKeepingDay(current, 6);
        const cmp = compareDate(creationDate, today);
        if (cmp === 0) {
          return { dueDate: formatYmd(current), index: idx };
        }
        if (cmp > 0) {
          // これ以上進めても creationDate は将来になるため終了
          return null;
        }
        current = addMonthsKeepingDay(current, interval, anchorDay);
        idx += 1;
        guard += 1;
      }
      return null;
    }
  }

  return null;
}

/** anchor から step で target にちょうど一致できるか探索（index も返す） */
function reachExact(
  anchor: Date,
  target: Date,
  step: (d: Date) => Date,
): { hit: boolean; index: number } {
  if (compareDate(anchor, target) > 0) return { hit: false, index: 0 };
  let cur = anchor;
  let idx = 0;
  let guard = 0;
  while (compareDate(cur, target) < 0 && guard < MAX_ITERATIONS) {
    cur = step(cur);
    idx += 1;
    guard += 1;
  }
  return { hit: compareDate(cur, target) === 0, index: idx };
}

/** target 以下で最後のスケジュール日とその index を返す */
function findLastDueOnOrBefore(
  anchor: Date,
  target: Date,
  step: (d: Date) => Date,
): { date: Date; index: number } | null {
  if (compareDate(anchor, target) > 0) return null;
  let cur = anchor;
  let idx = 0;
  let guard = 0;
  while (true) {
    const next = step(cur);
    if (compareDate(next, target) > 0 || guard >= MAX_ITERATIONS) {
      return { date: cur, index: idx };
    }
    cur = next;
    idx += 1;
    guard += 1;
  }
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



