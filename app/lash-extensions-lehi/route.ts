import { htmlResponse, renderLandingHtml } from '@/lib/seo-service-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  return htmlResponse(await renderLandingHtml('lash'));
}
