/**
 * Client-side booking funnel events for the static marketing site.
 * Relies on the Vercel Analytics queue stub + /_vercel/insights/script.js
 * already present in index.html. Never send PII.
 */
(function (global) {
  'use strict';

  var MAX = 255;

  function clip(value) {
    if (value == null) return '';
    var s = String(value).trim();
    return s.length > MAX ? s.slice(0, MAX) : s;
  }

  function trackBookingEvent(name, data) {
    if (!name || typeof global.va !== 'function') return;
    try {
      var payload = { name: String(name) };
      if (data && typeof data === 'object') {
        var cleaned = {};
        Object.keys(data).forEach(function (key) {
          var value = data[key];
          if (value === undefined) return;
          if (typeof value === 'string') cleaned[key] = clip(value);
          else if (
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value === null
          ) {
            cleaned[key] = value;
          }
        });
        payload.data = cleaned;
      }
      global.va('event', payload);
    } catch (_) {
      /* analytics must never break booking */
    }
  }

  /** Best-effort step label from a Cal embed routeChanged payload. */
  function classifyCalRoute(event) {
    var detail = (event && event.detail) || {};
    var data = detail.data || event.data || detail || {};
    var raw = clip(
      data.to ||
        data.path ||
        data.route ||
        data.routerUrl ||
        data.url ||
        data.message ||
        ''
    ).toLowerCase();
    if (!raw) return 'unknown';
    if (
      raw.indexOf('success') !== -1 ||
      raw.indexOf('confirm') !== -1 ||
      raw.indexOf('booked') !== -1
    ) {
      return 'success';
    }
    if (
      raw.indexOf('form') !== -1 ||
      raw.indexOf('detail') !== -1 ||
      raw.indexOf('attendee') !== -1 ||
      raw.indexOf('booker') !== -1
    ) {
      return 'details';
    }
    if (raw.indexOf('time') !== -1 || raw.indexOf('slot') !== -1) {
      return 'time';
    }
    if (
      raw.indexOf('date') !== -1 ||
      raw.indexOf('month') !== -1 ||
      raw.indexOf('calendar') !== -1 ||
      raw.indexOf('availability') !== -1
    ) {
      return 'calendar';
    }
    return clip(raw) || 'unknown';
  }

  function serviceFromCalLink(link) {
    if (!link) return 'Unknown';
    var parts = String(link).split('/').filter(Boolean);
    return clip(parts[parts.length - 1] || link) || 'Unknown';
  }

  global.SadieBookingAnalytics = {
    track: trackBookingEvent,
    classifyCalRoute: classifyCalRoute,
    serviceFromCalLink: serviceFromCalLink,
    events: {
      SERVICE_OPENED: 'Booking Service Opened',
      CAL_STEP: 'Booking Cal Step',
      DETAILS_SUBMITTED: 'Booking Details Submitted',
      CONTACT_CAPTURE: 'Booking Contact Capture',
      HOLD_CREATED: 'Booking Hold Created',
      CHECKOUT_VIEWED: 'Checkout Viewed',
      CHECKOUT_PAYMENT_ATTEMPT: 'Checkout Payment Attempt',
      CHECKOUT_EXPIRED: 'Checkout Expired',
      HOLD_ABANDONED: 'Booking Hold Abandoned',
      BOOKING_CONFIRMED: 'Booking Confirmed'
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
