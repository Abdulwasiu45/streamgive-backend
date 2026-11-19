import { logger } from '../logger.js';
import { recordIndexerEventUnknownContract } from '../metrics.js';
import { DONATION_VAULT_CONTRACT_ID, NGO_REGISTRY_CONTRACT_ID } from './contracts.js';
import { handleDonationVaultEvent } from './handlers/donationVault.js';
import { handleNgoRegistryEvent } from './handlers/ngoRegistry.js';
import type { ContractEvent, EventHandler } from './worker.js';

// The worker only asks the RPC for watched contracts, so an unknown id here
// means the event filter and the dispatcher disagree. Warning once per id
// keeps a misconfigured contract id visible without logging every event.
const warnedContractIds = new Set<string>();

export const dispatchEvent: EventHandler = async (event: ContractEvent) => {
  const contractId = event.contractId?.toString();

  switch (contractId) {
    case NGO_REGISTRY_CONTRACT_ID:
      await handleNgoRegistryEvent(event);
      break;
    case DONATION_VAULT_CONTRACT_ID:
      await handleDonationVaultEvent(event);
      break;
    default:
      recordIndexerEventUnknownContract();
      if (contractId !== undefined && !warnedContractIds.has(contractId)) {
        warnedContractIds.add(contractId);
        logger.warn(
          { contractId },
          'indexer: ignoring event from an unrecognised contract; check NGO_REGISTRY_CONTRACT_ID and DONATION_VAULT_CONTRACT_ID',
        );
      }
      break;
  }
};
