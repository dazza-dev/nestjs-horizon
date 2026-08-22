<template>
  <div class="hz-card">
    <div class="hz-card-header d-flex justify-content-between align-items-center">
      <span>Batches</span>
      <input
        v-model="search"
        class="form-control form-control-sm hz-search"
        placeholder="Search Batches"
        aria-label="Search batches"
      />
    </div>
    <table class="table hz-table">
      <thead>
        <tr>
          <th class="ps-3">Batch</th>
          <th>Status</th>
          <th class="text-end">Size</th>
          <th class="text-end">Completion</th>
          <th class="text-end pe-3">Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in batches" :key="batch.id">
          <td class="ps-3">
            <RouterLink :to="`/batches/${batch.id}`" class="hz-link">{{
              batch.name || batch.id
            }}</RouterLink>
          </td>
          <td>
            <span :class="badgeClass(batch)">{{ label(batch) }}</span>
          </td>
          <td class="text-end text-secondary">{{ batch.totalJobs }}</td>
          <td class="text-end text-secondary">{{ batch.progress }}%</td>
          <td class="text-end pe-3 text-secondary">{{ when(batch.createdAt) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!batches.length" class="hz-empty">No batches yet.</div>
    <Pager :page="page" :per-page="perPage" :total="total" @go="go" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { usePoll } from '../poll';
import { useDebounced } from '../debounce';
import { RouterLink } from 'vue-router';
import { action, api, type Batch, type BatchPage } from '../api';
import { autoLoad } from '../state';
import Pager from '../components/Pager.vue';
import { badgeClass, label, when } from '../format';

const batches = ref<Batch[]>([]);
const total = ref(0);
const page = ref(0);
const search = ref('');
const perPage = 25;

const load = action(async () => {
  const data = await api.get<BatchPage>(
    `/batches?search=${encodeURIComponent(search.value)}&page=${page.value}&perPage=${perPage}`,
  );

  batches.value = data.batches;
  total.value = data.total;
});

const go = (delta: number) => {
  page.value = Math.max(0, page.value + delta);
  void load();
};

useDebounced(search, () => {
  page.value = 0;
  void load();
});

onMounted(() => void load());

usePoll(() => {
  // Page 2 is a fixed offset into a list that grows from the top, and a search has its
  // own debounce. Refreshing either shuffles rows under the reader.
  if (!autoLoad.value || page.value > 0 || search.value) {
    return;
  }

  return load();
});
</script>
