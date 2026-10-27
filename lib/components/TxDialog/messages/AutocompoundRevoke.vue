<script setup lang="ts">
import { computed, ref } from 'vue';
import { autocompoundParams, revokeMessage, WITHDRAW_REWARD } from '../../../utils/autocompound';
const props = defineProps({ sender: { type: String, required: true }, params: String });
const consent = ref(false);
const details = computed(() => {
    try { return autocompoundParams(props.params, 'autocompound_revoke'); } catch { return undefined; }
});
const validation = computed(() => {
    try {
        const p = autocompoundParams(props.params, 'autocompound_revoke');
        const message = revokeMessage(props.sender, p);
        if (!consent.value) throw new Error('Confirm the operator and grant to revoke');
        return { ok: true, error: '', messages: [message] };
    } catch (error) { return { ok: false, error: String(error), messages: [] }; }
});
const msgs = computed(() => validation.value.messages);
const isValid = computed(() => ({ ok: validation.value.ok, error: validation.value.error }));
function initial() { consent.value = false; }
defineExpose({ msgs, isValid, initial });
</script>
<template>
    <div class="space-y-4 text-sm dark:text-gray-300">
        <dl class="space-y-2 break-all">
            <dt class="font-bold">Chain</dt><dd>{{ details?.expected_chain_id }}</dd>
            <dt class="font-bold">Your account</dt><dd>{{ sender }}</dd>
            <dt class="font-bold">Operator{{ details?.operator_name ? ` (${details.operator_name})` : '' }}</dt>
            <dd>{{ details?.operator_address }}</dd>
            <dt class="font-bold">Permission to revoke</dt>
            <dd>{{ details?.message_type === WITHDRAW_REWARD ? 'Legacy reward withdrawal' : 'Delegate' }}</dd>
        </dl>
        <p>This revokes this operator's selected permission for your account after the transaction is confirmed. Your existing stake remains delegated. You pay the revocation transaction fee.</p>
        <p v-if="details?.message_type === WITHDRAW_REWARD">Current REStake compounding does not need this old withdrawal permission. Revoking it does not revoke a separate delegate grant.</p>
        <label class="flex items-start gap-3">
            <input v-model="consent" type="checkbox" class="checkbox checkbox-sm" />
            <span>I reviewed the operator and permission to revoke.</span>
        </label>
        <p v-if="!isValid.ok" class="text-sm text-red-600 dark:text-red-400" role="status">{{ isValid.error.replace(/^Error: /, '') }}</p>
    </div>
</template>
