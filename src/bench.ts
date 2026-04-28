// Deterministic camera trajectory for perf benchmarking. Triggered by
// ?bench=1. Runs after initial tile stream settles, drives the camera
// through a fixed path (rotate / zoom / tilt / all-at-once), and
// toggles the stats sampler around it. On completion the summary
// lands in window.__benchResults for external scrapers to read.

import {
  updateCamera, setOrbitRadius, setOrbitPhi, setOrbitTheta,
  orbitRadius, orbitPhi, orbitTheta,
} from "./scene.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { statsToggleSampling, getLastSampleSummary } from "./debug.ts";
import { getGpuPhases, resetGpuPhases, isGpuTimerEnabled, drainGpuQueries } from "./gpuTimer.ts";

const DURATION_MS = 15_000;
const SETTLE_MS = 2000;

type BenchResult = {
  frames: number;
  seconds: number;
  fps_avg: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
};

declare global {
  interface Window {
    __benchDone?: boolean;
    __benchResults?: BenchResult;
    __gpuPhases?: Record<string, { per_frame_ms: number; total_ms: number; calls: number }>;
    __gpuTimerEnabled?: boolean;
  }
}

export function runBench(): void {
  setTimeout(() => {
    const start = performance.now();
    const baseTheta = orbitTheta;
    const basePhi = orbitPhi;
    const baseRadius = orbitRadius;

    statsToggleSampling();
    resetGpuPhases();

    function tick() {
      const t = (performance.now() - start) / DURATION_MS;
      if (t >= 1) {
        statsToggleSampling();
        // Drain a few times to give in-flight queries a chance to
        // resolve before snapshotting. Each drain runs after a frame
        // boundary so the GPU has had time to finish.
        drainGpuQueries();
        const summary = getLastSampleSummary();
        if (summary) window.__benchResults = summary;
        window.__gpuPhases = getGpuPhases();
        window.__gpuTimerEnabled = isGpuTimerEnabled();
        window.__benchDone = true;
        return;
      }
      // Four-phase loop that exercises different hot paths:
      //   0.00-0.25  spin theta (stars re-project, labels re-cluster)
      //   0.25-0.50  zoom in then back out (tile streaming + disc growth)
      //   0.50-0.75  tilt phi (view angle changes, labels re-collide)
      //   0.75-1.00  all three at once (worst-case mixed load)
      if (t < 0.25) {
        setOrbitTheta(baseTheta + (t / 0.25) * Math.PI * 2);
      } else if (t < 0.5) {
        const zt = (t - 0.25) / 0.25;
        const factor = zt < 0.5 ? 1 - zt * 1.6 : 0.2 + (zt - 0.5) * 1.6;
        setOrbitRadius(baseRadius * factor);
      } else if (t < 0.75) {
        const pt = (t - 0.5) / 0.25;
        setOrbitPhi(basePhi + (pt * 2 - 1) * 0.5);
      } else {
        const st = (t - 0.75) / 0.25;
        setOrbitTheta(baseTheta + st * Math.PI);
        setOrbitRadius(baseRadius * (1 - st * 0.3));
        setOrbitPhi(basePhi + Math.sin(st * Math.PI) * 0.3);
      }
      updateCamera();
      setLabelsDirty(true);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, SETTLE_MS);
}
