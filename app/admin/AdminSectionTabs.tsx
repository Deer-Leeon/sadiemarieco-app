'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Horizontal section nav for /admin/*.
 *
 * Append to SECTIONS when adding a new admin sub-page (e.g.
 * /admin/customers, /admin/services). The tab auto-lights based on
 * usePathname(), so any page under /admin/* can render
 * <AdminSectionTabs /> with no props and no per-page wiring.
 *
 * Typographic register matches the "Sadie Marie · Admin" eyebrow used
 * throughout the admin (uppercase, 10px, letter-spacing 0.28em). That
 * means the eyebrow + tab row read as a single layered header system
 * rather than two competing typographic voices.
 *
 * Active visual: stone-900 text + a 1px stone-900 hairline that scales
 * in from the centre on hover-for-inactive / always-on for active.
 * Inactive sits at stone-400 with a stone-700 hover so the cursor
 * target is clearly clickable without shouting at the page.
 */
interface AdminSection {
  href: string;
  label: string;
}

const SECTIONS: AdminSection[] = [
  { href: '/admin', label: 'Bookings' },
  { href: '/admin/website', label: 'Website' },
];

export default function AdminSectionTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin sections"
      className="border-b border-stone-200 bg-[#FAF9F6]/95 px-6 backdrop-blur-sm"
    >
      <ul className="flex flex-wrap items-center">
        {SECTIONS.map(({ href, label }) => {
          const isActive = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={`group relative inline-block px-4 py-3 text-[10px] font-medium uppercase tracking-[0.28em] transition-colors first:pl-0 ${
                  isActive
                    ? 'text-stone-900'
                    : 'text-stone-400 hover:text-stone-700'
                }`}
              >
                {label}
                {/*
                  Hairline indicator. Always present in the DOM so the
                  scale-x transition on hover-in / hover-out is symmetric
                  (otherwise the line would pop in instantly on enter
                  and ease out on leave). For the active tab, scale-x-100
                  pins it open; for inactive, hover triggers the scale.
                */}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-x-4 bottom-0 h-px origin-center transform-gpu transition-transform duration-200 ease-out first:left-0 ${
                    isActive
                      ? 'scale-x-100 bg-stone-900'
                      : 'scale-x-0 bg-stone-400 group-hover:scale-x-100'
                  }`}
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
