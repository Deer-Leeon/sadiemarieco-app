/* ==========================================================================
   Sadie Marie — Appointment Management Portal
   Client-side controller for /manage.html?uid=<bookingUid>

   Flow
   ────
   1. Read `uid` from the query string.
   2. Fetch booking details through /api/booking (server-side proxy to Cal.com).
   3. Render upcoming appointments (when more than one) + details/actions,
      or an error/expired state.
   4. Reschedule → fee confirmation modal → Cal.com inline embed with `rescheduleUid`
      → on success, show confirmed new time + manage link (not the old cancelled booking).
   5. Cancel → confirmation modal (with fee callout) → POST /api/cancel-booking → success state.
   ========================================================================== */

(function () {
  'use strict';

  const STUDIO_ADDRESS = '61 W 3200 N, Suite #10, Lehi, UT 84043';

  // ── STATE ──
  const STATES = ['loading', 'error', 'loaded', 'reschedule', 'cancelled', 'rescheduled', 'empty'];
  let booking = null;
  let rescheduleMounted = false;
  let loadToken = 0;

  // ── DOM REFS ──
  const el = (id) => document.getElementById(id);

  const stateNodes = {
    loading: el('portal-loading'),
    error: el('portal-error'),
    loaded: el('portal-loaded'),
    reschedule: el('portal-reschedule'),
    cancelled: el('portal-cancelled'),
    rescheduled: el('portal-rescheduled'),
    empty: el('portal-empty')
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

  const rescheduledService = el('portal-rescheduled-service');
  const rescheduledDate = el('portal-rescheduled-date');
  const rescheduledTime = el('portal-rescheduled-time');
  const rescheduledManage = el('portal-rescheduled-manage');
  const rescheduledSummary = el('portal-rescheduled-summary');
  const inlineNotice = el('portal-inline-notice');
  const upcomingWrap = el('portal-upcoming');
  const upcomingList = el('portal-upcoming-list');
  const upcomingSummary = el('portal-upcoming-summary');
  const dayReschedule = el('portal-day-reschedule');
  const dayCalendar = el('portal-day-calendar');
  const dayTimes = el('portal-day-times');
  const dayConfirmFee = el('portal-day-confirm-fee');
  const dayConfirm = el('portal-day-confirm');
  const rescheduleHint = el('portal-reschedule-hint');
  const emptyMessage = el('portal-empty-message');
  let selectedIds = new Set();
  let daySlots = {};
  let dayMonth = '';
  let pickedStart = '';
  let visibleDay = '';
  let dayDurationMins = 0;
  let lastFeePreview = null;

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

  const setInlineNotice = (message) => {
    if (!inlineNotice) return;
    if (!message) {
      inlineNotice.hidden = true;
      inlineNotice.textContent = '';
      return;
    }
    inlineNotice.textContent = message;
    inlineNotice.hidden = false;
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

  const escapeHtml = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

  const servicesOf = (b) => (Array.isArray(b && b.services) ? b.services : []);

  const selectedServices = (b) =>
    servicesOf(b).filter((service) => service && selectedIds.has(service.id));

  const selectionHasStarted = () => {
    const chosen = selectedServices(booking);
    if (!chosen.length) return appointmentHasStarted(booking);
    return chosen.some((service) => {
      const startMs = service.start ? new Date(service.start).getTime() : NaN;
      return Number.isFinite(startMs) && startMs <= Date.now();
    });
  };

  const postManageChange = async (action, extra) => {
    const res = await fetch('/api/manage/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(Object.assign({
        uid: booking && booking.uid,
        ids: [...selectedIds],
        action,
      }, extra || {})),
    });
    const payload = await res.json().catch(() => null);
    return { ok: res.ok && payload && payload.ok, payload };
  };

  const describeFeePreview = (preview, action) => {
    const verb = action === 'reschedule' ? 'Rescheduling' : 'Canceling';
    const lines = (preview && preview.services ? preview.services : []).map((service) => {
      const name = escapeHtml(service.service_name || 'Service');
      if (service.waived) return `${name}: one-time courtesy waiver — $0`;
      if (!service.amount_cents) return `${name}: no fee`;
      return `${name}: ${escapeHtml(service.amount_display || '$0')}`;
    });
    const total = escapeHtml((preview && preview.total_display) || '$0');
    return {
      show: true,
      html: `${verb} charges each service from its own start time.<br>${lines.join('<br>')}<br><strong>Total ${total}</strong>`,
    };
  };

  const setPreviewCallout = (node, preview, action) => {
    if (!node) return;
    const desc = describeFeePreview(preview, action);
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

  const formatListWhen = (startIso, endIso, tz) => {
    const date = formatDate(startIso, tz);
    const time = formatTimeRange(startIso, endIso || startIso, tz);
    if (date === '—' && time === '—') return 'Time to be confirmed';
    if (date === '—') return time;
    if (time === '—') return date;
    return `${date} · ${time}`;
  };

  const toIsoMaybe = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
      const ms = new Date(value).getTime();
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value < 1e12 ? value * 1000 : value;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    if (typeof value === 'object') {
      return (
        toIsoMaybe(value.date) ||
        toIsoMaybe(value.start) ||
        toIsoMaybe(value.startTime) ||
        toIsoMaybe(value.end) ||
        toIsoMaybe(value.endTime) ||
        toIsoMaybe(value.time) ||
        null
      );
    }
    return null;
  };

  const firstIso = (...candidates) => {
    for (let i = 0; i < candidates.length; i += 1) {
      const iso = toIsoMaybe(candidates[i]);
      if (iso) return iso;
    }
    return null;
  };

  const parseBookingFromEvent = (event) => {
    const detail = (event && event.detail) || {};
    const payload =
      detail.data ||
      (event && event.data) ||
      detail ||
      {};
    const nestedData =
      (payload && payload.data && typeof payload.data === 'object'
        ? payload.data
        : null) || null;
    const b =
      (payload && payload.booking && typeof payload.booking === 'object'
        ? payload.booking
        : null) ||
      (nestedData && nestedData.booking && typeof nestedData.booking === 'object'
        ? nestedData.booking
        : null) ||
      payload;
    const uidRaw =
      (typeof b.uid === 'string' && b.uid) ||
      (typeof payload.uid === 'string' && payload.uid) ||
      (nestedData && typeof nestedData.uid === 'string' && nestedData.uid) ||
      (typeof detail.uid === 'string' && detail.uid) ||
      '';
    const uid = uidRaw.trim();
    const start = firstIso(
      b.startTime,
      b.start,
      b.date,
      payload.startTime,
      payload.start,
      payload.date,
      nestedData && nestedData.startTime,
      nestedData && nestedData.start,
      nestedData && nestedData.date,
      detail.startTime,
      detail.start
    );
    const end = firstIso(
      b.endTime,
      b.end,
      payload.endTime,
      payload.end,
      nestedData && nestedData.endTime,
      nestedData && nestedData.end,
      detail.endTime,
      detail.end
    );
    const title =
      (typeof b.title === 'string' && b.title) ||
      (typeof b.eventTitle === 'string' && b.eventTitle) ||
      (typeof payload.title === 'string' && payload.title) ||
      (nestedData && typeof nestedData.title === 'string' && nestedData.title) ||
      null;
    const eventType =
      detail.type ||
      detail.action ||
      (typeof event === 'object' && event && event.type) ||
      '';
    return { uid, start, end, title, eventType: String(eventType) };
  };

  const isCalRescheduleSuccessType = (type) => {
    const t = String(type || '').toLowerCase();
    return (
      t.includes('reschedulebookingsuccessful') ||
      t === 'bookingsuccessful' ||
      t === 'bookingsuccessfulv2' ||
      t.endsWith('bookingsuccessful') ||
      t.endsWith('bookingsuccessfulv2')
    );
  };

  /** Cal sometimes returns type tokens (`inPerson`) instead of the address. */
  const formatLocationLabel = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (
      lower === 'inperson' ||
      lower === 'in person' ||
      lower === 'address' ||
      lower === 'in_person'
    ) {
      return STUDIO_ADDRESS;
    }
    return trimmed;
  };

  const replaceManageUidInUrl = (newUid) => {
    const url = new URL(window.location.href);
    url.searchParams.set('uid', newUid);
    const search = url.searchParams.toString();
    window.history.replaceState(
      {},
      '',
      search ? `${url.pathname}?${search}` : url.pathname
    );
  };

  const showRescheduledSuccess = ({ uid, start, end, title }) => {
    const tz = tzForDisplay(booking) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const serviceName = deriveServiceName({
      title: title || (booking && booking.title),
      eventType: booking && booking.eventType,
    });

    if (rescheduledService) rescheduledService.textContent = serviceName;
    if (rescheduledDate) rescheduledDate.textContent = formatDate(start, tz);
    if (rescheduledTime) {
      rescheduledTime.textContent = formatTimeRange(start, end, tz);
    }
    if (rescheduledSummary) {
      rescheduledSummary.textContent =
        'Your new time is confirmed. Keep this manage link for any future changes.';
    }
    if (rescheduledManage) {
      rescheduledManage.href = `/manage?uid=${encodeURIComponent(uid)}`;
    }

    booking = {
      ...(booking || {}),
      uid,
      start,
      end,
      title: title || (booking && booking.title) || null,
      status: 'accepted',
      can_modify: true,
    };
    replaceManageUidInUrl(uid);

    // Tear down Cal's confirmation UI so the dark embed never stays visible.
    if (rescheduleMount) rescheduleMount.innerHTML = '';
    rescheduleMounted = false;

    setState('rescheduled');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const showEmptyUpcoming = (message) => {
    if (message && emptyMessage) emptyMessage.textContent = message;
    booking = null;
    if (upcomingList) upcomingList.innerHTML = '';
    if (upcomingWrap) upcomingWrap.hidden = true;
    setState('empty');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const isSameAppointmentSlot = (existingStart, existingEnd, newStart, newEnd) => {
    if (!existingStart || !newStart) return false;
    const toMinute = (iso) => {
      const ms = new Date(iso).getTime();
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 60000);
    };
    const oldStartMin = toMinute(existingStart);
    const newStartMin = toMinute(newStart);
    if (oldStartMin == null || newStartMin == null) return false;
    // Same start minute = same appointment slot (ignore end-ms/format noise).
    if (oldStartMin !== newStartMin) return false;
    if (existingEnd && newEnd) {
      const oldEndMin = toMinute(existingEnd);
      const newEndMin = toMinute(newEnd);
      if (
        oldEndMin != null &&
        newEndMin != null &&
        oldEndMin !== newEndMin
      ) {
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

  const syncSelectionButtons = (chosen) => {
    const mins = chosen.reduce((sum, service) => sum + (Number(service.duration_mins) || 0), 0);
    const started = chosen.some((service) => {
      const startMs = service.start ? new Date(service.start).getTime() : NaN;
      return Number.isFinite(startMs) && startMs <= Date.now();
    });
    const actionable = chosen.length > 0 && !started;
    rescheduleBtn.disabled = !actionable;
    cancelBtn.disabled = !actionable;
    rescheduleBtn.textContent = chosen.length > 1
      ? `Reschedule ${chosen.length} services (${formatDuration(mins)})`
      : 'Reschedule';
    cancelBtn.textContent = chosen.length > 1
      ? `Cancel ${chosen.length} services (${formatDuration(mins)})`
      : 'Cancel appointment';
    if (upcomingSummary) {
      upcomingSummary.hidden = chosen.length === 0;
      upcomingSummary.textContent = chosen.length
        ? `${chosen.length} selected · ${formatDuration(mins)} together`
        : '';
    }
  };

  // ── RENDER ──
  const renderUpcomingList = (b) => {
    if (!upcomingWrap || !upcomingList) return;
    const services = servicesOf(b);
    if (services.length > 0) {
      const known = new Set(services.map((service) => service.id));
      selectedIds = new Set([...selectedIds].filter((id) => known.has(id)));
      if (selectedIds.size === 0) {
        const current = services.find((service) => service.uid && service.uid === b.uid) || services[0];
        if (current) selectedIds.add(current.id);
      }

      const tz = tzForDisplay(b);
      const days = [];
      const byDay = new Map();
      services.forEach((service) => {
        if (!byDay.has(service.day)) {
          byDay.set(service.day, []);
          days.push(service.day);
        }
        byDay.get(service.day).push(service);
      });

      upcomingList.innerHTML = '';
      days.forEach((day) => {
        const members = byDay.get(day) || [];
        const li = document.createElement('li');
        li.className = 'portal-day-group';
        const heading = document.createElement('h3');
        heading.className = 'portal-day-heading';
        heading.textContent = formatDate(members[0] && members[0].start, tz);
        const nested = document.createElement('ul');
        nested.className = 'portal-upcoming-list';
        members.forEach((service) => {
          const item = document.createElement('li');
          const label = document.createElement('label');
          label.className = 'portal-service-check';
          const checked = selectedIds.has(service.id);
          if (checked) label.classList.add('is-selected');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = checked;
          input.addEventListener('change', () => {
            const chosenNow = selectedServices(b);
            const currentDay = chosenNow[0] && chosenNow[0].day;
            if (input.checked && currentDay && service.day !== currentDay) {
              selectedIds = new Set([service.id]);
            } else if (input.checked) {
              selectedIds.add(service.id);
            } else {
              selectedIds.delete(service.id);
            }
            renderUpcomingList(b);
          });
          const copy = document.createElement('span');
          copy.className = 'portal-upcoming-item-copy';
          const name = document.createElement('span');
          name.className = 'portal-upcoming-item-service';
          name.textContent = service.service_name || 'Appointment';
          const when = document.createElement('span');
          when.className = 'portal-upcoming-item-when';
          const length = formatDuration(service.duration_mins);
          const ownEnd = service.duration_mins
            ? new Date(new Date(service.start).getTime() + Number(service.duration_mins) * 60000).toISOString()
            : service.end;
          when.textContent = `${formatListWhen(service.start, ownEnd, tz)} · ${length}`;
          copy.appendChild(name);
          copy.appendChild(when);
          label.appendChild(input);
          label.appendChild(copy);
          item.appendChild(label);
          nested.appendChild(item);
        });
        li.appendChild(heading);
        li.appendChild(nested);
        upcomingList.appendChild(li);
      });
      upcomingWrap.hidden = false;
      syncSelectionButtons(selectedServices(b));
      return;
    }

    if (upcomingSummary) upcomingSummary.hidden = true;
    rescheduleBtn.textContent = 'Reschedule';
    cancelBtn.textContent = 'Cancel appointment';
    const items = Array.isArray(b && b.upcoming) ? b.upcoming : [];
    const selectedUid = b && b.uid;
    const showList =
      items.length > 1 ||
      (items.length === 1 && items[0] && items[0].uid !== selectedUid);

    if (!showList) {
      upcomingWrap.hidden = true;
      upcomingList.innerHTML = '';
      return;
    }

    const tz = tzForDisplay(b);
    upcomingList.innerHTML = '';
    items.forEach((item) => {
      if (!item || !item.uid) return;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'portal-upcoming-item';
      const isSelected = item.uid === selectedUid;
      if (isSelected) btn.classList.add('is-selected');
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

      const copy = document.createElement('span');
      copy.className = 'portal-upcoming-item-copy';
      const service = document.createElement('span');
      service.className = 'portal-upcoming-item-service';
      service.textContent = item.service_name || 'Appointment';
      const when = document.createElement('span');
      when.className = 'portal-upcoming-item-when';
      when.textContent = formatListWhen(item.start, item.end, tz);
      copy.appendChild(service);
      copy.appendChild(when);

      const mark = document.createElement('span');
      mark.className = 'portal-upcoming-item-mark';
      mark.textContent = isSelected ? 'Selected' : 'View';

      btn.appendChild(copy);
      btn.appendChild(mark);
      btn.addEventListener('click', async () => {
        if (!item.uid || item.uid === (booking && booking.uid)) return;
        const previousUid = booking && booking.uid;
        setInlineNotice('');
        replaceManageUidInUrl(item.uid);
        const ok = await loadBooking(item.uid, { keepView: true, silentError: true });
        if (ok) return;
        if (previousUid) replaceManageUidInUrl(previousUid);
        setInlineNotice(
          "We couldn't load that appointment. Please try again or contact the studio."
        );
        if (booking) renderBooking(booking);
      });

      li.appendChild(btn);
      upcomingList.appendChild(li);
    });
    upcomingWrap.hidden = false;
  };

  const renderBooking = (b) => {
    booking = b;
    const tz = tzForDisplay(b);

    detail.title.textContent = deriveServiceName(b);
    detail.date.textContent = formatDate(b.start, tz);
    detail.time.textContent = formatTimeRange(b.start, b.end, tz);
    detail.duration.textContent = formatDuration(b.duration);
    detail.host.textContent = (b.host && b.host.name) || '—';

    if (b.location) {
      const whereLabel = formatLocationLabel(b.location);
      if (whereLabel) {
        detail.where.textContent = whereLabel;
        detail.whereRow.hidden = false;
      } else {
        detail.whereRow.hidden = true;
      }
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

    renderUpcomingList(b);
    setState('loaded');
  };

  // ── FETCH ──
  const loadBooking = async (uid, options = {}) => {
    const token = ++loadToken;
    const keepView = options.keepView === true && Boolean(booking);
    if (!keepView) setState('loading');
    else {
      rescheduleBtn.disabled = true;
      cancelBtn.disabled = true;
    }
    try {
      const res = await fetch(`/api/booking?uid=${encodeURIComponent(uid)}`, {
        headers: { Accept: 'application/json' }
      });
      const payload = await res.json().catch(() => null);
      if (token !== loadToken) return false;

      if (res.status === 404) {
        if (options.silentError) return false;
        showError("We couldn't find an appointment matching this link. It may have been cancelled, rescheduled, or the link copied incorrectly.");
        return false;
      }
      if (res.status === 400) {
        if (options.silentError) return false;
        showError('This link is missing required information. Please use the link from your confirmation email.');
        return false;
      }
      if (!res.ok) {
        if (options.silentError) return false;
        showError("We hit a snag loading your appointment. Please refresh, or contact the studio if this keeps happening.");
        return false;
      }
      if (!payload || !payload.uid) {
        if (options.silentError) return false;
        showError("We couldn't load your appointment details. Please try again in a moment.");
        return false;
      }
      renderBooking(payload);
      return true;
    } catch (err) {
      if (token !== loadToken) return false;
      console.error('[manage] loadBooking failed:', err);
      if (options.silentError) return false;
      showError("We couldn't reach the booking service. Check your connection and try again.");
      return false;
    }
  };

  const remainingUpcoming = (excludeUid, upcoming) => {
    return (Array.isArray(upcoming) ? upcoming : []).filter(
      (item) => item && item.uid && item.uid !== excludeUid
    );
  };

  const selectNextUpcoming = async (excludeUid, upcoming, notice) => {
    const rest = remainingUpcoming(excludeUid, upcoming);
    for (let i = 0; i < rest.length; i += 1) {
      const nextUid = rest[i].uid;
      replaceManageUidInUrl(nextUid);
      const ok = await loadBooking(nextUid, { silentError: true });
      if (ok) {
        if (notice) setInlineNotice(notice);
        return true;
      }
    }
    return false;
  };

  // ── RESCHEDULE ──
  // Mounts Cal.com's inline embed with `rescheduleUid` once per attempt.
  // On success we immediately swap to our branded confirmation (Cal's own
  // success screen is dark / cluttered and must not stay on screen).
  const RESCHEDULE_NS = 'portal-reschedule';
  const handledRescheduleUids = new Set();
  let rescheduleHandlersBound = false;

  const handleRescheduleSuccess = (event) => {
    if (!booking) return;
    const parsed = parseBookingFromEvent(event);
    const { uid: newUid, start, end, title, eventType } = parsed;

    // Cal emits the same success on the namespaced API and a wildcard `*`.
    // After we apply the new slot, `booking.start` already matches the event,
    // so a second pass used to look like a same-slot noop and flash
    // "already booked" on the manage page.
    if (
      newUid &&
      (handledRescheduleUids.has(newUid) ||
        handledRescheduleUids.has(`same:${newUid}`))
    ) {
      return;
    }

    const typedSuccess = isCalRescheduleSuccessType(eventType);
    // Ignore availability/slot events that happen to include a uid + start.
    if (eventType && !typedSuccess) return;

    const movedToNewUid = Boolean(newUid && newUid !== booking.uid);
    const sameSlot =
      !movedToNewUid &&
      start &&
      isSameAppointmentSlot(booking.start, booking.end, start, end);

    if (sameSlot) {
      if (rescheduleMount) rescheduleMount.innerHTML = '';
      rescheduleMounted = false;
      const uidToLoad = newUid || booking.uid;
      if (newUid) {
        handledRescheduleUids.add(`same:${newUid}`);
        handledRescheduleUids.add(newUid);
        replaceManageUidInUrl(newUid);
      }
      setInlineNotice(
        "You're already booked for this time. Pick a different date or time if you want to move your appointment."
      );
      setState('loaded');
      loadBooking(uidToLoad);
      return;
    }

    // Same UID with no detectable time change — treat as same-slot noop.
    if (newUid && newUid === booking.uid && !start) {
      if (rescheduleMount) rescheduleMount.innerHTML = '';
      rescheduleMounted = false;
      handledRescheduleUids.add(`same:${newUid}`);
      handledRescheduleUids.add(newUid);
      setInlineNotice(
        "You're already booked for this time. Pick a different date or time if you want to move your appointment."
      );
      setState('loaded');
      loadBooking(booking.uid);
      return;
    }

    if (!newUid) {
      console.warn('[manage] reschedule success without uid', event);
      showError(
        'Your appointment was rescheduled, but we could not open the new manage link here. Please use the link in your confirmation text or email.'
      );
      if (rescheduleMount) rescheduleMount.innerHTML = '';
      rescheduleMounted = false;
      return;
    }

    handledRescheduleUids.add(newUid);
    setInlineNotice('');
    showRescheduledSuccess({ uid: newUid, start, end, title });
  };

  const bindRescheduleSuccessHandlers = (nsApi) => {
    const actions = [
      'bookingSuccessful',
      'bookingSuccessfulV2',
      'rescheduleBookingSuccessful',
      'rescheduleBookingSuccessfulV2',
    ];
    actions.forEach((action) => {
      nsApi('on', { action, callback: handleRescheduleSuccess });
    });

    // Also listen on the root Cal API — some embed builds emit namespaced
    // success events there instead of (or in addition to) Cal.ns[...].
    if (!rescheduleHandlersBound && typeof window.Cal === 'function') {
      rescheduleHandlersBound = true;
      window.Cal('on', {
        action: '*',
        callback: (event) => {
          const ns =
            (event && event.detail && event.detail.namespace) || '';
          if (ns && ns !== RESCHEDULE_NS) return;
          const type =
            (event && event.detail && (event.detail.type || event.detail.action)) ||
            (event && event.type) ||
            '';
          if (!isCalRescheduleSuccessType(type)) return;
          handleRescheduleSuccess(event);
        },
      });
    }
  };

  const mountReschedule = () => {
    if (rescheduleMounted || !booking) return;
    if (!booking.host || !booking.host.username || !booking.eventType || !booking.eventType.slug) {
      showError('This appointment is missing the information needed to reschedule. Please contact the studio.');
      return;
    }
    const calLink =
      `${booking.host.username}/${booking.eventType.slug}` +
      `?rescheduleUid=${encodeURIComponent(booking.uid)}` +
      (booking.sms_opt_in === true ? '&sms-consent=true' : '');

    if (typeof window.Cal !== 'function') {
      console.warn('[manage] Cal embed script not yet loaded; retrying shortly');
      setTimeout(mountReschedule, 200);
      return;
    }

    window.Cal('init', RESCHEDULE_NS, { origin: 'https://cal.com' });
    const nsApi = window.Cal.ns && window.Cal.ns[RESCHEDULE_NS];
    if (!nsApi) {
      showError("We couldn't launch the reschedule view. Please refresh and try again.");
      return;
    }

    // Bind listeners before the iframe mounts so we catch V2 success
    // events that fire before Cal paints its confirmation UI.
    bindRescheduleSuccessHandlers(nsApi);

    if (rescheduleMount) rescheduleMount.innerHTML = '';

    const embedConfig = {
      theme: 'light',
      layout: 'month_view',
    };
    // Prefill only — never remove/require sms-consent (A2P: docs/a2p-sms-compliance.md).
    // Already opted in for this appointment — prefill so Cal doesn't look like
    // a fresh opt-in (unchecked must not revoke sticky sms_opt_in server-side).
    if (booking.sms_opt_in === true) {
      embedConfig['sms-consent'] = 'true';
    }

    nsApi('inline', {
      elementOrSelector: '#portal-reschedule-mount',
      calLink,
      config: embedConfig,
    });
    nsApi('ui', Object.assign({}, window.calUiConfig || {}, {
      theme: 'light',
      layout: 'month_view',
      colorScheme: 'light'
    }));

    rescheduleMounted = true;
  };

  const appointmentHasStarted = (b) => {
    if (!b) return true;
    if (typeof b.can_modify === 'boolean') return !b.can_modify;
    const startMs = b.start ? new Date(b.start).getTime() : NaN;
    return Number.isFinite(startMs) && startMs <= Date.now();
  };

  const shiftMonth = (ym, delta) => {
    const [year, month] = ym.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const renderDayTimes = (day) => {
    if (!dayTimes) return;
    visibleDay = day || visibleDay;
    const times = daySlots[visibleDay] || [];
    dayTimes.innerHTML = '';
    const tz = tzForDisplay(booking);
    times.forEach((iso) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'portal-day-time';
      if (iso === pickedStart) btn.classList.add('is-picked');
      const end = new Date(new Date(iso).getTime() + dayDurationMins * 60000).toISOString();
      btn.textContent = formatTimeRange(iso, end, tz);
      btn.addEventListener('click', () => {
        pickedStart = iso;
        if (dayConfirm) dayConfirm.disabled = false;
        renderDayTimes(visibleDay);
        renderDayCalendar();
      });
      dayTimes.appendChild(btn);
    });
  };

  const renderDayCalendar = () => {
    if (!dayCalendar) return;
    if (!dayMonth) {
      const keys = Object.keys(daySlots).sort();
      dayMonth = keys[0] ? keys[0].slice(0, 7) : new Date().toISOString().slice(0, 7);
    }
    const [year, month] = dayMonth.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const title = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
      .map((label) => `<span>${label}</span>`)
      .join('');
    for (let blank = 0; blank < first; blank += 1) cells += '<span></span>';
    for (let day = 1; day <= count; day += 1) {
      const key = `${dayMonth}-${String(day).padStart(2, '0')}`;
      const open = Array.isArray(daySlots[key]) && daySlots[key].length > 0;
      const picked = key === visibleDay;
      cells += `<button type="button" class="portal-day-cell${open ? ' is-open' : ''}${picked ? ' is-picked' : ''}" data-day="${key}" ${open ? '' : 'disabled'}>${day}</button>`;
    }
    dayCalendar.innerHTML =
      `<div class="portal-day-calendar-nav">` +
      `<button type="button" class="btn-outline-navy" data-month="-1">←</button>` +
      `<h3>${escapeHtml(title)}</h3>` +
      `<button type="button" class="btn-outline-navy" data-month="1">→</button>` +
      `</div><div class="portal-day-grid">${cells}</div>`;
    dayCalendar.querySelectorAll('[data-month]').forEach((btn) => {
      btn.addEventListener('click', () => {
        dayMonth = shiftMonth(dayMonth, Number(btn.getAttribute('data-month')));
        renderDayCalendar();
      });
    });
    dayCalendar.querySelectorAll('[data-day]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pickedStart = '';
        if (dayConfirm) dayConfirm.disabled = true;
        renderDayTimes(btn.getAttribute('data-day'));
        renderDayCalendar();
      });
    });
  };

  const mountDayPicker = async () => {
    pickedStart = '';
    visibleDay = '';
    if (dayConfirm) {
      dayConfirm.disabled = true;
      dayConfirm.textContent = 'Confirm new time';
    }
    if (dayTimes) dayTimes.innerHTML = '';
    if (dayConfirmFee && lastFeePreview) {
      setPreviewCallout(dayConfirmFee, lastFeePreview, 'reschedule');
    }
    if (dayCalendar) dayCalendar.textContent = 'Loading open times…';
    const params = new URLSearchParams({
      uid: booking.uid,
      ids: [...selectedIds].join(','),
    });
    try {
      const res = await fetch(`/api/manage/change?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload || !payload.ok) {
        if (dayCalendar) {
          dayCalendar.textContent =
            (payload && payload.message) || "We couldn't load open times.";
        }
        return;
      }
      daySlots = payload.slots || {};
      dayDurationMins = Number(payload.duration_mins) || 0;
      const first = Object.keys(daySlots).sort()[0] || '';
      dayMonth = (payload.today || first || new Date().toISOString()).slice(0, 7);
      visibleDay = first;
      renderDayCalendar();
      if (first) renderDayTimes(first);
      else if (dayTimes) dayTimes.textContent = 'No open times fit these services in the next six weeks.';
    } catch (err) {
      console.error('[manage] slots failed', err);
      if (dayCalendar) dayCalendar.textContent = "We couldn't load open times.";
    }
  };

  const confirmDayMove = async () => {
    if (!pickedStart || !dayConfirm) return;
    dayConfirm.disabled = true;
    dayConfirm.textContent = 'Moving…';
    try {
      const result = await postManageChange('reschedule', { start: pickedStart });
      if (!result.ok) {
        setInlineNotice(
          (result.payload && result.payload.message) || "We couldn't move that visit."
        );
        dayConfirm.disabled = false;
        dayConfirm.textContent = 'Confirm new time';
        return;
      }
      const payload = result.payload || {};
      showRescheduledSuccess({
        uid: payload.uid || booking.uid,
        start: payload.start,
        end: payload.end,
        title: payload.service_name,
      });
    } catch (err) {
      console.error('[manage] reschedule failed', err);
      setInlineNotice("We couldn't move that visit. Please try again.");
      dayConfirm.disabled = false;
      dayConfirm.textContent = 'Confirm new time';
    }
  };

  const openRescheduleModal = async () => {
    if (!booking) return;
    if (selectionHasStarted()) {
      showError(
        'This appointment has started and can no longer be rescheduled. Please contact the studio if you need help.'
      );
      setState('loaded');
      return;
    }
    setInlineNotice('');
    const chosen = selectedServices(booking);
    if (chosen.length) {
      const mins = chosen.reduce((sum, service) => sum + (Number(service.duration_mins) || 0), 0);
      if (rescheduleModalBody) {
        rescheduleModalBody.textContent = chosen.length > 1
          ? `You'll move ${chosen.length} services to one new time that fits ${formatDuration(mins)}. Each service is charged from its own current start time.`
          : "You'll pick a new time on the next screen. Your current slot is released once you confirm the new one.";
      }
      try {
        const preview = await postManageChange('preview');
        if (preview.ok) {
          lastFeePreview = preview.payload;
          setPreviewCallout(rescheduleModalFee, preview.payload, 'reschedule');
        } else {
          setFeeCallout(rescheduleModalFee, booking.change_fee, 'reschedule');
        }
      } catch (err) {
        setFeeCallout(rescheduleModalFee, booking.change_fee, 'reschedule');
      }
    } else {
      lastFeePreview = null;
      setFeeCallout(rescheduleModalFee, booking.change_fee, 'reschedule');
      if (rescheduleModalBody) {
        rescheduleModalBody.textContent =
          "You'll pick a new time on the next screen. Your current slot is released once you confirm the new one.";
      }
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
    if (selectionHasStarted()) {
      showError(
        'This appointment has started and can no longer be rescheduled. Please contact the studio if you need help.'
      );
      setState('loaded');
      return;
    }
    const chosen = selectedServices(booking);
    if (chosen.length) {
      const label = chosen.map((service) => service.service_name).join(' + ');
      const mins = chosen.reduce((sum, service) => sum + (Number(service.duration_mins) || 0), 0);
      if (rescheduleTitle) {
        rescheduleTitle.innerHTML = `Pick a new time for <em>${escapeHtml(label)}</em>`;
      }
      if (rescheduleHint) {
        rescheduleHint.textContent =
          `Only times long enough for ${formatDuration(mins)} are shown. The services stay back to back.`;
      }
      if (rescheduleMount) rescheduleMount.hidden = true;
      if (dayReschedule) dayReschedule.hidden = false;
      setState('reschedule');
      mountDayPicker();
      return;
    }
    if (dayReschedule) dayReschedule.hidden = true;
    if (rescheduleMount) rescheduleMount.hidden = false;
    if (rescheduleTitle) {
      rescheduleTitle.innerHTML = `Pick a new time for <em>${escapeHtml(deriveServiceName(booking))}</em>`;
    }
    setState('reschedule');
    mountReschedule();
  };

  const openReschedule = () => {
    openRescheduleModal();
  };

  const closeReschedule = () => {
    if (rescheduleMount) {
      rescheduleMount.innerHTML = '';
      rescheduleMount.hidden = false;
    }
    if (dayReschedule) dayReschedule.hidden = true;
    rescheduleMounted = false;
    setState('loaded');
  };

  // ── CANCEL ──
  const openCancelModal = async () => {
    if (selectionHasStarted()) {
      showError(
        'This appointment has started and can no longer be canceled. Please contact the studio if you need help.'
      );
      return;
    }
    const chosen = selectedServices(booking);
    if (chosen.length) {
      const mins = chosen.reduce((sum, service) => sum + (Number(service.duration_mins) || 0), 0);
      const modalBody = el('portal-modal-body');
      if (modalBody) {
        modalBody.textContent = chosen.length > 1
          ? `Cancel ${chosen.length} services (${formatDuration(mins)})? This can't be undone.`
          : "Are you sure you want to cancel? This can't be undone — you'd need to book a new session if you change your mind.";
      }
      try {
        const preview = await postManageChange('preview');
        if (preview.ok) setPreviewCallout(modalFee, preview.payload, 'cancel');
        else setFeeCallout(modalFee, booking && booking.change_fee, 'cancel');
      } catch (err) {
        setFeeCallout(modalFee, booking && booking.change_fee, 'cancel');
      }
    } else {
      setFeeCallout(modalFee, booking && booking.change_fee, 'cancel');
    }
    modal.hidden = false;
    modalBackdrop.hidden = false;
    modalError.hidden = true;
    modalError.textContent = '';
    modalConfirm.disabled = false;
    modalDismiss.disabled = false;
    requestAnimationFrame(() => modalDismiss.focus());
  };

  const closeCancelModal = () => {
    modal.hidden = true;
    if (rescheduleModal && !rescheduleModal.hidden) return;
    modalBackdrop.hidden = true;
  };

  const confirmCancel = async () => {
    if (!booking) return;
    if (selectionHasStarted()) {
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
      const chosen = selectedServices(booking);
      if (chosen.length) {
        const result = await postManageChange('cancel');
        if (!result.ok) {
          modalError.textContent =
            (result.payload && result.payload.message) ||
            "We couldn't cancel right now. Please try again or contact the studio.";
          modalError.hidden = false;
          modalConfirm.disabled = false;
          modalDismiss.disabled = false;
          modalConfirm.textContent = 'Yes, cancel it';
          return;
        }
        closeCancelModal();
        modalConfirm.disabled = false;
        modalDismiss.disabled = false;
        modalConfirm.textContent = 'Yes, cancel it';
        const payload = result.payload || {};
        if (payload.remaining_uid) {
          selectedIds = new Set();
          replaceManageUidInUrl(payload.remaining_uid);
          setInlineNotice('Those services were cancelled. Your other upcoming visits are still listed.');
          await loadBooking(payload.remaining_uid);
          return;
        }
        if (payload.remaining) {
          showEmptyUpcoming(
            'Those services were cancelled. If another visit is still booked and this page looks empty, contact the studio.'
          );
          return;
        }
        setState('cancelled');
        return;
      }

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
      modalConfirm.disabled = false;
      modalDismiss.disabled = false;
      modalConfirm.textContent = 'Yes, cancel it';
      const cancelledUid = booking.uid;
      const siblings = booking.upcoming;
      const moved = await selectNextUpcoming(
        cancelledUid,
        siblings,
        'That appointment was cancelled. Your other upcoming visits are still listed.'
      );
      if (moved) return;
      showEmptyUpcoming(
        'That appointment was cancelled. You have no other upcoming visits scheduled. Book a new session whenever you\'re ready.'
      );
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
  if (dayConfirm) dayConfirm.addEventListener('click', confirmDayMove);
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
  if (rescheduledManage) {
    rescheduledManage.addEventListener('click', (event) => {
      event.preventDefault();
      const href = rescheduledManage.getAttribute('href') || '';
      let nextUid = '';
      try {
        nextUid = new URL(href, window.location.origin).searchParams.get('uid') || '';
      } catch (err) {
        nextUid = '';
      }
      if (!nextUid && booking) nextUid = booking.uid;
      if (!nextUid) return;
      setInlineNotice('');
      loadBooking(nextUid);
    });
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
