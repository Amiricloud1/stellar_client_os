/**
 * Campaign data models and filter types for the Stellar Client OS frontend.
 */

export type CampaignStatus = "Active" | "Paused" | "Successful" | "Failed" | "Claimed";

export type TreeType =
  | "Oak"
  | "Mangrove"
  | "Pine"
  | "Acacia"
  | "Cedar"
  | "Fruit Tree"
  | "Baobab"
  | "Redwood"
  | "Birch"
  | "General Fund";

export type Region = 
  | "North America"
  | "South America"
  | "Europe"
  | "Africa"
  | "Asia"
  | "Oceania"
  | "Global";

export interface SustainabilityPillarScore {
  score: number;
  maxScore: number;
  percentage: number;
  grade: "Optimal" | "High" | "Moderate" | "Developing";
  title: string;
  rationale: string;
  highlights: string[];
}

export type SustainabilityTier = "Optimal" | "High Impact" | "Moderate" | "Developing";

export interface CampaignSustainabilityScore {
  totalScore: number;
  tier: SustainabilityTier;
  tierDescription: string;
  pillars: {
    speciesDiversity: SustainabilityPillarScore;
    climateImpact: SustainabilityPillarScore;
    soilHealth: SustainabilityPillarScore;
    biodiversityPotential: SustainabilityPillarScore;
  };
  recommendations: string[];
}

export interface CampaignCoordinates {
  latitude: number;
  longitude: number;
}

export interface CampaignData {
  id: string;
  title: string;
  description: string;
  creator: string;
  token: string;
  targetAmount: string;
  minTarget: string;
  totalRaised: string;
  status: CampaignStatus;
  treeType: TreeType;
  costPerTree: number;
  treesPlanted: number;
  targetTrees: number;
  createdAt: number;
  deadline: number;
  location?: string;
  region?: Region;
  imageUrl?: string;
  sponsorCount?: number;
  uniqueContributors?: number;
  contributionCount?: number;
  sustainabilityScore?: CampaignSustainabilityScore;
  /**
   * Version of the incremental aggregate logic that produced the totals above.
   * Optional for backward compatibility with campaigns served by older backends.
   */
  aggregateVersion?: number;
  /**
   * Identifier of the last contribution event folded into the incremental
   * aggregates. Used to detect duplicate or out-of-order event delivery.
   */
  lastProcessedEventId?: string;
  /**
   * Timestamp (ms since epoch) of the last successful reconciliation against a
   * full recomputation. Absent when the campaign has never been reconciled.
   */
  lastReconciledAt?: number;
  /**
   * True when the incremental totals diverged from the full recomputation.
   * UI should surface this state and gate on it until reconciliation succeeds.
   */
  driftDetected?: boolean;
}

export interface CampaignFilterOptions {
  searchQuery: string;
  status: CampaignStatus | "All";
  treeType: TreeType | "All";
  region: Region | "All";
  progressRange: "All" | "0-25%" | "25-50%" | "50-75%" | "75-100%" | "100%+";
  sortBy: "trending" | "newest" | "progress" | "target";
}
