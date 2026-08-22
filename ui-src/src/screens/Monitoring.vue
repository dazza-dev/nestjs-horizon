<template>
  <div class="hz-card">
    <div class="hz-card-header d-flex justify-content-between align-items-center">
      <span>Monitored Tags ({{ tags.length }})</span>
      <form class="d-flex gap-2" @submit.prevent="monitor">
        <input
          v-model="tag"
          class="form-control form-control-sm hz-search"
          placeholder="Tag"
          aria-label="Tag to monitor"
        />
        <button
          type="submit"
          class="btn btn-sm btn-primary text-nowrap"
          :disabled="!tag.trim()"
        >
          Monitor
        </button>
      </form>
    </div>
    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">Tag</th>
          <th class="text-end">Jobs</th>
          <th class="text-end">Failed</th>
          <th class="text-end pe-3"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in tags" :key="entry.tag">
          <td class="ps-3">
            <RouterLink
              :to="`/monitoring/${encodeURIComponent(entry.tag)}`"
              class="hz-link"
            >
              {{ entry.tag }}
            </RouterLink>
          </td>
          <td class="text-end text-secondary">{{ entry.count }}</td>
          <td
            class="text-end"
            :class="entry.failed ? 'hz-failed-count' : 'text-secondary'"
          >
            {{ entry.failed }}
          </td>
          <td class="text-end pe-3 hz-actions">
            <button
              type="button"
              :aria-label="`Stop monitoring ${entry.tag}`"
              title="Stop Monitoring"
              class="hz-action hz-action-danger"
              @click="stop(entry.tag)"
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
    <div v-if="!tags.length" class="hz-empty">
      No tags are being monitored. Add one above and every job carrying it is collected
      here.
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { usePoll } from '../poll';
import { action, api, type MonitoredTag } from '../api';
import { confirm } from '../confirm';

const tags = ref<MonitoredTag[]>([]);
const tag = ref('');

const load = action(async () => {
  tags.value = await api.get<MonitoredTag[]>('/monitoring');
});

const monitor = async () => {
  await api.post(`/monitoring?tag=${encodeURIComponent(tag.value.trim())}`);
  tag.value = '';
  await load();
};

const stop = action(async (name: string) => {
  const ok = await confirm({
    title: `Stop monitoring ${name}?`,
    body: 'The jobs collected under this tag are dropped, and new ones stop being indexed.',
    confirmLabel: 'Stop monitoring',
  });

  if (!ok) {
    return;
  }

  await api.del(`/monitoring?tag=${encodeURIComponent(name)}`);
  await load();
});

onMounted(() => void load());
// Safe to poll unconditionally: rows are keyed by tag, and only the counters move.
usePoll(() => load());
</script>
