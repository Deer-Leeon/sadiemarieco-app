import BookClient, { type BookQuery, type BookService } from './BookClient';
import { loadBookableServices } from '@/lib/book-public';

export const metadata = {
  title: 'Book',
  description: 'Book a lash or brow appointment with Sadie Marie in Lehi, UT.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function firstQueryValue(
  value: string | string[] | undefined
): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? '').trim();
}

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const bookQuery: BookQuery = {
    service: firstQueryValue(params.service),
    resumeCheckout: firstQueryValue(params.resume_checkout),
    name: firstQueryValue(params.name),
    email: firstQueryValue(params.email),
    phone: firstQueryValue(params.phone),
    time: firstQueryValue(params.time),
    redirectStatus: firstQueryValue(params.redirect_status),
    setupIntent: firstQueryValue(params.setup_intent),
    paymentIntent: firstQueryValue(params.payment_intent),
    uid: firstQueryValue(params.uid),
  };

  let initialServices: BookService[] = [];
  try {
    const rows = await loadBookableServices();
    initialServices = rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      category: row.category,
      description: row.description,
      priceLabel: row.priceLabel,
      priceCents: row.priceCents,
      durationMins: row.durationMins,
      durationLabel: row.durationLabel,
    }));
  } catch (err) {
    console.error(
      '[book] failed to load services for first paint',
      err instanceof Error ? err.message : err
    );
  }

  return (
    <BookClient initialServices={initialServices} bookQuery={bookQuery} />
  );
}
