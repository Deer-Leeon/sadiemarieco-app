import ConsentDocumentClient from './ConsentDocumentClient';

export const metadata = {
  title: 'Your signed consent',
  description: 'View and download your signed Sadie Marie intake and consent form.',
  robots: { index: false, follow: false },
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
