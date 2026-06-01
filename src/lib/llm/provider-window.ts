const DAY_TO_INDEX: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface WeeklyWindow {
  startMinute: number;
  endMinute: number;
}

export function parseWeeklyWindow(value: string): WeeklyWindow | null {
  const match = value
    .trim()
    .toUpperCase()
    .match(/^([A-Z]{3})\s+(\d{2}):(\d{2})-([A-Z]{3})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;

  const startDay = DAY_TO_INDEX[match[1]];
  const endDay = DAY_TO_INDEX[match[4]];
  const startHour = Number(match[2]);
  const startMinute = Number(match[3]);
  const endHour = Number(match[5]);
  const endMinute = Number(match[6]);

  if (
    startDay === undefined ||
    endDay === undefined ||
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    return null;
  }

  return {
    startMinute: startDay * 24 * 60 + startHour * 60 + startMinute,
    endMinute: endDay * 24 * 60 + endHour * 60 + endMinute,
  };
}

export function isWithinWeeklyWindow(
  value: string,
  timeZone: string,
  now = new Date(),
): boolean {
  if (!value.trim()) return true;

  const window = parseWeeklyWindow(value);
  if (!window) return false;

  const currentMinute = getZonedMinuteOfWeek(now, timeZone);
  if (currentMinute === null) return false;
  if (window.endMinute > window.startMinute) {
    return currentMinute >= window.startMinute && currentMinute < window.endMinute;
  }

  return currentMinute >= window.startMinute || currentMinute < window.endMinute;
}

export function isClaudeCodeWithinAllowedWindow(now = new Date()): boolean {
  return isWithinWeeklyWindow(
    process.env.CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW ?? "",
    process.env.CLAUDE_CODE_WINDOW_TZ ?? "Asia/Tokyo",
    now,
  );
}

function getZonedMinuteOfWeek(now: Date, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return null;
  }

  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;

  if (!weekday || hour === undefined || minute === undefined) return null;
  return WEEKDAY_TO_INDEX[weekday] * 24 * 60 + Number(hour) * 60 + Number(minute);
}
