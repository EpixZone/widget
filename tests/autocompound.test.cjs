const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { reactive, nextTick } = require('vue');
const { toBech32 } = require('@cosmjs/encoding');
const { Registry } = require('@cosmjs/proto-signing');
const { defaultRegistryTypes } = require('@cosmjs/stargate');
const { MsgGrant, MsgRevoke } = require('cosmjs-types/cosmos/authz/v1beta1/tx');
const { StakeAuthorization } = require('cosmjs-types/cosmos/staking/v1beta1/authz');
const { TxBody, TxRaw } = require('cosmjs-types/cosmos/tx/v1beta1/tx');

function compile(filename) {
    const full = path.resolve(filename);
    const options = filename.endsWith('.vue') ? { stdin: {
        contents: compileScript(parse(fs.readFileSync(full, 'utf8')).descriptor, { id: 'test' }).content,
        resolveDir: path.dirname(full), loader: 'ts',
    } } : { entryPoints: [full] };
    const result = esbuild.buildSync({ ...options, bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external' });
    const mod = new Module(full, module);
    mod.paths = module.paths;
    mod._compile(result.outputFiles[0].text, full);
    return mod.exports;
}
const api = compile('lib/utils/autocompound.ts');
const sender = toBech32('epix', new Uint8Array(20).fill(1));
const operator = toBech32('epix', new Uint8Array(20).fill(2));
const validator = toBech32('epixvaloper', new Uint8Array(20).fill(3));
const params = { expected_chain_id: 'epix_6381917-1', operator_address: operator,
    operator_name: 'Fixture operator', validator_address: validator, existing_grant: true };
const expiry = '2099-01-02T12:30';
const { additionalRegistryTypes } = compile('lib/wallet/registry.ts');
const registry = new Registry([...defaultRegistryTypes, ...additionalRegistryTypes]);
const grant = () => api.grantMessage(sender, params, '1.000000000000000001', expiry);

test('grant bytes restrict one validator, exact positive cap and finite expiry', () => {
    const decoded = MsgGrant.decode(registry.encode(grant()));
    assert.equal(decoded.granter, sender);
    assert.equal(decoded.grantee, operator);
    assert.equal(decoded.grant.authorization.typeUrl, api.STAKE_AUTHORIZATION);
    const auth = StakeAuthorization.decode(decoded.grant.authorization.value);
    assert.equal(auth.authorizationType, 1);
    assert.deepEqual(auth.allowList.address, [validator]);
    assert.equal(auth.denyList, undefined);
    assert.deepEqual(auth.maxTokens, { denom: 'aepix', amount: '1000000000000000001' });
    assert.equal(decoded.grant.expiration.seconds, BigInt(new Date(`${expiry}:00`).getTime() / 1000));
    assert.equal(decoded.grant.expiration.nanos, 0);
});

test('caps preserve base units and reject rounding, exponential, empty or unlimited inputs', () => {
    assert.equal(api.epixCap('0.000000000000000001'), '1');
    assert.equal(api.epixCap('9007199254740993.000000000000000001'), '9007199254740993000000000000000001');
    for (const cap of ['', '0', '-1', '1e3', 'NaN', 'Infinity', '1.0000000000000000001', ' 1', '+1', '01', '.1', '1.', '9'.repeat(80)]) {
        assert.throws(() => api.epixCap(cap), undefined, cap);
    }
});

test('expiry rejects invalid, normalized or expired dates', () => {
    for (const value of ['', '2026-02-30T12:00', '2099-01-01T25:00', '2000-01-01T00:00', '2099-01-01', '2099-01-01T00:00Z']) {
        assert.throws(() => api.expirySeconds(value), undefined, value);
    }
    const timestamp = new Date(`${expiry}:00`).getTime();
    assert.throws(() => api.expirySeconds(expiry, timestamp));
    assert.equal(api.expirySeconds(expiry, timestamp - 1), BigInt(timestamp / 1000));
});

test('address, chain and parameter checks reject mismatched or malformed identities', () => {
    assert.equal(api.autocompoundParams(JSON.stringify(params), 'autocompound').operator_address, operator);
    for (const invalid of [
        { ...params, operator_address: validator }, { ...params, validator_address: operator },
        { ...params, operator_address: `${operator.slice(0, -1)}x` },
        { ...params, operator_address: toBech32('epix', new Uint8Array(32)) },
        { ...params, expected_chain_id: 'cosmoshub-4' }, { ...params, expected_chain_id: '' },
    ]) assert.throws(() => api.autocompoundParams(JSON.stringify(invalid), 'autocompound'));
    assert.throws(() => api.autocompoundParams('{', 'autocompound'));
    assert.throws(() => api.autocompoundParams('null', 'autocompound'));
});

test('revoke permits delegate and legacy withdrawal only, with correct message URL', () => {
    for (const type of [api.DELEGATE, api.WITHDRAW_REWARD]) {
        const p = api.autocompoundParams(JSON.stringify({ ...params, message_type: type }), 'autocompound_revoke');
        assert.equal(p.validator_address, undefined);
        const decoded = MsgRevoke.decode(registry.encode(api.revokeMessage(sender, p)));
        assert.deepEqual(decoded, { granter: sender, grantee: operator, msgTypeUrl: type });
    }
    for (const message_type of ['', '/cosmos.bank.v1beta1.MsgSend', '/cosmos.authz.v1beta1.MsgGrant', api.STAKE_AUTHORIZATION]) {
        assert.throws(() => api.autocompoundParams(JSON.stringify({ ...params, message_type }), 'autocompound_revoke'));
    }
});

function responses(overrides = {}) {
    return async url => {
        let data;
        if (url.includes('/cosmos/authz/v1beta1/grants?')) data = { grants: [], pagination: {} };
        else if (url.endsWith('/blocks/latest')) data = { block: { header: { chain_id: params.expected_chain_id, height: '10' } } };
        else if (url.endsWith('/params')) data = { params: { bond_denom: 'aepix' } };
        else if (url.endsWith('/withdraw_address')) data = { withdraw_address: sender };
        else if (url.endsWith('/validators/' + validator)) data = { validator: { operator_address: validator, jailed: false, status: 'BOND_STATUS_BONDED' } };
        else if (url.includes('/delegations/')) data = { delegation_response: { balance: { denom: 'aepix', amount: '1' } } };
        else throw new Error(`Unexpected query ${url}`);
        for (const [suffix, value] of Object.entries(overrides)) if (url.endsWith(suffix)) data = value;
        return { ok: true, status: 200, json: async () => data };
    };
}

test('network checks reject wrong chain, wrong token, absent delegation and changed withdrawal address', async () => {
    const old = global.fetch;
    try {
        global.fetch = responses();
        await api.checkAutocompoundChain('http://fixture', params, sender);
        for (const overrides of [
            { '/blocks/latest': { block: { header: { chain_id: 'epix_1916-1' } } } },
            { '/params': { params: { bond_denom: 'uepix' } } },
            { '/withdraw_address': { withdraw_address: operator } },
            { [`/delegations/${sender}`]: { delegation_response: { balance: { denom: 'aepix', amount: '0' } } } },
        ]) {
            global.fetch = responses(overrides);
            await assert.rejects(api.checkAutocompoundChain('http://fixture', params, sender));
        }
        global.fetch = async () => ({ ok: false, status: 503 });
        await assert.rejects(api.checkAutocompoundChain('http://fixture', params, sender), /503/);
    } finally { global.fetch = old; }
});

test('revoke remains possible after delegation or withdrawal changes', async () => {
    const old = global.fetch;
    const calls = [];
    try {
        const responder = responses();
        global.fetch = url => { calls.push(url); return responder(url); };
        const p = api.autocompoundParams(JSON.stringify({ ...params, message_type: api.WITHDRAW_REWARD }), 'autocompound_revoke');
        await api.checkAutocompoundChain('http://fixture', p, sender);
        assert.equal(calls.length, 2);
    } finally { global.fetch = old; }
});

test('signed transaction must retain every reviewed authorization byte', () => {
    const reviewed = [registry.encodeAsAny(grant())];
    const raw = messages => TxRaw.fromPartial({ bodyBytes: TxBody.encode(TxBody.fromPartial({ messages })).finish() });
    api.assertReviewedMessages(raw(reviewed), reviewed);
    assert.throws(() => api.assertReviewedMessages(raw([]), reviewed));
    const changed = grant();
    changed.value.grantee = sender;
    assert.throws(() => api.assertReviewedMessages(raw([registry.encodeAsAny(changed)]), reviewed));
    assert.throws(() => api.assertReviewedMessages(raw([...reviewed, ...reviewed]), reviewed));
});

test('grant form resets consent and cap on reopen and requires explicit review', () => {
    const component = compile('lib/components/TxDialog/messages/Autocompound.vue').default;
    let exposed;
    const state = component.setup({ sender, params: JSON.stringify(params) }, { expose: value => { exposed = value; } });
    exposed.initial();
    state.cap.value = '460000'; // custom limits are whole EPIX (A08); decimals are rejected before epixCap
    state.expiry.value = expiry;
    assert.equal(exposed.isValid.value.ok, false);
    state.consent.value = true;
    assert.equal(exposed.isValid.value.ok, true);
    assert.equal(exposed.msgs.value.length, 1);
    exposed.initial();
    assert.equal(state.cap.value, '');
    assert.equal(state.consent.value, false);
    assert.equal(exposed.isValid.value.ok, false);
});

async function loadDialog() {
    const filename = path.resolve('lib/components/TxDialog/index.vue');
    const script = compileScript(parse(fs.readFileSync(filename, 'utf8')).descriptor, { id: 'dialog-test' }).content;
    const result = await esbuild.build({ stdin: { contents: script, loader: 'ts', resolveDir: path.dirname(filename) },
        bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', plugins: [{
            name: 'native-boundary-doubles', setup(build) {
                build.onResolve({ filter: /\.vue$/ }, () => ({ path: 'component', namespace: 'double' }));
                build.onResolve({ filter: /\/UniClient$/ }, () => ({ path: 'client', namespace: 'double' }));
                build.onResolve({ filter: /\/wallet\/Wallet$/ }, () => ({ path: 'wallet', namespace: 'double' }));
                build.onResolve({ filter: /\/utils\/http$/ }, () => ({ path: 'http', namespace: 'double' }));
                build.onResolve({ filter: /^@ping-pub\/chain-registry-client$/ }, () => ({ path: 'registry', namespace: 'double' }));
                build.onLoad({ filter: /.*/, namespace: 'double' }, ({ path }) => ({ contents: {
                    component: 'export default {};', registry: 'export default class {}',
                    client: 'export const UniClient = class { constructor(...args) { return new global.__authz.Client(...args); } }',
                    wallet: `export const WalletName = {Keplr:'Keplr',Leap:'Leap',MetamaskSnap:'MetamaskSnap'};
                        export const readWallet = () => global.__authz.wallet;`,
                    http: ['getAccount','getBalance','getBalanceMetadata','getIBCDenomMetadata','getLatestBlock','getStakingParam','getTxByHash']
                        .map(name => `export const ${name} = (...args) => global.__authz.http.${name}(...args);`).join('\n'),
                }[path], loader: 'js' }));
            },
        }] });
    const mod = new Module(filename, module);
    mod.paths = module.paths;
    mod._compile(result.outputFiles[0].text, filename);
    return mod.exports.default;
}

