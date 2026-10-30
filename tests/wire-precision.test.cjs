const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const protobuf = require('protobufjs');
const { Registry } = require('@cosmjs/proto-signing');
const { defaultRegistryTypes } = require('@cosmjs/stargate');
const { SignDoc, AuthInfo, TxBody, TxRaw } = require('cosmjs-types/cosmos/tx/v1beta1/tx');
const { MsgGrant } = require('cosmjs-types/cosmos/authz/v1beta1/tx');
const { Timestamp } = require('cosmjs-types/google/protobuf/timestamp');
function load(file) {
 const full = path.resolve(file);
 const out = esbuild.buildSync({ entryPoints:[full],bundle:true,platform:'node',format:'cjs',write:false,packages:'external' });
 const mod = new Module(full,module); mod.paths=module.paths; mod._compile(out.outputFiles[0].text,full); return mod.exports;
}
const signing = load('lib/wallet/signing.ts');
const { ExactBinaryWriter } = load('lib/wallet/binary.ts');
const { additionalRegistryTypes } = load('lib/wallet/registry.ts');
const registry = new Registry([...defaultRegistryTypes,...additionalRegistryTypes]);
const schema = protobuf.parse(`syntax="proto3";
message Any {string type_url=1; bytes value=2;}
message Timestamp {int64 seconds=1;int32 nanos=2;}
message Coin {string denom=1;string amount=2;}
message ModeSingle {int32 mode=1;}
message ModeInfo {ModeSingle single=1;}
message SignerInfo {Any public_key=1;ModeInfo mode_info=2;uint64 sequence=3;}
message Fee {repeated Coin amount=1;uint64 gas_limit=2;string payer=3;string granter=4;}
message AuthInfo {repeated SignerInfo signer_infos=1;Fee fee=2;}
message SignDoc {bytes body_bytes=1;bytes auth_info_bytes=2;string chain_id=3;uint64 account_number=4;}
message Grant {Any authorization=1;Timestamp expiration=2;}
message MsgGrant {string granter=1;string grantee=2;Grant grant=3;}`).root;
const encode = (type,value) => schema.lookupType(type).encode(schema.lookupType(type).fromObject(value)).finish();
const boundaries=[0n,1n,(1n<<31n)-1n,1n<<31n,(1n<<32n)-1n,1n<<32n,(1n<<53n)-1n,1n<<53n,(1n<<53n)+1n,(1n<<63n)-1n,1n<<63n,(1n<<63n)+1n,(1n<<64n)-1n];

test('SignDoc account numbers match independent protobufjs at every uint64 boundary',()=>{
 for(const value of boundaries){
  const doc=signing.makeSignDoc(Uint8Array.of(1),Uint8Array.of(2),'epix_6381917-1',value);
  const bytes=signing.makeSignBytes(doc);
  assert.deepEqual(Buffer.from(bytes),Buffer.from(encode('SignDoc',{bodyBytes:doc.bodyBytes,authInfoBytes:doc.authInfoBytes,chainId:doc.chainId,...(value===0n?{}:{accountNumber:value.toString()})})),String(value));
  assert.equal(SignDoc.decode(bytes).accountNumber,value);
 }
});

test('AuthInfo sequence and gas match independent protobufjs through uint64 max',()=>{
 const pubkey={typeUrl:'/ethermint.crypto.v1.ethsecp256k1.PubKey',value:Uint8Array.of(10,0)};
 for(const value of boundaries){
  const bytes=signing.makeAuthInfoBytes([{pubkey,sequence:value}],[{denom:'aepix',amount:'1'}],value);
  const expected=encode('AuthInfo',{signerInfos:[{publicKey:pubkey,modeInfo:{single:{mode:1}},...(value===0n?{}:{sequence:value.toString()})}],fee:{amount:[{denom:'aepix',amount:'1'}],...(value===0n?{}:{gasLimit:value.toString()})}});
  assert.deepEqual(Buffer.from(bytes),Buffer.from(expected),String(value));
  const decoded=AuthInfo.decode(bytes); assert.equal(decoded.signerInfos[0].sequence,value);assert.equal(decoded.fee.gasLimit,value);
 }
});

