const steps = Array.from(document.querySelectorAll('.step'));
const dots = Array.from(document.querySelectorAll('.dot'));
const prevBtn = document.querySelector('.prev-arrow');
const nextBtn = document.querySelector('.next-arrow');
const track = document.querySelector('.steps-track');

let current = 0;
let touchStartX = 0;
let animating = false;

function goTo(index, direction) {
  if (animating || index === current) return;
  animating = true;

  const incoming = steps[index];
  const outgoing = steps[current];

  incoming.style.transform = direction > 0 ? 'translateX(60px)' : 'translateX(-60px)';
  incoming.style.opacity = '0';
  incoming.style.transition = 'none';
  incoming.classList.add('active');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      incoming.style.transition = '';
      incoming.style.transform = 'translateX(0)';
      incoming.style.opacity = '1';

      outgoing.style.transform = direction > 0 ? 'translateX(-60px)' : 'translateX(60px)';
      outgoing.style.opacity = '0';

      dots[current].classList.remove('active');
      dots[index].classList.add('active');
      current = index;

      setTimeout(() => {
        outgoing.classList.remove('active');
        outgoing.style.transform = '';
        outgoing.style.opacity = '';
        outgoing.style.transition = '';
        animating = false;
      }, 350);
    });
  });
}

prevBtn.addEventListener('click', () => goTo((current - 1 + steps.length) % steps.length, -1));
nextBtn.addEventListener('click', () => goTo((current + 1) % steps.length, 1));
dots.forEach((dot, i) => dot.addEventListener('click', () => goTo(i, i > current ? 1 : -1)));

track.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
track.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 40) goTo(dx < 0 ? (current + 1) % steps.length : (current - 1 + steps.length) % steps.length, dx < 0 ? 1 : -1);
});
