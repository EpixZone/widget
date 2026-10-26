import { BinaryWriter } from 'cosmjs-types/binary';

// cosmjs-types 0.9 uses a signed low word for 64-bit varints. When the high
// word is zero, values 2^31..2^32-1 are truncated. Keep the workaround local
// to encoders we own; uint32 produces the same protobuf wire representation.
export class ExactBinaryWriter extends BinaryWriter {
    int64(value: string | number | bigint): BinaryWriter {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) {
            throw new Error('Unsafe 64-bit integer');
        }
        const integer = BigInt(value);
        if (integer < -(1n << 63n) || integer > (1n << 64n) - 1n) {
            throw new Error('Integer outside 64-bit range');
        }
        if (integer >= 0n && integer <= 0xffffffffn) return this.uint32(Number(integer));
        return super.int64(integer);
    }

    uint64 = (value: string | number | bigint): BinaryWriter => {
        if (BigInt(value) < 0n) throw new Error('Negative unsigned integer');
        return this.int64(value);
    };
}
