export function getJstToday(): Date {
  const nowUtcMs = Date.now();
  const jstMs = nowUtcMs + 9 * 60 * 60 * 1000;
  const jstDate = new Date(jstMs);
  return new Date(Date.UTC(jstDate.getUTCFullYear(), jstDate.getUTCMonth(), jstDate.getUTCDate()));
}

export function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

export function formatYmd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseYmdToUtc(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

export function compareDate(a: Date, b: Date): number {
  const aTime = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bTime = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.sign(aTime - bTime);
}
