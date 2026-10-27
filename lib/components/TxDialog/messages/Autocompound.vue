<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EncodeObject } from '@cosmjs/proto-signing';
import {
    autocompoundParams, grantMessage, epixCap, expirySeconds, recommendedCap, projectedRewards, formatEpix, withSeparators,
    ceilEpix, shortAddress, DURATION_PRESETS, DEFAULT_DURATION, presetExpiry, expiryFromIso, durationDays, formatLocalDateTime,
    formatIsoDate, daysOfRewards, humanDuration, thresholdDays, localDateTime, scheduleIntervalDays, type AutocompoundParams,
} from '../../../utils/autocompound';

const props = defineProps({ sender: { type: String, required: true }, params: String });

// Form state. `cap`, `expiry` and `consent` are the names the shell and the tests rely on.
const cap = ref('');                // custom limit as typed (whole EPIX); '' until the user edits it
const expiry = ref('');             // datetime-local text: the single source of truth for the end date
const consent = ref(false);
const preset = ref(DEFAULT_DURATION); // '3m' | '6m' | '1y' | 'keep' | 'custom'
const limitMode = ref<'recommended' | 'custom'>('recommended');
const capEdited = ref(false);
const touched = ref({ cap: false, expiry: false });
const submitted = ref(false);

const details = computed<AutocompoundParams | undefined>(() => {
    try { return autocompoundParams(props.params, 'autocompound'); } catch { return undefined; }
});
const intent = computed(() => details.value?.intent ?? (details.value?.existing_grant ? 'change' : 'turn_on'));
const name = computed(() => details.value?.validator_name || details.value?.operator_name || 'this validator');
const shortOwner = computed(() => shortAddress(props.sender));
const shortGrantee = computed(() => shortAddress(details.value?.operator_address || ''));
const shortValidator = computed(() => shortAddress(details.value?.validator_address || ''));
const minLocal = computed(() => localDateTime(new Date()));

// ---- Duration ----
const currentExpiryLocal = computed(() => details.value?.current_expiration ? expiryFromIso(details.value.current_expiration) : '');
const currentExpiryFuture = computed(() => currentExpiryLocal.value !== '' && durationDays(currentExpiryLocal.value) > 0);
// datetime-local text cannot say which of two repeated local hours it means (daylight-saving fall-back), so a kept end
// date is offered only when the text re-parses to the same minute; otherwise the form falls back to the 1-year preset.
const keepExact = computed(() => {
    const d = details.value;
    if (!d?.current_expiration || !currentExpiryLocal.value) return false;
    try {
        return Number(expirySeconds(currentExpiryLocal.value, 0)) * 1000 === Math.ceil(new Date(d.current_expiration).getTime() / 60000) * 60000;
    } catch { return false; }
});
const keepAvailable = computed(() => (intent.value === 'raise_limit' || intent.value === 'change') && currentExpiryFuture.value && keepExact.value);
const presets = computed(() => [
    ...(keepAvailable.value ? [{ id: 'keep', label: `Keep current end date (${formatLocalDateTime(currentExpiryLocal.value, false)})` }] : []),
    ...DURATION_PRESETS.map(option => ({ id: option.id, label: option.label })),
    { id: 'custom', label: 'Custom' },
]);
function applyPreset(id: string) {
    const days = DURATION_PRESETS.find(option => option.id === id)?.days;
    if (days) expiry.value = presetExpiry(days);
    else if (id === 'keep' && currentExpiryLocal.value) expiry.value = currentExpiryLocal.value;
    else if (id === 'custom' && !expiry.value) expiry.value = presetExpiry(365);
}
function selectPreset(id: string) {
    preset.value = id;
    applyPreset(id);
}
const days = computed(() => durationDays(expiry.value));
// While the end date is empty, malformed or past (routine while a Custom date is being typed), the limit maths keeps the
// one-year default instead of collapsing to 1 EPIX; the expiry error still blocks submission.
const effectiveDays = computed(() => (days.value > 0 ? days.value : 365));
const untilText = computed(() => formatLocalDateTime(expiry.value));
const untilDate = computed(() => formatLocalDateTime(expiry.value, false));

