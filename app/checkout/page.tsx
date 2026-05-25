import { Suspense } from 'react';

import { getAppointmentHoldByCalUid } from '@/lib/appointment-hold';
import { isHoldExpired } from '@/lib/booking-hold';

import CheckoutClient from './CheckoutClient';

export const metadata = {
  title: 'Secure your appointment · Sadie Marie',
  description:
    'Save a card on file to confirm your Sadie Marie Beauty Studio booking.',
};

type CheckoutPageProps = {
  searchParams: Promise<{ uid?: string }>;
};

/**
 * Cal.com redirects clients here after they pick a slot. The booking is
 * created on Cal in PENDING status (configured on the event-type so it
 * requires confirmation), the client lands on this page to vault a card
 * within an 8-minute hold window, and our `/api/booking/confirm` route
 * accepts the booking on Cal once the card is saved.
 *
 * Why this is a Server Component wrapping a Suspense:
 *   • `useSearchParams()` inside the client child suspends until the
 *     URL is available. Next.js requires that the suspension boundary
 *     be explicit, otherwise the entire route is forced into client-
 *     side dynamic rendering and emits a build-time warning.
 *   • Keeping page.tsx server-side lets us export `metadata` (which
 *     can't live on a Client Component) so the tab title reads
 *     "Secure your appointment" instead of the parent layout default.
 *
 * The fallback is a minimal cream-on-cream skeleton so the page never
 * flashes a stark white screen between server paint and client mount.
 */
export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const sp = await searchParams;
  const uid = sp.uid?.trim() ?? '';

  let initialHoldCreatedAt: string | null = null;
  let initialHoldExpired = false;

  if (uid) {
    const hold = await getAppointmentHoldByCalUid(uid);
    if (hold) {
      initialHoldCreatedAt = hold.created_at;
      initialHoldExpired =
        (hold.status || '').toLowerCase() === 'canceled_by_system' ||
        isHoldExpired(hold.created_at);
    }
  }

  return (
    <Suspense fallback={<CheckoutSkeleton />}>
      <CheckoutClient
        initialHoldCreatedAt={initialHoldCreatedAt}
        initialHoldExpired={initialHoldExpired}
      />
    </Suspense>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#FAF9F6] font-sans">
      <div className="flex flex-col items-center gap-3">
        <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-stone-300" />
        <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
          Preparing your secure checkout
        </p>
      </div>
    </div>
  );
}