async function dialogCase(run) {
    const oldFetch = global.fetch;
    const oldStorage = global.localStorage;
    const storage = new Map();
    global.localStorage = { getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value), removeItem: key => storage.delete(key) };
    const oldBoundary = global.__authz;
    const oldTimeout = global.setTimeout;
    const oldClear = global.clearTimeout;
    const timers = new Map();
    let timerId = 0;
    const calls = { signed: [], broadcast: [], events: [] };
    const boundary = {
        wallet: { wallet: 'Keplr', hdPath: "m/44'/60'/0'/0/0", cosmosAddress: sender },
        http: {
            getBalance: async () => ({ balances: [] }),
            getAccount: async () => ({ account: { account_number: '14353137888589996058', sequence: '9007199254740993' } }),
            getTxByHash: async (_, hash) => ({ tx_response: { height: '2', code: 0, txhash: hash } }),
        },
        Client: class {
            registry = registry;
            async simulate() { return 100000; }
            async sign(tx) {
                calls.signed.push(tx);
                return TxRaw.fromPartial({ bodyBytes: TxBody.encode(TxBody.fromPartial({ messages: tx.messages.map(m => registry.encodeAsAny(m)), timeoutHeight: BigInt(tx.timeoutHeight) })).finish() });
            }
            async broadcastTx(_, raw) { calls.broadcast.push(raw); return { tx_response: { txhash: 'fixture' } }; }
        },
    };
    try {
        global.fetch = responses();
        global.__authz = boundary;
        global.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
        global.clearTimeout = id => timers.delete(id);
        const component = await loadDialog();
        const props = reactive({ type: 'autocompound', sender, endpoint: 'http://fixture', params: JSON.stringify(params), hdPath: boundary.wallet.hdPath });
        const state = component.setup(props, { expose() {}, emit: (...event) => calls.events.push(event) });
        state.msgBox.value = { msgs: [grant()], isValid: { ok: true, error: '' }, initial() {} };
        state.open.value = true;
        await state.initAuthorization();
        assert.equal(state.authorizationReady.value, true, state.error.value);
        await run({ state, props, calls, boundary, timers, storage });
    } finally {
        global.fetch = oldFetch;
        global.localStorage = oldStorage;
        global.__authz = oldBoundary;
        global.setTimeout = oldTimeout;
        global.clearTimeout = oldClear;
    }
}

test('dialog sends reviewed grant with exact account fields and confirms committed success', () => dialogCase(async ({ state, calls, timers }) => {
    await state.sendAuthorization();
    assert.equal(calls.signed.length, 1);
    assert.equal(calls.signed[0].signerData.accountNumber, '14353137888589996058');
    assert.equal(calls.signed[0].signerData.sequence, '9007199254740993');
    assert.equal(calls.broadcast.length, 1);
    assert.equal(state.view.value, 'submitting');
    const poll = [...timers.values()].find(t => t.ms === 6000);
    await poll.fn();
    assert.deepEqual(calls.events.map(e => e[0]), ['submited', 'confirmed']);
}));

