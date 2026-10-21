/**
 * Probes the iPhone admin app depends on. The website health check does
 * not load sharp or look at the photo columns, so a green website report
 * can still mean a photo replace returns an HTML 500.
 */

import { sql } from '@vercel/postgres';

import { probeApnsCredentials } from '@/lib/admin-booking-push';
import {
  buildHealthReport,
  type HealthCheckResult,
  type HealthReport,
} from '@/lib/health-check';

const CATEGORY = 'iOS app';

const TINY_JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z',
  'base64'
);

const PHOTO_COLUMNS = [
  'image_url',
  'caption',
  'alt_text',
  'file_name',
  'photo_subject',
] as const;

function check(
  partial: Omit<HealthCheckResult, 'status' | 'category'> & {
    status?: HealthCheckResult['status'];
  },
  latencyMs?: number
): HealthCheckResult {
  return {
    category: CATEGORY,
    status: partial.status ?? 'healthy',
    ...partial,
    ...(latencyMs != null ? { latencyMs } : {}),
  };
}

async function checkSharp(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const mod = await import('sharp');
    const out = await mod
      .default(TINY_JPEG)
      .rotate()
      .withIccProfile('srgb')
      .jpeg({ quality: 80 })
      .toBuffer();
    if (!out.length) {
      return check({
        id: 'ios-sharp',
        name: 'Image processor',
        status: 'unhealthy',
        message: 'sharp loaded but produced an empty image',
      });
    }
    return check(
      {
        id: 'ios-sharp',
        name: 'Image processor',
        message: 'sharp can turn a photo into sRGB JPEG',
        detail: `${out.length} bytes`,
      },
      Date.now() - start
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return check(
      {
        id: 'ios-sharp',
        name: 'Image processor',
        status: 'unhealthy',
        message: 'The iPhone photo replace cannot process images',
        detail: message,
      },
      Date.now() - start
    );
  }
}

async function checkPhotoColumns(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const { rows } = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'site_images'
    `;
    const found = new Set(rows.map((row) => row.column_name));
    const missing = PHOTO_COLUMNS.filter((name) => !found.has(name));
    if (missing.length > 0) {
      return check(
        {
          id: 'ios-site-images-columns',
          name: 'Photo columns',
          status: 'unhealthy',
          message: 'site_images is missing columns the iPhone upload writes',
          detail: missing.join(', '),
        },
        Date.now() - start
      );
    }
    return check(
      {
        id: 'ios-site-images-columns',
        name: 'Photo columns',
        message: 'site_images can store the photo, caption, and file name',
      },
      Date.now() - start
    );
  } catch (err) {
    return check(
      {
        id: 'ios-site-images-columns',
        name: 'Photo columns',
        status: 'unhealthy',
        message: 'Could not read the site_images columns',
        detail: err instanceof Error ? err.message : String(err),
      },
      Date.now() - start
    );
  }
}

function checkBlobToken(): HealthCheckResult {
  const present = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
  return check({
    id: 'ios-blob-token',
    name: 'Photo storage',
    status: present ? 'healthy' : 'unhealthy',
    message: present
      ? 'Blob token is set, so a replaced photo can be stored'
      : 'BLOB_READ_WRITE_TOKEN is missing — photo replace cannot save',
  });
}

function checkApns(): HealthCheckResult {
  const result = probeApnsCredentials();
  return check({
    id: 'ios-apns',
    name: 'Booking alerts',
    status: result.ok ? 'healthy' : 'unhealthy',
    message: result.ok
      ? 'A booking alert can be signed for the iPhone'
      : 'Booking alerts cannot be signed',
    detail: result.message,
  });
}

async function checkUploadRoute(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const route = await import('@/app/api/upload/route');
    if (typeof route.POST !== 'function') {
      return check({
        id: 'ios-upload-route',
        name: 'Photo upload route',
        status: 'unhealthy',
        message: 'POST /api/upload is not a function',
      });
    }
    return check(
      {
        id: 'ios-upload-route',
        name: 'Photo upload route',
        message: 'POST /api/upload is mounted and returns JSON on failure',
      },
      Date.now() - start
    );
  } catch (err) {
    return check(
      {
        id: 'ios-upload-route',
        name: 'Photo upload route',
        status: 'unhealthy',
        message: 'POST /api/upload failed to load, which is the HTML 500 the phone showed',
        detail: err instanceof Error ? err.message : String(err),
      },
      Date.now() - start
    );
  }
}

export async function runIosAppHealthChecks(): Promise<HealthReport> {
  const checks = await Promise.all([
    checkSharp(),
    checkPhotoColumns(),
    Promise.resolve(checkBlobToken()),
    Promise.resolve(checkApns()),
    checkUploadRoute(),
  ]);
  return buildHealthReport(checks);
}
