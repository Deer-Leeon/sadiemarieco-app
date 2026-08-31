import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import SmsMessagesClient from './SmsMessagesClient';
import SmsOutboundLogPanel from './SmsOutboundLogPanel';

export const dynamic = 'force-dynamic';

export default async function AdminSmsMessagesPage() {
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const user = await currentUser();
  const displayName = user?.firstName || access.emails[0] || 'Admin';

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      <AdminHeader title="SMS Messages" displayName={displayName} />
      <AdminSectionTabs />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <p className="mb-6 max-w-2xl text-sm leading-relaxed text-stone-600">
          Every text the studio sends for appointments. Edit the middle of each
          message; the brand prefix and STOP/HELP footer stay locked. Edits
          apply on the next send.
        </p>
        <div className="space-y-8">
          <SmsOutboundLogPanel />
          <SmsMessagesClient />
        </div>
      </main>
    </div>
  );
}
