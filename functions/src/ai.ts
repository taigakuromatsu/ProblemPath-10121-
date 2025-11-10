// functions/src/ai.ts
// Vertex AI (Gemini) 版: JSON 優先 + 行分割フェイルセーフ
// 週次レポートは Analytics 集計値を元に安定したドラフトを生成（主な成果＝完了タスク名）

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

// ----- Insight（参考用：現在の週次本文では未使用・将来拡張用として残す）-----
const INSIGHT_SYS_JA =
  `あなたはプロダクト/開発チームの進捗を1文で端的に要約するアナリストです。` +
  `出力は日本語の1文のみ。箇条書き・接頭辞・引用符・余計な記号は禁止。` +
  `与えられた指標を踏まえ、来週の注力方針を含めて80〜120文字程度で簡潔に。`;
const INSIGHT_SYS_EN =
  `You are an analyst who summarizes delivery signals in ONE sentence.` +
  `Output exactly one English sentence. No bullets, no prefixes, no quotes.` +
  `Use the given metrics and include a focus suggestion for next week (~20–30 words).`;

// ====== helper ======
function cleanLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((x) => x.replace(/^[-*●・\d\.\)\]]+\s*/, "").trim())
    .filter(Boolean);
}

function postProcessSuggestions(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const line of raw) {
    let s = (line || "").trim();
    if (!s) continue;

    s = s.replace(/^[-*●・\d]+\s*[.)】］）]?\s*/u, "").trim();
    if (!s) continue;

    const key = s.toLowerCase();
    if (seen.has(key)) continue;

    if (s.length < 8 || s.length > 36) continue;

    seen.add(key);
    out.push(s);
    if (out.length >= 7) break;
  }

  return out;
}
function oneLine(s: string): string {
  return cleanLines(s).join(" ").replace(/\s+/g, " ").trim();
}
function firstSentence(text: string, lang: "ja" | "en"): string {
  const t = oneLine(text);
  if (!t) return "";
  if (lang === "ja") {
    const i = t.indexOf("。");
    return i >= 0 ? t.slice(0, i + 1) : t;
  }
  const m = t.match(/[^.!?]+[.!?]/);
  return m ? m[0].trim() : t;
}
function clampJa(text: string): string {
  // 日本語だけ長すぎるときに丸める（約130字で切って読点を足す）
  const limit = 130;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + "…";
}

