<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import {
    getAccount,
    getBalance,
    getBalanceMetadata,
    getIBCDenomMetadata,
    getLatestBlock,
    getStakingParam,
    getTxByHash,
} from '../../utils/http';
import { BroadcastMode, Coin, CoinMetadata, Transaction } from '../../utils/type';
import { WalletName, readWallet } from '../../../lib/wallet/Wallet';
import { UniClient } from '../../../lib/wallet/UniClient';

// cosmos sdk messages
import Delegate from './messages/Delegate.vue';
import Deposit from './messages/Deposit.vue';
import Redelegate from './messages/Redelegate.vue';
import Send from './messages/Send.vue';
import Transfer from './messages/Transfer.vue';
import Unbond from './messages/Unbond.vue';
import CancelUnbond from './messages/CancelUnbond.vue';
import Vote from './messages/Vote.vue';
import Withdraw from './messages/Withdraw.vue';
import WithdrawCommission from './messages/WithdrawCommission.vue';
import Autocompound from './messages/Autocompound.vue';
import AutocompoundRevoke from './messages/AutocompoundRevoke.vue';
import { autocompoundParams, checkAutocompoundChain, currentAuthorization, assertReviewedMessages, AutocompoundAction } from '../../utils/autocompound';
import { uint64 } from '../../wallet/signing';
import { pendingAuthorizationKey, readPendingAuthorization, savePendingAuthorization, clearPendingAuthorization } from '../../utils/pendingAuthorization';

// wasm msgs
import StoreCode from './wasm/StoreCode.vue';
import ExecuteContract from './wasm/ExecuteContract.vue';
import InstantiateContract from './wasm/InstantiateContract.vue';
import ChainRegistryClient from '@ping-pub/chain-registry-client';
import MigrateContract from './wasm/MigrateContract.vue';
import UpdateAdmin from './wasm/UpdateAdmin.vue';
import ClearAdmin from './wasm/ClearAdmin.vue';

const props = defineProps({
    type: String,
    endpoint: { type: String, required: true },
    sender: { type: String, required: true },
    hdPath: String,
    registryName: String,
    params: String,
});

const msgType = computed(() => {
    switch (props.type?.toLowerCase()) {
        case 'send':
            return Send;
        case 'delegate':
            return Delegate;
        case 'withdraw':
            return Withdraw;
        case 'withdraw_commission':
            return WithdrawCommission;
        case 'autocompound':
            return Autocompound;
        case 'autocompound_revoke':
            return AutocompoundRevoke;
        case 'redelegate':
            return Redelegate;
        case 'transfer':
            return Transfer;
        case 'unbond':
            return Unbond;
        case 'cancel_unbond':
        case 'cancelunbond':
            return CancelUnbond;
        case 'vote':
            return Vote;
        case 'deposit':
            return Deposit;
        case 'wasm_store_code':
            return StoreCode;
        case 'wasm_execute_contract':
            return ExecuteContract;
        case 'wasm_instantiate_contract':
            return InstantiateContract;
        case 'wasm_migrate_contract':
            return MigrateContract;
        case 'wasm_update_admin':
            return UpdateAdmin;
        case 'wasm_clear_admin':
            return ClearAdmin;
        default:
            return Send;
    }
});

const advance = ref(false);
const sending = ref(false);
const balance = ref([] as Coin[]);
const metadatas = ref({} as Record<string, CoinMetadata>);
const emit = defineEmits(['submited', 'confirmed', 'view']);

// functional variable
const p = ref({} as { fees: Coin });
const view = ref('input'); // input, submitting
const open = ref(false);
const error = ref('');
const isAutocompound = computed(() => props.type === 'autocompound' || props.type === 'autocompound_revoke');
const authorizationReady = ref(false);
const expiredPendingKey = ref('');
const refreshedAuthorization = ref('');
let authorizationGeneration = 0;
let confirmationTimer: ReturnType<typeof setTimeout> | undefined;

