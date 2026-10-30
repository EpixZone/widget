import type { AminoMsg, StdFee, StdSignDoc } from "@cosmjs/amino";
import { AuthInfo, SignDoc, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import type { EncodeObject, Registry } from '@cosmjs/proto-signing';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';
import type { Any } from 'cosmjs-types/google/protobuf/any';
import type { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import Long from 'long';
import { ExactBinaryWriter } from './binary';

// Account numbers are uint64, including values above Number.MAX_SAFE_INTEGER.
export function uint64(value: unknown): string {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new Error('Unsafe account number or sequence');
    }
    const text = String(value);
    if (!/^\d+$/.test(text) || BigInt(text) > 18446744073709551615n) {
        throw new Error('Invalid account number or sequence');
    }
    return BigInt(text).toString();
}

export function makeSignDoc(bodyBytes: Uint8Array, authInfoBytes: Uint8Array,
    chainId: string, accountNumber: string | number | bigint): SignDoc {
    return { bodyBytes, authInfoBytes, chainId, accountNumber: BigInt(uint64(accountNumber)) };
}

export function makeSignBytes(document: SignDoc): Uint8Array {
    uint64(document.accountNumber);
    return SignDoc.encode(document, new ExactBinaryWriter()).finish();
}

export function makeTxBodyBytes(registry: Registry, messages: readonly EncodeObject[], memo: string, timeoutHeight?: string): Uint8Array {
    return TxBody.encode(TxBody.fromPartial({
        messages: messages.map(message => registry.encodeAsAny(message)), memo,
        timeoutHeight: BigInt(uint64(timeoutHeight || '0')),
    }), new ExactBinaryWriter()).finish();
}

function returnedAccountNumber(value: unknown): string {
    if (!Long.isLong(value)) return uint64(value);
    // Some providers return a signed Long for this protobuf uint64 field.
    // Compare its exact bits with the requested account; never reinterpret
    // negative decimal strings or change the document that was signed.
    if (!Number.isInteger(value.low) || value.low < -2147483648 || value.low > 2147483647 ||
        !Number.isInteger(value.high) || value.high < -2147483648 || value.high > 2147483647 ||
        typeof value.unsigned !== 'boolean') {
        throw new Error('Invalid returned account number');
    }
    return Long.fromBits(value.low, value.high, true).toString();
}

export function assertDirectSignIdentity(signed: {
    accountNumber: unknown; chainId: string; authInfoBytes: Uint8Array;
}, requested: SignDoc): void {
    const before = AuthInfo.decode(requested.authInfoBytes).signerInfos;
    const after = AuthInfo.decode(signed.authInfoBytes).signerInfos;
    if (signed.chainId !== requested.chainId || returnedAccountNumber(signed.accountNumber) !== uint64(requested.accountNumber) ||
        before.length !== 1 || after.length !== 1 || after[0].sequence !== before[0].sequence) {
        throw new Error('Wallet changed the signing chain, account number or sequence');
    }
}

export function makeAuthInfoBytes(
    signers: readonly { pubkey: Any; sequence: string | number | bigint }[],
    feeAmount: readonly Coin[], gasLimit: string | number | bigint,
    feeGranter?: string, feePayer?: string, signMode = SignMode.SIGN_MODE_DIRECT,
): Uint8Array {
    if ((feeGranter !== undefined && typeof feeGranter !== 'string') ||
        (feePayer !== undefined && typeof feePayer !== 'string')) throw new Error('Invalid fee payer or granter');
    const authInfo = AuthInfo.fromPartial({
        signerInfos: signers.map(({ pubkey, sequence }) => ({
            publicKey: pubkey, modeInfo: { single: { mode: signMode } }, sequence: BigInt(uint64(sequence)),
        })),
        fee: { amount: [...feeAmount], gasLimit: BigInt(uint64(gasLimit)), granter: feeGranter, payer: feePayer },
    });
    return AuthInfo.encode(authInfo, new ExactBinaryWriter()).finish();
}

export function makeSignDocAmino(msgs: readonly AminoMsg[], fee: StdFee, chainId: string,
    memo: string | undefined, accountNumber: string | number, sequence: string | number, timeoutHeight?: string): StdSignDoc {
    return { msgs, fee, chain_id: chainId, memo: memo || "",
        account_number: uint64(accountNumber), sequence: uint64(sequence),
        ...(timeoutHeight ? { timeout_height: uint64(timeoutHeight) } : {}) };
}

export function assertAminoSignIdentity(signed: StdSignDoc, requested: StdSignDoc): void {
    if (signed.chain_id !== requested.chain_id || uint64(signed.account_number) !== uint64(requested.account_number) ||
        uint64(signed.sequence) !== uint64(requested.sequence) ||
        uint64(signed.timeout_height || '0') !== uint64(requested.timeout_height || '0')) throw new Error('Wallet changed the signing chain, account number, sequence or timeout height');
}
