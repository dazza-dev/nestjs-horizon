<template>
  <div class="hz-card mb-4">
    <div class="hz-card-header">Overview</div>
    <div class="hz-overview">
      <div v-for="stat in stats" :key="stat.label" class="hz-overview-item">
        <div class="hz-overview-label">{{ stat.label }}</div>
        <div class="hz-overview-value">
          <svg
            v-if="stat.label === 'Status'"
            aria-hidden="true"
            viewBox="0 0 20 20"
            width="22"
            height="22"
            :fill="statusColor"
            class="me-2"
          >
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
              clip-rule="evenodd"
            />
          </svg>
          {{ stat.value }}
        </div>
      </div>
    </div>
  </div>

  <div class="hz-card mb-4">
    <div class="hz-card-header">Current Workload</div>
    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">Queue</th>
          <th class="text-end">Jobs</th>
          <th class="text-end">Delayed</th>
          <th class="text-end">Processes</th>
          <th class="text-end pe-3">Wait</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="queue in workload" :key="queue.name">
          <td class="ps-3">
            {{ queue.name }}
            <span v-if="queue.paused" class="hz-pill hz-pill-warn ms-2"> Paused </span>
          </td>
          <td class="text-end text-secondary">{{ queue.length }}</td>
          <td class="text-end text-secondary">{{ queue.delayed }}</td>
          <td class="text-end text-secondary">{{ queue.processes }}</td>
          <td class="text-end pe-3 text-secondary">{{ humanWait(queue.wait) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!workload.length" class="hz-empty">No queues configured.</div>
  </div>

  <div v-for="master in masters" :key="master.id" class="hz-card mb-4">
    <div class="hz-card-header d-flex justify-content-between align-items-center">
      <span>{{ master.pid ? `${master.hostname}-${master.pid}` : 'Not running' }}</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        width="20"
        height="20"
        :fill="master.pid ? '#12b76a' : 'var(--hz-muted)'"
      >
        <path
          fill-rule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
          clip-rule="evenodd"
        />
      </svg>
    </div>
    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">Supervisor</th>
          <th>Queues</th>
          <th class="text-end">Concurrency</th>
          <th class="text-end pe-3">Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="supervisor in master.supervisors" :key="supervisor.name">
          <td class="ps-3">
            <svg
              v-if="supervisor.paused"
              aria-hidden="true"
              viewBox="0 0 20 20"
              width="16"
              height="16"
              class="hz-paused-mark me-1"
            >
              <path
                d="M2.93 17.07A10 10 0 1 1 17.07 2.93 10 10 0 0 1 2.93 17.07zm12.73-1.41A8 8 0 1 0 4.34 4.34a8 8 0 0 0 11.32 11.32zM7 6h2v8H7V6zm4 0h2v8h-2V6z"
              />
            </svg>
            {{ supervisor.name }}
          </td>
          <td class="text-secondary">
            <span
              v-for="(queue, index) in supervisor.queues"
              :key="queue"
              :class="supervisor.unconsumed?.includes(queue) ? 'text-warning' : ''"
              :title="
                supervisor.unconsumed?.includes(queue)
                  ? 'No processor is registered for this queue'
                  : ''
              "
            >
              {{ queue }}<span v-if="index < supervisor.queues.length - 1">, </span>
            </span>
          </td>
          <td class="text-end text-secondary">{{ supervisor.concurrency }}</td>
          <td class="text-end pe-3 hz-actions">
            <span v-if="!supervisor.running" class="text-secondary small">Inactive</span>
            <button
              v-else
              type="button"
              :aria-label="
                supervisor.paused
                  ? `Resume supervisor ${supervisor.name}`
                  : `Pause supervisor ${supervisor.name}`
              "
              :title="supervisor.paused ? 'Resume supervisor' : 'Pause supervisor'"
              class="hz-action"
              :class="supervisor.paused ? 'hz-action-warning' : ''"
              @click="toggle(supervisor)"
            >
              <svg v-if="supervisor.paused" aria-hidden="true" viewBox="0 0 20 20">
                <path
                  d="M2.93 17.07A10 10 0 1 1 17.07 2.93 10 10 0 0 1 2.93 17.07zm12.73-1.41A8 8 0 1 0 4.34 4.34a8 8 0 0 0 11.32 11.32zM8 6l6 4-6 4V6z"
                />
              </svg>
              <svg v-else aria-hidden="true" viewBox="0 0 20 20">
                <path
                  d="M2.93 17.07A10 10 0 1 1 17.07 2.93 10 10 0 0 1 2.93 17.07zm12.73-1.41A8 8 0 1 0 4.34 4.34a8 8 0 0 0 11.32 11.32zM7 6h2v8H7V6zm4 0h2v8h-2V6z"
                />
              </svg>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="!masters.length" class="hz-card">
    <div class="hz-empty">No workers running. Start a Sentinel worker process.</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  action,
  api,
  type Master,
  type Stats,
  type SupervisorView,
  type Workload,
} from '../api';
import { usePoll } from '../poll';
import { confirm } from '../confirm';

const raw = ref<Stats | null>(null);
const workload = ref<Workload[]>([]);
const masters = ref<Master[]>([]);

const statusLabel = computed(() => {
  const map = { running: 'Active', paused: 'Paused', inactive: 'Inactive' };

  return map[raw.value?.status ?? 'inactive'];
});

const statusColor = computed(() => {
  const map = { running: '#12b76a', paused: '#f79009', inactive: '#98a2b3' };

  return map[raw.value?.status ?? 'inactive'];
});

const humanWait = (seconds: number | null): string => {
  // Null means a backlog with nothing consuming it. "-" would read as "no wait".
  if (seconds === null) return 'Never';
  if (seconds <= 0) return '-';
  if (seconds < 60) return 'A few seconds';

  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);

    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }

  const hours = Math.round(seconds / 3600);

  return hours === 1 ? '1 hour' : `${hours} hours`;
};

