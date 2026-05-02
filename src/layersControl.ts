import { registerPanel, setOpenPanel, closePanel } from "./panelManager.ts";

export interface LayerSpec {
  id: string;
  isOn: () => boolean;
  toggle: () => void;
}

export function setupLayersControl(layers: LayerSpec[], onChange: () => void): void {
  const container = document.getElementById("layers-control");
  const btn = document.getElementById("layers-btn");
  if (!container || !btn) return;

  const elByLayer = new Map<string, HTMLElement>();
  for (const l of layers) {
    const el = container.querySelector<HTMLElement>(`[data-layer="${l.id}"]`);
    if (el) elByLayer.set(l.id, el);
  }

  function reflect() {
    for (const l of layers) {
      elByLayer.get(l.id)?.classList.toggle("active", l.isOn());
    }
  }
  reflect();

  registerPanel("layers", () => container.classList.add("collapsed"));

  btn.addEventListener("pointerup", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (container.classList.contains("collapsed")) {
      container.classList.remove("collapsed");
      setOpenPanel("layers");
    } else {
      closePanel("layers");
    }
  });

  for (const [id, el] of elByLayer) {
    const layer = layers.find((l) => l.id === id)!;
    el.addEventListener("pointerup", (e) => {
      e.preventDefault();
      e.stopPropagation();
      layer.toggle();
      reflect();
      onChange();
    });
  }
}