test('identity changes during wallet approval prevent broadcast and stale confirmation', () => dialogCase(async ({ state, props, calls, boundary }) => {
    let finish;
    boundary.Client.prototype.sign = async tx => {
        calls.signed.push(tx);
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = state.sendAuthorization();
    for (let i = 0; i < 80 && !finish; i++) await Promise.resolve();
    assert.ok(finish);
    props.sender = operator;
    await nextTick();
    finish(TxRaw.fromPartial({ bodyBytes: TxBody.encode(TxBody.fromPartial({ messages: [registry.encodeAsAny(grant())] })).finish() }));
    await pending;
    assert.equal(calls.broadcast.length, 0);
    assert.equal(calls.events.length, 0);
    assert.equal(state.authorizationReady.value, false);
}));

test('changed signed grant is rejected without broadcast', () => dialogCase(async ({ state, calls, boundary }) => {
    boundary.Client.prototype.sign = async () => TxRaw.fromPartial({ bodyBytes: TxBody.encode(TxBody.fromPartial({ messages: [], timeoutHeight: 130n })).finish() });
    await state.sendAuthorization();
    assert.equal(calls.broadcast.length, 0);
    assert.match(state.error.value, /differs from the reviewed/);
}));

test('broadcast response loss checks the original hash without requesting a second signature', () => dialogCase(async ({ state, calls, boundary, timers }) => {
    boundary.Client.prototype.broadcastTx = async (_, raw) => { calls.broadcast.push(raw); throw new Error('connection lost'); };
    await state.sendAuthorization();
    assert.equal(state.view.value, 'submitting');
    assert.match(state.msg.value, /not confirmed/);
    await [...timers.values()].find(t => t.ms === 6000).fn();
    assert.equal(calls.signed.length, 1);
    assert.deepEqual(calls.events.map(e => e[0]), ['confirmed']);
}));

test('simulation errors require an explicit fee review instead of signing automatically', () => dialogCase(async ({ state, calls, boundary }) => {
    boundary.Client.prototype.simulate = async () => { throw new Error('fixture failure'); };
    await state.sendAuthorization();
    assert.equal(calls.signed.length, 0);
    assert.equal(calls.broadcast.length, 0);
    assert.equal(state.advance.value, true);
    assert.match(state.error.value, /Fee settings/);
}));

test('Amino-only and EIP712 wallets fail clearly without a broader permission fallback', () => dialogCase(async ({ state, calls, boundary }) => {
    for (const wallet of ['LedgerUSB', 'OKX Wallet', 'Metamask']) {
        boundary.wallet.wallet = wallet;
        await state.initAuthorization();
        await state.sendAuthorization();
        assert.match(state.error.value, /can't be changed with this wallet/);
    }
    assert.equal(calls.signed.length, 0);
    assert.equal(calls.broadcast.length, 0);
}));

test('SDK block responses work and inactive or jailed validators cannot receive new grants', async () => {
    const old = global.fetch;
    try {
        global.fetch = responses({ '/blocks/latest': { sdk_block: { header: { chain_id: params.expected_chain_id, height: '10' } } } });
        await api.checkAutocompoundChain('http://fixture', params, sender);
        for (const change of [{ jailed: true }, { status: 'BOND_STATUS_UNBONDING' }, { operator_address: sender }]) {
            global.fetch = responses({ ['/validators/' + validator]: { validator: { operator_address: validator, jailed: false, status: 'BOND_STATUS_BONDED', ...change } } });
            await assert.rejects(api.checkAutocompoundChain('http://fixture', params, sender), /jailed or inactive/);
        }
    } finally { global.fetch = old; }
});

test('unknown broadcast persists through a fresh dialog and prevents a second signature', () => dialogCase(async ({ state, props, calls, boundary, timers, storage }) => {
    boundary.Client.prototype.broadcastTx = async () => { throw new Error('CheckTx context deadline'); };
    boundary.http.getTxByHash = async () => { throw new Error('not found'); };
    await state.sendAuthorization();
    const savedHash = state.hash.value;
    assert.equal(storage.size, 1);
    for(let i=0;i<5;i++) await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.match(state.error.value, /Still not confirmed/);
    state.open.value = false;
    await nextTick();
    const component = await loadDialog();
    const reloaded = component.setup(props, { expose() {}, emit: (...e) => calls.events.push(e) });
    reloaded.msgBox.value = { msgs: [grant()], isValid: { ok: true, error: '' }, initial() {} };
    reloaded.open.value = true;
    await reloaded.initAuthorization();
    assert.equal(reloaded.view.value, 'submitting');
    assert.equal(reloaded.hash.value, savedHash);
    assert.equal(reloaded.authorizationReady.value, false);
    await reloaded.sendAuthorization();
    assert.equal(calls.signed.length, 1);
    assert.equal(storage.size, 1);
    boundary.http.getTxByHash = async (_, hash) => ({ tx_response: { height: '9', code: 0, txhash: hash } });
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.equal(storage.size, 0);
    assert.equal(calls.events.filter(e => e[0] === 'confirmed').length, 1);
}));

test('only a committed matching result clears pending, and committed failure is not success', () => dialogCase(async ({ state, calls, boundary, timers, storage }) => {
    await state.sendAuthorization();
    boundary.http.getTxByHash = async () => ({ tx_response: { height: '1', code: 0, txhash: 'B'.repeat(64) } });
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.equal(storage.size, 1);
    boundary.http.getTxByHash = async (_, hash) => ({ tx_response: { height: '0', code: 0, txhash: hash } });
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.equal(storage.size, 1);
    boundary.http.getTxByHash = async (_, hash) => ({ tx_response: { height: '8', code: 5, raw_log: 'Rejected by fixture', txhash: hash } });
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.equal(storage.size, 0);
    assert.match(state.error.value, /Rejected/);
    assert.equal(calls.events.filter(e => e[0] === 'confirmed').length, 0);
}));

test('disabled status storage prevents broadcasting a signed grant', () => dialogCase(async ({ state, calls }) => {
    global.localStorage.setItem = () => { throw new Error('storage blocked'); };
    await state.sendAuthorization();
    assert.equal(calls.broadcast.length, 0);
    assert.match(state.error.value, /storage blocked/);
}));

test('a changed chain endpoint or closed review cancels a delayed signature', () => dialogCase(async ({ state, props, calls, boundary }) => {
    let finish;
    boundary.Client.prototype.sign = async () => new Promise(resolve => { finish = resolve; });
    const pending=state.sendAuthorization();
    for(let i=0;i<80&&!finish;i++) await Promise.resolve();
    assert.ok(finish);
    props.endpoint='http://other-chain';
    state.open.value=false;
    await nextTick();
    finish(TxRaw.fromPartial({bodyBytes:TxBody.encode(TxBody.fromPartial({messages:[registry.encodeAsAny(grant())]})).finish()}));
    await pending;
    assert.equal(calls.broadcast.length,0);
    assert.equal(calls.events.filter(e => e[0] !== 'closed').length, 0, 'closing emits only the additive closed event');
}));

test('expired pending bytes require height strictly beyond bound, refreshed grant and explicit new review', () => dialogCase(async ({ state, calls, boundary, timers, storage }) => {
    boundary.Client.prototype.broadcastTx = async () => { throw new Error('insufficient fee or queued timeout'); };
    boundary.http.getTxByHash = async () => { throw new Error('not found'); };
    await state.sendAuthorization();
    assert.equal(calls.signed[0].timeoutHeight, '130');
    assert.equal([...storage.values()].map(JSON.parse)[0].timeoutHeight, '130');
    global.fetch = responses({ '/blocks/latest': { block: { header: { chain_id: params.expected_chain_id, height: '130' } } } });
    await [...timers.values()].filter(t=>t.ms===6000).at(-1).fn();
    assert.equal(state.expiredPendingKey.value, '');
    assert.equal(storage.size, 1);
    global.fetch = responses({ '/blocks/latest': { sdk_block: { header: { chain_id: params.expected_chain_id, height: '131' } } } });
    await [...timers.values()].filter(t=>t.ms===6000).at(-1).fn();
    assert.match(state.error.value, /missed its deadline/);
    assert.match(state.refreshedAuthorization.value, /No current grant/);
    assert.ok(state.expiredPendingKey.value);
    assert.equal(storage.size, 1);
    assert.equal(calls.signed.length, 1);
    await state.reviewAfterTimeout();
    assert.equal(storage.size, 0);
    assert.equal(state.view.value, 'input');
    assert.equal(state.authorizationReady.value, true);
    assert.equal(calls.signed.length, 1);
    assert.equal(calls.events.filter(e=>e[0]==='confirmed').length, 0);
}));

test('wallet removal of the transaction timeout is rejected before broadcast', () => dialogCase(async ({ state, calls, boundary }) => {
    boundary.Client.prototype.sign = async tx => TxRaw.fromPartial({bodyBytes:TxBody.encode(TxBody.fromPartial({messages:tx.messages.map(m=>registry.encodeAsAny(m)),timeoutHeight:0n})).finish()});
    await state.sendAuthorization();
    assert.equal(calls.broadcast.length,0);
    assert.match(state.error.value,/timeout height/);
}));

// Mount the real dialog setup in Vue's renderer. The small child substitutes only
// message UI and records when initial() runs, so render/prop/lifecycle ordering is real.
async function mountedDialog(props, run) {
    const { createRenderer, h } = require('vue');
    const old = { window: global.window, fetch: global.fetch, localStorage: global.localStorage, boundary: global.__authz };
    const initial = [];
    global.window = new EventTarget();
    global.localStorage = { getItem: () => null };
    global.fetch = responses();
    global.__authz = { wallet: { wallet: 'Keplr', cosmosAddress: sender }, http: { getBalance: async () => ({ balances: [] }) } };
    const node = type => ({ type, children: [], parent: null });
    const renderer = createRenderer({
        createElement: node, createText: text => ({ ...node('text'), text }), createComment: node,
        insert(child, parent, anchor = null) { child.parent = parent; const at = parent.children.indexOf(anchor); parent.children.splice(at < 0 ? parent.children.length : at, 0, child); },
        remove(child) { const at = child.parent?.children.indexOf(child); if (at >= 0) child.parent.children.splice(at, 1); },
        setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; },
        parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
        patchProp(n, key, previous, value) { n[key] = value; },
    });
    const Child = { props: ['action'], setup(p, { expose }) { expose({ initial() { initial.push(p.action); } }); return () => h('span', p.action || 'unset'); } };
    const component = await loadDialog();
    component.render = function() { return h(Child, { key: this.type, action: this.type, ref: 'msgBox' }); };
    let vm;
    const app = renderer.createApp({ setup: () => () => h(component, { ...props, ref: value => { vm = value; } }) });
    const settle = async () => { for (let i = 0; i < 12; i++) { await nextTick(); await Promise.resolve(); } };
    try {
        app.mount(node('root'));
        await settle();
        await run({ state: vm.$.setupState, initial, settle });
    } finally {
        app.unmount();
        global.window = old.window; global.fetch = old.fetch; global.localStorage = old.localStorage; global.__authz = old.boundary;
    }
}

test('mounted dialog handles the first delayed grant request and later revoke exactly once after render', async () => {
    const props = reactive({ endpoint: 'http://fixture', sender, type: undefined, params: undefined, openRequest: undefined });
    await mountedDialog(props, async ({ state, initial, settle }) => {
        assert.equal(state.open, false);
        assert.deepEqual(initial, []);
        props.type = 'autocompound'; props.params = JSON.stringify(params); props.openRequest = '1';
        await settle();
        assert.equal(state.open, true);
        assert.equal(state.authorizationReady, true, state.error);
        assert.deepEqual(initial, ['autocompound']);
        state.open = false; await settle();
        props.type = 'autocompound_revoke'; props.params = JSON.stringify({ ...params, message_type: api.DELEGATE }); props.openRequest = 2;
        await settle();
        assert.equal(state.open, true);
        assert.equal(state.authorizationReady, true, state.error);
        assert.deepEqual(initial, ['autocompound', 'autocompound_revoke']);
        props.openRequest = '2'; await settle();
        assert.deepEqual(initial, ['autocompound', 'autocompound_revoke']);
        state.open = false; props.openRequest = 0; await settle();
        props.openRequest = 2; await settle();
        assert.equal(state.open, false, 'an already handled request does not replay after reset');
        assert.equal(initial.length, 2);
    });
});

test('mounted dialog handles a positive pre-upgrade request once and preserves legacy consumers', async () => {
    const initialProps = reactive({ endpoint: 'http://fixture', sender, type: 'autocompound', params: JSON.stringify(params), openRequest: '7' });
    await mountedDialog(initialProps, async ({ state, initial, settle }) => {
        assert.equal(state.open, true);
        assert.equal(state.authorizationReady, true, state.error);
        assert.deepEqual(initial, ['autocompound']);
        initialProps.openRequest = 7; await settle();
        assert.equal(initial.length, 1);
    });
    const legacy = reactive({ endpoint: 'http://fixture', sender, type: 'autocompound', params: JSON.stringify(params) });
    await mountedDialog(legacy, async ({ state, initial, settle }) => {
        for (const request of [undefined, '', 0, '0', -1, 'bad', Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            legacy.openRequest = request; await settle();
            assert.equal(state.open, false); assert.equal(initial.length, 0);
        }
        state.open = true; await state.initData();
        assert.equal(state.authorizationReady, true, state.error);
        assert.deepEqual(initial, ['autocompound'], 'legacy checkbox change still initializes normally');
    });
});

// ---- Redesign (plain-language dialogs, presets, recommended limit, native shell) ----
const E = '0'.repeat(18);

test('recommended limit is exact, rounded up to two significant digits and at least 1 EPIX', () => {
    assert.equal(api.recommendedCap(`296829${E}`, '0.70', 365), '460000');
    assert.equal(api.recommendedCap(`300000${E}`, '0.72', 365), '480000');
    assert.equal(api.recommendedCap(`300000${E}`, '0.72', 3650), '480000', 'the duration is clamped to one year');
    assert.equal(api.recommendedCap(`1000${E}`, '0.1', 365), '160');
    assert.equal(api.recommendedCap(`2${E}`, '0.72', 365), '3.2');
    assert.equal(api.recommendedCap('1', '0.72', 365), '1', 'a tiny stake floors at 1 EPIX');
    assert.equal(api.recommendedCap(`1000${E}`, '0.1', 0), '1');
    for (const [stake, apr, days] of [[undefined, '0.7', 365], [`1000${E}`, undefined, 365], ['1e5', '0.7', 365], [`1000${E}`, '15', 365],
        [`1000${E}`, '0', 365], ['-1', '0.5', 365], [`1000${E}`, 'abc', 365], [`1000${E}`, '0.7', NaN]]) {
        assert.equal(api.recommendedCap(stake, apr, days), '', `${stake} ${apr} ${days}`);
    }
    assert.equal(api.epixCap(api.recommendedCap(`296829${E}`, '0.70', 365)), `460000${E}`);
    assert.equal(api.epixCap(api.recommendedCap(`2${E}`, '0.72', 365)), '3200000000000000000');
    const huge = api.recommendedCap('9'.repeat(40), '9.99', 365);
    assert.match(huge, /^[1-9]\d0+$/, 'huge stakes keep two significant digits without Number rounding');
    assert.equal(api.epixCap(huge).length > 40, true);
    // 296829 × 1013752707470 (e^0.70 − 1 at 12 fixed decimals) × 1e6: the exponential is converted once, then only BigInt math.
    assert.equal(api.projectedRewards(`296829${E}`, '0.70', 365), '300911202405612630000000');
    assert.equal(api.formatEpix(api.projectedRewards(`296829${E}`, '0.70', 365), 0), '300,911');
    assert.equal(api.formatEpix('1196600000000000000'), '1.19');
    assert.equal(api.formatEpix(`296829${E}`), '296,829');
    assert.equal(api.formatEpix('x'), '');
    assert.equal(api.ceilEpix('12500000000000000000001'), '12501');
});

test('duration presets land on the same wall-clock minute and a kept end date never moves earlier', () => {
    const now = new Date(2026, 9, 27, 16, 12);
    assert.equal(api.presetExpiry(365, now), '2027-10-27T16:12');
    assert.equal(api.presetExpiry(182, now), '2027-04-27T16:12');
    assert.equal(api.presetExpiry(91, now), '2027-01-26T16:12');
    assert.deepEqual(api.DURATION_PRESETS.map(p => p.id), ['3m', '6m', '1y']);
    assert.equal(api.DEFAULT_DURATION, '1y');
    assert.equal(api.durationDays('2027-10-27T16:12', now.getTime()), 365);
    assert.equal(api.durationDays('2020-01-01T00:00', now.getTime()), 0);
    assert.equal(api.durationDays('garbage', now.getTime()), 0);
    const instant = new Date('2027-07-17T08:00:37Z').getTime();
    assert.equal(api.expiryFromIso('2027-07-17T08:00:37Z'), api.localDateTime(new Date(Math.ceil(instant / 60000) * 60000)));
    assert.equal(api.expiryFromIso('not a date'), '');
    assert.equal(api.humanDuration(5214), '14 years');
    assert.equal(api.humanDuration(17.56), '3 weeks');
    assert.equal(api.humanDuration(0.5), '12 hours');
    assert.equal(api.humanDuration(0.00176), '3 minutes');
    assert.equal(api.humanDuration(0.00001), '1 minute');
    assert.equal(api.daysOfRewards(`10000${E}`, `296829${E}`, '0.70'), 17.56);
    assert.equal(api.thresholdDays(`10000${E}`, '0', `1000${E}`, '0.7'), 5214.28);
    assert.equal(api.thresholdDays(`10${E}`, `10${E}`, `1000${E}`, '0.7'), 0);
    assert.equal(api.thresholdDays(undefined, '0', `1000${E}`, '0.7'), null);
    assert.equal(api.thresholdDays(`10${E}`, '0', `1000${E}`, undefined), null);
});

test('short addresses are bech32-aware with a plain fallback', () => {
    assert.equal(api.shortAddress('epix1fu9eq5qzlemrmjw0c3vrq37yxmv8hut8t98jxf'), 'epix1fu9e…t98jxf');
    assert.equal(api.shortAddress(validator), `epixvaloper1${validator.slice(12, 16)}…${validator.slice(-6)}`);
    assert.equal(api.shortAddress('0x7b4D1234567890abcdef1234567890abcdef1234'), '0x7b4D1234…ef1234');
    assert.equal(api.shortAddress('abc'), 'abc');
    assert.equal(api.shortAddress(''), '');
});

test('optional display params are parsed leniently and never fail the dialog', () => {
    const valid = { ...params, validator_name: ' Tyrannical Taco ', intent: 'raise_limit', stake_amount: `296829${E}`, apr: '0.70', schedule: 'every 5 minutes',
        current_cap: `12500${E}`, current_cap_unlimited: false, current_expiration: '2027-07-17T08:00:00Z', minimum_reward: `1${E}`,
        rewards_amount: '1190000000000000000', unbonding_seconds: '1814400' };
    const parsed = api.autocompoundParams(JSON.stringify(valid), 'autocompound');
    assert.deepEqual(parsed, { expected_chain_id: params.expected_chain_id, operator_address: operator, operator_name: 'Fixture operator',
        existing_grant: true, validator_name: 'Tyrannical Taco', validator_address: validator, intent: 'raise_limit', stake_amount: `296829${E}`,
        apr: '0.70', schedule: 'every 5 minutes', current_cap: `12500${E}`, current_expiration: '2027-07-17T08:00:00Z', minimum_reward: `1${E}`,
        rewards_amount: '1190000000000000000', unbonding_seconds: '1814400' });
    assert.equal(api.autocompoundParams(JSON.stringify({ ...params, current_cap_unlimited: true }), 'autocompound').current_cap_unlimited, true);
    const invalid = { ...params, validator_name: 42, intent: 'explode', stake_amount: '1e5', apr: '15', schedule: 'x'.repeat(200), current_cap: '-1',
        current_cap_unlimited: 'yes', current_expiration: 'tomorrow', minimum_reward: 10, rewards_amount: '0x10', unbonding_seconds: '21 days' };
    const lenient = api.autocompoundParams(JSON.stringify(invalid), 'autocompound');
    for (const key of ['validator_name', 'intent', 'stake_amount', 'apr', 'current_cap', 'current_cap_unlimited', 'current_expiration',
        'minimum_reward', 'rewards_amount', 'unbonding_seconds']) assert.equal(lenient[key], undefined, key);
    assert.equal(lenient.schedule.length, 160);
    assert.equal(lenient.operator_address, operator);
    const revoke = api.autocompoundParams(JSON.stringify({ ...params, message_type: api.DELEGATE, validator_name: 'Taco', stake_amount: `1${E}` }), 'autocompound_revoke');
    assert.equal(revoke.validator_name, 'Taco');
    assert.equal(revoke.stake_amount, undefined);
    assert.throws(() => api.autocompoundParams(JSON.stringify({ ...valid, operator_address: validator }), 'autocompound'), 'required keys stay strict');
    assert.throws(() => api.autocompoundParams(JSON.stringify({ ...valid, validator_address: undefined }), 'autocompound'));
});

test('pending authorization keys pin the storage format the explorer re-implements', () => {
    const pending = compile('lib/utils/pendingAuthorization.ts');
    assert.equal(pending.pendingAuthorizationKey(sender, api.autocompoundParams(JSON.stringify(params), 'autocompound')),
        `epix:pending-authorization:${JSON.stringify([params.expected_chain_id, sender, operator, api.DELEGATE])}`);
    assert.equal(pending.pendingAuthorizationKey(sender, { ...params, message_type: api.WITHDRAW_REWARD }),
        `epix:pending-authorization:${JSON.stringify([params.expected_chain_id, sender, operator, api.WITHDRAW_REWARD])}`);
});

function grantForm(extra = {}) {
    const component = compile('lib/components/TxDialog/messages/Autocompound.vue').default;
    let exposed;
    const state = component.setup({ sender, params: JSON.stringify({ ...params, ...extra }) }, { expose: value => { exposed = value; } });
    exposed.initial();
    return { state, exposed };
}
const maxTokens = message => StakeAuthorization.decode(MsgGrant.decode(registry.encode(message)).grant.authorization.value).maxTokens.amount;

test('grant form defaults to one year and the recommended limit, and validates each field only after it is touched', () => {
    const { state, exposed } = grantForm({ existing_grant: false, stake_amount: `296829${E}`, apr: '0.70' });
    assert.equal(state.preset.value, '1y');
    const oneYear = new Date(`${api.presetExpiry(365)}:00`).getTime();
    assert.ok(Math.abs(new Date(`${state.expiry.value}:00`).getTime() - oneYear) <= 60000, 'default end date is the 1-year preset');
    assert.equal(state.limitMode.value, 'recommended');
    assert.equal(state.recommended.value, '460000');
    assert.equal(exposed.isValid.value.ok, false);
    assert.equal(exposed.blocker.value.kind, 'consent');
    assert.equal(exposed.isValid.value.error, "Tick 'I understand…' to continue.", 'the hint no longer points "above": the box sits in the footer');
    assert.equal(exposed.consentText.value,
        `I understand Fixture operator's service may stake up to 460,000 EPIX from this account, only to Fixture operator, until ${state.untilText.value}.`);
    exposed.consent.value = true; // the shell's footer checkbox writes through this exposed ref
    assert.equal(state.consent.value, true);
    assert.equal(exposed.isValid.value.ok, true);
    assert.equal(maxTokens(exposed.msgs.value[0]), `460000${E}`);
    state.selectMode('custom');
    assert.equal(exposed.blocker.value.kind, 'cap');
    assert.match(exposed.isValid.value.error, /Enter a limit in EPIX, or choose Recommended/);
    assert.equal(state.capError.value, '', 'no validation text at rest');
    exposed.touch();
    assert.match(state.capError.value, /Enter a limit/);
    state.customLimit.value = '460,000';
    assert.match(exposed.isValid.value.error, /Whole EPIX only/);
    state.customLimit.value = '1.5';
    assert.match(exposed.isValid.value.error, /Whole EPIX only/);
    state.customLimit.value = '9'.repeat(60);
    assert.match(exposed.isValid.value.error, /too large/);
    state.customLimit.value = '0';
    assert.match(exposed.isValid.value.error, /more than 0/);
    state.customLimit.value = ' 12 500 ';
    assert.equal(exposed.isValid.value.ok, true);
    assert.equal(maxTokens(exposed.msgs.value[0]), `12500${E}`);
    assert.match(state.customFeedback.value, /12,500 EPIX is about 3 weeks of rewards/);
    state.selectPreset('custom');
    state.expiry.value = '';
    assert.match(exposed.isValid.value.error, /Pick an end date/);
    assert.equal(state.expiryError.value, 'Pick an end date.', 'the primary was already pressed, so the field error renders');
    assert.equal(state.limitText.value, '12,500', 'a valid limit stays visible while only the end date is wrong');
    assert.match(state.customFeedback.value, /12,500 EPIX is about 3 weeks of rewards/);
    assert.equal(state.recommended.value, '460000', 'the recommendation keeps the one-year default while the date is empty');
    assert.equal(state.periodText.value, 'in a year');
    const rested = grantForm({ existing_grant: false, stake_amount: `296829${E}`, apr: '0.70' });
    rested.state.selectPreset('custom');
    rested.state.expiry.value = '';
    assert.equal(rested.state.expiryError.value, '', 'an untouched end date shows nothing until it is edited or the primary is pressed');
    rested.state.touched.value.expiry = true;
    assert.equal(rested.state.expiryError.value, 'Pick an end date.');
    state.expiry.value = '2000-01-01T00:00';
    assert.match(exposed.isValid.value.error, /must be in the future/);
    state.expiry.value = expiry;
    assert.equal(exposed.isValid.value.ok, true);
    state.selectPreset('3m');
    assert.ok(Math.abs(new Date(`${state.expiry.value}:00`).getTime() - new Date(`${api.presetExpiry(91)}:00`).getTime()) <= 60000);
    assert.equal(state.recommended.value, '85000', 'the recommendation follows the chosen period');
    assert.equal(api.withSeparators(state.recommended.value), '85,000');
    assert.equal(state.periodText.value, 'over 3 months');
    assert.match(state.periodRewards.value, /^56,\d{3}$/, 'the helper explains the 3-month figure, not the yearly one');
    assert.equal(state.stakeMultiple.value, '0.3', 'the multiple is rounded to the nearest tenth, not truncated');
    state.selectPreset('1y');
    assert.equal(state.periodText.value, 'in a year');
    assert.equal(state.periodRewards.value, '300,911');
    assert.equal(state.stakeMultiple.value, '1.5');
    assert.equal(state.stakeMultipleText.value, '1.5× your current stake');
    state.selectPreset('custom');
    state.expiry.value = api.presetExpiry(10);
    assert.equal(state.recommended.value, '8700');
    assert.equal(state.stakeMultiple.value, '', 'a short Custom end date rounds to 0×, which is omitted rather than shown');
    assert.equal(state.stakeMultipleText.value, '');
    const level = grantForm({ existing_grant: false, stake_amount: `296829${E}`, apr: '0.5' });
    assert.equal(level.state.stakeMultiple.value, '1');
    assert.equal(level.state.stakeMultipleText.value, 'the same as your current stake');
    exposed.initial();
    assert.equal(state.cap.value, '');
    assert.equal(state.consent.value, false);
    assert.equal(state.limitMode.value, 'recommended');
    assert.equal(state.preset.value, '1y');
});

test('raise and change intents keep the current end date and prefill the current limit without touching cap', () => {
    const far = new Date(Date.now() + 90 * 86400000).toISOString();
    const soon = new Date(Date.now() + 10 * 86400000).toISOString();
    let form = grantForm({ intent: 'raise_limit', current_expiration: far, current_cap: '0', stake_amount: `296829${E}`, apr: '0.70' });
    assert.equal(form.state.preset.value, 'keep');
    assert.equal(form.state.expiry.value, api.expiryFromIso(far));
    assert.equal(form.state.limitMode.value, 'recommended');
    assert.deepEqual(form.state.presets.value.map(p => p.id), ['keep', '3m', '6m', '1y', 'custom']);
    assert.match(form.state.situation.value, /current limit is used up/);
    form = grantForm({ intent: 'raise_limit', current_expiration: soon, current_cap: '0', stake_amount: `296829${E}`, apr: '0.70' });
    assert.equal(form.state.preset.value, '1y', 'an end date under 30 days away is not kept');
    form = grantForm({ intent: 'change', current_expiration: far, current_cap: `12500${E}`, stake_amount: `296829${E}`, apr: '0.70' });
    assert.equal(form.state.preset.value, 'keep');
    assert.equal(form.state.limitMode.value, 'custom');
    assert.equal(form.state.cap.value, '', 'initial() still resets cap');
    assert.equal(form.state.customLimit.value, '12500');
    assert.equal(form.state.endDateRow.value.unchanged, true, 'the end-date row reads (unchanged)');
    form.state.consent.value = true;
    assert.equal(form.exposed.isValid.value.ok, true);
    assert.equal(maxTokens(form.exposed.msgs.value[0]), `12500${E}`);
    form.state.customLimit.value = '';
    assert.equal(form.exposed.blocker.value.kind, 'cap', 'clearing the prefilled limit is not silently refilled');
    form = grantForm({ intent: 'change', current_expiration: far, current_cap_unlimited: true, stake_amount: `296829${E}`, apr: '0.70' });
    assert.equal(form.state.limitMode.value, 'recommended');
    assert.match(form.state.situation.value, /^Your current permission has no limit/);
    form = grantForm({ intent: 'turn_on', current_expiration: far, current_cap: `1${E}` });
    assert.equal(form.state.preset.value, '1y', 'turn_on never keeps the old end date');
    assert.equal(form.state.limitMode.value, 'custom', 'no rate means custom is the only mode');
    assert.equal(form.state.recommendedAvailable.value, false);
    assert.equal(form.exposed.isValid.value.error, 'Enter a limit in EPIX.', 'no Recommended option exists to point at');
    assert.equal(form.state.current.value.limit, '1 EPIX');
    form = grantForm({ existing_grant: true });
    assert.equal(form.state.current.value.limit, 'unknown', 'a missing current limit is not an engineer placeholder');
    assert.deepEqual(form.state.endDateRow.value, { before: '', after: form.state.untilDate.value, unchanged: false });
    form = grantForm({ existing_grant: false, intent: 'turn_on', minimum_reward: `10000${E}`, stake_amount: `1000${E}`, apr: '0.7', rewards_amount: '0' });
    assert.match(form.state.headsUp.value, /only re-stakes once rewards reach 10,000 EPIX, about 14 years at your stake/);
});

test('keep current end date is offered only when the local text re-parses to the same instant', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
        const base = { intent: 'raise_limit', current_cap: '0', stake_amount: `296829${E}`, apr: '0.70' };
        // 06:30Z is 01:30 EST, the second 01:30 of 7 Nov 2027. datetime-local text cannot say which one it means and would
        // re-parse an hour earlier, so the chip is withheld and the form falls back to the 1-year preset.
        let form = grantForm({ ...base, current_expiration: '2027-11-07T06:30:00Z' });
        assert.equal(api.expiryFromIso('2027-11-07T06:30:00Z'), '2027-11-07T01:30');
        assert.equal(form.state.keepAvailable.value, false);
        assert.deepEqual(form.state.presets.value.map(p => p.id), ['3m', '6m', '1y', 'custom']);
        assert.equal(form.state.preset.value, '1y');
        assert.equal(form.state.endDateRow.value.unchanged, false);
        // 05:30Z is 01:30 EDT, the first occurrence: the text round-trips, so the chip is kept and signs the same instant.
        form = grantForm({ ...base, current_expiration: '2027-11-07T05:30:00Z' });
        assert.equal(form.state.preset.value, 'keep');
        assert.equal(form.state.endDateRow.value.unchanged, true);
        form.state.consent.value = true;
        assert.equal(form.exposed.isValid.value.ok, true, form.exposed.isValid.value.error);
        assert.equal(form.exposed.msgs.value[0].value.grant.expiration.seconds, BigInt(Date.parse('2027-11-07T05:30:00Z') / 1000));
    } finally {
        if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
    }
});

