<template>
  <nav class="hz-navbar d-flex align-items-center justify-content-between">
    <span class="hz-brand d-flex align-items-center gap-2">
      <!-- Three queued items and the one being dispatched. -->
      <svg
        viewBox="0 0 24 24"
        width="26"
        height="26"
        fill="currentColor"
        aria-hidden="true"
      >
        <rect x="2" y="4.2" width="11.5" height="3.6" rx="1.8" opacity=".45" />
        <rect x="2" y="10.2" width="11.5" height="3.6" rx="1.8" />
        <rect x="2" y="16.2" width="11.5" height="3.6" rx="1.8" opacity=".7" />
        <path d="M16.4 7.9 22.2 12l-5.8 4.1z" />
      </svg>
      <span>{{ name }}</span>
    </span>
    <div class="d-flex align-items-center gap-2">
      <SchemeToggler />
      <AutoLoadToggler />
    </div>
  </nav>

  <div v-if="lastError" class="container-fluid px-4 pt-3">
    <div
      class="alert alert-danger d-flex justify-content-between align-items-center mb-0"
    >
      <span>{{ lastError }}</span>
      <button
        type="button"
        class="btn-close"
        aria-label="Dismiss"
        @click="lastError = null"
      ></button>
    </div>
  </div>

  <div class="container-fluid py-4 px-4">
    <div class="row g-4">
      <div class="col-12 col-lg-2">
        <Sidebar />
      </div>
      <div class="col-12 col-lg-10">
        <RouterView />
      </div>
    </div>
  </div>

  <ConfirmDialog />
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router';
import { instanceName, lastError } from './api';

const name = instanceName();
import ConfirmDialog from './components/ConfirmDialog.vue';
import SchemeToggler from './components/SchemeToggler.vue';
import AutoLoadToggler from './components/AutoLoadToggler.vue';
import Sidebar from './components/Sidebar.vue';
</script>
