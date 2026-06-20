const PUBLIC_BASE_URL = 'https://www.sadiemarie.co';
const PAGE_BG = '#f5f3f0';
const NAVY = '#0d1b2a';
const SERIF = "'Times New Roman', Times, Georgia, serif";
const SCRIPT = "'Pinyon Script', 'Brush Script MT', 'Segoe Script', cursive";
const CARD_WIDTH = 680;

export interface ConfirmationEmailContent {
  clientName: string;
  serviceName: string;
  appointmentDate: string;
  appointmentTime: string;
  cancelUrl: string;
}

/**
 * Sadie Marie booking confirmation email — matches the Canva design language.
 */
export function generateConfirmationHtml({
  serviceName,
  appointmentDate,
  appointmentTime,
  cancelUrl,
}: ConfirmationEmailContent): string {
  const appointmentWhen = `${appointmentDate} at ${appointmentTime}`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
  <link href="https://fonts.googleapis.com/css2?family=Pinyon+Script&amp;display=swap" rel="stylesheet" />
  <title>${serviceName} — Sadie Marie</title>
  <style>
    body, table, td { margin: 0; padding: 0; }
    img { border: 0; outline: none; text-decoration: none; display: block; }
    a { color: inherit; }
    @media (max-width: 720px) {
      .email-card { width: 100% !important; max-width: 100% !important; }
      .email-pad { padding-left: 20px !important; padding-right: 20px !important; }
      .banner-title { font-size: 52px !important; line-height: 1 !important; }
      .banner-sub { font-size: 15px !important; }
      .service-title { font-size: 26px !important; }
      .body-copy { font-size: 16px !important; }
    }
  </style>
  <!--[if mso]>
  <style>
    .banner-title { font-family: ${SERIF} !important; font-style: italic !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;width:100%;background-color:${PAGE_BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Your ${serviceName} appointment is confirmed for ${appointmentWhen}.
  </div>

  <!-- Full-viewport wash so wide screens feel intentional, not empty -->
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="${PAGE_BG}" style="width:100%;min-width:100%;background-color:${PAGE_BG};">
    <tr>
      <td align="center" bgcolor="${PAGE_BG}" style="background-color:${PAGE_BG};padding:48px 16px;">

        <!-- Card -->
        <table role="presentation" class="email-card" width="${CARD_WIDTH}" border="0" cellpadding="0" cellspacing="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:${CARD_WIDTH}px;background-color:${PAGE_BG};border-collapse:separate;border-radius:4px;overflow:hidden;box-shadow:0 12px 48px rgba(13,27,42,0.10);">

          <!-- Header bar — anchored above the banner -->
          <tr>
            <td class="email-pad" style="padding:0;background-color:#ebe8e4;border-bottom:1px solid #d5d0ca;">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#ebe8e4;">
                <tr>
                  <td style="padding:14px 36px 13px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="left" valign="middle" style="font-family:${SERIF};font-size:20px;letter-spacing:-0.04em;color:${NAVY};line-height:1.2;">
                          <span style="white-space:nowrap;">Sadie&nbsp;Marie</span>
                        </td>
                        <td align="right" valign="middle" style="font-family:${SERIF};font-size:13px;color:${NAVY};line-height:1.2;">
                          <a href="${PUBLIC_BASE_URL}" target="_blank" rel="noopener noreferrer" style="color:${NAVY};text-decoration:none;white-space:nowrap;">sadiemarie.co</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero banner — edge-to-edge within card -->
          <tr>
            <td align="center" style="padding:0;background-color:${NAVY};">
              <!--[if gte mso 9]>
              <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:${CARD_WIDTH}px;height:220px;">
                <v:fill type="gradient" color="#1c2e42" color2="#0d1b2a" angle="90" />
                <v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:true">
              <![endif]-->
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;background-color:${NAVY};background-image:radial-gradient(ellipse 120% 90% at 50% 42%, #2a4460 0%, #152536 38%, ${NAVY} 72%, #1a2f45 100%);">
                <tr>
                  <td align="center" style="padding:52px 40px 48px;">
                    <p class="banner-title" style="margin:0;font-family:${SCRIPT};font-size:64px;font-weight:400;color:#f5f3f0;line-height:1.05;letter-spacing:0.01em;">
                      Confirmed!
                    </p>
                    <p class="banner-sub" style="margin:22px 0 0;font-family:${SERIF};font-size:16px;font-weight:400;color:#e8eaed;line-height:1.65;text-align:center;max-width:520px;">
                      You've booked <strong style="color:#ffffff;font-weight:700;">${serviceName}</strong> on <strong style="color:#ffffff;font-weight:700;">${appointmentWhen}</strong> with <span style="white-space:nowrap;">Sadie&nbsp;Marie.</span>
                    </p>
                  </td>
                </tr>
              </table>
              <!--[if gte mso 9]></v:textbox></v:rect><![endif]-->
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="email-pad" style="padding:28px 40px 8px;background-color:${PAGE_BG};">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-bottom:20px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td height="1" style="height:1px;line-height:1px;font-size:0;background-color:#8a93a0;border-radius:999px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" class="service-title" style="padding-bottom:18px;font-family:${SERIF};font-size:33px;font-weight:700;letter-spacing:-0.02em;color:${NAVY};line-height:1.35;text-align:center;">
                    ${serviceName}
                  </td>
                </tr>
                <tr>
                  <td align="center" class="body-copy" style="font-family:${SERIF};font-size:17px;color:${NAVY};line-height:1.55;text-align:center;">
                    If there is any conflict, please cancel or reschedule with at least 24 hours' notice. You'll receive reminder messages with pre-arrival instructions before your appointment. I can't wait to see you!
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align="center" class="email-pad" style="padding:28px 40px 40px;background-color:${PAGE_BG};">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td align="center" bgcolor="#2a4460" style="background-color:#2a4460;border-radius:26px;">
                    <a href="${cancelUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:20px 36px;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:-0.02em;line-height:1;">
                      Cancel/Reschedule
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="${NAVY}" style="background-color:${NAVY};padding:0 36px 20px;">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:18px 0 16px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td height="1" style="height:1px;line-height:1px;font-size:0;background-color:#8a93a0;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="font-family:${SERIF};font-size:12px;color:#f5f3f0;line-height:1.6;text-align:center;padding-bottom:8px;">
                    61 W 3200 N, Suite #10, Lehi, UT 84043<br />
                    (<a href="tel:3852003904" target="_blank" rel="noopener noreferrer" style="color:#f5f3f0;text-decoration:none;">385) 200-3904</a>)<br />
                    © <span style="white-space:nowrap;">Sadie&nbsp;Marie</span> Co.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>
</body>
</html>`;
}
