/** The logo lab: every animation control, no server. Also a fake 120 BPM clock to see the beat lock. */
import { mountLogo, BRAND_RED, type Logo } from '@lib/logo';

const control = <T extends HTMLElement = HTMLElement>(name: string) => document.querySelector<T>(`[data-control="${name}"]`)!;
const input = (name: string) => control<HTMLInputElement>(name);
const button = (name: string) => control<HTMLButtonElement>(name);

const logo: Logo = mountLogo(document.querySelector<HTMLElement>('[data-logo]')!);
declare global { interface Window { logo: Logo } }
window.logo = logo;

let twoTone = false, animating = false, random = false;
button('mode').addEventListener('click', () => logo.toggleMode());
button('guides').addEventListener('click', () => logo.showGuides(!logo.svg.classList.contains('show-guides')));
button('colours').addEventListener('click', () => { twoTone = !twoTone; logo.setColors(BRAND_RED, twoTone ? '#4cc9f0' : BRAND_RED); logo.recolor(); });
button('anim').addEventListener('click', () => { animating = !animating; logo.setAnimating(animating); button('anim').textContent = animating ? 'Animation: on' : 'Animation: off'; });
input('speed').addEventListener('input', (e) => logo.setSpeed(+(e.target as HTMLInputElement).value));
input('dash').addEventListener('input', (e) => logo.setDash(+(e.target as HTMLInputElement).value));
button('random').addEventListener('click', () => { random = !random; logo.setRandom(random); button('random').textContent = random ? 'Random: on' : 'Random: off'; });
input('radius').addEventListener('input', (e) => logo.setRadius(+(e.target as HTMLInputElement).value));
button('pulse').addEventListener('click', () => logo.pulse(1));
button('flash').addEventListener('click', () => logo.flash(1));
button('levels').addEventListener('click', () => logo.setLevels(Array.from({ length: 8 }, Math.random)));
button('reset').addEventListener('click', () => { logo.reset(); logo.clearLevels(); });

// fake 120 BPM clock so the beat lock can be seen without music
let beatTimer: ReturnType<typeof setInterval> | null = null;
button('beat').addEventListener('click', () => {
  if (beatTimer) {
    clearInterval(beatTimer); beatTimer = null;
    logo.clearBeatClock(); logo.showBeatMarkers(false);
    button('beat').textContent = 'Beat 120: off';
    return;
  }
  const period = 0.5;
  let next = performance.now() + 500;
  const tickBeat = () => { logo.setBeatClock({ period, nextBeatAt: next }); next += period * 1000; };
  tickBeat();
  beatTimer = setInterval(tickBeat, period * 1000);
  logo.showBeatMarkers(true);
  if (!animating) button('anim').click();
  button('beat').textContent = 'Beat 120: on';
});
