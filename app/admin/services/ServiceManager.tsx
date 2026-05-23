'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock,
  DollarSign,
  ExternalLink,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

/**
 * ServiceManager
 *
 * Client-side orchestrator for /admin/services. The server page paints
 * the initial list (so the editor sees data on first paint) and hands
 * the array to this component, which from then on owns:
 *
 *   • Visual grouping by category, with a stable section order
 *   • The slide-over form for create + edit (single component, two
 *     modes — the form is identical in both cases and what changes is
 *     the API verb used on submit and the prefilled values)
 *   • Optimistic UI updates that fall back gracefully when the API
 *     reports an error — we always re-trust the server's row shape on
 *     success rather than synthesising it client-side, so soft-edge
 *     fields (updated_at, normalised price) stay in sync.
 *   • An inline two-step delete confirmation. Using the browser's
 *     window.confirm() would break the premium aesthetic and frustrate
 *     editors who want to scan multiple deletes; the inline pattern
 *     lets the row visually transform and auto-revert after 4s.
 *
 * What lives outside this component: all data mutation goes through
 * /api/admin/services, which is the single source of truth for the
 * Cal.com ↔ Postgres sync. This component never calls Cal.com directly.
 */

export interface Service {
  id: number;
  cal_event_id: number;
  category: string;
  title: string;
  description: string;
  price: number;
  duration_mins: number;
  is_active: boolean;
  /**
   * The Cal.com event-type slug, used by the public site's
   * `data-cal-link` attribute to wire the booking drawer. Nullable
   * defensively — pre-migration rows that haven't been backfilled
   * yet will be null until the operator runs the backfill script.
   */
  slug: string | null;
}

interface Props {
  initialServices: Service[];
}

/**
 * Closed enum of categories the studio is willing to publish to the
 * public site. Public homepage hard-codes a two-column layout for
 * Lash Services on the left and Brow Services on the right; adding a
 * third category here would orphan its services on the live site
 * because there's no third column to render them into. If/when the
 * studio expands the menu, update this list AND the corresponding
 * grid layout in public/index.html + .services-cols in styles.css.
 *
 * Closed-enum (not free text + suggestions) because the previous
 * datalist let editors create near-duplicate sections by typing
 * variants like "Lashes" vs "Lash Services". A strict <select> is
 * the only way to guarantee the data shape the public site expects.
 */
const CATEGORIES = ['Lash Services', 'Brow Services'] as const;

interface FormState {
  title: string;
  category: string;
  description: string;
  price: string;
  length: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  // Default to the first allowed category so a brand-new <select>
  // doesn't render with a blank placeholder row that the user has to
  // touch before submitting.
  category: CATEGORIES[0],
  description: '',
  price: '',
  length: '',
};

type FormMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; service: Service };