// ---- Limit ----
const recommended = computed(() => recommendedCap(details.value?.stake_amount, details.value?.apr, effectiveDays.value));
const recommendedAvailable = computed(() => recommended.value !== '');
const mode = computed(() => (recommendedAvailable.value ? limitMode.value : 'custom'));
const customDefault = computed(() => {
    const d = details.value;
    return intent.value === 'change' && d?.current_cap !== undefined && !d.current_cap_unlimited && d.current_cap !== '0' ? ceilEpix(d.current_cap) : '';
});
// The input shows the current limit for `change` until the user edits it, while `cap` itself still resets to ''.
const customLimit = computed({
    get: () => (capEdited.value || !customDefault.value ? cap.value : customDefault.value),
    set: (value: string) => { cap.value = value; capEdited.value = true; touched.value.cap = true; },
});
function selectMode(value: 'recommended' | 'custom') { limitMode.value = value; }
function useStake() {
    if (details.value?.stake_amount) customLimit.value = ceilEpix(details.value.stake_amount);
}
const stakeText = computed(() => formatEpix(details.value?.stake_amount));
const stakeMultiple = computed(() => {
    const stake = details.value?.stake_amount;
    if (!recommended.value || !stake || BigInt(stake) === 0n) return '';
    const tenths = (BigInt(epixCap(recommended.value)) * 10n + BigInt(stake) / 2n) / BigInt(stake); // nearest tenth
    if (tenths === 0n) return ''; // a short Custom end date rounds to "0×", which is noise rather than information
    return tenths % 10n === 0n ? `${tenths / 10n}` : `${tenths / 10n}.${tenths % 10n}`;
});
const stakeMultipleText = computed(() => {
    const multiple = stakeMultiple.value;
    return !multiple ? '' : multiple === '1' ? 'the same as your current stake' : `${multiple}× your current stake`;
});
// The helper explains the figure actually shown: rewards over the chosen period, clamped to the year the formula uses.
// A preset lands a few seconds short of its day count once the minute has started, so anything over 364 days is a year.
const periodDays = computed(() => {
    const clamped = Math.min(effectiveDays.value, 365);
    return clamped > 364 ? 365 : clamped;
});
const periodRewards = computed(() => formatEpix(projectedRewards(details.value?.stake_amount, details.value?.apr, periodDays.value) || undefined, 0));
const periodText = computed(() => (periodDays.value >= 365 ? 'in a year' : `over ${humanDuration(periodDays.value)}`));
const aprPercent = computed(() => {
    const apr = details.value?.apr;
    return apr ? String(Math.round(Number(apr) * 100)) : '';
});
const customFeedback = computed(() => {
    if (check.value.field === 'cap' || mode.value !== 'custom' || !check.value.capText) return '';
    const period = daysOfRewards(epixCap(check.value.capText), details.value?.stake_amount, details.value?.apr);
    if (period === null) return '';
    const amount = `${withSeparators(check.value.capText)} EPIX`;
    if (days.value > 0 && period >= days.value) return `At your stake, ${amount} is about ${humanDuration(period)} of rewards, more than this permission lasts.`;
    return `At your stake, ${amount} is about ${humanDuration(period)} of rewards; you'll need to raise it after that.`;
});

