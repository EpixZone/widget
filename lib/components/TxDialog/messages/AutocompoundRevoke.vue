<script setup lang="ts">
import { computed } from 'vue';
import { autocompoundParams, revokeMessage, shortAddress, WITHDRAW_REWARD } from '../../../utils/autocompound';

const props = defineProps({ sender: { type: String, required: true }, params: String });
const details = computed(() => {
    try { return autocompoundParams(props.params, 'autocompound_revoke'); } catch { return undefined; }
});
const legacy = computed(() => details.value?.message_type === WITHDRAW_REWARD);
const name = computed(() => details.value?.validator_name || details.value?.operator_name || 'this service');
const shortGrantee = computed(() => shortAddress(details.value?.operator_address || ''));
// Turning off is reversible and low risk, so the primary button is the confirmation: no consent box.
const validation = computed(() => {
    try {
        const p = autocompoundParams(props.params, 'autocompound_revoke');
        return { ok: true, error: '', messages: [revokeMessage(props.sender, p)] };
    } catch (error) { return { ok: false, error: String(error).replace(/^Error: /, ''), messages: [] }; }
});
const msgs = computed(() => validation.value.messages);
const isValid = computed(() => ({ ok: validation.value.ok, error: validation.value.error }));
const blocker = computed(() => ({ kind: validation.value.ok ? '' : 'params', message: validation.value.error }));
function initial() { /* nothing to reset; kept for the shell's form contract */ }
function touch() { /* no per-field state */ }
defineExpose({ msgs, isValid, initial, touch, blocker });
</script>
<template>
    <div class="space-y-3 text-sm dark:text-gray-300">
        <!-- The same context block as the grant dialog: the title already asks the question, so no second heading. -->
        <section class="space-y-0.5" aria-label="Validator and service">
            <p class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-base font-semibold text-gray-900 dark:text-white">{{ name }}</span>
                <code v-if="shortGrantee" class="font-mono text-xs text-gray-500 dark:text-gray-400">{{ shortGrantee }}</code>
            </p>
        </section>
        <p v-if="legacy">Current services don't need this permission. Removing it doesn't change your auto-compound setting.</p>
        <p v-else>The service will stop re-staking your rewards. Your stake and rewards stay exactly where they are. You can turn it on again any time.</p>
        <details class="text-sm">
            <!-- text-gray-500 maps to the widget's --text-secondary (main.css), the same gray the page's Details uses. -->
            <summary class="flex min-h-[2.75rem] cursor-pointer items-center gap-1 font-medium text-gray-500 sm:min-h-[2.5rem]"><svg aria-hidden="true" class="ac-chevron h-4 w-4 shrink-0 fill-current transition-transform" viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z" /></svg>Details</summary>
            <dl class="space-y-2 pb-1">
                <div><dt class="font-medium">Your account</dt><dd><code class="break-all font-mono text-xs">{{ sender }}</code></dd></div>
                <div>
                    <dt class="font-medium">Service account (receives the permission)</dt>
                    <dd><code class="break-all font-mono text-xs">{{ details?.operator_address || shortGrantee }}</code></dd>
                </div>
                <div><dt class="font-medium">Network</dt><dd>{{ details?.expected_chain_id }}</dd></div>
                <div><dt class="font-medium">Permission</dt><dd>{{ legacy ? 'Reward withdrawal (old)' : 'Stake to this validator (auto-compound)' }}</dd></div>
            </dl>
        </details>
    </div>
</template>
