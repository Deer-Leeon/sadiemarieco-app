'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import { getServiceColor } from '../serviceColors';

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
  /**
   * Null for group headers (groups are CMS-only accordion containers
   * with no Cal.com event-type behind them). Required for every
   * bookable service.
   */
  cal_event_id: number | null;
  category: string;
  title: string;
  description: string;
  price: number;
  /**
   * Null for group headers (groups don't have a duration of their
   * own — they aggregate bookable children that each carry one).
   */
  duration_mins: number | null;
  is_active: boolean;
  /**
   * The Cal.com event-type slug, used by the public site's
   * `data-cal-link` attribute to wire the booking drawer. Nullable
   * defensively — pre-migration rows that haven't been backfilled
   * yet will be null until the operator runs the backfill script,
   * and groups are always null since they have no Cal event.
   */
  slug: string | null;
  /**
   * True when this row is an accordion header (a "Service Group"
   * parent). Group rows have no Cal event, render as a "From $X"
   * heading on the homepage, and contain bookable child services.
   */
  is_group: boolean;
  /**
   * Optional nesting under a group. Null means this row sits at the
   * top level (a standalone bookable service, or a group itself).
   * When set, this row renders inside its parent group's accordion
   * on both the admin list and the public site.
   */
  parent_id: number | null;
  /**
   * Editor-assigned hex colour used to paint this service's
   * appointment blocks on the admin calendar. Canonical form is
   * `#RRGGBB` (7 chars). Null means "auto-pick from the keyword +
   * duration matcher in app/admin/serviceColors.ts" — the same
   * behaviour every row had before this column existed. Mirrors
   * `site_services.color`; persisted via /api/admin/services.
   */
  color: string | null;
  /** Global menu sequence (lower = earlier). Set via Save Order. */
  display_order: number;
}

interface Props {
  initialServices: Service[];
}

function sortServicesByDisplayOrder(list: Service[]): Service[] {
  return [...list].sort((a, b) =>
    a.display_order !== b.display_order
      ? a.display_order - b.display_order
      : a.id - b.id
  );
}

function idsInDisplayOrder(list: Service[]): number[] {
  return sortServicesByDisplayOrder(list).map((s) => s.id);
}

/** Mirrors `renderCategoryItems()` in app/route.ts — same top-level sequence. */
function buildCategoryMenuStructure(
  items: Service[],
  sortByMenuOrder: (list: Service[]) => Service[]
): {
  topLevel: Service[];
  childrenByParent: Map<number, Service[]>;
} {
  const ordered = sortByMenuOrder(items);
  const groupIds = new Set(ordered.filter((s) => s.is_group).map((s) => s.id));
  const childrenByParent = new Map<number, Service[]>();

  for (const s of ordered) {
    if (s.parent_id !== null && groupIds.has(s.parent_id)) {
      const list = childrenByParent.get(s.parent_id);
      if (list) list.push(s);
      else childrenByParent.set(s.parent_id, [s]);
    }
  }

  const topLevel = ordered.filter(
    (s) =>
      s.is_group ||
      s.parent_id === null ||
      !groupIds.has(s.parent_id)
  );

  return { topLevel, childrenByParent };
}

/** Row ids in the order they appear in the admin column (group, then its children). */
function flattenCategoryVisualIds(
  topLevel: Service[],
  childrenByParent: Map<number, Service[]>
): number[] {
  const ids: number[] = [];
  for (const row of topLevel) {
    ids.push(row.id);
    if (row.is_group) {
      for (const child of childrenByParent.get(row.id) ?? []) {
        ids.push(child.id);
      }
    }
  }
  return ids;
}

