// Click-vs-drag toggle: tiny accidental drags over selectable text would
// otherwise create a selection that blocks a plain click handler.
export function makeCollapsible(el: HTMLElement, threshold = 4) {
  let downX = 0, downY = 0;
  el.addEventListener("mousedown", (e) => { downX = e.clientX; downY = e.clientY; });
  el.addEventListener("mouseup", (e) => {
    if (Math.abs(e.clientX - downX) < threshold && Math.abs(e.clientY - downY) < threshold) {
      el.classList.toggle("collapsed");
    }
  });
}
