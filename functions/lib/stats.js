"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateProjectStats = void 0;
// functions/src/stats.ts
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
if (admin.apps.length === 0) {
    admin.initializeApp();
}
const db = admin.firestore();
// 固定：まずは Tokyo。将来は projects/{pid}/meta.tz などで可変にしてもOK。
const TIMEZONE = 'Asia/Tokyo';
// "YYYY-MM-DD" を特定タイムゾーンで生成
function ymdInTZ(d, tz) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = fmt.formatToParts(d).reduce((acc, part) => {
        if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
            acc[part.type] = part.value;
        }
        return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
}
// 任意の Firestore 値から Date を推定（Timestamp / string / number）
function toDateOrNull(v) {
    // Firestore Timestamp
    if (v && typeof v.toDate === 'function')
        return v.toDate();
    // ISO/string（"YYYY-MM-DD" など）
    if (typeof v === 'string') {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }
    // epoch millis
    if (typeof v === 'number') {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}
exports.aggregateProjectStats = functions.pubsub
    .schedule('every 60 minutes')
    .timeZone(TIMEZONE)
    .onRun(async (context) => {
    try {
        console.log('Starting project stats aggregation...');
        const projects = await db.collection('projects').get();
        const now = admin.firestore.Timestamp.now();
        if (projects.empty) {
            console.log('No projects found');
            return null;
        }
        for (const p of projects.docs) {
            const pid = p.id;
            console.log(`Processing project: ${pid}`);
            // tasks: projects/{pid}/problems/*/issues/*/tasks/*
            // 各タスクに projectId が入っている前提。無いデータはスキップ。
            const tasksSnap = await db.collectionGroup('tasks')
                .where('projectId', '==', pid)
                .get();
            let open = 0;
            let doing = 0;
            let done = 0;
            let overdue = 0;
            let dueToday = 0;
            let dueWeek = 0;
            let noDue = 0;
            // 「今日」「週末」基準（Tokyo）
            const nowUtc = new Date();
            const todayYmd = ymdInTZ(nowUtc, TIMEZONE);
            const tmp = new Date(nowUtc);
            tmp.setUTCDate(tmp.getUTCDate() + 1);
            const tomorrowYmd = ymdInTZ(tmp, TIMEZONE);
            // 週の開始＝月曜（Tokyo）
            const todayInTz = new Date(nowUtc.toLocaleString("en-US", { timeZone: TIMEZONE }));
            const dayOfWeek = todayInTz.getDay(); // 0=日曜, 1=月曜, ..., 6=土曜
            // 月曜日を週の開始とする（月曜=1から日曜=0への変換）
            const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            const weekStart = new Date(todayInTz);
            weekStart.setDate(todayInTz.getDate() - daysToMonday);
            const weekStartYmd = ymdInTZ(weekStart, TIMEZONE);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 6);
            const weekEndYmd = ymdInTZ(weekEnd, TIMEZONE);
            tasksSnap.forEach((d) => {
                const t = d.data();
                // status 判定（将来カスタムワークフロー対応のため、done 以外は open/doing に丸める）
                const status = t.status ?? 'not_started';
                if (status === 'done')
                    done++;
                else if (status === 'in_progress')
                    doing++;
                else
                    open++;
                // 期限
                const dueDate = toDateOrNull(t.dueDate) ??
                    toDateOrNull(t.due) ??
                    toDateOrNull(t.dueDateYmd);
                if (!dueDate) {
                    noDue++;
                    return;
                }
                const dueYmd = ymdInTZ(dueDate, TIMEZONE);
                // 過去だが done 以外 → overdue
                if (dueYmd < todayYmd && status !== 'done')
                    overdue++;
                if (dueYmd === todayYmd)
                    dueToday++;
                // 今週内（今日を含む）の期限
                if (dueYmd >= todayYmd && dueYmd <= weekEndYmd)
                    dueWeek++;
            });
            await db.doc(`projects/${pid}/stats/summary`).set({
                openCount: open,
                inProgressCount: doing,
                doneCount: done,
                overdueCount: overdue,
                dueTodayCount: dueToday,
                dueThisWeekCount: dueWeek,
                noDueCount: noDue,
                updatedAt: now
            }, { merge: true });
            console.log(`Completed stats aggregation for project: ${pid}`);
        }
        console.log('Project stats aggregation completed successfully');
        return null;
    }
    catch (error) {
        console.error('Error in project stats aggregation:', error);
        throw error;
    }
});
//# sourceMappingURL=stats.js.map