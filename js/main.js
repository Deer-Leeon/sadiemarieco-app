/* ==========================================================================
   Sadie Marie — Luxury Beauty Studio
   Main JavaScript: nav scroll behavior, scroll-reveal animations, FAQ accordion
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
    // Fallback: reveal everything immediately if IntersectionObserver is unsupported
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
})();
