<template>
  <Markdown :text="text" class="max-w-full" />
</template>

<script setup lang="ts">
import { sanitizeAssistantText, type AnimaUIMessage } from '@anima/core';
import type { TextUIPart } from 'ai';
import { computed } from 'vue';

const props = defineProps<{ part: TextUIPart; role?: AnimaUIMessage['role'] }>();

// Models sometimes write their native tool-call syntax into the text stream, and that must never reach the
// user. Assistant text is sanitized while streaming; storage and reads sanitize it too.
const text = computed(() => (props.role === 'user' ? props.part.text : sanitizeAssistantText(props.part.text)));
</script>
