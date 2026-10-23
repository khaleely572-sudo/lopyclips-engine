import {PermanentError} from '../jobs/queue.mjs';

export const PERMISSION_STATUSES = ['unknown', 'authorized', 'denied'];
export const PERMISSION_BLOCK_PREFIX = 'permission:';

/**
 * The single rule for whether a creator's footage may be fetched, edited or published.
 * A creator must be explicitly authorized by the channel owner, with a written basis.
 */
export const checkAccess = (creator) => {
  if (!creator) {
    return {allowed: false, reason: `${PERMISSION_BLOCK_PREFIX} creator not found`};
  }
  if (creator.permission_status === 'denied') {
    return {allowed: false, reason: `${PERMISSION_BLOCK_PREFIX} this creator is marked as not permitting clips`};
  }
  if (creator.permission_status !== 'authorized') {
    return {allowed: false, reason: `${PERMISSION_BLOCK_PREFIX} no permission has been recorded for this creator`};
  }
  if (!creator.permission_basis || !creator.permission_basis.trim()) {
    return {allowed: false, reason: `${PERMISSION_BLOCK_PREFIX} creator is marked authorized but no basis is written down`};
  }
  return {allowed: true, reason: null};
};

export const assertAccess = (creator) => {
  const access = checkAccess(creator);
  if (!access.allowed) {
    throw new PermanentError(`Blocked — ${access.reason}`);
  }
};
