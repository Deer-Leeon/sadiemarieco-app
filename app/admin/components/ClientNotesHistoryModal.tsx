'use client';

import { useCallback, useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Loader2, Pin, X } from 'lucide-react';

import type { ClientNote } from '@/app/admin/types';

interface Props {
  clientId: string;
  open: boolean;
  onClose: () => void;
  /** Called after pin toggle so the profile can refresh counts. */
  onNotesUpdated?: () => void;
}

function sortNotes(notes: ClientNote[]): ClientNote[] {
  return [...notes].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function NoteCard({
  note,
  toggling,
  onTogglePin,
}: {
  note: ClientNote;
  toggling: boolean;
  onTogglePin: (note: ClientNote) => void;
}) {
  let savedLabel = note.created_at;
  try {
    savedLabel = format(parseISO(note.created_at), 'MMM d, yyyy · h:mm a');
  } catch {
    // keep raw ISO
  }

  return (
    <article
      className={`rounded-lg border p-4 ${
        note.is_pinned
          ? 'border-amber-200/80 bg-amber-50/40'
          : 'border-stone-200 bg-white'
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-stone-500">
          {savedLabel}
        </p>
        <button
          type="button"
          onClick={() => onTogglePin(note)}
          disabled={toggling}
          aria-label={note.is_pinned ? 'Unpin note' : 'Pin note'}
          aria-pressed={note.is_pinned}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-200 disabled:opacity-50 ${
            note.is_pinned
              ? 'border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200/80'
              : 'border-stone-200 bg-stone-50 text-stone-500 hover:border-stone-300 hover:text-stone-800'
          }`}
        >
          <Pin
            className="h-3.5 w-3.5"
            strokeWidth={note.is_pinned ? 0 : 1.75}
            fill={note.is_pinned ? 'currentColor' : 'none'}
            aria-hidden
          />
        </button>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-800">
        {note.notes || (
          <span className="text-stone-400 italic">Empty note</span>
        )}
      </p>
    </article>
  );
}

export default function ClientNotesHistoryModal({
  clientId,
  open,
  onClose,
  onNotesUpdated,
}: Props) {
  const [notes, setNotes] = useState<ClientNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/clients/${clientId}/notes`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { notes: ClientNote[] };
      setNotes(sortNotes(data.notes ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    if (!open) return;
    void loadNotes();
  }, [open, loadNotes]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onTogglePin = async (note: ClientNote) => {
    if (togglingId != null) return;
    const nextPinned = !note.is_pinned;
    setTogglingId(note.id);
    setNotes((prev) =>
      sortNotes(
        prev.map((n) =>
          n.id === note.id ? { ...n, is_pinned: nextPinned } : n
        )
      )
    );
    try {
      const res = await fetch(
        `/api/admin/clients/${clientId}/notes/${note.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_pinned: nextPinned }),
        }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { note: ClientNote };
      setNotes((prev) =>
        sortNotes(prev.map((n) => (n.id === data.note.id ? data.note : n)))
      );
      onNotesUpdated?.();
    } catch (err) {
      setNotes((prev) =>
        sortNotes(
          prev.map((n) =>
            n.id === note.id ? { ...n, is_pinned: note.is_pinned } : n
          )
        )
      );
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingId(null);
    }
  };

  if (!open) return null;

  const pinned = notes.filter((n) => n.is_pinned);
  const unpinned = notes.filter((n) => !n.is_pinned);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-[#FAF9F6] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-notes-history-title"
      >
        <div className="flex items-start justify-between gap-3 border-b border-stone-200/70 px-5 py-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
              Private notes
            </p>
            <h2
              id="client-notes-history-title"
              className="font-serif text-xl text-stone-900"
            >
              All notes
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close notes history"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading history…
            </div>
          ) : error ? (
            <p className="py-8 text-center text-sm text-rose-700">{error}</p>
          ) : notes.length === 0 ? (
            <p className="py-8 text-center text-sm text-stone-500">
              No notes saved yet.
            </p>
          ) : (
            <div className="space-y-4">
              {pinned.length > 0 && (
                <section>
                  <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-amber-800/80">
                    Pinned
                  </p>
                  <div className="space-y-3">
                    {pinned.map((note) => (
                      <NoteCard
                        key={note.id}
                        note={note}
                        toggling={togglingId === note.id}
                        onTogglePin={onTogglePin}
                      />
                    ))}
                  </div>
                </section>
              )}
              {unpinned.length > 0 && (
                <section>
                  {pinned.length > 0 && (
                    <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-stone-500">
                      History
                    </p>
                  )}
                  <div className="space-y-3">
                    {unpinned.map((note) => (
                      <NoteCard
                        key={note.id}
                        note={note}
                        toggling={togglingId === note.id}
                        onTogglePin={onTogglePin}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-stone-200/70 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-full border border-stone-200 bg-white py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-stone-800 transition-colors hover:bg-stone-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
