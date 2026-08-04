import {
  STUDIO_ADDRESS_ONE_LINE,
  STUDIO_PHONE_DISPLAY,
  STUDIO_PHONE_TEL,
  STUDIO_SITE_URL,
} from '@/lib/studio-nap';

const PUBLIC_BASE_URL = STUDIO_SITE_URL;
const PAGE_BG = '#ebe8e4';
const NAVY = '#0d1b2a';
const NAVY_BTN = '#2a4460';
const SERIF = "'Times New Roman', Times, Georgia, serif";
const SCRIPT = "'Pinyon Script', 'Brush Script MT', 'Segoe Script', cursive";
const CARD_WIDTH = 680;
const STUDIO_ADDRESS = STUDIO_ADDRESS_ONE_LINE;

/** Inline + class hook — Gmail dark mode often skips solid bgcolor but keeps gradients. */
const creamBg = `background-color:${PAGE_BG};background-image:linear-gradient(${PAGE_BG},${PAGE_BG});`;
const navyBg = `background-color:${NAVY};background-image:linear-gradient(${NAVY},${NAVY});`;
const btnBg = `background-color:${NAVY_BTN};background-image:linear-gradient(${NAVY_BTN},${NAVY_BTN});`;

const DARK_MODE_STYLES = `
    :root { color-scheme: light only; supported-color-schemes: light; }
    @media (prefers-color-scheme: dark) {
      .dm-cream-bg { ${creamBg} }
      .dm-navy-bg { ${navyBg} }
      .dm-btn-bg { ${btnBg} }
      .dm-text-navy { color: ${NAVY} !important; }
      .dm-text-navy a { color: ${NAVY} !important; }
      .dm-text-light { color: #f5f3f0 !important; }
      .dm-text-light a { color: #f5f3f0 !important; }
      .dm-text-white { color: #ffffff !important; }
      .dm-btn-text { color: #ffffff !important; }
      .dm-divider { background-color: #8a93a0 !important; }
    }
    [data-ogsc] .dm-cream-bg { ${creamBg} }
    [data-ogsc] .dm-navy-bg { ${navyBg} }
    [data-ogsc] .dm-btn-bg { ${btnBg} }
    [data-ogsc] .dm-text-navy { color: ${NAVY} !important; }
    [data-ogsc] .dm-text-light { color: #f5f3f0 !important; }
    [data-ogsc] .dm-text-white { color: #ffffff !important; }
    [data-ogsc] .dm-btn-text { color: #ffffff !important; }
    u + .body .dm-cream-bg { ${creamBg} }
    u + .body .dm-navy-bg { ${navyBg} }
    u + .body .dm-btn-bg { ${btnBg} }
    u + .body .dm-text-navy { color: ${NAVY} !important; }
    u + .body .dm-text-light { color: #f5f3f0 !important; }
    u + .body .dm-text-white { color: #ffffff !important; }
    u + .body .dm-btn-text { color: #ffffff !important; }
`;

function firstNameFrom(clientName: string): string {
  const part = (clientName || '').trim().split(/\s+/)[0];
  return part || '';
}

function emailDocumentHead(title: string): string {
  return `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
  <link href="https://fonts.googleapis.com/css2?family=Pinyon+Script&amp;display=swap" rel="stylesheet" />
  <title>${title}</title>
  <style>
    body, table, td { margin: 0; padding: 0; }
    img { border: 0; outline: none; text-decoration: none; display: block; }
    a { color: inherit; }
    ${DARK_MODE_STYLES}
    @media (max-width: 720px) {
      .email-card { width: 100% !important; max-width: 100% !important; }
      .email-pad { padding-left: 20px !important; padding-right: 20px !important; }
      .banner-title { font-size: 48px !important; line-height: 1 !important; }
      .banner-sub { font-size: 14px !important; }
      .appt-date { font-size: 24px !important; }
      .body-copy { font-size: 16px !important; }
    }
  </style>
  <!--[if mso]>
  <style>
    .banner-title { font-family: ${SERIF} !important; font-style: italic !important; }
  </style>
  <![endif]-->
</head>`;
}

