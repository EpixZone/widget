# EpixZone Widget

A Vue 3 blockchain explorer widget for the EpixZone ecosystem.

## Install

- npm

```bash
npm install @epixzone/widget
```

- yarn

```bash
yarn add @epixzone/widget
```

- cdn

```html
<script src="https://unpkg.com/@epixzone/widget/dist/widget.js"></script>
```

## Usage

```js
import '@epixzone/widget';

// Use as web component
<epix-widget></epix-widget>
```

This template should help get you started developing with Vue 3 and TypeScript in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur) + [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin).

## Type Support For `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin) to make the TypeScript language service aware of `.vue` types.

If the standalone TypeScript plugin doesn't feel fast enough to you, Volar has also implemented a [Take Over Mode](https://github.com/johnsoncodehk/volar/discussions/471#discussioncomment-1361669) that is more performant. You can enable it by the following steps:

1. Disable the built-in TypeScript Extension
   1. Run `Extensions: Show Built-in Extensions` from VSCode's command palette
   2. Find `TypeScript and JavaScript Language Features`, right click and select `Disable (Workspace)`
2. Reload the VSCode window by running `Developer: Reload Window` from the command palette.

### Redelegate dialog destination

For `type="redelegate"`, `params.validator_address` is the source validator (required) and the optional `params.validator_dst_address` preselects the destination validator in the dialog; an invalid value is ignored.

## Auto-compound transaction dialogs

`ping-tx-dialog` accepts `type="autocompound"` ("Turn on auto-compound") and `type="autocompound_revoke"` ("Turn off auto-compound"). Provide the connected `sender`, chain REST `endpoint`, and wallet `hd-path` as usual, plus a JSON `params` attribute. The widget checks the endpoint's chain ID, `aepix` staking denomination, the connected wallet (Keplr, Leap or the Epix MetaMask Snap), active validator, existing delegation, and the account's withdrawal address before signing, and explains any blocker in plain language.

### `autocompound` params

Keys (`expected_chain_id`, `validator_address` and `operator_address` are strictly validated and the dialog shows an error without them; `operator_name` defaults to an empty name and `existing_grant` to `false`):

| Key | Meaning |
| --- | --- |
| `expected_chain_id` | Epix chain ID the endpoint must report, e.g. `epix_1916-1`. |
| `validator_address` | `epixvaloper…` address the service may stake to (the only validator on the allow-list). |
| `operator_address` | `epix…` service account that receives the permission (the grantee). |

`operator_name` (the service name shown when `validator_name` is absent, up to 128 characters) defaults to an empty string and `existing_grant` (`true` when an unexpired permission to this service already exists) to `false` when absent; only `expected_chain_id`, `validator_address` (grant dialog) / `message_type` (revoke dialog) and `operator_address` make the dialog refuse to open.

Optional keys. They are display-only and parsed leniently: an invalid value is ignored as if it were absent, and never fails the dialog.

| Key | Type | Used for | Fallback when absent or invalid |
| --- | --- | --- | --- |
| `validator_name` | string, up to 128 chars | Moniker in the title, lists and consent line. | `operator_name`, then "this validator". |
| `intent` | `turn_on`, `renew`, `raise_limit` or `change` | Title, primary button label and defaults (see below). | `change` when `existing_grant` is true, else `turn_on`. |
| `stake_amount` | base-unit integer string (aepix) | Recommended limit, "Staked … EPIX" line, "Use … EPIX" chip. | Recommended limit unavailable; Custom is the only mode. |
| `apr` | decimal string, 0 < apr < 10 (e.g. `0.72`, after commission) | Recommended limit and "about N weeks of rewards" feedback. | Recommended limit unavailable. |
| `schedule` | human text, up to 160 chars (e.g. `every 5 minutes`) | Service line in the context block. | Line omitted. |
| `minimum_reward` | base-unit integer string | "once rewards reach … EPIX" and the "Turn on anyway" heads-up when the threshold is over a year away. | Threshold clause omitted. |
| `rewards_amount` | base-unit integer string | "… EPIX of rewards waiting" and the heads-up estimate. | Treated as 0 for the estimate; line omitted. |
| `current_cap` | base-unit integer string (remaining limit) | Before → after rows; `change` prefills the Custom limit with it. | "Limit: unknown → …". |
| `current_cap_unlimited` | boolean | "Limit: no limit → …" plus the explanation for permissions created elsewhere. | Not unlimited. |
| `current_expiration` | ISO 8601 date-time | "Keep current end date" chip, before → after rows, "ended on" wording. | No keep chip; end-date row shows only the new date. |
| `unbonding_seconds` | integer string (e.g. `1814400`) | "takes N days to unstake" note. | "can only be unstaked after the network's unbonding period". |

