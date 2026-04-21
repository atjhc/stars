import { describe, it, expect } from "bun:test";
import { parseUrlState, serializeUrlState, type UrlState } from "./urlState.ts";

describe("serializeUrlState", () => {
  it("emits orbit params with 2-decimal precision", () => {
    const q = serializeUrlState({
      orbit: { radius: 12.345, phi: 1.567, theta: 0.489 },
    });
    expect(q.get("r")).toBe("12.35");
    expect(q.get("phi")).toBe("1.57");
    expect(q.get("theta")).toBe("0.49");
  });

  it("includes focus when provided", () => {
    const q = serializeUrlState({
      orbit: { radius: 1, phi: 1, theta: 0 },
      focus: "Ptolemy Cluster",
    });
    expect(q.get("focus")).toBe("Ptolemy Cluster");
  });

  it("omits focus when absent", () => {
    const q = serializeUrlState({
      orbit: { radius: 1, phi: 1, theta: 0 },
    });
    expect(q.has("focus")).toBe(false);
  });

  it("preserves unrelated params in the base query", () => {
    const base = new URLSearchParams("debug=1&other=x");
    const q = serializeUrlState({
      orbit: { radius: 1, phi: 1, theta: 0 },
    }, base);
    expect(q.get("debug")).toBe("1");
    expect(q.get("other")).toBe("x");
    expect(q.get("r")).toBe("1");
  });

  it("emits mag when it differs from the default", () => {
    const q = serializeUrlState({ mag: 8.25 });
    expect(q.get("mag")).toBe("8.25");
  });

  it("omits mag when it equals the default", () => {
    const q = serializeUrlState({ mag: 7.5 });
    expect(q.has("mag")).toBe(false);
  });

  it("strips a stale mag from the base when value is default", () => {
    const base = new URLSearchParams("mag=8.25");
    const q = serializeUrlState({ mag: 7.5 }, base);
    expect(q.has("mag")).toBe(false);
  });
});

describe("parseUrlState", () => {
  it("round-trips serialize → parse", () => {
    const s: UrlState = {
      orbit: { radius: 12.35, phi: 1.57, theta: 0.49 },
      focus: "Sirius",
    };
    const parsed = parseUrlState(serializeUrlState(s).toString());
    expect(parsed).toEqual(s);
  });

  it("returns empty state when no known params present", () => {
    expect(parseUrlState("foo=bar")).toEqual({});
  });

  it("parses focus alone without camera", () => {
    expect(parseUrlState("focus=Vega")).toEqual({ focus: "Vega" });
  });

  it("returns empty orbit if any component is missing", () => {
    const result = parseUrlState("r=10&phi=1");
    expect(result.orbit).toBeUndefined();
  });

  it("returns empty orbit if any component is non-numeric", () => {
    const result = parseUrlState("r=foo&phi=1&theta=0");
    expect(result.orbit).toBeUndefined();
  });

  it("decodes URL-encoded focus names with spaces", () => {
    expect(parseUrlState("focus=Ptolemy%20Cluster").focus).toBe("Ptolemy Cluster");
    expect(parseUrlState("focus=Ptolemy+Cluster").focus).toBe("Ptolemy Cluster");
  });

  it("parses mag as a finite float", () => {
    expect(parseUrlState("mag=8.25").mag).toBe(8.25);
  });

  it("ignores non-numeric mag", () => {
    expect(parseUrlState("mag=bright").mag).toBeUndefined();
  });

  it("round-trips mag via serialize → parse", () => {
    const s: UrlState = { mag: 5.75 };
    expect(parseUrlState(serializeUrlState(s).toString())).toEqual(s);
  });
});
