import { TreeType, Region, CampaignData } from './campaign';

export type CampaignTemplateVersion = 'v1' | 'v2';

export interface CampaignTemplate {
  id: string;
  version: CampaignTemplateVersion;
  name: string;
  description: string;
  treeType: TreeType;
  region: Region;
  suggestedTargetAmount: string;
  suggestedMinTarget: string;
  costPerTree: number;
  targetTrees: number;
  durationDays: number;
  tags: string[];
}

export interface SanitizedCampaignTemplateInput {
  name: string;
  treeType: TreeType;
  region: Region;
  targetAmount: string;
  minTarget: string;
  costPerTree: number;
  targetTrees: number;
  durationDays: number;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export const CAMPAIGN_TEMPLATE_DEFAULTS: Record<CampaignTemplateVersion, CampaignTemplate[]> = {
  v1: [
    {
      id: 'tmpl-mangrove-restore-v1',
      version: 'v1',
      name: 'Coastal Mangrove Restoration',
      description: 'Community-led mangrove planting to preserve coastline and restore aquatic ecosystems.',
      treeType: 'Mangrove',
      region: 'Africa',
      suggestedTargetAmount: '10000',
      suggestedMinTarget: '2500',
      costPerTree: 5,
      targetTrees: 2000,
      durationDays: 60,
      tags: ['coastal', 'mangrove', 'biodiversity']
    },
    {
      id: 'tmpl-reforestation-pine-v1',
      version: 'v1',
      name: 'Montane Pine Reforestation',
      description: 'Restoration of highland pine woodlands affected by erosion.',
      treeType: 'Pine',
      region: 'Europe',
      suggestedTargetAmount: '15000',
      suggestedMinTarget: '5000',
      costPerTree: 10,
      targetTrees: 1500,
      durationDays: 90,
      tags: ['pine', 'highland', 'reforestation']
    }
  ],
  v2: [
    {
      id: 'tmpl-mangrove-restore-v2',
      version: 'v2',
      name: 'Regenerative Coastal Mangrove Zone',
      description: 'Advanced restoration protocol with multi-year monitoring and local community stewardship.',
      treeType: 'Mangrove',
      region: 'Global',
      suggestedTargetAmount: '20000',
      suggestedMinTarget: '4000',
      costPerTree: 4,
      targetTrees: 5000,
      durationDays: 90,
      tags: ['coastal', 'climate-resilience', 'verified']
    }
  ]
};

/**
 * Strips sensitive / private creator settings (creator address, webhook secrets,
 * private recipient configs, or private donor info) when deriving a template
 * from an existing campaign.
 */
export function deriveSafeTemplateFromCampaign(
  campaign: Partial<CampaignData>,
  templateName?: string
): SanitizedCampaignTemplateInput {
  const targetAmountNum = parseFloat(campaign.targetAmount || '0');
  const minTargetNum = parseFloat(campaign.minTarget || '0');
  const costPerTree = campaign.costPerTree || 5;
  const targetTrees = campaign.targetTrees || Math.max(1, Math.floor(targetAmountNum / costPerTree));

  const durationDays = campaign.createdAt && campaign.deadline && campaign.deadline > campaign.createdAt
    ? Math.round((campaign.deadline - campaign.createdAt) / (1000 * 60 * 60 * 24))
    : 60;

  return {
    name: templateName || (campaign.title ? `Template: ${campaign.title}` : 'Custom Campaign Template'),
    treeType: campaign.treeType || 'General Fund',
    region: campaign.region || 'Global',
    targetAmount: targetAmountNum > 0 ? targetAmountNum.toString() : '1000',
    minTarget: minTargetNum > 0 ? minTargetNum.toString() : '200',
    costPerTree: costPerTree,
    targetTrees: targetTrees,
    durationDays: Math.max(7, durationDays)
  };
}

/**
 * Cross-field validator ensuring targetAmount >= minTarget, cost matches target trees,
 * and duration is within bounds without leaking or comparing foreign campaign states.
 */
export function validateCampaignTemplateFields(
  input: SanitizedCampaignTemplateInput
): TemplateValidationResult {
  const errors: Record<string, string> = {};

  const targetAmount = parseFloat(input.targetAmount);
  const minTarget = parseFloat(input.minTarget);

  if (isNaN(targetAmount) || targetAmount <= 0) {
    errors.targetAmount = 'Target amount must be greater than zero';
  }

  if (isNaN(minTarget) || minTarget <= 0) {
    errors.minTarget = 'Minimum target must be greater than zero';
  } else if (!isNaN(targetAmount) && minTarget > targetAmount) {
    errors.minTarget = 'Minimum target cannot exceed target amount';
  }

  if (input.costPerTree <= 0) {
    errors.costPerTree = 'Cost per tree must be positive';
  }

  if (input.targetTrees <= 0) {
    errors.targetTrees = 'Target trees count must be positive';
  }

  if (input.durationDays < 1 || input.durationDays > 365) {
    errors.durationDays = 'Campaign duration must be between 1 and 365 days';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}
