<script setup lang="ts">
import { computed, ref } from 'vue';
import { autocompoundParams, grantMessage, localDateTime } from '../../../utils/autocompound';

const props = defineProps({ sender: { type: String, required: true }, params: String });
const cap = ref('');
const expiry = ref('');
const consent = ref(false);
const details = computed(() => {
    try { return autocompoundParams(props.params, 'autocompound'); } catch { return undefined; }
});
const validation = computed(() => {
    try {
        const p = autocompoundParams(props.params, 'autocompound');
        const message = grantMessage(props.sender, p, cap.value, expiry.value);
        if (!consent.value) throw new Error('Confirm the delegation authority before continuing');
        return { ok: true, error: '', messages: [message] };
    } catch (error) { return { ok: false, error: String(error), messages: [] }; }
});
const msgs = computed(() => validation.value.messages);
const isValid = computed(() => ({ ok: validation.value.ok, error: validation.value.error }));
const expiryUtc = computed(() => {
    const date = new Date(`${expiry.value}:00`);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
});
function initial() {
    cap.value = '';
    expiry.value = localDateTime(new Date(Date.now() + 30 * 86400000));
    consent.value = false;
}
defineExpose({ msgs, isValid, initial });
</script>
<template>
    <div class="space-y-4 text-sm dark:text-gray-300">
        <p>Allow this validator's operator to compound your rewards using its existing REStake service.</p>
        <dl class="space-y-2 break-all">
            <dt class="font-bold">Chain</dt><dd>{{ details?.expected_chain_id }}</dd>
            <dt class="font-bold">Your account</dt><dd>{{ sender }}</dd>
            <dt class="font-bold">Validator</dt><dd>{{ details?.validator_address }}</dd>
            <dt class="font-bold">Operator{{ details?.operator_name ? ` (${details.operator_name})` : '' }}</dt>
            <dd>{{ details?.operator_address }}</dd>
        </dl>
        <label class="form-control">
            <span class="label label-text dark:text-gray-300">Total delegation allowance (EPIX)</span>
            <input v-model="cap" type="text" inputmode="decimal" autocomplete="off" placeholder="Enter a positive cap"
                class="input input-bordered dark:text-gray-300" />
        </label>
        <p>This allowance is cumulative and decreases with every authorized delegation. It is not a limit per run.</p>
        <label class="form-control">
            <span class="label label-text dark:text-gray-300">Expiry (your local time)</span>
            <input v-model="expiry" type="datetime-local" class="input input-bordered dark:text-gray-300" />
        </label>
        <p v-if="expiryUtc">Expires at {{ expiryUtc }} (UTC).</p>
        <p>The operator can delegate available EPIX, including your existing balance, up to this cap and only to the validator shown above. The grant cannot restrict it to rewards alone. It does not allow sending, undelegating, redelegating, or changing your withdrawal address.</p>
        <p>You pay for this grant transaction. The operator pays for its later compounding transactions. The service's advertised schedule is not a guarantee.</p>
        <p v-if="details?.existing_grant" class="font-bold">This replaces the existing delegate grant to this operator and resets its remaining allowance to the cap entered here.</p>
        <p v-else>A delegate grant already held by this operator will be replaced, and its allowance will reset to this cap.</p>
        <label class="flex items-start gap-3">
            <input v-model="consent" type="checkbox" class="checkbox checkbox-sm" />
            <span>I reviewed the operator, validator, allowance and expiry, and understand the delegation authority.</span>
        </label>
        <p v-if="!isValid.ok" class="text-sm text-red-600 dark:text-red-400" role="status">{{ isValid.error.replace(/^Error: /, '') }}</p>
    </div>
</template>
