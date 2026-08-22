import { createRouter, createWebHistory } from 'vue-router';
import { basePath } from './api';
import Dashboard from './screens/Dashboard.vue';
import Metrics from './screens/Metrics.vue';
import MetricDetail from './screens/MetricDetail.vue';
import Batches from './screens/Batches.vue';
import Jobs from './screens/Jobs.vue';
import BatchDetail from './screens/BatchDetail.vue';
import JobDetail from './screens/JobDetail.vue';
import Monitoring from './screens/Monitoring.vue';
import MonitoredTag from './screens/MonitoredTag.vue';

export const router = createRouter({
  history: createWebHistory(basePath()),
  routes: [
    { path: '/', component: Dashboard },
    { path: '/metrics', redirect: '/metrics/jobs' },
    { path: '/metrics/:kind(jobs|queues)', component: Metrics },
    { path: '/metrics/:kind(jobs|queues)/:name', component: MetricDetail },
    { path: '/batches', component: Batches },
    { path: '/batches/:id', component: BatchDetail },
    { path: '/monitoring', component: Monitoring },
    { path: '/monitoring/:tag', component: MonitoredTag },
    {
      path: '/jobs/:listing(pending|active|completed|failed|silenced)',
      component: Jobs,
      props: true,
    },
    { path: '/jobs/:queue/:id', component: JobDetail },
  ],
});