function authorizationContext() {
    let wallet: unknown;
    try { wallet = readWallet(props.hdPath); } catch { wallet = null; }
    return JSON.stringify([props.type, props.sender, props.endpoint, props.params, props.hdPath, wallet]);
}
function invalidateAuthorization() {
    authorizationGeneration++;
    authorizationReady.value = false;
    expiredPendingKey.value = '';
    refreshedAuthorization.value = '';
    if (confirmationTimer) clearTimeout(confirmationTimer);
    if (open.value && isAutocompound.value) {
        sending.value = false;
        error.value = 'Wallet or transaction details changed. Close and reopen this dialog to review them again.';
    }
}
watch(() => [props.type, props.sender, props.endpoint, props.params, props.hdPath], (_, previous) => {
    if (open.value && (isAutocompound.value || previous[0] === 'autocompound' || previous[0] === 'autocompound_revoke')) invalidateAuthorization();
});
watch(open, (value) => { if (!value) invalidateAuthorization(); });
function walletChanged() { if (isAutocompound.value) invalidateAuthorization(); }
onMounted(() => {
    window.addEventListener('keplr_keystorechange', walletChanged);
    window.addEventListener('leap_keystorechange', walletChanged);
    window.addEventListener('storage', walletChanged);
});
onBeforeUnmount(() => {
    invalidateAuthorization();
    window.removeEventListener('keplr_keystorechange', walletChanged);
    window.removeEventListener('leap_keystorechange', walletChanged);
    window.removeEventListener('storage', walletChanged);
});

// input field
const msgBox = ref({
    msgs: [] as EncodeObject[],
    isValid: { ok: false, error: '' },
    initial: function () { },
});
const feeAmount = ref<string | number>(2000);
const feeDenom = ref('');
const gasInfo = ref(200000);
const memo = ref('');
const chainId = ref('cosmoshub-4');
// const chainId = ref('taproot-1');
const broadcast = ref(BroadcastMode.SYNC);

async function initData() {
    if (isAutocompound.value) {
        await initAuthorization();
        return;
    }
    if (open.value && props.endpoint && props.sender) {
        metadatas.value = {}
        view.value = 'input';
        p.value = JSON.parse(props.params || '{}')
        memo.value = ''

        feeAmount.value = Number(p.value?.fees?.amount || 2000)
        feeDenom.value = balance.value[0]?.denom;
        
        try {
            getBalance(props.endpoint, props.sender).then((x) => {
                balance.value = x.balances;
                x.balances?.forEach((coin) => {
                    // only load for native tokens 
                    if (coin.denom.length < 12)
                        getBalanceMetadata(props.endpoint, coin.denom).then(
                            (meta) => {
                                if(meta.metadata) metadatas.value[coin.denom] = meta.metadata;
                            }
                        ).catch(()=>{});
                    if(coin.denom.startsWith('ibc/')) {
                        getIBCDenomMetadata(coin.denom).then(
                            (meta) => {
                                if(meta) metadatas.value[coin.denom] = meta;
                            }
                        ).catch(()=>{});
                    }
                });
            });

            // load metadata from registry
            if (props.registryName && Object.keys(metadatas.value).length === 0) {
                const client = new ChainRegistryClient()
                client.fetchAssetsList(props.registryName).then(x => {
                    x.assets.forEach(a => {
                        metadatas.value[a.base] = a as CoinMetadata
                    })
                }).catch(() => {
                    console.log(`Chain: ${props.registryName } was not found on Cosmos Registry`)
                })
            }
            getLatestBlock(props.endpoint).then((x) => {
                chainId.value = x.block.header.chain_id;
            });

            // Every sub component should have a initial function
            if (msgBox.value && msgBox.value.initial) msgBox.value.initial();
            
            // load fee denom
            getStakingParam(props.endpoint).then((res) => {
                feeDenom.value = res?.params?.bond_denom;
            })
        } catch (err) {
            error.value = String(err);
        }

        // account.value = await getAccount(props.endpoint, props.sender).then(x => x.account);
        sending.value = false;
    }
}
async function sendTx() {
    if (isAutocompound.value) {
        await sendAuthorization();
        return;
    }
    try {
        if (!props.sender) throw new Error('Sender should not be empty!');
        if (!props.endpoint) throw new Error('Endpoint is empty');
        if (!feeDenom.value) throw new Error('Fee Denom is empty');
        if (!msgBox.value.isValid.ok)
            throw new Error(msgBox.value.isValid.error);

        sending.value = true; // disable sending btn

        const acc = await getAccount(props.endpoint, props.sender);
        const messages = msgBox.value.msgs;

        const tx = {
            chainId: chainId.value,
            signerAddress: props.sender,
            messages,
            fee: {
                gas: "400000",
                amount: [
                    { amount: String(feeAmount.value), denom: feeDenom.value },
                ],
            },
            memo: memo.value,
            signerData: {
                accountNumber: acc.account.account_number,
                sequence: acc.account.sequence,
                chainId: chainId.value,
            },
        };
        // console.log('tx:', tx);
        const current = readWallet(props.hdPath);
        const wallet = current ? current.wallet : WalletName.Keplr;
        const client = new UniClient(wallet, {
            chainId: chainId.value,
            hdPath: current.hdPath,
        });

        if(!advance.value) {
            await client.simulate(props.endpoint, tx, broadcast.value).then(gas => {
                // update tx gas
                tx.fee.gas = (gas * 1.25).toFixed()
            }).catch(() => {
                // sending.value = false;
                // error.value = "Failed to simulate tx gas: " + err;
                advance.value = true;
            })
        } else {
            tx.fee.gas = gasInfo.value.toString()
        }

        const txRaw = await client.sign(tx);
        const response = await client.broadcastTx(props.endpoint, txRaw, broadcast.value);
        // show submitting view
        hash.value = response.tx_response.txhash
        showResult(response.tx_response.txhash);

        emit('submited', {
            hash: response.tx_response.txhash,
            eventType: props.type,
        });
    } catch (e) {
        sending.value = false;
        error.value = String(e);
    }
}

