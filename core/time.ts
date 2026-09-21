// Dates and times in the vault timezone. Every name the store writes uses these,
// so two machines in different zones file the same instant under the same day.

interface Parts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function parts(date: Date, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return {
    year: out.year ?? "0000",
    month: out.month ?? "00",
    day: out.day ?? "00",
    hour: out.hour ?? "00",
    minute: out.minute ?? "00",
    second: out.second ?? "00",
  };
}

export function dayStamp(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function monthStamp(date: Date, timeZone: string): string {
  return dayStamp(date, timeZone).slice(0, 7);
}

// YYYY-MM-DDTHHMMSS: sortable and safe in file names.
export function fileStamp(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}${p.minute}${p.second}`;
}

export function timeStamp(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.hour}${p.minute}${p.second}`;
}

export function isoWithOffset(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMin = Math.round((wallAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

// Calendar arithmetic on a YYYY-MM-DD string (no timezone involved).
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}
