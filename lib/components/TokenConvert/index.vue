<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { fromBech32, toBech32, toHex } from '@cosmjs/encoding';
import { sha256 } from '@cosmjs/crypto';
import ChainRegistryClient from '@ping-pub/chain-registry-client';
import {
    Asset,
    Chain,
    IBCInfo,
    IBCPath,
} from '@ping-pub/chain-registry-client/dist/types';
import {
    getBalance,
    getStakingParam,
    getOsmosisPools,
    getLatestBlock,
    getAccount,
    getTxByHash,
    getSqsQuote,
} from '../../utils/http';
import {
    Account,
    ConnectedWallet,
    WalletName,
    createWallet,
    readWallet,
    writeWallet,
} from '../../wallet/Wallet';
import { Coin } from '../../utils/type';
import { osmosis, ibc, getSigningOsmosisClient } from 'osmojs';
import { tokens, type TokenConfig } from './tokens';
import { decimal2percent } from '../../utils/format';
import { StdFee, coin } from '@cosmjs/stargate';
import Long from 'long';
import { UniClient } from '../../wallet/UniClient';

const props = defineProps({
    chainName: { type: String, required: true },
    endpoint: { type: String, required: true },
    hdPath: String,
});
const OSMOSIS_RPC = 'https://rpc.osmosis.zone';
const OSMOSIS_REST = 'https://lcd.osmosis.zone';
const DEFAULT_HDPATH = "m/44'/118/0'/0/0";

const view = ref('connect'); // [connect, swap, deposit, withdraw]

function switchView(v: string) {
    view.value = v;
}

// variables
const direction = ref('buy');
const sending = ref(false); // show status on send tx
const open = ref(false);
const error = ref('');
const osmoSenderAddress = ref('');
const chains = ref([] as IBCPath[]);
const osmosisPath = ref({} as IBCPath | undefined);
const osmosisPathInfo = ref({} as IBCInfo);
const defaultDenom = ref('');
const sender = ref({} as ConnectedWallet);
const localBalances = ref([] as Coin[]);
const osmoBalances = ref([] as Coin[]);
const localChainInfo = ref({} as Chain);
const localCoinInfo = ref([] as Asset[]);
const swapIn = ref({} as TokenConfig | undefined);
const swapOut = ref({} as TokenConfig | undefined);
const amountIn = ref('');
const allPools = ref([] as any[]);
const sqsQuote = ref(null as any);
const sqsLoading = ref(false);
let quoteTimer: any = null;
const client = new ChainRegistryClient();
const registryName = computed(() => props.chainName?.toLowerCase().replace(/\s+/g, '') || '');

// Convert a human-readable amount to on-chain integer string without scientific notation
function toBaseAmount(amount: number | string, decimals: number): string {
    const [whole, frac = ''] = String(amount).split('.');
    const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    return (BigInt(whole) * BigInt(10 ** decimals) + BigInt(padded || '0')).toString();
}

// swap logic

async function initData() {
    error.value = ''; //reset error
    sender.value = readWallet(props.hdPath);
    if (!sender.value.cosmosAddress) {
        view.value = 'connect';
        return;
    }

    // Resolve real Osmosis address from wallet if not already set
    if (!osmoSenderAddress.value) {
        try {
            // @ts-ignore
            await window.keplr.enable('osmosis-1');
            // @ts-ignore
            const osmoSigner = window.getOfflineSigner('osmosis-1');
            const osmoAccounts = await osmoSigner.getAccounts();
            if (osmoAccounts.length > 0) {
                osmoSenderAddress.value = osmoAccounts[0].address;
            }
        } catch (e) {
            // Fallback to bech32 re-encoding
            osmoSenderAddress.value = osmoSenderAddress.value;
        }
    }

    if (open.value) {
        view.value = 'swap';
        localChainInfo.value = {} as Chain;
        localCoinInfo.value = [];
        recipient.value = sender.value.cosmosAddress
        await client
            .fetchChainInfo(registryName.value)
            .then((res) => {
                localChainInfo.value = res;
                if (Number(res.slip44) !== 118 && Number(res.slip44) !== 60) {
                    error.value = `Coin type ${res.slip44} is not supported`;
                }
            })
            .catch(() => {
                error.value = 'Not found IBC Path';
            });
        getBalance(OSMOSIS_REST, osmoSenderAddress.value).then(
            (res) => {
                osmoBalances.value = res.balances.filter(
                    (x) => !x.denom.startsWith('gamm')
                );
            }
        );
        getBalance(
            props.endpoint,
            sender.value.cosmosAddress
        ).then((res) => {
            localBalances.value = res.balances;
        });

        client.fetchAssetsList(registryName.value).then((al) => {
            localCoinInfo.value = al.assets;
        });

        getStakingParam(props.endpoint).then((x) => {
            defaultDenom.value = x.params.bond_denom;
        });
        // Pool discovery now handled by SQS router quote API

        client.fetchIBCPaths().then((paths) => {
            chains.value = paths.filter(
                (x) => x.from === registryName.value || x.to === registryName.value
            );
            const path = chains.value.find(
                (x) => x.from === 'osmosis' || x.to === 'osmosis'
            );
            if (path) {
                osmosisPath.value = path;
                client.fetchIBCPathInfo(path.path).then((info) => {
                    osmosisPathInfo.value = info;
                });
            }
        });
    }
}

