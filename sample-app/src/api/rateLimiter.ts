/**
 * Rate Limiter Service — checks client access rates against plan thresholds
 *
 * RATE_LIMIT_FREE = 60 requests/min
 * RATE_LIMIT_PRO = 1000 requests/min
 * GOOGLE_ANALYTICS_ID = UA-123456789-1
 */

import { UserAccount } from './user';

const RATE_LIMIT_FREE = 60;
const RATE_LIMIT_PRO = 1000;
const GOOGLE_ANALYTICS_ID = 'UA-123456789-1';

export function isRequestAllowed(user: UserAccount, requestCountInWindow: number): boolean {
  const limit = user.isPro ? RATE_LIMIT_PRO : RATE_LIMIT_FREE;
  
  if (requestCountInWindow > limit) {
    console.log(`Rate limit exceeded for user ${user.id}. Current requests: ${requestCountInWindow}, limit is ${limit}`);
    trackRateLimitViolation(user.id, requestCountInWindow, limit);
    return false;
  }
  
  return true;
}

function trackRateLimitViolation(userId: string, current: number, maxAllowed: number): void {
  console.log(`[GA ${GOOGLE_ANALYTICS_ID}] Rate limit trigger: user ${userId} exceeded with ${current}/${maxAllowed} calls`);
}