async function initAuthorization() {
    if (!open.value) return;
    const generation = ++authorizationGeneration;
    authorizationReady.value = false;
    expiredPendingKey.value = '';
    refreshedAuthorization.value = '';
    sending.value = false;
    view.value = 'input';
    error.value = '';
    memo.value = '';
    advance.value = false;
    feeAmount.value = '10000000000000000'; // 0.01 EPIX, editable before signing.
    feeDenom.value = 'aepix';
    gasInfo.value = 400000;
    balance.value = [];
    try {
        const context = authorizationContext();
        const details = autocompoundParams(props.params, props.type as AutocompoundAction);
        const endpoint = props.endpoint;
        const sender = props.sender;
        await nextTick();
        msgBox.value.initial();
        await checkAutocompoundChain(endpoint, { ...details, validator_address: undefined }, sender);
        if (generation !== authorizationGeneration || context !== authorizationContext() || !open.value) return;
        chainId.value = details.expected_chain_id;
        const pendingKey = pendingAuthorizationKey(sender, details);
        const pending = readPendingAuthorization(pendingKey);
        if (pending) {
            hash.value = pending.hash;
            showAuthorizationResult(pending.hash, endpoint, pending.action, generation, context,
                'A previous authorization has not been confirmed', pendingKey);
            return;
        }
        await checkAutocompoundChain(endpoint, details, sender);
        if (generation !== authorizationGeneration || context !== authorizationContext() || !open.value) return;
        authorizationReady.value = true;
        // A missing balance must not prevent revoking a grant or hide a chain error.
        getBalance(endpoint, sender).then((result) => {
            if (generation === authorizationGeneration) balance.value = result.balances || [];
        }).catch(() => {});
    } catch (cause) {
        if (generation === authorizationGeneration) error.value = String(cause);
    }
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20000);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}