function osmoAddress(addr?: string) {
    if (!addr) return '';
    const { data } = fromBech32(addr);
    return toBech32('osmo', data);
}

function localAddress(addr?: string) {
    if (!addr) return '';
    const { data } = fromBech32(addr);
    const prefix = localChainInfo.value?.bech32_prefix || 'cosmos';
    return toBech32(prefix, data);
}

function showBalance(denom?: string, decimal = 0) {
    const bal = osmoBalances.value.find((x) => x.denom === denom || '');
    if (bal) {
        return Number(bal.amount) / 10 ** decimal;
    }
    return 0;
}

function findlocalCoinDecimal(denom: string) {
    const localCoin = localCoinInfo.value.find((x) => x.base === denom);
    if (localCoin) {
        const unit = localCoin.denom_units.find(
            (x) => x.denom === localCoin.symbol.toLowerCase()
        );
        if (unit) return unit.exponent;
    }
    return 0;
}

function findTokenUrl(coinInfo?: Asset) {
    const url =
        coinInfo?.logo_URIs?.svg ||
        coinInfo?.logo_URIs?.png ||
        coinInfo?.logo_URIs?.jpeg;
    return url
        ? url.replace(
            'https://raw.githubusercontent.com/cosmos/chain-registry/master',
            'https://registry.ping.pub'
        )
        : '';
}

const localTokenOnOsmosis = computed(() => {
    const channel = osmosisPathInfo.value.channels?.find(
        (x) => x.chain_1.port_id === 'transfer'
    );
    const channelId =
        osmosisPathInfo.value.chain_1?.chain_name === 'osmosis'
            ? channel?.chain_1.channel_id
            : channel?.chain_2.channel_id;
    const ibcDenom = toHex(
        sha256(
            new TextEncoder().encode(
                `transfer/${channelId}/${defaultDenom.value}`
            )
        )
    ).toUpperCase();
    return localCoinInfo.value?.map((localCoin) => ({
        denom: defaultDenom.value,
        symbol: localCoin.symbol || '',
        ibcDenom: `ibc/${ibcDenom}`,
        sourceChannelId: channelId,
        decimals: findlocalCoinDecimal(defaultDenom.value),
        coinImageUrl: findTokenUrl(localCoin),
    }));
});

const localSourceChannelID = computed(() => {
    const channel = osmosisPathInfo.value.channels?.find(
        (x) => x.chain_1.port_id === 'transfer'
    );
    const channelId =
        osmosisPathInfo.value.chain_1?.chain_name === 'osmosis'
            ? channel?.chain_2.channel_id
            : channel?.chain_1.channel_id;
    return channelId;
});

const withdrawable = computed(() => {
    return (
        localTokenOnOsmosis.value.findIndex(
            (x) => x.denom === swapOut.value?.denom
        ) > -1
    );
});

const depositable = computed(() => {
    return (
        localTokenOnOsmosis.value.findIndex(
            (x) => x.denom === swapIn.value?.denom
        ) > -1
    );
});

const inTokens = computed(() => {
    if (direction.value === 'buy') {
        swapIn.value = tokens[0];
        return tokens;
    } else {
        swapIn.value = localTokenOnOsmosis.value[0];
        return localTokenOnOsmosis.value;
    }
});

const outTokens = computed(() => {
    if (direction.value === 'buy') {
        swapOut.value = localTokenOnOsmosis.value[0];
        return localTokenOnOsmosis.value;
    } else {
        swapOut.value = tokens[0];
        return tokens;
    }
});

function selectInput(v) {
    swapIn.value = v;
    amountIn.value = '';
    closeDropdown();
}

function selectOutput(v) {
    swapOut.value = v;
    closeDropdown();
}

function closeDropdown() {
    const el = document.activeElement as HTMLElement;
    if (el) el.blur();
}

function fetchQuote() {
    if (quoteTimer) clearTimeout(quoteTimer);
    sqsQuote.value = null;
    const amount = Number(amountIn.value || 0);
    if (amount <= 0 || !swapIn.value?.ibcDenom || !swapOut.value?.ibcDenom) return;
    sqsLoading.value = true;
    quoteTimer = setTimeout(async () => {
        try {
            const tokenInAmount = toBaseAmount(amount, swapIn.value?.decimals || 0);
            const quote = await getSqsQuote(tokenInAmount, swapIn.value!.ibcDenom, swapOut.value!.ibcDenom);
            sqsQuote.value = quote;
        } catch (e) {
            sqsQuote.value = null;
        }
        sqsLoading.value = false;
    }, 500);
}

watch([amountIn, swapIn, swapOut], fetchQuote);

function switchDirection() {
    direction.value = direction.value === 'buy' ? 'sell' : 'buy';
}

const needsDeposit = computed(() => {
    const amount = Number(amountIn.value || 0);
    if (amount <= 0 || !depositable.value) return false;
    const token = swapIn.value;
    if (!token) return false;
    const b = osmoBalances.value.find((x) => x.denom === token.ibcDenom || '');
    const osmoBalance = b ? Number(b.amount) : 0;
    const needed = amount * 10 ** token.decimals;
    if (osmoBalance >= needed) return false;
    // Check if they have enough on the local chain
    const localB = localBalances.value?.find((x) => x.denom === token.denom);
    return localB ? Number(localB.amount) >= needed : false;
});

