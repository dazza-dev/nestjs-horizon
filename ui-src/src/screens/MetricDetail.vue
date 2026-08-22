<template>
  <div v-for="chart in charts" :key="chart.metric" class="hz-card mb-4">
    <div class="hz-card-header">{{ chart.title }} - {{ name }}</div>
    <div class="hz-chart-body">
      <div v-if="enoughData" style="height: 240px">
        <SnapshotChart :points="snapshots" :metric="chart.metric" />
      </div>
      <div v-else class="hz-not-enough">Not Enough Data</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { action, api, type SnapshotPoint } from '../api';
import SnapshotChart from '../components/SnapshotChart.vue';

const route = useRoute();
const snapshots = ref<SnapshotPoint[]>([]);

const kind = computed(() => (route.params.kind === 'queues' ? 'queues' : 'jobs'));
const name = computed(() => String(route.params.name ?? ''));

// A single point still charts; only an empty series says nothing.
const enoughData = computed(() => snapshots.value.length > 0);

const charts = [
  { title: 'Throughput', metric: 'throughput' as const },
  { title: 'Runtime (ms)', metric: 'runtime' as const },
];

const load = action(async () => {
  const detail = await api.get<{ snapshots: SnapshotPoint[] }>(
    `/metrics/${kind.value}/${encodeURIComponent(name.value)}`,
  );

  snapshots.value = detail.snapshots;
});

watch([kind, name], () => void load(), { immediate: true });
</script>
