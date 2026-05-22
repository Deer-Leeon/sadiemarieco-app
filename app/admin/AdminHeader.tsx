'use client';

import { SignOutButton } from '@clerk/nextjs';
import { LogOut } from 'lucide-react';

/**
 * Shared chrome for every /admin/* page header.
 *
 * Purpose: every /admin/* page renders the same eyebrow + page title +
 * sign-out cluster, so the header geometry stays pixel-stable when
 * clicking between section tabs (only the body underneath actually
 * changes). Without a shared component, headers drift apart and tab
 * switches cause perceived "page jumps" that erode the polished feel.
 *
 * Layout invariants (must stay in sync with the bookings DateNav and
 * AdminSectionTabs row heights for the no-shift contract to hold):
 *   - px-6 py-4         (16px vertical, 24px lateral)
 *   - font-serif text-2xl on the title (the "thin" register the
 *     editor explicitly liked)
 *   - sm:flex-row sm:justify-between for the eyebrow/title group on
 *     the left and the control cluster on the right
 *   - border-b stone-200 so it sits flush above <AdminSectionTabs />
 *
 * Client component because <SignOutButton /> from @clerk/nextjs is
 * client-only. Marking the header 'use client' also lets DashboardUI
 * (a client component) and the /admin/website page (a server
 * component) both import the same module — server components are
 * allowed to render client components.
 */
interface Props {
  /** Section-specific page title shown next to "Sadie Marie · Admin". */
  title: string;
  /** Display name for the right cluster (firstName → email → 'Admin'). */
  displayName: string;
  /**
   * Optional page-specific controls rendered to the LEFT of the
   * display name. Used by the bookings dashboard for the view-mode
   * toggle (List / 3 Day / Week / Month). Pages with no extra
   * controls (e.g. /admin/website) simply omit children.
   */
  children?: React.ReactNode;
}

export default function AdminHeader({ title, displayName, children }: Props) {
  return (
    <header className="flex flex-col gap-3 border-b border-stone-200 bg-[#FAF9F6]/95 px-6 py-4 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
          Sadie Marie · Admin
        </p>
        <h1 className="font-serif text-2xl leading-tight text-stone-900">
          {title}
        </h1>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {children}
        <span className="hidden text-sm text-stone-500 md:inline">
          {displayName}
        </span>
        <SignOutButton redirectUrl="/">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </SignOutButton>
      </div>
    </header>
  );
}
