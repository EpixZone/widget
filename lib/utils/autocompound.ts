import { fromBech32, toBech32 } from '@cosmjs/encoding';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { StakeAuthorization } from 'cosmjs-types/cosmos/staking/v1beta1/authz';
import { TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';

export const DELEGATE = '/cosmos.staking.v1beta1.MsgDelegate';
export const WITHDRAW_REWARD = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward';
export const STAKE_AUTHORIZATION = '/cosmos.staking.v1beta1.StakeAuthorization';
export type AutocompoundAction = 'autocompound' | 'autocompound_revoke';

export interface AutocompoundParams {
    expected_chain_id: string;
    operator_address: string;
    operator_name: string;
    validator_address?: string;
    existing_grant: boolean;
    message_type?: typeof DELEGATE | typeof WITHDRAW_REWARD;
}

export function epixAddress(value: unknown, prefix: 'epix' | 'epixvaloper'): string {
    if (typeof value !== 'string') throw new Error(`A valid ${prefix} address is required`);
    try {
        const decoded = fromBech32(value);
        if (decoded.prefix !== prefix || decoded.data.length !== 20 ||
            toBech32(prefix, decoded.data) !== value) throw new Error();
    } catch {
        throw new Error(`Invalid ${prefix} address`);
    }
    return value;
}

export function autocompoundParams(json: string | undefined, action: AutocompoundAction): AutocompoundParams {
    const value: unknown = JSON.parse(json || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid auto-compound details');
    const p = value as Record<string, unknown>;
    if (typeof p.expected_chain_id !== 'string' || !/^epix_\d+-\d+$/.test(p.expected_chain_id)) {
        throw new Error('An expected Epix chain ID is required');
    }
    const params: AutocompoundParams = {
        expected_chain_id: p.expected_chain_id,
        operator_address: epixAddress(p.operator_address, 'epix'),
        operator_name: typeof p.operator_name === 'string' ? p.operator_name.slice(0, 128) : '',
        existing_grant: p.existing_grant === true,
    };
    if (action === 'autocompound') {
        params.validator_address = epixAddress(p.validator_address, 'epixvaloper');
    } else {
        if (p.message_type !== DELEGATE && p.message_type !== WITHDRAW_REWARD) {
            throw new Error('Only delegate or legacy reward-withdraw grants can be revoked here');
        }
        params.message_type = p.message_type;
    }
    return params;
}

// Keep user input as decimal text. Number would round an 18-decimal EPIX cap.
export function epixCap(value: string): string {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) {
        throw new Error('Enter a positive EPIX cap with at most 18 decimal places');
    }
    const [whole, fraction = ''] = value.split('.');
    const amount = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
    if (amount <= 0n || amount >= 2n ** 256n) throw new Error('EPIX cap is outside the supported range');
    return amount.toString();
}

export function localDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function expirySeconds(value: string, now = Date.now()): bigint {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose an expiry date and time');
    const date = new Date(`${value}:00`);
    if (!Number.isFinite(date.getTime()) || localDateTime(date) !== value || date.getTime() <= Math.max(0, now)) {
        throw new Error('Expiry must be a valid date and time in the future');
    }
    return BigInt(Math.floor(date.getTime() / 1000));
}

export function grantMessage(sender: string, p: AutocompoundParams, cap: string, expiry: string, now = Date.now()): EncodeObject {
    const validator = epixAddress(p.validator_address, 'epixvaloper');
    return {
        typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
        value: {
            granter: epixAddress(sender, 'epix'),
            grantee: epixAddress(p.operator_address, 'epix'),
            grant: {
                authorization: {
                    typeUrl: STAKE_AUTHORIZATION,
                    value: StakeAuthorization.encode(StakeAuthorization.fromPartial({
                        authorizationType: 1,
                        allowList: { address: [validator] },
                        maxTokens: { denom: 'aepix', amount: epixCap(cap) },
                    })).finish(),
                },
                expiration: { seconds: expirySeconds(expiry, now), nanos: 0 },
            },
        },
    };
}

export function revokeMessage(sender: string, p: AutocompoundParams): EncodeObject {
    if (p.message_type !== DELEGATE && p.message_type !== WITHDRAW_REWARD) throw new Error('Unsupported grant type');
    return { typeUrl: '/cosmos.authz.v1beta1.MsgRevoke', value: {
        granter: epixAddress(sender, 'epix'), grantee: epixAddress(p.operator_address, 'epix'), msgTypeUrl: p.message_type,
    } };
}

async function readJson(url: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Chain query failed (${response.status})`);
        const result = await response.json();
        if (result.code) throw new Error(result.message || 'Chain query failed');
        return result;
    } finally { clearTimeout(timer); }
}

export async function checkAutocompoundChain(endpoint: string, p: AutocompoundParams, sender: string): Promise<string> {
    epixAddress(sender, 'epix');
    const base = endpoint.replace(/\/$/, '');
    const [block, staking] = await Promise.all([
        readJson(`${base}/cosmos/base/tendermint/v1beta1/blocks/latest`),
        readJson(`${base}/cosmos/staking/v1beta1/params`),
    ]);
    if ((block.block?.header?.chain_id || block.sdk_block?.header?.chain_id) !== p.expected_chain_id) throw new Error('Endpoint chain does not match the selected Epix chain');
    const height = block.block?.header?.height || block.sdk_block?.header?.height;
    if (typeof height !== 'string' || !/^[1-9]\d*$/.test(height) || BigInt(height) >= 2n ** 64n) throw new Error('Invalid chain height');
    if (staking.params?.bond_denom !== 'aepix') throw new Error('Endpoint staking token is not aepix');
    if (!p.validator_address) return height; // Revocation remains possible after staking conditions change.
    const [withdraw, delegation, validator] = await Promise.all([
        readJson(`${base}/cosmos/distribution/v1beta1/delegators/${sender}/withdraw_address`),
        readJson(`${base}/cosmos/staking/v1beta1/validators/${p.validator_address}/delegations/${sender}`),
        readJson(`${base}/cosmos/staking/v1beta1/validators/${p.validator_address}`),
    ]);
    if (validator.validator?.operator_address !== p.validator_address || validator.validator.jailed !== false ||
        !['BOND_STATUS_BONDED', 3, '3'].includes(validator.validator.status)) {
        throw new Error('Auto-compound requires an active, unjailed validator');
    }
    if (withdraw.withdraw_address !== sender) throw new Error('REStake requires your reward withdrawal address to be your own address');
    const amount = delegation.delegation_response?.balance;
    if (amount?.denom !== 'aepix' || typeof amount.amount !== 'string' || !/^\d+$/.test(amount.amount) || BigInt(amount.amount) <= 0n) {
        throw new Error('Delegate to this validator before enabling auto-compound');
    }
    return height;
}

export async function currentAuthorization(endpoint: string, sender: string, details: AutocompoundParams): Promise<string> {
    const query = new URLSearchParams({ granter: sender, grantee: details.operator_address, msg_type_url: details.message_type || DELEGATE });
    const response = await readJson(`${endpoint.replace(/\/$/, '')}/cosmos/authz/v1beta1/grants?${query}`);
    if (!Array.isArray(response.grants) || response.pagination?.next_key) throw new Error('Unable to refresh the complete current grant');
    return response.grants.length ? JSON.stringify(response.grants, null, 2) : 'No current grant for this operator and permission.';
}

export function assertReviewedMessages(raw: TxRaw, reviewed: readonly { typeUrl: string; value: Uint8Array }[], timeoutHeight?: string): void {
    const body = TxBody.decode(raw.bodyBytes);
    if (timeoutHeight && body.timeoutHeight !== BigInt(timeoutHeight)) throw new Error('Wallet changed the transaction timeout height');
    const signed = body.messages;
    if (signed.length !== reviewed.length || signed.some((message, index) =>
        message.typeUrl !== reviewed[index].typeUrl || message.value.length !== reviewed[index].value.length ||
        message.value.some((byte, offset) => byte !== reviewed[index].value[offset]))) {
        throw new Error('The signed authorization differs from the reviewed transaction');
    }
}
