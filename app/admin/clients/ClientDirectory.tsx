'use client';

/**
 * Interactive directory view rendered by `/admin/clients`. Receives
 * the full client roster from the server component on first paint
 * and handles all filtering client-side — see page.tsx for the
 * rationale on not paginating server-side at this scale.
 *
 * Visual language:
 *   - Cream page surface inherited from the parent (`#FAF9F6`).
 *   - White cards with `border-stone-200` + `rounded-lg`, mirroring
 *     the Bookings ListView row treatment exactly.
 *   - Three-column row layout (name+contact / phone / chevron) on
 *     desktop; collapses to a single stacked block on mobile.
 *   - Stone-900 serif name, stone-500 supporting copy for email +
 *     phone — same typographic register as the rest of the admin.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  CreditCard,
  Flag,
  Mail,
  Phone,
  Search,
  UserRound,
} from 'lucide-react';

import type { Client } from '../types';
import {
  clientDisplayName,
  formatLifetimeSpend,
  formatPhone,
} from '../helpers';
import ClientProfileModal from '../ClientProfileModal';

interface Props {
  clients: Client[];
}

export default function ClientDirectory({ clients }: Props) {
  // The client whose profile is currently open in the modal
  // overlay. Null = no modal. We keep this here (rather than
  // inside each card) so a single backdrop + scroll-lock contract
  // applies to the whole directory and there's no risk of stacking
  // two modals on top of each other.
  const [openClient, setOpenClient] = useState<Client | null>(null);
  // Single source of truth for the search box. We deliberately do
  // NOT debounce — the filter pass below is cheap (an O(n) string
  // scan over a few thousand rows tops) and a debounce would
  // introduce a perceptible lag that undermines the "real-time"
  // feel the spec asks for.
  const [searchQuery, setSearchQuery] = useState('');

  // Pre-compute a lowercased searchable haystack per client so the
  // filter loop doesn't repeatedly lowercase the same strings on
  // every keystroke. Map runs once per prop change (server refresh)
  // rather than on every keystroke.
  const searchableClients = useMemo(
    () =>
      clients.map((client) => ({
        client,
        haystack: [
          client.first_name,
          client.last_name,
          client.email,
          client.phone, // digits-only — matches what a user would type
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      })),
    [clients]
  );

  const filteredClients = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return clients;
    // Search digits-only against the stored phone too, so an admin
    // who types "555-123" matches the same row as "5551234". The
    // haystack already holds the raw digits; we additionally strip
    // non-digits from the needle and check against the raw phone
    // when the needle is mostly digits.
    const digitsOnly = needle.replace(/\D/g, '');
    return searchableClients
      .filter(({ client, haystack }) => {
        if (haystack.includes(needle)) return true;
        if (
          digitsOnly.length >= 3 &&
          client.phone &&
          client.phone.includes(digitsOnly)
        ) {
          return true;
        }
        return false;
      })
      .map(({ client }) => client);
  }, [searchQuery, searchableClients, clients]);

  return (
    <div className="flex flex-col gap-6">
      <SearchBar value={searchQuery} onChange={setSearchQuery} />

      {/* Result summary — quiet, sits just below the search bar.
          We only render the count when there's something to count;
          an empty roster surfaces the dedicated empty state below. */}
      {clients.length > 0 && (
        <ResultCount total={clients.length} filtered={filteredClients.length} />
      )}

      {clients.length === 0 ? (
        <EmptyDirectoryState />
      ) : filteredClients.length === 0 ? (
        <NoMatchesState query={searchQuery} />
      ) : (
        <ul className="space-y-2">
          {filteredClients.map((client) => (
            <ClientCard
              key={client.id}
              client={client}
              onOpen={() => setOpenClient(client)}
            />
          ))}
        </ul>
      )}

      {openClient && (
        <ClientProfileOverlay
          client={openClient}
          onClose={() => setOpenClient(null)}
        />
      )}
    </div>
  );
}

// ─── PROFILE OVERLAY ───────────────────────────────────────────────────────

/**
 * Modal shell around `<ClientProfileModal />` for the directory
 * entry point.
 *
 * AppointmentModal owns its own shell for the appointment-entry
 * flow; we mirror its exact chrome (backdrop, ESC, scroll lock,
 * card geometry) so a profile opened from either entry point
 * looks and behaves identically. Kept inline rather than
 * extracted into a shared helper because there are only two call
 * sites and a shared shell would couple two otherwise-independent
 * modal stacks.
 */
function ClientProfileOverlay({
  client,
  onClose,
}: {
  client: Client;
  onClose: () => void;
}) {
  // ESC closes the modal. Bound at window so it works regardless
  // of which inner element has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Body scroll lock so the page underneath can't wheel-scroll
  // while the modal's open. Snapshot the previous value rather
  // than hard-coding '' on cleanup so we cooperate with any
  // outer modal that already locked overflow.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Stop propagation on inner click so backdrop click-to-close
  // doesn't fire when the user clicks inside the card.
  const stopProp = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[#FAF9F6] shadow-2xl"
        onClick={stopProp}
        role="dialog"
        aria-modal="true"
        aria-label="Client profile"
      >
        <ClientProfileModal
          initialClient={client}
          backLabel="Clients"
          onBack={onClose}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

// ─── SEARCH BAR ────────────────────────────────────────────────────────────

function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search clients by name, email, or phone…"
        aria-label="Search clients"
        // `autoComplete="off"` so the browser's saved-searches dropdown
        // doesn't overlap our quiet UI. `spellCheck={false}` to keep red
        // underlines off names that aren't in the dictionary.
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-full border border-stone-200 bg-white py-3 pl-11 pr-4 text-sm text-stone-900 placeholder:text-stone-400 shadow-sm transition-shadow focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-300/40"
      />
    </div>
  );
}

