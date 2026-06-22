/**
 * Regenerate static HTML previews for all appointment reminder emails.
 * Run: npx tsx scripts/generate-email-previews.ts
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  buildReminderBodyCopy,
  reminderEmailSubject,
} from '../lib/appointment-reminder-copy';
import { generateReminderHtml } from '../lib/email-templates';

const OUT_DIR = path.join(process.cwd(), 'email-previews');

const SAMPLE = {
  browsService: 'Brow Lamination, Tint + Wax',
  lashesService: 'Classic Full Set',
  date: 'Tuesday, March 18',
  time: '10:30am',
  cancelUrl: 'https://www.sadiemarie.co/manage.html?uid=preview-sample',
};

interface PreviewVariant {
  id: string;
  title: string;
  category: 'Brows' | 'Lashes';
  kind: 'brows' | 'lashes';
  timing: 'lead' | '1h' | 'immediate';
  minutesUntil?: number;
  serviceName: string;
  whenSent: string;
  skipNote: string;
}

const VARIANTS: PreviewVariant[] = [
  {
    id: 'brows-48h',
    title: 'Brows — 48 hours before',
    category: 'Brows',
    kind: 'brows',
    timing: 'lead',
    serviceName: SAMPLE.browsService,
    whenSent: '48 hours before the appointment',
    skipNote: 'Not sent if the client books less than 48 hours before.',
  },
  {
    id: 'lashes-24h',
    title: 'Lashes — 24 hours before',
    category: 'Lashes',
    kind: 'lashes',
    timing: 'lead',
    serviceName: SAMPLE.lashesService,
    whenSent: '24 hours before the appointment',
    skipNote: 'Not sent if the client books less than 24 hours before.',
  },
  {
    id: 'brows-1h',
    title: 'Brows — 1 hour before',
    category: 'Brows',
    kind: 'brows',
    timing: '1h',
    serviceName: SAMPLE.browsService,
    whenSent: '1 hour before the appointment',
    skipNote: 'Always scheduled when the appointment is more than 1 hour away.',
  },
  {
    id: 'lashes-1h',
    title: 'Lashes — 1 hour before',
    category: 'Lashes',
    kind: 'lashes',
    timing: '1h',
    serviceName: SAMPLE.lashesService,
    whenSent: '1 hour before the appointment',
    skipNote: 'Always scheduled when the appointment is more than 1 hour away.',
  },
  {
    id: 'brows-immediate-30m',
    title: 'Brows — immediate (booked ~30 min before)',
    category: 'Brows',
    kind: 'brows',
    timing: 'immediate',
    minutesUntil: 30,
    serviceName: SAMPLE.browsService,
    whenSent: 'Immediately at booking (appointment less than 1 hour away)',
    skipNote: 'Time phrase is dynamic, e.g. “in 30 minutes!”',
  },
  {
    id: 'lashes-immediate-30m',
    title: 'Lashes — immediate (booked ~30 min before)',
    category: 'Lashes',
    kind: 'lashes',
    timing: 'immediate',
    minutesUntil: 30,
    serviceName: SAMPLE.lashesService,
    whenSent: 'Immediately at booking (appointment less than 1 hour away)',
    skipNote: 'Time phrase is dynamic, e.g. “in 30 minutes!”',
  },
];

function buildPreviewHtml(variant: PreviewVariant): string {
  const bodyCopy = buildReminderBodyCopy({
    serviceName: variant.serviceName,
    kind: variant.kind,
    timing: variant.timing,
    minutesUntil: variant.minutesUntil,
  });

  return generateReminderHtml({
    serviceName: variant.serviceName,
    appointmentDate: SAMPLE.date,
    appointmentTime: SAMPLE.time,
    bodyCopy,
    cancelUrl: SAMPLE.cancelUrl,
  });
}

function buildIndexHtml(): string {
  const cards = VARIANTS.map((variant) => {
    const subject = reminderEmailSubject(variant.serviceName);
    const bodyCopy = buildReminderBodyCopy({
      serviceName: variant.serviceName,
      kind: variant.kind,
      timing: variant.timing,
      minutesUntil: variant.minutesUntil,
    });

    return `
      <section class="card" id="${variant.id}">
        <header class="card-header">
          <span class="pill pill--${variant.kind}">${variant.category}</span>
          <h2>${variant.title}</h2>
          <dl class="meta">
            <div><dt>Subject</dt><dd>${subject}</dd></div>
            <div><dt>When sent</dt><dd>${variant.whenSent}</dd></div>
            <div><dt>Rule</dt><dd>${variant.skipNote}</dd></div>
          </dl>
          <p class="body-preview"><strong>Beige body copy:</strong> ${bodyCopy}</p>
          <p class="links">
            <a href="./${variant.id}.html" target="_blank">Open full email ↗</a>
          </p>
        </header>
        <iframe
          src="./${variant.id}.html"
          title="${variant.title}"
          loading="lazy"
        ></iframe>
      </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sadie Marie — Appointment Email Previews</title>
  <style>
    :root {
      --cream: #ebe8e4;
      --navy: #0d1b2a;
      --mist: #586574;
      --border: #d5d0ca;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background: var(--cream);
      color: var(--navy);
      line-height: 1.5;
    }
    .page {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 20px 64px;
    }
    h1 {
      font-size: 2rem;
      letter-spacing: -0.03em;
      margin: 0 0 8px;
    }
    .intro {
      max-width: 720px;
      color: var(--mist);
      margin-bottom: 32px;
    }
    .intro strong { color: var(--navy); }
    .schedule {
      display: grid;
      gap: 12px;
      margin-bottom: 40px;
      padding: 20px 24px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .schedule h2 {
      margin: 0 0 8px;
      font-size: 1.1rem;
    }
    .schedule table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95rem;
    }
    .schedule th, .schedule td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    .schedule th { width: 28%; color: var(--mist); font-weight: 600; }
    .grid {
      display: grid;
      gap: 32px;
    }
    .card {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(13, 27, 42, 0.06);
    }
    .card-header {
      padding: 20px 24px 16px;
      border-bottom: 1px solid var(--border);
    }
    .card-header h2 {
      margin: 8px 0 12px;
      font-size: 1.35rem;
      letter-spacing: -0.02em;
    }
    .pill {
      display: inline-block;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 999px;
    }
    .pill--brows { background: #e8dfd4; color: #5c4a3a; }
    .pill--lashes { background: #dde4eb; color: #2a4460; }
    .meta {
      display: grid;
      gap: 8px;
      margin: 0 0 12px;
      font-size: 0.92rem;
    }
    .meta div { display: grid; grid-template-columns: 110px 1fr; gap: 8px; }
    .meta dt { color: var(--mist); font-weight: 600; margin: 0; }
    .meta dd { margin: 0; }
    .body-preview {
      font-size: 0.92rem;
      color: var(--mist);
      margin: 0 0 8px;
    }
    .links a {
      color: #2a4460;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 0.88rem;
      font-weight: 600;
    }
    iframe {
      display: block;
      width: 100%;
      height: 920px;
      border: 0;
      background: var(--cream);
    }
    @media (max-width: 640px) {
      .meta div { grid-template-columns: 1fr; }
      iframe { height: 760px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <h1>Appointment reminder emails</h1>
    <p class="intro">
      Static previews generated from the live <code>generateReminderHtml</code> template.
      <strong>No email is sent at booking</strong> — clients still get the confirmation SMS immediately.
      All variants share the same layout: cursive <em>“Your appointment is almost here!”</em>,
      navy banner with date/time, beige body with prep instructions, and a Cancel/Reschedule button.
    </p>

    <section class="schedule">
      <h2>Send schedule at a glance</h2>
      <table>
        <thead>
          <tr>
            <th>Appointment type</th>
            <th>Lead reminder</th>
            <th>1-hour reminder</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Brow Services</strong> (incl. Teeth Whitening)</td>
            <td>48 hours before — skipped if booked &lt; 48h out</td>
            <td>1 hour before — or sent immediately with dynamic time if booked &lt; 1h out</td>
          </tr>
          <tr>
            <td><strong>Lash Services</strong></td>
            <td>24 hours before — skipped if booked &lt; 24h out</td>
            <td>1 hour before — or sent immediately with dynamic time if booked &lt; 1h out</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="grid">
      ${cards}
    </div>
  </main>
</body>
</html>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const variant of VARIANTS) {
  const filePath = path.join(OUT_DIR, `${variant.id}.html`);
  fs.writeFileSync(filePath, buildPreviewHtml(variant), 'utf8');
}

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), buildIndexHtml(), 'utf8');

console.log(`Wrote ${VARIANTS.length + 1} files to ${OUT_DIR}/`);
