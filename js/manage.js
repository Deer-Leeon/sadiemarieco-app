/* ==========================================================================
   Sadie Marie — Appointment Management Portal
   Client-side controller for /manage.html?uid=<bookingUid>

   Flow
   ────
   1. Read `uid` from the query string.
   2. Fetch booking details through /api/booking (server-side proxy to Cal.com).
   3. Render the details + actions, or an error/expired state.
   4. Reschedule → mount a Cal.com inline embed with `rescheduleUid`.
   5. Cancel → confirmation modal → POST /api/cancel-booking → success state.
   ========================================================================== */

(function () {
  'use strict';

  // ── STATE ──
  const STATES = ['loading', 'error', 'loaded', 'reschedule', 'cancelled'];
  let booking = null;
  let rescheduleMounted = false;

  // ── DOM REFS ──
  const el = (id) => document.getElementById(id);

  const stateNodes = {
    loading: el('portal-loading'),
    error: el('portal-error'),
    loaded: el('portal-loaded'),
    reschedule: el('portal-reschedule'),
    cancelled: el('portal-cancelled')
  };

  const detail = {
    title: el('portal-service-name'),
    status: el('portal-status-pill'),
    date: el('portal-detail-date'),
    time: el('portal-detail-time'),
    duration: el('portal-detail-duration'),
    host: el('portal-detail-host'),
    where: el('portal-detail-where'),
    whereRow: el('portal-detail-where-row'),
    attendee: el('portal-detail-attendee'),
    attendeeRow: el('portal-detail-attendee-row')
  };

  const errorMessage = el('portal-error-message');
  const rescheduleMount = el('portal-reschedule-mount');
  const rescheduleTitle = el('portal-reschedule-title');
  const rescheduleBackBtn = el('portal-reschedule-back');
  const rescheduleBtn = el('portal-reschedule-btn');
  const cancelBtn = el('portal-cancel-btn');

  const modal = el('portal-modal');
  const modalBackdrop = el('portal-modal-backdrop');
  const modalConfirm = el('portal-modal-confirm');
  const modalDismiss = el('portal-modal-dismiss');
  const modalError = el('portal-modal-error');

  // ── HELPERS ──
  const setState = (name) => {
    STATES.forEach((s) => {
      if (!stateNodes[s]) return;
      stateNodes[s].hidden = s !== name;
    });
  };

  const showError = (message) => {
    if (message && errorMessage) errorMessage.textContent = message;
    setState('error');
  };

  const getQueryParam = (key) => {
    const params = new URLSearchParams(window.location.search);
    return (params.get(key) || '').trim();
  };

  // Title in Cal's response looks like "Lamination + Tint between Host and Guest".
  // Split on " between " so we render just the service name. Falls back to a
  // title-cased slug, then finally to the raw title.
  const deriveServiceName = (b) => {
    if (b && b.title && typeof b.title === 'string') {
      const idx = b.title.indexOf(' between ');
      if (idx > 0) return b.title.slice(0, idx).trim();
    }
    if (b && b.eventType && b.eventType.slug) {
      return b.eventType.slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    return (b && b.title) || 'Your session';
  };

  const tzForDisplay = (b) => {
    return (
      (b && b.attendee && b.attendee.timeZone) ||
      (b && b.host && b.host.timeZone) ||
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  };

  const formatDate = (iso, tz) => {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: tz
      }).format(new Date(iso));
    } catch (e) { return '—'; }
  };

  const formatTimeRange = (startIso, endIso, tz) => {
    if (!startIso || !endIso) return '—';
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: tz
      });
      const tzName = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'short'
      }).formatToParts(new Date(startIso)).find((p) => p.type === 'timeZoneName');
      const tzLabel = tzName ? ` (${tzName.value})` : '';
      return `${fmt.format(new Date(startIso))} – ${fmt.format(new Date(endIso))}${tzLabel}`;
    } catch (e) { return '—'; }
  };

  const formatDuration = (mins) => {
    if (!mins) return '—';
    if (mins < 60) return `${mins} minutes`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? '' : 's'}`;
  };

  // ── RENDER ──
  const renderBooking = (b) => {
    booking = b;
    const tz = tzForDisplay(b);

    detail.title.textContent = deriveServiceName(b);
    detail.date.textContent = formatDate(b.start, tz);
    detail.time.textContent = formatTimeRange(b.start, b.end, tz);
    detail.duration.textContent = formatDuration(b.duration);
    detail.host.textContent = (b.host && b.host.name) || '—';

    if (b.location) {
      detail.where.textContent = b.location;
      detail.whereRow.hidden = false;
    } else {
      detail.whereRow.hidden = true;
    }

    if (b.attendee && b.attendee.name) {
      detail.attendee.textContent = b.attendee.name;
      detail.attendeeRow.hidden = false;
    } else {
      detail.attendeeRow.hidden = true;
    }

    // Status pill + action availability. Cal returns lowercase status strings
    // ("accepted", "pending", "cancelled", "rejected", ...). Reschedule/cancel
    // are only meaningful for a live, future booking.
    const status = (b.status || '').toLowerCase();
    const isCancelled = status === 'cancelled' || status === 'rejected';
    const isPast = b.end ? new Date(b.end).getTime() < Date.now() : false;

    detail.status.textContent = isCancelled
      ? 'Cancelled'
      : isPast
        ? 'Past appointment'
        : status === 'pending'
          ? 'Pending confirmation'
          : 'Confirmed';
    detail.status.dataset.variant = isCancelled
      ? 'cancelled'
      : isPast
        ? 'past'
        : status === 'pending'
          ? 'pending'
          : 'confirmed';

    const actionable = !isCancelled && !isPast;
    rescheduleBtn.disabled = !actionable;
    cancelBtn.disabled = !actionable;
    rescheduleBtn.title = actionable ? '' : 'This appointment is no longer active.';
    cancelBtn.title = actionable ? '' : 'This appointment is no longer active.';

    setState('loaded');
  };

  // ── FETCH ──
  const loadBooking = async (uid) => {
    setState('loading');
    try {
      const res = await fetch(`/api/booking?uid=${encodeURIComponent(uid)}`, {
        headers: { Accept: 'application/json' }
      });
      const payload = await res.json().catch(() => null);

      if (res.status === 404) {
        return showError("We couldn't find an appointment matching this link. It may have been cancelled, rescheduled, or the link copied incorrectly.");
      }
      if (res.status === 400) {
        return showError('This link is missing required information. Please use the link from your confirmation email.');
      }
      if (!res.ok) {
        return showError("We hit a snag loading your appointment. Please refresh, or contact the studio if this keeps happening.");
      }
      if (!payload || !payload.uid) {
        return showError("We couldn't load your appointment details. Please try again in a moment.");
      }
      renderBooking(payload);
    } catch (err) {
      console.error('[manage] loadBooking failed:', err);
      showError("We couldn't reach the booking service. Check your connection and try again.");
    }
  };

  // ── RESCHEDULE ──
  // Mounts Cal.com's inline embed with `rescheduleUid` once. Cal handles the
  // slot picker, payment if any, and emits `bookingSuccessful` on completion.
  const mountReschedule = () => {
    if (rescheduleMounted || !booking) return;
    if (!booking.host || !booking.host.username || !booking.eventType || !booking.eventType.slug) {
      showError('This appointment is missing the information needed to reschedule. Please contact the studio.');
      return;
    }
    const calLink = `${booking.host.username}/${booking.eventType.slug}?rescheduleUid=${encodeURIComponent(booking.uid)}`;

    if (typeof window.Cal !== 'function') {
      console.warn('[manage] Cal embed script not yet loaded; retrying shortly');
      setTimeout(mountReschedule, 200);
      return;
    }

    const namespace = 'portal-reschedule';
    window.Cal('init', namespace, { origin: 'https://cal.com' });
    const nsApi = window.Cal.ns && window.Cal.ns[namespace];
    if (!nsApi) {
      showError("We couldn't launch the reschedule view. Please refresh and try again.");
      return;
    }

    nsApi('inline', {
      elementOrSelector: '#portal-reschedule-mount',
      calLink,
      config: { layout: 'month_view' }
    });
    nsApi('ui', window.calUiConfig || { layout: 'month_view' });
    nsApi('on', {
      action: 'bookingSuccessful',
      callback: () => {
        // Once Cal confirms the new slot, refresh our details from the API
        // and pop the user back to the details view. The booking UID
        // typically stays the same across reschedules.
        loadBooking(booking.uid);
      }
    });

    rescheduleMounted = true;
  };

  const openReschedule = () => {
    if (!booking) return;
    if (rescheduleTitle) {
      rescheduleTitle.innerHTML = `Pick a new time for <em>${deriveServiceName(booking)}</em>`;
    }
    setState('reschedule');
    mountReschedule();
  };

  const closeReschedule = () => {
    setState('loaded');
  };

  // ── CANCEL ──
  const openCancelModal = () => {
    modal.hidden = false;
    modalBackdrop.hidden = false;
    modalError.hidden = true;
    modalError.textContent = '';
    modalConfirm.disabled = false;
    modalDismiss.disabled = false;
    // Focus the safe action by default so a stray Enter keypress doesn't cancel.
    requestAnimationFrame(() => modalDismiss.focus());
  };

  const closeCancelModal = () => {
    modal.hidden = true;
    modalBackdrop.hidden = true;
  };

  const confirmCancel = async () => {
    if (!booking) return;
    modalConfirm.disabled = true;
    modalDismiss.disabled = true;
    modalError.hidden = true;
    modalConfirm.textContent = 'Cancelling…';

    try {
      const res = await fetch('/api/cancel-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ uid: booking.uid })
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok || !(payload && payload.ok)) {
        const msg = (payload && payload.upstreamMessage) || 'We couldn\'t cancel right now. Please try again or contact the studio.';
        modalError.textContent = msg;
        modalError.hidden = false;
        modalConfirm.disabled = false;
        modalDismiss.disabled = false;
        modalConfirm.textContent = 'Yes, cancel it';
        return;
      }

      closeCancelModal();
      setState('cancelled');
    } catch (err) {
      console.error('[manage] cancel failed:', err);
      modalError.textContent = "We couldn't reach the booking service. Please try again.";
      modalError.hidden = false;
      modalConfirm.disabled = false;
      modalDismiss.disabled = false;
      modalConfirm.textContent = 'Yes, cancel it';
    }
  };

  // ── EVENT WIRING ──
  rescheduleBtn.addEventListener('click', openReschedule);
  rescheduleBackBtn.addEventListener('click', closeReschedule);
  cancelBtn.addEventListener('click', openCancelModal);
  modalDismiss.addEventListener('click', closeCancelModal);
  modalBackdrop.addEventListener('click', closeCancelModal);
  modalConfirm.addEventListener('click', confirmCancel);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeCancelModal();
  });

  // ── BOOT ──
  const uid = getQueryParam('uid');
  if (!uid) {
    showError('No booking reference was provided. Please open the link from your confirmation email.');
  } else {
    loadBooking(uid);
  }
})();