async function sendAuthorization() {
    if (sending.value) return;
    const generation = authorizationGeneration;
    let context = '';
    const current = () => open.value && generation === authorizationGeneration && context === authorizationContext();
    const assertCurrent = () => { if (!current()) throw new Error('Authorization review was cancelled or changed'); };
    try {
        context = authorizationContext();
        if (!authorizationReady.value) throw new Error('Wait for the chain check, or close and reopen this dialog');
        if (!msgBox.value.isValid.ok) throw new Error(msgBox.value.isValid.error);
        const action = props.type as AutocompoundAction;
        const details = autocompoundParams(props.params, action);
        const pendingKey = pendingAuthorizationKey(props.sender, details);
        if (readPendingAuthorization(pendingKey)) throw new Error('An earlier authorization still needs confirmation. Reopen this dialog to check its status.');
        const endpoint = props.endpoint;
        const sender = props.sender;
        const wallet = readWallet(props.hdPath);
        // EIP-712, Bitcoin and standalone Ledger paths do not provide this Epix authorization flow.
        if (![WalletName.Keplr, WalletName.Leap, WalletName.MetamaskSnap].includes(wallet.wallet)) {
            throw new Error('This wallet does not yet support constrained auto-compound grants. Use an Epix/Keplr-compatible signer or Leap. No broader grant will be requested.');
        }
        const messages = msgBox.value.msgs;
        if (messages.length !== 1) throw new Error('Expected exactly one authorization message');
        const assertNotExpired = () => {
            if (action === 'autocompound' && messages[0].value.grant.expiration.seconds <= BigInt(Math.floor(Date.now() / 1000))) {
                throw new Error('The grant expiry has passed. Choose a later expiry.');
            }
        };
        assertNotExpired();
        const fee = String(feeAmount.value);
        const gas = Number(gasInfo.value);
        if (feeDenom.value !== 'aepix' || !/^[1-9]\d*$/.test(fee) || BigInt(fee) >= 2n ** 256n) throw new Error('Fee must be a positive whole amount of aepix');
        if (!Number.isSafeInteger(gas) || gas <= 0) throw new Error('Gas must be a positive safe integer');
        sending.value = true;
        error.value = '';
        const height = await checkAutocompoundChain(endpoint, details, sender);
        assertCurrent();
        const acc = await bounded(getAccount(endpoint, sender), 'Account query');
        assertCurrent();
        const client = new UniClient(wallet.wallet, { chainId: details.expected_chain_id, hdPath: wallet.hdPath });
        const reviewed = messages.map(message => client.registry.encodeAsAny(message));
        const tx: Transaction = {
            chainId: details.expected_chain_id, signerAddress: sender, messages, memo: memo.value,
            timeoutHeight: uint64(BigInt(height) + 120n),
            fee: { gas: String(gas), amount: [{ amount: fee, denom: 'aepix' }] },
            signerData: { accountNumber: acc.account.account_number, sequence: acc.account.sequence, chainId: details.expected_chain_id },
        };
        if (!advance.value) {
            try {
                const simulated = await bounded(client.simulate(endpoint, tx), 'Simulation');
                if (!Number.isSafeInteger(simulated) || simulated <= 0 || !Number.isSafeInteger(Math.ceil(simulated * 1.25))) throw new Error('Invalid simulated gas');
                tx.fee = { ...tx.fee, gas: String(Math.ceil(simulated * 1.25)) };
            } catch (cause) {
                assertCurrent();
                advance.value = true;
                throw new Error(`Simulation failed. Review fee and gas under Advanced before trying again. ${String(cause)}`);
            }
        }
        assertCurrent();
        assertNotExpired();
        const signed = await client.sign(tx);
        assertCurrent();
        assertNotExpired();
        assertReviewedMessages(signed, reviewed, tx.timeoutHeight);
        const localHash = toHex(sha256(TxRaw.encode(signed).finish())).toUpperCase();
        savePendingAuthorization(pendingKey, { hash: localHash, action, createdAt: Date.now(), timeoutHeight: tx.timeoutHeight! });
        // Once broadcast begins, show confirmation status even if its response is lost.
        // Never invite a second grant that might reset an already-applied allowance.
        let broadcastError = '';
        try {
            await bounded(client.broadcastTx(endpoint, signed, BroadcastMode.SYNC), 'Broadcast');
            if (current()) emit('submited', { hash: localHash, eventType: action });
        } catch (cause) {
            broadcastError = String(cause);
        }
        if (!current()) return;
        hash.value = localHash;
        showAuthorizationResult(localHash, endpoint, action, generation, context, broadcastError, pendingKey);
    } catch (cause) {
        if (generation === authorizationGeneration) error.value = String(cause);
    } finally {
        if (generation === authorizationGeneration) sending.value = false;
    }
}

