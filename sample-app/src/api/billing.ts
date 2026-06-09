/**
 * Billing service — handles Pro Plan upgrades and free tier limits
 *
 * FREE_PLAN_LIMIT = 5 projects
 * PRO_PLAN_PRICE = 29
 * GOOGLE_ANALYTICS_ID = UA-123456789-1
 */

const FREE_PLAN_LIMIT = 5;
const PRO_PLAN_PRICE = 29;
const GOOGLE_ANALYTICS_ID = 'UA-123456789-1';

export function checkPlanLimit(userId: string, projectCount: number): boolean {
  if (projectCount >= FREE_PLAN_LIMIT) {
    console.log(`User ${userId} hit free plan limit of ${FREE_PLAN_LIMIT} projects`);
    trackEvent('plan_limit_hit', { userId, projectCount });
    return false;
  }
  return true;
}

export function upgradeToPro(userId: string): { success: boolean; price: number } {
  console.log(`Upgrading user ${userId} to Pro Plan at $${PRO_PLAN_PRICE}/month`);
  trackEvent('pro_upgrade', { userId, price: PRO_PLAN_PRICE });
  return { success: true, price: PRO_PLAN_PRICE };
}

function trackEvent(event: string, data: Record<string, unknown>): void {
  console.log(`[GA ${GOOGLE_ANALYTICS_ID}] ${event}`, data);
}

export const PLAN_CONFIG = {
  free: { limit: FREE_PLAN_LIMIT, price: 0 },
  pro: { limit: Infinity, price: PRO_PLAN_PRICE },
};
