<template>
  <!-- eslint-disable-next-line vue/no-v-html -- the payload is escaped before it is coloured -->
  <pre class="hz-json"><code v-html="highlighted"></code></pre>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ value: unknown }>();

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Colours a JSON dump without pulling in a syntax highlighter. */
const highlighted = computed(() => {
  const json = escape(JSON.stringify(props.value, null, 2) ?? 'null');

  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      if (/^"/.test(match)) {
        return /:$/.test(match)
          ? `<span class="hz-json-key">${match}</span>`
          : `<span class="hz-json-string">${match}</span>`;
      }

      return /true|false|null/.test(match)
        ? `<span class="hz-json-literal">${match}</span>`
        : `<span class="hz-json-number">${match}</span>`;
    },
  );
});
</script>
