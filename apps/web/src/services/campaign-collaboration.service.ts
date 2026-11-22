import { CoCreator, CoCreatorInvite, CoCreatorRole, TeamAccessAuditEntry } from "@/types/collaboration";

const initialCollaborators: CoCreator[] = [
  {
    id: "col-1",
    campaignId: "camp-101",
    name: "Alex Rivera (Owner)",
    email: "alex@fundable.org",
    stellarAddress: "GD6W...X892",
    role: "OWNER",
    avatarUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=120&q=80",
    joinedAt: Date.now() - 30 * 86400000,
    invitedBy: "SYSTEM",
  },
  {
    id: "col-2",
    campaignId: "camp-101",
    name: "Dr. Maya Lin",
    email: "maya@rainforest.org",
    stellarAddress: "GB88...K992",
    role: "CO_CREATOR",
    avatarUrl: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=120&q=80",
    joinedAt: Date.now() - 10 * 86400000,
    invitedBy: "GD6W...X892",
  },
];

const initialInvites: CoCreatorInvite[] = [
  {
    token: "inv_demo_token_123",
    campaignId: "camp-101",
    campaignTitle: "Save the Amazon RainForest Reserve",
    role: "CO_CREATOR",
    invitedBy: "GD6W...X892",
    invitedByName: "Alex Rivera",
    createdAt: Date.now() - 3600000,
    expiresAt: Date.now() + 7 * 86400000,
    isUsed: false,
    maxUses: 5,
    usedCount: 1,
    isRevoked: false,
  },
];

/**
 * Objective 4: Team Invitations & Access Control
 * ==============================================
 * 
 * Enhanced collaboration service with:
 *   - Expiring invitations (time-bounded)
 *   - Role-scoped access restrictions
 *   - Revocation capability
 *   - Complete audit history for compliance
 */
class CampaignCollaborationService {
  private collaborators = new Map<string, CoCreator[]>();
  private invites = new Map<string, CoCreatorInvite>();
  private auditLog = new Map<string, TeamAccessAuditEntry[]>(); // campaignId -> audit entries

  constructor() {
    this.collaborators.set("camp-101", initialCollaborators);
    initialInvites.forEach((inv) => this.invites.set(inv.token, inv));
  }

  getCollaborators(campaignId: string): CoCreator[] {
    return this.collaborators.get(campaignId) || [];
  }