export default function ServiceManager({ initialServices }: Props) {
  const [services, setServices] = useState<Service[]>(initialServices);
  const [mode, setMode] = useState<FormMode>({ kind: 'closed' });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Inline "are you sure" delete state: holds the id of the row in
  // its confirmation window. A timeout auto-reverts after 4s so an
  // accidental click never leaves the page in a "primed to delete"
  // state if the editor wanders away.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(
    null
  );
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Derived: services grouped by category, sorted alphabetically ──────
  // Recomputed only when `services` changes. Map preserves insertion
  // order, which matches the sorted iteration we want for rendering.
  const grouped = useMemo(() => {
    const map = new Map<string, Service[]>();
    const sorted = [...services].sort((a, b) => {
      const cat = a.category.localeCompare(b.category);
      if (cat !== 0) return cat;
      return a.title.localeCompare(b.title);
    });
    for (const s of sorted) {
      const list = map.get(s.category);
      if (list) list.push(s);
      else map.set(s.category, [s]);
    }
    return Array.from(map.entries());
  }, [services]);

  // ── Slide-over open/close side-effects ────────────────────────────────
  // Lock body scroll while the panel is open (otherwise the long form
  // can scroll the page underneath, which feels broken). ESC closes.
  useEffect(() => {
    if (mode.kind === 'closed') return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) closeForm();
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
    // closeForm reads `isSubmitting` from the outer scope; we want the
    // effect to re-bind the listener whenever that changes so ESC respects
    // the in-flight state. mode also matters because closing should clean
    // the listener up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind, isSubmitting]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  // ── Form openers ──────────────────────────────────────────────────────

  function openCreate() {
    setSubmitError(null);
    setForm(EMPTY_FORM);
    setMode({ kind: 'create' });
  }

  function openEdit(service: Service) {
    setSubmitError(null);
    setForm({
      title: service.title,
      category: service.category,
      description: service.description,
      price: String(service.price),
      length: String(service.duration_mins),
    });
    setMode({ kind: 'edit', service });
  }

  function closeForm() {
    setMode({ kind: 'closed' });
    setSubmitError(null);
  }

  // ── Validation + payload assembly ─────────────────────────────────────

  function validateForm(): {
    title: string;
    category: string;
    description: string;
    price: number;
    length: number;
  } | null {
    const title = form.title.trim();
    const category = form.category.trim();
    const description = form.description.trim();
    const price = Number(form.price);
    const length = Number(form.length);

    if (!title) {
      setSubmitError('Title is required.');
      return null;
    }
    if (!category) {
      setSubmitError('Category is required.');
      return null;
    }
    if (!Number.isFinite(price) || price < 0) {
      setSubmitError('Price must be a non-negative number.');
      return null;
    }
    if (!Number.isInteger(length) || length < 5) {
      setSubmitError('Duration must be a whole number of at least 5 minutes.');
      return null;
    }
    return { title, category, description, price, length };
  }

  // ── Submit handlers ───────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const payload = validateForm();
    if (!payload) return;

    setIsSubmitting(true);
    try {
      if (mode.kind === 'create') {
        const res = await fetch('/api/admin/services', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Request failed');
        setServices((prev) => [...prev, data.service as Service]);
        closeForm();
      } else if (mode.kind === 'edit') {
        const res = await fetch('/api/admin/services', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            db_id: mode.service.id,
            cal_event_id: mode.service.cal_event_id,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Request failed');
        const updated = data.service as Service;
        setServices((prev) =>
          prev.map((s) => (s.id === updated.id ? updated : s))
        );
        closeForm();
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Delete flow ──────────────────────────────────────────────────────

  function primeDelete(serviceId: number) {
    setConfirmingDeleteId(serviceId);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingDeleteId((current) =>
        current === serviceId ? null : current
      );
    }, 4000);
  }

  function cancelDelete() {
    setConfirmingDeleteId(null);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }

  async function confirmDelete(service: Service) {
    setDeletingId(service.id);
    try {
      const qs = new URLSearchParams({
        db_id: String(service.id),
        cal_event_id: String(service.cal_event_id),
      });
      const res = await fetch(`/api/admin/services?${qs.toString()}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Delete failed');
      }
      setServices((prev) => prev.filter((s) => s.id !== service.id));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Top toolbar — empty-state hint sits in the body below */}
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-xl text-stone-900">
          Service Catalogue
        </h2>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[#FAF9F6] transition-colors hover:bg-stone-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Add service
        </button>
      </div>

      {/* Page-level error banner for delete failures (the form has its
          own inline error.) Both reuse `submitError` because only one
          modal-or-delete action runs at a time. */}
      {submitError && mode.kind === 'closed' && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {submitError}
        </div>
      )}

      {grouped.length === 0 ? (
        <EmptyState onAdd={openCreate} />
      ) : (
        grouped.map(([category, items]) => (
          <CategorySection
            key={category}
            category={category}
            services={items}
            confirmingDeleteId={confirmingDeleteId}
            deletingId={deletingId}
            onEdit={openEdit}
            onPrimeDelete={primeDelete}
            onCancelDelete={cancelDelete}
            onConfirmDelete={confirmDelete}
          />
        ))
      )}

      <SlideOverForm
        mode={mode}
        form={form}
        onChange={setForm}
        isSubmitting={isSubmitting}
        submitError={submitError}
        onSubmit={handleSubmit}
        onClose={closeForm}
      />
    </div>
  );
}

// ─── SUBCOMPONENTS ─────────────────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white/60 p-12 text-center">
      <p className="font-serif text-xl text-stone-900">No services yet.</p>
      <p className="mt-2 text-sm text-stone-500">
        Add your first service to publish it to the booking page and the
        site menu.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-6 inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[#FAF9F6] transition-colors hover:bg-stone-700"
      >
        <Plus className="h-3.5 w-3.5" />
        Add your first service
      </button>
    </div>
  );
}

interface CategorySectionProps {
  category: string;
  services: Service[];
  confirmingDeleteId: number | null;
  deletingId: number | null;
  onEdit: (service: Service) => void;
  onPrimeDelete: (id: number) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (service: Service) => void;
}

function CategorySection({
  category,
  services,
  confirmingDeleteId,
  deletingId,
  onEdit,
  onPrimeDelete,
  onCancelDelete,
  onConfirmDelete,
}: CategorySectionProps) {
  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between border-b border-stone-200 pb-2">
        <h3 className="font-serif text-lg text-stone-900">{category}</h3>
        <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
          {services.length} {services.length === 1 ? 'service' : 'services'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            isConfirmingDelete={confirmingDeleteId === service.id}
            isDeleting={deletingId === service.id}
            onEdit={() => onEdit(service)}
            onPrimeDelete={() => onPrimeDelete(service.id)}
            onCancelDelete={onCancelDelete}
            onConfirmDelete={() => onConfirmDelete(service)}
          />
        ))}
      </div>
    </section>
  );
}

interface ServiceCardProps {
  service: Service;
  isConfirmingDelete: boolean;
  isDeleting: boolean;
  onEdit: () => void;
  onPrimeDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

function ServiceCard({
  service,
  isConfirmingDelete,
  isDeleting,
  onEdit,
  onPrimeDelete,
  onCancelDelete,
  onConfirmDelete,
}: ServiceCardProps) {
  return (
    <article
      className={`group relative flex flex-col rounded-xl border bg-white p-5 shadow-sm transition-shadow ${
        isConfirmingDelete
          ? 'border-rose-300'
          : 'border-stone-200 hover:shadow-md'
      } ${isDeleting ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="font-serif text-lg leading-tight text-stone-900">
          {service.title}
        </h4>
        <div className="flex shrink-0 items-center gap-3 text-sm font-medium text-stone-900">
          <span className="inline-flex items-center gap-1">
            <DollarSign className="h-3.5 w-3.5 text-stone-400" />
            {formatPrice(service.price)}
          </span>
          <span className="inline-flex items-center gap-1 text-stone-500">
            <Clock className="h-3.5 w-3.5 text-stone-400" />
            {service.duration_mins} min
          </span>
        </div>
      </div>

      {service.description && (
        <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-stone-600">
          {service.description}
        </p>
      )}

      <div className="mt-5 flex items-center justify-between gap-2 border-t border-stone-100 pt-3">
        {/*
          Cal.com dashboard deep-link, left-anchored so it sits visually
          apart from the destructive actions on the right. Opens in a
          new tab — the editor's primary task lives on this page and
          we shouldn't yank them away from it.

          Why this link exists: Cal's v2 API enforces
          `checkIsEmailUserAccessible` on personal accounts, which
          means we cannot toggle the email field to optional from this
          CMS no matter what payload we send (Cal issue #25430, fix
          pending in PR #26316). Cal's own dashboard UI uses a
          different code path and DOES allow the toggle. So when the
          studio wants email-optional, this link is the one-click
          bridge to where they can flip the switch.
        */}
        {!isConfirmingDelete && (
          <a
            href={`https://app.cal.com/event-types/${service.cal_event_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-stone-400 transition-colors hover:text-stone-700"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Cal
          </a>
        )}

        <div className="ml-auto flex items-center gap-2">
          {isConfirmingDelete ? (
            <>
              <button
                type="button"
                onClick={onCancelDelete}
                disabled={isDeleting}
                className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={isDeleting}
                className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                {isDeleting ? 'Removing…' : 'Confirm delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </button>
              <button
                type="button"
                onClick={onPrimeDelete}
                className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

interface SlideOverFormProps {
  mode: FormMode;
  form: FormState;
  onChange: (form: FormState) => void;
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

function SlideOverForm({
  mode,
  form,
  onChange,
  isSubmitting,
  submitError,
  onSubmit,
  onClose,
}: SlideOverFormProps) {
  const isOpen = mode.kind !== 'closed';
  const isEdit = mode.kind === 'edit';

  return (
    <div
      className={`fixed inset-0 z-50 ${isOpen ? '' : 'pointer-events-none'}`}
      aria-hidden={!isOpen}
    >
      {/* Backdrop. Click-to-dismiss is intentionally enabled even mid-
          submit because the request will still complete on the server;
          the editor just loses optimistic UI for that one action. ESC
          (handled at the parent) is what we block during submit. */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-stone-900/40 transition-opacity duration-200 ${
          isOpen ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Panel — right-anchored slide-over. translate-x-full hides it
          off-stage when closed; translate-x-0 brings it in. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit service' : 'Add service'}
        className={`absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-[#FAF9F6] shadow-2xl transition-transform duration-300 ease-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              {isEdit ? 'Edit' : 'New'}
            </p>
            <h2 className="font-serif text-2xl leading-tight text-stone-900">
              {isEdit ? 'Edit service' : 'Add service'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close form"
            className="rounded-full p-1.5 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <form
          onSubmit={onSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-6">
            <Field label="Title" htmlFor="svc-title" required>
              <input
                id="svc-title"
                type="text"
                required
                maxLength={120}
                value={form.title}
                onChange={(e) => onChange({ ...form, title: e.target.value })}
                placeholder="Classic Lash Set"
                className={inputClass}
              />
            </Field>

            <Field
              label="Category"
              htmlFor="svc-category"
              required
              hint="Determines which column on the public site this service appears in."
            >
              {/*
                Strict closed enum — the public homepage hard-codes a
                two-column layout (Lash Services | Brow Services), so
                anything not in CATEGORIES would silently disappear
                from the public menu. Rendering a <select> instead of
                a free-text input makes that guarantee impossible to
                violate from the admin UI.

                Visual styling deliberately matches `inputClass` from
                the other fields — the only added utilities are the
                custom chevron (`appearance-none` + a background-image
                arrow) so the field reads as a select on all browsers
                rather than relying on the default OS chrome.
              */}
              <select
                id="svc-category"
                required
                value={form.category}
                onChange={(e) =>
                  onChange({ ...form, category: e.target.value })
                }
                className={`${inputClass} appearance-none bg-size-[14px_14px] bg-position-[right_0.75rem_center] bg-no-repeat pr-9 bg-[url("data:image/svg+xml;utf8,<svg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2020%2020'%20fill='%2378716c'><path%20d='M5.516%207.548L10%2012.032l4.484-4.484L16%209.064l-6%206-6-6z'/></svg>")]`}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                {/*
                  Legacy escape hatch: if we're editing a row whose
                  category predates the closed enum (e.g. an old
                  "Facials & Skincare" record), surface it as a
                  marked option so the editor can see what's there
                  before remapping it. Saving the form forces them to
                  pick a current category — the legacy value never
                  round-trips back into the DB unless explicitly chosen.
                */}
                {!(CATEGORIES as readonly string[]).includes(form.category) &&
                  form.category && (
                    <option value={form.category}>
                      {form.category} (legacy — please reassign)
                    </option>
                  )}
              </select>
            </Field>

            <Field label="Description" htmlFor="svc-description">
              <textarea
                id="svc-description"
                rows={4}
                maxLength={2000}
                value={form.description}
                onChange={(e) =>
                  onChange({ ...form, description: e.target.value })
                }
                placeholder="What the client should expect. This appears under the service on the public site."
                className={`${inputClass} resize-y`}
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Price ($)" htmlFor="svc-price" required>
                <input
                  id="svc-price"
                  type="number"
                  required
                  min={0}
                  step="0.01"
                  value={form.price}
                  onChange={(e) =>
                    onChange({ ...form, price: e.target.value })
                  }
                  placeholder="125"
                  className={inputClass}
                />
              </Field>

              <Field
                label="Duration (min)"
                htmlFor="svc-length"
                required
              >
                <input
                  id="svc-length"
                  type="number"
                  required
                  min={5}
                  step={5}
                  value={form.length}
                  onChange={(e) =>
                    onChange({ ...form, length: e.target.value })
                  }
                  placeholder="60"
                  className={inputClass}
                />
              </Field>
            </div>

            {submitError && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                {submitError}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-3 border-t border-stone-200 bg-white px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[#FAF9F6] transition-colors hover:bg-stone-700 disabled:opacity-60"
            >
              {isSubmitting
                ? isEdit
                  ? 'Saving…'
                  : 'Creating…'
                : isEdit
                  ? 'Save changes'
                  : 'Create service'}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}

interface FieldProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, htmlFor, required, hint, children }: FieldProps) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500"
      >
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-stone-400">{hint}</p>}
    </div>
  );
}

// Shared text input / textarea base class. Defined once so the four
// inputs in the form stay visually identical without duplicating the
// 6+ utility classes inline at each site.
const inputClass =
  'block w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 transition-colors focus:border-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900';

/**
 * Format a numeric price for the card display. NUMERIC values arrive
 * as JS numbers from the API (we coerce server-side), so we just need
 * to render with at most 2 decimals — no currency formatter because
 * the studio is USD-only and the `$` glyph is rendered as an icon
 * adjacent to this string.
 */
function formatPrice(price: number): string {
  if (Number.isInteger(price)) return price.toString();
  return price.toFixed(2);
}
