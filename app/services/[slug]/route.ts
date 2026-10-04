import {
  htmlResponse,
  loadServicePage,
  renderServiceNotFound,
  renderServicePage,
} from '@/lib/seo-service-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const { slug } = await ctx.params;
  try {
    const service = await loadServicePage(slug);
    if (!service) {
      return htmlResponse(renderServiceNotFound(), 404);
    }
    return htmlResponse(renderServicePage(service));
  } catch (err) {
    console.warn('[services] menu unavailable', {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service page unavailable.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
