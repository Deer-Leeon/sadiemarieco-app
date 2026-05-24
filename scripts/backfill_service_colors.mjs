// One-shot backfill that pre-populates `site_services.color` with the
// colours the legacy auto-matcher used to derive at runtime.
//
// Why this exists:
//   We removed the runtime auto-matcher (keyword + duration probes
//   in app/admin/serviceColors.ts) so every service's calendar colour
//   is now editor-controlled exclusively. Without backfill, every
//   existing service would lose its colour on the next page render
//   until the studio re-assigned them by hand. This script preserves
//   the visual state at the moment of the cut-over by writing the
//   inferred hex into the new `color` column.
//
// Behaviour:
//   • Idempotent — only touches rows where `color IS NULL`. Re-runs
//     after an editor has set a colour are no-ops on that row.
//   • Skips group headers (is_group = TRUE) since groups don't appear
//     on the calendar — they're CMS-only accordion shells.
//   • Logs every write so the operator can eyeball the cut-over.
//
// Usage:
//   node --env-file=.env.local scripts/backfill_service_colors.mjs
//
// After this runs, the auto-matcher branch can be removed from
// app/admin/serviceColors.ts without any visual regression.
import { sql } from '@vercel/postgres';

/**
 * Source-of-truth palette — mirrors the SERVICE_COLORS map that used
 * to live in app/admin/serviceColors.ts. Kept inline here so this
 * script is self-contained and survives the matcher's deletion.
 */
const PALETTE = {
  FULL_SET: '#FE036A',
  FIRST_TIME_FILL: '#F5347F',
  FOUR_WEEK_FILL: '#F58D93',
  THREE_WEEK_FILL: '#F99DBC',
  TWO_WEEK_FILL: '#FEC2D6',
  KOREAN_LIFT: '#8FD9FB',
  LAM_TINT_WAX: '#5DAE5D',
  BROW_SHAPE: '#90C890',
  BROW_ADD_ON: '#CBE5CB',
};

/**
 * Mirror of the legacy two-pass matcher. Pass 1 = title/slug keyword
 * probes ordered most-specific first; Pass 2 = duration fallback for
 * bare Classic/Hybrid/Volume fill children whose titles+slugs don't
 * disambiguate which fill-week group they belong to.
 *
 * Returns the hex string or `null` if the service didn't match any
 * rule (which means the editor will need to assign a colour by hand).
 */
function inferColor({ title, slug, durationMins }) {
  const t = (title || '').toLowerCase();
  const s = (slug || '').toLowerCase();
  const hay = `${t} ${s}`;
  const has = (...needles) => needles.some((n) => hay.includes(n));

  if (has('full set', 'full-set', 'fullset')) return PALETTE.FULL_SET;
  if (has('first time', 'first-time', 'firsttime'))
    return PALETTE.FIRST_TIME_FILL;
  if (has('4 week', '4-week', '4week')) return PALETTE.FOUR_WEEK_FILL;
  if (has('3 week', '3-week', '3week')) return PALETTE.THREE_WEEK_FILL;
  if (has('2 week', '2-week', '2week')) return PALETTE.TWO_WEEK_FILL;
  if (has('korean')) return PALETTE.KOREAN_LIFT;
  if (has('lamination', 'lam tint', 'lam-tint')) return PALETTE.LAM_TINT_WAX;
  if (has('brow shape', 'brow-shape', 'brow wax', 'brow-wax'))
    return PALETTE.BROW_SHAPE;
  if (has('brow add', 'brow-add')) return PALETTE.BROW_ADD_ON;

  // Duration fallback for ambiguous fill children — same 120 / 150 /
  // 180 minute mapping the runtime matcher used.
  const bareFillChild = t === 'classic' || t === 'hybrid' || t === 'volume';
  if (bareFillChild && typeof durationMins === 'number') {
    if (durationMins === 120) return PALETTE.TWO_WEEK_FILL;
    if (durationMins === 150) return PALETTE.THREE_WEEK_FILL;
    if (durationMins === 180) return PALETTE.FOUR_WEEK_FILL;
  }
  return null;
}

async function main() {
  const { rows } = await sql`
    SELECT id, title, slug, duration_mins, color, is_group
    FROM site_services
    WHERE is_active = TRUE
      AND is_group = FALSE
      AND color IS NULL
    ORDER BY id ASC
  `;

  if (rows.length === 0) {
    console.log('No services need backfill — every active row already has a color.');
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const hex = inferColor({
      title: row.title,
      slug: row.slug,
      durationMins: row.duration_mins,
    });
    if (!hex) {
      console.log(`  ↷ skip id=${row.id} "${row.title}" — no rule matched`);
      skipped += 1;
      continue;
    }
    await sql`UPDATE site_services SET color = ${hex} WHERE id = ${row.id}`;
    console.log(`  ✓ id=${row.id} "${row.title}" → ${hex}`);
    updated += 1;
  }

  console.log(
    `\nDone. ${updated} service(s) backfilled, ${skipped} skipped (no rule matched — assign in /admin/services).`
  );
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
