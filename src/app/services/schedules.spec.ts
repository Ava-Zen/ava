import { nextClock, nextRunAt } from './schedules';

describe('schedule timing', () => {
  it('picks the next clock time in local time', () => {
    const now = new Date('2026-08-29T07:00:00');
    const next = nextClock(8, 0, now);
    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('rolls a past clock to tomorrow', () => {
    const now = new Date('2026-08-29T09:00:00');
    const next = nextClock(8, 0, now);
    expect(next.getDate()).toBe(30);
    expect(next.getHours()).toBe(8);
  });

  it('uses a relative delay when given', () => {
    const now = new Date('2026-08-29T09:00:00');
    const next = nextRunAt({ hour: 8, minute: 0, delayMs: 5 * 60 * 1000 }, now);
    expect(next.getTime() - now.getTime()).toBe(5 * 60 * 1000);
  });
});