// ---- Context ----
// "17 minutes" → "17 min": the context line is the one place where the long unit costs a whole extra line on phones.
function compactDuration(days: number) { return humanDuration(days).replace(/ minutes?$/, ' min'); }
interface ContextPart { main: string; note: string; nowrap: boolean }
// Separate facts with a visible separator. Short facts never break inside ("every 5 minutes" stays whole), a long
// clause flows like text, and a note is the parenthetical that moves to the next line as one piece. `scheduleText`
// joins them for plain contexts.
const NOWRAP_FACT = 24; // characters; longer free-text schedules must be allowed to wrap on narrow phones
const fact = (main: string, note = ''): ContextPart => ({ main, note, nowrap: main.length <= NOWRAP_FACT });
const scheduleParts = computed<ContextPart[]>(() => {
    const d = details.value;
    if (!d) return [];
    const parts: ContextPart[] = [];
    const schedule = d.schedule ? (/^runs\b/i.test(d.schedule) ? d.schedule : `Runs ${d.schedule}`) : '';
    if (schedule) parts.push(fact(schedule));
    if (d.minimum_reward !== undefined) {
        const tiny = BigInt(d.minimum_reward) < 10n ** 15n;
        const cycle = tiny ? null : daysOfRewards(d.minimum_reward, d.stake_amount, d.apr);
        const interval = scheduleIntervalDays(d.schedule);
        // Rewards that reach the minimum within one run interval mean every run re-stakes; a sub-interval figure right
        // after "Runs every 5 minutes" would read as the run frequency.
        const everyRun = cycle !== null && (interval !== null ? cycle <= interval : cycle < 1 / 24);
        const note = cycle === null ? '' : everyRun ? '(on every run for you)' : `(about every ${compactDuration(cycle)} for you)`;
        const verb = schedule ? 're-stakes' : 'Re-stakes';
        parts.push(tiny ? fact(`${verb} yours on every run`) : fact(`${verb} yours once rewards reach ${formatEpix(d.minimum_reward)} EPIX`, note));
    }
    if (parts.length === 0) return [fact('The service pays its own fees.')];
    parts.push(fact('pays its own fees'));
    return parts;
});
const scheduleText = computed(() => scheduleParts.value.map(part => (part.note ? `${part.main} ${part.note}` : part.main)).join(' · '));
const stakeParts = computed<string[]>(() => {
    const d = details.value;
    if (!d?.stake_amount) return [];
    const parts = [`Staked ${stakeText.value} EPIX`];
    if (d.rewards_amount !== undefined) parts.push(`${formatEpix(d.rewards_amount)} EPIX waiting`);
    return parts;
});
const stakeLine = computed(() => stakeParts.value.join(' · '));
const headsUp = computed(() => {
    const d = details.value;
    if (!d || intent.value !== 'turn_on') return '';
    const wait = thresholdDays(d.minimum_reward, d.rewards_amount, d.stake_amount, d.apr);
    return wait !== null && wait > 365
        ? `Heads-up: this service only re-stakes once rewards reach ${formatEpix(d.minimum_reward)} EPIX, about ${humanDuration(wait)} at your stake.` : '';
});
const unbondingText = computed(() => {
    const seconds = details.value?.unbonding_seconds;
    if (seconds === undefined) return "Re-staked EPIX becomes stake: like all stake it can only be unstaked after the network's unbonding period.";
    const unbondingDays = Number((BigInt(seconds) + 86399n) / 86400n);
    return `Re-staked EPIX becomes stake: like all stake it takes ${unbondingDays} day${unbondingDays === 1 ? '' : 's'} to unstake.`;
});

// ---- Existing permission (before → after) ----
const current = computed(() => {
    const d = details.value;
    if (!d) return null;
    if (!(d.existing_grant || d.current_cap !== undefined || d.current_cap_unlimited === true || d.current_expiration !== undefined)) return null;
    const unlimited = d.current_cap_unlimited === true;
    const limit = unlimited ? 'no limit' : d.current_cap !== undefined ? `${formatEpix(d.current_cap)} EPIX` : 'unknown';
    const endDate = d.current_expiration ? formatIsoDate(d.current_expiration) : '';
    const ended = d.current_expiration !== undefined && !currentExpiryFuture.value;
    return { unlimited, limit, endDate, ended, used: d.current_cap === '0' };
});
// Parts, not one string, so the template can speak the change ("changes to") where screen readers drop the arrow glyph.
const endDateRow = computed(() => {
    const c = current.value;
    const after = untilDate.value || '…';
    if (!c?.endDate) return { before: '', after, unchanged: false };
    return { before: c.endDate, after, unchanged: expiry.value === currentExpiryLocal.value && keepExact.value };
});
const situation = computed(() => {
    const c = current.value;
    if (!c) return '';
    const prefix = c.unlimited ? "Your current permission has no limit (it was created elsewhere). This app always sets a limit, so the new permission stops at the amount you choose, and this page will tell you when it's nearly used. " : '';
    if (c.ended) return `${prefix}Your previous permission ended on ${c.endDate}. This creates a new one.`;
    if (c.used) return `${prefix}Your current limit is used up. This sets a new limit of ${limitText.value || '…'} EPIX, counted from now.`;
    return `${prefix}This replaces your current permission. The new limit starts fresh: EPIX already re-staked doesn't count against it.`;
});

