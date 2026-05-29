'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import {
  buildManualBookingServiceMenu,
  type ManualBookingServiceGroupHeader,
  type ManualBookingServiceOption,
} from './manual-booking-utils';

const SERVICE_CARD_CLASS =
  'w-full rounded-lg border px-4 py-3 text-left transition-colors';

interface Props {
  services: ManualBookingServiceOption[];
  groupHeaders: ManualBookingServiceGroupHeader[];
  selectedService: ManualBookingServiceOption | null;
  onSelectService: (service: ManualBookingServiceOption) => void;
}

export default function ManualBookingServicePicker({
  services,
  groupHeaders,
  selectedService,
  onSelectService,
}: Props) {
  const menu = useMemo(
    () => buildManualBookingServiceMenu(services, groupHeaders),
    [services, groupHeaders]
  );

  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    () => new Set()
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(
    () => new Set(groupHeaders.map((g) => g.id))
  );

  function toggleCategory(category: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function toggleGroup(groupId: number) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  const hasBookable = services.length > 0;
  const hasMenu = menu.some((s) => s.rows.length > 0 || s.comingSoon);

  if (!hasMenu) {
    return (
      <p className="text-sm text-stone-500">
        No bookable services found. Add services in the Services tab first.
      </p>
    );
  }

  return (
    <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
      {menu.map(({ category, rows, comingSoon }) => {
        const categoryCollapsed = collapsedCategories.has(category);
        return (
          <section key={category} aria-label={category} className="space-y-2">
            <button
              type="button"
              onClick={() => toggleCategory(category)}
              aria-expanded={!categoryCollapsed}
              className="flex w-full items-center gap-2 border-b border-stone-200/80 pb-1 text-left"
            >
              {categoryCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-400" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-stone-400" />
              )}
              <span className="text-[10px] font-medium uppercase tracking-[0.36em] text-stone-500">
                {category}
              </span>
            </button>

            {!categoryCollapsed && comingSoon && (
              <p className="pl-5 text-sm italic text-stone-400">Coming soon.</p>
            )}

            {!categoryCollapsed && !comingSoon && rows.length > 0 && (
              <ul className="space-y-2">
                {rows.map((row) => {
                  if (row.kind === 'standalone') {
                    return (
                      <ServiceCard
                        key={row.service.slug}
                        service={row.service}
                        selected={selectedService?.slug === row.service.slug}
                        onSelect={onSelectService}
                      />
                    );
                  }

                  const groupCollapsed = collapsedGroups.has(row.groupId);
                  return (
                    <li key={`group-${row.groupId}`} className="space-y-1">
                      <button
                        type="button"
                        onClick={() => toggleGroup(row.groupId)}
                        aria-expanded={!groupCollapsed}
                        className="flex w-full items-center gap-2 rounded-md py-1 pl-1 text-left hover:bg-stone-100/80"
                      >
                        {groupCollapsed ? (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-400" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-stone-400" />
                        )}
                        <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-stone-400">
                          Group
                        </span>
                        <span className="font-serif text-sm text-stone-800">
                          {row.groupTitle}
                        </span>
                        {groupCollapsed && row.children.length > 0 && (
                          <span className="ml-auto shrink-0 text-xs text-stone-400">
                            {row.children.length} service
                            {row.children.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </button>
                      {!groupCollapsed && row.children.length > 0 && (
                        <ul className="ml-2 space-y-2 border-l border-stone-200/80 pl-2">
                          {row.children.map((child) => (
                            <ServiceCard
                              key={child.slug}
                              service={child}
                              selected={selectedService?.slug === child.slug}
                              onSelect={onSelectService}
                            />
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {!categoryCollapsed &&
              !comingSoon &&
              rows.length === 0 &&
              hasBookable && (
                <p className="pl-5 text-sm text-stone-400">
                  No services in this category.
                </p>
              )}
          </section>
        );
      })}
    </div>
  );
}

function ServiceCard({
  service,
  selected,
  onSelect,
}: {
  service: ManualBookingServiceOption;
  selected: boolean;
  onSelect: (service: ManualBookingServiceOption) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(service)}
        className={`${SERVICE_CARD_CLASS} ${
          selected
            ? 'border-stone-300 bg-stone-50'
            : 'border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50'
        }`}
      >
        <span className="block font-serif text-base text-stone-900">
          {service.title}
        </span>
        {service.durationMins != null && (
          <span className="mt-0.5 block text-xs text-stone-500">
            {service.durationMins} min
          </span>
        )}
      </button>
    </li>
  );
}
