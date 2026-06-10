// Minimal 5-field cron, next-fire computed in a FIXED-offset timezone (no DST).
// Logic validated in cron.test.mjs (5 KL cases + impossible-expr guard).
// Supports: *, N, a-b, lists (,), steps (/s). Fields: min hour dom month dow (0=Sun).
// Vixie quirk: when BOTH day-of-month and day-of-week are restricted, match EITHER.

function parseField(field: string, min: number, max: number): Set<number> | null {
  if (field === '*') return null; // null = matches anything
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step < 1) {
      throw new Error(`bad cron field: "${field}"`);
    }
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) out.add(v);
  }
  return out;
}

function parseCron(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  return {
    mins: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    doms: parseField(parts[2], 1, 31),
    mons: parseField(parts[3], 1, 12),
    dows: parseField(parts[4], 0, 6),
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

// Next fire (epoch ms, UTC) strictly after `fromMs`, for a cron interpreted in a
// fixed-offset timezone. Returns -1 if no match within ~1 year (impossible expr).
export function nextCron(expr: string, fromMs: number, tzOffsetMin: number): number {
  const { mins, hours, doms, mons, dows } = parseCron(expr);
  let t = Math.ceil((fromMs + 1) / 60000) * 60000; // next full minute
  const limit = t + 367 * 24 * 60 * 60000;
  for (; t <= limit; t += 60000) {
    const d = new Date(t + tzOffsetMin * 60000); // shift so getUTC* reads local wall-clock
    if (mins && !mins.has(d.getUTCMinutes())) continue;
    if (hours && !hours.has(d.getUTCHours())) continue;
    if (mons && !mons.has(d.getUTCMonth() + 1)) continue;
    const domOk = !doms || doms.has(d.getUTCDate());
    const dowOk = !dows || dows.has(d.getUTCDay());
    const dayOk = doms && dows ? domOk || dowOk : domOk && dowOk;
    if (dayOk) return t;
  }
  return -1;
}

export const KL_OFFSET_MIN = 480; // Asia/Kuala_Lumpur, UTC+8, no DST
