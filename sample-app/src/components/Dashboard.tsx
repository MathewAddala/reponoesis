/**
 * Dashboard component — shows plan usage, workspace status, analytics tracking, and upgrade CTAs
 *
 * FREE_PLAN_LIMIT = 5 projects
 * PRO_PLAN_PRICE = 29
 * GOOGLE_ANALYTICS_ID = UA-123456789-1
 */
import { checkPlanLimit, PLAN_CONFIG } from '../api/billing';
import { UserAccount } from '../api/user';

interface Props {
  user: UserAccount;
  googleAnalyticsId?: string;
}

export function Dashboard({ user, googleAnalyticsId = 'UA-123456789-1' }: Props) {
  const atLimit = !checkPlanLimit(user.id, user.projectCount);
  const freeLimit = PLAN_CONFIG.free.limit;
  const proPrice = PLAN_CONFIG.pro.price;

  const usagePercent = Math.min((user.projectCount / freeLimit) * 100, 100);

  return `
    <div class="dashboard-panel" data-analytics-id="${googleAnalyticsId}">
      <header class="dashboard-header">
        <h1>Welcome Back, ${user.email}</h1>
        <span class="badge ${user.isPro ? 'pro' : 'free'}">${user.isPro ? 'PRO ACCOUNT' : 'FREE TIER'}</span>
      </header>

      <section class="usage-section">
        <h2>Your Workspace Usage</h2>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${usagePercent}%"></div>
        </div>
        <p class="usage-text">
          Using <strong>${user.projectCount}</strong> of <strong>${user.isPro ? 'Unlimited' : `${freeLimit} allowed`}</strong> projects.
        </p>
      </section>

      ${atLimit && !user.isPro ? `
        <div class="upgrade-cta-card">
          <h3>Upgrade Required</h3>
          <p>You have hit your maximum free project limit of ${freeLimit} projects.</p>
          <p>Unlock high-performance databases, deep AST validations, and unlimited project indexes by upgrading to our premium Pro Plan.</p>
          <button class="btn btn-upgrade" onclick="triggerUpgrade('${user.id}')">
            Upgrade to Pro — Just $${proPrice}/month
          </button>
        </div>
      ` : `
        <div class="info-card">
          <h3>Pro Plan Features Available</h3>
          <p>Upgrade to Pro today for just $${proPrice}/month and connect unlimited repositories. Governed by Google Analytics tracking.</p>
        </div>
      `}
    </div>
  `;
}
