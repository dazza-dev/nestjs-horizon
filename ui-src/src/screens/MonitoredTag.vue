<template>
  <div class="hz-card">
    <div class="hz-card-header d-flex justify-content-between align-items-center">
      <span>Recent Jobs for "{{ tag }}"</span>
      <RouterLink to="/monitoring" class="hz-link">Back to monitoring</RouterLink>
    </div>

    <nav class="hz-tabs">
      <RouterLink
        :to="{ query: {} }"
        replace
        class="hz-tab"
        :class="{ 'hz-tab-on': type === 'jobs' }"
        :aria-current="type === 'jobs' ? 'page' : undefined"
      >
        Recent Jobs
      </RouterLink>
      <RouterLink
        :to="{ query: { type: 'failed' } }"
        replace
        class="hz-tab"
        :class="{ 'hz-tab-on': type === 'failed' }"
        :aria-current="type === 'failed' ? 'page' : undefined"
      >
        Failed Jobs
      </RouterLink>
    </nav>

    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">Job</th>
          <th>State</th>
          <th class="text-end">Queued</th>
          <th class="text-end">Finished</th>
          <th class="text-end pe-3">Runtime</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="`${job.queue}-${job.id}`">
          <td class="ps-3">
            <RouterLink :to="`/jobs/${job.queue}/${job.id}`" class="hz-link">
              {{ job.name }}
            </RouterLink>
            <div class="hz-job-queue">Queue: {{ job.queue }}</div>
          </td>
          <td class="text-secondary">{{ job.state }}</td>
          <td class="text-end text-secondary">{{ when(job.createdAt) }}</td>
          <td class="text-end text-secondary">{{ when(job.finishedAt) }}</td>
          <td class="text-end pe-3 text-secondary">{{ runtime(job.runtime) }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="!jobs.length" class="hz-empty">{{ emptyMessage }}</div>
    <Pager :page="page" :per-page="perPage" :total="total" @go="go" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { action, api, type JobPage, type JobView } from '../api';
import Pager from '../components/Pager.vue';
import { autoLoad } from '../state';
import { usePoll } from '../poll';
import { runtime, when } from '../format';

const route = useRoute();

const tag = computed(() => String(route.params.tag ?? ''));
const type = computed(() => (route.query.type === 'failed' ? 'failed' : 'jobs'));

const jobs = ref<JobView[]>([]);
const total = ref(0);
const page = ref(0);
const perPage = 25;

const emptyMessage = computed(() =>
  type.value === 'failed'
    ? 'No failures carrying this tag.'
    : 'No jobs collected yet. Only jobs that run after the tag was monitored show up here.',
);

const load = action(async () => {
  const data = await api.get<JobPage>(
    `/monitoring/jobs?tag=${encodeURIComponent(tag.value)}&type=${type.value}` +
      `&page=${page.value}&perPage=${perPage}`,
  );

  jobs.value = data.jobs;
  total.value = data.total;
});

const go = (delta: number) => {
  page.value = Math.max(0, page.value + delta);
  void load();
};

watch(type, () => {
  page.value = 0;
  void load();
});

onMounted(() => void load());
usePoll(() => {
  // Refreshing page 2 shuffles rows: it is a fixed offset into a list that grows from
  // the top.
  if (!autoLoad.value || page.value > 0) {
    return;
  }

  return load();
});
</script>
