import { afterEach, describe, expect, it } from 'vitest';

import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  hashRequestBody,
} from '../src/idempotency/index.js';
import { resetDb } from './helpers/db.js';

describe('idempotency keys are scoped per route', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('lets the same client key proceed independently on two routes', async () => {
    const hash = hashRequestBody('{"amount":1}');

    const first = await beginIdempotentRequest('route-a', 'shared-key', hash);
    const second = await beginIdempotentRequest('route-b', 'shared-key', hash);

    expect(first).toEqual({ kind: 'proceed', key: 'route-a:shared-key' });
    expect(second).toEqual({ kind: 'proceed', key: 'route-b:shared-key' });
  });

  it('does not replay or conflict with another route, even for a different body', async () => {
    const started = await beginIdempotentRequest('route-a', 'shared-key', hashRequestBody('one'));
    if (started.kind !== 'proceed') throw new Error('expected the first request to proceed');
    await completeIdempotentRequest(started.key, 201, { id: 'created-on-a' });

    const other = await beginIdempotentRequest('route-b', 'shared-key', hashRequestBody('two'));

    expect(other).toEqual({ kind: 'proceed', key: 'route-b:shared-key' });
  });

  it('still replays the stored response on the same route', async () => {
    const hash = hashRequestBody('same');
    const started = await beginIdempotentRequest('route-a', 'shared-key', hash);
    if (started.kind !== 'proceed') throw new Error('expected the first request to proceed');
    await completeIdempotentRequest(started.key, 201, { id: 'created-on-a' });

    const again = await beginIdempotentRequest('route-a', 'shared-key', hash);

    expect(again).toEqual({ kind: 'replay', statusCode: 201, response: { id: 'created-on-a' } });
  });
});
