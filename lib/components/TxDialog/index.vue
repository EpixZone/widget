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
import {
    autocompoundParams, checkAutocompoundChain, currentAuthorization, assertReviewedMessages, AutocompoundAction,
    WITHDRAW_REWARD, formatEpix, formatIsoDate, shortAddress, thresholdDays,
} from '../../utils/autocompound';
import { uint64 } from '../../wallet/signing';
import {
    pendingAuthorizationKey, readPendingAuthorization, savePendingAuthorization, clearPendingAuthorization, type PendingAuthorization,
} from '../../utils/pendingAuthorization';

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
    openRequest: [String, Number],
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
const emit = defineEmits(['submited', 'confirmed', 'view', 'closed']);

// functional variable
const p = ref({} as { fees: Coin });
const view = ref('input'); // input, submitting
const open = ref(false);
const error = ref('');
const isAutocompound = computed(() => props.type === 'autocompound' || props.type === 'autocompound_revoke');
const authorizationReady = ref(false);
const reviewing = ref(false); // an account check is in flight; tracked explicitly so dismissing an error cannot fake "checking"
const expiredPendingKey = ref('');
const refreshedAuthorization = ref('');
let authorizationGeneration = 0;
let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
let mounted = false;
let lastOpenRequest = 0;

// Native dialog shell (all types): the hidden checkbox stays for legacy <label for=type> consumers and drives `open`.
const box = ref<HTMLDialogElement | null>(null);
const titleEl = ref<HTMLElement | null>(null);
const gasInput = ref<HTMLInputElement | null>(null);
const alertEl = ref<HTMLElement | null>(null);
let focusGasAfterError = false; // a simulation failure lands focus on the gas input instead of the alert
const reason = ref(''); // why an aria-disabled primary did nothing, shown after a press
const reasonFor = ref(''); // the blocker that reason was written for; once the live blocker differs the text is stale
const resultTone = ref<'neutral' | 'success' | 'warning' | 'error'>('neutral');
const signedExpiry = ref(''); // end date of the grant this dialog signed, for the success text
const copyStatus = ref('');
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

function focusElement(element: unknown, scroll: 'none' | 'nearest' | 'center' = 'none') {
    const target = element as { focus?: (options?: { preventScroll?: boolean }) => void; scrollIntoView?: (options: { block: string }) => void } | null;
    if (!target) return;
    try {
        if (scroll !== 'none' && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: scroll });
        if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    } catch { /* headless renderer */ }
}
function showNativeDialog(value: boolean) {
    const element = box.value as (HTMLDialogElement & { showModal?: () => void }) | null;
    if (!element) return;
    try {
        if (value && typeof element.showModal === 'function' && !element.open) element.showModal();
        else if (!value && typeof element.close === 'function' && element.open) element.close();
    } catch { /* The checkbox-driven CSS keeps the modal usable where <dialog> is unsupported. */ }
}
function onDialogClose() { open.value = false; }
function onDialogCancel(event: Event) { if (sending.value) event.preventDefault(); }

