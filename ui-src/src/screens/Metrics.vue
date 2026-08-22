<template>
  <div class="hz-card">
    <div class="hz-card-header">Metrics</div>

    <nav class="hz-tabs">
      <RouterLink to="/metrics/jobs" class="hz-tab">Jobs</RouterLink>
      <RouterLink to="/metrics/queues" class="hz-tab">Queues</RouterLink>
    </nav>

    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">{{ kind === 'jobs' ? 'Job' : 'Queue' }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.name">
          <td class="ps-3">
            <RouterLink
              :to="`/metrics/${kind}/${encodeURIComponent(row.name)}`"
              class="hz-link"
            >
              {{ row.name }}
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!rows.length" class="hz-empty">Nothing measured yet.</div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { action, api, type Measurement } from '../api';

const route = useRoute();
const rows = ref<Measurement[]>([]);

const kind = computed(() => (route.params.kind === 'queues' ? 'queues' : 'jobs'));

const load = action(async () => {
  rows.value = await api.get<Measurement[]>(`/metrics/${kind.value}`);
});

watch(kind, () => void load(), { immediate: true });
</script>
