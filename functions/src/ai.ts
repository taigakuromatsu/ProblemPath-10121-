// functions/src/ai.ts
import { OpenAI } from "openai";

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

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const SYSTEM_EN = `You generate concise, actionable issue titles for a Kanban/issue tracker. Reply ONLY with a JSON: {"suggestions": string[]}.`;
const SYSTEM_JA = `あなたは課題管理ツール向けに、短く実行可能なイシュータイトルを生成します。出力はJSONのみ: {"suggestions": string[]}.`;

export class AiClient {
  private client: OpenAI;
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("[AI] OPENAI_API_KEY is not set");
    this.client = new OpenAI({ apiKey });
  }

  async suggestIssues(input: IssueSuggestInput): Promise<IssueSuggestOutput> {
    const sys = input.lang === "ja" ? SYSTEM_JA : SYSTEM_EN;
    const preferLang = input.lang === "ja" ? "Japanese" : "English";

    const prompt = [
      `Project ID: ${input.projectId}`,
      `Problem Title: ${input.problem.title}`,
      input.problem.phenomenon ? `Phenomenon: ${input.problem.phenomenon}` : "",
      input.problem.cause ? `Cause: ${input.problem.cause}` : "",
      input.problem.solution ? `Solution: ${input.problem.solution}` : "",
      input.problem.goal ? `Goal/KPI: ${input.problem.goal}` : "",
      "",
      `Return ${preferLang} issue titles only. 5–7 items.`,
      `Rules:`,
      `- 8–36 characters`,
      `- Start with a verb`,
      `- Specific & scannable`,
      `- No numbering, no markdown`,
      `- Avoid duplicates`,
    ].filter(Boolean).join("\n");

    const resp = await this.client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" } as any,
    });

    const text = resp.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch {}
    const arr = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    const suggestions = arr
      .map((s: unknown) => (typeof s === "string" ? s.trim() : ""))
      .filter((s: string) => s.length > 0)
      .slice(0, 7);

    return { suggestions };
  }
}
