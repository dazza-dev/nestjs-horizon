<template>
  <div v-if="batch" class="hz-card mb-4">
    <div class="hz-card-header d-flex justify-content-between align-items-center">
      <span>{{ batch.name || batch.id }}</span>
      <button
        v-if="!batch.finished && !batch.cancelled"
        type="button"
        aria-label="Cancel batch"
        title="Cancel Batch"
        class="hz-action hz-action-danger"
        @click="cancel"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>
    <div class="hz-detail">
      <div v-for="row in rows" :key="row.label" class="hz-detail-row">
        <div class="hz-detail-label">{{ row.label }}</div>
        <div class="hz-detail-value">
          {{ row.value }}
          <span v-if="row.label === 'ID'" class="ms-2" :class="badgeClass(batch)">
            {{ label(batch) }}
          </span>
        </div>
      </div>
    </div>
  </div>

  <div v-if="batch && batch.failedJobs > 0" class="hz-card">
    <div class="hz-card-header d-flex justify-content-between align-items-center">
      <span>Failed Jobs ({{ total }})</span>
      <button
        type="button"
        class="btn btn-sm btn-primary text-nowrap d-flex align-items-center gap-1"
        @click="retryFailed"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          width="15"
          height="15"
          :class="{ 'hz-spin': retrying }"
        >
          <path
            fill-rule="evenodd"
            d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
            clip-rule="evenodd"
          />
        </svg>
        Retry Failed Jobs
      </button>
    </div>
    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">Job</th>
          <th>Queue</th>
          <th>Reason</th>
          <th class="text-end pe-3">Failed at</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in failed" :key="`${job.queue}-${job.id}`">
          <td class="ps-3">
            <RouterLink :to="`/jobs/${job.queue}/${job.id}`" class="hz-link">
              {{ job.name }}
            </RouterLink>
          </td>
          <td class="text-secondary">{{ job.queue }}</td>
          <td class="text-secondary text-truncate" style="max-width: 340px">
            {{ job.failedReason ?? '-' }}
          </td>
          <td class="text-end pe-3 text-secondary">{{ when(job.finishedAt ?? null) }}</td>
        </tr>
      </tbody>
    </table>
    <Pager :page="page" :per-page="perPage" :total="total" @go="go" />
  </div>

  <div v-if="missing" class="hz-card">
    <div class="hz-empty">Batch not found. It may have expired.</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { usePoll } from '../poll';
import { RouterLink, useRoute } from 'vue-router';
import { action, api, type Batch, type JobView } from '../api';
import { confirm } from '../confirm';
import Pager from '../components/Pager.vue';
import { badgeClass, label, when } from '../format';

const route = useRoute();
const id = String(route.params.id ?? '');
const batch = ref<Batch | null>(null);
const failed = ref<JobView[]>([]);
const total = ref(0);
const page = ref(0);
const retrying = ref(false);
const perPage = 10;

const rows = computed(() => {
  const b = batch.value;

  if (!b) {
    return [];
  }

  const processed = b.processedJobs + b.failedJobs;

  return [
    { label: 'ID', value: b.id },
    { label: 'Name', value: b.name || b.id },
    { label: 'Created', value: when(b.createdAt) },
    { label: 'Finished', value: when(b.finishedAt) },
    ...(b.cancelledAt ? [{ label: 'Cancelled', value: when(b.cancelledAt) }] : []),
    { label: 'Total Jobs', value: b.totalJobs },
    { label: 'Pending Jobs', value: b.pendingJobs },
    { label: 'Failed Jobs', value: b.failedJobs },
    ...(b.skippedJobs ? [{ label: 'Skipped Jobs', value: b.skippedJobs }] : []),
    { label: 'Processed Jobs', value: `${processed} (${b.progress}%)` },
  ];
});

const loadFailed = action(async () => {
  const data = await api.get<{ jobs: JobView[]; total: number }>(
    `/batches/${id}/failed?page=${page.value}&perPage=${perPage}`,
  );

  failed.value = data.jobs;
  total.value = data.total;
});

const retryFailed = action(async () => {
  const ok = await confirm({
    title: 'Retry the failed jobs of this batch?',
    body: `${total.value} job${total.value === 1 ? '' : 's'} run again on their own queues.`,
    confirmLabel: 'Retry failed',
    tone: 'primary',
  });

  if (!ok) {
    return;
  }

  retrying.value = true;

  try {
    await api.post(`/batches/${id}/retry`);

    // The list just shrank and the counters moved: back to page 1, and re-read the batch
    // or the header keeps its stale number.
    page.value = 0;
    await load();
    await loadFailed();
  } finally {
    retrying.value = false;
  }
});

const cancel = action(async () => {
  const ok = await confirm({
    title: `Cancel ${batch.value?.name ?? 'this batch'}?`,
    body: 'Jobs that have not started are skipped. Anything already running finishes.',
    confirmLabel: 'Cancel batch',
  });

  if (!ok) {
    return;
  }

  await api.post(`/batches/${id}/cancel`);
  await load();
});

const go = (delta: number) => {
  page.value = Math.max(0, page.value + delta);
  void loadFailed();
};

const missing = ref(false);

const load = async () => {
  try {
    batch.value = await api.get<Batch>(`/batches/${id}`);

    // An empty body means gone too, not just a rejected request.
    missing.value = !batch.value;
  } catch (error) {
    // Only a 404 means gone. On a transient 500 the screen would lock on "expired" with
    // nothing left to retry it.
    missing.value = String(error).includes('404');

    if (missing.value) {
      batch.value = null;
    }

    return;
  }

  // The Batch type is a promise about the server, not a guarantee.
  if (batch.value?.failedJobs) {
    await loadFailed();
  }
};

onMounted(() => void load());

usePoll(() => {
  // Stop for a batch that is done or gone, never because a request failed.
  if (missing.value || batch.value?.finished || batch.value?.cancelled) {
    return;
  }

  return load();
}, 3000);
</script>