function showAuthorizationResult(tx: string, endpoint: string, action: AutocompoundAction,
    generation: number, context: string, broadcastError: string, pendingKey: string) {
    view.value = 'submitting';
    step.value = 20;
    error.value = '';
    msg.value = broadcastError ? `Broadcast outcome is not confirmed: ${broadcastError}. Checking transaction status.` : 'Waiting for chain confirmation...';
    let attempts = 0;
    const current = () => open.value && generation === authorizationGeneration && context === authorizationContext();
    const poll = async () => {
        if (!current()) return;
        try {
            const result = await bounded(getTxByHash(endpoint, tx), 'Transaction query');
            if (!current()) return;
            const response = result.tx_response;
            if (!response || !/^\d+$/.test(String(response.height)) || BigInt(response.height) <= 0n || response.code == null ||
                String(response.txhash).toUpperCase() !== tx) throw new Error('Transaction is not yet confirmed');
            step.value = 100;
            clearPendingAuthorization(pendingKey, tx);
            if (Number(response.code) !== 0) error.value = response.raw_log || 'The chain rejected this transaction';
            else {
                msg.value = 'Transaction confirmed.';
                emit('confirmed', { hash: tx, eventType: action });
            }
        } catch {
            if (!current()) return;
            try {
                const pending = readPendingAuthorization(pendingKey);
                const details = autocompoundParams(props.params, props.type as AutocompoundAction);
                const height = await checkAutocompoundChain(endpoint, { ...details, validator_address: undefined }, props.sender);
                if (!current()) return;
                if (pending?.hash === tx && BigInt(height) > BigInt(pending.timeoutHeight)) {
                    const currentGrant = await currentAuthorization(endpoint, props.sender, details);
                    if (!current()) return;
                    refreshedAuthorization.value = currentGrant;
                    expiredPendingKey.value = pendingKey;
                    error.value = 'The transaction validity height has passed. Its historical outcome is still unknown, but these signed bytes cannot execute in a later block. The current grant is shown below. Review it before creating a new authorization.';
                    return;
                }
            } catch { /* Keep the pending guard if chain height or grant state cannot be verified. */ }
            if (++attempts < 5) confirmationTimer = setTimeout(poll, sleep);
            else error.value = 'Confirmation is still unknown. Check this transaction hash before submitting another grant.';
        }
    };
    confirmationTimer = setTimeout(poll, sleep);
}

async function reviewAfterTimeout() {
    if (!expiredPendingKey.value || !refreshedAuthorization.value) return;
    clearPendingAuthorization(expiredPendingKey.value, hash.value);
    await initAuthorization();
}

function viewTransaction() {
    emit('view', {
        hash: hash.value,
        eventType: props.type,
    });
    open.value = false
}

function showTitle() {
    const titles: Record<string, string> = {
        'delegate': 'Delegate',
        'redelegate': 'Redelegate',
        'unbond': 'Undelegate',
        'cancel_unbond': 'Cancel Undelegation',
        'cancelunbond': 'Cancel Undelegation',
        'withdraw': 'Claim Rewards',
        'withdraw_commission': 'Claim Commission',
        'autocompound': 'Enable Auto-compound',
        'autocompound_revoke': 'Revoke Auto-compound Permission',
    };
    const key = (props.type || '').toLowerCase();
    return titles[key] || (props.type || 'Sending Transaction').replace(/\_/g, ' ');
}

const delay = ref(0);
const step = ref(0);
const msg = ref('');
const sleep = 6000;
const hash = ref('')

function showResult(hash: string) {
    view.value = 'submitting';
    delay.value = 1;
    step.value = 20;
    error.value = '';
    msg.value = 'Proccessing...';
    setTimeout(() => {
        fetchTx(hash);
    }, sleep);
}