// --- 重複抑止ヘルパ ---
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripDuplicateHeadJa(text: string, title: string): string {
  // 先頭に「タイトル」は進捗XX%（％）が来ていたら削除
  const re = new RegExp(`^\\s*「?${escapeRegExp(title)}」?は進捗\\d+(?:\\.\\d+)?[％%]。?\\s*`);
  return text.replace(re, "").trim();
}
function stripDuplicateHeadEn(text: string, title: string): string {
  // Top priority "Title" is at XX% などを先頭から削除
  const re = new RegExp(
    `^\\s*(?:Top\\s+priority\\s+)?["']?${escapeRegExp(title)}["']?\\s+is\\s+at\\s+\\d+(?:\\.\\d+)?%\\.?\\s*`,
    "i"
  );
  return text.replace(re, "").trim();
}

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

      const parts =
        (resp as any)?.response?.candidates?.[0]?.content?.parts ?? [];
      const joinedText = parts
        .map((p: any) => (p?.text ?? "").trim())
        .filter(Boolean)
        .join("\n");

      if (joinedText) {
        try {
          const parsed = JSON.parse(joinedText);
          const arr = Array.isArray((parsed as any)?.suggestions)
            ? ((parsed as any).suggestions as unknown[])
            : [];

          const normalizedFromJson = arr
            .map((x) => {
              if (typeof x === "string") return x.trim();
              if (x && typeof (x as any).text === "string") {
                return String((x as any).text).trim();
              }
              return "";
            })
            .filter(Boolean);

          const processed = postProcessSuggestions(normalizedFromJson);
          if (processed.length) {
            return { suggestions: processed };
          }
        } catch {
          // JSON でなければ fallback へ
        }
      }

      let candidates: string[] = [];
      if (Array.isArray(parts) && parts.length > 0) {
        candidates = cleanLines(
          parts.map((p: any) => (p?.text ?? "").trim()).join("\n")
        );
      } else {
        candidates = cleanLines(joinedText);
      }

      const processed = postProcessSuggestions(candidates);
      return { suggestions: processed };
    } catch (e: any) {
      console.error("[VertexAI] suggestIssues failed", {
        message: e?.message,
        model: MODEL,
        location: LOCATION,
        details: e,
      });
      throw new Error(`Vertex request failed: ${String(e?.message ?? e)}`);
    }
  }

  // === Insight（現在はレポート本文には使わないが、将来用に残す）===
  async generateInsight(params: {
    lang: "ja" | "en";
    scope: "personal" | "project";
    completedTasks7d: number;
    avgLeadTime30dDays: number;
    lateRateThisWeekPercent: number;
    avgProgressPercent: number;
    topProblemTitle: string;
    topProblemPercent?: number;
  }): Promise<string> {
    const vertex = await this.vertexPromise;

    const sys = params.lang === "ja" ? INSIGHT_SYS_JA : INSIGHT_SYS_EN;
    const prompt = buildInsightPrompt(params);

    const model = vertex.getGenerativeModel({
      model: MODEL,
      systemInstruction: sys,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 128,
        responseMimeType: "text/plain",
      },
    });

    try {
      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }] as any,
      });
      const parts = (resp as any)?.response?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p: any) => (p?.text ?? "")).join(" ");
      let line = firstSentence(text, params.lang);
      line = params.lang === "ja"
        ? stripDuplicateHeadJa(line, params.topProblemTitle)
        : stripDuplicateHeadEn(line, params.topProblemTitle);
      if (params.lang === "ja") line = clampJa(line);

      line = line.replace(/^["'「『（(【\-\*\•\s]+/, "").trim();
      return line || this.fallbackInsight(params);
    } catch (e) {
      console.warn("[VertexAI] generateInsight failed, fallback used.", e);
      return this.fallbackInsight(params);
    }
  }

  private fallbackInsight(p: {
    lang: "ja" | "en";
    scope: "personal" | "project";
    completedTasks7d: number;
    avgLeadTime30dDays: number;
    lateRateThisWeekPercent: number;
    avgProgressPercent: number;
    topProblemTitle: string;
    topProblemPercent?: number;
  }): string {
    if (p.lang === "ja") {
      if (p.lateRateThisWeekPercent >= 20) {
        return `今週は遅延率がやや高め（${formatNumber(p.lateRateThisWeekPercent)}%）。「${p.topProblemTitle}」のボトルネックを特定し、WIP抑制とレビュー高速化に注力。`;
      }
      if (p.avgLeadTime30dDays >= 5) {
        return `平均対応日数が長め（${formatNumber(p.avgLeadTime30dDays)}日）。タスク分割と詰まり解消で処理速度の底上げを優先。`;
      }
      const pctAvg = formatNumber(p.avgProgressPercent);
      return `平均進捗は${pctAvg}%前後。現状ペース維持と品質確保を両立しつつ、軽微な遅延要因の除去を。`;
    }
    if (p.lateRateThisWeekPercent >= 20) {
      return `Late rate is elevated (${formatNumber(p.lateRateThisWeekPercent)}%). Identify bottlenecks in "${p.topProblemTitle}" and prioritize WIP control and faster reviews.`;
    }
    if (p.avgLeadTime30dDays >= 5) {
      return `Lead time is relatively long (${formatNumber(p.avgLeadTime30dDays)}d). Split work smaller and remove blockers to improve throughput.`;
    }
    return `Overall progress is around ${formatNumber(p.avgProgressPercent)}%. Maintain pace while trimming minor sources of delay.`;
  }
}

type IssueSuggestCallableRequest = {
  lang?: "ja" | "en";
  projectId?: string;
  problem?: {
    title?: string;
    phenomenon?: string;
    cause?: string | null;
    solution?: string | null;
    goal?: string;
  };
  title?: string;
  description?: string;
};

type IssueSuggestCallableResponse = {
  suggestions: string[];
};