test('the context line says when every run re-stakes and never degrades to a bare fragment', () => {
    assert.equal(api.humanDuration(api.daysOfRewards(`10${E}`, `296829${E}`, '0.70')), '25 minutes');
    assert.equal(api.daysOfRewards(`10000${E}`, `296829${E}`, '0.70'), 17.56, 'a day or more keeps two decimals');
    assert.equal(api.scheduleIntervalDays('every 5 minutes'), 5 / 1440);
    assert.equal(api.scheduleIntervalDays('Runs every hour'), 1 / 24);
    assert.equal(api.scheduleIntervalDays('every 2 days'), 2);
    assert.equal(api.scheduleIntervalDays('daily at 02:00 UTC'), null);
    assert.equal(api.scheduleIntervalDays(undefined), null);
    const base = { existing_grant: false, stake_amount: `296829${E}`, apr: '0.70' };
    const line = extra => grantForm({ ...base, ...extra }).state.scheduleText.value;
    assert.equal(line({ schedule: 'every 5 minutes', minimum_reward: `1${E}` }),
        'Runs every 5 minutes · re-stakes yours once rewards reach 1 EPIX (on every run for you) · pays its own fees');
    assert.equal(line({ schedule: 'every 5 minutes', minimum_reward: `10${E}` }),
        'Runs every 5 minutes · re-stakes yours once rewards reach 10 EPIX (about every 25 min for you) · pays its own fees');
    assert.equal(line({ schedule: 'daily at 02:00 UTC', minimum_reward: `1${E}` }),
        'Runs daily at 02:00 UTC · re-stakes yours once rewards reach 1 EPIX (on every run for you) · pays its own fees');
    assert.equal(line({ minimum_reward: `10000${E}` }), 'Re-stakes yours once rewards reach 10,000 EPIX (about every 3 weeks for you) · pays its own fees');
    assert.equal(line({ schedule: 'every 5 minutes', minimum_reward: '1' }), 'Runs every 5 minutes · re-stakes yours on every run · pays its own fees');
    assert.equal(line({}), 'The service pays its own fees.');
    // The template keeps each fact on one line and lets only the parenthetical drop to the next line.
    const form = grantForm({ ...base, schedule: 'every 5 minutes', minimum_reward: `10${E}`, rewards_amount: '1190000000000000000' });
    assert.deepEqual(form.state.scheduleParts.value, [
        { main: 'Runs every 5 minutes', note: '', nowrap: true },
        { main: 're-stakes yours once rewards reach 10 EPIX', note: '(about every 25 min for you)', nowrap: false },
        { main: 'pays its own fees', note: '', nowrap: true },
    ]);
    assert.equal(grantForm({ ...base, schedule: 'twice a day, whenever the operator is online' }).state.scheduleParts.value[0].nowrap, false,
        'a long free-text schedule may wrap on narrow phones');
    assert.deepEqual(form.state.stakeParts.value, ['Staked 296,829 EPIX', '1.19 EPIX waiting']);
    assert.equal(form.state.stakeLine.value, 'Staked 296,829 EPIX · 1.19 EPIX waiting');
});

