import type { AminoConverters } from '@cosmjs/stargate';
import { StakeAuthorization } from 'cosmjs-types/cosmos/staking/v1beta1/authz';
import { DELEGATE, WITHDRAW_REWARD, STAKE_AUTHORIZATION, epixAddress } from '../utils/autocompound';

function checkedStake(value: StakeAuthorization): StakeAuthorization {
    if (value.authorizationType !== 1 || value.denyList || value.allowList?.address.length !== 1 ||
        value.maxTokens?.denom !== 'aepix' || !/^[1-9]\d*$/.test(value.maxTokens.amount) ||
        BigInt(value.maxTokens.amount) >= 2n ** 256n) throw new Error('Only a capped, single-validator delegate authorization is supported');
    epixAddress(value.allowList.address[0], 'epixvaloper');
    return value;
}

function expiryText(seconds: bigint, nanos: number): string {
    if (nanos !== 0 || seconds <= 0n || seconds > 253402300799n) throw new Error('A finite whole-second grant expiry is required');
    return new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
}

// REStake's legacy SDK Amino oneof representation. Verified against Epix v0.7.3.
// This adapter deliberately rejects generic, unlimited and multi-validator grants.
export function authzAminoConverters(): AminoConverters {
    return {
        '/cosmos.authz.v1beta1.MsgGrant': {
            aminoType: 'cosmos-sdk/MsgGrant',
            toAmino: ({ granter, grantee, grant }) => {
                if (grant?.authorization?.typeUrl !== STAKE_AUTHORIZATION || !grant.expiration) throw new Error('Unsupported authorization');
                const stake = checkedStake(StakeAuthorization.decode(grant.authorization.value));
                return { granter: epixAddress(granter, 'epix'), grantee: epixAddress(grantee, 'epix'), grant: {
                    authorization: { type: 'cosmos-sdk/StakeAuthorization', value: {
                        Validators: { type: 'cosmos-sdk/StakeAuthorization/AllowList', value: { allow_list: { address: [...stake.allowList!.address] } } },
                        max_tokens: stake.maxTokens, authorization_type: 1,
                    } },
                    expiration: expiryText(BigInt(grant.expiration.seconds), grant.expiration.nanos),
                } };
            },
            fromAmino: ({ granter, grantee, grant }) => {
                const value = grant?.authorization?.value;
                if (grant?.authorization?.type !== 'cosmos-sdk/StakeAuthorization' ||
                    value?.Validators?.type !== 'cosmos-sdk/StakeAuthorization/AllowList' ||
                    !Array.isArray(value.Validators.value?.allow_list?.address) || typeof value.max_tokens?.amount !== 'string') {
                    throw new Error('Unsupported authorization');
                }
                const stake = checkedStake(StakeAuthorization.fromPartial({
                    authorizationType: value.authorization_type, maxTokens: value.max_tokens,
                    allowList: { address: value.Validators.value.allow_list.address },
                }));
                if (typeof grant.expiration !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(grant.expiration)) throw new Error('Invalid grant expiry');
                const millis = new Date(grant.expiration).getTime();
                if (!Number.isSafeInteger(millis)) throw new Error('Invalid grant expiry');
                const seconds = BigInt(millis / 1000);
                if (expiryText(seconds, 0) !== grant.expiration) throw new Error('Invalid grant expiry');
                return { granter: epixAddress(granter, 'epix'), grantee: epixAddress(grantee, 'epix'), grant: {
                    authorization: { typeUrl: STAKE_AUTHORIZATION, value: StakeAuthorization.encode(stake).finish() },
                    expiration: { seconds, nanos: 0 },
                } };
            },
        },
        '/cosmos.authz.v1beta1.MsgRevoke': {
            aminoType: 'cosmos-sdk/MsgRevoke',
            toAmino: ({ granter, grantee, msgTypeUrl }) => {
                if (msgTypeUrl !== DELEGATE && msgTypeUrl !== WITHDRAW_REWARD) throw new Error('Unsupported authorization revoke');
                return { granter: epixAddress(granter, 'epix'), grantee: epixAddress(grantee, 'epix'), msg_type_url: msgTypeUrl };
            },
            fromAmino: ({ granter, grantee, msg_type_url }) => {
                if (msg_type_url !== DELEGATE && msg_type_url !== WITHDRAW_REWARD) throw new Error('Unsupported authorization revoke');
                return { granter: epixAddress(granter, 'epix'), grantee: epixAddress(grantee, 'epix'), msgTypeUrl: msg_type_url };
            },
        },
    };
}
