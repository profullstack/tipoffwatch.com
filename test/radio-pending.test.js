import { beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetPending,
  dropPending,
  peekPending,
  putPending,
  takePending,
} from '../packages/radio/src/pending.js';

describe('pending sign-ins', () => {
  beforeEach(() => _resetPending());

  test('take is single-use; peek shows only what the page needs', () => {
    putPending('u1', { email: 'a@b.c', identityId: 'i', anonAccessToken: 't', cookies: 'j=1' });
    expect(peekPending('u1')).toMatchObject({ email: 'a@b.c' });
    expect(peekPending('u1')).not.toHaveProperty('cookies');
    const taken = takePending('u1');
    expect(taken).toMatchObject({ identityId: 'i', cookies: 'j=1' });
    expect(takePending('u1')).toBeNull();
    expect(peekPending('u1')).toBeNull();
  });

  test('one reader cannot see another\'s', () => {
    putPending('u1', { email: 'a@b.c' });
    expect(peekPending('u2')).toBeNull();
    dropPending('u1');
    expect(peekPending('u1')).toBeNull();
  });
});
