import type { GeneratedType } from '@cosmjs/proto-signing';
import { MsgGrant, MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { MsgCancelUnbondingDelegation } from 'cosmjs-types/cosmos/staking/v1beta1/tx';
import { ExactBinaryWriter } from './binary';

// Supply our writer at the outer message so nested Timestamp encoding retains
// positive seconds beyond 2038. Any payloads are encoded separately by builders.
const ExactMsgGrant = { ...MsgGrant,
    encode: (message: MsgGrant) => MsgGrant.encode(message, new ExactBinaryWriter()),
};
export const additionalRegistryTypes: ReadonlyArray<[string, GeneratedType]> = [
    ['/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation', MsgCancelUnbondingDelegation],
    ['/cosmos.authz.v1beta1.MsgGrant', ExactMsgGrant],
    ['/cosmos.authz.v1beta1.MsgRevoke', MsgRevoke],
];
