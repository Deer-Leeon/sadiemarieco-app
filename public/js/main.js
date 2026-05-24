/* ==========================================================================
   Sadie Marie — Luxury Beauty Studio
   Main JavaScript: nav scroll behavior, scroll-reveal animations,
   FAQ accordion, services accordion with lazy-loaded Cal.com widgets
   ========================================================================== */

(function () {
  'use strict';

  // ── NAVBAR SCROLL ──
  const navbar = document.getElementById('navbar');
  if (navbar) {
    const handleScroll = () => {
      navbar.classList.toggle('scrolled', window.scrollY > 60);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
  }

  // ── SCROLL REVEAL ──
  const reveals = document.querySelectorAll('.reveal');
  if (reveals.length && 'IntersectionObserver' in window) {
    const revealObs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    reveals.forEach((el) => revealObs.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('visible'));
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
          config: { layout: 'month_view' }
        });
        nsApi('ui', window.calUiConfig || { layout: 'month_view' });
        nsApi('on', {
          action: 'bookingSuccessful',
          callback: () => {
            // The just-booked iframe is parked on the confirmation
            // screen; reopening should restart fresh.
            staleLinks.add(link);
            // ALL other pre-rendered iframes are now showing at-least-
            // one stale slot — the one McKenna just got booked into.
            // Marking them stale (rather than rebuilding eagerly) keeps
            // this cheap: the next time the visitor opens a different
            // service, `ensureFreshMount` will rebuild it on demand.
            mountsByLink.forEach((_, otherLink) => {
              if (otherLink !== link) staleLinks.add(otherLink);
            });
          }
        });
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
})();
