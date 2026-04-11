import { describe, it, expect, beforeEach } from "bun:test";

// Test against a fresh registry instance each time. We can't easily
// reset the module-level singleton, so we replicate the registry logic
// as a factory — the production code uses the same algorithm.

interface LabelTypeHandler {
  readonly type: string;
  setVisible(visible: boolean): void;
  update(): void;
  selectByName(name: string): boolean;
  clearSelection(): void;
  handleClick(div: { getAttribute(name: string): string | null }): boolean;
  detailHtml(): string | null;
}

function createRegistry() {
  const handlers: LabelTypeHandler[] = [];

  return {
    register(h: LabelTypeHandler) { handlers.push(h); },
    setAllVisible(v: boolean) { for (const h of handlers) h.setVisible(v); },
    updateAll() { for (const h of handlers) h.update(); },
    clearAll(except?: string) {
      for (const h of handlers) if (h.type !== except) h.clearSelection();
    },
    dispatchClick(target: { closest(sel: string): { getAttribute(n: string): string | null } | null }): boolean {
      const div = target.closest("[data-label-type]");
      if (!div) return false;
      const type = div.getAttribute("data-label-type")!;
      const handler = handlers.find((h) => h.type === type);
      if (!handler) return false;
      this.clearAll(type);
      return handler.handleClick(div);
    },
    selectByType(type: string, name: string): boolean {
      const h = handlers.find((x) => x.type === type);
      return h ? h.selectByName(name) : false;
    },
    getActiveDetail(): string | null {
      for (const h of handlers) {
        const html = h.detailHtml();
        if (html) return html;
      }
      return null;
    },
  };
}

function mockHandler(type: string) {
  return {
    type,
    visible: true,
    updated: 0,
    selected: null as string | null,
    cleared: 0,
    clicked: null as string | null,

    setVisible(v: boolean) { this.visible = v; },
    update() { this.updated++; },
    selectByName(name: string) { this.selected = name; return true; },
    clearSelection() { this.selected = null; this.cleared++; },
    handleClick(div: any) {
      const name = div.getAttribute("data-label-name");
      if (!name) return false;
      this.selected = name;
      return true;
    },
    detailHtml() { return this.selected ? `<div>${this.selected}</div>` : null; },
  };
}

describe("label registry", () => {
  let reg: ReturnType<typeof createRegistry>;
  let nebula: ReturnType<typeof mockHandler>;
  let star: ReturnType<typeof mockHandler>;

  beforeEach(() => {
    reg = createRegistry();
    nebula = mockHandler("nebula");
    star = mockHandler("star");
    reg.register(nebula);
    reg.register(star);
  });

  describe("setAllVisible", () => {
    it("toggles all handlers", () => {
      reg.setAllVisible(false);
      expect(nebula.visible).toBe(false);
      expect(star.visible).toBe(false);
    });

    it("toggles back to visible", () => {
      reg.setAllVisible(false);
      reg.setAllVisible(true);
      expect(nebula.visible).toBe(true);
      expect(star.visible).toBe(true);
    });
  });

  describe("updateAll", () => {
    it("calls update on every handler", () => {
      reg.updateAll();
      reg.updateAll();
      expect(nebula.updated).toBe(2);
      expect(star.updated).toBe(2);
    });
  });

  describe("clearAll", () => {
    it("clears all handlers", () => {
      nebula.selected = "Orion";
      star.selected = "Vega";
      reg.clearAll();
      expect(nebula.selected).toBeNull();
      expect(star.selected).toBeNull();
    });

    it("clears all except the specified type", () => {
      nebula.selected = "Orion";
      star.selected = "Vega";
      reg.clearAll("nebula");
      expect(nebula.selected).toBe("Orion"); // preserved
      expect(star.selected).toBeNull();       // cleared
    });
  });

  describe("dispatchClick", () => {
    it("dispatches to the correct handler by data-label-type", () => {
      const div = {
        closest: (sel: string) => sel === "[data-label-type]" ? {
          getAttribute: (n: string) => n === "data-label-type" ? "nebula" : n === "data-label-name" ? "Taurus" : null,
        } : null,
      };
      const handled = reg.dispatchClick(div);
      expect(handled).toBe(true);
      expect(nebula.selected).toBe("Taurus");
    });

    it("clears other types when dispatching", () => {
      star.selected = "Vega";
      const div = {
        closest: (sel: string) => sel === "[data-label-type]" ? {
          getAttribute: (n: string) => n === "data-label-type" ? "nebula" : n === "data-label-name" ? "Orion" : null,
        } : null,
      };
      reg.dispatchClick(div);
      expect(star.selected).toBeNull(); // cleared
      expect(nebula.selected).toBe("Orion");
    });

    it("returns false for elements without data-label-type", () => {
      const div = { closest: () => null };
      expect(reg.dispatchClick(div)).toBe(false);
    });

    it("returns false for unknown type", () => {
      const div = {
        closest: (sel: string) => sel === "[data-label-type]" ? {
          getAttribute: (n: string) => n === "data-label-type" ? "blackhole" : null,
        } : null,
      };
      expect(reg.dispatchClick(div)).toBe(false);
    });
  });

  describe("selectByType", () => {
    it("selects the right handler", () => {
      reg.selectByType("nebula", "Coal Sack");
      expect(nebula.selected).toBe("Coal Sack");
      expect(star.selected).toBeNull();
    });

    it("returns false for unknown type", () => {
      expect(reg.selectByType("blackhole", "Cyg X-1")).toBe(false);
    });
  });

  describe("getActiveDetail", () => {
    it("returns null when nothing is selected", () => {
      expect(reg.getActiveDetail()).toBeNull();
    });

    it("returns detail from the handler with an active selection", () => {
      nebula.selected = "Orion";
      expect(reg.getActiveDetail()).toBe("<div>Orion</div>");
    });

    it("returns the first active handler's detail (registration order)", () => {
      nebula.selected = "Orion";
      star.selected = "Vega";
      // nebula registered first, so it wins
      expect(reg.getActiveDetail()).toBe("<div>Orion</div>");
    });
  });

  describe("cross-type selection clearing", () => {
    it("selecting a nebula clears star selection", () => {
      star.selected = "Sirius";
      reg.clearAll("nebula");
      nebula.selected = "Taurus";
      expect(star.selected).toBeNull();
      expect(nebula.selected).toBe("Taurus");
    });

    it("selecting a star clears nebula selection", () => {
      nebula.selected = "Orion";
      reg.clearAll("star");
      star.selected = "Vega";
      expect(nebula.selected).toBeNull();
      expect(star.selected).toBe("Vega");
    });
  });
});
