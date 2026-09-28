<script lang="ts" setup>
import { PropType, computed, ref, watch } from 'vue';
import BigNumber from 'bignumber.js';
import { CoinMetadata } from '../../../utils/type';
import { TokenUnitConverter } from '../../../utils/TokenUnitConverter';
import { getStakingParam } from '../../../utils/http';

const props = defineProps({
    endpoint: { type: String, required: true },
    sender: { type: String, required: true },
    metadata: Object as PropType<Record<string, CoinMetadata>>,
    params: String,
});

const params = computed(() => JSON.parse(props.params || "{}"))
const amount = ref("")
const amountDenom = ref("")
const stakingDenom = ref(params.value.bond_denom || "")

// Cancel only the remaining balance of this specific unbonding entry.
const validatorAddress = computed(() => params.value.validator_address || "")
const creationHeight = computed(() => params.value.creation_height || "")
const remainingBalance = computed(() => params.value.balance || "0")

const msgs = computed(() => {
    const convert = new TokenUnitConverter(props.metadata)
    return [{
        typeUrl: '/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation',
        value: {
            delegatorAddress: props.sender,
            validatorAddress: validatorAddress.value,
            amount: convert.displayToBase(stakingDenom.value, {
                amount: String(amount.value),
                denom: amountDenom.value,
            }),
            creationHeight: BigInt(creationHeight.value),
        },
    }]
})

const units = computed(() => {
    const list = props.metadata?.[stakingDenom.value]?.denom_units;
    return list ? [...list].sort((a, b) => b.exponent - a.exponent)
        : [{ denom: stakingDenom.value, exponent: 0, aliases: [] }];
});

const available = computed(() => {
    const convert = new TokenUnitConverter(props.metadata);
    const base = { amount: remainingBalance.value, denom: stakingDenom.value };
    return { base, display: convert.baseToUnit(base, amountDenom.value) };
});

// Metadata can arrive after staking parameters. Keep the selected amount in
// the same base units when its display denomination changes.
watch(units, (list) => {
    const convert = new TokenUnitConverter(props.metadata);
    const base = amount.value && amountDenom.value
        ? convert.displayToBase(stakingDenom.value, { amount: amount.value, denom: amountDenom.value })
        : available.value.base;
    amountDenom.value = list[0]?.denom || stakingDenom.value;
    amount.value = convert.baseToUnit(base, amountDenom.value).amount;
}, { immediate: true });

const isValid = computed(() => {
    if (!props.sender) return { ok: false, error: "Sender is empty" };
    if (!validatorAddress.value) return { ok: false, error: "Validator address is empty" };
    if (!/^[1-9]\d*$/.test(String(creationHeight.value)) || BigInt(creationHeight.value) > 9223372036854775807n)
        return { ok: false, error: "Creation height is invalid" };
    if (!amountDenom.value || !stakingDenom.value) return { ok: false, error: "Amount denomination is empty" };
    const base = new TokenUnitConverter(props.metadata).displayToBase(stakingDenom.value,
        { amount: amount.value, denom: amountDenom.value });
    const value = new BigNumber(base.amount);
    if (!value.isFinite() || !value.isInteger() || !value.gt(0))
        return { ok: false, error: "Enter a positive amount in whole base units" };
    if (value.gt(remainingBalance.value))
        return { ok: false, error: "Amount cannot exceed the remaining unbonding balance" };
    return { ok: true, error: "" };
});

async function initial() {
    if (!stakingDenom.value) {
        const response = await getStakingParam(props.endpoint);
        stakingDenom.value = response.params.bond_denom;
    }
    amount.value = available.value.display.amount;
}

defineExpose({ msgs, isValid, initial })
</script>
<template>
    <div>
        <div class="form-control">
            <label class="label">
                <span class="label-text">Sender</span>
            </label>
            <input 
                :value="sender" 
                type="text" 
                class="text-gray-600 dark:text-white input border !border-gray-300 dark:!border-gray-600" 
                readonly
            />
        </div>
        
        <div class="form-control">
            <label class="label">
                <span class="label-text">Validator Address</span>
            </label>
            <input 
                :value="validatorAddress" 
                type="text" 
                class="text-gray-600 dark:text-white input border !border-gray-300 dark:!border-gray-600" 
                readonly
            />
        </div>
        
        <div class="form-control">
            <label class="label">
                <span class="label-text">Creation Height</span>
            </label>
            <input 
                :value="creationHeight" 
                type="text" 
                class="text-gray-600 dark:text-white input border !border-gray-300 dark:!border-gray-600" 
                readonly
            />
        </div>
        
        <div class="form-control">
            <label class="label">
                <span class="label-text">Amount to Cancel</span>
                <span class="label-text-alt">
                    Available: {{ available?.display.amount }} {{ available?.display.denom }}
                </span>
            </label>
            <label class="input-group">
                <input 
                    v-model="amount" 
                    type="number" 
                    :placeholder="`Available: ${available?.display.amount}`" 
                    class="input border border-gray-300 dark:border-gray-600 w-full dark:text-white" 
                />
                <select v-model="amountDenom" class="select select-bordered dark:text-white">
                    <option v-for="u in units" :key="u.denom">{{ u.denom }}</option>
                </select>
            </label>
        </div>
        
        <div v-if="!isValid.ok" class="text-error mt-2">{{ isValid.error }}</div>
        
        <div class="mt-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <div class="flex items-start">
                <div class="flex-shrink-0">
                    <svg class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                    </svg>
                </div>
                <div class="ml-3">
                    <h3 class="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                        Cancel Unbonding Delegation
                    </h3>
                    <div class="mt-2 text-sm text-yellow-700 dark:text-yellow-300">
                        <p>This will cancel your unbonding delegation and immediately re-delegate the specified amount back to the validator. The tokens will be bonded again and subject to the unbonding period if you decide to unbond in the future.</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
