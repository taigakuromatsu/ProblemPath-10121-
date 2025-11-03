// functions/src/ai.ts
// Vertex AI (Gemini) 版: JSON 優先 + 行分割フェイルセーフ
// @ts-ignore - firebase-functions/v2/httpsの型定義の問題を回避
import { onCall, HttpsError } from "firebase-functions/v2/https";
// @ts-ignore
import type { CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

// ==== Vertex defaults（環境変数が無ければこれを使う）====
const PROJECT =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.PROJECT_ID ||
  "kensyu10121";

const LOCATION = process.env.VERTEX_LOCATION || "asia-northeast1";
const MODEL    = process.env.VERTEX_MODEL    || "gemini-2.5-flash";

// ====== 型 ======
export type IssueSuggestInput = {
  lang: "ja" | "en";
  projectId: string;
  problem: {
    title: string;
    phenomenon?: string;
    cause?: string | null;
    solution?: string | null;
    goal?: string;
  };
};

export type IssueSuggestOutput = { suggestions: string[] };

// Problem progress / Status の型
type ProblemProgressItem = { title: string; percent: number };
type StatusItem = { label: string; count: number };

// ====== System prompts ======
const SYSTEM_EN =
  `You generate concise, actionable issue titles for a Kanban/issue tracker. ` +
  `Reply ONLY as JSON: {"suggestions": string[]}. 5-7 items, 8–36 chars, imperative, no duplicates.`;

const SYSTEM_JA =
  `あなたは課題管理ツール向けに短く実行可能なイシュータイトルを作成します。` +
  `必ず JSON でのみ返答: {"suggestions": string[]}。5〜7件、8〜36文字、命令形、重複なし。`;

// ====== helper ======
function cleanLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((x) => x.replace(/^[-*●・\d\.\)\]]+\s*/, "").trim())
    .filter(Boolean);
}

function buildPrompt(input: IssueSuggestInput): string {
  const preferLang = input.lang === "ja" ? "Japanese" : "English";
  return [
    `Project ID: ${input.projectId}`,
    `Problem Title: ${input.problem.title}`,
    input.problem.phenomenon ? `Phenomenon: ${input.problem.phenomenon}` : "",
    input.problem.cause ? `Cause: ${input.problem.cause}` : "",
    input.problem.solution ? `Solution: ${input.problem.solution}` : "",
    input.problem.goal ? `Goal/KPI: ${input.problem.goal}` : "",
    "",
    `Return ${preferLang} issue titles only.`,
    `Rules:`,
    `- 8–36 characters`,
    `- Start with a verb`,
    `- Specific & scannable`,
    `- No numbering, no markdown`,
    `- Avoid duplicates`,
    `- Provide 5 to 7 lines`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ====== Vertex クライアント ======
export class AiClient {
  private vertexPromise: Promise<any>;

  constructor() {
    const project = PROJECT;
    const location = LOCATION;
    // 遅延 import で他関数への影響を最小化
    this.vertexPromise = (async () => {
      const { VertexAI } = await import("@google-cloud/vertexai");
      return new VertexAI({ project, location });
    })();
  }

  async suggestIssues(input: IssueSuggestInput): Promise<IssueSuggestOutput> {
    const vertex = await this.vertexPromise;

    const sys = input.lang === "ja" ? SYSTEM_JA : SYSTEM_EN;
    const prompt = buildPrompt(input);

    const model = vertex.getGenerativeModel({
      model: MODEL,
      systemInstruction: sys,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3,
      },
    });

    try {
      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }] as any,
      });

      const parts = (resp as any)?.response?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p: any) => (p?.text ?? "").trim()).filter(Boolean).join("\n");

      // JSON不達時の強化: parts が複数なら候補化
      if (Array.isArray(parts) && parts.length > 1) {
        const fromParts = parts
          .map((p: any) => (p?.text ?? "").trim())
          .filter(Boolean);
        if (fromParts.length >= 3) {
          return { suggestions: fromParts.slice(0, 7) };
        }
      }

      // 1) JSON 優先
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray((parsed as any)?.suggestions)) {
          const arr = (parsed as any).suggestions as unknown[];
          const normalized = arr
            .map((x) => {
              if (typeof x === "string") return x.trim();
              if (x && typeof x === "object" && typeof (x as any).text === "string") {
                return String((x as any).text).trim();
              }
              return "";
            })
            .filter(Boolean);
          if (normalized.length) {
            return { suggestions: normalized.slice(0, 7) };
          }
        }
      } catch {
        /* JSON でなければ行分割へ */
      }

      const suggestions = cleanLines(text).slice(0, 7);
      return { suggestions };
    } catch (e: any) {
      console.error("[VertexAI] call failed", {
        message: e?.message,
        model: MODEL,
        location: LOCATION,
        details: e,
      });
      throw new Error(`Vertex request failed: ${String(e?.message ?? e)}`);
    }
  }
}

