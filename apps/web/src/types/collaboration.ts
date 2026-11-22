export type CoCreatorRole = "OWNER" | "CO_CREATOR" | "EDITOR" | "VIEWER";

export interface CampaignPermissions {
  canEditDetails: boolean;
  canEditGoals: boolean;
  canEditTimeline: boolean;
  canManageCollaborators: boolean;
  canWithdrawFunds: boolean;
  canDeleteCampaign: boolean;
}

export const ROLE_PERMISSIONS: Record<CoCreatorRole, CampaignPermissions> = {
  OWNER: {
    canEditDetails: true,
    canEditGoals: true,
    canEditTimeline: true,
    canManageCollaborators: true,
    canWithdrawFunds: true,
    canDeleteCampaign: true,
  },
  CO_CREATOR: {
    canEditDetails: true,
    canEditGoals: true,
    canEditTimeline: true,
    canManageCollaborators: true,
    canWithdrawFunds: false,
    canDeleteCampaign: false,
  },
  EDITOR: {
    canEditDetails: true,
    canEditGoals: false,
    canEditTimeline: true,
    canManageCollaborators: false,
    canWithdrawFunds: false,
    canDeleteCampaign: false,
  },
  VIEWER: {
    canEditDetails: false,
    canEditGoals: false,
    canEditTimeline: false,
    canManageCollaborators: false,
    canWithdrawFunds: false,
    canDeleteCampaign: false,
  },
};

export interface CoCreator {
  id: string;
  campaignId: string;
  name: string;
  email?: string;
  stellarAddress: string;
  role: CoCreatorRole;
  avatarUrl?: string;
  joinedAt: number; // timestamp ms
  invitedBy: string;
}

/**
 * Objective 4: Team Invitations & Access Control
 * ==============================================
 * 
 * Enhanced invite tracking with:
 *   - Expiration support (time-bounded invitations)
 *   - Role-scoped access restrictions
 *   - Revocation capability
 *   - Audit history tracking
 */
export interface CoCreatorInvite {
  token: string;
  campaignId: string;
  campaignTitle: string;
  role: CoCreatorRole;
  invitedBy: string;
  invitedByName: string;
  createdAt: number;
  expiresAt: number;
  isUsed: boolean;
  maxUses?: number;
  usedCount?: number;
  
  // Objective 4: Revocation and audit
  isRevoked?: boolean;
  revokedAt?: number;
  revokedBy?: string;
}

/**
 * Audit entry for team access control events
 */
export interface TeamAccessAuditEntry {
  id: string;
  campaignId: string;
  eventType: 
    | "INVITE_CREATED" 
    | "INVITE_ACCEPTED" 
    | "INVITE_EXPIRED" 
    | "INVITE_REVOKED" 
    | "MEMBER_ADDED" 
    | "ROLE_CHANGED" 
    | "MEMBER_REMOVED";
  
  // Actor and target
  actor: string;
  actorRole: CoCreatorRole;
  targetMember?: string;
  targetRole?: CoCreatorRole;
  
  // Event details
  reason?: string;
  changeDetails?: Record<string, unknown>;
  
  // Timestamp
  timestamp: number;
  ipAddress?: string; // For security auditing
}

export function formatTruncatedAddress(address: string): string {
  if (!address || address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

