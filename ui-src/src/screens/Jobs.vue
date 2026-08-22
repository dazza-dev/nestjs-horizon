<template>
  <div class="hz-card">
    <div class="hz-card-header d-flex justify-content-between align-items-center">
      <span>{{ title }} ({{ total }})</span>
      <div class="d-flex gap-2">
        <button
          v-if="listing === 'failed' && total"
          type="button"
          class="btn btn-sm btn-primary text-nowrap d-flex align-items-center gap-1"
          @click="retryAll"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            width="15"
            height="15"
          >
            <path
              fill-rule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
              clip-rule="evenodd"
            />
          </svg>
          Retry all
        </button>
        <input
          v-if="listing === 'failed'"
          v-model="tag"
          class="form-control form-control-sm hz-search"
          placeholder="Search Tags"
          aria-label="Filter by tag"
        />
        <input
          v-model="search"
          class="form-control form-control-sm hz-search"
          placeholder="Search Jobs"
          aria-label="Search jobs"
        />
      </div>
    </div>
    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">Job</th>
          <th v-if="listing === 'failed'">Reason</th>
          <th class="text-end">Queued</th>
          <th class="text-end">{{ listing === 'failed' ? 'Failed' : 'Completed' }}</th>
          <th class="text-end">Runtime</th>
          <th class="text-end pe-3"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="hasNewEntries" class="hz-new-entries" @click="loadNewEntries">
          <td :colspan="listing === 'failed' ? 6 : 5" class="text-center py-2">
            Load new entries
          </td>
        </tr>
        <tr v-for="job in jobs" :key="`${job.queue}-${job.id}`">
          <td class="ps-3">
            <RouterLink :to="`/jobs/${job.queue}/${job.id}`" class="hz-link">
              {{ job.name }}
            </RouterLink>
            <div class="hz-job-queue">Queue: {{ job.queue }}</div>
            <div v-if="job.tags.length" class="hz-tags">
              <span v-for="jobTag in job.tags" :key="jobTag" class="hz-tag">
                {{ jobTag }}
              </span>
            </div>
          </td>
          <td
            v-if="listing === 'failed'"
            class="text-secondary text-truncate"
            style="max-width: 280px"
          >
            {{ job.failedReason ?? '-' }}
          </td>
          <td class="text-end text-secondary">{{ when(job.createdAt) }}</td>
          <td class="text-end text-secondary">{{ when(job.finishedAt) }}</td>
          <td class="text-end text-secondary">{{ runtime(job.runtime) }}</td>
          <td class="text-end pe-3 hz-actions">
            <button
              v-if="listing === 'failed'"
              type="button"
              :aria-label="`Retry ${job.name}`"
              title="Retry Job"
              class="hz-action hz-action-primary"
              @click="retry(job)"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                :class="{ 'hz-spin': retrying === job.id }"
              >
                <path
                  fill-rule="evenodd"
                  d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <button
              type="button"
              :aria-label="`Delete ${job.name}`"
              title="Delete Job"
              class="hz-action hz-action-danger"
              @click="remove(job)"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!jobs.length" class="hz-empty">Nothing here.</div>
    <Pager
      :page="page"
      :per-page="perPage"
      :total="total"
      :reachable="reachable"
      @go="go"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { action, api, type JobPage, type JobView } from '../api';
import { autoLoad } from '../state';
import Pager from '../components/Pager.vue';
import { usePoll } from '../poll';
import { useDebounced } from '../debounce';
import { confirm } from '../confirm';
import { runtime, when } from '../format';

const props = defineProps<{ listing: string }>();

const jobs = ref<JobView[]>([]);
const total = ref(0);
const reachable = ref<number | undefined>(undefined);
const page = ref(0);
const search = ref('');
const tag = ref('');
const hasNewEntries = ref(false);
const retrying = ref<string | null>(null);
const perPage = 25;

const title = computed(() => {
  const map: Record<string, string> = {
    pending: 'Pending Jobs',
    active: 'Active Jobs',
    completed: 'Completed Jobs',
    failed: 'Failed Jobs',
    silenced: 'Silenced Jobs',
  };

  return map[props.listing] ?? 'Jobs';
});

// A tag filter reads the failure index instead of scanning, reaching failures far
// outside the search window.
const fetchPage = () =>
  api.get<JobPage>(
    `/jobs/${props.listing}?search=${encodeURIComponent(search.value)}` +
      `&tag=${encodeURIComponent(tag.value.trim())}` +
      `&page=${page.value}&perPage=${perPage}`,
  );

const load = action(async () => {
  const data = await fetchPage();

  jobs.value = data.jobs;
  total.value = data.total;
  reachable.value = data.reachable;
  hasNewEntries.value = false;
});

const loadNewEntries = () => void load();

/** Polls the listing. With auto load off, only the "load new entries" notice appears. */
const poll = async () => {
  if (page.value > 0) {
    return;
  }

  const data = await fetchPage();

  if (autoLoad.value || !jobs.value.length) {
    jobs.value = data.jobs;
    total.value = data.total;
    reachable.value = data.reachable;
    hasNewEntries.value = false;

    return;
  }

  hasNewEntries.value = data.jobs[0]?.id !== jobs.value[0]?.id;
};

const go = (delta: number) => {
  page.value = Math.max(0, page.value + delta);
  void load();
};

const retry = action(async (job: JobView) => {
  const ok = await confirm({
    title: `Retry ${job.name}?`,
    body: `It runs again on the ${job.queue} queue, with its attempts reset.`,
    confirmLabel: 'Retry job',
    tone: 'primary',
  });

  if (!ok) {
    return;
  }

  retrying.value = job.id;

  try {
    await api.post(`/jobs/${job.queue}/${job.id}/retry`);
    await load();
  } finally {
    retrying.value = null;
  }
});

const retryAll = action(async () => {
  const ok = await confirm({
    title: `Retry every failed job?`,
    body: `All ${total.value} failures run again. Work that has already been done by hand will be repeated.`,
    confirmLabel: 'Retry all',
    tone: 'primary',
  });

  if (!ok) {
    return;
  }

  await api.post('/jobs/retry-all');
  await load();
});

const remove = action(async (job: JobView) => {
  const ok = await confirm({
    title: `Delete ${job.name}?`,
    body: 'The job and its payload are removed from Redis. This cannot be undone.',
    confirmLabel: 'Delete job',
  });

  if (!ok) {
    return;
  }

  await api.del(`/jobs/${job.queue}/${job.id}`);
  await load();
});

useDebounced([search, tag], () => {
  page.value = 0;
  void load();
});

watch(
  () => props.listing,
  () => {
    page.value = 0;
    search.value = '';
    tag.value = '';
    void load();
  },
  { immediate: true },
);

usePoll(() => poll());
</script>
