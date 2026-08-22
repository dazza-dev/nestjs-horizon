<template>
  <div v-if="total > perPage" class="d-flex justify-content-between p-3 border-top">
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary"
      :disabled="page === 0"
      @click="$emit('go', -1)"
    >
      Previous
    </button>
    <span class="small text-secondary align-self-center">
      {{ page * perPage + 1 }}–{{ Math.min((page + 1) * perPage, total) }} of {{ total }}
      <span v-if="reachable !== undefined && reachable < total">
        (first {{ reachable }})</span
      >
    </span>
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary"
      :disabled="(page + 1) * perPage >= Math.min(reachable ?? total, total)"
      @click="$emit('go', 1)"
    >
      Next
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{ page: number; perPage: number; total: number; reachable?: number }>();
defineEmits<{ go: [delta: number] }>();
</script>
