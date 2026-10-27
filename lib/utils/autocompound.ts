import { fromBech32, toBech32 } from '@cosmjs/encoding';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { StakeAuthorization } from 'cosmjs-types/cosmos/staking/v1beta1/authz';
import { TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';

export const DELEGATE = '/cosmos.staking.v1beta1.MsgDelegate';
export const WITHDRAW_REWARD = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward';
export const STAKE_AUTHORIZATION = '/cosmos.staking.v1beta1.StakeAuthorization';
export type AutocompoundAction = 'autocompound' | 'autocompound_revoke';
export type AutocompoundIntent = 'turn_on' | 'renew' | 'raise_limit' | 'change';
export const AUTOCOMPOUND_INTENTS: readonly AutocompoundIntent[] = ['turn_on', 'renew', 'raise_limit', 'change'];

export interface AutocompoundParams {
    expected_chain_id: string;
    operator_address: string;
    operator_name: string;
    validator_address?: string;
    existing_grant: boolean;
    message_type?: typeof DELEGATE | typeof WITHDRAW_REWARD;
    // Optional display-only keys. An invalid value is dropped as if absent; it never fails the dialog.
    validator_name?: string;
    intent?: AutocompoundIntent;
    stake_amount?: string;
    apr?: string;
    schedule?: string;
    current_cap?: string;
    current_cap_unlimited?: boolean;
    current_expiration?: string;
    minimum_reward?: string;
    rewards_amount?: string;
    unbonding_seconds?: string;
}

const EPIX = 10n ** 18n;
const INTEGER = /^(?:0|[1-9]\d*)$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

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

function optionalText(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    return text ? text.slice(0, max) : undefined;
}

function optionalInteger(value: unknown): string | undefined {
    return typeof value === 'string' && INTEGER.test(value) && BigInt(value) < 2n ** 256n ? value : undefined;
}

function optionalApr(value: unknown): string | undefined {
    if (typeof value !== 'string' || !DECIMAL.test(value)) return undefined;
    const rate = Number(value);
    return rate > 0 && rate < 10 ? value : undefined;
}

function optionalIsoDate(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return Number.isFinite(new Date(value).getTime()) ? value : undefined;
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
    const validatorName = optionalText(p.validator_name, 128);
    if (validatorName !== undefined) params.validator_name = validatorName;
    if (action === 'autocompound') {
        params.validator_address = epixAddress(p.validator_address, 'epixvaloper');
        const optional: Partial<AutocompoundParams> = {
            intent: AUTOCOMPOUND_INTENTS.find(intent => intent === p.intent),
            stake_amount: optionalInteger(p.stake_amount),
            apr: optionalApr(p.apr),
            schedule: optionalText(p.schedule, 160),
            current_cap: optionalInteger(p.current_cap),
            current_cap_unlimited: p.current_cap_unlimited === true ? true : undefined,
            current_expiration: optionalIsoDate(p.current_expiration),
            minimum_reward: optionalInteger(p.minimum_reward),
            rewards_amount: optionalInteger(p.rewards_amount),
            unbonding_seconds: optionalInteger(p.unbonding_seconds),
        };
        for (const [key, item] of Object.entries(optional)) {
            if (item !== undefined) (params as unknown as Record<string, unknown>)[key] = item;
        }
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

// ---- Display helpers (exact; no Number touches an amount) ----

export function withSeparators(decimalText: string): string {
    const [whole, fraction] = decimalText.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fraction ? `${grouped}.${fraction}` : grouped;
}

// Base units (aepix) to EPIX decimal text without separators, e.g. '460000' or '3.2'.
export function baseToEpixText(amount: bigint | string): string {
    const value = BigInt(amount);
    const whole = value / EPIX;
    const fraction = (value % EPIX).toString().padStart(18, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Base units to grouped EPIX text truncated to `maxDecimals`, e.g. '296,829' or '1.19'. '' for non-integers.
export function formatEpix(base: string | bigint | undefined, maxDecimals = 2): string {
    if (base === undefined || !INTEGER.test(String(base))) return '';
    const value = BigInt(base);
    const whole = withSeparators((value / EPIX).toString());
    const fraction = (value % EPIX).toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

// Whole EPIX text, rounded up, for prefilling a whole-EPIX limit from a base-unit amount.
export function ceilEpix(base: string): string {
    if (!INTEGER.test(base)) return '';
    return ((BigInt(base) + EPIX - 1n) / EPIX).toString();
}

// bech32-aware: hrp + '1' + first 4 + '…' + last 6 of the data part; 10/6 fallback when it is not bech32.
export function shortAddress(address: string): string {
    if (typeof address !== 'string') return '';
    try {
        const { prefix } = fromBech32(address);
        const data = address.slice(prefix.length + 1);
        if (data.length > 10) return `${address.slice(0, prefix.length)}1${data.slice(0, 4)}…${data.slice(-6)}`;
    } catch { /* not bech32 */ }
    return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}

// ---- Recommended limit (A07): stake × (e^(apr × days/365) − 1) × 1.5, rounded up to two significant digits, at least 1 EPIX ----

const SCALE = 10n ** 12n;

// Rewards over `days` at a continuously compounded annual rate, in base units: stake × (e^(apr × days/365) − 1).
// The exponential uses Number once and is converted to a fixed-point BigInt before it touches the stake.
export function projectedRewards(stake: string | undefined, apr: string | undefined, days: number): string {
    if (stake === undefined || !INTEGER.test(stake) || optionalApr(apr) === undefined || !Number.isFinite(days) || days < 0) return '';
    const factor = Math.exp(Number(apr) * days / 365) - 1;
    if (!Number.isFinite(factor) || factor >= 1e15) return '';
    const scaled = BigInt(factor.toFixed(12).replace('.', ''));
    return ((BigInt(stake) * scaled + SCALE - 1n) / SCALE).toString();
}

function ceilToSignificant(amount: bigint, digits: number): bigint {
    const text = amount.toString();
    if (text.length <= digits) return amount;
    const unit = 10n ** BigInt(text.length - digits);
    return ((amount + unit - 1n) / unit) * unit;
}

// EPIX decimal text that `epixCap` accepts, or '' when the stake or rate is unknown. Days are clamped to one year.
export function recommendedCap(stake: string | undefined, apr: string | undefined, days: number): string {
    if (!Number.isFinite(days)) return '';
    const rewards = projectedRewards(stake, apr, Math.min(Math.max(days, 0), 365));
    if (!rewards) return '';
    let amount = (BigInt(rewards) * 3n + 1n) / 2n;
    if (amount < EPIX) amount = EPIX;
    return baseToEpixText(ceilToSignificant(amount, 2));
}

// Days of rewards an amount represents at a linear rate (amount ÷ (stake × apr ÷ 365)); null when unknown.
export function daysOfRewards(amount: string | undefined, stake: string | undefined, apr: string | undefined): number | null {
    if (amount === undefined || !INTEGER.test(amount) || stake === undefined || !INTEGER.test(stake) || BigInt(stake) === 0n) return null;
    if (optionalApr(apr) === undefined) return null;
    const [whole, fraction = ''] = (apr as string).split('.');
    const rate = BigInt(whole + fraction.padEnd(9, '0').slice(0, 9)); // apr × 1e9
    if (rate === 0n) return null;
    // Microday precision keeps sub-day cycles honest (a 10 EPIX minimum on a large stake is minutes, not a multiple of
    // 0.01 days); values of a day or more keep the two-decimal truncation the pinned figures rely on.
    const micro = BigInt(amount) * 365n * 10n ** 9n * 10n ** 6n / (BigInt(stake) * rate);
    const days = Number(micro) / 1e6;
    return days >= 1 ? Math.floor(days * 100) / 100 : days;
}

// Days until accrued rewards reach the service minimum; null when the minimum or the rate is unknown.
export function thresholdDays(minimum: string | undefined, rewards: string | undefined, stake: string | undefined, apr: string | undefined): number | null {
    if (minimum === undefined || !INTEGER.test(minimum)) return null;
    const waiting = rewards !== undefined && INTEGER.test(rewards) ? BigInt(rewards) : 0n;
    const remaining = BigInt(minimum) > waiting ? BigInt(minimum) - waiting : 0n;
    return daysOfRewards(remaining.toString(), stake, apr);
}

export function humanDuration(days: number): string {
    if (!Number.isFinite(days) || days < 0) return '';
    const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    if (days < 1 / 24) return unit(Math.max(1, Math.round(days * 1440)), 'minute');
    if (days < 1) return unit(Math.max(1, Math.round(days * 24)), 'hour');
    if (days < 14) return unit(Math.max(1, Math.round(days)), 'day');
    if (days < 60) return unit(Math.round(days / 7), 'week');
    if (days < 365) return unit(Math.round(days / 30.4375), 'month');
    const years = days / 365.25;
    return unit(years < 10 ? Math.round(years * 10) / 10 : Math.round(years), 'year');
}

// "every N minutes/hours/days" in a schedule text → days between runs; null when the text states no such interval.
export function scheduleIntervalDays(schedule: string | undefined): number | null {
    const match = schedule ? /every\s+(\d+)?\s*(minute|hour|day)s?/i.exec(schedule) : null;
    if (!match) return null;
    const count = match[1] ? Number(match[1]) : 1;
    if (!Number.isFinite(count) || count <= 0) return null;
    const unit = match[2].toLowerCase();
    return unit === 'minute' ? count / 1440 : unit === 'hour' ? count / 24 : count;
}

// ---- Duration presets (A19): now + N days at the same wall-clock minute ----

export interface DurationPreset { id: string; label: string; days: number }
export const DURATION_PRESETS: readonly DurationPreset[] = [
    { id: '3m', label: '3 months', days: 91 },
    { id: '6m', label: '6 months', days: 182 },
    { id: '1y', label: '1 year', days: 365 },
];
export const DEFAULT_DURATION = '1y';

export function localDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Calendar arithmetic keeps the wall-clock minute across daylight-saving changes.
export function presetExpiry(days: number, now = new Date()): string {
    const date = new Date(now.getTime());
    date.setDate(date.getDate() + days);
    return localDateTime(date);
}

// datetime-local text for an ISO instant, rounded up to the next minute so a kept end date never moves earlier.
export function expiryFromIso(iso: string): string {
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return '';
    return localDateTime(new Date(Math.ceil(time / 60000) * 60000));
}

// Fractional days from now until a datetime-local value; 0 when invalid or past.
export function durationDays(expiry: string, now = Date.now()): number {
    if (!LOCAL_DATE_TIME.test(expiry)) return 0;
    const time = new Date(`${expiry}:00`).getTime();
    return Number.isFinite(time) ? Math.max(0, (time - now) / 86400000) : 0;
}

export function formatLocalDateTime(expiry: string, withTime = true): string {
    if (!LOCAL_DATE_TIME.test(expiry)) return '';
    const date = new Date(`${expiry}:00`);
    if (!Number.isFinite(date.getTime())) return '';
    return withTime ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatIsoDate(iso: string, withTime = false): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    return withTime ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function expirySeconds(value: string, now = Date.now()): bigint {
    if (!LOCAL_DATE_TIME.test(value)) throw new Error('Choose an expiry date and time');
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

const WRONG_NETWORK = 'This explorer is connected to a different network than expected. Close this and reload the page.';

export async function checkAutocompoundChain(endpoint: string, p: AutocompoundParams, sender: string): Promise<string> {
    epixAddress(sender, 'epix');
    const name = p.validator_name || p.operator_name || 'This validator';
    const base = endpoint.replace(/\/$/, '');
    const [block, staking] = await Promise.all([
        readJson(`${base}/cosmos/base/tendermint/v1beta1/blocks/latest`),
        readJson(`${base}/cosmos/staking/v1beta1/params`),
    ]);
    if ((block.block?.header?.chain_id || block.sdk_block?.header?.chain_id) !== p.expected_chain_id) throw new Error(WRONG_NETWORK);
    const height = block.block?.header?.height || block.sdk_block?.header?.height;
    if (typeof height !== 'string' || !/^[1-9]\d*$/.test(height) || BigInt(height) >= 2n ** 64n) throw new Error('Invalid chain height');
    if (staking.params?.bond_denom !== 'aepix') throw new Error(WRONG_NETWORK);
    if (!p.validator_address) return height; // Revocation remains possible after staking conditions change.
    const [withdraw, delegation, validator] = await Promise.all([
        readJson(`${base}/cosmos/distribution/v1beta1/delegators/${sender}/withdraw_address`),
        readJson(`${base}/cosmos/staking/v1beta1/validators/${p.validator_address}/delegations/${sender}`),
        readJson(`${base}/cosmos/staking/v1beta1/validators/${p.validator_address}`),
    ]);
    if (validator.validator?.operator_address !== p.validator_address || validator.validator.jailed !== false ||
        !['BOND_STATUS_BONDED', 3, '3'].includes(validator.validator.status)) {
        throw new Error(`${name} is jailed or inactive right now, so auto-compound can't be turned on.`);
    }
    if (withdraw.withdraw_address !== sender) throw new Error('Your rewards are paid to a different address. Auto-compound needs them paid to this account.');
    const amount = delegation.delegation_response?.balance;
    if (amount?.denom !== 'aepix' || typeof amount.amount !== 'string' || !/^\d+$/.test(amount.amount) || BigInt(amount.amount) <= 0n) {
        throw new Error(`You don't have EPIX staked with ${name}.`);
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