/** Names the retention window a counter covers. */
const period = (minutes: number): string => {
  if (minutes < 60) {
    return `Past ${minutes} Minutes`;
  }

  if (minutes < 60 * 24) {
    const hours = Math.round(minutes / 60);

    return hours === 1 ? 'Past Hour' : `Past ${hours} Hours`;
  }

  const days = Math.round(minutes / (60 * 24));

  return days === 1 ? 'Past Day' : `Past ${days} Days`;
};

const stats = computed(() => [
  { label: 'Jobs Per Minute', value: raw.value?.jobsPerMinute ?? 0 },
  {
    label: `Jobs ${period(raw.value?.periods.recentJobs ?? 60)}`,
    value: raw.value?.recentJobs ?? 0,
  },
  {
    label: `Failed Jobs ${period(raw.value?.periods.failedJobs ?? 60 * 24 * 7)}`,
    value: raw.value?.failedJobs ?? 0,
  },
  { label: 'Status', value: statusLabel.value },
  { label: 'Total Processes', value: raw.value?.processes ?? 0 },
  { label: 'Max Time To Clear', value: humanWait(raw.value?.maxWait ?? null) },
  { label: 'Max Runtime', value: raw.value?.queueWithMaxRuntime ?? '-' },
  { label: 'Max Throughput', value: raw.value?.queueWithMaxThroughput ?? '-' },
]);

const load = action(async () => {
  const [s, w, m] = await Promise.all([
    api.get<Stats>('/stats'),
    api.get<Workload[]>('/workload'),
    api.get<Master[]>('/masters'),
  ]);

  raw.value = s;
  workload.value = w;
  masters.value = m;
});

const toggle = action(async (supervisor: SupervisorView) => {
  // Only the pause is confirmed. Resuming is the undo.
  if (!supervisor.paused) {
    const ok = await confirm({
      title: `Pause ${supervisor.name}?`,
      body: `Its queues stop being consumed: ${supervisor.queues.join(', ')}. Jobs keep arriving and wait.`,
      confirmLabel: 'Pause supervisor',
    });

    if (!ok) {
      return;
    }
  }

  try {
    await api.post(
      `/supervisors/${supervisor.name}/${supervisor.paused ? 'resume' : 'pause'}`,
    );
  } finally {
    // A refused toggle must not leave the button showing the wrong state.
    await load();
  }
});

onMounted(() => void load());

// Polls regardless of auto-load, which only governs listing rows.
usePoll(() => load());
</script>
