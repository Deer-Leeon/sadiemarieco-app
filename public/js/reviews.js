/* ==========================================================================
   Sadie Marie — Google Reviews carousel (vanilla)
   ========================================================================== */

(function () {
  'use strict';

  const DESKTOP_VISIBLE = 3;
  const MOBILE_VISIBLE = 1;
  const MOBILE_MAX_PX = 860;
  const GAP_PX = 24;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderStars() {
    return '<span class="reviews-card__stars" aria-label="5 out of 5 stars">★★★★★</span>';
  }

  function formatReviewDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function renderCard(review) {
    const rawName = review.author_name || 'Guest';
    const name = escapeHtml(rawName);
    const text = escapeHtml(review.text || '');
    const initial = escapeHtml(rawName.trim().charAt(0).toUpperCase() || '?');
    const reviewDate = escapeHtml(formatReviewDate(review.review_time));
    const dateHtml = reviewDate
      ? `<time class="reviews-card__date" datetime="${escapeHtml(review.review_time || '')}">${reviewDate}</time>`
      : '';

    const avatar = review.profile_photo_url
      ? `<img class="reviews-card__avatar" src="${escapeHtml(review.profile_photo_url)}" alt="" width="46" height="46" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : `<div class="reviews-card__avatar reviews-card__avatar--initial" aria-hidden="true">${initial}</div>`;

    return `
      <article class="reviews-card">
        <div class="reviews-card__head">
          ${avatar}
          <p class="reviews-card__name">${name}</p>
        </div>
        <div class="reviews-card__meta">
          ${renderStars()}
          ${dateHtml}
        </div>
        <p class="reviews-card__quote">&ldquo;${text}&rdquo;</p>
        <p class="reviews-card__verified">Verified Google Review</p>
      </article>`;
  }

  function visibleCount() {
    return window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`).matches
      ? MOBILE_VISIBLE
      : DESKTOP_VISIBLE;
  }

  async function initReviewsCarousel() {
    const root = document.getElementById('reviews-carousel-root');
    if (!root) return;

    let payload;
    try {
      const res = await fetch('/api/reviews');
      if (!res.ok) return;
      payload = await res.json();
    } catch {
      return;
    }

    const reviews = payload && Array.isArray(payload.reviews) ? payload.reviews : [];
    if (reviews.length === 0) return;

    root.innerHTML = `
      <section class="reviews-section" aria-label="Client reviews">
        <header class="reviews-section__header">
          <span class="section-label">Kind Words</span>
          <h2 class="section-title">Client <em>Love</em></h2>
        </header>
        <div class="reviews-carousel">
          <button
            type="button"
            class="reviews-carousel__nav reviews-carousel__nav--prev"
            aria-label="Previous review"
            disabled
          >&lsaquo;</button>
          <div class="reviews-carousel__viewport">
            <div class="reviews-carousel__track">
              ${reviews.map(renderCard).join('')}
            </div>
          </div>
          <button
            type="button"
            class="reviews-carousel__nav reviews-carousel__nav--next"
            aria-label="Next review"
            hidden
          >&rsaquo;</button>
        </div>
      </section>`;

    const viewport = root.querySelector('.reviews-carousel__viewport');
    const track = root.querySelector('.reviews-carousel__track');
    const prevBtn = root.querySelector('.reviews-carousel__nav--prev');
    const nextBtn = root.querySelector('.reviews-carousel__nav--next');
    const cards = track.querySelectorAll('.reviews-card');

    cards.forEach((card) => {
      const img = card.querySelector('img.reviews-card__avatar');
      if (!img) return;

      img.addEventListener('error', () => {
        const name = card.querySelector('.reviews-card__name')?.textContent?.trim() || 'Guest';
        const letter = name.charAt(0).toUpperCase() || '?';
        const fallback = document.createElement('div');
        fallback.className = 'reviews-card__avatar reviews-card__avatar--initial';
        fallback.setAttribute('aria-hidden', 'true');
        fallback.textContent = letter;
        img.replaceWith(fallback);
      }, { once: true });
    });

    let offset = 0;

    function maxOffset() {
      return Math.max(0, reviews.length - visibleCount());
    }

    function cardStepPx() {
      const card = cards[0];
      if (!card) return 0;
      return card.offsetWidth + GAP_PX;
    }

    function layoutCards() {
      const visible = visibleCount();
      const innerWidth = viewport.clientWidth;
      const cardWidth = (innerWidth - GAP_PX * (visible - 1)) / visible;

      cards.forEach((card) => {
        card.style.width = `${cardWidth}px`;
        card.style.flexBasis = `${cardWidth}px`;
      });

      if (offset > maxOffset()) {
        offset = maxOffset();
      }
      applyTransform();
      updateNav();
    }

    function applyTransform() {
      track.style.transform = `translateX(${-offset * cardStepPx()}px)`;
    }

    function updateNav() {
      const visible = visibleCount();
      const showArrows =
        window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`).matches
          ? reviews.length > MOBILE_VISIBLE
          : reviews.length > DESKTOP_VISIBLE;

      nextBtn.hidden = !showArrows;
      prevBtn.disabled = offset <= 0;
      nextBtn.disabled = offset >= maxOffset();

      if (!showArrows) {
        prevBtn.disabled = true;
      }
    }

    prevBtn.addEventListener('click', () => {
      if (offset <= 0) return;
      offset -= 1;
      applyTransform();
      updateNav();
    });

    nextBtn.addEventListener('click', () => {
      if (offset >= maxOffset()) return;
      offset += 1;
      applyTransform();
      updateNav();
    });

    window.addEventListener('resize', layoutCards);
    layoutCards();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReviewsCarousel);
  } else {
    initReviewsCarousel();
  }
})();
