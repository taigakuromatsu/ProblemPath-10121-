import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { addDays, compareDate, formatYmd, getJstToday, parseYmdToUtc } from './time';

type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY';

type RecurrenceRule = {
  freq: RecurrenceFreq;
  interval?: number;
};

type Occurrence = {
  dueDate: string;
  index: number;
};

const firestore = getFirestore();
const HORIZON_DAYS = 30;
const MAX_ITERATIONS = 5000;

export const generateRecurringTasks = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'Asia/Tokyo',
  },
  async () => {
    const rangeStart = getJstToday();
    const rangeEnd = addDays(rangeStart, HORIZON_DAYS);
    const from = formatYmd(rangeStart);
    const to = formatYmd(rangeEnd);

    console.log('[recurrence] start', JSON.stringify({ from, to }));

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
        const parent = parentDoc.data() ?? {};
        const rule: RecurrenceRule | null = parent.recurrenceRule ?? null;
        const anchorYmd: string | null = parent.recurrenceAnchorDate ?? parent.dueDate ?? null;

        if (!rule || !anchorYmd) {
          console.warn('[recurrence] skip parent - missing rule/anchor', parentDoc.ref.path);
          continue;
        }

        const occurrences = generateOccurrences(rule, anchorYmd, rangeStart, rangeEnd);
        if (!occurrences.length) {
          continue;
        }

        const pathInfo = extractPath(parentDoc.ref.path);
        const projectId: string | undefined = parent.projectId ?? pathInfo.projectId;
        const problemId: string | undefined = parent.problemId ?? pathInfo.problemId;
        const issueId: string | undefined = parent.issueId ?? pathInfo.issueId;

        if (!projectId || !problemId || !issueId) {
          console.warn('[recurrence] skip parent - missing ids', parentDoc.ref.path);
          continue;
        }

        let createdForParent = 0;
        for (const occurrence of occurrences) {
          const lockId = `${parentDoc.id}_${occurrence.dueDate}`;
          const lockRef = firestore.doc(`projects/${projectId}/recurrenceLocks/${lockId}`);
          const childCollection = parentDoc.ref.parent;

          const created = await firestore
            .runTransaction(async tx => {
              const lockSnap = await tx.get(lockRef);
              if (lockSnap.exists) {
                return false;
              }

              const childRef = childCollection.doc();
              const payload = buildChildPayload({
                parent,
                parentId: parentDoc.id,
                projectId,
                problemId,
                issueId,
                occurrence,
                anchorYmd,
              });

              tx.create(childRef, payload);
              tx.create(lockRef, {
                parentId: parentDoc.id,
                dueDate: occurrence.dueDate,
                recurrenceInstanceIndex: occurrence.index,
                createdAt: FieldValue.serverTimestamp(),
              });
              return true;
            })
            .catch(err => {
              console.error('[recurrence] transaction error', parentDoc.ref.path, occurrence, err);
              return false;
            });

          if (created) {
            createdForParent += 1;
            createdTotal += 1;
          }
        }

        console.log(
          '[recurrence] parent processed',
          JSON.stringify({
            parentId: parentDoc.id,
            projectId,
            issueId,
            created: createdForParent,
            occurrences: occurrences.length,
            range: { from, to },
          })
        );
      } catch (err) {
        console.error('[recurrence] parent error', parentDoc.ref.path, err);
      }
    }

    console.log('[recurrence] complete', JSON.stringify({ processed, createdTotal, from, to }));
  }
);

function generateOccurrences(
  rule: RecurrenceRule,
  anchorYmd: string,
  rangeStart: Date,
  rangeEnd: Date
): Occurrence[] {
  const anchorDate = parseYmdToUtc(anchorYmd);
  if (!anchorDate) return [];

  const interval = Math.max(1, Number(rule.interval ?? 1));
  const anchorDay = anchorDate.getUTCDate();
  let current = anchorDate;
  let index = 0;
  const occurrences: Occurrence[] = [];
  let guard = 0;

  while (compareDate(current, rangeStart) < 0 && guard < MAX_ITERATIONS) {
    current = advance(current, rule.freq, interval, anchorDay);
    index += 1;
    guard += 1;
  }
  if (guard >= MAX_ITERATIONS) return [];

  guard = 0;
  while (compareDate(current, rangeEnd) <= 0 && guard < MAX_ITERATIONS) {
    occurrences.push({ dueDate: formatYmd(current), index });
    current = advance(current, rule.freq, interval, anchorDay);
    index += 1;
    guard += 1;
  }

  return occurrences;
}

function advance(base: Date, freq: RecurrenceFreq, interval: number, anchorDay: number): Date {
  if (freq === 'DAILY') {
    return addDays(base, interval);
  }
  if (freq === 'WEEKLY') {
    return addDays(base, interval * 7);
  }
  return addMonthsKeepingDay(base, interval, anchorDay);
}

function addMonthsKeepingDay(base: Date, months: number, anchorDay: number): Date {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, lastDay);
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
  parent: DocumentData;
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
    recurrenceRule: null,
    recurrenceTemplate: false,
    recurrenceParentId: parentId,
    recurrenceInstanceIndex: occurrence.index,
    recurrenceAnchorDate: anchorYmd,
    projectId,
    problemId,
    issueId,
    softDeleted: false,
  };
}
