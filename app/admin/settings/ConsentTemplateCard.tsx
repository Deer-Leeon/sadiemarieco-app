'use client';

import { Download, FileText, Loader2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConsentTemplateWire } from '@/lib/studio-settings';

type LoadState = 'loading' | 'ready' | 'error';

function errorLabel(code: string): string {
  switch (code) {
    case 'invalid_file_type':
      return 'Please choose a PDF file (.pdf).';
    case 'file_too_large':
      return 'PDF must be 4.5 MB or smaller.';
    case 'empty_file':
      return 'The selected file is empty.';
    case 'blob_upload_failed':
      return 'Upload to storage failed. Try again.';
    case 'db_update_failed':
    case 'db_select_failed':
      return 'Could not save the template. Try again.';
    case 'settings_row_missing':
      return 'Database not set up. Run scripts/create_studio_settings.sql.';
    default:
      return 'Upload failed. Try again.';
  }
}

export default function ConsentTemplateCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [consentPdfUrl, setConsentPdfUrl] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const loadTemplate = useCallback(async () => {
    setLoadState('loading');
    setFetchError(null);
    try {
      const res = await fetch('/api/admin/settings/template', {
        cache: 'no-store',
      });
      const data = (await res.json()) as ConsentTemplateWire & { error?: string };
      if (!res.ok) {
        setFetchError(data.error ?? 'load_failed');
        setLoadState('error');
        return;
      }
      setConsentPdfUrl(data.consent_pdf_url ?? null);
      setLoadState('ready');
    } catch {
      setFetchError('network_error');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void loadTemplate();
  }, [loadTemplate]);

  const resetFileInput = () => {
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadError(null);
    try {
      const body = new FormData();
      body.append('file', selectedFile);
      const res = await fetch('/api/admin/settings/template', {
        method: 'POST',
        body,
      });
      const data = (await res.json()) as ConsentTemplateWire & { error?: string };
      if (!res.ok) {
        setUploadError(errorLabel(data.error ?? 'upload_failed'));
        return;
      }
      setConsentPdfUrl(data.consent_pdf_url ?? null);
      setReplaceOpen(false);
      resetFileInput();
    } catch {
      setUploadError('Network error while uploading.');
    } finally {
      setUploading(false);
    }
  };

  const hasTemplate = Boolean(consentPdfUrl);
  const showUploadForm =
    !hasTemplate || replaceOpen;

  const downloadFilename =
    consentPdfUrl?.split('/').pop()?.split('?')[0] ?? 'consent-template.pdf';

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-100">
          <FileText className="h-5 w-5 text-stone-600" aria-hidden />
        </div>
        <div>
          <h2 className="font-serif text-xl text-stone-900">
            Consent Form Template (PDF)
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            Upload the studio&apos;s master consent PDF. Clients and staff can
            download the current version from this link.
          </p>
        </div>
      </div>

      {loadState === 'loading' && (
        <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading template…
        </div>
      )}

      {loadState === 'error' && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {fetchError === 'network_error'
            ? 'Could not reach the server.'
            : errorLabel(fetchError ?? 'load_failed')}
          <button
            type="button"
            onClick={() => void loadTemplate()}
            className="mt-2 block text-xs font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}

      {loadState === 'ready' && (
        <div className="space-y-4">
          {hasTemplate && !replaceOpen && (
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={consentPdfUrl!}
                download={downloadFilename}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-[#FAF9F6] px-4 py-2.5 text-sm font-medium text-stone-800 transition-colors hover:bg-stone-100"
              >
                <Download className="h-4 w-4" aria-hidden />
                Download current template
              </a>
              <button
                type="button"
                onClick={() => {
                  setReplaceOpen(true);
                  setUploadError(null);
                  resetFileInput();
                }}
                disabled={uploading}
                className="inline-flex items-center gap-2 rounded-lg border border-stone-900 bg-white px-4 py-2.5 text-sm font-medium text-stone-900 transition-colors hover:bg-stone-50 disabled:opacity-50"
              >
                Replace template
              </button>
            </div>
          )}

          {showUploadForm && (
            <div className="space-y-3 rounded-md border border-dashed border-stone-200 bg-[#FAF9F6]/60 p-4">
              {hasTemplate && replaceOpen && (
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-500">
                  Replace template
                </p>
              )}
              <label className="block">
                <span className="sr-only">PDF file</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setSelectedFile(file);
                    setUploadError(null);
                  }}
                  className="block w-full text-sm text-stone-700 file:mr-4 file:rounded-md file:border-0 file:bg-stone-900 file:px-3 file:py-2 file:text-xs file:font-medium file:text-white hover:file:bg-stone-800 disabled:opacity-50"
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleUpload()}
                  disabled={uploading || !selectedFile}
                  className="inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Uploading…
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4" aria-hidden />
                      {hasTemplate ? 'Upload replacement' : 'Upload template'}
                    </>
                  )}
                </button>
                {hasTemplate && replaceOpen && (
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => {
                      setReplaceOpen(false);
                      resetFileInput();
                      setUploadError(null);
                    }}
                    className="text-sm text-stone-600 underline underline-offset-2 hover:text-stone-900 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {selectedFile && !uploading && (
                <p className="text-xs text-stone-500">
                  Selected: {selectedFile.name} (
                  {(selectedFile.size / 1024).toFixed(0)} KB)
                </p>
              )}
            </div>
          )}

          {uploadError && (
            <p className="text-sm text-rose-700" role="alert">
              {uploadError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
