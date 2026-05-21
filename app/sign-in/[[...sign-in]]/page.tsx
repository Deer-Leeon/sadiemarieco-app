import { SignIn } from '@clerk/nextjs';

/**
 * Custom sign-in page styled to match the cream/champagne admin aesthetic.
 *
 * Route convention is Clerk-mandated: `[[...sign-in]]` is an optional
 * catch-all so the same page renders for `/sign-in`, `/sign-in/factor-one`,
 * `/sign-in/verify`, etc. — Clerk handles its own internal multi-step
 * routing inside the <SignIn /> component using these sub-paths.
 *
 * Security note: hiding the "Sign up" link in `appearance.elements` is a
 * UI safeguard only — it does NOT prevent someone from POSTing directly
 * to Clerk's sign-up API. The hard guarantee comes from disabling sign-ups
 * in the Clerk Dashboard (Settings → Restrictions → Sign-up mode).
 */
export default function SignInPage() {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-8 bg-[#FAF9F6] px-4 font-sans">
      {/* ── Editorial brand header ───────────────────────────────── */}
      <div className="text-center">
        <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
          Studio · Admin
        </p>
        <h1 className="font-serif text-3xl text-stone-900">
          Sadie Marie
        </h1>
      </div>

      {/* ── Clerk widget ─────────────────────────────────────────────
          We deliberately do NOT wrap <SignIn /> in a `w-full max-w-md`
          div. That wrapper would stretch to 448px, but Clerk's card
          has a smaller intrinsic width and renders at the left edge
          of the wrapper instead of centering — which made the card
          drift left of the brand wordmark above. Letting <SignIn />
          render at its natural width inside the flex-column parent
          (which has `items-center`) keeps the card dead-centre and
          perfectly aligned with the wordmark. */}
      <div className="flex w-full justify-center">
        <SignIn
          // Land on the dashboard after sign-in regardless of how the user
          // arrived here. `forceRedirectUrl` overrides `?redirect_url=`
          // query params; if we add more protected routes later, switch
          // to `fallbackRedirectUrl` so deep links survive auth round-trips.
          forceRedirectUrl="/admin"
          appearance={{
            // Design tokens lifted from app/globals.css and DashboardUI.tsx
            // so the widget reads as native — same primary colour as the
            // dashboard toggle, same border radius as the stat surfaces,
            // same DM Sans body font as the rest of the App Router pages.
            variables: {
              colorPrimary: '#1c1917', // stone-900
              colorBackground: '#ffffff',
              colorText: '#1c1917',
              colorTextSecondary: '#78716c', // stone-500
              colorInputBackground: '#ffffff',
              colorInputText: '#1c1917',
              colorDanger: '#b91c1c', // rose-700 — matches admin error banner family
              colorNeutral: '#1c1917',
              borderRadius: '0.5rem',
              fontFamily:
                '"DM Sans", ui-sans-serif, system-ui, -apple-system, sans-serif',
              fontFamilyButtons:
                '"DM Sans", ui-sans-serif, system-ui, -apple-system, sans-serif',
              spacingUnit: '1rem',
            },
            elements: {
              // Header centering + card centering are enforced via
              // globals.css with !important rules targeting Clerk's own
              // .cl-header / .cl-rootBox / .cl-cardBox classes — the
              // appearance prop's Tailwind classes were losing the
              // specificity fight inconsistently. Here we only carry
              // typography intent (font-serif on the title).
              card: 'border border-stone-200 bg-white rounded-xl shadow-sm shadow-stone-900/[0.03] px-8 py-10',
              headerTitle: 'font-serif',

              // Form fields: thin stone borders, focus ring lifted from
              // the admin's active-toggle treatment.
              formFieldLabel:
                'text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-600 mb-1.5',
              formFieldInput:
                'border border-stone-200 bg-white text-stone-900 rounded-md px-3 py-2.5 text-sm focus:border-stone-900 focus:ring-2 focus:ring-stone-900/10 focus:outline-none transition-colors',
              formFieldErrorText: 'text-xs text-rose-700 mt-1',
              formFieldSuccessText: 'text-xs text-emerald-700 mt-1',

              // Primary CTA mirrors the dashboard's "Sign out" pattern —
              // solid stone-900 with subtle hover lift. No drop shadow:
              // the cream background reads better with flat surfaces.
              formButtonPrimary:
                'bg-stone-900 hover:bg-stone-800 active:bg-stone-900 text-stone-50 rounded-md normal-case tracking-wide font-medium py-2.5 px-4 text-sm shadow-none transition-colors',
              formButtonReset:
                'text-stone-600 hover:text-stone-900 text-sm font-medium',

              // Social buttons (if any are enabled in Clerk dashboard) get
              // a quieter treatment that matches our pill aesthetic.
              socialButtonsBlockButton:
                'border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 rounded-md py-2.5 transition-colors',
              socialButtonsBlockButtonText: 'text-sm font-medium',
              socialButtonsIconButton:
                'border border-stone-200 hover:bg-stone-50 rounded-md transition-colors',

              // Divider between social and email auth.
              dividerLine: 'bg-stone-200',
              dividerText:
                'text-stone-400 text-[10px] font-medium uppercase tracking-[0.22em]',

              // Identity preview shown after entering email (between
              // factor-one screens). Match the dashboard's row treatment.
              identityPreview:
                'bg-stone-50 border border-stone-200 rounded-md',
              identityPreviewText: 'text-sm text-stone-700',
              identityPreviewEditButton:
                'text-stone-600 hover:text-stone-900 text-xs font-medium',

              // OTP field (used for email codes & MFA). Tighter borders to
              // keep the digit boxes feeling editorial.
              otpCodeFieldInput:
                'border border-stone-200 bg-white text-stone-900 rounded-md font-serif text-lg focus:border-stone-900 focus:ring-2 focus:ring-stone-900/10',

              // Alternate sign-in methods links (e.g. "Use another method").
              alternativeMethodsBlockButton:
                'border border-stone-200 text-stone-700 hover:bg-stone-50 rounded-md py-2.5 text-sm transition-colors',
              alternativeMethodsBlockButtonText: 'text-sm',

              // ── SECURITY: hide every path to sign-up ───────────────
              // Belt-and-suspenders: covers all known Clerk DOM nodes
              // that can render a "Sign up" link. The hard guarantee
              // still requires disabling sign-ups in Clerk Dashboard
              // → Restrictions → Sign-up mode.
              footer: 'hidden',
              footerAction: '!hidden',
              footerActionText: '!hidden',
              footerActionLink: '!hidden',
              signUpLink: 'hidden',
            },
            layout: {
              socialButtonsPlacement: 'bottom',
              socialButtonsVariant: 'iconButton',
              showOptionalFields: false,
              logoPlacement: 'none',
            },
          }}
        />
      </div>

      {/* ── Quiet caveat below the card ──────────────────────────── */}
      <p className="text-center text-[11px] tracking-wide text-stone-400">
        Access restricted to authorised studio team only.
      </p>
    </div>
  );
}