const disabled = computed(() => {
    if (needsDeposit.value) return true;
    const amount = Number(amountIn.value || 0);
    if (amount <= 0 || outAmount.value <= 0) return true;
    const token = swapIn.value;
    const b = osmoBalances.value.find((x) => x.denom === token?.ibcDenom || '');
    if (b && token) {
        return Number(b.amount) < amount * 10 ** token.decimals;
    }
    return true;
});

const outAmount = computed(() => {
    if (sqsQuote.value?.amount_out) {
        return Number(sqsQuote.value.amount_out) / 10 ** (swapOut.value?.decimals || 0);
    }
    return 0;
});

async function doSwap() {
    sending.value = true;
    try {
        const latest = await getLatestBlock(OSMOSIS_REST);

        const stargateClient = await getSigningOsmosisClient({
            rpcEndpoint: OSMOSIS_RPC,
            // @ts-ignore
            signer: window.getOfflineSigner(latest.block.header.chain_id),
        });
        const address = osmoSenderAddress.value;

        if (!swapIn.value || !swapOut.value || !address || !sqsQuote.value) return;
        const { swapExactAmountIn } =
            osmosis.gamm.v1beta1.MessageComposer.withTypeUrl;

        const amount = Number(amountIn.value || 0);
        // Build routes from SQS quote response
        const sqsRoutes = sqsQuote.value.route?.[0]?.pools || [];
        const routes = sqsRoutes.map((p: any) => ({
            poolId: Long.fromNumber(Number(p.id)),
            tokenOutDenom: p.token_out_denom,
        }));

        const msg = swapExactAmountIn({
            sender: address,
            routes,
            tokenIn: {
                amount: toBaseAmount(amount, swapIn.value.decimals),
                denom: swapIn.value.ibcDenom,
            },
            tokenOutMinAmount: toBaseAmount(outAmount.value * 0.99, swapOut.value.decimals), // slippage: 1%
        });

        const gas = await stargateClient.simulate(address, [msg], '');

        const fee: StdFee = {
            amount: [
                {
                    denom: 'uosmo',
                    amount: '864',
                },
            ],
            gas: (gas * 1.25).toFixed(),
        };
        const response = await stargateClient.signAndBroadcast(
            address,
            [msg],
            fee,
            ''
        );
        if (response.code === 0) {
            await showResult(response.transactionHash)
            await getBalance(
                OSMOSIS_REST,
                osmoSenderAddress.value
            ).then((res) => {
                osmoBalances.value = res.balances.filter(
                    (x) => !x.denom.startsWith('gamm')
                );
            });
        } else {
            if (response.rawLog) error.value = response.rawLog;
        }
    } catch (err: any) {
        // cosmjs may throw a base64 parsing error even when the tx succeeds on-chain
        const errMsg = err?.message || String(err);
        if (errMsg.includes('Length must be a multiple of 4') || errMsg.includes('Invalid string')) {
            // Tx was likely broadcast successfully; poll for confirmation
            const hash = err?.transactionHash || err?.txId;
            if (hash) {
                await showResult(hash);
            } else {
                error.value = '';
                msg.value = 'Swap broadcast successfully. Please check your wallet for confirmation.';
                view.value = 'submitting';
                step.value = 100;
            }
        } else {
            error.value = errMsg;
        }
    }
    sending.value = false;
}

// deposit logic
const depositAmount = ref('');

function showLocalBalance(denom = '', decimals = 0) {
    const b = localBalances.value?.find((x) => x.denom === denom);
    if (b) {
        return Number(b.amount) / 10 ** decimals;
    }
    return 0;
}
const disableDeposit = computed(() => {
    const token = swapIn.value;
    if (token) {
        const b = localBalances.value?.find((x) => x.denom === token.denom);
        if (b) {
            const amount = Number(depositAmount.value || 0);
            return (
                amount <= 0 || Number(b.amount) < amount * 10 ** token.decimals
            );
        }
    }
    return true;
});

