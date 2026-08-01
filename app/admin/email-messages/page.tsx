import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import EmailMessagesClient from './EmailMessagesClient';

export const dynamic = 'force-dynamic';

export default async function AdminEmailMessagesPage() {
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const user = await currentUser();
  const displayName = user?.firstName || access.emails[0] || 'Admin';

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      <AdminHeader title="Email Messages" displayName={displayName} />
      <AdminSectionTabs />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <p className="mb-6 max-w-2xl text-sm leading-relaxed text-stone-600">
          Editable body paragraphs for every studio email. Layout, greetings,
          buttons, and the footer stay locked — only the message content below
          is customizable. Edits apply on the next send.
        </p>
        <EmailMessagesClient />
      </main>
    </div>
  );
}