// ---- Validation ----
interface Check { ok: boolean; error: string; messages: EncodeObject[]; field: '' | 'cap' | 'expiry' | 'consent' | 'params'; capText: string }
const CONSENT_HINT = "Tick 'I understand…' to continue.";
const check = computed<Check>(() => {
    // Later failures carry the parsed cap, so a valid limit stays visible while only the end date is wrong.
    const fail = (field: Check['field'], error: string, capText = ''): Check => ({ ok: false, error, messages: [], field, capText });
    let p: AutocompoundParams;
    try { p = autocompoundParams(props.params, 'autocompound'); } catch (error) { return fail('params', String(error).replace(/^Error: /, '')); }
    let capText = '';
    if (mode.value === 'recommended') capText = recommended.value;
    else {
        const custom = customLimit.value.replace(/\s+/g, '');
        if (!custom) return fail('cap', recommendedAvailable.value ? 'Enter a limit in EPIX, or choose Recommended.' : 'Enter a limit in EPIX.');
        if (!/^\d+$/.test(custom)) return fail('cap', 'Whole EPIX only: digits with no separators (for example 460000).');
        capText = custom.replace(/^0+(?=\d)/, '');
        if (capText === '0') return fail('cap', 'The limit must be more than 0 EPIX.');
        try { epixCap(capText); } catch { return fail('cap', 'That amount is too large.'); }
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(expiry.value)) return fail('expiry', 'Pick an end date.', capText);
    try { expirySeconds(expiry.value); } catch { return fail('expiry', 'The end date must be in the future.', capText); }
    let message: EncodeObject;
    try { message = grantMessage(props.sender, p, capText, expiry.value); } catch (error) { return fail('params', String(error).replace(/^Error: /, ''), capText); }
    if (!consent.value) return { ok: false, error: CONSENT_HINT, messages: [], field: 'consent', capText };
    return { ok: true, error: '', messages: [message], field: '', capText };
});
const msgs = computed(() => check.value.messages);
const isValid = computed(() => ({ ok: check.value.ok, error: check.value.error }));
const blocker = computed(() => ({ kind: check.value.field, message: check.value.error }));
const limitText = computed(() => (check.value.capText ? withSeparators(check.value.capText) : ''));
const capError = computed(() => (check.value.field === 'cap' && (touched.value.cap || submitted.value) ? check.value.error : ''));
const expiryError = computed(() => (check.value.field === 'expiry' && (touched.value.expiry || submitted.value) ? check.value.error : ''));
// The consent control renders in the shell's non-scrolling footer (next to the primary it gates), so the shell reads
// this text and writes `consent` through the exposed ref; the checkbox still gates `isValid` here.
const consentText = computed(() => `I understand ${name.value}'s service may stake up to ${limitText.value || '…'} EPIX from this account, only to ${name.value}, until ${untilText.value || '…'}.`);