test('revoke form needs no consent and names the permission', () => {
    const component = compile('lib/components/TxDialog/messages/AutocompoundRevoke.vue').default;
    for (const type of [api.DELEGATE, api.WITHDRAW_REWARD]) {
        let exposed;
        const state = component.setup({ sender, params: JSON.stringify({ ...params, message_type: type, validator_name: 'Taco' }) }, { expose: value => { exposed = value; } });
        exposed.initial();
        assert.equal(exposed.isValid.value.ok, true);
        assert.equal(state.legacy.value, type === api.WITHDRAW_REWARD);
        assert.equal(state.name.value, 'Taco');
        assert.equal(MsgRevoke.decode(registry.encode(exposed.msgs.value[0])).msgTypeUrl, type);
    }
    let exposed;
    component.setup({ sender, params: JSON.stringify({ ...params, message_type: '/cosmos.bank.v1beta1.MsgSend' }) }, { expose: value => { exposed = value; } });
    assert.equal(exposed.isValid.value.ok, false);
    assert.equal(exposed.blocker.value.kind, 'params');
});

test('closing emits closed, and an unsupported wallet ends the account check in a clear message', () => dialogCase(async ({ state, calls, boundary }) => {
    state.open.value = false;
    await nextTick();
    assert.deepEqual(calls.events.map(e => e[0]), ['closed']);
    assert.equal(calls.events[0][1].eventType, 'autocompound');
    state.open.value = true;
    boundary.wallet.wallet = 'Metamask';
    await state.initAuthorization();
    assert.equal(state.authorizationReady.value, false);
    assert.match(state.error.value, /can't be changed with this wallet \(Metamask\) yet/);
    assert.equal(state.primaryLabel.value, 'Save changes', 'a failed check does not pretend to still be checking');
    boundary.wallet.wallet = 'Keplr';
    await state.initAuthorization();
    assert.equal(state.authorizationReady.value, true);
}));

test('dismissing a failed account check never leaves a false checking state', () => dialogCase(async ({ state, boundary, timers }) => {
    boundary.wallet.wallet = 'Metamask';
    await state.initAuthorization();
    assert.match(state.error.value, /can't be changed with this wallet/);
    assert.equal(state.checking.value, false);
    state.error.value = '';
    await nextTick();
    assert.equal(state.checking.value, false, 'nothing is running after Dismiss');
    assert.equal(state.primaryLabel.value, 'Save changes');
    assert.equal(state.accountStatus.value, '');
    await state.primaryClick();
    assert.equal(state.reason.value, "The account check didn't pass. Close and reopen this dialog to check again.");
    boundary.wallet.wallet = 'Keplr';
    const review = state.initAuthorization();
    await nextTick();
    await Promise.resolve();
    assert.equal(state.checking.value, true, 'the live region fills only while a check runs');
    assert.equal(state.accountStatus.value, 'Checking your account…');
    assert.equal(state.primaryLabel.value, 'Checking your account…');
    await review;
    await nextTick();
    assert.equal(state.authorizationReady.value, true);
    assert.equal(state.checking.value, false);
    assert.equal(state.accountStatus.value, 'Account checked. You can continue.', 'readiness is announced');
    [...timers.values()].filter(t => t.ms === 3000).at(-1).fn();
    assert.equal(state.accountStatus.value, '');
    state.open.value = false;
    await nextTick();
    assert.equal(state.checking.value, false, 'a closed dialog is never "checking"');
}));

test('a fresh input view forgets the previous transaction hash', () => dialogCase(async ({ state, calls, timers, storage }) => {
    await state.sendAuthorization();
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.equal(storage.size, 0);
    const sent = state.hash.value;
    assert.ok(sent);
    state.open.value = false;
    await nextTick();
    assert.equal(calls.events.at(-1)[0], 'closed');
    assert.equal(calls.events.at(-1)[1].hash, sent, 'closing after a send reports what was sent');
    state.open.value = true;
    await state.initAuthorization();
    assert.equal(state.view.value, 'input');
    assert.equal(state.hash.value, '');
    state.open.value = false;
    await nextTick();
    assert.equal(calls.events.at(-1)[1].hash, '', 'closing an untouched fresh form reports no hash');
}));

test('titles, primary labels and the fee line follow the intent', () => dialogCase(async ({ state, props }) => {
    assert.equal(state.showTitle(), 'Change auto-compound');
    assert.equal(state.primaryLabel.value, 'Save changes');
    assert.equal(state.feeText.value, '0.01');
    for (const [intent, title, label] of [['turn_on', 'Turn on auto-compound', 'Turn on auto-compound'], ['renew', 'Renew auto-compound', 'Renew'],
        ['raise_limit', 'Raise the limit', 'Raise limit'], ['change', 'Change auto-compound', 'Save changes'], ['bogus', 'Change auto-compound', 'Save changes']]) {
        props.params = JSON.stringify({ ...params, intent });
        await nextTick();
        await state.initAuthorization();
        assert.equal(state.showTitle(), title, intent);
        assert.equal(state.primaryLabel.value, label, intent);
    }
    props.params = JSON.stringify({ ...params, existing_grant: false, intent: 'turn_on', minimum_reward: `10000${E}`, stake_amount: `1000${E}`, apr: '0.7' });
    await nextTick();
    await state.initAuthorization();
    assert.equal(state.primaryLabel.value, 'Turn on anyway');
    state.open.value = false;
    await nextTick();
    props.type = 'autocompound_revoke';
    props.params = JSON.stringify({ ...params, message_type: api.DELEGATE });
    state.open.value = true;
    await state.initAuthorization();
    assert.equal(state.authorizationReady.value, true, 'properties set in the same tick as opening are reviewed, not treated as a change');
    assert.equal(state.showTitle(), 'Turn off auto-compound');
    assert.equal(state.primaryLabel.value, 'Turn off');
    props.params = JSON.stringify({ ...params, message_type: api.WITHDRAW_REWARD });
    await nextTick();
    await state.initAuthorization();
    assert.equal(state.showTitle(), 'Remove old permission');
    assert.equal(state.primaryLabel.value, 'Remove');
    assert.equal(state.primaryLabel.value.includes('Send'), false);
}));

test('a press on the blocked primary explains the reason instead of sending', () => dialogCase(async ({ state, calls }) => {
    let touched = 0;
    const capError = 'Enter a limit in EPIX, or choose Recommended.';
    state.msgBox.value = { msgs: [], isValid: { ok: false, error: capError }, initial() {}, touch() { touched++; }, blocker: { kind: 'cap', message: capError } };
    await state.primaryClick();
    assert.equal(touched, 1);
    assert.equal(state.reason.value, 'Fix the highlighted field above.', 'the field alert already carries the text');
    assert.equal(state.liveReason.value, 'Fix the highlighted field above.');
    assert.equal(calls.signed.length, 0);
    touched = 0;
    const hint = "Tick 'I understand…' to continue.";
    state.msgBox.value = { msgs: [], isValid: { ok: false, error: hint }, initial() {}, touch() { touched++; }, blocker: { kind: 'consent', message: hint } };
    assert.equal(state.primaryBlocked.value, true);
    assert.equal(state.consentHint.value, hint);
    assert.equal(state.liveReason.value, '', 'a reason written for another blocker is not shown under the button');
    await state.primaryClick();
    assert.equal(touched, 1);
    assert.equal(state.reason.value, hint);
    assert.equal(state.liveReason.value, hint);
    assert.equal(calls.signed.length, 0);
    state.msgBox.value = { msgs: [grant()], isValid: { ok: true, error: '' }, initial() {} };
    await nextTick();
    assert.equal(state.reason.value, '', 'the reason clears once the form is valid');
    await state.primaryClick();
    assert.equal(calls.signed.length, 1);
    assert.equal(state.view.value, 'submitting');
}));

test('a reopened pending grant keeps its end date for the success text and tolerates a malformed one', () => dialogCase(async ({ state, boundary, timers, storage }) => {
    boundary.Client.prototype.broadcastTx = async () => { throw new Error('lost'); };
    boundary.http.getTxByHash = async () => { throw new Error('not found'); };
    await state.sendAuthorization();
    const [key, raw] = [...storage.entries()][0];
    const record = JSON.parse(raw);
    assert.equal(record.expiration, new Date(`${expiry}:00`).toISOString(), 'the end date is stored beside the hash (additive field)');
    assert.deepEqual(Object.keys(record).sort(), ['action', 'createdAt', 'expiration', 'hash', 'timeoutHeight']);
    assert.equal(state.signedExpiry.value, api.formatIsoDate(record.expiration, true));
    state.open.value = false;
    await nextTick();
    boundary.http.getTxByHash = async (_, hash) => ({ tx_response: { height: '9', code: 0, txhash: hash } });
    state.open.value = true;
    await state.initAuthorization();
    assert.equal(state.view.value, 'submitting');
    assert.equal(state.signedExpiry.value, api.formatIsoDate(record.expiration, true), 'a reopened dialog restores the stored end date');
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.match(state.msg.value, /^Your auto-compound settings for Fixture operator are saved until .+\. Nothing will remind you when it ends, so check back before .+\.$/);
    assert.equal(storage.size, 0);
    // An older or edited record without a readable end date still confirms, just without "until".
    storage.set(key, JSON.stringify({ ...record, expiration: 'garbage' }));
    state.open.value = false;
    await nextTick();
    state.open.value = true;
    await state.initAuthorization();
    assert.equal(state.view.value, 'submitting');
    assert.equal(state.signedExpiry.value, '');
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.match(state.msg.value, /are saved\. Nothing will remind you when it ends, so check back before it ends\.$/);
    assert.equal(storage.size, 0);
}));

test('result copy is plain language with tones, and rejections are explained', () => dialogCase(async ({ state, props, boundary, timers }) => {
    props.params = JSON.stringify({ ...params, existing_grant: false, intent: 'turn_on', validator_name: 'Taco', minimum_reward: `1${E}` });
    await nextTick();
    await state.initAuthorization();
    await state.sendAuthorization();
    assert.equal(state.view.value, 'submitting');
    assert.match(state.msg.value, /^Sent\. Waiting for the network to confirm/);
    assert.equal(state.resultTone.value, 'neutral');
    assert.equal(state.shortHash.value, `${state.hash.value.slice(0, 4)}…${state.hash.value.slice(-4)}`);
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.match(state.msg.value, /^Auto-compound is on for Taco until .+ once your rewards reach 1 EPIX\./);
    assert.equal(state.resultTone.value, 'success');
    state.open.value = false;
    await nextTick();
    state.open.value = true;
    await state.initAuthorization();
    boundary.http.getTxByHash = async (_, hash) => ({ tx_response: { height: '8', code: 5, raw_log: 'spendable balance 0aepix is smaller than 10aepix: insufficient funds', txhash: hash } });
    await state.sendAuthorization();
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.match(state.error.value, /doesn't have enough EPIX for the network fee/);
    assert.equal(state.resultTone.value, 'error');
    state.open.value = false;
    await nextTick();
    props.type = 'autocompound_revoke';
    props.params = JSON.stringify({ ...params, message_type: api.DELEGATE, validator_name: 'Taco' });
    boundary.http.getTxByHash = async (_, hash) => ({ tx_response: { height: '9', code: 0, txhash: hash } });
    state.open.value = true;
    await state.initAuthorization();
    state.msgBox.value = { msgs: [api.revokeMessage(sender, { ...params, message_type: api.DELEGATE })], isValid: { ok: true, error: '' }, initial() {} };
    await state.sendAuthorization();
    await [...timers.values()].filter(t => t.ms === 6000).at(-1).fn();
    assert.equal(state.msg.value, 'Auto-compound is off for Taco. Your stake and rewards stay where they are.');
}));
