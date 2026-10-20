'use client';

import { useMemo, useState } from 'react';

import { STUDIO_TIMEZONE } from '@/lib/cal-config';

import styles from './book.module.css';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function studioParts(ymd: string): { y: number; m: number; d: number; weekday: number } {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
  const weekdayName = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    weekday: 'short',
  }).format(dt);
  return { y, m, d, weekday: WEEKDAYS.indexOf(weekdayName) };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function monthKey(y: number, m: number): string {
  return `${y}-${pad(m)}`;
}

function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const next = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1 };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function BookMonthCalendar({
  todayYmd,
  slotsByDay,
  selectedDay,
  onSelectDay,
  onNeedMore,
}: {
  todayYmd: string;
  slotsByDay: Record<string, string[]>;
  selectedDay: string;
  onSelectDay: (ymd: string) => void;
  onNeedMore?: () => void;
}) {
  const start = selectedDay || todayYmd;
  const initial = studioParts(start);
  const [cursor, setCursor] = useState({ y: initial.y, m: initial.m });

  const cells = useMemo(() => {
    const count = daysInMonth(cursor.y, cursor.m);
    const firstYmd = `${monthKey(cursor.y, cursor.m)}-01`;
    const lead = studioParts(firstYmd).weekday;
    const out: Array<string | null> = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= count; d += 1) {
      out.push(`${monthKey(cursor.y, cursor.m)}-${pad(d)}`);
    }
    return out;
  }, [cursor]);

  const title = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(cursor.y, cursor.m - 1, 15, 18, 0, 0)));

  return (
    <div className={styles.month}>
      <div className={styles.monthNav}>
        <p className={styles.monthTitle}>{title}</p>
        <div className={styles.monthNavBtns}>
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setCursor((c) => shiftMonth(c.y, c.m, -1))}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => {
              setCursor((c) => shiftMonth(c.y, c.m, 1));
              onNeedMore?.();
            }}
          >
            ›
          </button>
        </div>
      </div>
      <div className={styles.monthWeekdays}>
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className={styles.monthGrid}>
        {cells.map((ymd, i) => {
          if (!ymd) return <span key={`e-${i}`} />;
          const loaded = Object.prototype.hasOwnProperty.call(slotsByDay, ymd);
          const open = (slotsByDay[ymd]?.length ?? 0) > 0;
          const past = ymd < todayYmd;
          const selected = ymd === selectedDay;
          const disabled = past || (loaded && !open);
          return (
            <button
              key={ymd}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              className={`${styles.monthDay} ${selected ? styles.monthDayOn : ''} ${
                ymd === todayYmd ? styles.monthDayToday : ''
              }`}
              onClick={() => onSelectDay(ymd)}
            >
              {Number(ymd.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