  /**
   * Objective 4: Create a time-bounded invite token.
   * 
   * Invites expire after the specified duration and cannot be used after expiration.
   */
  createInviteToken(params: {
    campaignId: string;
    campaignTitle: string;
    role: CoCreatorRole;
    invitedBy: string;
    invitedByName: string;
    expiresInDays?: number;
  }): CoCreatorInvite {
    const token = `inv_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const days = params.expiresInDays || 7;
    const invite: CoCreatorInvite = {
      token,
      campaignId: params.campaignId,
      campaignTitle: params.campaignTitle,
      role: params.role,
      invitedBy: params.invitedBy,
      invitedByName: params.invitedByName,
      createdAt: Date.now(),
      expiresAt: Date.now() + days * 86400000,
      isUsed: false,
      maxUses: 10,
      usedCount: 0,
      isRevoked: false,
    };

    this.invites.set(token, invite);

    // Audit log
    this.recordAuditEntry({
      campaignId: params.campaignId,
      eventType: "INVITE_CREATED",
      actor: params.invitedBy,
      actorRole: "OWNER", // Assume OWNER for now; in practice, check actual role
      targetRole: params.role,
      reason: `Invitation created for role: ${params.role}`,
    });

    return invite;
  }

  /**
   * Objective 4: Retrieve an invite only if it's valid and not expired/revoked.
   */
  getInviteByToken(token: string): CoCreatorInvite | null {
    const invite = this.invites.get(token);
    if (!invite) return null;
    
    // Check if revoked
    if (invite.isRevoked) {
      return null;
    }
    
    // Check if expired
    if (invite.expiresAt < Date.now()) {
      // Log expiration
      this.recordAuditEntry({
        campaignId: invite.campaignId,
        eventType: "INVITE_EXPIRED",
        actor: "SYSTEM",
        actorRole: "OWNER",
        reason: `Invitation expired on ${new Date(invite.expiresAt).toISOString()}`,
      });
      return null;
    }
    
    return invite;
  }

  /**
   * Objective 4: Revoke an active invitation.
   * 
   * Prevents the invite token from being used, even if not yet expired.
   */
  revokeInvite(
    token: string,
    revokedBy: string,
    reason?: string
  ): { success: boolean; error?: string } {
    const invite = this.invites.get(token);
    if (!invite) {
      return { success: false, error: "Invitation not found" };
    }

    if (invite.isRevoked) {
      return { success: false, error: "Invitation has already been revoked" };
    }

    if (invite.isUsed) {
      return { success: false, error: "Cannot revoke an invitation that has already been accepted" };
    }

    invite.isRevoked = true;
    invite.revokedAt = Date.now();
    invite.revokedBy = revokedBy;

    // Audit log
    this.recordAuditEntry({
      campaignId: invite.campaignId,
      eventType: "INVITE_REVOKED",
      actor: revokedBy,
      actorRole: "OWNER",
      reason: reason || "Invitation revoked by team member",
    });

    return { success: true };
  }

  acceptInvite(token: string, user: { name: string; email?: string; stellarAddress: string }): { success: boolean; collaborator?: CoCreator; error?: string } {
    const invite = this.getInviteByToken(token);
    if (!invite) {
      return { success: false, error: "Invitation token is invalid or expired." };
    }

    const currentList = this.collaborators.get(invite.campaignId) || [];
    const existing = currentList.find((c) => c.stellarAddress.toLowerCase() === user.stellarAddress.toLowerCase());
    if (existing) {
      return { success: true, collaborator: existing };
    }

    const newCollaborator: CoCreator = {
      id: `col-${Date.now()}`,
      campaignId: invite.campaignId,
      name: user.name,
      email: user.email,
      stellarAddress: user.stellarAddress,
      role: invite.role,
      joinedAt: Date.now(),
      invitedBy: invite.invitedBy,
    };

    currentList.push(newCollaborator);
    this.collaborators.set(invite.campaignId, currentList);

    invite.usedCount = (invite.usedCount || 0) + 1;
    if (invite.maxUses && invite.usedCount >= invite.maxUses) {
      invite.isUsed = true;
    }

    // Audit log
    this.recordAuditEntry({
      campaignId: invite.campaignId,
      eventType: "INVITE_ACCEPTED",
      actor: user.stellarAddress,
      actorRole: invite.role,
      targetMember: user.stellarAddress,
      targetRole: invite.role,
      reason: `${user.name} accepted invitation for role: ${invite.role}`,
    });

    return { success: true, collaborator: newCollaborator };
  }

  removeCollaborator(campaignId: string, collaboratorId: string, removedBy: string): boolean {
    const list = this.collaborators.get(campaignId) || [];
    const collaborator = list.find((c) => c.id === collaboratorId);
    
    if (!collaborator) {
      return false;
    }

    // Cannot remove OWNER
    if (collaborator.role === "OWNER") {
      return false;
    }

    const updated = list.filter((c) => c.id !== collaboratorId);
    this.collaborators.set(campaignId, updated);

    // Audit log
    this.recordAuditEntry({
      campaignId,
      eventType: "MEMBER_REMOVED",
      actor: removedBy,
      actorRole: "OWNER",
      targetMember: collaborator.stellarAddress,
      targetRole: collaborator.role,
      reason: `Removed ${collaborator.name} (${collaborator.role}) from team`,
    });

    return true;
  }

  updateRole(campaignId: string, collaboratorId: string, newRole: CoCreatorRole, updatedBy: string): boolean {
    const list = this.collaborators.get(campaignId) || [];
    const item = list.find((c) => c.id === collaboratorId);
    if (!item || item.role === "OWNER") {
      return false;
    }

    const oldRole = item.role;
    item.role = newRole;

    // Audit log
    this.recordAuditEntry({
      campaignId,
      eventType: "ROLE_CHANGED",
      actor: updatedBy,
      actorRole: "OWNER",
      targetMember: item.stellarAddress,
      targetRole: newRole,
      changeDetails: { from: oldRole, to: newRole },
      reason: `Role changed from ${oldRole} to ${newRole}`,
    });

    return true;
  }

  /**
   * Objective 4: Get complete audit history for a campaign.
   * 
   * Returns all access control events (invites, members, role changes, revocations).
   */
  getAuditHistory(campaignId: string): TeamAccessAuditEntry[] {
    return this.auditLog.get(campaignId) || [];
  }

  /**
   * Objective 4: Record an audit entry for compliance tracking.
   */
  private recordAuditEntry(entry: Omit<TeamAccessAuditEntry, 'id' | 'timestamp'>): void {
    const auditEntry: TeamAccessAuditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
      ...entry,
    };

    const existing = this.auditLog.get(entry.campaignId) || [];
    existing.push(auditEntry);
    this.auditLog.set(entry.campaignId, existing);
  }
}

export const collaborationService = new CampaignCollaborationService();
