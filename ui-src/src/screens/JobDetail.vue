<template>
  <template v-if="job">
    <div class="hz-card mb-4">
      <div class="hz-card-header d-flex justify-content-between align-items-center">
        <span>{{ job.name }}</span>
        <button
          v-if="job.state === 'failed'"
          type="button"
          class="btn btn-sm btn-primary d-flex align-items-center gap-1"
          @click="retry"
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
          Retry
        </button>
      </div>
      <div class="hz-detail">
        <div v-for="row in rows" :key="row.label" class="hz-detail-row">
          <div class="hz-detail-label">{{ row.label }}</div>
          <div class="hz-detail-value">
            <RouterLink
              v-if="row.label === 'Batch' && batchId"
              :to="`/batches/${batchId}`"
              class="hz-link"
            >
              {{ row.value }}
            </RouterLink>
            <template v-else>{{ row.value }}</template>
          </div>
        </div>
      </div>
    </div>

    <div v-if="attempts.length" class="hz-card mb-4">
      <div class="hz-card-header d-flex justify-content-between align-items-center">
        <span>Exception</span>
        <div v-if="attempts.length > 1" class="btn-group btn-group-sm">
          <button
            v-for="(_, i) in attempts"
            :key="i"
            type="button"
            class="btn"
            :class="i === attempt ? 'btn-primary' : 'btn-outline-secondary'"
            @click="attempt = i"
          >
            #{{ i + 1 }}
          </button>
        </div>
      </div>
      <div v-for="(frame, i) in visibleFrames" :key="i" class="hz-frame">{{ frame }}</div>
      <div v-if="frames.length > COLLAPSED" class="hz-frame">
        <button
          type="button"
          class="hz-link"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? 'Show Less' : 'Show All' }}
        </button>
      </div>
    </div>

    <div v-if="job.manualRetries.length" class="hz-card mb-4">
      <div class="hz-card-header">Retries</div>
      <table class="table hz-table">
        <thead>
          <tr>
            <th class="ps-3">#</th>
            <th>Retried at</th>
            <th class="text-end pe-3">Outcome</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, i) in job.manualRetries" :key="entry.at">
            <td class="ps-3">{{ i + 1 }}</td>
            <td class="text-secondary">{{ when(entry.at) }}</td>
            <td class="text-end pe-3">
              <span v-if="entry.outcome" :class="outcomeClass(entry)">
                {{ entry.outcome }}
              </span>
              <span v-else class="text-secondary">running</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="context" class="hz-card mb-4">
      <div class="hz-card-header">Exception Context</div>
      <JsonBlock :value="context" />
    </div>

    <div class="hz-card">
      <div class="hz-card-header">Data</div>
      <JsonBlock :value="job.data" />
    </div>
  </template>

  <div v-else-if="missing" class="hz-card">
    <div class="hz-empty">Job not found. It may have been removed from the queue.</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { action, api, type JobView, type ManualRetry } from '../api';
import { runtime, when } from '../format';
import { confirm } from '../confirm';
import JsonBlock from '../components/JsonBlock.vue';

const COLLAPSED = 4;

const route = useRoute();
const router = useRouter();
const queue = String(route.params.queue ?? '');
const id = String(route.params.id ?? '');
const job = ref<JobView | null>(null);
const expanded = ref(false);
const attempt = ref(0);

const batchId = computed(() => {
  const data = job.value?.data as { batchId?: string } | undefined;

  return data?.batchId ?? null;
});

/** BullMQ appends one full trace per attempt, oldest first. */
const attempts = computed(() => job.value?.attemptTraces ?? []);

const frames = computed(() => {
  const trace = attempts.value[attempt.value] ?? job.value?.failedReason ?? '';

  return trace.split('\n').filter((line) => line.trim().length > 0);
});

const outcomeClass = (retry: ManualRetry): string =>
  retry.outcome === 'completed' ? 'hz-pill hz-pill-ok' : 'hz-pill hz-pill-bad';

const visibleFrames = computed(() =>
  expanded.value ? frames.value : frames.value.slice(0, COLLAPSED),
);

// Error metadata only. The reason and attempt count are in the table above.
const context = computed(() => job.value?.context ?? null);

const rows = computed(() => {
  const j = job.value;

  if (!j) {
    return [];
  }

  const failed = Boolean(j.failedReason);

  return [
    { label: 'ID', value: j.id },
    { label: 'Status', value: j.state },
    { label: 'Queue', value: j.queue },
    { label: 'Attempts', value: j.attempts },
    { label: 'Tags', value: j.tags.length ? j.tags.join(', ') : '-' },
    { label: 'Batch', value: batchId.value ?? '-' },
    { label: 'Pushed', value: when(j.createdAt) },
    ...(j.scheduledFor ? [{ label: 'Scheduled for', value: when(j.scheduledFor) }] : []),
    { label: failed ? 'Failed' : 'Finished', value: when(j.finishedAt) },
    { label: 'Runtime', value: runtime(j.runtime) },
  ];
});

const missing = ref(false);

const load = async () => {
  try {
    job.value = await api.get<JobView>(`/jobs/${queue}/${id}`);
    missing.value = !job.value;
  } catch (error) {
    // Only a 404 means gone. On a transient 500 the screen would lock on "removed" with
    // nothing left to retry it.
    missing.value = String(error).includes('404');

    if (missing.value) {
      job.value = null;
    }
  }
};

const retry = action(async () => {
  const ok = await confirm({
    title: `Retry ${job.value?.name ?? 'this job'}?`,
    body: `It runs again on the ${queue} queue, with its attempts reset.`,
    confirmLabel: 'Retry job',
    tone: 'primary',
  });

  if (!ok) {
    return;
  }

  await api.post(`/jobs/${queue}/${id}/retry`);
  await router.push('/jobs/failed');
});

onMounted(load);
</script>
