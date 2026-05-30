/**
 * Dashboard component — shows plan usage and upgrade CTA
 */
import { checkPlanLimit, PLAN_CONFIG } from '../api/billing';

interface Props {
  userId: string;
  projectCount: number;
}

export function Dashboard({ userId, projectCount }: Props) {
  const atLimit = !checkPlanLimit(userId, projectCount);
  const freeLimit = PLAN_CONFIG.free.limit; // 5 projects
  const proPrice = PLAN_CONFIG.pro.price;   // $29/month

  return `
    <div class="dashboard">
      <h2>Your Projects (${projectCount} / ${freeLimit})</h2>
      ${atLimit ? `
        <div class="upgrade-banner">
          <p>You've reached the free plan limit of ${freeLimit} projects.</p>
          <p>Upgrade to Pro for unlimited projects — just $${proPrice}/month</p>
          <button onclick="upgradeToPro('${userId}')">Upgrade to Pro — $${proPrice}/mo</button>
        </div>
      ` : ''}
    </div>
  `;
}
