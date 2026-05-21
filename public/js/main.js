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
  // Services where the user just completed a booking. Their iframe is now
  // parked on Cal's confirmation screen; we tear it down and replace it on
  // next open so the user sees a fresh calendar instead of the receipt.
  const bookedLinks = new Set();

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
            bookedLinks.add(link);
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

  const resetMountIfBooked = (link) => {
    if (!bookedLinks.has(link)) return;
    bookedLinks.delete(link);
    const oldMount = mountsByLink.get(link);
    if (oldMount) {
      oldMount.remove();
      mountsByLink.delete(link);
    }
    createCalMount(link);
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
    // If the user already completed a booking on this service, the iframe
    // is still parked on Cal's confirmation screen. Swap it for a fresh
    // embed so reopening starts a brand-new booking flow.
    resetMountIfBooked(link);
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