// ─── RESULT COUNT ──────────────────────────────────────────────────────────

function ResultCount({
  total,
  filtered,
}: {
  total: number;
  filtered: number;
}) {
  const isFiltered = filtered !== total;
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-stone-500">
      {isFiltered
        ? `${filtered} of ${total} ${pluralise('client', total)}`
        : `${total} ${pluralise('client', total)}`}
    </p>
  );
}

function pluralise(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

// ─── CLIENT CARD ───────────────────────────────────────────────────────────

/**
 * Single row mirroring the geometry of `ListView`'s appointment
 * cards: `border-stone-200`, `bg-white`, `rounded-lg`, `px-4 py-3`,
 * `hover:shadow-sm`. Difference is the column layout — appointments
 * lead with a time column, clients lead with a name+contact block
 * because there's no chronological anchor.
 *
 * Rendered as a `<button>` so the chevron affordance reads as
 * genuinely clickable (cursor, focus ring, keyboard activation) and
 * the row picks up a subtle hover lift. Clicking opens the same
 * `ClientProfileModal` you get from drilling into a client name in
 * the appointments view.
 */
function ClientCard({
  client,
  onOpen,
}: {
  client: Client;
  onOpen: () => void;
}) {
  const fullName = clientDisplayName(client.first_name, client.last_name);
  const bookingLabel =
    client.total_bookings === 1 ? '1 booking' : `${client.total_bookings} bookings`;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open profile for ${fullName}`}
        className="group relative grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 rounded-lg border border-stone-200 bg-white px-4 py-3 text-left transition-shadow hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF9F6]"
      >
        {client.risk_flag && (
          <span
            className="absolute right-3 top-3 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700 ring-1 ring-amber-200/80"
            title="Past no-show or late cancellation"
          >
            <Flag className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">Risk flag</span>
          </span>
        )}
        {/* Leading avatar token — neutral stone disk with the
            person icon. Keeps the row visually anchored on the
            left, mirroring the time column on the Bookings list. */}
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-500">
          <UserRound className="h-5 w-5" strokeWidth={1.6} />
        </span>

        <div className="min-w-0">
          <p className="truncate font-serif text-base text-stone-900">
            {fullName}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
            {client.email && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Mail
                  className="h-3 w-3 shrink-0 text-stone-400"
                  aria-hidden="true"
                />
                <span className="truncate">{client.email}</span>
              </span>
            )}
            {client.phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone
                  className="h-3 w-3 shrink-0 text-stone-400"
                  aria-hidden="true"
                />
                <span className="font-mono tabular-nums">
                  {formatPhone(client.phone)}
                </span>
              </span>
            )}
            {!client.email && !client.phone && (
              <span className="italic text-stone-400">
                No contact details on file
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-medium uppercase tracking-[0.14em] text-stone-500 sm:hidden">
            <span>
              {client.total_bookings} booking
              {client.total_bookings === 1 ? '' : 's'}
            </span>
            <span>LTV {formatLifetimeSpend(client.lifetime_value)}</span>
            {client.has_vaulted_card && (
              <span className="inline-flex items-center gap-0.5 text-emerald-700">
                <CreditCard className="h-3 w-3" aria-hidden />
                Vaulted
              </span>
            )}
          </div>
        </div>

        <div className="hidden shrink-0 flex-col items-end gap-1.5 text-right sm:flex">
          <div className="flex flex-col gap-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
            <span>
              <span className="text-stone-400">Bookings</span>{' '}
              <span className="tabular-nums text-stone-800">
                {client.total_bookings}
              </span>
            </span>
            <span>
              <span className="text-stone-400">LTV</span>{' '}
              <span className="tabular-nums text-stone-800">
                {formatLifetimeSpend(client.lifetime_value)}
              </span>
            </span>
          </div>
          {client.has_vaulted_card && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700"
              title="Card on file"
            >
              <CreditCard className="h-3 w-3" aria-hidden="true" />
              Vaulted
            </span>
          )}
          <span className="sr-only">{bookingLabel}</span>
        </div>

        <ChevronRight
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-stone-300 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-stone-600 group-focus-visible:translate-x-0.5 group-focus-visible:text-stone-600"
        />
      </button>
    </li>
  );
}

// ─── EMPTY STATES ──────────────────────────────────────────────────────────

/** Rendered when the `clients` table is genuinely empty. */
function EmptyDirectoryState() {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-stone-100 text-stone-500">
        <UserRound className="h-6 w-6" strokeWidth={1.5} />
      </span>
      <h3 className="mt-4 font-serif text-lg text-stone-900">No clients yet</h3>
      <p className="mt-1 text-sm text-stone-500">
        Clients are created automatically when bookings come in through
        Cal.com — your first booking will populate this directory.
      </p>
    </div>
  );
}

/** Rendered when the directory has rows but the current search matches none. */
function NoMatchesState({ query }: { query: string }) {
  const trimmed = query.trim();
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-white/60 px-6 py-10 text-center">
      <Search
        className="mx-auto h-5 w-5 text-stone-400"
        aria-hidden="true"
      />
      <p className="mt-3 text-sm text-stone-600">
        No clients match{' '}
        <span className="font-medium text-stone-900">
          &ldquo;{trimmed}&rdquo;
        </span>
        .
      </p>
      <p className="mt-1 text-xs text-stone-400">
        Try a different spelling, partial name, or just the area code.
      </p>
    </div>
  );
}
