<script lang="ts" setup>
import { PropType, computed, ref } from 'vue';
import { Coin, CoinMetadata } from '../../../utils/type';
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
const error = ref("")
const stakingDenom = ref("")

// The params should contain validator_address, creation_height, and initial_balance from the unbonding entry
const validatorAddress = computed(() => params.value.validator_address || "")
const creationHeight = computed(() => params.value.creation_height || "")
const initialBalance = computed(() => params.value.initial_balance || "")

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
            creationHeight: creationHeight.value,
        },
    }]
})

const units = computed(() => {
    if (!props.metadata || !props.metadata[stakingDenom.value]) {
        amountDenom.value = stakingDenom.value;
        return [{ denom: stakingDenom.value, exponent: 0, aliases: [] }];
    }
    const list = props.metadata[stakingDenom.value].denom_units.sort(
        (a, b) => b.exponent - a.exponent
    );
    if (list.length > 0) amountDenom.value = list[0].denom;
    return list;
})

const isValid = computed(() => {
    let ok = true
    let error = ""
    if (!props.sender) {
        ok = false
        error = "Sender is empty"
    }
    if (!validatorAddress.value) {
        ok = false
        error = "Validator address is empty"
    }
    if (!creationHeight.value) {
        ok = false
        error = "Creation height is empty"
    }
    if (!(Number(amount.value) > 0)) {
        ok = false
        error = "Amount should be greater than 0"
    }
    if (!amountDenom.value) {
        ok = false
        error = "Amount denomination is empty"
    }
    
    // Validate that amount doesn't exceed initial balance
    const convert = new TokenUnitConverter(props.metadata);
    const initialBalanceDisplay = convert.baseToUnit(
        { amount: initialBalance.value, denom: stakingDenom.value },
        amountDenom.value
    );
    
    if (Number(amount.value) > Number(initialBalanceDisplay.amount)) {
        ok = false
        error = `Amount cannot exceed initial unbonding balance of ${initialBalanceDisplay.amount} ${amountDenom.value}`
    }
    
    return { ok, error }
})

const available = computed(() => {
    const convert = new TokenUnitConverter(props.metadata);
    const base = { amount: initialBalance.value, denom: stakingDenom.value }
    return {
        base,
        display: convert.baseToUnit(base, amountDenom.value),
    };
});

function initial() {
    // Fetch staking parameters to get the correct denomination
    getStakingParam(props.endpoint).then((x) => {
        stakingDenom.value = x.params.bond_denom;

        // Set default amount to the full initial balance after staking denom is loaded
        setTimeout(() => {
            if (available.value.display) {
                amount.value = available.value.display.amount
            }
        }, 100);
    });
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
        
        <div v-if="error" class="text-error mt-2">{{ error }}</div>
        
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