test('nested grant expiry survives Any, TxBody and simulation TxRaw with protobufjs-equivalent bytes',()=>{
 for(const value of [2147483647n,2147483648n,4071065400n,4294967295n,4294967296n,253402300799n]){
  const grant={granter:'granter',grantee:'operator',grant:{authorization:{typeUrl:'stake',value:Uint8Array.of(1,2)},expiration:{seconds:value,nanos:0}}};
  const any=registry.encodeAsAny({typeUrl:'/cosmos.authz.v1beta1.MsgGrant',value:grant});
  const expected=encode('MsgGrant',{...grant,grant:{...grant.grant,expiration:{seconds:value.toString()}}});
  assert.deepEqual(Buffer.from(any.value),Buffer.from(expected));
  const body=registry.encode({typeUrl:'/cosmos.tx.v1beta1.TxBody',value:{messages:[{typeUrl:any.typeUrl,value:grant}],memo:''}});
  const auth=signing.makeAuthInfoBytes([{pubkey:{typeUrl:'key',value:Uint8Array.of(1)},sequence:4294967295n}],[],400000);
  const raw=TxRaw.decode(TxRaw.encode(TxRaw.fromPartial({bodyBytes:body,authInfoBytes:auth,signatures:[new Uint8Array()]})).finish());
  assert.equal(MsgGrant.decode(TxBody.decode(raw.bodyBytes).messages[0].value).grant.expiration.seconds,value);
  assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence,4294967295n);
  assert.deepEqual(Buffer.from(Timestamp.encode({seconds:value,nanos:0},new ExactBinaryWriter()).finish()),Buffer.from(encode('Timestamp',{seconds:value.toString()})));
 }
});

test('unsafe numbers, overflow and negative unsigned signing values are rejected',()=>{
 for(const value of [Number(9007199254740993n),-1,'-1','18446744073709551616','Infinity']){
  assert.throws(()=>signing.makeSignDoc(new Uint8Array(),new Uint8Array(),'epix_1916-1',value));
  assert.throws(()=>signing.makeAuthInfoBytes([{pubkey:{typeUrl:'key',value:new Uint8Array()},sequence:value}],[],1));
 }
 assert.throws(()=>new ExactBinaryWriter().uint64(-1));
 assert.throws(()=>new ExactBinaryWriter().int64(Number(9007199254740993n)));
});

test('returned wallet document cannot silently change chain, account or sequence',()=>{
 const auth=sequence=>signing.makeAuthInfoBytes([{pubkey:{typeUrl:'key',value:new Uint8Array()},sequence}],[],1);
 const doc=signing.makeSignDoc(Uint8Array.of(1),auth('4294967295'),'epix_1916-1','18446744073709551615');
 signing.assertDirectSignIdentity(doc,doc);
 for(const changed of [{...doc,chainId:'other'},{...doc,accountNumber:'18446744073709551614'},{...doc,authInfoBytes:auth('127')}]) assert.throws(()=>signing.assertDirectSignIdentity(changed,doc),/Wallet changed/);
});

const { AminoTypes } = require('@cosmjs/stargate');
const { createAminoConverters } = load('lib/wallet/amino.ts');
const { toBech32 } = require('@cosmjs/encoding');
const api = load('lib/utils/autocompound.ts');
const sender=toBech32('epix',new Uint8Array(20).fill(1));
const operator=toBech32('epix',new Uint8Array(20).fill(2));
const validator=toBech32('epixvaloper',new Uint8Array(20).fill(3));
const details={expected_chain_id:'epix_6381917-1',operator_address:operator,operator_name:'fixture',validator_address:validator};
const message=()=>api.grantMessage(sender,details,'0.009007199254740993','2099-01-02T12:30');
const amino=new AminoTypes(createAminoConverters());

test('constrained Amino grant matches accepted SDK oneof shape and roundtrips exact bytes',()=>{
 const msg=message(), converted=amino.toAmino(msg);
 assert.equal(converted.type,'cosmos-sdk/MsgGrant');
 assert.deepEqual(converted.value.grant.authorization,{type:'cosmos-sdk/StakeAuthorization',value:{Validators:{type:'cosmos-sdk/StakeAuthorization/AllowList',value:{allow_list:{address:[validator]}}},max_tokens:{denom:'aepix',amount:'9007199254740993'},authorization_type:1}});
 assert.match(converted.value.grant.expiration,/Z$/);
 assert.deepEqual(registry.encode(amino.fromAmino(converted)),registry.encode(msg));
 for(const type of [api.DELEGATE,api.WITHDRAW_REWARD]){
  const revoke=api.revokeMessage(sender,{...details,message_type:type});
  assert.deepEqual(amino.toAmino(revoke),{type:'cosmos-sdk/MsgRevoke',value:{granter:sender,grantee:operator,msg_type_url:type}});
  assert.deepEqual(registry.encode(amino.fromAmino(amino.toAmino(revoke))),registry.encode(revoke));
 }
});

