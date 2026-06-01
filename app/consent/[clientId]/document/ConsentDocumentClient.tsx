'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Download, ExternalLink, Loader2 } from 'lucide-react';

import type { ConsentApiResponse } from '@/lib/consent';
import {
  consentFormPath,
  isValidClientUuid,
  resolveConsentPdfUrl,
} from '@/lib/consent';

import ConsentPdfScrollViewer from '../ConsentPdfScrollViewer';

export default function ConsentDocumentClient({ clientId }: { clientId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ConsentApiResponse | null>(null);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isValidClientUuid(clientId)) {
      setError('Invalid client link.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/consent/${clientId}`);
      const payload = (await res.json()) as ConsentApiResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(payload.message || payload.error || `Failed to load (${res.status})`);
      }
      setData(payload);

      const pdfUrl = resolveConsentPdfUrl(payload.intake, payload.client.consent_form_url);
      if (!pdfUrl) {
        if (!payload.submitted) {
          setError('redirect_to_form');
        } else {
          setError('Your signed PDF is not ready yet. Please contact the studio.');
        }
        return;
      }

      const pdfRes = await fetch(pdfUrl);
      if (!pdfRes.ok) {
        throw new Error('Could not load your signed PDF.');
      }
      const buffer = await pdfRes.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      setPdfBase64(btoa(binary));
    } catch (loadErr) {
      setError(loadErr instanceof Error ? loadErr.message : 'Failed to load document');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#FAF9F6] text-stone-500">
        <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        <p className="mt-3 text-sm">Loading your signed consent…</p>
      </div>
    );
  }

  if (error === 'redirect_to_form') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FAF9F6] px-4">
        <div className="max-w-md rounded-xl border border-stone-200 bg-white p-8 text-center shadow-sm">
          <p className="font-serif text-xl text-stone-900">Consent form not submitted</p>
          <p className="mt-2 text-sm text-stone-600">
            Complete your intake and consent form first.
          </p>
          <Link
            href={consentFormPath(clientId)}
            className="mt-6 inline-flex rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
          >
            Go to consent form
          </Link>
        </div>
      </div>
    );
  }

  const pdfUrl =
    data &&
    resolveConsentPdfUrl(data.intake, data.client.consent_form_url);

  if (error || !pdfBase64 || !pdfUrl) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FAF9F6] px-4">
        <div className="max-w-md rounded-xl border border-stone-200 bg-white p-8 text-center">
          <p className="font-serif text-xl text-stone-900">Unable to load document</p>
          <p className="mt-2 text-sm text-stone-600">{error ?? 'Document unavailable.'}</p>
        </div>
      </div>
    );
  }

  const clientName = [data.client.first_name, data.client.last_name]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-stone-200">
      <header className="shrink-0 border-b border-stone-300/80 bg-[#FAF9F6] px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <Check className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h1 className="font-serif text-xl text-stone-900">Signed consent on file</h1>
              <p className="text-sm text-stone-600">
                {clientName ? `${clientName} · ` : ''}
                Save or print this document anytime from this page.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={pdfUrl}
              download
              className="inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download PDF
            </a>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-sm font-medium text-stone-800 hover:bg-stone-50"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Open in tab
            </a>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        <ConsentPdfScrollViewer pdfBase64={pdfBase64} />
      </div>

      <p className="shrink-0 border-t border-stone-300/80 bg-[#FAF9F6] py-3 text-center text-[10px] uppercase tracking-widest text-stone-400">
        mckenna@sadiemarie.co · sadiemarie.co
      </p>
    </div>
  );
}
