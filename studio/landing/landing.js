const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const header = document.querySelector('[data-header]');
const menu = document.querySelector('[data-menu]');
const nav = document.querySelector('[data-nav]');

function closeMenu() {
  menu?.classList.remove('open');
  nav?.classList.remove('open');
  menu?.setAttribute('aria-expanded', 'false');
}

menu?.addEventListener('click', () => {
  const open = !nav.classList.contains('open');
  menu.classList.toggle('open', open);
  nav.classList.toggle('open', open);
  menu.setAttribute('aria-expanded', String(open));
});

nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
addEventListener('scroll', () => header?.classList.toggle('scrolled', scrollY > 24), { passive: true });

const reveals = [...document.querySelectorAll('.reveal')];
if (reduceMotion || !('IntersectionObserver' in window)) {
  reveals.forEach((element) => element.classList.add('visible'));
} else {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  reveals.forEach((element, index) => {
    element.style.transitionDelay = `${Math.min((index % 4) * 60, 180)}ms`;
    observer.observe(element);
  });
}

document.querySelectorAll('[data-stem]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-stem]').forEach((stem) => {
      const active = stem === button;
      stem.classList.toggle('active', active);
      stem.setAttribute('aria-pressed', String(active));
    });
  });
});

if (!reduceMotion && matchMedia('(hover: hover)').matches) {
  document.querySelectorAll('[data-tilt]').forEach((card) => {
    card.addEventListener('pointermove', (event) => {
      const box = card.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      card.style.transform = `perspective(900px) rotateX(${-y * 2.8}deg) rotateY(${x * 3.6}deg) translateY(-3px)`;
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  });
}

let heroScene;
const canvas = document.querySelector('#hero-canvas');
const heroVisual = document.querySelector('[data-hero-visual]');
const heroVisibilityObserver = heroVisual && 'IntersectionObserver' in window
  ? new IntersectionObserver(([entry]) => {
    // Chromium can retain a scrolled-off WebGL compositor layer over fixed UI.
    // Removing it from paint outside the hero prevents header corruption and
    // avoids spending GPU time on an invisible scene.
    heroVisual.style.visibility = entry.isIntersecting ? 'visible' : 'hidden';
  }, { threshold: 0.01 })
  : null;

heroVisibilityObserver?.observe(heroVisual);
if (canvas && !reduceMotion) {
  import('/landing/hero-scene.js')
    .then(({ mountHeroScene }) => mountHeroScene(canvas))
    .then((scene) => {
      if (!scene) return;
      heroScene = scene;
      document.documentElement.classList.add('three-ready');
    })
    .catch(() => {
      // The static SVG is the intentional offline and no-WebGL experience.
    });
}

addEventListener('pagehide', () => {
  heroVisibilityObserver?.disconnect();
  heroScene?.destroy();
}, { once: true });
