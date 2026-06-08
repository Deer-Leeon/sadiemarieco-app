/**
 * Hold the homepage invisible until the hero photo AND webfonts are ready,
 * then reveal everything in one shot (no FOUT / progressive JPEG flash).
 */
(function () {
  'use strict';

  var MAX_WAIT_MS = 10000;
  var done = false;

  function reveal() {
    if (done) return;
    done = true;
    document.documentElement.classList.add('hero-ready');
  }

  function waitForHeroImage(img) {
    return new Promise(function (resolve) {
      if (!img) {
        resolve();
        return;
      }
      function finish() {
        if (img.naturalWidth > 0 && typeof img.decode === 'function') {
          img.decode().then(resolve).catch(resolve);
        } else {
          resolve();
        }
      }
      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', resolve, { once: true });
      if (img.complete) finish();
    });
  }

  function waitForFonts() {
    if (!document.fonts || !document.fonts.ready) {
      return Promise.resolve();
    }
    return document.fonts.ready;
  }

  var img = document.querySelector('.hero-img-col img');
  Promise.all([waitForHeroImage(img), waitForFonts()])
    .then(reveal)
    .catch(reveal);
  setTimeout(reveal, MAX_WAIT_MS);
})();
