'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, FileText, Loader2 } from 'lucide-react';

import type { ConsentApiResponse } from '@/lib/consent';
import {
  consentDocumentPath,
  isValidClientUuid,
  resolveConsentPdfUrl,
} from '@/lib/consent';

import {
  allConsentStatementsAccepted,
  asConsentFormData,
  asConsentStatements,
  asMedicalChecklist,
  asYesNo,
  buildInitialForm,
  CLIENT_AGREEMENT_TEXT,
  CONSENT_STATEMENTS,
  MEDICAL_CONDITION_CHECKLIST,
  validateConsentForm,
  PERSONAL_INFO_QUESTIONS,
  SERVICE_HISTORY_QUESTIONS,
  type ConsentFormData,
  type ConsentStatementKey,
  type MedicalConditionChecklistKey,
  type YesNo,
} from './consent-form-config';
import {
  FieldLabel,
  formatYesNo,
  inputClass,
  RequiredMark,
  SectionBody,
  SectionHeader,
  sectionClass,
  YesNoQuestion,
} from './ConsentFormFields';
import ConsentPreviewStep from './ConsentPreviewStep';

function SubmittedView({ data }: { data: ConsentApiResponse }) {
  const documentPage = consentDocumentPath(data.client.id);
  const pdfUrl = resolveConsentPdfUrl(
    data.intake,
    data.client.consent_form_url
  );

  useEffect(() => {
    if (pdfUrl) {
      window.location.replace(documentPage);
    }
  }, [pdfUrl, documentPage]);

  if (pdfUrl) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-stone-500" aria-hidden />
        <p className="mt-4 font-serif text-xl text-stone-900">Opening your signed document…</p>
        <p className="mt-2 text-sm text-stone-600">
          You can view and download your consent anytime from this page.
        </p>
        <a
          href={documentPage}
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          <FileText className="h-4 w-4" aria-hidden />
          View signed document
        </a>
      </div>
    );
  }

  const form = asConsentFormData(data.intake?.form_data ?? {});
  const submittedAt = data.intake?.submitted_at;
  const signature = data.intake?.signature_image ?? null;
  const checklist = asMedicalChecklist(form.medical_conditions_checklist);
  const flagged = MEDICAL_CONDITION_CHECKLIST.filter((c) => checklist[c.key]);
  const statements = asConsentStatements(form.consent_statements);

  const textFields: [string, string][] = [
    ['Full name', form.full_name],
    ['Date of birth', form.dob],
    ['Phone', form.phone],
    ['Address', form.address],
    ['City', form.city],
    ['State', form.state],
    ['Zip', form.zip],
    ['Email', form.email],
    ['Occupation', form.occupation || '—'],
    ['How did you hear about us?', form.referral_source || '—'],
    ['Emergency contact', form.emergency_contact_name],
    ['Emergency phone', form.emergency_contact_phone],
    ['Printed name', form.agreement_print_name],
    ['Date signed', form.agreement_date],
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-emerald-200/90 bg-emerald-50/50 p-5 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-700" aria-hidden />
        </div>
        <h1 className="mt-3 font-serif text-2xl text-stone-900">
          Form successfully submitted
        </h1>
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your signed PDF could not be generated yet. The summary below is on
          file.
          {data.stamp_error && (
            <span className="mt-2 block text-left text-xs leading-relaxed text-amber-800">
              {data.stamp_error}
            </span>
          )}
        </p>
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
        <SectionHeader title="Client information" />
        <SectionBody>
          <dl className="divide-y divide-stone-100">
            {textFields.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-2.5 text-sm">
                <dt className="text-stone-500">{label}</dt>
                <dd className="text-right font-medium text-stone-900">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Service history" />
        <SectionBody>
          <dl className="space-y-2 text-sm">
            {SERVICE_HISTORY_QUESTIONS.map((q) => (
              <div key={q.key} className="flex justify-between gap-4">
                <dt className="text-stone-600">{q.label}</dt>
                <dd className="font-medium text-stone-900">{formatYesNo(form[q.key])}</dd>
              </div>
            ))}
          </dl>
          {form.service_adverse_reaction_explain.trim() && (
            <div className="mt-3 border-t border-stone-100 pt-3">
              <p className="text-xs font-medium text-stone-500">Adverse reaction details</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-stone-900">
                {form.service_adverse_reaction_explain}
              </p>
            </div>
          )}
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Personal information" />
        <SectionBody>
          <dl className="space-y-2 text-sm">
            {PERSONAL_INFO_QUESTIONS.map((q) => (
              <div key={q.key}>
                <div className="flex justify-between gap-4">
                  <dt className="text-stone-600">{q.label}</dt>
                  <dd className="font-medium text-stone-900">{formatYesNo(form[q.key])}</dd>
                </div>
                {q.explainKey &&
                  asYesNo(form[q.key]) === 'yes' &&
                  String(form[q.explainKey] ?? '').trim() && (
                    <p className="mt-1 text-xs text-stone-600">
                      {String(form[q.explainKey])}
                    </p>
                  )}
              </div>
            ))}
          </dl>
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Medical conditions" />
        <SectionBody>
          {flagged.length > 0 ? (
            <ul className="list-inside list-disc text-sm text-stone-800">
              {flagged.map((c) => (
                <li key={c.key}>{c.label}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-600">None checked.</p>
          )}
          {checklist.other && form.medical_conditions_other_text.trim() && (
            <p className="mt-2 text-sm text-stone-700">
              <span className="font-medium">Other:</span>{' '}
              {form.medical_conditions_other_text}
            </p>
          )}
          {form.additional_notes.trim() && (
            <div className="mt-4 border-t border-stone-100 pt-4">
              <p className="text-xs font-medium text-stone-500">Additional notes</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-stone-900">
                {form.additional_notes}
              </p>
            </div>
          )}
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Consent acknowledgments" />
        <SectionBody>
          <ul className="space-y-3">
            {CONSENT_STATEMENTS.map((s) => (
              <li key={s.key} className="flex gap-2 text-sm text-stone-800">
                <Check
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    statements[s.key] ? 'text-emerald-600' : 'text-stone-300'
                  }`}
                  aria-hidden
                />
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </SectionBody>
      </section>

      {signature && (
        <section className={sectionClass}>
          <SectionHeader title="Signature" />
          <SectionBody>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={signature}
              alt="Client signature"
              className="mx-auto max-h-36 w-full max-w-md object-contain"
            />
          </SectionBody>
        </section>
      )}

      <p className="text-center text-[10px] uppercase tracking-widest text-stone-400">
        mckenna@sadiemarie.co · sadiemarie.co
      </p>
      <p className="text-center">
        <Link
          href="https://www.sadiemarie.co"
          className="text-sm font-medium text-stone-800 underline underline-offset-2"
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
  const [form, setForm] = useState<ConsentFormData>(() => buildInitialForm(initial.client));
  const [step, setStep] = useState<'filling' | 'preview'>('filling');
  const [previewPdf, setPreviewPdf] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checklist = asMedicalChecklist(form.medical_conditions_checklist);
  const statements = asConsentStatements(form.consent_statements);
  const statementsComplete = allConsentStatementsAccepted(statements);
  const validationError = validateConsentForm(form);
  const canReview = !validationError && statementsComplete;

  const setField = <K extends keyof ConsentFormData>(key: K, value: ConsentFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setYesNo = (key: keyof ConsentFormData, value: YesNo) => {
    setField(key, value as ConsentFormData[typeof key]);
  };

  const setChecklistItem = (key: MedicalConditionChecklistKey, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      medical_conditions_checklist: {
        ...asMedicalChecklist(prev.medical_conditions_checklist),
        [key]: checked,
      },
    }));
  };

  const setStatement = (key: ConsentStatementKey, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      consent_statements: {
        ...asConsentStatements(prev.consent_statements),
        [key]: checked,
      },
    }));
  };

  const payloadForm = (): ConsentFormData => ({
    ...form,
    agreement_date: form.agreement_date || new Date().toISOString().slice(0, 10),
  });

  const handleReviewDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateConsentForm(form);
    if (err) {
      setError(err);
      return;
    }

    setPreviewLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/consent/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form_data: payloadForm() }),
      });
      const data = (await res.json()) as {
        pdf_base64?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || `Preview failed (${res.status})`);
      }
      if (!data.pdf_base64) {
        throw new Error('Preview PDF was not returned.');
      }
      setPreviewPdf(data.pdf_base64);
      setStep('preview');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (previewErr) {
      setError(previewErr instanceof Error ? previewErr.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSubmitFinal = async () => {
    if (!signatureData) {
      setError('Please add your signature before submitting.');
      return;
    }
    const err = validateConsentForm(form);
    if (err) {
      setError(err);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/consent/${clientId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_data: payloadForm(),
          signature_image: signatureData,
        }),
      });
      const payload = (await res.json()) as ConsentApiResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(payload.message || payload.error || `Submit failed (${res.status})`);
      }

      window.location.replace(consentDocumentPath(clientId));
    } catch (submitErr) {
      setError(submitErr instanceof Error ? submitErr.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  };

  const showServiceExplain =
    asYesNo(form.had_lash_lift_tint) === 'yes' ||
    asYesNo(form.had_brow_lamination_tint) === 'yes';

  if (step === 'preview' && previewPdf) {
    return (
      <ConsentPreviewStep
        previewPdf={previewPdf}
        signatureData={signatureData}
        submitting={submitting}
        error={error}
        onBack={() => {
          setStep('filling');
          setError(null);
        }}
        onSignatureSaved={setSignatureData}
        onClearSignature={() => setSignatureData(null)}
        onSubmitFinal={() => void handleSubmitFinal()}
      />
    );
  }

  return (
    <form onSubmit={handleReviewDocument} className="space-y-6">
      <header className="text-center">
        <p className="font-serif text-lg text-stone-800">Sadie Marie</p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-stone-500">
          61 W 3200 N Suite C · Lehi, UT 84043
        </p>
        <h1 className="mt-4 font-serif text-2xl uppercase tracking-wide text-stone-900">
          Lash &amp; Brow Intake &amp; Consent Form
        </h1>
        <p className="mt-2 text-xs text-stone-500">
          Fields marked with <span className="text-red-600">*</span> are required.
        </p>
      </header>

      <section className={sectionClass}>
        <SectionHeader title="Client information" />
        <SectionBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <FieldLabel required>Full name</FieldLabel>
              <input
                type="text"
                required
                value={String(form.full_name ?? '')}
                onChange={(e) => setField('full_name', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>Date of birth</FieldLabel>
              <input
                type="date"
                required
                value={String(form.dob ?? '')}
                onChange={(e) => setField('dob', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>Phone number</FieldLabel>
              <input
                type="tel"
                required
                value={String(form.phone ?? '')}
                onChange={(e) => setField('phone', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block sm:col-span-2">
              <FieldLabel required>Address</FieldLabel>
              <input
                type="text"
                required
                value={String(form.address ?? '')}
                onChange={(e) => setField('address', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>City</FieldLabel>
              <input
                type="text"
                required
                value={String(form.city ?? '')}
                onChange={(e) => setField('city', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>State</FieldLabel>
              <input
                type="text"
                required
                maxLength={2}
                value={String(form.state ?? '')}
                onChange={(e) => setField('state', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>Zip</FieldLabel>
              <input
                type="text"
                required
                inputMode="numeric"
                value={String(form.zip ?? '')}
                onChange={(e) => setField('zip', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block sm:col-span-2">
              <FieldLabel required>Email address</FieldLabel>
              <input
                type="email"
                required
                value={String(form.email ?? '')}
                onChange={(e) => setField('email', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel>Occupation</FieldLabel>
              <input
                type="text"
                value={String(form.occupation ?? '')}
                onChange={(e) => setField('occupation', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel>How did you hear about us?</FieldLabel>
              <input
                type="text"
                value={String(form.referral_source ?? '')}
                onChange={(e) => setField('referral_source', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>Emergency contact name</FieldLabel>
              <input
                type="text"
                required
                value={String(form.emergency_contact_name ?? '')}
                onChange={(e) => setField('emergency_contact_name', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>Emergency contact phone</FieldLabel>
              <input
                type="tel"
                required
                value={String(form.emergency_contact_phone ?? '')}
                onChange={(e) => setField('emergency_contact_phone', e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Service history" />
        <SectionBody>
          <YesNoQuestion
            name="lash_lift"
            required
            label="Have you previously had a lash lift and/or tint?"
            value={asYesNo(form.had_lash_lift_tint)}
            onChange={(v) => setYesNo('had_lash_lift_tint', v)}
          />
          <YesNoQuestion
            name="brow_lam"
            required
            label="Have you previously had a brow lamination and/or tint?"
            value={asYesNo(form.had_brow_lamination_tint)}
            onChange={(v) => setYesNo('had_brow_lamination_tint', v)}
          />
          {showServiceExplain && (
            <label className="block">
              <FieldLabel required>
                If yes to either service above, have you ever experienced an adverse
                reaction? Please explain:
              </FieldLabel>
              <textarea
                required
                rows={3}
                value={String(form.service_adverse_reaction_explain ?? '')}
                onChange={(e) => setField('service_adverse_reaction_explain', e.target.value)}
                className={`${inputClass} resize-y`}
              />
            </label>
          )}
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Personal information" />
        <SectionBody>
          <YesNoQuestion
            name="contacts"
            required
            label="Do you wear contact lenses?"
            value={asYesNo(form.wears_contact_lenses)}
            onChange={(v) => setYesNo('wears_contact_lenses', v)}
          />
          <YesNoQuestion
            name="pregnant"
            required
            label="Are you pregnant or believe you may be pregnant?"
            value={asYesNo(form.pregnant_or_may_be)}
            onChange={(v) => setYesNo('pregnant_or_may_be', v)}
          >
            {asYesNo(form.pregnant_or_may_be) === 'yes' && (
              <label className="mt-2 block">
                <FieldLabel required>If yes, how far along are you?</FieldLabel>
                <input
                  type="text"
                  required
                  value={form.pregnancy_weeks}
                  onChange={(e) => setField('pregnancy_weeks', e.target.value)}
                  className={inputClass}
                  placeholder="e.g. 12 weeks"
                />
              </label>
            )}
          </YesNoQuestion>
          <YesNoQuestion
            name="eye_injury"
            required
            label="Do you currently have, or are you being treated for, any eye injury or condition?"
            value={asYesNo(form.eye_injury_or_condition)}
            onChange={(v) => setYesNo('eye_injury_or_condition', v)}
          >
            {asYesNo(form.eye_injury_or_condition) === 'yes' && (
              <label className="block">
                <FieldLabel required>If yes, please explain:</FieldLabel>
                <textarea
                  required
                  rows={2}
                  value={form.eye_injury_or_condition_explain}
                  onChange={(e) =>
                    setField('eye_injury_or_condition_explain', e.target.value)
                  }
                  className={`${inputClass} resize-y`}
                />
              </label>
            )}
          </YesNoQuestion>
          <YesNoQuestion
            name="allergies"
            required
            label="Do you have any known allergies?"
            value={asYesNo(form.known_allergies)}
            onChange={(v) => setYesNo('known_allergies', v)}
          >
            {asYesNo(form.known_allergies) === 'yes' && (
              <label className="block">
                <FieldLabel required>If yes, please explain:</FieldLabel>
                <textarea
                  required
                  rows={2}
                  value={form.known_allergies_explain}
                  onChange={(e) => setField('known_allergies_explain', e.target.value)}
                  className={`${inputClass} resize-y`}
                />
              </label>
            )}
          </YesNoQuestion>
          <YesNoQuestion
            name="accutane"
            required
            label="Are you currently using Accutane, or have you used it within the last 6 months?"
            value={asYesNo(form.accutane_last_6_months)}
            onChange={(v) => setYesNo('accutane_last_6_months', v)}
          />
          <YesNoQuestion
            name="retinol"
            required
            label="Do you use retinol or tretinoin products?"
            value={asYesNo(form.uses_retinol_tretinoin)}
            onChange={(v) => setYesNo('uses_retinol_tretinoin', v)}
          />
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Medical conditions" />
        <SectionBody>
          <div className="rounded-md border border-stone-200 bg-stone-50/50">
            <div className="border-b border-stone-200 bg-stone-100/90 px-3 py-2 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-stone-600">
                Medical conditions — please check all that apply
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2">
              {MEDICAL_CONDITION_CHECKLIST.map((item) => (
                <label
                  key={item.key}
                  className="flex cursor-pointer items-center gap-2 text-sm text-stone-800"
                >
                  <input
                    type="checkbox"
                    checked={checklist[item.key]}
                    onChange={(e) => setChecklistItem(item.key, e.target.checked)}
                    className="h-4 w-4 rounded border-stone-300"
                  />
                  {item.label}
                </label>
              ))}
            </div>
            {checklist.other && (
              <div className="border-t border-stone-200 px-4 pb-4">
                <FieldLabel required>Other (please specify)</FieldLabel>
                <input
                  type="text"
                  required
                  value={form.medical_conditions_other_text}
                  onChange={(e) => setField('medical_conditions_other_text', e.target.value)}
                  className={inputClass}
                />
              </div>
            )}
          </div>

          <label className="block">
            <FieldLabel>Any additional notes</FieldLabel>
            <textarea
              rows={3}
              value={form.additional_notes}
              onChange={(e) => setField('additional_notes', e.target.value)}
              className={`${inputClass} resize-y`}
            />
          </label>
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Consent acknowledgments" />
        <SectionBody>
          <p className="text-center font-serif text-sm italic text-stone-600">
            Please read each statement carefully and check the box to show your agreement
            <RequiredMark />
          </p>
          <ul className="divide-y divide-stone-200 rounded-md border border-stone-200">
            {CONSENT_STATEMENTS.map((item) => (
              <li key={item.key} className="flex gap-3 bg-[#FAF9F6] p-3 first:rounded-t-md last:rounded-b-md">
                <input
                  type="checkbox"
                  checked={statements[item.key]}
                  onChange={(e) => setStatement(item.key, e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-stone-400 text-stone-900"
                  aria-required
                />
                <span className="text-sm leading-relaxed text-stone-800">{item.text}</span>
              </li>
            ))}
          </ul>
        </SectionBody>
      </section>

      <section className={sectionClass}>
        <SectionHeader title="Client agreement &amp; signature" />
        <SectionBody>
          <p className="whitespace-pre-line text-sm leading-relaxed text-stone-700">
            {CLIENT_AGREEMENT_TEXT}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <FieldLabel required>Print name</FieldLabel>
              <input
                type="text"
                required
                value={String(form.agreement_print_name ?? '')}
                onChange={(e) => setField('agreement_print_name', e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <FieldLabel required>Date</FieldLabel>
              <input
                type="date"
                required
                value={String(form.agreement_date ?? '')}
                onChange={(e) => setField('agreement_date', e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          <p className="text-sm text-stone-600">
            You will review a PDF of this form and sign on the next step before submitting.
          </p>
        </SectionBody>
      </section>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {!canReview && !previewLoading && (
        <p className="text-center text-xs text-stone-500">
          Complete all required fields and check every consent statement to continue.
          {validationError && (
            <span className="mt-1 block text-stone-400">{validationError}</span>
          )}
        </p>
      )}

      <button
        type="submit"
        disabled={previewLoading || !canReview}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {previewLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Building preview…
          </>
        ) : (
          'Review document'
        )}
      </button>

      <p className="text-center text-[10px] uppercase tracking-widest text-stone-400">
        mckenna@sadiemarie.co · sadiemarie.co
      </p>
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
        throw new Error(payload.message || payload.error || `Failed to load (${res.status})`);
      }
      setData(payload);
    } catch (loadErr) {
      setError(loadErr instanceof Error ? loadErr.message : 'Failed to load form');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="min-h-screen bg-[#FAF9F6] px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-4xl">
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