Defaults by intent: `turn_on` and `renew` select the 1-year preset and the Recommended limit. `raise_limit` adds a first "Keep current end date" chip, preselected when the current end date is 30 days or more away (otherwise 1 year), with the Recommended limit. `change` preselects "Keep current end date" and prefills Custom with `current_cap` (Recommended when the current permission has no limit). Duration presets are 3 months, 6 months, 1 year and Custom, each set to now + N days at the same wall-clock minute.

The recommended limit is `stake × (e^(apr × days / 365) − 1) × 1.5`, with the duration clamped to one year, rounded up to two significant digits and never below 1 EPIX. It is computed on base units with BigInt (the exponential factor is converted once to fixed-point) and exported as `recommendedCap(stake, apr, days)` from `lib/utils/autocompound.ts`. The Custom limit is whole EPIX (digits only; spaces are stripped). Only a single-validator, cumulative, capped Delegate StakeAuthorization is created. The service can stake any liquid EPIX of the account up to the limit; the permission cannot enforce rewards-only use, which the dialog says plainly. Replacing a permission starts the new limit fresh.

### `autocompound_revoke` params

Pass `expected_chain_id`, `operator_address`, `operator_name`, and `message_type`. The only accepted types are `/cosmos.staking.v1beta1.MsgDelegate` ("Turn off") and the legacy `/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward` ("Remove old permission"). Optional `validator_name` (up to 128 characters) names the service in the copy, falling back to `operator_name`. There is no consent checkbox: the button is the confirmation. Revocation remains available after the validator or delegation changes.

### Dialog shell

Every dialog type now renders in a native `<dialog>` (Escape closes it except while a transaction is being signed, focus moves to the title on open, the page behind is inert). The hidden `<input type="checkbox" id="<type>">` is kept, so existing `<label for="delegate">` consumers keep working. The auto-compound dialogs are a bottom sheet below the `sm` breakpoint with a non-scrolling footer that holds the one-time network fee line ("You pay a network fee of about 0.01 EPIX…"), the "I understand…" consent box of the grant dialog, the primary button and "Fee settings" (the fee and gas inputs). Pending auto-compound transactions are tracked in `localStorage` under `epix:pending-authorization:<JSON [chainId, sender, grantee, msgType]>` (exported as `pendingAuthorizationKey` from `lib/utils/pendingAuthorization.ts`) as `{hash, action, createdAt, timeoutHeight}` plus, for grants, an additive `expiration` (ISO 8601, display-only: the reopened dialog uses it to say "until …" and ignores it when unreadable); the host may read the same key to show a "confirming" state.

Epix/Keplr-compatible and Leap providers support direct signing or the constrained legacy Amino representation. Snap uses its explicit legacy account-number adapter. Standalone Ledger, EIP-712 and Bitcoin wallet paths are not enabled for these dialogs. No broader authorization is substituted when a wallet cannot sign.

Transactions have a validity limit of 120 blocks beyond the freshly checked chain height. The exact signed transaction hash and limit are retained in local storage before broadcasting. A lost response stays unknown across reopen or reload. A committed matching result settles it. If the chain advances strictly beyond the signed limit, the widget refreshes the current grant and requires an explicit new review; it does not claim the old transaction failed. Changing the wallet, sender, endpoint or dialog parameters cancels an in-progress review.

For a dynamic dialog type, set the optional `open-request` property to a new positive safe integer after updating its parameters. Numeric strings are accepted. The widget opens and initializes the selected form after rendering, once per request. Use an increasing counter; `0` or an omitted value does not open a dialog. Existing label and checkbox consumers remain supported.

Events: `submited` `{hash, eventType}` once the transaction is broadcast, `confirmed` `{hash, eventType}` once it is committed (only for a matching committed transaction with code zero; consumers should refresh grant state after it), `view` `{hash, eventType}` when the user presses View transaction, and `closed` `{hash, eventType}` whenever the dialog closes (✕, Done, View transaction, Escape, backdrop tap or `open` set to false programmatically); `hash` is `''` when nothing was sent from the dialog that just closed.