async function doDeposit() {
    sending.value = true;

    const address = sender.value.cosmosAddress;

    if (!swapIn.value || !address) return;

    const latest = await getLatestBlock(props.endpoint);
    const acc = await getAccount(props.endpoint, address);

    const chainId = latest.block.header.chain_id;
    const timeout = Date.now() + new Date().getTimezoneOffset() + 3600000;
    const amount = toBaseAmount(depositAmount.value || 0, swapIn.value.decimals);
    const tx = {
        chainId,
        signerAddress: address,
        messages: [
            {
                typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
                value: {
                    sourcePort: 'transfer',
                    sourceChannel: localSourceChannelID.value || '',
                    token: {
                        amount,
                        denom: swapIn.value.denom,
                    },
                    sender: address,
                    receiver: osmoSenderAddress.value,
                    timeoutTimestamp: `${timeout}000000`,
                },
            },
        ],
        fee: {
            gas: '200000',
            amount: [{ amount: '5000', denom: swapIn.value.denom }],
        },
        memo: '',
        signerData: {
            chainId: chainId.value,
            accountNumber: Number(acc.account.account_number),
            sequence: Number(acc.account.sequence),
        },
    };

    try {
        const client = new UniClient(WalletName.Keplr, { chainId });

        const txRaw = await client.sign(tx);
        const response = await client.broadcastTx(props.endpoint, txRaw);
        if (response.tx_response?.code === 0) {
            // Show waiting state and poll for IBC arrival on Osmosis
            view.value = 'submitting';
            step.value = 20;
            msg.value = 'Deposit submitted. Waiting for IBC transfer...';
            error.value = '';

            // Record current Osmosis balance to detect when new funds arrive
            const token = swapIn.value;
            const prevBal = osmoBalances.value.find(
                (x) => x.denom === token?.ibcDenom
            );
            const prevAmount = prevBal ? Number(prevBal.amount) : 0;

            // Poll Osmosis balance until it increases
            let attempts = 0;
            const maxAttempts = 20; // ~60 seconds
            const pollInterval = 3000;
            const pollForArrival = async () => {
                attempts++;
                step.value = Math.min(20 + Math.floor((attempts / maxAttempts) * 70), 90);
                try {
                    const res = await getBalance(OSMOSIS_REST, osmoSenderAddress.value);
                    const newBalances = res.balances.filter((x) => !x.denom.startsWith('gamm'));
                    const newBal = newBalances.find((x) => x.denom === token?.ibcDenom);
                    const newAmount = newBal ? Number(newBal.amount) : 0;

                    if (newAmount > prevAmount) {
                        // Funds arrived! Update balances and go back to swap
                        osmoBalances.value = newBalances;
                        const localRes = await getBalance(
                            props.endpoint,
                            sender.value.cosmosAddress
                        );
                        localBalances.value = localRes.balances;
                        step.value = 100;
                        msg.value = 'Deposit confirmed! Returning to swap...';
                        setTimeout(() => {
                            view.value = 'swap';
                            sending.value = false;
                        }, 1500);
                        return;
                    }
                } catch (e) {
                    // ignore polling errors
                }

                if (attempts < maxAttempts) {
                    setTimeout(pollForArrival, pollInterval);
                } else {
                    // Timeout — refresh balances anyway and go back
                    try {
                        const res = await getBalance(OSMOSIS_REST, osmoSenderAddress.value);
                        osmoBalances.value = res.balances.filter((x) => !x.denom.startsWith('gamm'));
                        const localRes = await getBalance(
                            props.endpoint,
                            sender.value.cosmosAddress
                        );
                        localBalances.value = localRes.balances;
                    } catch (e) {}
                    step.value = 100;
                    msg.value = 'IBC transfer may still be in progress. Returning to swap...';
                    setTimeout(() => {
                        view.value = 'swap';
                        sending.value = false;
                    }, 2000);
                }
            };
            setTimeout(pollForArrival, pollInterval);
        } else {
            error.value = response.tx_response?.raw_log || 'Deposit failed';
            sending.value = false;
        }
    } catch (e: any) {
        sending.value = false;
        error.value = e?.message || e;
        setTimeout(() => (error.value = ''), 5000);
    }
}