function buildCategoryVisualOrder(
  categoryServices: Service[],
  orderDraft: number[]
): number[] {
  const orderIndex = new Map<number, number>();
  orderDraft.forEach((id, index) => orderIndex.set(id, index));
  const sortByMenuOrder = (list: Service[]) =>
    [...list].sort(
      (a, b) =>
        (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  const { topLevel, childrenByParent } = buildCategoryMenuStructure(
    categoryServices,
    sortByMenuOrder
  );
  return flattenCategoryVisualIds(topLevel, childrenByParent);
}

/**
 * Reassign global order slots for one category to match the admin column's
 * visual row order, without moving other categories' rows.
 */
function applyCategoryVisualOrderToGlobal(
  globalOrder: number[],
  category: string,
  allServices: Service[],
  visualIds: number[]
): number[] {
  const categoryIdSet = new Set(
    allServices.filter((s) => s.category === category).map((s) => s.id)
  );
  const slotIndices: number[] = [];
  for (let i = 0; i < globalOrder.length; i++) {
    if (categoryIdSet.has(globalOrder[i])) slotIndices.push(i);
  }

  if (slotIndices.length === 0 || categoryIdSet.size === 0) return globalOrder;

  const seen = new Set<number>();
  const canonicalVisual: number[] = [];
  for (const id of visualIds) {
    if (!categoryIdSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    canonicalVisual.push(id);
  }
  const missing = [...categoryIdSet]
    .filter((id) => !seen.has(id))
    .sort(
      (a, b) =>
        globalOrder.indexOf(a) - globalOrder.indexOf(b) ||
        a - b
    );
  canonicalVisual.push(...missing);

  if (canonicalVisual.length !== categoryIdSet.size) return globalOrder;

  const next = [...globalOrder];
  for (let j = 0; j < canonicalVisual.length; j++) {
    next[slotIndices[j]] = canonicalVisual[j];
  }
  return next;
}

function computeCategoryRenderedOrder(
  categoryServices: Service[],
  orderDraft: number[],
  servicesById: Map<number, Service>,
  groupIds: Set<number>
): number[] {
  const visual = buildCategoryVisualOrder(categoryServices, orderDraft);
  return buildRenderedRowIds(visual, servicesById, groupIds);
}

/**
 * Pure reorder: returns a new global id list, or null when the move is a no-op.
 */
function moveItemInGlobalOrder(
  orderDraft: number[],
  allServices: Service[],
  groupIds: Set<number>,
  category: string,
  serviceId: number,
  direction: -1 | 1
): number[] | null {
  const servicesById = new Map(allServices.map((s) => [s.id, s]));
  const categoryServices = allServices.filter((s) => s.category === category);
  if (categoryServices.length === 0) return null;

  const rendered = computeCategoryRenderedOrder(
    categoryServices,
    orderDraft,
    servicesById,
    groupIds
  );
  const service = servicesById.get(serviceId);
  if (!service || service.category !== category) return null;

  let newRendered: number[] | null = null;

  if (service.is_group) {
    const units = buildMoveUnits(rendered, servicesById);
    const unitIndex = units.findIndex((unit) => unit[0] === serviceId);
    if (unitIndex < 0) return null;
    const targetUnit = unitIndex + direction;
    if (targetUnit < 0 || targetUnit >= units.length) return null;

    const nextUnits = [...units];
    [nextUnits[unitIndex], nextUnits[targetUnit]] = [
      nextUnits[targetUnit],
      nextUnits[unitIndex],
    ];
    newRendered = nextUnits.flat();
  } else {
    const index = rendered.indexOf(serviceId);
    if (index < 0) return null;
    const target = index + direction;
    if (target < 0 || target >= rendered.length) return null;

    const a = servicesById.get(rendered[index]);
    const b = servicesById.get(rendered[target]);
    if (!a || !b) return null;
    if (a.parent_id === b.id || b.parent_id === a.id) return null;

    newRendered = [...rendered];
    [newRendered[index], newRendered[target]] = [
      newRendered[target],
      newRendered[index],
    ];
  }

  const newVisual = renderedRowsToVisualOrder(newRendered, servicesById);
  const nextGlobal = applyCategoryVisualOrderToGlobal(
    orderDraft,
    category,
    allServices,
    newVisual
  );

  if (nextGlobal.join(',') === orderDraft.join(',')) return null;
  return nextGlobal;
}

/**
 * Build the global id list to persist: each category block in homepage
 * column order (Lash, then Brow, …), with rows inside each column matching
 * the admin catalogue.
 */
function buildGlobalOrderForSave(
  allServices: Service[],
  orderDraft: number[],
  servicesById: Map<number, Service>,
  groupIds: Set<number>
): number[] {
  const byCategory = new Map<string, Service[]>();
  for (const s of allServices) {
    const list = byCategory.get(s.category);
    if (list) list.push(s);
    else byCategory.set(s.category, [s]);
  }

  const categories = Array.from(byCategory.keys()).sort((a, b) => {
    const rankA = CATEGORY_COLUMN_RANK[a] ?? 50;
    const rankB = CATEGORY_COLUMN_RANK[b] ?? 50;
    if (rankA !== rankB) return rankA - rankB;
    return a.localeCompare(b);
  });

  const result: number[] = [];
  const used = new Set<number>();

  for (const category of categories) {
    const items = byCategory.get(category) ?? [];
    const rendered = computeCategoryRenderedOrder(
      items,
      orderDraft,
      servicesById,
      groupIds
    );
    for (const id of rendered) {
      if (!used.has(id)) {
        result.push(id);
        used.add(id);
      }
    }
  }

  for (const id of orderDraft) {
    if (!used.has(id)) result.push(id);
  }

  return result;
}

/** Flat list of rows exactly as rendered (group header, then its children, etc.). */
function buildRenderedRowIds(
  visualOrder: number[],
  servicesById: Map<number, Service>,
  groupIds: Set<number>
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();

  for (const id of visualOrder) {
    if (seen.has(id)) continue;
    const service = servicesById.get(id);
    if (!service) continue;

    if (
      service.parent_id !== null &&
      groupIds.has(service.parent_id) &&
      !service.is_group
    ) {
      continue;
    }

    if (service.is_group) {
      out.push(service.id);
      seen.add(service.id);
      for (const child of childrenForGroupInVisualOrder(
        service.id,
        visualOrder,
        servicesById
      )) {
        out.push(child.id);
        seen.add(child.id);
      }
      continue;
    }

    out.push(service.id);
    seen.add(service.id);
  }

  return out;
}

/**
 * Moveable units for reordering: each group header plus its nested children
 * moves together; standalones and individual child rows move alone.
 */
function buildMoveUnits(
  rendered: number[],
  servicesById: Map<number, Service>
): number[][] {
  const units: number[][] = [];
  let i = 0;
  while (i < rendered.length) {
    const service = servicesById.get(rendered[i]);
    if (!service) {
      i += 1;
      continue;
    }
    if (service.is_group) {
      const unit = [service.id];
      i += 1;
      while (i < rendered.length) {
        const child = servicesById.get(rendered[i]);
        if (child?.parent_id === service.id) {
          unit.push(rendered[i]);
          i += 1;
        } else {
          break;
        }
      }
      units.push(unit);
      continue;
    }
    units.push([rendered[i]]);
    i += 1;
  }
  return units;
}

function childrenForGroupInVisualOrder(
  groupId: number,
  visualOrder: number[],
  servicesById: Map<number, Service>
): Service[] {
  return visualOrder
    .map((id) => servicesById.get(id))
    .filter(
      (s): s is Service => s !== undefined && s.parent_id === groupId
    )
    .sort((a, b) => visualOrder.indexOf(a.id) - visualOrder.indexOf(b.id));
}

function renderedRowsToVisualOrder(
  rendered: number[],
  servicesById: Map<number, Service>
): number[] {
  const visual: number[] = [];
  let i = 0;
  while (i < rendered.length) {
    const service = servicesById.get(rendered[i]);
    if (!service) {
      i += 1;
      continue;
    }
    visual.push(service.id);
    if (service.is_group) {
      i += 1;
      while (i < rendered.length) {
        const child = servicesById.get(rendered[i]);
        if (child?.parent_id === service.id) {
          visual.push(child.id);
          i += 1;
        } else {
          break;
        }
      }
      continue;
    }
    i += 1;
  }
  return visual;
}

/**
 * Closed enum of categories the studio is willing to publish to the
 * public site. Public homepage uses a two-column layout (Lash
 * Services left, Brow Services right) and currently treats
 * `Teeth Whitening` as a "coming soon" placeholder rendered as a
 * sibling block under Brow Services in the right column (see
 * `app/route.ts`). Rows in that category CAN be created here today
 * but won't appear on the live menu until the placeholder is
 * replaced with the dynamic list — by design, so the studio can
 * pre-stage the launch catalogue.
 *
 * If/when a fourth category gets added, update this list AND the
 * column-routing logic in `app/route.ts` so the new category lands
 * in the right column. The two-column grid in
 * `public/css/styles.css` doesn't need touching — categories stack
 * vertically inside whichever column they're routed to.
 *
 * Closed-enum (not free text + suggestions) because the previous
 * datalist let editors create near-duplicate sections by typing
 * variants like "Lashes" vs "Lash Services". A strict <select> is
 * the only way to guarantee the data shape the public site expects.
 */
const CATEGORIES = [
  'Lash Services',
  'Brow Services',
  'Teeth Whitening',
] as const;

/** Public homepage column order: Lash left, Brow right. */
const CATEGORY_COLUMN_RANK: Record<string, number> = {
  'Lash Services': 0,
  'Brow Services': 1,
  'Teeth Whitening': 2,
};

interface FormState {
  title: string;
  category: string;
  description: string;
  price: string;
  length: string;
  /**
   * True when the editor is creating/editing a group header. Drives
   * visibility of the duration + parent-picker fields and switches
   * the submit payload to the no-Cal-sync path on the server.
   */
  is_group: boolean;
  /**
   * Stringified id of the parent group, or '' for "no parent
   * (standalone)". Stored as a string because <select> values are
   * always strings — coerced to `number | null` at submit time.
   */
  parent_id: string;
  /**
   * Editor-assigned calendar-block colour, '#RRGGBB' or '' for "use
   * the auto-matcher fallback". Stored as a string (not `string |
   * null`) so the controlled <input> never sees a `null` value
   * mid-typing — we coerce empty → null at submit time.
   */
  color: string;
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
  is_group: false,
  parent_id: '',
  color: '',
};

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Native `<input type="color">` requires its value in the canonical
 * `#rrggbb` form. Editors may type a hex with no `#`, with a 3-char
 * shorthand, or in upper-case — this helper canonicalises whatever
 * they typed into the 7-char lower-case form the colour picker
 * understands, so the swatch always reflects what the editor will
 * actually save. Returns null when the input doesn't parse to a
 * full hex, signalling "leave the swatch on its previous value".
 */
function toCanonicalHex(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  // Allow 3-char shorthand (#fa3) too — expand to 6-char before
  // validating against the strict CHECK pattern we send to Postgres.
  if (/^#[0-9A-Fa-f]{3}$/.test(withHash)) {
    const [, r, g, b] = withHash;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (HEX_COLOR_RE.test(withHash)) return withHash.toLowerCase();
  return null;
}

type FormMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; service: Service };

export default function ServiceManager({ initialServices }: Props) {
  const router = useRouter();
  const [services, setServices] = useState<Service[]>(() =>
    sortServicesByDisplayOrder(initialServices)
  );
  const [orderDraft, setOrderDraft] = useState<number[]>(() =>
    idsInDisplayOrder(initialServices)
  );
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [orderToast, setOrderToast] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode>({ kind: 'closed' });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const savedOrderKey = useMemo(
    () => idsInDisplayOrder(services).join(','),
    [services]
  );

  const servicesById = useMemo(
    () => new Map(services.map((s) => [s.id, s])),
    [services]
  );

  const groupIds = useMemo(
    () => new Set(services.filter((s) => s.is_group).map((s) => s.id)),
    [services]
  );

  const canonicalOrderKey = useMemo(
    () =>
      buildGlobalOrderForSave(
        services,
        orderDraft,
        servicesById,
        groupIds
      ).join(','),
    [services, orderDraft, servicesById, groupIds]
  );

  const orderDirty = useMemo(
    () => canonicalOrderKey !== savedOrderKey,
    [canonicalOrderKey, savedOrderKey]
  );

  useEffect(() => {
    const sorted = sortServicesByDisplayOrder(initialServices);
    const draft = idsInDisplayOrder(sorted);
    setServices(sorted);
    setOrderDraft(draft);
  }, [initialServices]);

  // Inline "are you sure" delete state: holds the id of the row in
  // its confirmation window. A timeout auto-reverts after 4s so an
  // accidental click never leaves the page in a "primed to delete"
  // state if the editor wanders away.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(
    null
  );
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const orderIndex = useMemo(() => {
    const map = new Map<number, number>();
    orderDraft.forEach((id, index) => map.set(id, index));
    return map;
  }, [orderDraft]);

  const servicesRef = useRef(services);
  servicesRef.current = services;
  const groupIdsRef = useRef(groupIds);
  groupIdsRef.current = groupIds;

  // ── Derived: categories in public-site order (display_order) ─────────
  const grouped = useMemo(() => {
    const byCategory = new Map<string, Service[]>();
    for (const s of services) {
      const list = byCategory.get(s.category);
      if (list) list.push(s);
      else byCategory.set(s.category, [s]);
    }

    return Array.from(byCategory.entries())
      .map(([category, items]) => {
        const renderedOrder = computeCategoryRenderedOrder(
          items,
          orderDraft,
          servicesById,
          groupIds
        );
        const minOrder = Math.min(
          ...items.map((s) => orderIndex.get(s.id) ?? Number.MAX_SAFE_INTEGER)
        );
        return { category, renderedOrder, minOrder };
      })
      .sort((a, b) => {
        const rankA = CATEGORY_COLUMN_RANK[a.category] ?? 50;
        const rankB = CATEGORY_COLUMN_RANK[b.category] ?? 50;
        if (rankA !== rankB) return rankA - rankB;
        return a.minOrder - b.minOrder;
      });
  }, [services, orderIndex, orderDraft, servicesById, groupIds]);

  function moveInCategoryVisual(
    category: string,
    serviceId: number,
    direction: -1 | 1
  ) {
    setOrderDraft((prev) => {
      const next = moveItemInGlobalOrder(
        prev,
        servicesRef.current,
        groupIdsRef.current,
        category,
        serviceId,
        direction
      );
      return next ?? prev;
    });
  }

  async function saveOrder() {
    if (!orderDirty || isSavingOrder) return;
    setIsSavingOrder(true);
    setSubmitError(null);
    const orderedIds = buildGlobalOrderForSave(
      services,
      orderDraft,
      servicesById,
      groupIds
    );
    try {
      const res = await fetch('/api/admin/services/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.message === 'string'
            ? data.message
            : data.error || 'Could not save order'
        );
      }

      const byId = new Map(services.map((s) => [s.id, s]));
      const reordered = orderedIds
        .map((id, index) => {
          const row = byId.get(id);
          return row ? { ...row, display_order: index } : null;
        })
        .filter((s): s is Service => s !== null);
      setOrderDraft(orderedIds);
      setServices(reordered);
      setOrderToast('Service order saved.');
      router.refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSavingOrder(false);
    }
  }

  // ── Derived: flat list of groups for the parent-picker dropdown ───────
  // Filtered by the form's current category so the editor can only
  // nest under a same-category parent — matches the API's
  // validateParentReference rule. Excludes the row being edited so
  // a service can't end up as its own parent.
  const candidateParents = useMemo(() => {
    const editingId =
      mode.kind === 'edit' ? mode.service.id : null;
    return services
      .filter(
        (s) =>
          s.is_group &&
          s.category === form.category &&
          s.id !== editingId
      )
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [services, form.category, mode]);

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
      // Groups have no duration; keep the field empty so the form
      // doesn't render "0" if the editor toggles is_group off mid-
      // edit (which the server forbids — we still keep the UI tidy).
      length: service.duration_mins !== null ? String(service.duration_mins) : '',
      is_group: service.is_group,
      parent_id: service.parent_id !== null ? String(service.parent_id) : '',
      // Pre-fill the colour input with the saved hex; '' means the
      // editor never set one yet (auto-matcher fallback in effect).
      color: service.color ?? '',
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
    length: number | null;
    is_group: boolean;
    parent_id: number | null;
    color: string | null;
  } | null {
    const title = form.title.trim();
    const category = form.category.trim();
    const description = form.description.trim();
    const price = Number(form.price);
    const is_group = form.is_group;
    const parent_id = form.parent_id ? Number(form.parent_id) : null;
    // Colour is OPTIONAL — '' means "no override, use the auto-
    // matcher". A non-empty value that doesn't canonicalise to a
    // valid 6-digit hex aborts submit with a clear message; the
    // canonicalised lower-case form is what we send to the API.
    let color: string | null = null;
    const rawColor = form.color.trim();
    if (rawColor) {
      const canonical = toCanonicalHex(rawColor);
      if (!canonical) {
        setSubmitError(
          `Calendar colour must be a hex like "#FE036A" (got "${rawColor}").`
        );
        return null;
      }
      color = canonical;
    }

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

    // Duration is only relevant for bookable services. For groups
    // we don't validate (and we send `null` on the wire). For
    // bookable services we keep the original 5-minute floor.
    let length: number | null = null;
    if (!is_group) {
      length = Number(form.length);
      if (!Number.isInteger(length) || length < 5) {
        setSubmitError(
          'Duration must be a whole number of at least 5 minutes.'
        );
        return null;
      }
    }

    // Defensive cross-field check before the server has to weigh in
    // (the API enforces this too, but a client-side message points
    // the editor at the exact mistake without a network round-trip).
    if (is_group && parent_id !== null) {
      setSubmitError(
        'A group header cannot itself be nested — clear "Nest under" or untick "This is a group header".'
      );
      return null;
    }

    return {
      title,
      category,
      description,
      price,
      length,
      is_group,
      parent_id,
      color,
    };
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
        const created = data.service as Service;
        setServices((prev) => sortServicesByDisplayOrder([...prev, created]));
        setOrderDraft((prev) => [...prev, created.id]);
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
      // The server now re-reads cal_event_id from the DB itself
      // (groups don't have one, and trusting a client-supplied id
      // for a group could PATCH `hidden: true` on the wrong event).
      // We only send db_id; cal_event_id is derived server-side.
      const qs = new URLSearchParams({ db_id: String(service.id) });
      const res = await fetch(`/api/admin/services?${qs.toString()}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Delete failed');
      }
      // Server cascade-removes children of a deleted group. Mirror
      // the cascade in local state so the list doesn't show stranded
      // child cards under a now-deleted parent until the next refetch.
      const removedIds = new Set<number>([service.id]);
      for (const s of services) {
        if (s.parent_id === service.id) removedIds.add(s.id);
      }
      setServices((prev) =>
        prev.filter((s) => !removedIds.has(s.id))
      );
      setOrderDraft((prev) => prev.filter((id) => !removedIds.has(id)));
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-xl text-stone-900">
            Service Catalogue
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            Lash column left, Brow right — same as the live site. ↑↓ to reorder,
            then Save order. Edit opens full details.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void saveOrder()}
            disabled={!orderDirty || isSavingOrder}
            className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-800 transition-colors hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
          >
            {isSavingOrder ? 'Saving order…' : 'Save order'}
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[#FAF9F6] transition-colors hover:bg-stone-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Add service
          </button>
        </div>
      </div>

      {orderToast && (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900"
        >
          <div className="flex items-center justify-between gap-3">
            <span>{orderToast}</span>
            <button
              type="button"
              onClick={() => setOrderToast(null)}
              className="text-emerald-800 underline-offset-2 hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

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
        <div className="rounded-xl border border-stone-200 bg-white px-4 py-6 sm:px-8 sm:py-8">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-0">
            {grouped.map((section, index) => (
              <div key={section.category} className="flex min-w-0 flex-1 flex-col lg:flex-row">
                {index > 0 && (
                  <div
                    className="my-6 h-px w-full shrink-0 bg-stone-200/90 lg:my-0 lg:mx-8 lg:h-auto lg:w-px lg:self-stretch"
                    aria-hidden
                  />
                )}
                <CategorySection
                  category={section.category}
                  renderedOrder={section.renderedOrder}
                  servicesById={servicesById}
                  groupIds={groupIds}
                  confirmingDeleteId={confirmingDeleteId}
                  deletingId={deletingId}
                  onEdit={openEdit}
                  onPrimeDelete={primeDelete}
                  onCancelDelete={cancelDelete}
                  onConfirmDelete={confirmDelete}
                  onMoveVisual={moveInCategoryVisual}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <SlideOverForm
        mode={mode}
        form={form}
        onChange={setForm}
        isSubmitting={isSubmitting}
        submitError={submitError}
        onSubmit={handleSubmit}
        onClose={closeForm}
        candidateParents={candidateParents}
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
  renderedOrder: number[];
  servicesById: Map<number, Service>;
  groupIds: Set<number>;
  confirmingDeleteId: number | null;
  deletingId: number | null;
  onEdit: (service: Service) => void;
  onPrimeDelete: (id: number) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (service: Service) => void;
  onMoveVisual: (
    category: string,
    serviceId: number,
    direction: -1 | 1
  ) => void;
}

function CategorySection({
  category,
  renderedOrder,
  servicesById,
  groupIds,
  confirmingDeleteId,
  deletingId,
  onEdit,
  onPrimeDelete,
  onCancelDelete,
  onConfirmDelete,
  onMoveVisual,
}: CategorySectionProps) {
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<number>>(
    () => new Set()
  );

  function toggleGroupCollapse(groupId: number) {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  const moveUnits = useMemo(
    () => buildMoveUnits(renderedOrder, servicesById),
    [renderedOrder, servicesById]
  );

  function rowProps(service: Service) {
    let canMoveUp = false;
    let canMoveDown = false;

    if (service.is_group) {
      const unitIndex = moveUnits.findIndex((unit) => unit[0] === service.id);
      canMoveUp = unitIndex > 0;
      canMoveDown = unitIndex >= 0 && unitIndex < moveUnits.length - 1;
    } else {
      const rowIndex = renderedOrder.indexOf(service.id);
      const above =
        rowIndex > 0 ? servicesById.get(renderedOrder[rowIndex - 1]) : null;
      const below =
        rowIndex >= 0 && rowIndex < renderedOrder.length - 1
          ? servicesById.get(renderedOrder[rowIndex + 1])
          : null;
      canMoveUp =
        rowIndex > 0 &&
        above !== null &&
        above !== undefined &&
        above.id !== service.parent_id;
      canMoveDown =
        rowIndex >= 0 &&
        rowIndex < renderedOrder.length - 1 &&
        below !== null &&
        below !== undefined &&
        below.parent_id !== service.id;
    }

    return {
      isConfirmingDelete: confirmingDeleteId === service.id,
      isDeleting: deletingId === service.id,
      canMoveUp,
      canMoveDown,
      onMoveUp: () => onMoveVisual(category, service.id, -1),
      onMoveDown: () => onMoveVisual(category, service.id, 1),
      onEdit: () => onEdit(service),
      onPrimeDelete: () => onPrimeDelete(service.id),
      onCancelDelete,
      onConfirmDelete: () => onConfirmDelete(service),
    };
  }

  const rows: ReactNode[] = [];

  for (let i = 0; i < renderedOrder.length; i++) {
    const service = servicesById.get(renderedOrder[i]);
    if (!service) continue;

    if (
      service.parent_id !== null &&
      groupIds.has(service.parent_id) &&
      !service.is_group
    ) {
      continue;
    }

    if (service.is_group) {
      const children: Service[] = [];
      for (let j = i + 1; j < renderedOrder.length; j++) {
        const child = servicesById.get(renderedOrder[j]);
        if (child?.parent_id === service.id) children.push(child);
        else break;
      }

      const isExpanded = !collapsedGroupIds.has(service.id);

      rows.push(
        <div key={service.id} className="py-1">
          <MenuServiceRow
            service={service}
            variant="group"
            isGroupExpanded={isExpanded}
            groupChildCount={children.length}
            onToggleGroupExpand={() => toggleGroupCollapse(service.id)}
            {...rowProps(service)}
          />
          {isExpanded &&
            (children.length > 0 ? (
              <div className="ml-2 border-l border-stone-200/80">
                {children.map((child) => (
                  <MenuServiceRow
                    key={child.id}
                    service={child}
                    variant="child"
                    {...rowProps(child)}
                  />
                ))}
              </div>
            ) : (
              <p className="py-2 pl-4 text-xs italic text-stone-400">
                No child services — use Edit on a bookable service to nest under
                this group.
              </p>
            ))}
        </div>
      );
      continue;
    }

    rows.push(
      <MenuServiceRow
        key={service.id}
        service={service}
        variant="standalone"
        {...rowProps(service)}
      />
    );
  }

  return (
    <section aria-label={category}>
      <h3 className="mb-5 border-b border-stone-200/80 pb-2 text-[10px] font-medium uppercase tracking-[0.36em] text-stone-900">
        {category}
      </h3>
      <div>{rows}</div>
    </section>
  );
}

type MenuRowVariant = 'group' | 'child' | 'standalone';

interface MenuServiceRowProps {
  service: Service;
  variant: MenuRowVariant;
  isConfirmingDelete: boolean;
  isDeleting: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onPrimeDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  isGroupExpanded?: boolean;
  groupChildCount?: number;
  onToggleGroupExpand?: () => void;
}

/** Compact list row — title + price/duration only; full fields live in the edit panel. */
function MenuServiceRow({
  service,
  variant,
  isConfirmingDelete,
  isDeleting,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onEdit,
  onPrimeDelete,
  onCancelDelete,
  onConfirmDelete,
  isGroupExpanded = true,
  groupChildCount = 0,
  onToggleGroupExpand,
}: MenuServiceRowProps) {
  const isGroup = variant === 'group';
  const isChild = variant === 'child';

  const priceLabel = isGroup
    ? `From ${formatPrice(service.price)}`
    : service.duration_mins !== null
      ? `${formatPrice(service.price)} · ${service.duration_mins} min`
      : formatPrice(service.price);

  return (
    <article
      className={`border-b border-stone-100 last:border-b-0 ${
        isConfirmingDelete ? 'bg-rose-50/50' : ''
      } ${isDeleting ? 'opacity-50' : ''}`}
    >
      <div
        className={`flex items-center gap-2 py-2.5 sm:gap-3 ${
          isChild ? 'pl-4 sm:pl-5' : ''
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {isGroup && onToggleGroupExpand && (
            <button
              type="button"
              onClick={onToggleGroupExpand}
              aria-expanded={isGroupExpanded}
              aria-label={
                isGroupExpanded
                  ? `Collapse ${service.title}`
                  : `Expand ${service.title}`
              }
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            >
              {isGroupExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          )}
          <div className="flex min-w-0 flex-1 items-baseline gap-2 sm:gap-4">
            {isGroup && (
              <span className="shrink-0 text-[9px] font-medium uppercase tracking-[0.2em] text-stone-400">
                Group
              </span>
            )}
            {isGroup && onToggleGroupExpand ? (
              <button
                type="button"
                onClick={onToggleGroupExpand}
                className="min-w-0 truncate text-left font-serif text-base leading-tight text-stone-900 hover:text-stone-700"
              >
                {service.title}
              </button>
            ) : (
              <h4 className="min-w-0 truncate font-serif text-base leading-tight text-stone-900">
                {service.title}
              </h4>
            )}
            {isGroup && !isGroupExpanded && groupChildCount > 0 && (
              <span className="shrink-0 text-xs text-stone-400">
                {groupChildCount} service{groupChildCount === 1 ? '' : 's'}
              </span>
            )}
            <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-stone-500">
              {priceLabel}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {isConfirmingDelete ? (
            <>
              <button
                type="button"
                onClick={onCancelDelete}
                disabled={isDeleting}
                className="rounded-md px-2 py-1.5 text-xs text-stone-600 hover:bg-stone-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={isDeleting}
                className="rounded-md bg-rose-600 px-2 py-1.5 text-xs font-medium text-white"
              >
                {isDeleting ? '…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onMoveUp();
                }}
                disabled={!canMoveUp || isDeleting}
                className="inline-flex h-8 w-8 touch-manipulation items-center justify-center text-stone-400 hover:bg-stone-100 hover:text-stone-800 disabled:pointer-events-none disabled:opacity-30"
                aria-label={`Move ${service.title} up`}
              >
                <ArrowUp className="pointer-events-none h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onMoveDown();
                }}
                disabled={!canMoveDown || isDeleting}
                className="inline-flex h-8 w-8 touch-manipulation items-center justify-center text-stone-400 hover:bg-stone-100 hover:text-stone-800 disabled:pointer-events-none disabled:opacity-30"
                aria-label={`Move ${service.title} down`}
              >
                <ArrowDown className="pointer-events-none h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="ml-1 inline-flex h-8 items-center gap-1 rounded-md border border-stone-200 bg-white px-2.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
              >
                <Pencil className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Edit</span>
              </button>
              <button
                type="button"
                onClick={onPrimeDelete}
                className="inline-flex h-8 w-8 items-center justify-center text-stone-400 hover:text-rose-600"
                aria-label={`Delete ${service.title}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
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
  /**
   * Same-category group rows the editor may nest the current service
   * under. Computed in the parent based on `form.category` so the
   * dropdown updates if the editor switches category mid-form.
   */
  candidateParents: Service[];
}

function SlideOverForm({
  mode,
  form,
  onChange,
  isSubmitting,
  submitError,
  onSubmit,
  onClose,
  candidateParents,
}: SlideOverFormProps) {
  const isOpen = mode.kind !== 'closed';
  const isEdit = mode.kind === 'edit';
  // is_group is immutable on the server side once a row exists —
  // toggling between bookable / group would require creating or
  // hard-deleting a Cal event mid-edit. The UI mirrors that rule by
  // locking the checkbox in edit mode; the editor's escape hatch is
  // "delete this row + create a fresh one with the right shape".
  const lockGroupToggle = isEdit;

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
            {isEdit && !form.is_group && mode.service.cal_event_id !== null && (
              <p className="text-xs text-stone-500">
                <a
                  href={`https://app.cal.com/event-types/${mode.service.cal_event_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-stone-700 underline-offset-2 hover:underline"
                >
                  Open in Cal.com
                </a>
                {' · '}
                Description, colour, duration, and pricing are edited here.
              </p>
            )}

            {/*
              Group toggle at the top of the form. Editors who want to
              create an accordion header pick this first; everything
              below the checkbox is conditional on it. Disabled in edit
              mode (see lockGroupToggle for the rationale) — the lock
              icon-free visual nudge here is the dimmed checkbox + the
              inline hint about deleting and recreating.
            */}
            <label
              htmlFor="svc-is-group"
              className={`flex cursor-pointer items-start gap-3 rounded-lg border bg-white p-4 transition-colors ${
                lockGroupToggle
                  ? 'cursor-not-allowed border-stone-200 opacity-70'
                  : form.is_group
                    ? 'border-stone-900 ring-1 ring-stone-900'
                    : 'border-stone-200 hover:border-stone-300'
              }`}
            >
              <input
                id="svc-is-group"
                type="checkbox"
                checked={form.is_group}
                disabled={lockGroupToggle}
                onChange={(e) => {
                  const next = e.target.checked;
                  // Toggling on: clear parent_id (groups can't be
                  // nested) AND clear length (groups don't carry one).
                  // Toggling off: leave the fields untouched so the
                  // editor doesn't have to retype after a misclick.
                  onChange(
                    next
                      ? { ...form, is_group: true, parent_id: '', length: '' }
                      : { ...form, is_group: false }
                  );
                }}
                className="mt-1 h-4 w-4 cursor-pointer rounded border-stone-300 text-stone-900 focus:ring-stone-900 disabled:cursor-not-allowed"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-stone-900">
                  This is a Group Header (Parent)
                </span>
                <span className="mt-1 block text-xs text-stone-500">
                  Group headers are accordion containers on the public
                  site. They don't sync to Cal.com and aren't bookable
                  on their own — their child services are.
                  {lockGroupToggle && (
                    <span className="mt-1 block italic">
                      Locked while editing. To convert this row, delete
                      it and create a new one with the desired shape.
                    </span>
                  )}
                </span>
              </span>
            </label>

            <Field label="Title" htmlFor="svc-title" required>
              <input
                id="svc-title"
                type="text"
                required
                maxLength={120}
                value={form.title}
                onChange={(e) => onChange({ ...form, title: e.target.value })}
                placeholder={
                  form.is_group ? 'Volume Lash Sets' : 'Classic Lash Set'
                }
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

            {/*
              Parent picker. Only meaningful for bookable services
              (groups themselves are always top-level), so we hide it
              entirely when is_group is true. The "None (Standalone)"
              option is the no-parent default and uses an empty
              string value — converted to null at submit.

              When the editor switches category, candidateParents
              recomputes in the parent component to scope the choices
              to same-category groups. If the previously-selected
              parent moves out of scope (cross-category edit), we
              still render it as a flagged stale option so the editor
              sees the existing state before it's silently dropped on
              save — same pattern as the legacy-category escape hatch.
            */}
            {!form.is_group && (
              <Field
                label="Nest under…"
                htmlFor="svc-parent"
                hint={
                  candidateParents.length === 0
                    ? `No group headers in "${form.category}" yet. Create a group first to nest services beneath it.`
                    : 'Choose a group header to nest this service under. Standalone services appear at the top level.'
                }
              >
                <select
                  id="svc-parent"
                  value={form.parent_id}
                  onChange={(e) =>
                    onChange({ ...form, parent_id: e.target.value })
                  }
                  disabled={candidateParents.length === 0}
                  className={`${inputClass} appearance-none bg-size-[14px_14px] bg-position-[right_0.75rem_center] bg-no-repeat pr-9 bg-[url("data:image/svg+xml;utf8,<svg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2020%2020'%20fill='%2378716c'><path%20d='M5.516%207.548L10%2012.032l4.484-4.484L16%209.064l-6%206-6-6z'/></svg>")] disabled:opacity-60`}
                >
                  <option value="">None (Standalone)</option>
                  {candidateParents.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.title}
                    </option>
                  ))}
                  {form.parent_id &&
                    !candidateParents.some(
                      (p) => String(p.id) === form.parent_id
                    ) && (
                      <option value={form.parent_id}>
                        Parent #{form.parent_id} (stale — different
                        category)
                      </option>
                    )}
                </select>
              </Field>
            )}

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

            {/*
              Price + Duration row. For groups, duration is omitted
              entirely and price becomes a single full-width field
              labelled "From price ($)" — the public site renders it
              with a "From " prefix, and matching that wording in the
              admin label keeps the preview honest.
            */}
            {form.is_group ? (
              <Field
                label='"From" price ($)'
                htmlFor="svc-price"
                required
                hint="Shown on the public site as 'From $X' on the group header."
              >
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
            ) : (
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
                  hint="Service length for the appointment; bookable start times are offered every 30 minutes on the calendar."
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
            )}

            <ColorField
              value={form.color}
              onChange={(next) => onChange({ ...form, color: next })}
            />

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

