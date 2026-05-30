import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import ConsentTemplateCard from './ConsentTemplateCard';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const user = await currentUser();
  const displayName =
    user?.firstName || access.emails[0] || 'Admin';

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      <AdminHeader title="Settings" displayName={displayName} />
      <AdminSectionTabs />
      <main className="mx-auto max-w-2xl space-y-6 px-6 py-8">
        <p className="text-sm text-stone-500">
          Studio-wide configuration. Upload the consent PDF your clients
          should receive or reference.
        </p>
        <ConsentTemplateCard />
      </main>
    </div>
  );
}
