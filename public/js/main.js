/* ==========================================================================
   Sadie Marie — Luxury Beauty Studio
   Main JavaScript: nav scroll behavior, scroll-reveal animations,
   FAQ accordion, services accordion with lazy-loaded Cal.com widgets
   ========================================================================== */

(function () {
  'use strict';

  // ── MARQUEE (seamless infinite scroll) ──
  // Clone the phrase group until the track is wider than the viewport so
  // wide screens never show empty strip. Animate by exactly one group width
  // (measured in px) so the loop resets without a gap or snap.
  function initMarqueeTrack(track) {
    const template = track.querySelector('.marquee-group');
    if (!template) return null;

    function rebuild() {
      track.classList.remove('marquee-ready');
      track.querySelectorAll('.marquee-group').forEach((group, index) => {
        if (index > 0) group.remove();
      });

      const groupWidth = template.offsetWidth;
      if (!groupWidth) return;

      const minWidth = window.innerWidth + groupWidth * 2;
      while (track.scrollWidth < minWidth) {
        const clone = template.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        track.appendChild(clone);
      }

      track.style.setProperty('--marquee-shift', `${groupWidth}px`);
      track.style.setProperty('--marquee-duration', `${Math.max(22, groupWidth / 42)}s`);
      track.classList.add('marquee-ready');
    }

    return rebuild;
  }

  function initMarquees() {
    const tracks = document.querySelectorAll('.marquee-track');
    if (!tracks.length) return;

    const rebuilders = [];
    tracks.forEach((track) => {
      const rebuild = initMarqueeTrack(track);
      if (rebuild) {
        rebuild();
        rebuilders.push(rebuild);
      }
    });

    if (!rebuilders.length) return;

    let resizeTimer;
    const rebuildAll = () => rebuilders.forEach((rebuild) => rebuild());

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuildAll, 150);
    });
    window.addEventListener('load', rebuildAll);
  }

  initMarquees();

  // ── SMOOTH IN-PAGE ANCHOR SCROLL ──
  // Nav and other #section links animate scroll; wheel/touch stay instant (html scroll-behavior: auto).
  function initSmoothAnchorScroll() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DURATION_MS = 560;

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    let scrollAnim = null;

    function smoothScrollTo(targetY) {
      if (reduceMotion) {
        window.scrollTo(0, targetY);
        return;
      }
      if (scrollAnim) cancelAnimationFrame(scrollAnim);
      const startY = window.scrollY;
      const delta = targetY - startY;
      if (Math.abs(delta) < 2) return;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min((now - start) / DURATION_MS, 1);
        window.scrollTo(0, startY + delta * easeInOutCubic(t));
        if (t < 1) scrollAnim = requestAnimationFrame(step);
        else scrollAnim = null;
      };
      scrollAnim = requestAnimationFrame(step);
    }

    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;
      const raw = link.getAttribute('href');
      if (!raw || raw === '#') return;
      let id;
      try {
        id = decodeURIComponent(raw.slice(1));
      } catch {
        return;
      }
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      // Match native anchor jumps: section top aligns with viewport top (same as before smooth scroll).
      const top = target.getBoundingClientRect().top + window.scrollY;
      smoothScrollTo(Math.max(0, top));
      if (history.pushState) history.pushState(null, '', raw);
    });
  }

  initSmoothAnchorScroll();

  // ── SCROLL REVEAL ──
  // Matches the site's 860px mobile breakpoint in styles.css.
  const MOBILE_LAYOUT_MAX_PX = 860;
  const reveals = document.querySelectorAll('.reveal');
  const showAllReveals = () => {
    reveals.forEach((el) => el.classList.add('visible'));
  };
  const isMobileInstantLayout = () =>
    window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_PX}px)`).matches;

  if (reveals.length) {
    if (isMobileInstantLayout()) {
      showAllReveals();
    } else if ('IntersectionObserver' in window) {
      const revealObs = new IntersectionObserver((entries) => {
        requestAnimationFrame(() => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('visible');
              revealObs.unobserve(entry.target);
            }
          });
        });
      }, { threshold: 0.08, rootMargin: '0px 0px 8% 0px' });
      reveals.forEach((el) => revealObs.observe(el));
    } else {
      showAllReveals();
    }
  }

  // ── FAQ ACCORDION ──
  document.querySelectorAll('.faq-q').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.parentElement;
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach((i) => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  // ── BOOKING DRAWER (Off-canvas) ──
  // Every service calendar is pre-rendered into its own mount inside the
  // drawer at page load, so clicks become an instant CSS-class swap rather
  // than a fresh iframe boot. Each service gets a dedicated Cal namespace
  // (required for multiple inline embeds on a single page).
  const drawer = document.getElementById('booking-drawer');
  const backdrop = document.getElementById('booking-backdrop');
  const drawerContainer = document.getElementById('drawer-cal-container');
  const closeButton = document.getElementById('close-drawer');
  const drawerTitleEl = document.getElementById('drawer-title');
  const drawerSubtitleEl = drawer ? drawer.querySelector('.drawer-subtitle') : null;

  const serviceItems = document.querySelectorAll('.service-item[data-cal-link]');
  const mountsByLink = new Map();
  const linkIndices = new Map();
  // Tracks how many times we've spun up an iframe for a given service link.
  // Used to mint a fresh Cal namespace + mount id each rebuild so the new
  // embed doesn't collide with the namespace the previous (booked) iframe
  // registered.
  const instanceCountByLink = new Map();
  // Wall-clock time each iframe was last (re)built. Read by `ensureFreshMount`
  // to decide whether an opened drawer needs a hard rebuild before display.
  // See FRESHNESS_MS below for the rationale.
  const mountCreatedAt = new Map();
  // Service links whose cached availability we know (or suspect) is no longer
  // accurate. Drained when the iframe is rebuilt. Two distinct events seed it:
  //   1. The user just completed a booking in this iframe → the embed is
  //      parked on Cal's confirmation screen; reopening should restart at
  //      the calendar, not the receipt.
  //   2. The user completed a booking in ANY other iframe → McKenna's
  //      availability shrank everywhere on her calendar (a 7pm booking on
  //      "Brow Shape" knocks 7pm out of "Volume Fill" too), so every
  //      pre-rendered iframe is now showing at-least-one stale slot.
  const staleLinks = new Set();
  // Hard upper bound on how long an iframe is allowed to sit on cached
  // availability before we throw it away and refetch. Anything past this
  // window risks displaying a slot that a different visitor booked in the
  // meantime (we can't push to their cache without WebSockets, so we eat
  // the half-second iframe re-boot as a freshness tax instead). 60 s keeps
  // the "instant open" UX intact for actively-browsing users while
  // capping cross-user staleness to a single minute.
  const FRESHNESS_MS = 60 * 1000;

  /** Drawer shell stays fixed; reset any stray scroll offsets on step changes. */
  const scrollDrawerToTop = () => {
    if (drawer) drawer.scrollTop = 0;
    if (drawerContainer) drawerContainer.scrollTop = 0;
  };

  const teardownDrawerEmbedFrame = (mount) => {
    if (!mount || typeof mount.__drawerFrameCleanup !== 'function') return;
    mount.__drawerFrameCleanup();
    delete mount.__drawerFrameCleanup;
  };

  /**
   * Cal inline embeds grow the iframe to content height and ask the parent
   * to scroll (`__scrollByDistance`). Pin the iframe to the drawer's
   * remaining viewport so the booker scrolls internally (timeslots column).
   */
  const bindDrawerEmbedFrame = (mount) => {
    if (!mount || !drawerContainer) return;
    teardownDrawerEmbedFrame(mount);

    const applyFrameBounds = () => {
      const iframe = mount.querySelector('iframe');
      if (!iframe) return;
      const h = drawerContainer.clientHeight;
      if (h <= 0) return;
      iframe.style.setProperty('height', `${h}px`, 'important');
      iframe.style.setProperty('max-height', `${h}px`, 'important');
    };

    const ro = new ResizeObserver(applyFrameBounds);
    ro.observe(drawerContainer);

    const mo = new MutationObserver(applyFrameBounds);
    mo.observe(mount, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'height']
    });

    mount.__drawerFrameCleanup = () => {
      ro.disconnect();
      mo.disconnect();
    };

    applyFrameBounds();
    requestAnimationFrame(applyFrameBounds);
  };

  const registerDrawerEmbedUi = (nsApi) => {
    const base = window.calUiConfig || {};
    nsApi('ui', Object.assign({}, base, {
      layout: 'month_view',
      disableAutoScroll: true,
      'ui.autoscroll': 'false'
    }));

    const onStepChange = () => scrollDrawerToTop();
    ['routeChanged', 'linkReady'].forEach((action) => {
      nsApi('on', { action, callback: onStepChange });
    });
  };

  // Prevent double-redirect when both bookingSuccessfulV2 and the legacy
  // bookingSuccessful event fire for the same booking.
  const checkoutRedirectedUids = new Set();

  const showCheckoutHandoff = () => {
    if (drawer) drawer.classList.remove('drawer-open');
    if (backdrop) backdrop.classList.remove('drawer-open');
    const handoff = document.getElementById('checkout-handoff');
    if (handoff) handoff.classList.add('is-active');
  };

  /** Cal v2 puts uid/title/startTime on `data`; legacy nests under `data.booking`. */
  const parseBookingFromEvent = (event) => {
    const payload =
      (event && event.detail && event.detail.data) ||
      (event && event.data) ||
      {};
    const booking = payload.booking || payload;
    const uid = typeof booking.uid === 'string' ? booking.uid : '';
    const attendees = Array.isArray(booking.attendees) ? booking.attendees : [];
    const attendee = attendees[0] || {};
    const name = typeof attendee.name === 'string' ? attendee.name : '';
    const email = typeof attendee.email === 'string' ? attendee.email : '';
    const serviceName =
      (typeof booking.title === 'string' && booking.title) ||
      (typeof booking.eventTitle === 'string' && booking.eventTitle) ||
      '';
    const bookingTime =
      (typeof booking.startTime === 'string' && booking.startTime) ||
      (typeof booking.start === 'string' && booking.start) ||
      null;
    const endTime =
      (typeof booking.endTime === 'string' && booking.endTime) ||
      (typeof booking.end === 'string' && booking.end) ||
      null;
    const phone =
      (typeof attendee.phoneNumber === 'string' && attendee.phoneNumber) ||
      '';
    return { uid, name, email, serviceName, bookingTime, endTime, phone };
  };

  const redirectToCheckoutAfterBooking = (event, link) => {
    staleLinks.add(link);
    mountsByLink.forEach((_, otherLink) => {
      if (otherLink !== link) staleLinks.add(otherLink);
    });

    try {
      const {
        uid,
        name,
        email,
        serviceName,
        bookingTime,
        endTime,
        phone
      } = parseBookingFromEvent(event);

      if (!uid) {
        console.warn(
          '[booking] booking success event without uid — skipping redirect',
          event
        );
        return;
      }

      if (checkoutRedirectedUids.has(uid)) return;
      checkoutRedirectedUids.add(uid);

      // Hide the drawer and Cal iframe before navigation so the Cal
      // "Your booking has been submitted" screen never flashes.
      showCheckoutHandoff();

      const search = new URLSearchParams({ uid });
      if (name) search.set('name', name);
      if (email) search.set('email', email);

      // Do not await — navigation must start immediately. Init hydrates
      // missing email/time from Cal when the embed omitted them (V2).
      fetch('/api/booking/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calBookingUid: uid,
          name,
          email,
          serviceName,
          bookingTime,
          endTime,
          phone
        }),
        keepalive: true
      }).catch((initErr) => {
        console.warn(
          '[booking] /api/booking/init failed (checkout will still run)',
          initErr
        );
      });

      window.location.replace(`/checkout?${search.toString()}`);
    } catch (err) {
      console.error(
        '[booking] failed to redirect to /checkout after booking success',
        err
      );
    }
  };

  const registerBookingRedirectHandlers = (nsApi, link) => {
    const onSuccess = (event) => redirectToCheckoutAfterBooking(event, link);
    // V2 fires as soon as the booking is created (often before the Cal
    // confirmation UI paints). Legacy event is kept for older embed.js.
    ['bookingSuccessfulV2', 'bookingSuccessful'].forEach((action) => {
      nsApi('on', { action, callback: onSuccess });
    });
  };

  const createCalMount = (link) => {
    if (!drawerContainer) return null;
    const idx = linkIndices.get(link);
    const instanceCount = (instanceCountByLink.get(link) || 0) + 1;
    instanceCountByLink.set(link, instanceCount);

    const mount = document.createElement('div');
    mount.id = `drawer-mount-${idx}-${instanceCount}`;
    mount.className = 'drawer-mount';
    drawerContainer.appendChild(mount);
    mountsByLink.set(link, mount);
    mountCreatedAt.set(link, Date.now());

    if (typeof window.Cal === 'function') {
      const namespace = `service-${idx}-${instanceCount}`;
      window.Cal('init', namespace, { origin: 'https://cal.com' });
      const nsApi = window.Cal.ns && window.Cal.ns[namespace];
      if (nsApi) {
        nsApi('inline', {
          elementOrSelector: `#${mount.id}`,
          calLink: link,
          config: {
            layout: 'month_view',
            'ui.autoscroll': 'false'
          }
        });
        registerDrawerEmbedUi(nsApi);
        registerBookingRedirectHandlers(nsApi, link);
        bindDrawerEmbedFrame(mount);
      }
    }
    return mount;
  };

  const preloadAllCalendars = () => {
    serviceItems.forEach((item, idx) => {
      const link = item.getAttribute('data-cal-link');
      if (!link || mountsByLink.has(link)) return;
      linkIndices.set(link, idx);
      createCalMount(link);
    });
  };

  // Tear down + rebuild a single mount, regardless of why it's gone stale.
  // The Cal namespace is minted fresh each time inside `createCalMount`
  // (instanceCountByLink), so the new iframe never collides with the
  // previous one's registered handlers.
  const rebuildMount = (link) => {
    const oldMount = mountsByLink.get(link);
    if (oldMount) {
      teardownDrawerEmbedFrame(oldMount);
      oldMount.remove();
      mountsByLink.delete(link);
    }
    mountCreatedAt.delete(link);
    staleLinks.delete(link);
    createCalMount(link);
  };

  // Called every time a drawer is about to be shown. Rebuilds the iframe
  // if it's been flagged stale (booking-cascade) OR if it's older than
  // FRESHNESS_MS. The result is that an opened drawer is always either
  // brand-new or freshly-confirmed-within-the-last-minute — Cal.com will
  // still be the final source of truth at submission, but the visitor is
  // overwhelmingly unlikely to *see* a slot that's already been claimed.
  const ensureFreshMount = (link) => {
    const createdAt = mountCreatedAt.get(link);
    const isStale = staleLinks.has(link);
    const isExpired = !createdAt || Date.now() - createdAt > FRESHNESS_MS;
    if (isStale || isExpired) rebuildMount(link);
  };

  // Defer the heavy pre-render until the browser is idle so it doesn't
  // compete with first paint. By the time the user scrolls to the
  // services section, all 9 iframes are fully populated.
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(preloadAllCalendars, { timeout: 1500 });
  } else {
    setTimeout(preloadAllCalendars, 200);
  }

  const showMount = (link) => {
    mountsByLink.forEach((mount, mountLink) => {
      mount.classList.toggle('active', mountLink === link);
    });
  };

  const openDrawer = (link, meta) => {
    if (!drawer || !backdrop || !link) return;

    if (drawerTitleEl) drawerTitleEl.textContent = (meta && meta.name) || '';
    if (drawerSubtitleEl) {
      const parts = [meta && meta.price, meta && meta.duration].filter(Boolean);
      drawerSubtitleEl.textContent = parts.join(' · ');
    }

    // If pre-render hasn't fired yet (very fast clicker), run it now.
    if (!mountsByLink.size) preloadAllCalendars();
    // Hard-rebuild the iframe if its cached availability is too old
    // (>60 s) or has been invalidated by a booking elsewhere. This is
    // the only protection visitors have against seeing a slot that
    // another visitor booked seconds ago; without it, the embed would
    // keep showing it as available and Cal would only reject at
    // confirmation time with a confusing "No available users found".
    ensureFreshMount(link);
    showMount(link);
    drawer.classList.add('drawer-open');
    backdrop.classList.add('drawer-open');
    scrollDrawerToTop();
    const activeMount = mountsByLink.get(link);
    if (activeMount) bindDrawerEmbedFrame(activeMount);
  };

  const closeDrawer = () => {
    if (!drawer || !backdrop) return;
    drawer.classList.remove('drawer-open');
    backdrop.classList.remove('drawer-open');
  };

  const readText = (root, selector) => {
    const el = root.querySelector(selector);
    return el ? el.textContent.trim() : '';
  };

  serviceItems.forEach((item) => {
    item.addEventListener('click', (event) => {
      // The bookable rows are now <a> elements whose href points at the
      // canonical Cal.com URL — that's the no-JS fallback. With JS
      // available we own the booking experience via the in-page drawer,
      // so preventDefault keeps the browser from navigating off to
      // cal.com when the row is clicked.
      event.preventDefault();
      // Suppress Cal.com's auto-popup: because the row carries [data-cal-link],
      // Cal would otherwise open its built-in modal alongside our drawer.
      // Our IIFE attaches this handler first (Cal's embed.js loads async),
      // so stopImmediatePropagation prevents Cal's listener from running.
      event.stopImmediatePropagation();

      openDrawer(item.getAttribute('data-cal-link'), {
        name: readText(item, '.service-name'),
        price: readText(item, '.service-price'),
        duration: readText(item, '.service-duration')
      });
    });
  });

  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  if (closeButton) closeButton.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer && drawer.classList.contains('drawer-open')) {
      closeDrawer();
    }
  });

  // ── PORTFOLIO LIGHTBOX ──
  const portfolioLightbox = document.getElementById('portfolio-lightbox');
  const portfolioLightboxImg = portfolioLightbox
    ? portfolioLightbox.querySelector('img')
    : null;
  const portfolioLightboxClose = portfolioLightbox
    ? portfolioLightbox.querySelector('.portfolio-lightbox-close')
    : null;
  let portfolioScrollLock = '';

  const openPortfolioLightbox = (src, alt) => {
    if (!portfolioLightbox || !portfolioLightboxImg) return;
    portfolioLightboxImg.src = src;
    portfolioLightboxImg.alt = alt || '';
    portfolioLightbox.hidden = false;
    portfolioLightbox.classList.add('is-open');
    portfolioScrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  };

  const closePortfolioLightbox = () => {
    if (!portfolioLightbox || !portfolioLightboxImg) return;
    portfolioLightbox.classList.remove('is-open');
    portfolioLightbox.hidden = true;
    portfolioLightboxImg.src = '';
    portfolioLightboxImg.alt = '';
    document.body.style.overflow = portfolioScrollLock;
  };

  document.querySelectorAll('#portfolio .p-item img').forEach((img) => {
    img.addEventListener('click', () => {
      openPortfolioLightbox(img.currentSrc || img.src, img.alt);
    });
  });

  if (portfolioLightbox) {
    portfolioLightbox.addEventListener('click', (event) => {
      if (event.target === portfolioLightbox) closePortfolioLightbox();
    });
  }
  if (portfolioLightboxClose) {
    portfolioLightboxClose.addEventListener('click', closePortfolioLightbox);
  }
  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      portfolioLightbox &&
      portfolioLightbox.classList.contains('is-open')
    ) {
      closePortfolioLightbox();
    }
  });
})();