const ai = new AiClient();

export const issueSuggest = onCall<
  IssueSuggestCallableRequest,
  IssueSuggestCallableResponse
>({ region: "asia-northeast1" }, async (
  request: CallableRequest<IssueSuggestCallableRequest>
) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const raw = request.data || {};

  const lang: "ja" | "en" = raw.lang === "en" ? "en" : "ja";

  const projectId = (raw.projectId || "").trim();

  function norm(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s || undefined;
  }
  
  const fallbackTitle = norm(raw.title);
  const fallbackPhenomenon = norm(raw.description);
  
  const prob = {
    title: norm(raw.problem?.title) || fallbackTitle,
    phenomenon: norm(raw.problem?.phenomenon) ?? fallbackPhenomenon,
    cause: norm(raw.problem?.cause),
    solution: norm(raw.problem?.solution),
    goal: norm(raw.problem?.goal),
  };

  if (!prob.title && !prob.phenomenon && !prob.goal) {
    throw new HttpsError(
      "invalid-argument",
      "Problem definition is empty. Provide at least title or phenomenon/goal."
    );
  }

  const input: IssueSuggestInput = {
    lang,
    projectId: projectId || "unknown",
    problem: {
      title: prob.title || "(untitled problem)",
      phenomenon: prob.phenomenon,
      cause: prob.cause,
      solution: prob.solution,
      goal: prob.goal,
    },
  };

  try {
    const out = await ai.suggestIssues(input);
    return { suggestions: out.suggestions || [] };
  } catch (e: any) {
    console.error("[issueSuggest] error", e);
    throw new HttpsError("internal", "Failed to generate suggestions");
  }
});

// ====== Prompt builders ======
function buildPrompt(input: IssueSuggestInput): string {
  const common = [
    `Project ID: ${input.projectId}`,
    `Problem Title: ${input.problem.title}`,
    input.problem.phenomenon ? `Phenomenon: ${input.problem.phenomenon}` : "",
    input.problem.cause ? `Cause: ${input.problem.cause}` : "",
    input.problem.solution ? `Solution: ${input.problem.solution}` : "",
    input.problem.goal ? `Goal/KPI: ${input.problem.goal}` : "",
    "",
  ].filter(Boolean);

  if (input.lang === "ja") {
    return [
      ...common,
      `出力は日本語のイシュータイトルのみ。`,
      `ルール:`,
      `- 8〜36文字`,
      `- 動詞で始める`,
      `- 具体的で一読可`,
      `- 番号・Markdown禁止`,
      `- 重複回避`,
      `- 問題文や原因の言い換えではなく、具体的なアクションのみを書く`,
      `- 「〜の確認」「〜の修正」「〜の自動化」「〜ルールの定義」など実行可能な粒度にする`,
      `- 「品質向上に努める」等の抽象的な表現は禁止`,
      `- 5〜7行`,
    ].join("\n");
  }

  return [
    ...common,
    `Return English issue titles only.`,
    `Rules:`,
    `- 8–36 characters`,
    `- Start with a verb`,
    `- Specific & scannable`,
    `- No numbering, no markdown`,
    `- Avoid duplicates`,
    `- Only actionable tasks, not explanations or restating the problem`,
    `- Use concrete verbs like "Fix", "Verify", "Automate", "Define"`,
    `- Avoid vague phrases like "Improve overall quality"`,
    `- Provide 5 to 7 lines`,
  ].join("\n");
}

