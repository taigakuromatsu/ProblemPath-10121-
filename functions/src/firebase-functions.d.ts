declare module "firebase-functions/v2/https" {
  type Request = unknown;
  interface Response {
    status(code: number): Response;
    send(body: unknown): void;
  }
  export function onRequest(
    handler: (req: Request, res: Response) => unknown | Promise<unknown>
  ): unknown;
}

declare module "firebase-functions/v2/scheduler" {
  type Schedule = string | { schedule: string; timeZone?: string };
  export function onSchedule(
    schedule: Schedule,
    handler: (...args: unknown[]) => unknown | Promise<unknown>
  ): unknown;
}