interface ColorFieldProps {
  /** Raw form value — '' or a hex string in any case, with/without `#'. */
  value: string;
  onChange: (next: string) => void;
}

/**
 * Hex-code editor with three coordinated controls:
 *
 *   1. The native `<input type="color">` swatch — gives editors the
 *      OS colour-picker for quick visual exploration without dragging
 *      a heavyweight react-colorful dependency in.
 *   2. A free-text `<input>` for typing/pasting an exact hex. This is
 *      the canonical "hex code editor" the studio asked for — pasting
 *      `FE036A` (no hash) or `#fe036a` (lower) both work; we lean on
 *      `toCanonicalHex` to normalise both into the form Postgres
 *      stores so the swatch and the saved value never disagree.
 *   3. A "Clear" button that wipes both controls back to '' which
 *      maps to NULL in the DB and re-engages the auto-matcher
 *      fallback in app/admin/serviceColors.ts.
 *
 * The text input owns the source-of-truth state; the swatch reads
 * canonicalised value via `toCanonicalHex` so partial typing
 * (`#fe03` mid-keystroke) doesn't reset the colour picker — it just
 * keeps showing the last valid hex. A small "preview" pill on the
 * right paints the appointment-block colour at the size + radius
 * the calendar will actually render, so editors see the studio chrome
 * 1:1 before saving.
 */
