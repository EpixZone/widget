import { createDefaultAminoConverters, AminoConverters } from '@cosmjs/stargate';

export function createAminoConverters(): AminoConverters {
    return {
        ...createDefaultAminoConverters(),
        '/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation': {
            aminoType: 'cosmos-sdk/MsgCancelUnbondingDelegation',
            toAmino: ({ delegatorAddress, validatorAddress, amount, creationHeight }) => ({
                delegator_address: delegatorAddress, validator_address: validatorAddress,
                amount, creation_height: creationHeight.toString(),
            }),
            fromAmino: ({ delegator_address, validator_address, amount, creation_height }) => ({
                delegatorAddress: delegator_address, validatorAddress: validator_address,
                amount, creationHeight: BigInt(creation_height),
            }),
        },
    };
}
