'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2 } from 'lucide-react';

import type { ConsentApiResponse, ConsentFormData } from '@/lib/consent';
import { isValidClientUuid } from '@/lib/consent';

import {
  allAgreementsAccepted,
  asConsentAgreements,
  asMedicalConditions,
  buildInitialForm,
  CONSENT_POLICY_ITEMS,
  MEDICAL_CONDITION_FIELDS,
  type ConsentAgreementKey,
  type MedicalConditionKey,
} from './consent-form-config';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';

const inputClass =
  'mt-1 w-full rounded-md border border-stone-200 bg-[#FAF9F6] px-3 py-2 text-sm text-stone-900 outline-none ring-stone-300 focus:ring-2';

const sectionClass =
  'rounded-lg border border-stone-200 bg-white p-5 shadow-sm';

const sectionTitleClass =
  'text-[10px] font-medium uppercase tracking-[0.24em] text-stone-500';

function ConditionToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
        checked
          ? 'border-stone-300 bg-stone-100/80'
          : 'border-stone-100 bg-[#FAF9F6] hover:border-stone-200'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-stone-300 text-stone-900 focus:ring-stone-400"
      />
      <span className="text-sm leading-snug text-stone-800">{label}</span>
    </label>
  );
}

function PolicyAgreement({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`block cursor-pointer rounded-md border p-4 transition-colors ${
        checked
          ? 'border-emerald-200/80 bg-emerald-50/40'
          : 'border-stone-100 bg-[#FAF9F6] hover:border-stone-200'
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          required
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300 text-stone-900 focus:ring-stone-400"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-stone-900">{title}</span>
          <span className="mt-1.5 block text-xs leading-relaxed text-stone-600">
            {description}
          </span>
        </span>
      </div>
    </label>
  );
}

function SubmittedView({ data }: { data: ConsentApiResponse }) {
  const formData = data.intake?.form_data ?? {};
  const submittedAt = data.intake?.submitted_at;
  const signature =
    data.intake?.signature_image ??
    (typeof formData.signature_image === 'string' ? formData.signature_image : null);

  const medical = asMedicalConditions(formData.medical_conditions);
  const agreements = asConsentAgreements(formData.consent_agreements);
  const flaggedConditions = MEDICAL_CONDITION_FIELDS.filter((f) => medical[f.key]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-emerald-200/90 bg-emerald-50/50 p-5 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-700" aria-hidden />
        </div>
        <h1 className="mt-3 font-serif text-2xl text-stone-900">
          Form successfully submitted
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          Your intake and consent are on file. This form is locked and cannot be
          edited.
        </p>
        {submittedAt && (
          <p className="mt-2 text-xs text-stone-500">
            Submitted {new Date(submittedAt).toLocaleString()}
          </p>
        )}
      </div>

      <section className={sectionClass}>
        <h2 className={sectionTitleClass}>Client information</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4 border-b border-stone-100 pb-2">
            <dt className="text-stone-500">Full name</dt>
            <dd className="text-right font-medium text-stone-900">
              {String(formData.full_name || '—')}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-stone-100 pb-2">
            <dt className="text-stone-500">Phone</dt>
            <dd className="text-right text-stone-900">
              {String(formData.phone || '—')}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-stone-500">Email</dt>
            <dd className="text-right text-stone-900">
              {String(formData.email || '—')}
            </dd>
          </div>
        </dl>
      </section>

      <section className={sectionClass}>
        <h2 className={sectionTitleClass}>Medical history &amp; eye health</h2>
        <p className="mt-2 text-xs text-stone-500">
          Conditions marked at time of submission:
        </p>
        {flaggedConditions.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {flaggedConditions.map((f) => (
              <li
                key={f.key}
                className="flex items-start gap-2 rounded-md bg-amber-50/60 px-3 py-2 text-sm text-stone-800"
              >
                <span className="mt-0.5 text-amber-700" aria-hidden>
                  •
                </span>
                {f.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-stone-600">None indicated.</p>
        )}
        <div className="mt-4 border-t border-stone-100 pt-4">
          <p className="text-xs font-medium text-stone-500">
            Medications, vitamins &amp; eye drops
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-stone-900">
            {String(formData.medications || '').trim() || 'None listed.'}
          </p>
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className={sectionTitleClass}>Studio policies &amp; liability release</h2>
        <ul className="mt-4 space-y-3">
          {CONSENT_POLICY_ITEMS.map((item) => (
            <li
              key={item.key}
              className="rounded-md border border-stone-100 bg-[#FAF9F6] px-3 py-3"
            >
              <p className="text-sm font-medium text-stone-900">{item.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-stone-600">
                {item.description}
              </p>
              <p className="mt-2 text-xs font-medium text-emerald-800">
                {agreements[item.key] ? 'Acknowledged' : '—'}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {signature && (
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>Digital signature</h2>
          <div className="mt-4 rounded-md border border-stone-200 bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={signature}
              alt="Client signature"
              className="mx-auto max-h-32 w-full max-w-md object-contain"
            />
          </div>
        </section>
      )}

      <p className="text-center">
        <Link
          href="https://www.sadiemarie.co"
          className="text-sm font-medium text-stone-800 underline underline-offset-2 hover:text-stone-950"
        >
          Back to sadiemarie.co
        </Link>
      </p>
    </div>
  );
}

function EditableForm({
  clientId,
  initial,
  onSubmitted,
}: {
  clientId: string;
  initial: ConsentApiResponse;
  onSubmitted: (data: ConsentApiResponse) => void;
}) {
  const [form, setForm] = useState<ConsentFormData>(() =>
    buildInitialForm(initial.client)
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signatureTouched, setSignatureTouched] = useState(false);
  const signatureRef = useRef<SignaturePadHandle>(null);

  const medical = asMedicalConditions(form.medical_conditions);
  const agreements = asConsentAgreements(form.consent_agreements);

  const setField = (key: string, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setMedical = (key: MedicalConditionKey, value: boolean) => {
    setForm((prev) => ({
      ...prev,
      medical_conditions: {
        ...asMedicalConditions(prev.medical_conditions),
        [key]: value,
      },
    }));
  };

  const setAgreement = (key: ConsentAgreementKey, value: boolean) => {
    setForm((prev) => ({
      ...prev,
      consent_agreements: {
        ...asConsentAgreements(prev.consent_agreements),
        [key]: value,
      },
    }));
  };

  const canSubmit = allAgreementsAccepted(agreements) && signatureTouched;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const signatureData = signatureRef.current?.toDataURL();
    if (!signatureData) {
      setError('Please sign in the signature box before submitting.');
      return;
    }
    if (!allAgreementsAccepted(agreements)) {
      setError('Please acknowledge all studio policies.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/consent/${clientId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_data: form,
          signature_image: signatureData,
        }),
      });
      const payload = (await res.json()) as ConsentApiResponse & {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(
          payload.message || payload.error || `Submit failed (${res.status})`
        );
      }
      onSubmitted({
        client: payload.client,
        intake: payload.intake,
        submitted: payload.submitted ?? true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <header className="text-center">
        <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
          Sadie Marie
        </p>
        <h1 className="mt-2 font-serif text-2xl text-stone-900">
          Client intake &amp; consent
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          Please complete all sections before your appointment.
        </p>
      </header>

      <section className={sectionClass}>
        <h2 className={sectionTitleClass}>Client information</h2>
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-stone-700">Full name</span>
            <input
              type="text"
              required
              value={String(form.full_name ?? '')}
              onChange={(e) => setField('full_name', e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-stone-700">Phone</span>
            <input
              type="tel"
              required
              value={String(form.phone ?? '')}
              onChange={(e) => setField('phone', e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-stone-700">Email</span>
            <input
              type="email"
              value={String(form.email ?? '')}
              onChange={(e) => setField('email', e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className={sectionTitleClass}>Medical history &amp; eye health</h2>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">
          Check all that apply. This helps us provide safe, appropriate service.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MEDICAL_CONDITION_FIELDS.map((field) => (
            <ConditionToggle
              key={field.key}
              label={field.label}
              checked={medical[field.key]}
              onChange={(v) => setMedical(field.key, v)}
            />
          ))}
        </div>
        <label className="mt-5 block">
          <span className="text-xs font-medium text-stone-700">
            Please list any current medications, vitamins, or eye drops:
          </span>
          <textarea
            rows={4}
            value={String(form.medications ?? '')}
            onChange={(e) => setField('medications', e.target.value)}
            placeholder="List each item, or write “None” if not applicable."
            className={`${inputClass} resize-y`}
          />
        </label>
      </section>

      <section className={sectionClass}>
        <h2 className={sectionTitleClass}>
          Studio policies &amp; liability release
        </h2>
        <p className="mt-2 text-xs text-stone-500">
          Please read each policy and check the box to acknowledge.
        </p>
        <div className="mt-4 space-y-3">
          {CONSENT_POLICY_ITEMS.map((item) => (
            <PolicyAgreement
              key={item.key}
              title={item.title}
              description={item.description}
              checked={agreements[item.key]}
              onChange={(v) => setAgreement(item.key, v)}
            />
          ))}
        </div>
      </section>

      <section className={sectionClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={sectionTitleClass}>Digital signature</h2>
          <button
            type="button"
            onClick={() => {
              signatureRef.current?.clear();
              setSignatureTouched(false);
            }}
            className="text-xs font-medium text-stone-600 underline underline-offset-2 hover:text-stone-900"
          >
            Clear signature
          </button>
        </div>
        <div className="mt-4">
          <SignaturePad
            ref={signatureRef}
            onStroke={() => setSignatureTouched(true)}
          />
        </div>
      </section>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !canSubmit}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Submitting…
          </>
        ) : (
          'Submit form'
        )}
      </button>
      {!canSubmit && !submitting && (
        <p className="text-center text-xs text-stone-500">
          Acknowledge all policies and sign above to enable submit.
        </p>
      )}
    </form>
  );
}

export default function ConsentFormClient({ clientId }: { clientId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ConsentApiResponse | null>(null);

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
        throw new Error(
          payload.message || payload.error || `Failed to load (${res.status})`
        );
      }
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load form');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="min-h-screen bg-[#FAF9F6] px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-2xl">
        {loading && (
          <div className="flex flex-col items-center justify-center py-24 text-stone-500">
            <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
            <p className="mt-3 text-sm">Loading intake form…</p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-stone-200 bg-white p-8 text-center">
            <h1 className="font-serif text-xl text-stone-900">Unable to load form</h1>
            <p className="mt-2 text-sm text-stone-600">{error}</p>
          </div>
        )}

        {!loading && !error && data && (
          <>
            {data.submitted ? (
              <SubmittedView data={data} />
            ) : (
              <EditableForm
                clientId={clientId}
                initial={data}
                onSubmitted={setData}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}
