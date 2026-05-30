import ConsentFormClient from './ConsentFormClient';

export const metadata = {
  title: 'Client intake & consent · Sadie Marie',
  description: 'Complete your intake and consent form for Sadie Marie Beauty Studio.',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PageProps = {
  params: Promise<{ clientId: string }>;
};

export default async function ConsentPage({ params }: PageProps) {
  const { clientId } = await params;
  return <ConsentFormClient clientId={clientId} />;
}