function requestedOpening() {
    const value = Number(props.openRequest);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
async function openRequestedDialog() {
    const request = requestedOpening();
    if (!mounted || !request || request === lastOpenRequest) return;
    lastOpenRequest = request;
    open.value = true;
    // Custom-element properties can arrive in the same update as a new type.
    // Let Vue mount the selected message form before initializing its fields.
    await nextTick();
    if (!mounted || request !== lastOpenRequest || request !== requestedOpening() || !open.value) return;
    await initData();
}
watch(() => props.openRequest, openRequestedDialog, { flush: 'post' });

function authorizationContext() {
    let wallet: unknown;
    try { wallet = readWallet(props.hdPath); } catch { wallet = null; }
    return JSON.stringify([props.type, props.sender, props.endpoint, props.params, props.hdPath, wallet]);
}
function invalidateAuthorization() {
    authorizationGeneration++;
    authorizationReady.value = false;
    reviewing.value = false;
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
watch(open, (value) => {
    if (value) {
        showNativeDialog(true);
        void nextTick(() => focusElement(titleEl.value));
        return;
    }
    invalidateAuthorization();
    reason.value = '';
    showNativeDialog(false);
    emit('closed', { hash: hash.value, eventType: props.type });
});
watch(view, (value) => { if (value === 'submitting') void nextTick(() => focusElement(titleEl.value)); });
function walletChanged() { if (isAutocompound.value) invalidateAuthorization(); }
onMounted(() => {
    mounted = true;
    void openRequestedDialog();
    window.addEventListener('keplr_keystorechange', walletChanged);
    window.addEventListener('leap_keystorechange', walletChanged);
    window.addEventListener('storage', walletChanged);
});
onBeforeUnmount(() => {
    mounted = false;
    invalidateAuthorization();
    if (copyTimer) clearTimeout(copyTimer);
    if (readyTimer) clearTimeout(readyTimer);
    window.removeEventListener('keplr_keystorechange', walletChanged);
    window.removeEventListener('leap_keystorechange', walletChanged);
    window.removeEventListener('storage', walletChanged);
});

// input field
const msgBox = ref({
    msgs: [] as EncodeObject[],
    isValid: { ok: false, error: '' },
    initial: function () { },
    touch: undefined as undefined | (() => void),
    blocker: undefined as undefined | { kind: string; message: string },
    consent: undefined as undefined | boolean, // the grant form's consent ref, rendered in the footer next to the primary
    consentText: undefined as undefined | string,
});
const feeAmount = ref<string | number>(2000);
const feeDenom = ref('');
const gasInfo = ref(200000);
const memo = ref('');
const chainId = ref('cosmoshub-4');
// const chainId = ref('taproot-1');
const broadcast = ref(BroadcastMode.SYNC);

// ---- Auto-compound copy (titles, labels, fee line) derived from the params; parsing never throws here ----
const details = computed(() => {
    if (!isAutocompound.value) return undefined;
    try { return autocompoundParams(props.params, props.type as AutocompoundAction); } catch { return undefined; }
});
const intent = computed(() => details.value?.intent ?? (details.value?.existing_grant ? 'change' : 'turn_on'));
const legacyRevoke = computed(() => props.type === 'autocompound_revoke' && details.value?.message_type === WITHDRAW_REWARD);
const validatorName = computed(() => details.value?.validator_name || details.value?.operator_name || 'this validator');
const headsUp = computed(() => {
    const d = details.value;
    if (!d || props.type !== 'autocompound' || intent.value !== 'turn_on') return false;
    const wait = thresholdDays(d.minimum_reward, d.rewards_amount, d.stake_amount, d.apr);
    return wait !== null && wait > 365;
});
const titleId = computed(() => `${props.type || 'tx'}-title`);
const checking = computed(() => open.value && isAutocompound.value && view.value === 'input' && reviewing.value);
const readyNote = ref(''); // short-lived "Account checked" announcement, same live region as the checking text
let readyTimer: ReturnType<typeof setTimeout> | undefined;
const accountStatus = computed(() => (checking.value ? 'Checking your account…' : readyNote.value));
watch(authorizationReady, (ready) => {
    if (readyTimer) clearTimeout(readyTimer);
    readyNote.value = ready ? 'Account checked. You can continue.' : '';
    if (ready) readyTimer = setTimeout(() => { readyNote.value = ''; }, 3000);
});
const primaryBlocked = computed(() => isAutocompound.value && (!authorizationReady.value || !msgBox.value?.isValid?.ok));
const primaryLabel = computed(() => {
    if (sending.value) return 'Confirm in your wallet…';
    if (checking.value) return 'Checking your account…';
    if (props.type === 'autocompound_revoke') return legacyRevoke.value ? 'Remove' : 'Turn off';
    switch (intent.value) {
        case 'renew': return 'Renew';
        case 'raise_limit': return 'Raise limit';
        case 'change': return 'Save changes';
        default: return headsUp.value ? 'Turn on anyway' : 'Turn on auto-compound';
    }
});
const consentHint = computed(() => (authorizationReady.value && msgBox.value?.blocker?.kind === 'consent' ? msgBox.value.blocker.message : ''));
// What currently blocks the primary, as one key: the account check's state while it is not ready, else the form's blocker.
const blockerKey = computed(() => (!authorizationReady.value ? (error.value ? 'error' : reviewing.value ? 'checking' : 'unchecked') : msgBox.value?.blocker?.kind || ''));
// The pressed reason is shown only while the blocker it explained is still the live one; a changed blocker hides it.
const liveReason = computed(() => (reason.value && reasonFor.value === blockerKey.value ? reason.value : ''));
function setConsent(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (msgBox.value && target) msgBox.value.consent = target.checked;
}
const feeText = computed(() => {
    const fee = String(feeAmount.value);
    return feeDenom.value === 'aepix' && /^\d+$/.test(fee) ? formatEpix(fee, 6) || '0' : '—';
});
const errorText = computed(() => error.value.replace(/^Error: /, ''));
const shortHash = computed(() => (hash.value.length > 12 ? `${hash.value.slice(0, 4)}…${hash.value.slice(-4)}` : hash.value));
const messageTone = computed(() => {
    if (!isAutocompound.value) return error.value ? 'text-red-500' : 'text-lg text-green-500';
    if (error.value) return resultTone.value === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
    return resultTone.value === 'success' ? 'text-lg text-green-600 dark:text-green-400' : 'text-gray-900 dark:text-white';
});
// The permission currently on the chain after a missed deadline, rendered as plain lines when it parses.
const refreshedGrant = computed(() => {
    const text = refreshedAuthorization.value;
    if (!text) return null;
    if (text.startsWith('No current grant')) return { none: true, raw: false, limit: '', until: '', validators: [] as string[] };
    try {
        const grants = JSON.parse(text);
        const grant = Array.isArray(grants) ? grants[0] : undefined;
        if (!grant || typeof grant !== 'object') throw new Error('unreadable');
        const authorization = grant.authorization || {};
        const max = authorization.max_tokens;
        const limit = max && typeof max.amount === 'string' && /^\d+$/.test(max.amount) ? `${formatEpix(max.amount)} EPIX` : 'no limit';
        const validators: string[] = Array.isArray(authorization.allow_list?.address) ? authorization.allow_list.address.map((a: unknown) => shortAddress(String(a))) : [];
        const until = typeof grant.expiration === 'string' ? formatIsoDate(grant.expiration, true) : 'no end date';
        return { none: false, raw: false, limit, until, validators };
    } catch { return { none: false, raw: true, limit: '', until: '', validators: [] as string[] }; }
});
watch(() => msgBox.value?.isValid?.ok, (ok) => { if (ok) reason.value = ''; });
// Errors raised after the user scrolled to the footer would otherwise render out of view with focus still on the title.
// After a simulation failure the alert leads and the gas input follows with the smallest scroll, so both stay in view.
watch(error, (value) => {
    if (!value || view.value !== 'input') return;
    const toGas = focusGasAfterError;
    focusGasAfterError = false;
    void nextTick(() => {
        if (!toGas) { focusElement(alertEl.value, 'nearest'); return; }
        try { alertEl.value?.scrollIntoView({ block: 'start' }); } catch { /* headless renderer */ }
        focusElement(gasInput.value, 'nearest');
    });
});
// Fee settings open far below the visible body, so the opened fieldset scrolls into view and takes focus. A simulation
// failure opens it too, but the error watcher above already places the alert and the gas input together.
watch(advance, (value) => {
    if (value && isAutocompound.value && view.value === 'input' && !focusGasAfterError) void nextTick(() => focusElement(gasInput.value, 'center'));
});

function walletSupported(wallet: { wallet?: string }): string {
    if (!wallet?.wallet) return 'Connect a wallet (Keplr, Leap, or the Epix MetaMask Snap) to continue.';
    // EIP-712, Bitcoin and standalone Ledger paths do not provide this Epix authorization flow.
    if (![WalletName.Keplr, WalletName.Leap, WalletName.MetamaskSnap].includes(wallet.wallet as WalletName)) {
        return `Auto-compound can't be changed with this wallet (${wallet.wallet}) yet. Connect with Keplr or Leap (or the Epix MetaMask Snap).`;
    }
    return '';
}

async function primaryClick() {
    if (!isAutocompound.value) {
        await sendTx();
        return;
    }
    if (sending.value) return;
    if (primaryBlocked.value) {
        msgBox.value?.touch?.();
        const kind = msgBox.value?.blocker?.kind;
        reasonFor.value = blockerKey.value;
        if (!authorizationReady.value) {
            reason.value = error.value ? 'Fix the problem above, or close and reopen this dialog.'
                : reviewing.value ? 'Still checking your account. Try again in a moment.'
                : "The account check didn't pass. Close and reopen this dialog to check again.";
        } else if (kind === 'cap' || kind === 'expiry') reason.value = 'Fix the highlighted field above.'; // the field's own alert carries the text
        else reason.value = msgBox.value?.blocker?.message || (msgBox.value?.isValid?.error || '').replace(/^Error: /, '') || 'Complete the form to continue.';
        return;
    }
    reason.value = '';
    await sendTx();
}

async function copyHash() {
    try {
        await navigator.clipboard.writeText(hash.value);
        copied.value = true;
        copyStatus.value = 'Hash copied';
    } catch { copyStatus.value = "Couldn't copy the hash"; }
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; copyStatus.value = ''; }, 1500);
}

