import { makeAuthInfoBytes, makeTxBodyBytes } from "../signing";
import { makeSignDoc, assertDirectSignIdentity, uint64 } from "../signing";
import Long from 'long';
import {
    AbstractWallet,
    Account,
    WalletArgument,
    WalletName,
    keyType,
} from '../Wallet';
import {
    fromBase64,
    fromBech32,
    toHex,
} from '@cosmjs/encoding';
import {
    Registry,

} from '@cosmjs/proto-signing';
import { Transaction } from '../../utils/type';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
// import { AminoTypes, createDefaultAminoConverters } from '@cosmjs/stargate';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';

import { connectSnap, getKey, getSnap, CosmjsOfflineSigner } from '@leapwallet/cosmos-snap-provider';
// import { createWasmAminoConverters } from "@cosmjs/cosmwasm-stargate";

export class MetamaskSnapWallet implements AbstractWallet {
    name: WalletName.MetamaskSnap;
    chainId: string;
    registry: Registry;
    prefix: string;
    // aminoTypes = new AminoTypes( {...createDefaultAminoConverters(), ...createWasmAminoConverters()});

    constructor(arg: WalletArgument, registry: Registry) {
        this.chainId = arg.chainId || 'cosmoshub';
        this.registry = registry;
        this.prefix = arg.prefix || 'cosmos';
    }

    async getAccounts(): Promise<Account[]> {
        const snapInstalled = await getSnap().catch(() => {
            throw new Error('Metamask snap not installed');
        });
        if (!snapInstalled) {
            await connectSnap()
        }
        const key = await getKey(this.chainId)
        return [key]
    }

    async supportCoinType(coinType?: string): Promise<boolean> {
        return true;
    }

    async sign(transaction: Transaction): Promise<TxRaw | Uint8Array> {
        const accouts = await this.getAccounts();
        const hex = toHex(fromBech32(transaction.signerAddress).data);
        const accountFromSigner = accouts.find(
            (account) => toHex(fromBech32(account.address).data) === hex
        );
        if (!accountFromSigner) {
            throw new Error('Failed to retrieve account from signer');
        }

        const pubkey = Any.fromPartial({
            typeUrl: keyType(transaction.chainId),
            value: PubKey.encode({
                key: new Uint8Array(Object.values(accountFromSigner.pubkey)),
            }).finish(),
        });
        const txBodyBytes = makeTxBodyBytes(this.registry, transaction.messages, transaction.memo, transaction.timeoutHeight);
        const gasLimit = Number(transaction.fee.gas);

        const authInfoBytes = makeAuthInfoBytes(
            [{ pubkey, sequence: BigInt(transaction.signerData.sequence) }],
            transaction.fee.amount,
            gasLimit,
            transaction.fee.granter,
            transaction.fee.payer
        );
        const signDoc = makeSignDoc(
            txBodyBytes,
            authInfoBytes,
            transaction.chainId,
            transaction.signerData.accountNumber
        );

        const offlineSigner = new CosmjsOfflineSigner(this.chainId);
        // This provider still serializes the legacy Long-shaped account number.
        const providerDoc = { ...signDoc, accountNumber: Long.fromString(uint64(signDoc.accountNumber), true) };
        const { signature, signed } = await offlineSigner.signDirect(transaction.signerAddress, providerDoc);
        assertDirectSignIdentity(signed, signDoc);

        return TxRaw.fromPartial({
            bodyBytes: signed.bodyBytes,
            authInfoBytes: signed.authInfoBytes,
            signatures: [fromBase64(signature.signature)],
        });
    }
}