function brandHeaderRow(): string {
  return `
          <tr>
            <td class="email-pad dm-cream-bg" style="padding:0;${creamBg}border-bottom:1px solid #d5d0ca;">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" class="dm-cream-bg" style="${creamBg}">
                <tr>
                  <td style="padding:14px 36px 13px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="left" valign="middle" class="dm-text-navy" style="font-family:${SERIF};font-size:20px;letter-spacing:-0.04em;color:${NAVY};line-height:1.2;">
                          <span style="white-space:nowrap;">Sadie&nbsp;Marie</span>
                        </td>
                        <td align="right" valign="middle" class="dm-text-navy" style="font-family:${SERIF};font-size:13px;color:${NAVY};line-height:1.2;">
                          <a href="${PUBLIC_BASE_URL}" target="_blank" rel="noopener noreferrer" class="dm-text-navy" style="color:${NAVY};text-decoration:none;white-space:nowrap;">sadiemarie.co</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}

function navyHeroRow(scriptTitle: string, subtitleHtml: string): string {
  return `
          <tr>
            <td align="center" class="dm-navy-bg" style="padding:0;${navyBg}">
              <!--[if gte mso 9]>
              <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:${CARD_WIDTH}px;height:160px;">
                <v:fill type="gradient" color="#1c2e42" color2="#0d1b2a" angle="90" />
                <v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:true">
              <![endif]-->
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" class="dm-navy-bg" style="width:100%;${navyBg}background-image:radial-gradient(ellipse 120% 90% at 50% 42%, #2a4460 0%, #152536 38%, ${NAVY} 72%, #1a2f45 100%);">
                <tr>
                  <td align="center" style="padding:36px 40px 32px;">
                    <p class="banner-title dm-text-light" style="margin:0;font-family:${SCRIPT};font-size:56px;font-weight:400;color:#f5f3f0;line-height:1.05;letter-spacing:0.01em;">
                      ${scriptTitle}
                    </p>
                    <p class="banner-sub dm-text-light" style="margin:14px 0 0;font-family:${SERIF};font-size:15px;font-weight:400;color:#f0f2f5;line-height:1.5;text-align:center;max-width:480px;">
                      ${subtitleHtml}
                    </p>
                  </td>
                </tr>
              </table>
              <!--[if gte mso 9]></v:textbox></v:rect><![endif]-->
            </td>
          </tr>`;
}

/** Strip Cal-style "Touch Up between A and B" down to the service title. */
export function cleanEmailServiceTitle(raw: string): string {
  if (!raw || typeof raw !== 'string') return 'appointment';
  const cleaned = raw.replace(/\s+between\s+.+$/i, '').trim();
  return cleaned || 'appointment';
}

/** Service on line 1; date · time on line 2 (always). */
function heroServiceWhenSubtitle(
  serviceName: string,
  appointmentDate: string,
  appointmentTime: string
): string {
  const service = cleanEmailServiceTitle(serviceName);
  return `<strong class="dm-text-white" style="color:#ffffff;font-weight:700;">${service}</strong><br /><span class="dm-text-light" style="color:#f0f2f5;">${appointmentDate} at ${appointmentTime}</span>`;
}

/** Escape + turn newlines into <br /> for admin-edited body paragraphs. */
export function formatEmailBodyHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '<br />');
}

function primaryButton(href: string, label: string): string {
  return `
                <tr>
                  <td align="center">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                      <tr>
                        <td align="center" class="dm-btn-bg" bgcolor="${NAVY_BTN}" style="${btnBg}border-radius:26px;">
                          <a href="${href}" target="_blank" rel="noopener noreferrer" class="dm-btn-text" style="display:inline-block;padding:18px 32px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:-0.02em;line-height:1;">
                            ${label}
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>`;
}

function studioFooterRow(includePhone = true): string {
  const phoneLine = includePhone
    ? `<br /><a href="tel:${STUDIO_PHONE_TEL}" target="_blank" rel="noopener noreferrer" class="dm-text-light" style="color:#f5f3f0;text-decoration:none;">${STUDIO_PHONE_DISPLAY}</a>`
    : '';
  return `
          <tr>
            <td class="dm-navy-bg" bgcolor="${NAVY}" style="${navyBg}padding:0 36px 20px;">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:18px 0 16px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td height="1" class="dm-divider" style="height:1px;line-height:1px;font-size:0;background-color:#8a93a0;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" class="dm-text-light" style="font-family:${SERIF};font-size:12px;color:#f5f3f0;line-height:1.6;text-align:center;padding-bottom:8px;">
                    ${STUDIO_ADDRESS}${phoneLine}<br />
                    © <span style="white-space:nowrap;">Sadie&nbsp;Marie</span> Co.
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}

function appointmentDetailsBlock(
  appointmentDate: string,
  appointmentTime: string
): string {
  return `
                <tr>
                  <td align="center" style="padding-bottom:8px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td height="1" class="dm-divider" style="height:1px;line-height:1px;font-size:0;background-color:#8a93a0;border-radius:999px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" class="appt-date dm-text-navy" style="padding-top:20px;padding-bottom:4px;font-family:${SERIF};font-size:26px;font-weight:700;letter-spacing:-0.02em;color:${NAVY};line-height:1.3;text-align:center;">
                    ${appointmentDate}
                  </td>
                </tr>
                <tr>
                  <td align="center" class="dm-text-navy" style="padding-bottom:22px;font-family:${SERIF};font-size:18px;color:${NAVY};line-height:1.4;text-align:center;">
                    ${appointmentTime}
                  </td>
                </tr>`;
}

export interface ConfirmationEmailContent {
  clientName: string;
  serviceName: string;
  appointmentDate: string;
  appointmentTime: string;
  cancelUrl: string;
  /** Editable middle paragraph (admin Email Messages → confirmation). */
  bodyCopy: string;
}

export interface ReminderEmailContent {
  serviceName: string;
  appointmentDate: string;
  appointmentTime: string;
  bodyCopy: string;
  cancelUrl: string;
}

export interface ConsentRequestEmailContent {
  clientName: string;
  consentUrl: string;
  /** Editable body after greeting (admin Email Messages → consent_request). */
  bodyCopy: string;
}

/**
 * Quiet appointment-card confirmation — navy hero, date/time block, Manage booking.
 */
export function generateConfirmationHtml({
  clientName,
  serviceName,
  appointmentDate,
  appointmentTime,
  cancelUrl,
  bodyCopy,
}: ConfirmationEmailContent): string {
  const displayService = cleanEmailServiceTitle(serviceName);
  const appointmentWhen = `${appointmentDate} at ${appointmentTime}`;
  const firstName = firstNameFrom(clientName);
  const greeting = firstName
    ? `You&rsquo;re all set, ${firstName}.`
    : `You&rsquo;re all set.`;
  const heroSub = heroServiceWhenSubtitle(
    displayService,
    appointmentDate,
    appointmentTime
  );
  const bodyHtml = formatEmailBodyHtml(bodyCopy);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
${emailDocumentHead(`${displayService} — Sadie Marie`)}
<body style="margin:0;padding:0;width:100%;${creamBg}-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Your ${displayService} appointment is confirmed for ${appointmentWhen}.
  </div>

  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" class="dm-cream-bg" bgcolor="${PAGE_BG}" style="width:100%;min-width:100%;${creamBg}">
    <tr>
      <td align="center" class="dm-cream-bg" bgcolor="${PAGE_BG}" style="${creamBg}padding:48px 16px;">
        <table role="presentation" class="email-card dm-cream-bg" width="${CARD_WIDTH}" border="0" cellpadding="0" cellspacing="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:${CARD_WIDTH}px;${creamBg}border-collapse:separate;border-radius:4px;overflow:hidden;box-shadow:0 12px 48px rgba(13,27,42,0.10);">
${brandHeaderRow()}
${navyHeroRow('Confirmed!', heroSub)}
          <tr>
            <td class="email-pad dm-cream-bg" bgcolor="${PAGE_BG}" style="padding:28px 40px 36px;${creamBg}">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
${appointmentDetailsBlock(appointmentDate, appointmentTime)}
                <tr>
                  <td align="center" class="body-copy dm-text-navy" style="padding-bottom:28px;font-family:${SERIF};font-size:17px;color:${NAVY};line-height:1.55;text-align:center;">
                    ${greeting}<br /><br />
                    ${bodyHtml}<br /><br />
                    <span style="font-size:15px;opacity:0.85;">Need to change plans? Please manage your booking with at least 24 hours&rsquo; notice.</span>
                  </td>
                </tr>
${primaryButton(cancelUrl, 'Manage booking')}
              </table>
            </td>
          </tr>
${studioFooterRow(true)}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Pre-appointment reminder — same quiet card as confirmation.
 */
export function generateReminderHtml({
  serviceName,
  appointmentDate,
  appointmentTime,
  bodyCopy,
  cancelUrl,
}: ReminderEmailContent): string {
  const displayService = cleanEmailServiceTitle(serviceName);
  const appointmentWhen = `${appointmentDate} at ${appointmentTime}`;
  const heroSub = heroServiceWhenSubtitle(
    displayService,
    appointmentDate,
    appointmentTime
  );
  const bodyHtml = formatEmailBodyHtml(bodyCopy);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
${emailDocumentHead(`${displayService} — Sadie Marie`)}
<body style="margin:0;padding:0;width:100%;${creamBg}-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Your ${displayService} appointment is on ${appointmentWhen}.
  </div>

  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" class="dm-cream-bg" bgcolor="${PAGE_BG}" style="width:100%;min-width:100%;${creamBg}">
    <tr>
      <td align="center" class="dm-cream-bg" bgcolor="${PAGE_BG}" style="${creamBg}padding:48px 16px;">
        <table role="presentation" class="email-card dm-cream-bg" width="${CARD_WIDTH}" border="0" cellpadding="0" cellspacing="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:${CARD_WIDTH}px;${creamBg}border-collapse:separate;border-radius:4px;overflow:hidden;box-shadow:0 12px 48px rgba(13,27,42,0.10);">
${brandHeaderRow()}
${navyHeroRow('Almost here!', heroSub)}
          <tr>
            <td class="email-pad dm-cream-bg" bgcolor="${PAGE_BG}" style="padding:28px 40px 36px;${creamBg}">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
${appointmentDetailsBlock(appointmentDate, appointmentTime)}
                <tr>
                  <td align="center" class="body-copy dm-text-navy" style="padding-bottom:28px;font-family:${SERIF};font-size:17px;color:${NAVY};line-height:1.55;text-align:center;">
                    ${bodyHtml}
                  </td>
                </tr>
${primaryButton(cancelUrl, 'Manage booking')}
              </table>
            </td>
          </tr>
${studioFooterRow(true)}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Consent / intake request — same quiet card chrome; form CTA unchanged.
 */
export function generateConsentRequestHtml({
  clientName,
  consentUrl,
  bodyCopy,
}: ConsentRequestEmailContent): string {
  const firstName = firstNameFrom(clientName);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const bodyHtml = formatEmailBodyHtml(bodyCopy);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
${emailDocumentHead('Complete your consent form — Sadie Marie')}
<body class="body" style="margin:0;padding:0;width:100%;${creamBg}-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Please complete your intake and consent form before your visit with Sadie Marie.
  </div>

  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" class="dm-cream-bg" bgcolor="${PAGE_BG}" style="width:100%;min-width:100%;${creamBg}">
    <tr>
      <td align="center" class="dm-cream-bg" bgcolor="${PAGE_BG}" style="${creamBg}padding:48px 16px;">
        <table role="presentation" class="email-card dm-cream-bg" width="${CARD_WIDTH}" border="0" cellpadding="0" cellspacing="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:${CARD_WIDTH}px;${creamBg}border-collapse:separate;border-radius:4px;overflow:hidden;box-shadow:0 12px 48px rgba(13,27,42,0.10);">
${brandHeaderRow()}
${navyHeroRow('One more step', 'Please complete your consent form before your visit.')}
          <tr>
            <td class="email-pad dm-cream-bg" bgcolor="${PAGE_BG}" style="padding:28px 40px 36px;${creamBg}">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-bottom:8px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td height="1" class="dm-divider" style="height:1px;line-height:1px;font-size:0;background-color:#8a93a0;border-radius:999px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" class="body-copy dm-text-navy" style="padding-top:20px;padding-bottom:28px;font-family:${SERIF};font-size:17px;color:${NAVY};line-height:1.55;text-align:center;">
                    ${greeting}<br /><br />
                    ${bodyHtml}
                  </td>
                </tr>
${primaryButton(consentUrl, 'Open consent form')}
              </table>
            </td>
          </tr>
${studioFooterRow(true)}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