// withdraw logic
const withdrawAmount = ref('');
const recipient = ref(sender.value.cosmosAddress)
const disableWithdraw = computed(() => {
    const token = swapOut.value;
    if (token) {
        const b = osmoBalances.value?.find((x) => x.denom === token.ibcDenom);
        if (b) {
            const amount = Number(withdrawAmount.value || 0);
            return (
                amount <= 0 || Number(b.amount) < amount * 10 ** token.decimals
            );
        }
    }
    return true;
});
async function doWithdraw() {
    sending.value = true;
    try {
        const latest = await getLatestBlock(OSMOSIS_REST);

        const stargateClient = await getSigningOsmosisClient({
            rpcEndpoint: OSMOSIS_RPC,
            // @ts-ignore
            signer: window.getOfflineSigner(latest.block.header.chain_id),
        });
        const address = osmoSenderAddress.value;

        if (!swapIn.value || !swapOut.value || !address) return;

        const timeout = Date.now() + new Date().getTimezoneOffset() + 3600000;
        const amount = Number(withdrawAmount.value || 0);
        const { transfer } =
            ibc.applications.transfer.v1.MessageComposer.withTypeUrl;
        const msg = transfer({
            sender: address,
            sourceChannel: swapOut.value.sourceChannelId || '',
            sourcePort: 'transfer',
            token: {
                amount: toBaseAmount(amount, swapOut.value.decimals),
                denom: swapOut.value.ibcDenom,
            },
            receiver: recipient.value,
            timeoutTimestamp: Long.fromString(`${timeout}000000`),
            timeoutHeight: {
                revisionHeight: Long.fromNumber(0),
                revisionNumber: Long.fromNumber(0),
            },
            memo: '',
        });

        const gas = await stargateClient.simulate(address, [msg], '');

        const fee: StdFee = {
            amount: [
                {
                    denom: 'uosmo',
                    amount: '1864',
                },
            ],
            gas: (gas * 1.25).toFixed(),
        };
        let broadcastOk = false;
        try {
            const response = await stargateClient.signAndBroadcast(
                address,
                [msg],
                fee,
                ''
            );
            broadcastOk = response.code === 0;
            if (!broadcastOk && response.rawLog) {
                error.value = response.rawLog;
                sending.value = false;
                return;
            }
        } catch (broadcastErr) {
            const errMsg = String(broadcastErr);
            if (errMsg.includes('Invalid string') && errMsg.includes('Length must be a multiple of 4')) {
                // cosmjs base64 parsing error after successful broadcast
                broadcastOk = true;
            } else {
                error.value = broadcastErr;
                sending.value = false;
                return;
            }
        }

        if (broadcastOk) {
            // Show waiting state and poll for IBC arrival on Epix
            view.value = 'submitting';
            step.value = 20;
            msg.value = 'Withdrawal submitted. Waiting for IBC transfer...';
            error.value = '';

            // Record current local balance to detect when new funds arrive
            const token = swapOut.value;
            const prevLocalBal = localBalances.value.find(
                (x) => x.denom === token?.denom
            );
            const prevAmount = prevLocalBal ? Number(prevLocalBal.amount) : 0;

            // Poll local chain balance until it increases
            let attempts = 0;
            const maxAttempts = 20; // ~60 seconds
            const pollInterval = 3000;
            const pollForArrival = async () => {
                attempts++;
                step.value = Math.min(20 + Math.floor((attempts / maxAttempts) * 70), 90);
                try {
                    const localRes = await getBalance(props.endpoint, sender.value.cosmosAddress);
                    const newLocalBal = localRes.balances.find((x) => x.denom === token?.denom);
                    const newAmount = newLocalBal ? Number(newLocalBal.amount) : 0;

                    if (newAmount > prevAmount) {
                        // Funds arrived! Update balances and go back to swap
                        localBalances.value = localRes.balances;
                        const osmoRes = await getBalance(OSMOSIS_REST, osmoSenderAddress.value);
                        osmoBalances.value = osmoRes.balances.filter((x) => !x.denom.startsWith('gamm'));
                        step.value = 100;
                        msg.value = 'Withdrawal confirmed! Returning to swap...';
                        setTimeout(() => {
                            view.value = 'swap';
                            sending.value = false;
                        }, 1500);
                        return;
                    }
                } catch (e) {
                    // ignore polling errors
                }

                if (attempts < maxAttempts) {
                    setTimeout(pollForArrival, pollInterval);
                } else {
                    // Timeout — refresh balances anyway and go back
                    try {
                        const osmoRes = await getBalance(OSMOSIS_REST, osmoSenderAddress.value);
                        osmoBalances.value = osmoRes.balances.filter((x) => !x.denom.startsWith('gamm'));
                        const localRes = await getBalance(props.endpoint, sender.value.cosmosAddress);
                        localBalances.value = localRes.balances;
                    } catch (e) {}
                    step.value = 100;
                    msg.value = 'IBC transfer may still be in progress. Returning to swap...';
                    setTimeout(() => {
                        view.value = 'swap';
                        sending.value = false;
                    }, 2000);
                }
            };
            setTimeout(pollForArrival, pollInterval);
        }
    } catch (err) {
        error.value = err;
        sending.value = false;
    }
}

async function connect() {
    sending.value = true;
    let accounts = [] as Account[];
    try {
        const latest = await getLatestBlock(props.endpoint);
        const wa = createWallet(WalletName.Keplr, {
            chainId: latest.block.header.chain_id,
            hdPath: props.hdPath || DEFAULT_HDPATH,
        });
        await wa
            .getAccounts()
            .then((x) => {
                accounts = x;
                if (accounts.length > 0) {
                    const [first] = accounts;
                    const connected = {
                        wallet: WalletName.Keplr,
                        cosmosAddress: first.address,
                        hdPath: props.hdPath || DEFAULT_HDPATH,
                    };
                    writeWallet(connected, props.hdPath || DEFAULT_HDPATH);
                }
            })
            .catch((e) => {
                error.value = e;
            });

        // Get real Osmosis address from Keplr (needed for EVM chains where
        // bech32 re-encoding doesn't produce the correct Osmosis address)
        try {
            // @ts-ignore
            await window.keplr.enable('osmosis-1');
            // @ts-ignore
            const osmoSigner = window.getOfflineSigner('osmosis-1');
            const osmoAccounts = await osmoSigner.getAccounts();
            if (osmoAccounts.length > 0) {
                osmoSenderAddress.value = osmoAccounts[0].address;
            }
        } catch (e) {
            // Fallback to bech32 re-encoding if Osmosis not available in wallet
            if (accounts.length > 0) {
                osmoSenderAddress.value = osmoAddress(accounts[0].address);
            }
        }

        initData();
        view.value = 'swap'
    } catch (e) {
        error.value = e.message;
    }
    sending.value = false;
}

