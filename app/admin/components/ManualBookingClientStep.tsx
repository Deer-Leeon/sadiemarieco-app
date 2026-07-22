'use client';

/**
 * Step 2 of the manual-booking wizard: pick an existing CRM client
 * (search + select) or enter a new client's details by hand.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, UserPlus, Users } from 'lucide-react';

import {
  CLIENT_PHONE_HINT,
  clientPhoneLookupVariants,
  clientPhoneValidationMessage,
  formatPhoneInputDisplay,
  isPlaceholderClientEmail,
  normaliseClientPhoneForStorage,
  parseClientPhone,
} from '@/lib/client-identity';

import { clientDisplayName, formatPhone } from '../helpers';
import type { Client } from '../types';

export type ClientEntryMode = 'existing' | 'new';

export interface ManualBookingClientFields {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

interface Props {
  mode: ClientEntryMode;
  onModeChange: (mode: ClientEntryMode) => void;
  fields: ManualBookingClientFields;
  onFieldsChange: (patch: Partial<ManualBookingClientFields>) => void;
  phoneTouched: boolean;
  onPhoneTouched: () => void;
  selectedClientId: string | null;
  onSelectClient: (client: Client | null) => void;
}

const INPUT_CLASS =
  'block w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 transition-colors focus:border-stone-300 focus:outline-none focus:ring-1 focus:ring-stone-200';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function usableClientEmail(raw: string | null | undefined): string {
  const trimmed = (raw || '').trim();
  if (!trimmed || isPlaceholderClientEmail(trimmed)) return '';
  return EMAIL_RE.test(trimmed) ? trimmed : '';
}

const MODE_BTN =
  'inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-medium uppercase tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-300';

export default function ManualBookingClientStep({
  mode,
  onModeChange,
  fields,
  onFieldsChange,
  phoneTouched,
  onPhoneTouched,
  selectedClientId,
  onSelectClient,
}: Props) {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (mode !== 'existing') return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const res = await fetch('/api/admin/clients/list');
        const payload: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            payload &&
            typeof payload === 'object' &&
            'message' in payload &&
            typeof (payload as { message: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : `Could not load clients (HTTP ${res.status})`;
          if (!cancelled) {
            setLoadError(message);
            fetchedRef.current = false;
          }
          return;
        }
        const list =
          payload &&
          typeof payload === 'object' &&
          'clients' in payload &&
          Array.isArray((payload as { clients: unknown }).clients)
            ? ((payload as { clients: Client[] }).clients)
            : [];
        if (!cancelled) setClients(list);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : 'Could not load clients'
          );
          fetchedRef.current = false;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode]);

  const searchableClients = useMemo(
    () =>
      clients.map((client) => ({
        client,
        haystack: [
          client.first_name,
          client.last_name,
          client.email,
          client.phone,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      })),
    [clients]
  );

  const filteredClients = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return clients.slice(0, 40);

    const digitsOnly = needle.replace(/\D/g, '');
    const queryVariants =
      digitsOnly.length >= 3
        ? clientPhoneLookupVariants(
            normaliseClientPhoneForStorage(digitsOnly) ?? digitsOnly
          )
        : [];

    return searchableClients
      .filter(({ client, haystack }) => {
        if (haystack.includes(needle)) return true;
        if (digitsOnly.length >= 3 && client.phone) {
          const clientVariants = clientPhoneLookupVariants(
            normaliseClientPhoneForStorage(client.phone) ?? client.phone
          );
          if (queryVariants.some((q) => clientVariants.includes(q))) {
            return true;
          }
        }
        return false;
      })
      .map(({ client }) => client)
      .slice(0, 40);
  }, [searchQuery, searchableClients, clients]);

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) ?? null,
    [clients, selectedClientId]
  );

  const parsedPhone = parseClientPhone(fields.phone);
  const phoneInvalid =
    phoneTouched && fields.phone.trim().length > 0 && !parsedPhone;
  const emailInvalid =
    fields.email.trim().length > 0 && !EMAIL_RE.test(fields.email.trim());

  const selectedNeedsEmail =
    mode === 'existing' &&
    selectedClient != null &&
    !usableClientEmail(fields.email || selectedClient.email);

  function formatPhoneField() {
    const formatted = formatPhoneInputDisplay(fields.phone);
    if (formatted !== fields.phone.trim()) {
      onFieldsChange({ phone: formatted });
    }
  }

  return (
    <div className="space-y-4">
      <div
        className="flex gap-1 rounded-full border border-stone-200 bg-stone-100/80 p-1"
        role="tablist"
        aria-label="Client entry mode"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'existing'}
          onClick={() => onModeChange('existing')}
          className={`${MODE_BTN} ${
            mode === 'existing'
              ? 'bg-white text-stone-900 shadow-sm'
              : 'text-stone-500 hover:text-stone-700'
          }`}
        >
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          Existing
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'new'}
          onClick={() => onModeChange('new')}
          className={`${MODE_BTN} ${
            mode === 'new'
              ? 'bg-white text-stone-900 shadow-sm'
              : 'text-stone-500 hover:text-stone-700'
          }`}
        >
          <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
          New client
        </button>
      </div>

      {mode === 'existing' ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-600">
            Search and select a client to skip typing their details.
          </p>

          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, email, or phone…"
              aria-label="Search existing clients"
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT_CLASS} pl-9`}
            />
          </div>

          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading clients…
            </div>
          )}

          {loadError && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {loadError}
            </p>
          )}

          {!loading && !loadError && selectedClient && (
            <div className="rounded-lg border border-stone-300 bg-white px-3 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-serif text-base text-stone-900">
                    <Check
                      className="h-4 w-4 shrink-0 text-emerald-600"
                      aria-hidden="true"
                    />
                    {clientDisplayName(
                      selectedClient.first_name,
                      selectedClient.last_name
                    )}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {[
                      formatPhone(selectedClient.phone, ''),
                      usableClientEmail(selectedClient.email) || null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'No contact details on file'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectClient(null)}
                  className="shrink-0 text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500 hover:text-stone-800"
                >
                  Change
                </button>
              </div>
              {!parseClientPhone(selectedClient.phone) && (
                <p className="mt-2 text-xs text-rose-600" role="alert">
                  This client has no usable phone on file. Add one from their
                  profile, or book them as a new client.
                </p>
              )}
              {!(selectedClient.first_name?.trim() && selectedClient.last_name?.trim()) && (
                <p className="mt-2 text-xs text-rose-600" role="alert">
                  This client is missing a first or last name. Update their
                  profile, or book them as a new client.
                </p>
              )}
            </div>
          )}

          {!loading && !loadError && !selectedClient && (
            <ul
              className="max-h-56 overflow-y-auto rounded-lg border border-stone-200 bg-white"
              role="listbox"
              aria-label="Matching clients"
            >
              {filteredClients.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-stone-500">
                  {clients.length === 0
                    ? 'No clients in your CRM yet.'
                    : 'No matches — try a different search.'}
                </li>
              ) : (
                filteredClients.map((client) => {
                  const name = clientDisplayName(
                    client.first_name,
                    client.last_name
                  );
                  const meta = [
                    formatPhone(client.phone, ''),
                    usableClientEmail(client.email) || null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <li key={client.id} className="border-b border-stone-100 last:border-b-0">
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => onSelectClient(client)}
                        className="flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-stone-50 focus-visible:bg-stone-50 focus-visible:outline-none"
                      >
                        <span className="text-sm font-medium text-stone-900">
                          {name}
                        </span>
                        {meta && (
                          <span className="text-xs text-stone-500">{meta}</span>
                        )}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          )}

          {selectedNeedsEmail && (
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
                Email needed for this booking
              </span>
              <input
                type="email"
                value={fields.email}
                onChange={(e) => onFieldsChange({ email: e.target.value })}
                autoComplete="email"
                aria-invalid={emailInvalid}
                className={`${INPUT_CLASS}${emailInvalid ? ' border-rose-200 focus:border-rose-300 focus:ring-rose-100' : ''}`}
                placeholder="client@example.com"
              />
              <p className="mt-1.5 text-xs text-stone-500">
                This client has no email on file. Add one to continue — Cal.com
                needs it for the booking.
              </p>
              {emailInvalid && (
                <p className="mt-1 text-xs text-rose-600" role="alert">
                  Enter a valid email address.
                </p>
              )}
            </label>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-stone-500">
            Phone is required and identifies the client in your CRM. Email is
            required for Cal.com confirmations.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
                First name
              </span>
              <input
                type="text"
                value={fields.firstName}
                onChange={(e) => onFieldsChange({ firstName: e.target.value })}
                autoComplete="given-name"
                className={INPUT_CLASS}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
                Last name
              </span>
              <input
                type="text"
                value={fields.lastName}
                onChange={(e) => onFieldsChange({ lastName: e.target.value })}
                autoComplete="family-name"
                className={INPUT_CLASS}
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
              Phone
            </span>
            <input
              type="tel"
              inputMode="tel"
              value={fields.phone}
              onChange={(e) => onFieldsChange({ phone: e.target.value })}
              onBlur={() => {
                onPhoneTouched();
                formatPhoneField();
              }}
              autoComplete="tel"
              placeholder="(801) 555-1234"
              aria-invalid={phoneInvalid}
              className={`${INPUT_CLASS}${phoneInvalid ? ' border-rose-200 focus:border-rose-300 focus:ring-rose-100' : ''}`}
            />
            <p className="mt-1.5 text-xs text-stone-500">{CLIENT_PHONE_HINT}</p>
            {phoneInvalid && (
              <p className="mt-1 text-xs text-rose-600" role="alert">
                {clientPhoneValidationMessage()}
              </p>
            )}
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
              Email
            </span>
            <input
              type="email"
              required
              value={fields.email}
              onChange={(e) => onFieldsChange({ email: e.target.value })}
              autoComplete="email"
              aria-invalid={emailInvalid}
              className={`${INPUT_CLASS}${emailInvalid ? ' border-rose-200 focus:border-rose-300 focus:ring-rose-100' : ''}`}
              placeholder="client@example.com"
            />
            {emailInvalid && (
              <p className="mt-1 text-xs text-rose-600" role="alert">
                Enter a valid email address.
              </p>
            )}
          </label>
        </div>
      )}
    </div>
  );
}

/** Whether step 2 has enough data to continue to the schedule picker. */
export function canAdvanceManualBookingClientStep(
  mode: ClientEntryMode,
  fields: ManualBookingClientFields,
  selectedClient: Client | null
): boolean {
  if (mode === 'existing') {
    if (!selectedClient) return false;
    const first = (selectedClient.first_name || fields.firstName).trim();
    const last = (selectedClient.last_name || fields.lastName).trim();
    const phoneRaw = selectedClient.phone || fields.phone;
    const email = usableClientEmail(fields.email || selectedClient.email);
    return (
      first.length > 0 &&
      last.length > 0 &&
      parseClientPhone(phoneRaw) !== null &&
      email.length > 0
    );
  }

  return (
    fields.firstName.trim().length > 0 &&
    fields.lastName.trim().length > 0 &&
    parseClientPhone(fields.phone) !== null &&
    usableClientEmail(fields.email).length > 0
  );
}