test('Amino adapters reject broader authorizations and imprecise or unlimited caps',()=>{
 for(const change of [v=>{v.type='cosmos-sdk/GenericAuthorization'},v=>{v.value.authorization_type=2},v=>{delete v.value.max_tokens},v=>{v.value.max_tokens.amount=9007199254740993},v=>{v.value.max_tokens.amount='0'},v=>{v.value.Validators.value.allow_list.address.push(validator)}]){
  const converted=amino.toAmino(message());change(converted.value.grant.authorization);assert.throws(()=>amino.fromAmino(converted));
 }
 const converted=amino.toAmino(message());converted.value.grant.expiration='2099-02-30T12:30:00Z';assert.throws(()=>amino.fromAmino(converted));
});

async function loadWallet(file) {
 const full=path.resolve(file);
 const out=await esbuild.build({entryPoints:[full],bundle:true,platform:'node',format:'cjs',write:false,packages:'external',plugins:[{
  name:'wallet-factory-boundary',setup(build){
   build.onResolve({filter:/\/Wallet$/},()=>({path:'wallet',namespace:'fixture'}));
   build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const WalletName={Keplr:'Keplr',Leap:'Leap',MetamaskSnap:'MetamaskSnap'};export const keyType=()=>'/ethermint.crypto.v1.ethsecp256k1.PubKey';export const createWallet=()=>global.__walletFactory;`,loader:'js'}));
  }
 }]});
 const mod=new Module(full,module);mod.paths=module.paths;mod._compile(out.outputFiles[0].text,full);return mod.exports;
}
const tx = value=>({chainId:details.expected_chain_id,signerAddress:sender,messages:[message()],memo:'fixture',timeoutHeight:'4294967295',fee:{amount:[{denom:'aepix',amount:'1'}],gas:'400000'},signerData:{chainId:details.expected_chain_id,accountNumber:value.toString(),sequence:value.toString()}});
const pubkey=Uint8Array.from(require('elliptic').ec('secp256k1').keyFromPrivate('1').getPublic().encodeCompressed());
const account={address:sender,algo:'secp256k1',pubkey};

test('actual Keplr and Leap direct adapters retain account, sequence, grant and independent sign bytes',async()=>{
 const old=global.window;
 try {
  const {KeplerWallet}=await loadWallet('lib/wallet/wallets/KeplerWallet.ts');
  const {LeapWallet}=await loadWallet('lib/wallet/wallets/LeapWallet.ts');
  for(const value of [2147483648n,4294967295n,9007199254740993n,18446744073709551615n]){
   let captured;
   const signer={getAccounts:async()=>[account],signDirect:async(_,doc)=>{captured=doc;return {signed:doc,signature:{signature:Buffer.alloc(64,1).toString('base64')}};}};
   global.window={getOfflineSigner:()=>signer,keplr:{enable:async()=>{}},leap:{enable:async()=>{},getOfflineSigner:()=>signer}};
   for(const Wallet of [KeplerWallet,LeapWallet]){
    const raw=await new Wallet({chainId:details.expected_chain_id,hdPath:"m/44'/60'/0'/0/0"},registry).sign(tx(value));
    assert.equal(captured.accountNumber,value);
    assert.equal(TxBody.decode(raw.bodyBytes).timeoutHeight,4294967295n);
    assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence,value);
    assert.deepEqual(Buffer.from(signing.makeSignBytes(captured)),Buffer.from(encode('SignDoc',{bodyBytes:captured.bodyBytes,authInfoBytes:captured.authInfoBytes,chainId:captured.chainId,accountNumber:value.toString()})));
    api.assertReviewedMessages(raw,[registry.encodeAsAny(message())]);
   }
  }
 } finally {global.window=old;}
});

test('actual Keplr and Leap select supported Amino before signing, without fallback after rejection',async()=>{
 const old=global.window;
 try {
  const {KeplerWallet}=await loadWallet('lib/wallet/wallets/KeplerWallet.ts');
  const {LeapWallet}=await loadWallet('lib/wallet/wallets/LeapWallet.ts');
  let aminoCalls=0;
  const signer={getAccounts:async()=>[account],signAmino:async(_,doc)=>{aminoCalls++;assert.equal(doc.account_number,'18446744073709551615');assert.equal(doc.sequence,'18446744073709551615');return {signed:doc,signature:{signature:Buffer.alloc(64,1).toString('base64')}};}};
  global.window={getOfflineSigner:()=>signer,keplr:{enable:async()=>{}},leap:{enable:async()=>{},getOfflineSigner:()=>signer}};
  for(const Wallet of [KeplerWallet,LeapWallet]){
   const raw=await new Wallet({chainId:details.expected_chain_id},registry).sign(tx(18446744073709551615n));
   assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence,18446744073709551615n);
   assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].modeInfo.single.mode,127);
   assert.equal(TxBody.decode(raw.bodyBytes).timeoutHeight,4294967295n);
   api.assertReviewedMessages(raw,[registry.encodeAsAny(message())]);
  }
  assert.equal(aminoCalls,2);
  signer.signDirect=async()=>{throw new Error('User rejected');};
  await assert.rejects(new KeplerWallet({chainId:details.expected_chain_id},registry).sign(tx(1n)),/User rejected/);
  assert.equal(aminoCalls,2);
 }finally{global.window=old;}
});

test('actual Snap provider receives unsigned Long and returns exact account values',async()=>{
 const old=global.window;
 try{
  const {MetamaskSnapWallet}=await loadWallet('lib/wallet/wallets/MetamaskSnapWallet.ts');
  let captured;
  global.window={ethereum:{request:async request=>{
   if(request.method==='wallet_getSnaps')return {fixture:{id:'npm:@leapwallet/metamask-cosmos-snap',version:'fixture'}};
   const call=request.params.request;
   if(call.method==='getKey')return {...account};
   assert.equal(call.method,'signDirect');captured=call.params.signDoc;
   assert.equal(captured.accountNumber.unsigned,true);
   return {signed:captured,signature:{signature:Buffer.alloc(64,1).toString('base64')}};
  }}};
  for(const value of [2147483648n,4294967295n,9007199254740993n,18446744073709551615n]){
   const raw=await new MetamaskSnapWallet({chainId:details.expected_chain_id},registry).sign(tx(value));
   assert.equal(captured.accountNumber.toString(),value.toString());
   assert.equal(TxBody.decode(raw.bodyBytes).timeoutHeight,4294967295n);
   assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence,value);
   api.assertReviewedMessages(raw,[registry.encodeAsAny(message())]);
  }
 }finally{global.window=old;}
});

test('actual UniClient simulation posts exact nested grant and uint64 AuthInfo bytes',async()=>{
 const http=require('node:http');let posted;
 const server=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{posted=JSON.parse(body);response.end(JSON.stringify({gas_info:{gas_used:'123456'}}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const {UniClient}=await loadWallet('lib/wallet/UniClient.ts');
  const client=new UniClient('Keplr',{chainId:details.expected_chain_id});
  assert.equal(await client.simulate(`http://127.0.0.1:${server.address().port}`,tx(4294967295n)),123456);
  const raw=TxRaw.decode(Buffer.from(posted.tx_bytes,'base64'));
  assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence,4294967295n);
  assert.equal(TxBody.decode(raw.bodyBytes).timeoutHeight,4294967295n);
  api.assertReviewedMessages(raw,[registry.encodeAsAny(message())]);
  assert.equal(MsgGrant.decode(TxBody.decode(raw.bodyBytes).messages[0].value).grant.expiration.seconds,BigInt(new Date('2099-01-02T12:30:00').getTime()/1000));
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('Amino provider must preserve the signed finite transaction height',()=>{
 const doc=signing.makeSignDocAmino([amino.toAmino(message())],{amount:[],gas:'1'},details.expected_chain_id,'','18446744073709551615','4294967295','4294967295');
 assert.equal(doc.timeout_height,'4294967295');
 signing.assertAminoSignIdentity(doc,doc);
 assert.throws(()=>signing.assertAminoSignIdentity({...doc,timeout_height:undefined},doc),/timeout height/);
 assert.throws(()=>signing.assertAminoSignIdentity({...doc,timeout_height:'4294967294'},doc),/timeout height/);
 for(const value of boundaries){
  const bytes=signing.makeTxBodyBytes(registry,[message()],'',value.toString());
  assert.equal(TxBody.decode(bytes).timeoutHeight,value);
 }
});

test('returned Long account numbers compare their exact uint64 bits',()=>{
 const Long=require('long');
 const auth=signing.makeAuthInfoBytes([{pubkey:{typeUrl:'key',value:Uint8Array.of(1)},sequence:'1'}],[],1);
 for(const value of boundaries){
  const doc=signing.makeSignDoc(Uint8Array.of(1),auth,details.expected_chain_id,value);
  for(const unsigned of [false,true]){
   const returned=Long.fromString(value.toString(),unsigned);
   signing.assertDirectSignIdentity({...doc,accountNumber:returned},doc);
   assert.equal(returned.unsigned,unsigned,'the provider response was not mutated');
   const independent=encode('SignDoc',{bodyBytes:doc.bodyBytes,authInfoBytes:doc.authInfoBytes,chainId:doc.chainId,...(value===0n?{}:{accountNumber:returned})});
   assert.deepEqual(Buffer.from(independent),Buffer.from(signing.makeSignBytes(doc)));
  }
 }
 const doc=signing.makeSignDoc(Uint8Array.of(1),auth,details.expected_chain_id,'18446744073709551615');
 for(const value of [-1,'-1',-1n,Number(18446744073709551615n),Long.fromString('18446744073709551614')]){
  assert.throws(()=>signing.assertDirectSignIdentity({...doc,accountNumber:value},doc));
 }
 for(const change of [{low:1.5},{high:NaN},{low:4294967295},{high:2147483648},{low:'-1'},{high:undefined},{unsigned:'false'}]){
  const malformed=Object.assign(Long.fromString('18446744073709551615'),change);
  assert.throws(()=>signing.assertDirectSignIdentity({...doc,accountNumber:malformed},doc));
 }
 assert.throws(()=>signing.uint64(Long.fromString('18446744073709551615')),/Invalid/,'request values remain strict');
});

test('Keplr and Leap accept signed Long responses without changing signed transaction bytes',async()=>{
 const Long=require('long');
 const {keccak256}=require('@cosmjs/crypto');
 const ec=new (require('elliptic').ec)('secp256k1');
 const fixtureKey=ec.keyFromPrivate('1'); // disposable public test key, no network
 const publicKey=ec.keyFromPublic(fixtureKey.getPublic());
 const old=global.window;
 try{
  const {KeplerWallet}=await loadWallet('lib/wallet/wallets/KeplerWallet.ts');
  const {LeapWallet}=await loadWallet('lib/wallet/wallets/LeapWallet.ts');
  for(const Wallet of [KeplerWallet,LeapWallet]){
   for(const value of [15n,9007199254740993n,1n<<63n,14353137888589996058n,(1n<<64n)-1n]){
    let returned,signatureBytes,calls=0;
    const signer={getAccounts:async()=>[account],signDirect:async(_,doc)=>{
     calls++;
     assert.equal(doc.accountNumber,value);
     returned={...doc,accountNumber:Long.fromString(value.toString()),
      bodyBytes:signing.makeTxBodyBytes(registry,[message()],'wallet reviewed memo','4294967295'),
      authInfoBytes:signing.makeAuthInfoBytes([{pubkey:{typeUrl:'/ethermint.crypto.v1.ethsecp256k1.PubKey',value:Uint8Array.of(10,0)},sequence:value}],[{denom:'aepix',amount:'2'}],450000)};
     const wire=encode('SignDoc',returned);
     const canonical=signing.makeSignBytes({...returned,accountNumber:value});
     assert.deepEqual(Buffer.from(wire),Buffer.from(canonical));
     const signature=fixtureKey.sign(keccak256(wire),{canonical:true});
     signatureBytes=Buffer.concat([signature.r.toArrayLike(Buffer,'be',32),signature.s.toArrayLike(Buffer,'be',32)]);
     return {signed:returned,signature:{signature:signatureBytes.toString('base64')}};
    }};
    global.window={getOfflineSigner:()=>signer,keplr:{enable:async()=>{}},leap:{enable:async()=>{},getOfflineSigner:()=>signer}};
    const raw=await new Wallet({chainId:details.expected_chain_id},registry).sign(tx(value));
    assert.equal(calls,1);
    assert.deepEqual(raw.bodyBytes,returned.bodyBytes);
    assert.deepEqual(raw.authInfoBytes,returned.authInfoBytes);
    assert.deepEqual(Buffer.from(raw.signatures[0]),signatureBytes);
    const expectedWire=encode('SignDoc',{bodyBytes:raw.bodyBytes,authInfoBytes:raw.authInfoBytes,chainId:details.expected_chain_id,accountNumber:value.toString()});
    assert.equal(publicKey.verify(keccak256(expectedWire),{r:signatureBytes.subarray(0,32),s:signatureBytes.subarray(32)}),true);
    api.assertReviewedMessages(raw,[registry.encodeAsAny(message())]);
   }
  }
 }finally{global.window=old;}
});