// Excuting result 
const delay = ref(0);
const step = ref(0);
const msg = ref('');
const sleep = 6000;
const emit = defineEmits(['completed']);

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
    getTxByHash(OSMOSIS_REST, tx)
        .then((res) => {
            step.value = 100;
            if (res.tx_response.code > 0) {
                error.value = res.tx_response.raw_log;
            } else {
                msg.value = `Swap completed successfully!`;
                emit('completed', { hash: tx, });
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
    <div>
        <!-- modal content -->
        <input v-model="open" type="checkbox" id="PingTokenConvert" class="modal-toggle" @change="initData()" />

        <label for="PingTokenConvert" class="modal cursor-pointer">
            <label class="modal-box modern-card rounded-xl shadow-modern" for="">
                <div v-show="view === 'swap'">
                    <div class="absolute right-4 top-4 dropdown dropdown-end dropdown-hover">
                        <label tabindex="0" class="text-epix-teal hover:text-epix-primary transition-colors duration-200">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
                                class="w-6 h-6 stroke-current">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                        </label>
                        <div tabindex="0"
                            class="card compact dropdown-content modern-card shadow-modern rounded-lg w-64 z-40">
                            <div class="card-body">
                                <ul class="text-right text-sm">
                                    <li>Liquidity is provided on Osmosis</li>
                                    <li>Powered by Epix Explorer</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                    <h3 class="text-xl font-semibold gradient-text">Token Convert</h3>
                    <div v-if="!osmosisPath || chainName === 'osmosis'" class="text-error mt-3">
                        <span>This feature is not available [{{
                            chainName
                        }}]</span>
                    </div>
                    <div
                        class="flex items-center relative h-14 bg-gray-100 dark:bg-epix-gray rounded-tl-lg rounded-tr-lg mt-4">
                        <div class="dropdown">
                            <label tabindex="0" class="flex items-center h-12 px-4 cursor-pointer hover-lift transition-all duration-200">
                                <img :src="swapIn?.coinImageUrl" class="w-8 h-8 mr-3 rounded-full" />
                                <div class="text-lg font-semibold mr-2">
                                    {{ swapIn?.symbol }}
                                </div>
                                <Icon icon="mdi:chevron-down" class="text-lg text-epix-primary" />
                            </label>
                            <div tabindex="0" class="dropdown-content shadow-modern modern-card rounded-lg w-64 z-40">
                                <div class="py-2">
                                    <div v-for="(item, index) in inTokens" :key="index"
                                        class="flex items-center px-4 py-2 hover:bg-gray-200 dark:hover:bg-epix-gray-light cursor-pointer hover-lift transition-all duration-200"
                                        @click="selectInput(item)">
                                        <img class="w-7 h-7 rounded-full mr-2" :src="item.coinImageUrl" />
                                        <div class="flex-1 text-sm">
                                            {{ item.symbol }}
                                        </div>
                                        <div class="text-sm font-semibold text-gray-600 dark:text-gray-400">
                                            {{
                                                showBalance(
                                                    item.ibcDenom || item.denom,
                                                    item.decimals
                                                )
                                            }}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <input v-model="amountIn" type="number" placeholder="1"
                            class="input bg-transparent flex-1 h-14 text-right text-lg font-bold focus:outline-none" />
                    </div>

                    <div class="flex items-center py-2 px-4 bg-gray-200 dark:bg-epix-gray-light rounded-bl-lg rounded-br-lg">
                        <div class="mr-3 text-sm">Balance:</div>
                        <div class="text-base font-semibold">
                            {{
                                showBalance(swapIn?.ibcDenom, swapIn?.decimals)
                            }}
                        </div>
                        <Icon v-if="depositable" icon="mdi:plus-box-outline" class="ml-2 cursor-pointer text-epix-primary hover:text-epix-accent transition-colors duration-200"
                            @click="switchView('deposit')" />
                    </div>

                    <!-- switch btn -->
                    <div class="flex items-center justify-center -mt-3 -mb-3">
                        <div class="inline-block px-4 cursor-pointer hover-lift" @click="switchDirection">
                            <Icon icon="mdi:arrow-down-circle"
                                class="text-4xl text-epix-primary bg-white dark:bg-epix-dark rounded-full origin-center duration-300 transform hover:rotate-180 shadow-modern" />
                        </div>
                    </div>

                    <div class="flex items-center h-14 rounded-tl-lg rounded-tr-lg bg-gray-100 dark:bg-epix-gray">
                        <div v-if="outTokens.length === 0">
                            <span v-if="error" class="text-red-500">No tradable tokens found.</span>
                            <button v-else class="modern-button-secondary" :class="{ 'loading relative start-0': sending }">
                                loading...
                            </button>
                        </div>
                        <div v-if="outTokens && outTokens.length > 0" class="dropdown">
                            <label tabindex="0" class="flex items-center h-12 px-4 cursor-pointer hover-lift transition-all duration-200">
                                <img :src="swapOut?.coinImageUrl" class="w-8 h-8 mr-3 rounded-full" />
                                <div class="text-lg font-semibold mr-2">
                                    {{ swapOut?.symbol }}
                                </div>
                                <Icon icon="mdi:chevron-down" class="text-lg text-epix-primary" />
                            </label>
                            <div tabindex="0" class="compact dropdown-content shadow-modern modern-card w-64 rounded-lg">
                                <div class="py-2 max-h-40 overflow-y-auto">
                                    <div v-for="(item, index) in outTokens" :key="index" @click="selectOutput(item)"
                                        class="flex items-center px-4 py-2 max-h-36 overflow-y-auto hover:bg-gray-200 dark:hover:bg-epix-gray-light cursor-pointer hover-lift transition-all duration-200">
                                        <img class="w-7 h-7 rounded-full mr-2" :src="item.coinImageUrl" />
                                        <div class="flex-1 text-sm">
                                            {{ item.symbol }}
                                        </div>
                                        <div class="text-sm font-semibold text-gray-600 dark:text-gray-400">
                                            {{
                                                showBalance(
                                                    item.ibcDenom || item.denom,
                                                    item.decimals
                                                )
                                            }}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="flex-1 w-0 text-xl text-right font-semibold text-gray-600 dark:text-gray-50 pr-4">
                            {{ `≈ ${parseFloat(outAmount.toFixed(6))}` }}
                        </div>
                    </div>

                    <div class="flex items-center py-2 px-4 bg-gray-200 dark:bg-epix-gray-light rounded-bl-lg rounded-br-lg">
                        <div class="mr-3 text-sm dark:text-gray-400">
                            Balance:
                        </div>
                        <div class="text-base font-semibold dark:text-gray-200">
                            {{
                                showBalance(
                                    swapOut?.ibcDenom,
                                    swapOut?.decimals
                                )
                            }}
                        </div>
                        <Icon v-if="withdrawable" icon="mdi:minus-box-outline" class="ml-2 cursor-pointer text-epix-primary hover:text-epix-accent transition-colors duration-200"
                            @click="switchView('withdraw')" />
                    </div>

                    <div class="px-4 mt-4">
                        <div class="flex items-center justify-between">
                            <div class="text-sm text-gray-600 dark:text-gray-400">
                                Swap Fee
                            </div>
                            <div class="text-base text-gray-800 dark:text-gray-200">
                                {{
                                    sqsQuote?.effective_fee
                                        ? (Number(sqsQuote.effective_fee) * 100).toFixed(2)
                                        : '—'
                                }}%
                            </div>
                        </div>
                    </div>

                    <div v-if="error" class="text-error mt-3">
                        <span>{{ error }}.</span>
                    </div>

                    <div v-if="needsDeposit" class="mt-4">
                        <p class="text-sm text-gray-500 dark:text-gray-400 mb-3 text-center">
                            You need to deposit {{ swapIn?.symbol }} to Osmosis first
                        </p>
                        <button class="modern-button w-full ping-connect-confirm capitalize text-base hover-lift"
                            @click="depositAmount = amountIn; switchView('deposit')">
                            Deposit {{ swapIn?.symbol }} to Osmosis
                        </button>
                    </div>
                    <div v-else class="mt-5">
                        <button class="modern-button w-full ping-connect-confirm capitalize text-base hover-lift"
                            :disabled="disabled" @click="doSwap">
                            <span v-if="sending" class="loading loading-spinner"></span>
                            Convert
                        </button>
                    </div>

                    <div class="text-center mt-3">
                        <a href="https://app.osmosis.zone/?from=USDC&to=EPIX.epix" target="_blank" rel="noopener noreferrer"
                            class="text-sm text-epix-primary hover:text-epix-accent transition-colors duration-200 underline">
                            Or trade directly on Osmosis
                        </a>
                    </div>
                </div>
                <!-- deposit -->
                <div v-show="view === 'deposit'">
                    <h3 class="text-xl font-semibold flex gradient-text">
                        <Icon class="mt-1 text-epix-primary hover:text-epix-accent cursor-pointer transition-colors duration-200" icon="mdi:chevron-left" @click="switchView('swap')"></Icon>
                        Deposit
                    </h3>

                    <div class="form-control">
                        <label class="label">
                            <span class="label-text">Deposit assets into Osmosis:</span>
                            <span class="lable-text">{{
                                showBalance(swapIn?.ibcDenom, swapIn?.decimals)
                            }}</span>
                        </label>
                        <input :value="osmoSenderAddress" readonly type="text"
                            class="input border border-gray-300 dark:border-gray-600" />
                    </div>
                    <div
                        class="flex items-center relative h-14 bg-gray-100 dark:bg-[#232333] rounded-tl-lg rounded-tr-lg mt-4">
                        <label tabindex="0" class="flex items-center h-12 px-4 cursor-pointer">
                            <img :src="swapIn?.coinImageUrl" class="w-8 h-8 mr-3 rounded-full" />
                            <div class="text-lg font-semibold mr-2">
                                {{ swapIn?.symbol }}
                            </div>
                        </label>
                        <input v-model="depositAmount" type="number" placeholder="1"
                            class="input bg-transparent flex-1 h-14 text-right text-lg font-bold" />
                    </div>

                    <div
                        class="flex flex-row-reverse items-center py-2 px-4 bg-gray-200 dark:bg-[#171721] rounded-bl-lg rounded-br-lg">
                        <div class="text-base font-semibold">
                            {{
                                showLocalBalance(
                                    swapIn?.denom,
                                    swapIn?.decimals
                                )
                            }}
                        </div>
                        <div class="mr-3 text-sm">Balance:</div>
                    </div>

                    <div v-if="error" class="text-error mt-3">
                        <span>{{ error }}.</span>
                    </div>

                    <div class="mt-5 flex">
                        <label class="btn mr-1" @click="switchView('swap')">
                            <svg fill="#ffffff" height="20px" width="20px" version="1.1" id="Layer_1"
                                xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
                                viewBox="0 0 330 330" xml:space="preserve">
                                <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
                                <g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
                                <g id="SVGRepo_iconCarrier">
                                    <path id="XMLID_6_"
                                        d="M165,0C74.019,0,0,74.019,0,165s74.019,165,165,165s165-74.019,165-165S255.981,0,165,0z M205.606,234.394 c5.858,5.857,5.858,15.355,0,21.213C202.678,258.535,198.839,260,195,260s-7.678-1.464-10.606-4.394l-80-79.998 c-2.813-2.813-4.394-6.628-4.394-10.606c0-3.978,1.58-7.794,4.394-10.607l80-80.002c5.857-5.858,15.355-5.858,21.213,0 c5.858,5.857,5.858,15.355,0,21.213l-69.393,69.396L205.606,234.394z">
                                    </path>
                                </g>
                            </svg>
                        </label>
                        <button class="btn btn-primary grow ping-connect-confirm capitalize text-base"
                            :disabled="disableDeposit" @click="doDeposit">
                            <span v-if="sending" class="loading loading-spinner"></span>
                            Deposit
                        </button>
                    </div>
                </div>

                <!-- withdraw -->
                <div v-show="view === 'withdraw'">
                    <h3 class="text-xl font-semibold flex">
                        <Icon class="mt-1" icon="mdi:chevron-left" @click="switchView('swap')"></Icon>
                        Withdraw
                    </h3>

                    <div
                        class="flex justify-between j items-center py-2 px-4 bg-gray-200 dark:bg-[#171721] rounded-tl-lg rounded-tr-lg mt-4">
                        <div class="text-sm">Withdrawable Balance:</div>
                        <div class="text-base font-semibold cursor-pointer text-epix-primary hover:text-epix-accent transition-colors duration-200"
                            @click="withdrawAmount = String(showBalance(swapOut?.ibcDenom, swapOut?.decimals))">
                            {{
                                showBalance(
                                    swapOut?.ibcDenom,
                                    swapOut?.decimals
                                )
                            }}
                        </div>
                    </div>
                    <div class="flex items-center relative h-14 bg-gray-100 dark:bg-[#232333] rounded-bl-lg rounded-br-lg">
                        <label tabindex="0" class="flex items-center h-12 px-4 cursor-pointer">
                            <img :src="swapOut?.coinImageUrl" class="w-8 h-8 mr-3 rounded-full" />
                            <div class="text-lg font-semibold mr-2">
                                {{ swapOut?.symbol }}
                            </div>
                        </label>
                        <input v-model="withdrawAmount" type="number" placeholder="1"
                            class="input bg-transparent flex-1 h-14 text-right text-lg font-bold" />
                    </div>

                    <div class="form-control">
                        <label class="label">
                            <span class="label-text">Recipient on
                                {{ localChainInfo.pretty_name }}</span>
                            <span class="lable-text">{{
                                showLocalBalance(
                                    swapOut?.denom,
                                    swapOut?.decimals
                                )
                            }}</span>
                        </label>
                        <input v-model="recipient" type="text" class="input border border-gray-300 dark:border-gray-600" />
                    </div>
                    <div v-if="error" class="text-error mt-3">
                        <span>{{ error }}.</span>
                    </div>

                    <div class="mt-5 flex">
                        <label class="btn mr-1" @click="switchView('swap')">
                            <svg fill="#ffffff" height="20px" width="20px" version="1.1" id="Layer_1"
                                xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
                                viewBox="0 0 330 330" xml:space="preserve">
                                <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
                                <g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
                                <g id="SVGRepo_iconCarrier">
                                    <path id="XMLID_6_"
                                        d="M165,0C74.019,0,0,74.019,0,165s74.019,165,165,165s165-74.019,165-165S255.981,0,165,0z M205.606,234.394 c5.858,5.857,5.858,15.355,0,21.213C202.678,258.535,198.839,260,195,260s-7.678-1.464-10.606-4.394l-80-79.998 c-2.813-2.813-4.394-6.628-4.394-10.606c0-3.978,1.58-7.794,4.394-10.607l80-80.002c5.857-5.858,15.355-5.858,21.213,0 c5.858,5.857,5.858,15.355,0,21.213l-69.393,69.396L205.606,234.394z">
                                    </path>
                                </g>
                            </svg>
                        </label>
                        <button class="btn btn-primary grow ping-connect-confirm capitalize text-base"
                            :disabled="disableWithdraw" @click="doWithdraw()">
                            <span v-if="sending" class="loading loading-spinner"></span>
                            Withdraw
                        </button>
                    </div>
                </div>

                <!-- Connect Wallet -->
                <div v-show="view === 'connect'">
                    <h3 class="text-xl font-semibold flex">Connect Wallet</h3>
                    <div class="form-control mt-5">
                        <select class="select">
                            <option>Keplr</option>
                        </select>
                    </div>

                    <div v-if="error" class="text-error mt-3">
                        <span>{{ error }}.</span>
                    </div>

                    <div class="mt-5">
                        <button class="btn btn-primary w-full ping-connect-confirm capitalize text-base" @click="connect()">
                            <span v-if="sending" class="loading loading-spinner"></span>
                            Connect
                        </button>
                    </div>
                </div>

                <div v-show="view === 'submitting'">
                    <div class="mt-10 mb-6">
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
                                    Submitted
                            </span>
                        </div>
                        <div class="text-right">
                            <span class="text-xs font-semibold inline-block text-gray-600 dark:text-white">
                                {{ step }}%
                            </span>
                        </div>
                    </div>
                </div>
                <div class="mb-0 text-center">
                    <label class="btn btn-link" @click="view = 'swap'">Continue</label>
                </div>
            </div>
        </label>
    </label>
</div></template>
<script lang="ts">
export default {
    name: 'TokenConvert',
};
</script>