async function initData() {
    if (isAutocompound.value) {
        await initAuthorization();
        return;
    }
    if (open.value && props.endpoint && props.sender) {
        metadatas.value = {}
        view.value = 'input';
        hash.value = '';
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
    // Property updates that arrive in the same tick as the open request flush their watcher on this tick.
    // Starting the review after it means those updates are reviewed, not treated as a change during review.
    await nextTick();
    if (!open.value) return;
    const generation = ++authorizationGeneration;
    reviewing.value = true;
    authorizationReady.value = false;
    expiredPendingKey.value = '';
    refreshedAuthorization.value = '';
    sending.value = false;
    view.value = 'input';
    hash.value = ''; // the pending branch below re-assigns it; `closed` must not carry an earlier transaction's hash
    focusGasAfterError = false;
    error.value = '';
    reason.value = '';
    resultTone.value = 'neutral';
    signedExpiry.value = '';
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
        // An unsupported wallet is reported here, so the check never ends in an enabled form it cannot sign.
        const unsupported = walletSupported(readWallet(props.hdPath));
        if (unsupported) throw new Error(unsupported);
        await checkAutocompoundChain(endpoint, { ...details, validator_address: undefined }, sender);
        if (generation !== authorizationGeneration || context !== authorizationContext() || !open.value) return;
        chainId.value = details.expected_chain_id;
        const pendingKey = pendingAuthorizationKey(sender, details);
        const pending = readPendingAuthorization(pendingKey);
        if (pending) {
            hash.value = pending.hash;
            signedExpiry.value = storedExpiry(pending);
            showAuthorizationResult(pending.hash, endpoint, pending.action, generation, context, 'reopened', pendingKey);
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
    } finally {
        if (generation === authorizationGeneration) reviewing.value = false;
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
        const wallet = readWallet(props.hdPath);
        const unsupported = walletSupported(wallet);
        if (unsupported) throw new Error(unsupported);
        if (!authorizationReady.value) throw new Error('Wait for the chain check, or close and reopen this dialog');
        if (!msgBox.value.isValid.ok) throw new Error(msgBox.value.isValid.error);
        const action = props.type as AutocompoundAction;
        const details = autocompoundParams(props.params, action);
        const pendingKey = pendingAuthorizationKey(props.sender, details);
        if (readPendingAuthorization(pendingKey)) throw new Error('An earlier authorization still needs confirmation. Reopen this dialog to check its status.');
        const endpoint = props.endpoint;
        const sender = props.sender;
        const messages = msgBox.value.msgs;
        if (messages.length !== 1) throw new Error('Expected exactly one authorization message');
        const assertNotExpired = () => {
            if (action === 'autocompound' && messages[0].value.grant.expiration.seconds <= BigInt(Math.floor(Date.now() / 1000))) {
                throw new Error('The end date has passed. Choose a later end date.');
            }
        };
        assertNotExpired();
        const fee = String(feeAmount.value);
        const gas = Number(gasInfo.value);
        if (feeDenom.value !== 'aepix' || !/^[1-9]\d*$/.test(fee) || BigInt(fee) >= 2n ** 256n) throw new Error('Fee must be a positive whole amount of aepix');
        if (!Number.isSafeInteger(gas) || gas <= 0) throw new Error('Gas must be a positive safe integer');
        sending.value = true;
        error.value = '';
        reason.value = '';
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
                focusGasAfterError = true;
                throw new Error(`Couldn't estimate the network fee. Make sure this account holds at least 0.01 EPIX, then try again. You can adjust the fee under Fee settings. (${String(cause).replace(/^Error: /, '')})`);
            }
        }
        assertCurrent();
        assertNotExpired();
        const signed = await client.sign(tx);
        assertCurrent();
        assertNotExpired();
        assertReviewedMessages(signed, reviewed, tx.timeoutHeight);
        const localHash = toHex(sha256(TxRaw.encode(signed).finish())).toUpperCase();
        // The end date travels with the pending record (additive field) so a reopened dialog can still say "until …".
        const record: PendingRecord = { hash: localHash, action, createdAt: Date.now(), timeoutHeight: tx.timeoutHeight! };
        if (action === 'autocompound') {
            const seconds = messages[0].value.grant.expiration.seconds as bigint;
            record.expiration = new Date(Number(seconds) * 1000).toISOString();
        }
        savePendingAuthorization(pendingKey, record);
        signedExpiry.value = storedExpiry(record);
        // Once broadcast begins, show confirmation status even if its response is lost.
        // Never invite a second grant that might reset an already-applied allowance.
        let lost = false;
        try {
            await bounded(client.broadcastTx(endpoint, signed, BroadcastMode.SYNC), 'Broadcast');
            if (current()) emit('submited', { hash: localHash, eventType: action });
        } catch {
            lost = true;
        }
        if (!current()) return;
        hash.value = localHash;
        showAuthorizationResult(localHash, endpoint, action, generation, context, lost ? 'lost' : 'sent', pendingKey);
    } catch (cause) {
        if (generation === authorizationGeneration) error.value = String(cause);
    } finally {
        if (generation === authorizationGeneration) sending.value = false;
    }
}

