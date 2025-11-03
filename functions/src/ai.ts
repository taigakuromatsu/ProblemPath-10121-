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
      // Vertex SDK の generateContent は { contents } 形式
      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }] as any,
      });

      // 応答本文（JSON 期待）
      const parts = (resp as any)?.response?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p: any) => (p?.text ?? "").trim()).filter(Boolean).join("\n");

        // 追加: parts が複数ならそれをそのまま候補化（JSON不達時の強化）
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
            if (Array.isArray(parsed?.suggestions)) {
            const arr = parsed.suggestions as unknown[];
            const normalized = arr
                .map(x => {
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
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function buildTitle(scope: ReportScope, period: ReportPeriod, lang: ReportLang): string {
  const isPersonal = scope === "personal";
  if (lang === "ja") {
    if (isPersonal) {
      return period === "daily" ? "個人タスク 日次レポート" : "個人タスク 週次レポート";
    }
    return period === "daily" ? "プロジェクト全体 日次レポート" : "プロジェクト全体 週次レポート";
  }

  if (isPersonal) {
    return period === "daily" ? "Personal Daily Summary" : "Personal Weekly Summary";
  }
  return period === "daily" ? "Project Daily Summary" : "Project Weekly Summary";
}

type BodyParams = {
  scope: ReportScope;
  period: ReportPeriod;
  lang: ReportLang;
  completedTasks7d: number;
  avgLeadTime30dDays: number;
  lateRateThisWeekPercent: number;
  avgProgressPercent: number;
  topProblemTitle: string;
  topProblemPercent: number;
};

function buildBody(params: BodyParams): string {
  const {
    scope,
    period,
    lang,
    completedTasks7d,
    avgLeadTime30dDays,
    lateRateThisWeekPercent,
    avgProgressPercent,
    topProblemTitle,
    topProblemPercent,
  } = params;

  const sentences: string[] = [];

  if (lang === "ja") {
    sentences.push(
      scope === "personal"
        ? period === "daily"
          ? "本日の個人タスクの振り返りです。"
          : "今週の個人タスクの振り返りです。"
        : period === "daily"
        ? "本日のプロジェクト全体の状況です。"
        : "今週のプロジェクト全体の状況です。"
    );
    sentences.push(`直近7日間の完了タスクは${completedTasks7d}件です。`);
    sentences.push(`30日平均の対応日数は約${formatNumber(avgLeadTime30dDays)}日です。`);
    sentences.push(`今週の遅延率は${formatNumber(lateRateThisWeekPercent)}%です。`);
    sentences.push(
      scope === "personal"
        ? `チーム重点課題「${topProblemTitle}」は進捗${formatNumber(topProblemPercent)}%、平均進捗の目安は${formatNumber(avgProgressPercent)}%です。`
        : `重点課題「${topProblemTitle}」は進捗${formatNumber(topProblemPercent)}%、平均進捗率は${formatNumber(avgProgressPercent)}%です。`
    );
    return sentences.join(" ");
  }

  sentences.push(
    scope === "personal"
      ? period === "daily"
        ? "Daily snapshot for your tasks."
        : "Weekly snapshot for your tasks."
      : period === "daily"
      ? "Daily overview for the project."
      : "Weekly overview for the project."
  );
  sentences.push(`Completed tasks (last 7 days): ${completedTasks7d}.`);
  sentences.push(`Average lead time (30-day avg): ${formatNumber(avgLeadTime30dDays)} days.`);
  sentences.push(`Late rate this week: ${formatNumber(lateRateThisWeekPercent)}%.`);
  sentences.push(
    scope === "personal"
      ? `Team focus "${topProblemTitle}" is ${formatNumber(topProblemPercent)}% complete; average progress sits around ${formatNumber(avgProgressPercent)}%.`
      : `Key focus "${topProblemTitle}" is ${formatNumber(topProblemPercent)}% complete with an average progress of ${formatNumber(avgProgressPercent)}%.`
  );
  return sentences.join(" ");
}

export const generateProgressReportDraft = onCall<
  GenerateProgressReportDraftRequest,
  GenerateProgressReportDraftResponse
>(async (request: CallableRequest<GenerateProgressReportDraftRequest>) => {
  const { projectId } = request.data ?? {};
  if (!projectId) {
    throw new HttpsError("invalid-argument", "projectId is required");
  }

  const scope: ReportScope = request.data?.scope === "personal" ? "personal" : "project";
  const period: ReportPeriod = request.data?.period === "daily" ? "daily" : "weekly";
  const lang: ReportLang = request.data?.lang === "en" ? "en" : "ja";

  if (scope === "personal") {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required for personal reports");
    }
  }

  const firestore = getFirestore();
  const summaryRef = firestore.doc(`projects/${projectId}/analytics/currentSummary`);
  const summarySnap = await summaryRef.get();

  if (!summarySnap.exists) {
    throw new HttpsError("not-found", "Analytics summary not found");
  }

  const summary = summarySnap.data() ?? {};
  const problemProgress = Array.isArray(summary.problemProgress) ? summary.problemProgress : [];

  const normalizedProgress = problemProgress
    .map((item: any) => ({
      title: typeof item?.title === "string" ? item.title : "",
      percent: typeof item?.percent === "number" ? item.percent : 0,
    }))
    .filter((item: { title: string; percent: number }) => item.title || item.percent);

  const avgProgressPercent = normalizedProgress.length
    ? Math.round(
        normalizedProgress.reduce(
          (total: number, current: { title: string; percent: number }) => total + current.percent,
          0,
        ) / normalizedProgress.length,
      )
    : 0;

  const topProblem = normalizedProgress[0];
  const fallbackTitle = lang === "ja" ? "重点課題" : "Key initiative";
  const topProblemTitle = topProblem?.title || fallbackTitle;
  const topProblemPercent = topProblem ? roundTo(toNumber(topProblem.percent), 1) : 0;

  let completedTasks7d = Math.max(0, Math.round(toNumber(summary.completedTasks7d)));
  let avgLeadTime30dDays = roundTo(toNumber(summary.avgLeadTime30dDays), 1);
  let lateRateThisWeekPercent = roundTo(toNumber(summary.lateRateThisWeekPercent), 1);

  if (scope === "personal") {
    const uid = request.auth?.uid as string;
    const personalRef = firestore.doc(`projects/${projectId}/analyticsPerUser/${uid}`);
    const personalSnap = await personalRef.get();
    const personalData = personalSnap.exists ? personalSnap.data() ?? {} : {};

    completedTasks7d = Math.max(0, Math.round(toNumber(personalData.completedTasks7d)));
    avgLeadTime30dDays = roundTo(toNumber(personalData.avgLeadTime30dDays), 1);
    lateRateThisWeekPercent = roundTo(toNumber(personalData.lateRateThisWeekPercent), 1);
  }

  const title = buildTitle(scope, period, lang);
  const body = buildBody({
    scope,
    period,
    lang,
    completedTasks7d,
    avgLeadTime30dDays,
    lateRateThisWeekPercent,
    avgProgressPercent,
    topProblemTitle,
    topProblemPercent,
  });

  const notes =
    scope === "personal"
      ? lang === "ja"
        ? `チーム重点: ${topProblemTitle}`
        : `Team focus: ${topProblemTitle}`
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
});

  

  