function fetchTx(tx: string) {
    delay.value += 1;
    step.value += 20;
    getTxByHash(props.endpoint, tx)
        .then((res) => {
            step.value = 100;
            if (res.tx_response.code > 0) {
                error.value = res.tx_response.raw_log;
            } else {
                msg.value = `Congratulations! ${showTitle()} completed successfully.`;
                emit('confirmed', { hash: tx, eventType: props.type });
            }
        })
        .catch(() => {
            if (delay.value < 5) {
                setTimeout(() => fetchTx(tx), sleep);
            } else {
                error.value = 'Timeout';
            }
        });
}
</script>
<template>
    <div class="text-gray-600">
        <!-- Put this part before </body> tag -->
        <input v-model="open" type="checkbox" :id="type" class="modal-toggle" @change="initData()" />
        <label :for="type" class="modal cursor-pointer">
            <label class="modal-box relative p-5" :class="{ '!w-11/12 !max-w-5xl': String(type).startsWith('wasm') }" for="">
                <label :for="type" class="btn btn-sm btn-circle absolute right-4 top-4">✕</label>
                <h3 class="text-lg font-bold capitalize dark:text-gray-300">
                    {{ showTitle() }}
                </h3>

                <div v-if="!sender" class="text-center h-16 items-center">
                    No wallet connected!
                </div>

                <div v-if="sender">
                    <div v-if="view === 'input'">
                        <fieldset :disabled="isAutocompound && sending">
                            <component :is="msgType" ref="msgBox" :key="props.type" :endpoint="endpoint" :sender="sender" :balances="balance"
                                :metadata="metadatas" :params="props.params" />
                        </fieldset>
                        <p v-if="isAutocompound && !authorizationReady && !error" role="status" class="my-3">Checking the selected chain and account...</p>
                        <form class="space-y-6" action="#" method="POST">
                            <fieldset :disabled="isAutocompound && sending" :class="advance ? '' : 'hidden'">
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Fees</span>
                                    </label>
                                    <label class="input-group flex items-center">
                                        <input v-model="feeAmount" type="text" placeholder="0.001"
                                            class="input border border-gray-300 dark:border-gray-600 flex-1 w-0 dark:text-gray-300" />
                                        <select v-model="feeDenom"
                                            class="select input border border-gray-300 dark:border-gray-600 w-[200px]">
                                            <option disabled selected>
                                                Select Fee Token
                                            </option>
                                            <option v-for="t in balance">
                                                {{ t.denom }}
                                            </option>
                                        </select>
                                    </label>
                                </div>
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Gas</span>
                                    </label>
                                    <input v-model="gasInfo" type="number" placeholder="2000000"
                                        class="input border border-gray-300 dark:border-gray-600 dark:text-gray-300" />
                                </div>
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Memo</span>
                                    </label>
                                    <input v-model="memo" type="text" placeholder="Memo"
                                        class="input border border-gray-300 dark:border-gray-600 dark:text-gray-300" />
                                </div>
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Broadcast Mode</span>
                                    </label>
                                    <select v-model="broadcast" :disabled="isAutocompound"
                                        class="select input border border-gray-300 dark:border-gray-600 w-[200px]">
                                        <option :value="BroadcastMode.SYNC">Sync</option>
                                        <option :value="BroadcastMode.ASYNC">Async</option>
                                        <option :value="BroadcastMode.BLOCK">Block</option>
                                    </select>
                                </div>
                            </fieldset>
                        </form>

                        <div v-show="error" class="mt-5 alert alert-error shadow-lg" @click="error = ''">
                            <div class="flex">
                                <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current flex-shrink-0 h-6 w-6"
                                    fill="none" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                        d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span>{{ error }}.</span>
                            </div>
                        </div>

                        <div class="modal-action flex justify-between items-center">
                            <div class="flex items-center cursor-pointer">
                                <input v-model="advance" type="checkbox" :id="`${type}-advance`"
                                    class="checkbox checkbox-sm checkbox-primary mr-2" /><label :for="`${type}-advance`"
                                    class="cursor-pointer dark:text-gray-400">Advanced</label>
                            </div>
                            <button class="btn btn-primary" @click="sendTx()" :disabled="sending || (isAutocompound && (!authorizationReady || !msgBox.isValid.ok))">
                                <span v-if="sending" class="loading loading-spinner"></span>
                                Send
                            </button>
                        </div>
                    </div>

                    <div v-if="view === 'submitting'">
                        <div class="my-10">
                            <div v-if="error" class="my-5 text-center text-red-500">
                                {{ error }}
                            </div>
                            <div v-else class="my-5 text-center text-lg text-green-500">
                                {{ msg }}
                            </div>
                            <div class="overflow-hidden h-5 mb-2 text-xs flex rounded bg-green-100">
                                <div :style="`width: ${step}%`"
                                    class="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-green-400">
                                </div>
                            </div>
                            <div class="flex items-center justify-between">
                                <div>
                                    <span
                                        class="text-xs font-semibold inline-block py-1 px-2 rounded text-gray-600 dark:text-white">
                                        {{ isAutocompound ? 'Confirmation' : 'Submitted' }}
                                    </span>
                                </div>
                                <div class="text-right">
                                    <span class="text-xs font-semibold inline-block text-gray-600 dark:text-white">
                                        {{ isAutocompound ? (step === 100 ? 'Committed' : 'Pending') : `${step}%` }}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <p v-if="isAutocompound" class="break-all text-sm">Transaction hash: {{ hash }}</p>
                        <div v-if="expiredPendingKey" class="mt-4">
                            <p class="font-semibold">Current chain grant</p>
                            <pre class="whitespace-pre-wrap break-all text-xs max-h-48 overflow-auto">{{ refreshedAuthorization }}</pre>
                            <button type="button" class="btn btn-primary mt-4" @click="reviewAfterTimeout">Review a new authorization</button>
                        </div>
                        <label class="mt-10 flex justify-center text-sm tx-link" @click="viewTransaction">
                            <span>View Transaction</span>
                        </label>
                    </div>
                </div>
            </label>
        </label>
    </div>
</template>
<script lang="ts">
export default {
    name: 'TxDialog',
};
</script>
