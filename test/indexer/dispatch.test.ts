import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DONATION_VAULT_CONTRACT_ID,
  NGO_REGISTRY_CONTRACT_ID,
} from '../../src/indexer/contracts.js';
import { dispatchEvent } from '../../src/indexer/dispatch.js';
import { handleDonationVaultEvent } from '../../src/indexer/handlers/donationVault.js';
import { handleNgoRegistryEvent } from '../../src/indexer/handlers/ngoRegistry.js';
import type { ContractEvent } from '../../src/indexer/worker.js';
import { logger } from '../../src/logger.js';
import { renderMetrics } from '../../src/metrics.js';
import { makeEvent, symbolScVal } from '../helpers/events.js';

vi.mock('../../src/indexer/contracts.js', () => ({
  NGO_REGISTRY_CONTRACT_ID: 'C_NGO_REGISTRY',
  DONATION_VAULT_CONTRACT_ID: 'C_DONATION_VAULT',
}));

vi.mock('../../src/indexer/handlers/donationVault.js', () => ({
  handleDonationVaultEvent: vi.fn(),
}));

vi.mock('../../src/indexer/handlers/ngoRegistry.js', () => ({
  handleNgoRegistryEvent: vi.fn(),
}));

describe('dispatchEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes event from NGO_REGISTRY_CONTRACT_ID to handleNgoRegistryEvent', async () => {
    const event = {
      ...makeEvent([symbolScVal('test')], symbolScVal('test')),
      contractId: NGO_REGISTRY_CONTRACT_ID,
    } as ContractEvent;

    await dispatchEvent(event);

    expect(handleNgoRegistryEvent).toHaveBeenCalledWith(event);
    expect(handleDonationVaultEvent).not.toHaveBeenCalled();
  });

  it('routes event from DONATION_VAULT_CONTRACT_ID to handleDonationVaultEvent', async () => {
    const event = {
      ...makeEvent([symbolScVal('test')], symbolScVal('test')),
      contractId: DONATION_VAULT_CONTRACT_ID,
    } as ContractEvent;

    await dispatchEvent(event);

    expect(handleDonationVaultEvent).toHaveBeenCalledWith(event);
    expect(handleNgoRegistryEvent).not.toHaveBeenCalled();
  });

  it('logs and counts an event from an unknown contract once per contract id', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const unknownContractId = 'C_UNKNOWN_CONTRACT_ID';
    const unknownTotal = (metrics: string) =>
      Number(metrics.match(/^streamgive_indexer_events_unknown_contract_total (\d+)$/m)?.[1] ?? 0);
    const before = unknownTotal(renderMetrics());
    const event = {
      ...makeEvent([symbolScVal('test')], symbolScVal('test')),
      contractId: unknownContractId,
    } as ContractEvent;

    await dispatchEvent(event);
    await dispatchEvent(event);

    expect(handleNgoRegistryEvent).not.toHaveBeenCalled();
    expect(handleDonationVaultEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { contractId: unknownContractId },
      expect.stringContaining('unrecognised contract'),
    );
    expect(unknownTotal(renderMetrics())).toBe(before + 2);

    warn.mockRestore();
  });
});
