/**
 * User Account Service — manages user registration and workspace limits
 * 
 * Free tier accounts are limited to FREE_PLAN_LIMIT projects.
 * Upgrade option redirects to pro upgrade funnel at PRO_PLAN_PRICE/month.
 */

import { checkPlanLimit, upgradeToPro, PLAN_CONFIG } from './billing';

export interface UserAccount {
  id: string;
  email: string;
  isPro: boolean;
  projectCount: number;
}

export function registerUser(email: string): UserAccount {
  console.log(`Registering new user: ${email}`);
  return {
    id: `usr_${Math.random().toString(36).substr(2, 9)}`,
    email,
    isPro: false,
    projectCount: 0
  };
}

export function createProjectForUser(user: UserAccount): { success: boolean; message: string } {
  const allowed = checkPlanLimit(user.id, user.projectCount);
  if (!allowed) {
    return { 
      success: false, 
      message: `Limit hit! You have reached your ${PLAN_CONFIG.free.limit} project limit. Upgrade to Pro for $${PLAN_CONFIG.pro.price}/mo.` 
    };
  }
  user.projectCount++;
  return { success: true, message: 'Project created successfully.' };
}

export function handleUpgradeRequest(user: UserAccount): { success: boolean; message: string } {
  if (user.isPro) {
    return { success: false, message: 'User is already on the Pro plan.' };
  }
  const result = upgradeToPro(user.id);
  if (result.success) {
    user.isPro = true;
    return { success: true, message: `Upgraded successfully! Charged $${result.price}/month.` };
  }
  return { success: false, message: 'Upgrade transaction failed.' };
}
