/**
 * Desktop drawer booking-attempt beacon. Shares sessionStorage keys with
 * lib/booking-attempt-client.ts so /checkout continues the same attempt.
 */
(function (global) {
  'use strict';

  var ID_KEY = 'sadie_booking_attempt_id';
  var SURFACE_KEY = 'sadie_booking_attempt_surface';
  var lastReported = '';
  var lastService = '';

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var rand = Math.floor(Math.random() * 16);
      var nibble = ch === 'x' ? rand : (rand & 0x3) | 0x8;
      return nibble.toString(16);
    });
  }

  function read(key) {
    try {
      return global.sessionStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function write(key, value) {
    try {
      global.sessionStorage.setItem(key, value);
    } catch (err) {
      /* private mode */
    }
  }

  /** Selenium / Puppeteer / Playwright set this; real visitors never do. */
  var automated = !!(global.navigator && global.navigator.webdriver);

  function post(body, beacon) {
    if (automated) return;
    var json = JSON.stringify(body);
    var url = '/api/booking/attempt';
    if (beacon && global.navigator && typeof global.navigator.sendBeacon === 'function') {
      var blob = new Blob([json], { type: 'text/plain;charset=UTF-8' });
      if (global.navigator.sendBeacon(url, blob)) return;
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true
    }).catch(function () {});
  }

  function id() {
    return read(ID_KEY);
  }

  function surface() {
    var value = read(SURFACE_KEY);
    return value === 'phone' || value === 'desktop' ? value : 'desktop';
  }

  function begin(nextSurface) {
    var prev = id();
    if (prev) {
      post({ attemptId: prev, surface: surface(), leave: true }, true);
    }
    var next = uuid();
    lastReported = '';
    lastService = '';
    write(ID_KEY, next);
    write(SURFACE_KEY, nextSurface || 'desktop');
    return next;
  }

  /** Keep this tab's visit. A new one starts only when the surface changes. */
  function ensure(nextSurface) {
    var wanted = nextSurface || 'desktop';
    var current = id();
    if (current && surface() === wanted) return current;
    return begin(wanted);
  }

  function report(step, service) {
    if (!step) return;
    var attemptId = id();
    if (!attemptId) return;
    var serviceText = service ? String(service).slice(0, 120) : '';
    if (step === lastReported && serviceText === lastService) return;
    lastReported = step;
    lastService = serviceText;
    var body = { attemptId: attemptId, surface: surface(), step: step };
    if (serviceText) body.service = serviceText;
    post(body, false);
  }

  function leave() {
    var attemptId = id();
    if (!attemptId) return;
    lastReported = '';
    lastService = '';
    post({ attemptId: attemptId, surface: surface(), leave: true }, true);
  }

  global.SadieBookingAttempt = {
    begin: begin,
    ensure: ensure,
    report: report,
    leave: leave,
    id: id,
    surface: surface
  };
})(typeof window !== 'undefined' ? window : globalThis);
