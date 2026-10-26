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

## Auto-compound transaction dialogs

`ping-tx-dialog` accepts `type="autocompound"` and a JSON `params` attribute containing `expected_chain_id`, `validator_address`, `operator_address`, `operator_name`, and optional `existing_grant`. Provide the connected `sender`, chain REST `endpoint`, and wallet `hd-path` as usual. The widget checks the endpoint's chain ID, `aepix` staking denomination, active validator, existing delegation, and the account's withdrawal address before signing.

The user supplies a positive EPIX allowance with at most 18 decimal places and a finite expiry. Only a single-validator, cumulative, capped Delegate StakeAuthorization is created. The operator can delegate available balance, including existing funds; this permission cannot enforce rewards-only use. Replacing a grant resets its remaining allowance.

For `type="autocompound_revoke"`, pass `expected_chain_id`, `operator_address`, `operator_name`, and `message_type`. The only accepted types are `/cosmos.staking.v1beta1.MsgDelegate` and the legacy `/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward`. Revocation remains available after the validator or delegation changes.

Epix/Keplr-compatible and Leap providers support direct signing or the constrained legacy Amino representation. Snap uses its explicit legacy account-number adapter. Standalone Ledger, EIP-712 and Bitcoin wallet paths are not enabled for these dialogs. No broader authorization is substituted when a wallet cannot sign.

Transactions have a validity limit of 120 blocks beyond the freshly checked chain height. The exact signed transaction hash and limit are retained in local storage before broadcasting. A lost response stays unknown across reopen or reload. A committed matching result settles it. If the chain advances strictly beyond the signed limit, the widget refreshes the current grant and requires an explicit new review; it does not claim the old transaction failed. Changing the wallet, sender, endpoint or dialog parameters cancels an in-progress review.

The existing `submited` event reports a broadcast response. `confirmed` is emitted only for a matching committed transaction with code zero. Consumers should refresh grant state after confirmation.
