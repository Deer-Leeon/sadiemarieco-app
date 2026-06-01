import ConsentDocumentClient from './ConsentDocumentClient';

export const metadata = {
  title: 'Your signed consent · Sadie Marie',
  description: 'View and download your signed Sadie Marie intake and consent form.',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PageProps = {
  params: Promise<{ clientId: string }>;
};

export default async function ConsentDocumentPage({ params }: PageProps) {
  const { clientId } = await params;
  return <ConsentDocumentClient clientId={clientId} />;
}