// === Insight 用のプロンプト（参考用保持） ===
function buildInsightPrompt(p: {
  lang: "ja" | "en";
  scope: "personal" | "project";
  completedTasks7d: number;
  avgLeadTime30dDays: number;
  lateRateThisWeekPercent: number;
  avgProgressPercent: number;
  topProblemTitle: string;
  topProblemPercent?: number;
}): string {
  const lines: string[] = [];
  lines.push(`Scope: ${p.scope}`);
  lines.push(`Completed(7d): ${p.completedTasks7d}`);
  lines.push(`AvgLeadTime(30d): ${formatNumber(p.avgLeadTime30dDays)} days`);
  lines.push(`LateRate(thisWeek): ${formatNumber(p.lateRateThisWeekPercent)}%`);
  lines.push(`AvgProgress(all problems): ${formatNumber(p.avgProgressPercent)}%`);
  lines.push(
    `TopProblem: ${p.topProblemTitle}${
      typeof p.topProblemPercent === "number"
        ? ` (${formatNumber(p.topProblemPercent)}%)`
        : ""
    }`
  );

  if (p.lang === "ja") {
    lines.push(
      `出力は日本語の1文のみ。数字を活かし、来週の注力方針（遅延低減/ボトルネック解消/WIP抑制/レビュー高速化 等）を具体的に示すこと。`
    );
  } else {
    lines.push(
      `Output exactly one English sentence; use metrics and suggest where to focus next (e.g., reduce lateness, remove bottlenecks, control WIP, speed up reviews).`
    );
  }
  return lines.join("\n");
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
function getJstWeekRange(today: Date = new Date()): {
  startYmd: string;
  endYmd: string;
  display: string;
} {
  const todayYmd = ymdInTz(today, JST);
  const todayUtc = parseYmdToUtcDate(todayYmd);
  const dow = todayUtc.getUTCDay(); // 0=Sun
  const diffFromMon = (dow + 6) % 7; // Mon=0
  const startUtc = new Date(
    todayUtc.getTime() - diffFromMon * 24 * 60 * 60 * 1000
  );
  const endUtc = new Date(
    startUtc.getTime() + 6 * 24 * 60 * 60 * 1000
  );
  const start = ymdInTz(startUtc, JST).replace(/-/g, "/");
  const end = ymdInTz(endUtc, JST).replace(/-/g, "/");
  return {
    startYmd: start.replace(/\//g, "-"),
    endYmd: end.replace(/\//g, "-"),
    display: `${start}–${end}`,
  };
}

// ---- タイトル（週次専用） ----
type ReportScope = "personal" | "project";
type ReportPeriod = "daily" | "weekly";
type ReportLang = "ja" | "en";

function buildWeeklyTitle(
  scope: ReportScope,
  lang: ReportLang,
  rangeDisp: string
): string {
  if (lang === "ja") {
    return scope === "personal"
      ? `個人タスク 週次レポート ${rangeDisp}`
      : `プロジェクト全体 週次レポート ${rangeDisp}`;
  }
  return scope === "personal"
    ? `Personal Weekly Summary ${rangeDisp}`
    : `Project Weekly Summary ${rangeDisp}`;
}

// status.not_started → 「未着手」などに変換
function translateStatusLabel(raw: string, lang: ReportLang): string {
  const key = raw
    .replace(/^status[.\-_]/, "")
    .toLowerCase();

  if (lang === "ja") {
    switch (key) {
      case "not_started":
      case "notstarted":
        return "未着手";
      case "in_progress":
      case "inprogress":
        return "対応中";
      case "done":
        return "完了";
    }
  } else {
    switch (key) {
      case "not_started":
      case "notstarted":
        return "Not started";
      case "in_progress":
      case "inprogress":
        return "In progress";
      case "done":
        return "Done";
    }
  }
  return raw;
}

function formatStatusLine(
  items: StatusItem[],
  lang: ReportLang
): string {
  if (!Array.isArray(items) || !items.length) {
    return lang === "ja" ? "（データなし）" : "(no data)";
  }
  const parts = items.map((i: StatusItem) => {
    return `${translateStatusLabel(i.label, lang)}: ${toNumber(
      i.count
    )}`;
  });
  return parts.join(" / ");
}

// ---- 主な成果（完了タスク名）行の整形 ----
function formatCompletedTasksSection(
  titles: string[] | undefined,
  lang: ReportLang,
  scope: ReportScope
): string {
  const safe = Array.isArray(titles)
    ? titles
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean)
    : [];

  const max = 20; // 表示しすぎ防止（analytics 側では 50 件まで）
  const sliced = safe.slice(0, max);

  if (lang === "ja") {
    if (sliced.length > 0) {
      return `【主な成果・完了したタスク】${sliced.join("／")}`;
    }
    // データがない場合もタイトルは固定で出す
    return scope === "personal"
      ? "【主な成果・完了したタスク】（今週、自分の完了タスクはありません）"
      : "【主な成果・完了したタスク】（今週、完了タスクはありません）";
  } else {
    if (sliced.length > 0) {
      return `Key outcomes / Completed tasks: ${sliced.join(" / ")}`;
    }
    return scope === "personal"
      ? "Key outcomes / Completed tasks: (No completed tasks for you this week)"
      : "Key outcomes / Completed tasks: (No completed tasks this week)";
  }
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
  topProblemPercent: number;
  completedTaskTitlesThisWeek: string[] | undefined;
};

function buildWeeklyPersonalBody(p: WeeklyPersonalParams): string {
  const L = p.lang;
  const kpiLine =
    L === "ja"
      ? `完了(7日): ${p.completedTasks7d}件 / 平均対応日数(30日): ${formatNumber(
          p.avgLeadTime30dDays
        )}日 / 今週の遅延率: ${formatNumber(p.lateRateThisWeekPercent)}%`
      : `Completed(7d): ${p.completedTasks7d} / Avg lead(30d): ${formatNumber(
          p.avgLeadTime30dDays
        )} days / Late rate: ${formatNumber(
          p.lateRateThisWeekPercent
        )}%`;

  const statusLine = formatStatusLine(p.personalStatus, L);
  const achievementsLine = formatCompletedTasksSection(
    p.completedTaskTitlesThisWeek,
    L,
    "personal"
  );

  const sections =
    L === "ja"
      ? [
          `【概要】個人の週次サマリーです（集計期間: ${p.rangeDisp} / JST）。`,
          `【今週の個人成果】${kpiLine}`,
          `【自分のステータス内訳】${statusLine}`,
          achievementsLine,
          `【来週のフォーカス】（ここに具体的なタスクを記入）`,
          `【期間注記】集計はJSTの週（Mon–Sun）基準です。`,
        ]
      : [
          `Overview: Personal weekly summary (Range: ${p.rangeDisp}, JST).`,
          `My Results: ${kpiLine}`,
          `My Status Breakdown: ${statusLine}`,
          achievementsLine,
          `Next Week Focus: (Fill in concrete tasks here)`,
          `Note: Week is based on Mon–Sun in JST.`,
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
  topProblemTitle: string;
  topProblemPercent: number;
  completedTaskTitlesThisWeek: string[] | undefined;
};

function buildWeeklyProjectBody(p: WeeklyProjectParams): string {
  const L = p.lang;
  const kpiLine =
    L === "ja"
      ? `完了(7日): ${p.completedTasks7d}件 / 平均対応日数(30日): ${formatNumber(
          p.avgLeadTime30dDays
        )}日 / 今週の遅延率: ${formatNumber(
          p.lateRateThisWeekPercent
        )}%`
      : `Completed(7d): ${p.completedTasks7d} / Avg lead(30d): ${formatNumber(
          p.avgLeadTime30dDays
        )} days / Late rate: ${formatNumber(
          p.lateRateThisWeekPercent
        )}%`;

  const statusLine = formatStatusLine(p.projectStatus, L);

  const top3 =
    p.topProblems.length
      ? p.topProblems
          .slice(0, 3)
          .map(
            (tp, idx) =>
              `${idx + 1}) ${tp.title}: ${formatNumber(tp.percent)}%`
          )
          .join(" / ")
      : L === "ja"
      ? "（データなし）"
      : "(no data)";

  const achievementsLine = formatCompletedTasksSection(
    p.completedTaskTitlesThisWeek,
    L,
    "project"
  );

  const sections =
    L === "ja"
      ? [
          `【概要】プロジェクト全体の週次サマリーです（集計期間: ${p.rangeDisp} / JST）。`,
          `【主要KPI】${kpiLine}`,
          `【Problem別平均進捗（上位3）】${top3}（平均: ${formatNumber(
            p.avgProgressPercent
          )}%）`,
          `【ステータス内訳】${statusLine}`,
          achievementsLine,
          `【来週の重点】（ここにスプリント目標や重点タスクを記入）`,
          `【期間注記】集計はJSTの週（Mon–Sun）基準です。`,
        ]
      : [
          `Overview: Weekly project summary (Range: ${p.rangeDisp}, JST).`,
          `Key KPIs: ${kpiLine}`,
          `Top 3 Problems by Avg Progress: ${top3} (Avg: ${formatNumber(
            p.avgProgressPercent
          )}%)`,
          `Status Breakdown: ${statusLine}`,
          achievementsLine,
          `Next Week Focus: (Fill in sprint goals and key tasks here)`,
          `Note: Week is based on Mon–Sun in JST.`,
        ];

  return sections.join("\n");
}

// ======================================================
// Callable: generateProgressReportDraft（週次のみ）
// ======================================================
type GenerateProgressReportDraftRequest = {
  projectId: string;
  scope?: ReportScope;
  period?: ReportPeriod;
  lang?: ReportLang;
};

type GenerateProgressReportDraftResponse = {
  title: string;
  body: string;
  metrics: {
    completedTasks: number;
    avgProgressPercent: number;
    notes: string;
  };
};

export const generateProgressReportDraft = onCall<
  GenerateProgressReportDraftRequest,
  GenerateProgressReportDraftResponse
>(
  { region: "asia-northeast1" },
  async (
    request: CallableRequest<GenerateProgressReportDraftRequest>
  ) => {
    const { projectId } = request.data ?? {};
    if (!projectId) {
      throw new HttpsError(
        "invalid-argument",
        "projectId is required"
      );
    }

    const scope: ReportScope =
      request.data?.scope === "personal"
        ? "personal"
        : "project";
    // UI は週次のみだが period 引数は念のため weekly に正規化
    const period: ReportPeriod = "weekly";
    const lang: ReportLang =
      request.data?.lang === "en" ? "en" : "ja";

    if (period !== "weekly") {
      throw new HttpsError(
        "invalid-argument",
        "Only weekly period is supported for now."
      );
    }

    if (scope === "personal") {
      const uid = request.auth?.uid;
      if (!uid) {
        throw new HttpsError(
          "unauthenticated",
          "Authentication required for personal reports"
        );
      }
    }

    const firestore = getFirestore();

    // プロジェクト全体の集計 (必須)
    const summaryRef = firestore.doc(
      `projects/${projectId}/analytics/currentSummary`
    );
    const summarySnap = await summaryRef.get();
    if (!summarySnap.exists) {
      throw new HttpsError(
        "not-found",
        "Analytics summary not found"
      );
    }
    const summary = summarySnap.data() ?? {};

    // Problem progress 正規化 & Top3
    const rawProgress: unknown[] = Array.isArray(
      (summary as any).problemProgress
    )
      ? ((summary as any).problemProgress as unknown[])
      : [];
    const normalizedProgress: ProblemProgressItem[] =
      rawProgress
        .map(
          (item: any): ProblemProgressItem => ({
            title:
              typeof item?.title === "string"
                ? item.title
                : "",
            percent:
              typeof item?.percent === "number"
                ? item.percent
                : 0,
          })
        )
        .filter(
          (it: ProblemProgressItem) =>
            it.title !== "" || it.percent > 0
        );
    normalizedProgress.sort(
      (a: ProblemProgressItem, b: ProblemProgressItem) =>
        b.percent - a.percent
    );

    const fallbackTitle =
      lang === "ja"
        ? "最重要プロブレム"
        : "Top Priority Problem";

    const topProblems: ProblemProgressItem[] =
      normalizedProgress.slice(0, 3).map(
        (p: ProblemProgressItem): ProblemProgressItem => ({
          title: p.title || fallbackTitle,
          percent: roundTo(toNumber(p.percent), 1),
        })
      );

    const avgProgressPercent = normalizedProgress.length
      ? Math.round(
          normalizedProgress.reduce(
            (total: number, cur: ProblemProgressItem) =>
              total + toNumber(cur.percent),
            0
          ) / normalizedProgress.length
        )
      : 0;

    // ステータス内訳（全体）
    const projectStatusRaw: unknown[] = Array.isArray(
      (summary as any).statusBreakdown
    )
      ? ((summary as any).statusBreakdown as unknown[])
      : [];
    const projectStatus: StatusItem[] = projectStatusRaw
      .map(
        (x: any): StatusItem => ({
          label:
            typeof x?.label === "string"
              ? x.label
              : "",
          count: toNumber(x?.count),
        })
      )
      .filter((x: StatusItem) => x.label !== "");

    // 主要KPI（全体）を初期値に
    let completedTasks7d = Math.max(
      0,
      Math.round(toNumber((summary as any).completedTasks7d))
    );
    let avgLeadTime30dDays = roundTo(
      toNumber((summary as any).avgLeadTime30dDays),
      1
    );
    let lateRateThisWeekPercent = roundTo(
      toNumber((summary as any).lateRateThisWeekPercent),
      1
    );

    // プロジェクト全体の今週完了タスク名
    const projectCompletedTaskTitlesThisWeek: string[] | undefined =
      Array.isArray(
        (summary as any).completedTaskTitlesThisWeek
      )
        ? ((summary as any)
            .completedTaskTitlesThisWeek as unknown[])
            .map((t) =>
              typeof t === "string" ? t : String(t ?? "")
            )
            .filter((t) => t.trim().length > 0)
        : undefined;

    // 個人用指標（必要時に上書き）
    let personalStatus: StatusItem[] = [];
    let personalCompletedTaskTitlesThisWeek:
      | string[]
      | undefined;

    if (scope === "personal") {
      const uid = request.auth!.uid as string;
      const personalRef = firestore.doc(
        `projects/${projectId}/analyticsPerUser/${uid}`
      );
      const personalSnap = await personalRef.get();
      const personalData = personalSnap.exists
        ? personalSnap.data() ?? {}
        : {};

      completedTasks7d = Math.max(
        0,
        Math.round(
          toNumber(
            (personalData as any).completedTasks7d
          )
        )
      );
      avgLeadTime30dDays = roundTo(
        toNumber(
          (personalData as any).avgLeadTime30dDays
        ),
        1
      );
      lateRateThisWeekPercent = roundTo(
        toNumber(
          (personalData as any)
            .lateRateThisWeekPercent
        ),
        1
      );

      const personalStatusRaw: unknown[] =
        Array.isArray(
          (personalData as any).statusBreakdown
        )
          ? ((personalData as any)
              .statusBreakdown as unknown[])
          : [];
      personalStatus = personalStatusRaw
        .map(
          (x: any): StatusItem => ({
            label:
              typeof x?.label === "string"
                ? x.label
                : "",
            count: toNumber(x?.count),
          })
        )
        .filter((x: StatusItem) => x.label !== "");

      // 個人の今週完了タスク名
      personalCompletedTaskTitlesThisWeek =
        Array.isArray(
          (personalData as any)
            .completedTaskTitlesThisWeek
        )
          ? ((personalData as any)
              .completedTaskTitlesThisWeek as unknown[])
              .map((t) =>
                typeof t === "string"
                  ? t
                  : String(t ?? "")
              )
              .filter(
                (t) => t.trim().length > 0
              )
          : undefined;
    }

    // 週範囲（JST）
    const { display: rangeDisp } = getJstWeekRange(
      new Date()
    );

    // タイトル
    const topProblemTitle =
      topProblems[0]?.title ?? fallbackTitle;
    const topProblemPercent =
      topProblems[0]?.percent ?? 0;
    const title = buildWeeklyTitle(
      scope,
      lang,
      rangeDisp
    );

    // 本文（AI Insight ではなく、安定した「主な成果・完了タスク」行を使用）
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
            topProblemPercent,
            completedTaskTitlesThisWeek:
              personalCompletedTaskTitlesThisWeek,
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
            topProblemTitle,
            topProblemPercent,
            completedTaskTitlesThisWeek:
              projectCompletedTaskTitlesThisWeek,
          });

    const notes =
      scope === "personal"
        ? lang === "ja"
          ? `最優先プロブレム: ${topProblemTitle}`
          : `Top Priority Problem: ${topProblemTitle}`
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



  

  
