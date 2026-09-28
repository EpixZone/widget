import type { AminoMsg, StdFee, StdSignDoc } from "@cosmjs/amino";
import { SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';

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
    chainId: string, accountNumber: string | number): SignDoc {
    return { bodyBytes, authInfoBytes, chainId, accountNumber: BigInt(uint64(accountNumber)) };
}

export function makeSignDocAmino(msgs: readonly AminoMsg[], fee: StdFee, chainId: string,
    memo: string | undefined, accountNumber: string | number, sequence: string | number): StdSignDoc {
    return { msgs, fee, chain_id: chainId, memo: memo || "",
        account_number: uint64(accountNumber), sequence: uint64(sequence) };
}