// The expiry stored beside a pending hash is display-only and lenient: anything unreadable just drops "until …".
type PendingRecord = PendingAuthorization & { expiration?: string };
function storedExpiry(record: PendingAuthorization): string {
    const expiration = (record as PendingRecord).expiration;
    return typeof expiration === 'string' && Number.isFinite(new Date(expiration).getTime()) ? formatIsoDate(expiration, true) : '';
}

function successMessage(action: AutocompoundAction): string {
    const name = validatorName.value;
    if (action === 'autocompound_revoke') {
        return legacyRevoke.value ? 'Permission removed.' : `Auto-compound is off for ${name}. Your stake and rewards stay where they are.`;
    }
    const until = signedExpiry.value ? ` until ${signedExpiry.value}` : '';
    const before = signedExpiry.value || 'it ends';
    const minimum = details.value?.minimum_reward !== undefined ? `${formatEpix(details.value.minimum_reward)} EPIX` : "the service's minimum";
    switch (intent.value) {
        case 'renew':
            return `Auto-compound is renewed for ${name}${until}. Nothing will remind you when it ends, so check back before ${before}.`;
        case 'raise_limit':
        case 'change':
            return `Your auto-compound settings for ${name} are saved${until}. Nothing will remind you when it ends, so check back before ${before}.`;
        default:
            return `Auto-compound is on for ${name}${until}. The first run happens on the service's schedule once your rewards reach ${minimum}. Nothing will remind you when it ends, so check back before ${before}.`;
    }
}

