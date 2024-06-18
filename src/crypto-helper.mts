import { randomBytes } from 'node:crypto';

export class CryptoHelper {
    createRandomHexString(lengthMultipleOf2: number): string {
        return randomBytes(lengthMultipleOf2 / 2).toString('hex');
    }
}