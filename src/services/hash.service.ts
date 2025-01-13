import crypto from 'crypto';

export class HashService {
  static generateHash(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }
}