function showAuthorizationResult(tx: string, endpoint: string, action: AutocompoundAction,
    generation: number, context: string, pendingState: 'sent' | 'lost' | 'reopened', pendingKey: string) {
    view.value = 'submitting';
    step.value = 20;
    error.value = '';
    resultTone.value = 'neutral';
    msg.value = pendingState === 'lost' ? "The network's response was lost, so this change is not confirmed yet. Checking its status now…"
        : pendingState === 'reopened' ? 'Your earlier change is still waiting for confirmation. Checking now…'
        : 'Sent. Waiting for the network to confirm, usually under a minute.';
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
            if (Number(response.code) !== 0) {
                const log = String(response.raw_log || '');
                resultTone.value = 'error';
                error.value = /insufficient funds/i.test(log) ? "This account doesn't have enough EPIX for the network fee."
                    : `The network rejected this change: ${log || 'no reason given'}`;
            } else {
                resultTone.value = 'success';
                msg.value = successMessage(action);
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
                    resultTone.value = 'warning';
                    error.value = 'Your earlier change missed its deadline and can no longer go through. Here is the permission currently on the chain:';
                    return;
                }
            } catch { /* Keep the pending guard if chain height or grant state cannot be verified. */ }
            if (++attempts < 5) confirmationTimer = setTimeout(poll, sleep);
            else {
                resultTone.value = 'warning';
                error.value = "Still not confirmed. The network may just be slow. You can close this; we won't let you send a duplicate by mistake, and reopening this dialog checks again.";
            }
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
    if (props.type === 'autocompound') {
        switch (intent.value) {
            case 'renew': return 'Renew auto-compound';
            case 'raise_limit': return 'Raise the limit';
            case 'change': return 'Change auto-compound';
            default: return 'Turn on auto-compound';
        }
    }
    if (props.type === 'autocompound_revoke') return legacyRevoke.value ? 'Remove old permission' : 'Turn off auto-compound';
    const titles: Record<string, string> = {
        'delegate': 'Delegate',
        'redelegate': 'Redelegate',
        'unbond': 'Undelegate',
        'cancel_unbond': 'Cancel Undelegation',
        'cancelunbond': 'Cancel Undelegation',
        'withdraw': 'Claim Rewards',
        'withdraw_commission': 'Claim Commission',
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
        <!-- The hidden checkbox keeps <label for="type"> consumers working; the native dialog is driven from `open`. -->
        <input v-model="open" type="checkbox" :id="type" class="modal-toggle" tabindex="-1" aria-hidden="true" @change="initData()" />
        <dialog ref="box" class="modal" :class="isAutocompound ? 'modal-bottom sm:modal-middle' : ''" :aria-labelledby="titleId"
            @close="onDialogClose" @cancel="onDialogCancel">
            <div class="modal-box relative" :class="[String(type).startsWith('wasm') ? '!w-11/12 !max-w-5xl' : '', isAutocompound ? 'ac-box w-full p-4 sm:p-5' : 'p-5']">
                <button type="button" class="btn btn-ghost btn-circle absolute right-3 top-3 h-11 w-11 min-h-0" :disabled="sending" aria-label="Close"
                    @click="open = false">✕</button>
                <h3 ref="titleEl" :id="titleId" tabindex="-1" class="pr-12 text-lg font-bold outline-none dark:text-white" :class="{ capitalize: !isAutocompound }">
                    {{ showTitle() }}
                </h3>

                <div v-if="!sender" class="text-center h-16 items-center">
                    No wallet connected!
                </div>

                <div v-if="sender" :class="isAutocompound ? 'flex min-h-0 flex-1 flex-col' : ''">
                    <div v-if="view === 'input'" :class="isAutocompound ? 'flex min-h-0 flex-1 flex-col' : ''">
                        <div :class="isAutocompound ? 'flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain py-2' : ''">
                            <!-- min-w-0 overrides the fieldset's UA min-inline-size: min-content, so no unbreakable span can widen the sheet. -->
                            <fieldset :disabled="isAutocompound && sending" :class="isAutocompound ? 'min-w-0' : ''">
                                <component :is="msgType" ref="msgBox" :key="props.type" :endpoint="endpoint" :sender="sender" :balances="balance"
                                    :metadata="metadatas" :params="props.params" />
                            </fieldset>
                            <p v-if="isAutocompound" role="status" class="sr-only">{{ accountStatus }}</p>

                            <!-- Pre-sign blockers sit above the form so they are seen without scrolling; errors after a press
                                 (wallet rejection, fee estimate) stay next to the consent box and the fee fields the user is at. -->
                            <div v-if="error" ref="alertEl" tabindex="-1" role="alert" class="alert alert-error flex items-start gap-3 text-left shadow-lg"
                                :class="isAutocompound ? (authorizationReady ? 'my-4' : 'order-first mb-4') : 'mt-5'">
                                <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="stroke-current flex-shrink-0 h-6 w-6"
                                    fill="none" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                        d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span class="min-w-0 flex-1 break-words">{{ errorText }}</span>
                                <button type="button" class="btn btn-ghost btn-sm min-h-[2.75rem] normal-case sm:min-h-[2.5rem]"
                                    @click="error = ''; void nextTick(() => focusElement(titleEl))">Dismiss</button>
                            </div>

                            <form class="space-y-6" action="#" method="POST" @submit.prevent>
                                <fieldset id="ac-fee-settings" :disabled="isAutocompound && sending" :class="advance ? '' : 'hidden'">
                                    <div class="form-control">
                                        <label class="label" :for="`${type}-fee`">
                                            <span class="label-text">{{ isAutocompound ? 'Fee (aepix, base units)' : 'Fees' }}</span>
                                        </label>
                                        <div class="input-group flex items-center" :class="isAutocompound ? 'flex-col items-stretch gap-2 sm:flex-row sm:items-center' : ''">
                                            <input v-model="feeAmount" :id="`${type}-fee`" type="text" placeholder="0.001"
                                                class="input border border-gray-300 dark:border-gray-600 flex-1 dark:text-gray-300" :class="isAutocompound ? 'w-full min-h-[2.75rem] sm:min-h-[2.5rem]' : 'w-0'" />
                                            <select v-model="feeDenom" :aria-label="'Fee token'"
                                                class="select input border border-gray-300 dark:border-gray-600" :class="isAutocompound ? 'w-full min-h-[2.75rem] sm:w-[200px] sm:min-h-[2.5rem]' : 'w-[200px]'">
                                                <option disabled selected>
                                                    Select Fee Token
                                                </option>
                                                <option v-for="t in balance">
                                                    {{ t.denom }}
                                                </option>
                                            </select>
                                        </div>
                                        <p v-if="isAutocompound" class="mt-1 text-xs text-gray-600 dark:text-gray-400">
                                            {{ feeText === '—' ? 'Whole aepix only; 1 EPIX is 1,000,000,000,000,000,000 aepix.' : `= ${feeText} EPIX` }}
                                        </p>
                                    </div>
                                    <div class="form-control">
                                        <label class="label" :for="`${type}-gas`">
                                            <span class="label-text">Gas</span>
                                        </label>
                                        <input ref="gasInput" v-model="gasInfo" :id="`${type}-gas`" type="number" placeholder="2000000"
                                            class="input border border-gray-300 dark:border-gray-600 dark:text-gray-300" :class="isAutocompound ? 'w-full min-h-[2.75rem] sm:min-h-[2.5rem]' : ''" />
                                    </div>
                                    <div class="form-control">
                                        <label class="label" :for="`${type}-memo`">
                                            <span class="label-text">Memo</span>
                                        </label>
                                        <input v-model="memo" :id="`${type}-memo`" type="text" placeholder="Memo"
                                            class="input border border-gray-300 dark:border-gray-600 dark:text-gray-300" :class="isAutocompound ? 'w-full min-h-[2.75rem] sm:min-h-[2.5rem]' : ''" />
                                    </div>
                                    <div v-if="!isAutocompound" class="form-control">
                                        <label class="label" :for="`${type}-broadcast`">
                                            <span class="label-text">Broadcast Mode</span>
                                        </label>
                                        <select v-model="broadcast" :id="`${type}-broadcast`"
                                            class="select input border border-gray-300 dark:border-gray-600 w-[200px]">
                                            <option :value="BroadcastMode.SYNC">Sync</option>
                                            <option :value="BroadcastMode.ASYNC">Async</option>
                                            <option :value="BroadcastMode.BLOCK">Block</option>
                                        </select>
                                    </div>
                                </fieldset>
                            </form>
                            <!-- Sticky fade over the last of the scrolling body: clipped content reads as scrollable. -->
                            <div v-if="isAutocompound" aria-hidden="true" class="pointer-events-none sticky bottom-0 -mt-8 h-8 shrink-0 bg-gradient-to-t from-base-100 to-transparent"></div>
                        </div>

                        <!-- The footer never scrolls: the consent the primary needs sits directly above it, and one row below holds
                             the fee line with the primary's hint beside Fee settings (three rows on a phone, not five). -->
                        <div v-if="isAutocompound" class="modal-action ac-footer mt-0 flex flex-col gap-2 border-t border-base-300 pt-3">
                            <label v-if="type === 'autocompound'" class="flex min-h-[2.75rem] cursor-pointer items-start gap-2 sm:min-h-[2.5rem] sm:gap-3">
                                <input type="checkbox" class="checkbox checkbox-md checkbox-primary mt-0.5 shrink-0" :checked="msgBox?.consent === true" :disabled="sending" @change="setConsent($event)" />
                                <span class="pt-1 text-xs sm:pt-0 sm:text-sm">{{ msgBox?.consentText }}</span>
                            </label>
                            <button type="button" class="btn btn-primary btn-block min-h-[2.75rem] normal-case sm:min-h-[2.5rem]"
                                :aria-disabled="primaryBlocked ? 'true' : undefined" :disabled="sending"
                                :aria-describedby="liveReason ? 'ac-reason' : consentHint ? 'ac-hint' : undefined" @click="primaryClick">
                                <span v-if="sending || checking" class="loading loading-spinner loading-sm"></span>
                                {{ primaryLabel }}
                            </button>
                            <div class="flex items-center justify-between gap-3">
                                <div class="min-w-0 flex-1">
                                    <p class="text-xs text-gray-600 dark:text-gray-400 sm:text-sm">You pay a network fee of about {{ feeText }} EPIX for this change.<span v-if="type === 'autocompound'" class="hidden sm:inline"> The service pays for the re-staking itself.</span></p>
                                    <p v-if="liveReason" id="ac-reason" role="alert" class="text-sm text-red-600 dark:text-red-400">{{ liveReason }}</p>
                                    <p v-else-if="consentHint" id="ac-hint" class="text-sm text-gray-600 dark:text-gray-400">{{ consentHint }}</p>
                                </div>
                                <button type="button" class="btn btn-ghost btn-sm min-h-[2.75rem] shrink-0 gap-0.5 px-2 font-medium normal-case underline underline-offset-2 sm:min-h-[2.5rem]"
                                    :aria-expanded="advance ? 'true' : 'false'" aria-controls="ac-fee-settings" @click="advance = !advance">
                                    Fee settings<svg aria-hidden="true" class="h-4 w-4 shrink-0 fill-current transition-transform" :class="{ 'rotate-90': advance }" viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z" /></svg>
                                </button>
                            </div>
                        </div>
                        <div v-else class="modal-action flex justify-between items-center">
                            <div class="flex items-center cursor-pointer">
                                <input v-model="advance" type="checkbox" :id="`${type}-advance`"
                                    class="checkbox checkbox-sm checkbox-primary mr-2" /><label :for="`${type}-advance`"
                                    class="cursor-pointer dark:text-gray-400">Advanced</label>
                            </div>
                            <button type="button" class="btn btn-primary" @click="sendTx()" :disabled="sending">
                                <span v-if="sending" class="loading loading-spinner"></span>
                                Send
                            </button>
                        </div>
                    </div>

                    <div v-if="view === 'submitting'" :class="isAutocompound ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : ''">
                        <div class="my-6 sm:my-10">
                            <p role="status" class="my-5 text-center" :class="messageTone">{{ error ? '' : msg }}</p>
                            <p role="alert" class="my-5 text-center" :class="[messageTone, { hidden: !error }]">{{ errorText }}</p>
                            <div aria-hidden="true" class="overflow-hidden h-5 mb-2 text-xs flex rounded bg-green-100">
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
                        <p v-if="isAutocompound" class="flex flex-wrap items-center gap-2 text-sm">
                            <span>Transaction hash: <code class="font-mono">{{ shortHash }}</code></span>
                            <button type="button" class="btn btn-ghost btn-sm min-h-[2.75rem] normal-case sm:min-h-[2.5rem]" @click="copyHash">{{ copied ? 'Copied' : 'Copy transaction hash' }}</button>
                        </p>
                        <p v-if="isAutocompound" role="status" class="sr-only">{{ copyStatus }}</p>
                        <div v-if="expiredPendingKey && refreshedGrant" class="mt-4 space-y-2 text-sm">
                            <p v-if="refreshedGrant.none">No permission for this service.</p>
                            <template v-else-if="!refreshedGrant.raw">
                                <p id="ac-current-title" class="font-medium">The service can:</p>
                                <ul aria-labelledby="ac-current-title" class="list-disc space-y-1 pl-5">
                                    <li>Stake EPIX from this account to {{ refreshedGrant.validators.length ? refreshedGrant.validators.join(', ') : 'any validator' }}</li>
                                    <li>Stake up to {{ refreshedGrant.limit }} in total</li>
                                    <li>Act until {{ refreshedGrant.until }}</li>
                                </ul>
                            </template>
                            <details v-else>
                                <summary class="flex min-h-[2.75rem] cursor-pointer items-center gap-1 sm:min-h-[2.5rem]"><svg aria-hidden="true" class="ac-chevron h-4 w-4 shrink-0 fill-current transition-transform" viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z" /></svg>Show the permission data</summary>
                                <pre class="whitespace-pre-wrap break-all text-xs max-h-48 overflow-auto">{{ refreshedAuthorization }}</pre>
                            </details>
                            <button type="button" class="btn btn-primary min-h-[2.75rem] normal-case sm:min-h-[2.5rem]" @click="reviewAfterTimeout">Review and send again</button>
                        </div>
                        <div class="modal-action flex flex-col gap-2 sm:flex-row sm:justify-end">
                            <button type="button" class="btn btn-ghost min-h-[2.75rem] normal-case sm:min-h-[2.5rem]" @click="viewTransaction">View transaction</button>
                            <button type="button" class="btn btn-primary min-h-[2.75rem] normal-case sm:min-h-[2.5rem]" @click="open = false">Done</button>
                        </div>
                    </div>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop"><button type="submit" tabindex="-1" :disabled="sending">close</button></form>
        </dialog>
    </div>
</template>
<style>
/* Bottom sheet for the auto-compound dialogs: the body scrolls, the title and footer stay put. */
ping-tx-dialog .modal-box.ac-box {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 1rem);
}
@supports (height: 100dvh) {
    ping-tx-dialog .modal-box.ac-box {
        max-height: calc(100dvh - 1rem);
    }
}
@media (min-width: 640px) {
    ping-tx-dialog .modal-box.ac-box {
        max-height: calc(100vh - 5em);
    }
}
/* Host pages override `.btn { min-height: auto }`; keep every dialog button at a usable height. */
ping-tx-dialog .modal-box .btn {
    min-height: 2.5rem;
}
@media (max-width: 639.98px) {
    ping-tx-dialog .modal-box .btn {
        min-height: 2.75rem;
    }
}
ping-tx-dialog .modal-box .ac-footer > :not([hidden]) ~ :not([hidden]) {
    margin-left: 0;
}
/* The footer casts a shadow upward over the scrolling body, so clipped content reads as scrollable. */
ping-tx-dialog .ac-footer {
    box-shadow: 0 -12px 12px -12px rgb(0 0 0 / .55);
}
/* A blocked primary stays focusable and clickable (the press renders its reason) but must not look ready. */
ping-tx-dialog .modal-box .btn-primary[aria-disabled="true"] {
    opacity: .55;
    cursor: not-allowed;
}
/* daisyUI fades a closed .modal with opacity only, so its controls would stay in the tab order and the accessibility
   tree. visibility is already in its transition, .modal[open] sets it visible, and the higher-specificity
   .modal-toggle:checked + .modal keeps the checkbox fallback working. */
ping-tx-dialog dialog.modal:not([open]) {
    visibility: hidden;
}
/* Opening must not transition visibility: at progress 0 the discrete step still computes `hidden`, so focus() calls
   made in the same frame as showModal() would be refused. Closing keeps daisyUI's fade (the after-change style is :not([open])). */
ping-tx-dialog dialog.modal[open],
ping-tx-dialog .modal-toggle:checked + dialog.modal {
    transition-property: transform, opacity;
}
/* Host pages may set `.btn { border: none }`; daisyUI resets width and colour but never the style, so the outline
   chips would render as bare text. Only the style and width come back; daisyUI keeps its own (hover) colours. */
ping-tx-dialog .modal-box .btn-outline {
    border-style: solid;
    border-width: 1px;
}
/* `display: flex` on a summary removes the native disclosure triangle; the inline chevron takes its place. */
ping-tx-dialog details[open] > summary .ac-chevron {
    transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
    ping-tx-dialog .modal,
    ping-tx-dialog .modal::backdrop,
    ping-tx-dialog .modal-box,
    ping-tx-dialog .btn {
        transition: none;
        animation: none;
    }
}
</style>
<script lang="ts">
export default {
    name: 'TxDialog',
};
</script>
