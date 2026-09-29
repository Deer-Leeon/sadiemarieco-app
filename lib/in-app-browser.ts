/**
 * Social in-app browsers (Instagram, Facebook, TikTok, …) are WKWebViews.
 * iOS still exposes ApplePaySession there, so a “Book with Apple Pay”
 * button can render, but the payment sheet cannot open. Card checkout
 * is the path that actually completes.
 */
const IN_APP_BROWSER_RE =
  /Instagram|FBAN|FBAV|FB_IAB|FB4A|FBIOS|Messenger|Barcelona|TikTok|musical_ly|Bytedance|Snapchat|Pinterest|LinkedInApp|Twitter|Line\/|MicroMessenger/i;

export function isInAppBrowser(userAgent?: string): boolean {
  const ua =
    userAgent ??
    (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (!ua) return false;
  return IN_APP_BROWSER_RE.test(ua);
}
