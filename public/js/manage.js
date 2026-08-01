/* ==========================================================================
   Sadie Marie — Appointment Management Portal
   Client-side controller for /manage.html?uid=<bookingUid>

   Flow
   ────
   1. Read `uid` from the query string.
   2. Fetch booking details through /api/booking (server-side proxy to Cal.com).
   3. Render the details + actions, or an error/expired state.
   4. Reschedule → fee confirmation modal → Cal.com inline embed with `rescheduleUid`.
   5. Cancel → confirmation modal (with fee callout) → POST /api/cancel-booking → success state.
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
  const modalFee = el('portal-modal-fee');

  const rescheduleModal = el('portal-reschedule-modal');
  const rescheduleModalBody = el('portal-reschedule-modal-body');
  const rescheduleModalFee = el('portal-reschedule-modal-fee');
  const rescheduleModalConfirm = el('portal-reschedule-modal-confirm');
  const rescheduleModalDismiss = el('portal-reschedule-modal-dismiss');

  // ── HELPERS ──
  const setState = (name) => {
    STATES.forEach((s) => {
      if (!stateNodes[s]) return;
      stateNodes[s].hidden = s !== name;
    });
    // Reschedule view goes "focus mode": masthead/footer hide and the Cal
    // embed expands to fill the viewport so users don't have to scroll past
    // any chrome to see and pick a new slot.
    document.body.classList.toggle('portal-focus-mode', name === 'reschedule');
  };

  const showError = (message) => {
    if (message && errorMessage) errorMessage.textContent = message;
    setState('error');
  };

  const getQueryParam = (key) => {
    const params = new URLSearchParams(window.location.search);
    return (params.get(key) || '').trim();
  };

  /**
   * Build fee warning copy from `/api/booking` `change_fee` preview.
   * Returns { html, show } for the modal fee callout.
   */
  const describeChangeFee = (fee, action) => {
    const verb = action === 'reschedule' ? 'Rescheduling' : 'Canceling';
    if (!fee || fee.tier === 'none') {
      return {
        show: true,
        html:
          action === 'reschedule'
            ? 'You\u2019re more than 24 hours before your appointment, so you can reschedule <strong>without a fee</strong>.'
            : 'You\u2019re more than 24 hours before your appointment, so you can cancel <strong>without a fee</strong>.',
      };
    }

    const pct = Math.round((fee.fraction || 0) * 100);
    const isNoShow = fee.tier === 'no_show_full';
    const windowLabel = isNoShow
      ? 'under 2 hours before your appointment'
      : 'within 24 hours of your appointment';

    if (fee.waived) {
      return {
        show: true,
        html: `${verb} ${windowLabel} would normally charge your card, but a <strong>one-time courtesy waiver</strong> applies \u2014 you won\u2019t be charged this time.`,
      };
    }

    if (fee.amount_display) {
      const noShowNote = isNoShow
        ? ' (treated as a no-show at 100% of the service cost)'
        : ` (${pct}% of the service cost)`;
      return {
        show: true,
        html: `${verb} now will charge <strong>${fee.amount_display}</strong>${noShowNote} to the card on file.`,
      };
    }

    // Price unknown — still warn with the policy %.
    return {
      show: true,
      html: `${verb} ${windowLabel} may charge <strong>${pct}%</strong> of the service cost to the card on file. See our <a href="/#policies">studio policy</a>.`,
    };
  };

  const setFeeCallout = (node, fee, action) => {
    if (!node) return;
    const desc = describeChangeFee(fee, action);
    if (!desc.show) {
      node.hidden = true;
      node.innerHTML = '';
      return;
    }
    node.innerHTML = desc.html;
    node.hidden = false;
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

  const parseBookingTimesFromEvent = (event) => {
    const payload =
      (event && event.detail && event.detail.data) ||
      (event && event.data) ||
      {};
    const booking = payload.booking || payload;
    const start =
      (typeof booking.startTime === 'string' && booking.startTime) ||
      (typeof booking.start === 'string' && booking.start) ||
      null;
    const end =
      (typeof booking.endTime === 'string' && booking.endTime) ||
      (typeof booking.end === 'string' && booking.end) ||
      null;
    return { start, end };
  };

  const isSameAppointmentSlot = (existingStart, existingEnd, newStart, newEnd) => {
    if (!existingStart || !newStart) return false;
    const oldStartMs = new Date(existingStart).getTime();
    const newStartMs = new Date(newStart).getTime();
    if (!Number.isFinite(oldStartMs) || !Number.isFinite(newStartMs)) return false;
    if (oldStartMs !== newStartMs) return false;
    if (existingEnd && newEnd) {
      const oldEndMs = new Date(existingEnd).getTime();
      const newEndMs = new Date(newEnd).getTime();
      if (Number.isFinite(oldEndMs) && Number.isFinite(newEndMs) && oldEndMs !== newEndMs) {
        return false;
      }
    }
    return true;
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
    // are only allowed before the appointment start time.
    const status = (b.status || '').toLowerCase();
    const isCancelled = status === 'cancelled' || status === 'rejected';
    const startMs = b.start ? new Date(b.start).getTime() : NaN;
    const hasStarted =
      Number.isFinite(startMs) && startMs <= Date.now();
    const locked =
      typeof b.can_modify === 'boolean' ? !b.can_modify : hasStarted;

    detail.status.textContent = isCancelled
      ? 'Cancelled'
      : locked
        ? 'In progress or past'
        : status === 'pending'
          ? 'Pending confirmation'
          : 'Confirmed';
    detail.status.dataset.variant = isCancelled
      ? 'cancelled'
      : locked
        ? 'past'
        : status === 'pending'
          ? 'pending'
          : 'confirmed';

    const actionable = !isCancelled && !locked;
    rescheduleBtn.disabled = !actionable;
    cancelBtn.disabled = !actionable;
    const lockedTitle = locked
      ? 'This appointment has started and can no longer be changed.'
      : 'This appointment is no longer active.';
    rescheduleBtn.title = actionable ? '' : lockedTitle;
    cancelBtn.title = actionable ? '' : lockedTitle;

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
      config: { theme: 'light', layout: 'month_view' }
    });
    nsApi('ui', Object.assign({}, window.calUiConfig || {}, {
      theme: 'light',
      layout: 'month_view'
    }));
    const handleRescheduleSuccess = (event) => {
      const { start, end } = parseBookingTimesFromEvent(event);
      if (
        start &&
        isSameAppointmentSlot(booking.start, booking.end, start, end)
      ) {
        showError(
          "You're already booked for this time. Choose a different date or time to move your appointment."
        );
        setState('reschedule');
        return;
      }
      loadBooking(booking.uid);
    };

    ['bookingSuccessful', 'bookingSuccessfulV2', 'rescheduleBookingSuccessful', 'rescheduleBookingSuccessfulV2'].forEach(
      (action) => {
        nsApi('on', { action, callback: handleRescheduleSuccess });
      }
    );

    rescheduleMounted = true;
  };

  const appointmentHasStarted = (b) => {
    if (!b) return true;
    if (typeof b.can_modify === 'boolean') return !b.can_modify;
    const startMs = b.start ? new Date(b.start).getTime() : NaN;
    return Number.isFinite(startMs) && startMs <= Date.now();
  };

  const openRescheduleModal = () => {
    if (!booking) return;
    if (appointmentHasStarted(booking)) {
      showError(
        'This appointment has started and can no longer be rescheduled. Please contact the studio if you need help.'
      );
      setState('loaded');
      return;
    }
    setFeeCallout(rescheduleModalFee, booking.change_fee, 'reschedule');
    if (rescheduleModalBody) {
      rescheduleModalBody.textContent =
        "You'll pick a new time on the next screen. Your current slot is released once you confirm the new one.";
    }
    modalBackdrop.hidden = false;
    rescheduleModal.hidden = false;
    requestAnimationFrame(() => rescheduleModalDismiss && rescheduleModalDismiss.focus());
  };

  const closeRescheduleModal = () => {
    if (rescheduleModal) rescheduleModal.hidden = true;
    // Keep backdrop if cancel modal is open (shouldn't happen).
    if (modal && !modal.hidden) return;
    modalBackdrop.hidden = true;
  };

  const confirmRescheduleModal = () => {
    closeRescheduleModal();
    proceedToReschedule();
  };

  const proceedToReschedule = () => {
    if (!booking) return;
    if (appointmentHasStarted(booking)) {
      showError(
        'This appointment has started and can no longer be rescheduled. Please contact the studio if you need help.'
      );
      setState('loaded');
      return;
    }
    if (rescheduleTitle) {
      rescheduleTitle.innerHTML = `Pick a new time for <em>${deriveServiceName(booking)}</em>`;
    }
    setState('reschedule');
    mountReschedule();
  };

  const openReschedule = () => {
    openRescheduleModal();
  };

  const closeReschedule = () => {
    setState('loaded');
  };

  // ── CANCEL ──
  const openCancelModal = () => {
    if (appointmentHasStarted(booking)) {
      showError(
        'This appointment has started and can no longer be canceled. Please contact the studio if you need help.'
      );
      return;
    }
    setFeeCallout(modalFee, booking && booking.change_fee, 'cancel');
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
    if (rescheduleModal && !rescheduleModal.hidden) return;
    modalBackdrop.hidden = true;
  };

  const confirmCancel = async () => {
    if (!booking) return;
    if (appointmentHasStarted(booking)) {
      closeCancelModal();
      showError(
        'This appointment has started and can no longer be canceled. Please contact the studio if you need help.'
      );
      return;
    }
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
        const msg =
          (payload && (payload.message || payload.upstreamMessage)) ||
          "We couldn't cancel right now. Please try again or contact the studio.";
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
  modalBackdrop.addEventListener('click', () => {
    if (rescheduleModal && !rescheduleModal.hidden) closeRescheduleModal();
    else closeCancelModal();
  });
  modalConfirm.addEventListener('click', confirmCancel);
  if (rescheduleModalConfirm) {
    rescheduleModalConfirm.addEventListener('click', confirmRescheduleModal);
  }
  if (rescheduleModalDismiss) {
    rescheduleModalDismiss.addEventListener('click', closeRescheduleModal);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (rescheduleModal && !rescheduleModal.hidden) closeRescheduleModal();
    else if (modal && !modal.hidden) closeCancelModal();
  });

  // ── BOOT ──
  const uid = getQueryParam('uid');
  if (!uid) {
    showError('No booking reference was provided. Please open the link from your confirmation email.');
  } else {
    loadBooking(uid);
  }
})();
