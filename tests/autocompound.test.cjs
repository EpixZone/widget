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
    state.cap.value = '1.000000000000000001';
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
    assert.match(state.error.value, /Review fee and gas/);
}));

test('Amino-only and EIP712 wallets fail clearly without a broader permission fallback', () => dialogCase(async ({ state, calls, boundary }) => {
    for (const wallet of ['LedgerUSB', 'OKX Wallet', 'Metamask']) {
        boundary.wallet.wallet = wallet;
        await state.initAuthorization();
        await state.sendAuthorization();
        assert.match(state.error.value, /does not yet support constrained/);
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
            await assert.rejects(api.checkAutocompoundChain('http://fixture', params, sender), /active, unjailed/);
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
    assert.match(state.error.value, /unknown/);
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
    assert.equal(calls.events.length,0);
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
    assert.match(state.error.value, /historical outcome is still unknown/);
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
