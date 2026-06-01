'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, X } from 'lucide-react';

import ConsentPdfScrollViewer from './ConsentPdfScrollViewer';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';

interface Props {
  previewPdf: string;
  signatureData: string | null;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onSignatureSaved: (dataUrl: string) => void;
  onClearSignature: () => void;
  onSubmitFinal: () => void;
}

export default function ConsentPreviewStep({
  previewPdf,
  signatureData,
  submitting,
  error,
  onBack,
  onSignatureSaved,
  onClearSignature,
  onSubmitFinal,
}: Props) {
  const [signModalOpen, setSignModalOpen] = useState(false);
  const [documentReady, setDocumentReady] = useState(false);
  const signatureRef = useRef<SignaturePadHandle>(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    if (!signModalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [signModalOpen]);

  const saveSignatureFromModal = () => {
    const dataUrl = signatureRef.current?.toDataURL();
    if (!dataUrl) return;
    onSignatureSaved(dataUrl);
    setSignModalOpen(false);
  };

  return (
    <div className="consent-preview-root fixed inset-0 z-50 flex flex-col bg-stone-200">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-300/80 bg-[#FAF9F6] px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-700 hover:text-stone-900 disabled:opacity-50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to edit
        </button>
        <p className="font-serif text-sm text-stone-800">Review your document</p>
        <span className="w-20" aria-hidden />
      </header>

      <div
        className={`min-h-0 flex-1 overflow-y-auto bg-stone-300/50 py-4 ${
          signatureData ? 'pb-[5.5rem]' : 'pb-8'
        }`}
      >
        <div className="mx-auto max-w-3xl px-2 sm:px-4">
          <ConsentPdfScrollViewer
            pdfBase64={previewPdf}
            signatureImageSrc={signatureData}
            onReadyChange={setDocumentReady}
          />
        </div>

        {!signatureData && documentReady && (
          <div className="mx-auto max-w-3xl px-4 pt-4">
            <div className="rounded-xl border-2 border-dashed border-stone-400 bg-white/95 p-5 shadow-sm">
              <p className="mb-1 text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                Signature required
              </p>
              <p className="mb-4 text-center text-sm text-stone-600">
                Scroll to the signature line on the last page, then tap below to sign.
              </p>
              <button
                type="button"
                onClick={() => setSignModalOpen(true)}
                disabled={submitting}
                className="w-full rounded-lg border-2 border-stone-900 bg-stone-900 px-6 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-white shadow-lg transition-colors hover:bg-stone-800 disabled:opacity-50"
              >
                Tap here to sign
              </button>
            </div>
          </div>
        )}
      </div>

      {signatureData && (
        <div className="shrink-0 border-t border-stone-300/80 bg-[#FAF9F6] px-4 py-4 shadow-[0_-4px_24px_rgba(0,0,0,0.06)]">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 sm:flex-row sm:items-stretch">
            <button
              type="button"
              onClick={() => {
                onClearSignature();
                setSignModalOpen(true);
              }}
              disabled={submitting}
              className="order-2 rounded-xl border-2 border-stone-300 bg-white px-4 py-3.5 text-sm font-semibold uppercase tracking-[0.1em] text-stone-800 transition-colors hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 sm:order-1 sm:min-w-[11.5rem] sm:shrink-0"
            >
              Clear &amp; sign again
            </button>
            <button
              type="button"
              onClick={onSubmitFinal}
              disabled={submitting}
              className="order-1 flex flex-1 items-center justify-center gap-2 rounded-xl bg-stone-900 px-4 py-3.5 text-sm font-semibold uppercase tracking-[0.1em] text-white shadow-lg transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 sm:order-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Submitting…
                </>
              ) : (
                'Submit final document'
              )}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="pointer-events-none fixed left-1/2 top-20 z-[60] w-[min(100%,28rem)] -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-center text-sm text-red-800 shadow-lg">
          {error}
        </p>
      )}

      {signModalOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-stone-900/60 p-4 sm:items-center"
          role="presentation"
          onClick={() => setSignModalOpen(false)}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-2xl border border-stone-200 bg-[#FAF9F6] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Sign consent form"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
              <p className="font-serif text-lg text-stone-900">Your signature</p>
              <button
                type="button"
                onClick={() => setSignModalOpen(false)}
                aria-label="Close"
                className="rounded-full p-1 text-stone-500 hover:bg-stone-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4">
              <SignaturePad ref={signatureRef} />
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => signatureRef.current?.clear()}
                  className="flex-1 rounded-lg border border-stone-200 bg-white py-2.5 text-sm font-medium text-stone-800 hover:bg-stone-50"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={saveSignatureFromModal}
                  className="flex-1 rounded-lg bg-stone-900 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
                >
                  Save signature
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
