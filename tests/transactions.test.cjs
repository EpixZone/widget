const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { MsgCancelUnbondingDelegation } = require('cosmjs-types/cosmos/staking/v1beta1/tx');
const { Registry } = require('@cosmjs/proto-signing');

function load(filename) {
  const full = path.resolve(filename);
  const options = filename.endsWith('.vue') ? {
    stdin: { contents: compileScript(parse(fs.readFileSync(full, 'utf8')).descriptor, { id: 'test' }).content,
      resolveDir: path.dirname(full), loader: 'ts' },
  } : { entryPoints: [full] };
  const { outputFiles } = esbuild.buildSync({ ...options, bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external' });
  const mod = new Module(full, module);
  mod.paths = module.paths;
  mod._compile(outputFiles[0].text, full);
  return mod.exports;
}
const { TokenUnitConverter } = load('lib/utils/TokenUnitConverter.ts');
const metadata = { aepix: { base: 'aepix', display: 'epix', denom_units: [
  { denom: 'aepix', exponent: 0, aliases: [] }, { denom: 'epix', exponent: 18, aliases: [] },
] } };

test('18 decimal amounts retain every base unit', () => {
  const convert = new TokenUnitConverter(metadata);
  assert.equal(convert.displayToBase('aepix', { amount: '1.000000000000000001', denom: 'epix' }).amount, '1000000000000000001');
  assert.equal(convert.baseToUnit({ amount: '1000000000000000001', denom: 'aepix' }, 'epix').amount, '1.000000000000000001');
});

test('cancellation offers the remaining balance, and encodes the creation height', () => {
  const component = load('lib/components/TxDialog/messages/CancelUnbond.vue').default;
  let exposed;
  const state = component.setup({ endpoint: 'http://unused', sender: 'epix1fixture', metadata,
    params: JSON.stringify({ validator_address: 'epixvaloper1fixture', creation_height: '9007199254740993',
      initial_balance: '2000000000000000000', balance: '1000000000000000001', bond_denom: 'aepix' }) },
    { expose: x => { exposed = x; } });
  state.stakingDenom.value = 'aepix';
  state.amountDenom.value = 'epix';
  assert.equal(state.available.value.display.amount, '1.000000000000000001');
  state.amount.value = '1.000000000000000002';
  assert.equal(exposed.isValid.value.ok, false);
  state.amount.value = '1.000000000000000001';
  assert.equal(exposed.isValid.value.ok, true);
  const registry = new Registry([['/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation', MsgCancelUnbondingDelegation]]);
  const decoded = MsgCancelUnbondingDelegation.decode(registry.encode(exposed.msgs.value[0]));
  assert.equal(decoded.amount.amount, '1000000000000000001');
  assert.equal(decoded.creationHeight, 9007199254740993n);
});

const { makeSignDoc, uint64 } = load('lib/wallet/signing.ts');
const { getAccount } = load('lib/utils/http.ts');
const { SignDoc } = require('cosmjs-types/cosmos/tx/v1beta1/tx');
const { keccak256 } = require('@cosmjs/crypto');
const { ec: EC } = require('elliptic');

test('a signature for a new uint64 account verifies against its exact account number', () => {
  const accountNumber = '14353137888589996058';
  const doc = makeSignDoc(new Uint8Array([10, 0]), new Uint8Array([18, 0]), 'epix_1916-1', accountNumber);
  assert.equal(SignDoc.decode(SignDoc.encode(doc).finish()).accountNumber.toString(), accountNumber);
  const key = new EC('secp256k1').keyFromPrivate('1'); // disposable test key
  const signature = key.sign(keccak256(SignDoc.encode(doc).finish()), { canonical: true });
  const expected = { ...doc, accountNumber: BigInt(accountNumber) };
  assert.equal(key.verify(keccak256(SignDoc.encode(expected).finish()), signature), true);
  const rounded = { ...doc, accountNumber: BigInt(Number(accountNumber)) };
  assert.equal(key.verify(keccak256(SignDoc.encode(rounded).finish()), signature), false);
  assert.throws(() => makeSignDoc(new Uint8Array(), new Uint8Array(), 'epix_1916-1', Number(accountNumber)), /Unsafe/);
});

test('REST account parsing keeps new and legacy account numbers and zero sequences', async () => {
  const http = require('node:http');
  let response;
  const server = http.createServer((req, res) => res.end(JSON.stringify(response)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    for (const account of [
      { account_number: '14353137888589996058', sequence: '0' },
      { base_account: { account_number: '18446744073709551615', sequence: 0 } },
      { base_vesting_account: { base_account: { account_number: '15', sequence: '9007199254740993' } } },
    ]) {
      response = { account };
      const result = (await getAccount(endpoint, 'fixture')).account;
      const base = account.base_account || account.base_vesting_account?.base_account || account;
      assert.equal(result.account_number, base.account_number);
      assert.equal(result.sequence, String(base.sequence));
    }
    response = { code: 5, message: 'account not found' };
    await assert.rejects(getAccount(endpoint, 'missing'), /Invalid/);
    assert.throws(() => uint64('18446744073709551616'), /Invalid/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Amino signing preserves uint64 account numbers and sequences', () => {
  const { makeSignDocAmino } = load('lib/wallet/signing.ts');
  const doc = makeSignDocAmino([], { amount: [], gas: '200000' }, 'epix_1916-1', '',
    '14353137888589996058', '9007199254740993');
  assert.equal(doc.account_number, '14353137888589996058');
  assert.equal(doc.sequence, '9007199254740993');
});

test('cancellation supports Amino wallets without rounding the entry height', () => {
  const { AminoTypes } = require('@cosmjs/stargate');
  const { createAminoConverters } = load('lib/wallet/amino.ts');
  const converters = new AminoTypes(createAminoConverters());
  const message = { typeUrl: '/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation', value: {
    delegatorAddress: 'sender', validatorAddress: 'validator',
    amount: {denom: 'aepix', amount: '1000000000000000001'}, creationHeight: 9007199254740993n,
  } };
  const amino = converters.toAmino(message);
  assert.equal(amino.type, 'cosmos-sdk/MsgCancelUnbondingDelegation');
  assert.equal(amino.value.creation_height, '9007199254740993');
  assert.deepEqual(converters.fromAmino(amino), message);
});

test('cancellation has an EIP-712 schema and serializes the exact message', () => {
  const { defaultMessageAdapter } = load('lib/wallet/EthermintMessageAdapter.ts');
  const adapter = defaultMessageAdapter['/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation'];
  const message = { typeUrl: '/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation', value: {
    delegatorAddress: 'sender', validatorAddress: 'validator',
    amount: { denom: 'aepix', amount: '1' }, creationHeight: 9007199254740993n,
  } };
  const proto = adapter.toProto(message);
  assert.equal(proto.path, message.typeUrl.substring(1));
  assert.equal(MsgCancelUnbondingDelegation.decode(proto.message.serializeBinary()).creationHeight, 9007199254740993n);
  assert.deepEqual(adapter.getTypes().MsgValue.map(field => field.name),
    ['delegator_address', 'validator_address', 'amount', 'creation_height']);
});
