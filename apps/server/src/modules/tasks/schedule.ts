export type ScheduleFrequency = "MONTHLY" | "YEARLY";

export function localDateAt(value: Date) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clampedDate(year: number, month: number, day: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

export function currentOccurrence(
  frequency: ScheduleFrequency,
  anchorOn: Date,
  now: Date,
) {
  const localToday = localDateAt(now);
  const [year, month] = localToday.split("-").map(Number);
  const anchorDay = anchorOn.getUTCDate();
  const anchorMonth = anchorOn.getUTCMonth() + 1;

  if (frequency === "MONTHLY") {
    const dueOn = clampedDate(year!, month!, anchorDay);
    const periodKey = `${year}-${String(month).padStart(2, "0")}`;
    return { periodKey, dueOn, localDueOn: dueOn.toISOString().slice(0, 10) };
  }

  const candidate = clampedDate(year!, anchorMonth, anchorDay);
  return {
    periodKey: String(year),
    dueOn: candidate,
    localDueOn: candidate.toISOString().slice(0, 10),
  };
}

export function firstOccurrenceOnOrAfter(
  frequency: ScheduleFrequency,
  anchorOn: Date,
  effectiveFromOn: string,
) {
  let occurrence = currentOccurrence(
    frequency,
    anchorOn,
    localSlotUtc(effectiveFromOn, "00:00"),
  );
  if (occurrence.localDueOn < effectiveFromOn) {
    occurrence = followingOccurrence(frequency, anchorOn, occurrence.periodKey);
  }
  return occurrence;
}

export function nextCycleOccurrence(
  frequency: ScheduleFrequency,
  anchorOn: Date,
  now: Date,
) {
  const current = currentOccurrence(frequency, anchorOn, now);
  return followingOccurrence(frequency, anchorOn, current.periodKey);
}

export function followingOccurrence(
  frequency: ScheduleFrequency,
  anchorOn: Date,
  periodKey: string,
) {
  const anchorDay = anchorOn.getUTCDate();
  const anchorMonth = anchorOn.getUTCMonth() + 1;
  if (frequency === "MONTHLY") {
    const [yearValue, monthValue] = periodKey.split("-").map(Number);
    const next = new Date(Date.UTC(yearValue!, monthValue! - 1, 1));
    next.setUTCMonth(next.getUTCMonth() + 1);
    const dueOn = clampedDate(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      anchorDay,
    );
    const year = next.getUTCFullYear();
    const month = next.getUTCMonth() + 1;
    return {
      periodKey: `${year}-${String(month).padStart(2, "0")}`,
      dueOn,
      localDueOn: dueOn.toISOString().slice(0, 10),
    };
  }
  const nextYear = Number(periodKey) + 1;
  const dueOn = clampedDate(nextYear, anchorMonth, anchorDay);
  return {
    periodKey: String(nextYear),
    dueOn,
    localDueOn: dueOn.toISOString().slice(0, 10),
  };
}

export function localSlotUtc(localDate: string, localTime: string) {
  return new Date(`${localDate}T${localTime}:00.000+08:00`);
}
