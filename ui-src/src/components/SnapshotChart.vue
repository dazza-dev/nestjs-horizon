<template>
  <canvas
    ref="canvas"
    height="90"
    role="img"
    :aria-label="`${metric === 'runtime' ? 'Runtime' : 'Throughput'} over the last ${points.length} snapshots`"
  ></canvas>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Chart, type ChartConfiguration, registerables } from 'chart.js';
import type { SnapshotPoint } from '../api';

Chart.register(...registerables);

const props = defineProps<{
  points: SnapshotPoint[];
  metric: 'throughput' | 'runtime';
}>();
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | undefined;
let observer: MutationObserver | undefined;

/** Chart colours come from the theme tokens rather than being pinned here. */
const token = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const accent = (alpha?: number): string => {
  const value = token('--hz-accent', '#f1455f');

  return alpha === undefined
    ? value
    : `color-mix(in srgb, ${value} ${alpha * 100}%, transparent)`;
};

const config = (): ChartConfiguration => ({
  type: 'line',
  data: {
    labels: props.points.map((p) => new Date(p.time).toLocaleTimeString()),
    datasets: [
      {
        data: props.points.map((p) => p[props.metric]),
        borderColor: accent(),
        backgroundColor: accent(0.12),
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointRadius: 2,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    // Chart.js defaults to near-black text and gridlines, which vanish on the dark surface.
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          maxTicksLimit: 6,
          font: { size: 10 },
          color: token('--hz-muted', '#6b7280'),
        },
      },
      y: {
        beginAtZero: true,
        grid: { color: token('--hz-border', '#e5e7eb') },
        ticks: {
          precision: 0,
          font: { size: 10 },
          color: token('--hz-muted', '#6b7280'),
        },
      },
    },
  },
});

const draw = () => {
  if (!canvas.value) {
    return;
  }

  chart?.destroy();
  chart = new Chart(canvas.value, config());
};

onMounted(() => {
  draw();
  // The canvas is painted, not styled: a theme switch needs a full redraw.
  observer = new MutationObserver(draw);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-bs-theme'],
  });
});

watch([() => props.points, () => props.metric], draw, { deep: true });

onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.destroy();
});
</script>
