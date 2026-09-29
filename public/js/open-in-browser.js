/**
 * Instagram, Facebook, and other apps open sadiemarie.co inside their
 * own browser. Apple Pay cannot run there. Real Safari and Chrome are
 * left alone. Inside those apps, tapping Book now (or landing on
 * /book or /checkout) shows a prompt to open the page in Safari.
 *
 * "Stay here" is remembered for the tab so they can still book with a card.
 */
(function () {
  'use strict';

  var STAY_KEY = 'sadieStayInApp';

  var APPS = [
    { name: 'Instagram', re: /Instagram/i },
    { name: 'Facebook', re: /FBAN|FBAV|FB_IAB|FB4A|FBIOS/i },
    { name: 'Messenger', re: /Messenger/i },
    { name: 'Threads', re: /Barcelona/i },
    { name: 'TikTok', re: /TikTok|musical_ly|BytedanceWebview/i },
    { name: 'Snapchat', re: /Snapchat/i },
    { name: 'Pinterest', re: /Pinterest/i },
    { name: 'LinkedIn', re: /LinkedInApp/i },
    { name: 'X', re: /Twitter/i },
    { name: 'LINE', re: /Line\//i },
  ];

  var BOOK_SELECTOR = [
    'a[href="#services"]',
    'a[href="/#services"]',
    'a[href$="#services"]',
    'a[href="/book"]',
    'a[href^="/book?"]',
    'a[href*="sadiemarie.co/book"]',
    '[data-cal-link]',
  ].join(',');

  var socialName = '';
  var open = false;
  var pendingEl = null;

  function appName(ua) {
    for (var i = 0; i < APPS.length; i++) {
      if (APPS[i].re.test(ua)) return APPS[i].name;
    }
    return '';
  }

  function skippedPath() {
    var path = location.pathname || '';
    return path.indexOf('/admin') === 0 || path.indexOf('/sign-in') === 0;
  }

  function staying() {
    try {
      return sessionStorage.getItem(STAY_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function rememberStay() {
    try {
      sessionStorage.setItem(STAY_KEY, '1');
    } catch (err) {
      /* private mode */
    }
  }

  function isBookingPage() {
    var path = location.pathname || '';
    return path === '/book' || path.indexOf('/book/') === 0 || path === '/checkout' || path.indexOf('/checkout/') === 0;
  }

  function bookingUrl(el) {
    var node = el && el.closest ? el.closest('[data-cal-link]') || el : null;
    if (node && node.getAttribute) {
      var cal = node.getAttribute('data-cal-link');
      if (cal) {
        var parts = String(cal).split('?')[0].split('/').filter(Boolean);
        var slug = parts[parts.length - 1] || '';
        return (
          location.origin +
          '/book' +
          (slug ? '?service=' + encodeURIComponent(slug) : '')
        );
      }
      var href = node.getAttribute('href') || '';
      if (/\/book/.test(href)) {
        try {
          return new URL(href, location.origin).href;
        } catch (err) {
          /* fall through */
        }
      }
      if (/#services/.test(href)) return location.origin + '/book';
    }
    if (isBookingPage()) return location.href;
    return location.origin + '/book';
  }

  function openOutside(url) {
    var ua = navigator.userAgent || '';
    var android = /Android/i.test(ua);
    if (!android && /Instagram/i.test(ua)) {
      location.href = 'instagram://extbrowser/?url=' + encodeURIComponent(url);
      return;
    }
    if (android) {
      var stripped = url.replace(/^https?:\/\//, '');
      location.href =
        'intent://' +
        stripped +
        '#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=' +
        encodeURIComponent(url) +
        ';end';
      return;
    }
    location.href = url
      .replace(/^https:\/\//, 'x-safari-https://')
      .replace(/^http:\/\//, 'x-safari-http://');
  }

  function showPrompt() {
    if (open || staying() || !socialName) return;
    if (!document.body) return;
    open = true;
    var android = /Android/i.test(navigator.userAgent || '');
    var browser = android ? 'your browser' : 'Safari';
    var destination = bookingUrl(pendingEl);

    var root = document.createElement('div');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'sadie-open-browser-title');
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483646',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:28px 22px',
      'background:rgba(13,27,42,0.46)',
      'color:#0d1b2a',
      'visibility:visible',
      'font-family:"DM Sans",system-ui,sans-serif',
    ].join(';');

    var card = document.createElement('div');
    card.style.cssText = [
      'width:100%',
      'max-width:380px',
      'padding:28px 22px 22px',
      'background:#faf9f6',
      'text-align:center',
      'box-shadow:0 18px 50px rgba(13,27,42,0.18)',
    ].join(';');

    var kicker = document.createElement('p');
    kicker.textContent = 'Sadie Marie';
    kicker.style.cssText =
      'margin:0;font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#586574';

    var title = document.createElement('h1');
    title.id = 'sadie-open-browser-title';
    title.textContent = android ? 'Open in your browser' : 'Open in Safari';
    title.style.cssText =
      'margin:14px 0 0;font-family:"Bodoni Moda",Georgia,serif;font-weight:500;font-size:34px;line-height:1.1';

    var body = document.createElement('p');
    body.textContent =
      'You’re in ' +
      socialName +
      '. Apple Pay only works in ' +
      browser +
      '. Open this page there to book your appointment.';
    body.style.cssText =
      'margin:14px 0 0;font-size:15px;line-height:1.5;color:#3d4a57';

    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = android ? 'Open in browser' : 'Open in Safari';
    button.style.cssText = [
      'margin-top:22px',
      'width:100%',
      'border:0',
      'background:#0d1b2a',
      'color:#f5f3f0',
      'font-family:"Bodoni Moda",Georgia,serif',
      'font-size:16px',
      'padding:14px 18px',
      'cursor:pointer',
    ].join(';');

    var status = document.createElement('p');
    status.style.cssText =
      'min-height:1.2em;margin:10px 0 0;font-size:13px;color:#586574';

    var steps = document.createElement('p');
    steps.textContent =
      'Or tap ••• at the top, then choose Open in external browser.';
    steps.style.cssText =
      'margin:16px 0 0;font-size:14px;line-height:1.45;color:#3d4a57';

    var stay = document.createElement('button');
    stay.type = 'button';
    stay.textContent = 'Stay here and book with a card';
    stay.style.cssText = [
      'margin-top:16px',
      'border:0',
      'background:transparent',
      'color:#586574',
      'font:inherit',
      'font-size:13px',
      'text-decoration:underline',
      'text-underline-offset:3px',
      'cursor:pointer',
    ].join(';');

    function close() {
      open = false;
      pendingEl = null;
      root.remove();
    }

    button.addEventListener('click', function () {
      status.textContent = 'If it didn’t switch, use the ••• menu.';
      openOutside(destination);
    });
    stay.addEventListener('click', function () {
      var resume = pendingEl;
      rememberStay();
      close();
      if (resume && typeof resume.click === 'function') resume.click();
    });

    card.appendChild(kicker);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(button);
    card.appendChild(status);
    card.appendChild(steps);
    card.appendChild(stay);
    root.appendChild(card);
    document.body.appendChild(root);
  }

  function onClick(event) {
    if (!socialName || staying() || open) return;
    var target = event.target;
    if (!target || !target.closest) return;
    var trigger = target.closest(BOOK_SELECTOR);
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    pendingEl = trigger;
    showPrompt();
  }

  function start() {
    if (skippedPath()) return;
    socialName = appName(navigator.userAgent || '');
    if (!socialName || staying()) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', start);
      return;
    }
    document.addEventListener('click', onClick, true);
    if (isBookingPage()) showPrompt();
  }

  start();
})();
