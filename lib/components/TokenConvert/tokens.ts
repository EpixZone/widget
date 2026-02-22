export interface TokenConfig {
    denom: string;
    symbol: string;
    ibcDenom: string;
    decimals: number;
    coinImageUrl: string;
    sourceChannelId?: string;
    destChannelId?: string;
}

export const tokens : TokenConfig[]= [
    {
        denom: "uusdc",
        symbol: "USDC",
        ibcDenom: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
        decimals: 6,
        coinImageUrl: "https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/usdc.svg",
    },
    {
        denom: "allBTC",
        symbol: "BTC",
        ibcDenom: "factory/osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3/alloyed/allBTC",
        decimals: 8,
        coinImageUrl: "https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/bitcoin/images/btc.svg",
    },
    {
        denom: "uosmo",
        symbol: "OSMO",
        ibcDenom: "uosmo", // use base denom for native token
        decimals: 6,
        coinImageUrl: "https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg",
    },
]