// Calendar days in Barcelona time and the day-only visitor fingerprint.
import { createHash, randomBytes } from 'node:crypto';

const TIME_ZONE = 'Europe/Madrid';
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

export function localDayHour(ms: number): { day: string; hour: number } {
  const p = Object.fromEntries(parts.formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The salt changes every day and is deleted afterwards, so the same person cannot be followed
// from one day to the next, and the address cannot be recovered from the fingerprint.
export function visitorId(salt: string, address: string, userAgent: string, project: string): string {
  return createHash('sha256').update(`${salt}\n${address}\n${userAgent}\n${project}`).digest('hex').slice(0, 16);
}

// Today's salt, kept only in memory: a leaked database cannot be used to try every address against
// the fingerprints. A restart in the middle of a day starts a new salt (that day may count someone twice).
export class DailySalt {
  #day = '';
  #salt = '';

  for(day: string): string {
    if (day !== this.#day) {
      this.#day = day;
      this.#salt = randomBytes(32).toString('hex');
    }
    return this.#salt;
  }
}