function touch() { submitted.value = true; }
function defaultPreset() {
    if (!keepAvailable.value) return DEFAULT_DURATION;
    if (intent.value === 'change') return 'keep';
    return durationDays(currentExpiryLocal.value) >= 30 ? 'keep' : DEFAULT_DURATION;
}
function initial() {
    cap.value = '';
    capEdited.value = false;
    consent.value = false;
    touched.value = { cap: false, expiry: false };
    submitted.value = false;
    preset.value = defaultPreset();
    applyPreset(preset.value);
    limitMode.value = recommendedAvailable.value && !(intent.value === 'change' && customDefault.value) ? 'recommended' : 'custom';
}
defineExpose({ msgs, isValid, initial, touch, blocker, consent, consentText });
</script>
<template>
    <div class="space-y-2 text-sm dark:text-gray-300 sm:space-y-3">
        <section class="space-y-0.5" aria-label="Validator and service">
            <p class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-base font-semibold text-gray-900 dark:text-white">{{ name }}</span>
                <code v-if="shortValidator" class="font-mono text-xs text-gray-500 dark:text-gray-400">{{ shortValidator }}</code>
            </p>
            <!-- Facts flow as text so lines fill up; a short fact or a note never breaks inside, and the separator stays
                 glued to the fact before it, so no line starts with a dot. -->
            <p v-if="scheduleParts.length" class="text-xs text-gray-600 dark:text-gray-400 sm:text-sm">
                <template v-for="(part, index) in scheduleParts" :key="index">
                    <template v-if="index > 0">{{ ' ' }}</template>
                    <span :class="{ 'whitespace-nowrap': part.nowrap }">{{ part.main }}<template v-if="part.note">{{ ' ' }}<span class="whitespace-nowrap">{{ part.note }}<span v-if="index < scheduleParts.length - 1" aria-hidden="true">&nbsp;·</span></span></template><span v-else-if="index < scheduleParts.length - 1" aria-hidden="true">&nbsp;·</span></span>
                </template>
            </p>
            <p v-if="stakeParts.length" class="text-xs tabular-nums text-gray-600 dark:text-gray-400 sm:text-sm">
                <template v-for="(part, index) in stakeParts" :key="index">
                    <template v-if="index > 0">{{ ' ' }}</template>
                    <span class="whitespace-nowrap">{{ part }}<span v-if="index < stakeParts.length - 1" aria-hidden="true">&nbsp;·</span></span>
                </template>
            </p>
            <p v-if="headsUp" class="alert alert-warning mt-2 block py-2 text-sm">{{ headsUp }}</p>
        </section>

        <fieldset class="space-y-1.5" aria-describedby="ac-until">
            <legend class="mb-0.5 font-medium sm:mb-1">For how long?</legend>
            <div class="grid grid-cols-4 gap-2">
                <label v-for="option in presets" :key="option.id"
                    class="btn h-auto min-h-[2.75rem] cursor-pointer px-1 py-2 text-sm font-normal normal-case focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary sm:min-h-[2.5rem] sm:px-3"
                    :class="[preset === option.id ? 'btn-primary' : 'btn-outline', option.id === 'keep' ? 'col-span-full' : '']">
                    <input type="radio" name="ac-duration" class="sr-only" :value="option.id" :checked="preset === option.id"
                        @change="selectPreset(option.id)" />{{ option.label }}
                </label>
            </div>
            <p id="ac-until" class="text-sm">Until {{ untilText || '…' }} (your local time).</p>
            <p class="text-xs text-gray-600 dark:text-gray-400">When it ends, re-staking stops until you renew it here. Nothing reminds you, so pick 1 year unless you plan to move your stake sooner.</p>
            <div v-if="preset === 'custom'" class="form-control">
                <label for="ac-end" class="label pb-1"><span class="label-text dark:text-gray-300">End date and time</span></label>
                <input id="ac-end" v-model="expiry" type="datetime-local" :min="minLocal"
                    class="input input-bordered min-h-[2.75rem] w-full dark:text-gray-300 sm:min-h-[2.5rem]"
                    :aria-invalid="expiryError ? 'true' : undefined" :aria-describedby="expiryError ? 'ac-expiry-error' : undefined"
                    @input="touched.expiry = true" />
            </div>
            <p v-if="expiryError" id="ac-expiry-error" role="alert" class="text-sm text-red-600 dark:text-red-400">{{ expiryError }}</p>
        </fieldset>

        <fieldset>
            <legend class="mb-0.5 font-medium sm:mb-1">Total re-stake limit</legend>
            <!-- Flex order: on phones the Recommended explanation would push the Custom radio below the first screen, so it
                 renders under both radios there (with a lead-in naming the figure it explains); from sm up it sits directly
                 under Recommended. DOM order stays Recommended, explanation, Custom. -->
            <div class="flex flex-col gap-1.5">
                <template v-if="recommendedAvailable">
                    <label class="order-1 flex min-h-[2.75rem] cursor-pointer items-center gap-3 sm:min-h-[2.5rem]">
                        <input type="radio" name="ac-limit" class="radio radio-md radio-primary shrink-0" :checked="mode === 'recommended'"
                            :aria-describedby="mode === 'recommended' ? 'ac-recommended-hint' : undefined" @change="selectMode('recommended')" />
                        <span>
                            <span class="font-medium">Recommended: {{ withSeparators(recommended) }} EPIX</span>
                            <span v-if="stakeMultipleText" class="text-gray-600 dark:text-gray-400"> (about {{ stakeMultipleText }})</span>
                        </span>
                    </label>
                    <!-- From sm up it is indented under the Recommended label text (radio width plus gap) so it reads as that option's explanation. -->
                    <p v-if="mode === 'recommended'" id="ac-recommended-hint" class="order-3 text-xs text-gray-600 dark:text-gray-400 sm:order-2 sm:ml-9">
                        <span class="font-medium sm:hidden">Why {{ withSeparators(recommended) }} EPIX: </span>At today's rate (about {{ aprPercent }}% a year) your {{ stakeText }} EPIX earns roughly {{ periodRewards }} EPIX of rewards {{ periodText }}.
                        This is a ceiling, not an amount taken from you.<template v-if="days > 366"> Covers the first year; you can raise the limit later.</template>
                    </p>
                    <label class="order-2 flex min-h-[2.75rem] cursor-pointer items-center gap-3 sm:order-3 sm:min-h-[2.5rem]">
                        <input type="radio" name="ac-limit" class="radio radio-md radio-primary shrink-0" :checked="mode === 'custom'"
                            @change="selectMode('custom')" />
                        <span class="font-medium">Custom</span>
                    </label>
                </template>
                <template v-else>
                    <p class="order-1 text-gray-600 dark:text-gray-400">
                        We couldn't estimate your rewards right now.
                        <template v-if="stakeText"> A common choice is an amount equal to your current stake ({{ stakeText }} EPIX).</template>
                    </p>
                    <button v-if="stakeText" type="button" class="btn btn-outline btn-sm order-2 min-h-[2.75rem] self-start normal-case sm:min-h-[2.5rem]" @click="useStake">Use {{ stakeText }} EPIX</button>
                </template>
                <div v-if="mode === 'custom'" class="form-control order-4">
                    <label for="ac-custom-limit" class="label pb-1"><span class="label-text dark:text-gray-300">Custom limit</span></label>
                    <div class="join w-full">
                        <input id="ac-custom-limit" v-model="customLimit" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
                            spellcheck="false" enterkeyhint="done" class="input join-item input-bordered min-h-[2.75rem] w-full min-w-0 dark:text-gray-300 sm:min-h-[2.5rem]"
                            :aria-invalid="capError ? 'true' : undefined" :aria-describedby="capError ? 'ac-cap-error' : 'ac-custom-hint'" />
                        <span class="join-item flex items-center border border-base-300 bg-base-200 px-3 text-sm">EPIX</span>
                    </div>
                    <p v-if="capError" id="ac-cap-error" role="alert" class="mt-1 text-sm text-red-600 dark:text-red-400">{{ capError }}</p>
                    <p v-else id="ac-custom-hint" class="mt-1 text-xs text-gray-600 dark:text-gray-400">{{ customFeedback }}</p>
                </div>
                <details class="order-5 text-sm">
                    <summary class="flex min-h-[2.75rem] cursor-pointer items-center gap-1 font-medium sm:min-h-[2.5rem]"><svg aria-hidden="true" class="ac-chevron h-4 w-4 shrink-0 fill-current transition-transform" viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z" /></svg>What does the limit mean?</summary>
                    <p class="pb-1 text-gray-600 dark:text-gray-400">Auto-compound stops when the limit is used up; you can raise it any time. The limit is the most the service could ever stake from this account, rewards or not.<template v-if="recommendedAvailable"> The recommended figure takes your rewards for the period and adds half again so you don't have to come back and raise it, then rounds up.</template></p>
                </details>
            </div>
        </fieldset>

        <!-- Both values of every change sit on the first screen, before the longer permission summary. -->
        <section v-if="current" class="space-y-1 rounded-lg border border-base-300 p-3" aria-labelledby="ac-changes-title">
            <h4 id="ac-changes-title" class="font-medium">What changes</h4>
            <p class="tabular-nums">Limit: {{ current.limit }} <span aria-hidden="true">→</span><span class="sr-only">changes to</span> {{ limitText ? `${limitText} EPIX` : '…' }}</p>
            <p class="tabular-nums">
                End date: <template v-if="!endDateRow.before">{{ endDateRow.after }}</template>
                <template v-else-if="endDateRow.unchanged">{{ endDateRow.before }} (unchanged)</template>
                <template v-else>{{ endDateRow.before }} <span aria-hidden="true">→</span><span class="sr-only">changes to</span> {{ endDateRow.after }}</template>
            </p>
            <p class="text-gray-600 dark:text-gray-400">{{ situation }}</p>
        </section>

        <section class="space-y-2 rounded-lg border border-base-300 p-3" aria-labelledby="ac-allow-title">
            <h4 id="ac-allow-title" class="font-medium">What you're allowing</h4>
            <p id="ac-can-title" class="font-medium">The service can:</p>
            <ul aria-labelledby="ac-can-title" class="space-y-1">
                <li class="flex gap-2"><svg aria-hidden="true" class="mt-0.5 h-4 w-4 shrink-0 fill-current" viewBox="0 0 24 24"><path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" /></svg><span>Stake EPIX from this account ({{ shortOwner }}) to {{ name }}, and no other validator (rewards, or other EPIX sitting in this account)</span></li>
                <li class="flex gap-2"><svg aria-hidden="true" class="mt-0.5 h-4 w-4 shrink-0 fill-current" viewBox="0 0 24 24"><path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" /></svg><span>Stake up to {{ limitText || '(choose a limit)' }} EPIX in total</span></li>
                <li class="flex gap-2"><svg aria-hidden="true" class="mt-0.5 h-4 w-4 shrink-0 fill-current" viewBox="0 0 24 24"><path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" /></svg><span>Act until {{ untilText || '(pick an end date)' }}</span></li>
                <li class="flex gap-2"><svg aria-hidden="true" class="mt-0.5 h-4 w-4 shrink-0 fill-current" viewBox="0 0 24 24"><path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" /></svg><span>Receive this permission at its public service account {{ shortGrantee }}</span></li>
            </ul>
            <p id="ac-never-title" class="font-medium">It can never:</p>
            <ul aria-labelledby="ac-never-title" class="space-y-1">
                <li class="flex gap-2"><svg aria-hidden="true" class="mt-0.5 h-4 w-4 shrink-0 fill-current" viewBox="0 0 24 24"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" /></svg><span>Send, unstake, redelegate, or change where your rewards are paid</span></li>
            </ul>
            <p class="text-gray-600 dark:text-gray-400">{{ unbondingText }}</p>
            <details class="text-xs">
                <summary class="flex min-h-[2.75rem] cursor-pointer items-center gap-1 font-medium sm:min-h-[2.5rem]"><svg aria-hidden="true" class="ac-chevron h-4 w-4 shrink-0 fill-current transition-transform" viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z" /></svg>Full wording</summary>
                <p class="pb-1 text-gray-600 dark:text-gray-400">What the service may do: stake EPIX that is sitting in this account to {{ name }}, up to the limit, until the end date. Honest services only re-stake rewards, but Epix can't enforce that, which is why the limit matters. What it can never do: send your EPIX anywhere, unstake it, move it to another validator, or change where your rewards are paid.</p>
            </details>
        </section>
    </div>
</template>