// ===== レポート生成（週次固定） =====
type ReportScope = "personal" | "project";
type ReportPeriod = "daily" | "weekly";
type ReportLang = "ja" | "en";

type GenerateProgressReportDraftRequest = {
  projectId: string;
  scope?: ReportScope;
  period?: ReportPeriod;
  lang?: ReportLang;
};

type GenerateProgressReportDraftResponse = {
  title: string;
  body: string;
  metrics: { completedTasks: number; avgProgressPercent: number; notes: string };
};

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}
function formatNumber(value: number): string {
  if (!Number.isFinite(value as number)) return "0";
  return Number.isInteger(value as number) ? String(value) : (value as number).toFixed(1);
}

// ---- JST週範囲（Mon–Sun）ユーティリティ ----
const JST = "Asia/Tokyo";

function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // YYYY-MM-DD
}
function parseYmdToUtcDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map((s) => Number(s));
  return new Date(Date.UTC(y, m - 1, d));
}
function getJstWeekRange(today: Date = new Date()): { startYmd: string; endYmd: string; display: string } {
  const todayYmd = ymdInTz(today, JST);         // JST の YYYY-MM-DD
  const todayUtc = parseYmdToUtcDate(todayYmd); // JST日付の 00:00Z
  const dow = todayUtc.getUTCDay();             // 0=Sun
  const diffFromMon = (dow + 6) % 7;            // Mon=0
  const startUtc = new Date(todayUtc.getTime() - diffFromMon * 24 * 60 * 60 * 1000);
  const endUtc   = new Date(startUtc.getTime() + 6 * 24 * 60 * 60 * 1000);
  const start = ymdInTz(startUtc, JST).replace(/-/g, "/");
  const end   = ymdInTz(endUtc,   JST).replace(/-/g, "/");
  return { startYmd: start.replace(/\//g, "-"), endYmd: end.replace(/\//g, "-"), display: `${start}–${end}` };
}

// ---- タイトル（週次専用） ----
function buildWeeklyTitle(scope: ReportScope, lang: ReportLang, rangeDisp: string): string {
  if (lang === "ja") {
    return scope === "personal"
      ? `個人タスク 週次レポート ${rangeDisp}`
      : `プロジェクト全体 週次レポート ${rangeDisp}`;
  }
  return scope === "personal"
    ? `Personal Weekly Summary ${rangeDisp}`
    : `Project Weekly Summary ${rangeDisp}`;
}

// ---- ステータス内訳の表示整形 ----
function formatStatusLine(items: StatusItem[], lang: ReportLang): string {
  if (!Array.isArray(items) || !items.length) return lang === "ja" ? "（データなし）" : "(no data)";
  // 例: 未着手: 12 / 対応中: 8 / 完了: 5 / others...
  const parts = items.map((i: StatusItem) => `${i.label}: ${toNumber(i.count)}`);
  return parts.join(" / ");
}

// ---- 週次本文（personal / project） ----
type WeeklyPersonalParams = {
  lang: ReportLang;
  rangeDisp: string;
  completedTasks7d: number;
  avgLeadTime30dDays: number;
  lateRateThisWeekPercent: number;
  personalStatus: StatusItem[];
  topProblemTitle: string;
  avgProgressPercent: number;
};

function buildWeeklyPersonalBody(p: WeeklyPersonalParams): string {
  const L = p.lang;
  const kpiLine =
    L === "ja"
      ? `完了(7日): ${p.completedTasks7d}件 / 平均対応日数(30日): ${formatNumber(p.avgLeadTime30dDays)}日 / 今週の遅延率: ${formatNumber(p.lateRateThisWeekPercent)}%`
      : `Completed(7d): ${p.completedTasks7d} / Avg lead(30d): ${formatNumber(p.avgLeadTime30dDays)} days / Late rate: ${formatNumber(p.lateRateThisWeekPercent)}%`;
  const statusLine = formatStatusLine(p.personalStatus, L);

  const sections =
    L === "ja"
      ? [
          `【概要】個人の週次サマリーです（集計期間: ${p.rangeDisp} / JST）。`,
          `【今週の個人成果】${kpiLine}`,
          `【自分のステータス内訳】${statusLine}`,
          `【傾向・気づき】チーム重点「${p.topProblemTitle}」の平均進捗目安は${formatNumber(p.avgProgressPercent)}%。遅延率や対応日数の推移を踏まえ、来週は遅延低減と処理速度の改善に注力。`,
          `【来週のフォーカス】（ここに具体的なタスク・OKRを記入）`,
          `【期間注記】集計はJSTの週（Mon–Sun）基準です。`,
        ]
      : [
          `【Overview】Weekly summary for your tasks (Range: ${p.rangeDisp}, JST).`,
          `【My Results】${kpiLine}`,
          `【My Status Breakdown】${statusLine}`,
          `【Observations】Team focus "${p.topProblemTitle}" sits around ${formatNumber(p.avgProgressPercent)}% on average. Prioritize reducing lateness and improving lead time next week.`,
          `【Next Week Focus】(Fill in concrete tasks/OKRs here)`,
          `【Note】Week is based on Mon–Sun in JST.`,
        ];

  return sections.join("\n");
}

type WeeklyProjectParams = {
  lang: ReportLang;
  rangeDisp: string;
  completedTasks7d: number;
  avgLeadTime30dDays: number;
  lateRateThisWeekPercent: number;
  projectStatus: StatusItem[];
  topProblems: ProblemProgressItem[]; // Top3
  avgProgressPercent: number;
};

function buildWeeklyProjectBody(p: WeeklyProjectParams): string {
  const L = p.lang;
  const kpiLine =
    L === "ja"
      ? `完了(7日): ${p.completedTasks7d}件 / 平均対応日数(30日): ${formatNumber(p.avgLeadTime30dDays)}日 / 今週の遅延率: ${formatNumber(p.lateRateThisWeekPercent)}%`
      : `Completed(7d): ${p.completedTasks7d} / Avg lead(30d): ${formatNumber(p.avgLeadTime30dDays)} days / Late rate: ${formatNumber(p.lateRateThisWeekPercent)}%`;
  const statusLine = formatStatusLine(p.projectStatus, L);

  const top3 =
    p.topProblems.length
      ? p.topProblems
          .slice(0, 3)
          .map((tp, idx) => `${idx + 1}) ${tp.title}: ${formatNumber(tp.percent)}%`)
          .join(" / ")
      : (L === "ja" ? "（データなし）" : "(no data)");

  const sections =
    L === "ja"
      ? [
          `【概要】プロジェクト全体の週次サマリーです（集計期間: ${p.rangeDisp} / JST）。`,
          `【主要KPI】${kpiLine}`,
          `【Problem別平均進捗（上位3）】${top3}（平均: ${formatNumber(p.avgProgressPercent)}%）`,
          `【ステータス内訳】${statusLine}`,
          `【リスク・対応方針】遅延率と対応日数の動向を監視し、ボトルネック工程の改善・引継ぎ基準の明確化・レビュー間隔の短縮等で処理速度を最適化。`,
          `【来週の重点】（ここにスプリント目標や重点イシューを記入）`,
          `【期間注記】集計はJSTの週（Mon–Sun）基準です。`,
        ]
      : [
          `【Overview】Weekly summary for the project (Range: ${p.rangeDisp}, JST).`,
          `【Key KPIs】${kpiLine}`,
          `【Top 3 Problems by Avg Progress】${top3} (Avg: ${formatNumber(p.avgProgressPercent)}%)`,
          `【Status Breakdown】${statusLine}`,
          `【Risks & Actions】Watch lateness and lead time; address bottlenecks, tighten handoff/review cadence, and streamline workflows.`,
          `【Next Week Focus】(Fill in sprint goals and key issues here)`,
          `【Note】Week is based on Mon–Sun in JST.`,
        ];

  return sections.join("\n");
}

// ======================================================
// Callable: generateProgressReportDraft（週次のみ）
// ======================================================
export const generateProgressReportDraft = onCall<
  GenerateProgressReportDraftRequest,
  GenerateProgressReportDraftResponse
>(
  { region: "asia-northeast1" },
  async (request: CallableRequest<GenerateProgressReportDraftRequest>) => {
    const { projectId } = request.data ?? {};
    if (!projectId) {
      throw new HttpsError("invalid-argument", "projectId is required");
    }

    const scope: ReportScope = request.data?.scope === "personal" ? "personal" : "project";
    // UI は週次のみだが、念のため period 引数は週次に正規化
    const period: ReportPeriod = "weekly";
    const lang: ReportLang = request.data?.lang === "en" ? "en" : "ja";

    if (scope === "personal") {
      const uid = request.auth?.uid;
      if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required for personal reports");
      }
    }

    const firestore = getFirestore();

    // プロジェクト全体の集計
    const summaryRef = firestore.doc(`projects/${projectId}/analytics/currentSummary`);
    const summarySnap = await summaryRef.get();
    if (!summarySnap.exists) {
      throw new HttpsError("not-found", "Analytics summary not found");
    }
    const summary = summarySnap.data() ?? {};

    // Problem progress 正規化 & Top3
    const rawProgress: unknown[] = Array.isArray((summary as any).problemProgress)
      ? ((summary as any).problemProgress as unknown[])
      : [];
    const normalizedProgress: ProblemProgressItem[] = rawProgress
      .map((item: any): ProblemProgressItem => ({
        title: typeof item?.title === "string" ? item.title : "",
        percent: typeof item?.percent === "number" ? item.percent : 0,
      }))
      .filter((it: ProblemProgressItem) => it.title !== "" || it.percent > 0);
    normalizedProgress.sort(
      (a: ProblemProgressItem, b: ProblemProgressItem) => b.percent - a.percent
    );
    const fallbackTitle = lang === "ja" ? "重点課題" : "Key initiative";
    const topProblems: ProblemProgressItem[] = normalizedProgress.slice(0, 3).map(
      (p: ProblemProgressItem): ProblemProgressItem => ({
        title: p.title || fallbackTitle,
        percent: roundTo(toNumber(p.percent), 1),
      })
    );
    const avgProgressPercent = normalizedProgress.length
      ? Math.round(
          normalizedProgress.reduce(
            (total: number, cur: ProblemProgressItem) => total + toNumber(cur.percent),
            0
          ) / normalizedProgress.length
        )
      : 0;

    // ステータス内訳（全体）
    const projectStatusRaw: unknown[] = Array.isArray((summary as any).statusBreakdown)
      ? ((summary as any).statusBreakdown as unknown[])
      : [];
    const projectStatus: StatusItem[] = projectStatusRaw
      .map((x: any): StatusItem => ({
        label: typeof x?.label === "string" ? x.label : "",
        count: toNumber(x?.count),
      }))
      .filter((x: StatusItem) => x.label !== "");

    // 主要KPI（全体）を初期値に
    let completedTasks7d = Math.max(0, Math.round(toNumber((summary as any).completedTasks7d)));
    let avgLeadTime30dDays = roundTo(toNumber((summary as any).avgLeadTime30dDays), 1);
    let lateRateThisWeekPercent = roundTo(toNumber((summary as any).lateRateThisWeekPercent), 1);

    // 個人用指標（必要時に上書き）
    let personalStatus: StatusItem[] = [];
    if (scope === "personal") {
      const uid = request.auth!.uid as string;
      const personalRef = firestore.doc(`projects/${projectId}/analyticsPerUser/${uid}`);
      const personalSnap = await personalRef.get();
      const personalData = personalSnap.exists ? personalSnap.data() ?? {} : {};

      completedTasks7d = Math.max(0, Math.round(toNumber((personalData as any).completedTasks7d)));
      avgLeadTime30dDays = roundTo(toNumber((personalData as any).avgLeadTime30dDays), 1);
      lateRateThisWeekPercent = roundTo(toNumber((personalData as any).lateRateThisWeekPercent), 1);

      const personalStatusRaw: unknown[] = Array.isArray((personalData as any).statusBreakdown)
        ? ((personalData as any).statusBreakdown as unknown[])
        : [];
      personalStatus = personalStatusRaw
        .map((x: any): StatusItem => ({
          label: typeof x?.label === "string" ? x.label : "",
          count: toNumber(x?.count),
        }))
        .filter((x: StatusItem) => x.label !== "");
    }

    // 週範囲（JST）
    const { display: rangeDisp } = getJstWeekRange(new Date());

    // タイトル & 本文
    const topProblemTitle = (topProblems[0]?.title ?? fallbackTitle);
    const title = buildWeeklyTitle(scope, lang, rangeDisp);

    const body =
      scope === "personal"
        ? buildWeeklyPersonalBody({
            lang,
            rangeDisp,
            completedTasks7d,
            avgLeadTime30dDays,
            lateRateThisWeekPercent,
            personalStatus,
            topProblemTitle,
            avgProgressPercent,
          })
        : buildWeeklyProjectBody({
            lang,
            rangeDisp,
            completedTasks7d,
            avgLeadTime30dDays,
            lateRateThisWeekPercent,
            projectStatus,
            topProblems,
            avgProgressPercent,
          });

    const notes =
      scope === "personal"
        ? (lang === "ja" ? `チーム重点: ${topProblemTitle}` : `Team focus: ${topProblemTitle}`)
        : topProblemTitle;

    return {
      title,
      body,
      metrics: {
        completedTasks: completedTasks7d,
        avgProgressPercent,
        notes,
      },
    };
  }
);


  

  
