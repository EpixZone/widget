import { DELEGATE, type AutocompoundAction, type AutocompoundParams } from './autocompound';

export interface PendingAuthorization {
    hash: string;
    action: AutocompoundAction;
    createdAt: number;
    timeoutHeight: string;
}

export function pendingAuthorizationKey(sender: string, details: AutocompoundParams): string {
    return `epix:pending-authorization:${JSON.stringify([
        details.expected_chain_id, sender, details.operator_address, details.message_type || DELEGATE,
    ])}`;
}

export function readPendingAuthorization(key: string): PendingAuthorization | undefined {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const value = JSON.parse(raw) as PendingAuthorization;
    if (!/^[A-F0-9]{64}$/.test(value.hash) ||
        !['autocompound', 'autocompound_revoke'].includes(value.action) || !Number.isSafeInteger(value.createdAt) ||
        typeof value.timeoutHeight !== 'string' || !/^[1-9]\d*$/.test(value.timeoutHeight) || BigInt(value.timeoutHeight) >= 2n ** 64n) {
        throw new Error('Stored transaction status is invalid. Check your transaction history before submitting another authorization.');
    }
    return value;
}

export function savePendingAuthorization(key: string, value: PendingAuthorization): void {
    if (readPendingAuthorization(key)) throw new Error('An earlier authorization still needs confirmation. Reopen this dialog to check its status.');
    localStorage.setItem(key, JSON.stringify(value));
    if (readPendingAuthorization(key)?.hash !== value.hash) throw new Error('Unable to retain transaction status. Nothing was broadcast.');
}

export function clearPendingAuthorization(key: string, hash: string): void {
    if (readPendingAuthorization(key)?.hash === hash) localStorage.removeItem(key);
}