function ColorField({ value, onChange }: ColorFieldProps) {
  const canonical = toCanonicalHex(value);
  // The native picker NEEDS a valid 7-char hex; default to a neutral
  // stone when the field is empty so the swatch doesn't render
  // browser-default black, which would mis-signal "this service has
  // a black colour assigned".
  const swatchValue = canonical ?? '#a8a29e';
  const hasColor = canonical !== null;

  return (
    <div>
      <label
        htmlFor="svc-color-hex"
        className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500"
      >
        Calendar colour
      </label>

      <div className="flex items-center gap-2">
        {/* Native colour swatch — clicking it opens the OS picker.
            We hide the underlying input visually (it's the entire 40×40
            box) and style the wrapper as the bordered swatch so the
            visual is consistent across browsers. */}
        <label
          htmlFor="svc-color-swatch"
          className="relative inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm transition-shadow hover:shadow-md"
          aria-label="Open OS colour picker"
        >
          <span
            aria-hidden="true"
            className="block h-full w-full"
            style={{
              backgroundColor: hasColor ? swatchValue : 'transparent',
              backgroundImage: hasColor
                ? undefined
                : // Subtle checker pattern signals "no colour set" without
                  // resorting to a separate empty-state component. The
                  // pattern is reused on the card chip below.
                  'linear-gradient(45deg, #e7e5e4 25%, transparent 25%), linear-gradient(-45deg, #e7e5e4 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e7e5e4 75%), linear-gradient(-45deg, transparent 75%, #e7e5e4 75%)',
              backgroundSize: hasColor ? undefined : '8px 8px',
              backgroundPosition: hasColor
                ? undefined
                : '0 0, 0 4px, 4px -4px, -4px 0',
            }}
          />
          <input
            id="svc-color-swatch"
            type="color"
            value={swatchValue}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            // Fully cover the parent so the click anywhere on the swatch
            // opens the OS picker; `opacity-0` hides Chrome/Safari's
            // default chrome but keeps the input clickable.
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>

        {/* Hex text input — the canonical editor. Accepts any case,
            with/without leading `#`, and 3-char shorthand; the
            canonicaliser handles the rest at submit time. */}
        <input
          id="svc-color-hex"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={7}
          placeholder="#FE036A"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // monospace + tracking-wider so a hex code reads as a code,
          // matching the look of CSS variables in the editor.
          className={`${inputClass} font-mono uppercase tracking-wider`}
        />

        {hasColor && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="inline-flex shrink-0 items-center rounded-full border border-stone-200 bg-white px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            Clear
          </button>
        )}
      </div>

      <p className="mt-1.5 text-xs text-stone-400">
        {hasColor
          ? 'This colour paints every appointment of this service on the admin calendar.'
          : 'No colour assigned — appointments of this service will render with neutral chrome until a hex is set.'}
      </p>
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
