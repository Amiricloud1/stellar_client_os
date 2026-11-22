/**
 * Campaign Schedule Service
 * 
 * Objective 2: Schedule Review Before Launch
 * ==========================================
 * 
 * Allows a bounded schedule to be reviewed before campaign launch and defines
 * how edits interact with contributions already accepted.
 * 
 * Key constraints:
 *   - Schedule can only be edited while campaign is in DRAFT or SCHEDULED state
 *   - Once campaign goes ACTIVE, schedule becomes immutable
 *   - If contributions have been accepted before launch, certain edits are forbidden
 *   - All schedule changes are audited for compliance
 */

export type CampaignScheduleState = 
  | "DRAFT" 
  | "SCHEDULED" 
  | "ACTIVE" 
  | "PAUSED" 
  | "COMPLETED" 
  | "CANCELLED";

/**
 * Campaign schedule that can be reviewed before launch
 */
export interface CampaignSchedule {
  campaignId: string;
  startDate: Date;
  endDate: Date;
  minDurationDays: number;
  maxDurationDays: number;
  
  // Milestones
  milestones: CampaignMilestone[];
  
  // State tracking
  state: CampaignScheduleState;
  acceptedContributionsCount: number;
  totalAcceptedAmount: bigint;
  
  createdAt: Date;
  reviewedAt?: Date;
  publishedAt?: Date;
  archivedAt?: Date;
}

/**
 * A campaign milestone (e.g., planting dates, verification windows, etc.)
 */
export interface CampaignMilestone {
  id: string;
  name: string;
  description?: string;
  scheduledDate: Date;
  type: "PLANTING" | "VERIFICATION" | "REWARD_STREAM" | "CUSTOM";
  
  // Edit tracking
  isLocked: boolean; // true if contributions accepted for this milestone
  lockedReason?: string;
}

/**
 * Audit entry for schedule edits
 */
export interface ScheduleEditAuditEntry {
  id: string;
  campaignId: string;
  editType: "MILESTONE_ADDED" | "MILESTONE_UPDATED" | "MILESTONE_REMOVED" | "SCHEDULE_EXTENDED" | "SCHEDULE_SHORTENED";
  previousValue?: unknown;
  newValue: unknown;
  editedBy: string;
  editedAt: Date;
  
  // Compliance tracking
  affectsAcceptedContributions: boolean;
  complianceReason?: string;
}

/**
 * Result of attempting to edit a schedule
 */
export interface ScheduleEditResult {
  success: boolean;
  error?: string;
  warning?: string;
  affectsExistingContributions: boolean;
  auditEntry?: ScheduleEditAuditEntry;
}

export class CampaignScheduleService {
  /**
   * Validates whether a schedule can be reviewed for launch.
   * 
   * Returns validation errors if:
   *   - Start date is in the past
   *   - End date is before start date
   *   - Duration violates min/max constraints
   *   - No milestones defined
   */
  static validateScheduleForReview(
    schedule: Omit<CampaignSchedule, 'state' | 'createdAt' | 'reviewedAt' | 'publishedAt' | 'archivedAt'> & {
      state: CampaignScheduleState;
      acceptedContributionsCount: number;
    }
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const now = new Date();

    // Validate dates
    if (schedule.startDate < now) {
      errors.push("Start date cannot be in the past");
    }

    if (schedule.endDate <= schedule.startDate) {
      errors.push("End date must be after start date");
    }

    // Validate duration
    const durationDays = Math.floor(
      (schedule.endDate.getTime() - schedule.startDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (durationDays < schedule.minDurationDays) {
      errors.push(`Duration must be at least ${schedule.minDurationDays} days`);
    }

    if (durationDays > schedule.maxDurationDays) {
      errors.push(`Duration cannot exceed ${schedule.maxDurationDays} days`);
    }

    // Validate milestones
    if (!schedule.milestones || schedule.milestones.length === 0) {
      errors.push("At least one milestone must be defined");
    }

    // Check for orphaned milestones
    schedule.milestones.forEach((milestone) => {
      if (milestone.scheduledDate < schedule.startDate || milestone.scheduledDate > schedule.endDate) {
        errors.push(`Milestone "${milestone.name}" is outside the campaign date range`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Attempts to edit a milestone in an active schedule.
   * 
   * Edits are forbidden if:
   *   - Campaign is ACTIVE (schedule immutable)
   *   - Contributions have been accepted for this milestone
   */
  static attemptMilestoneEdit(
    schedule: CampaignSchedule,
    milestoneId: string,
    newDate: Date,
    editedBy: string
  ): ScheduleEditResult {
    // Check if campaign is active
    if (schedule.state === "ACTIVE") {
      return {
        success: false,
        error: "Campaign is active — schedule cannot be modified",
        affectsExistingContributions: true,
      };
    }

    // Find the milestone
    const milestone = schedule.milestones.find((m) => m.id === milestoneId);
    if (!milestone) {
      return {
        success: false,
        error: `Milestone with ID ${milestoneId} not found`,
        affectsExistingContributions: false,
      };
    }

    // Check if milestone is locked
    if (milestone.isLocked) {
      return {
        success: false,
        error: `Milestone "${milestone.name}" is locked — contributions have already been accepted for this date`,
        warning: `Reason: ${milestone.lockedReason}`,
        affectsExistingContributions: true,
      };
    }

    // Validate new date is within schedule bounds
    if (newDate < schedule.startDate || newDate > schedule.endDate) {
      return {
        success: false,
        error: "New milestone date is outside the campaign date range",
        affectsExistingContributions: false,
      };
    }

    // Success — create audit entry
    const auditEntry: ScheduleEditAuditEntry = {
      id: `audit-${Date.now()}`,
      campaignId: schedule.campaignId,
      editType: "MILESTONE_UPDATED",
      previousValue: milestone.scheduledDate,
      newValue: newDate,
      editedBy,
      editedAt: new Date(),
      affectsAcceptedContributions: schedule.acceptedContributionsCount > 0,
      complianceReason: schedule.acceptedContributionsCount > 0
        ? "Edit made while campaign has accepted contributions — monitor for fairness"
        : undefined,
    };

    return {
      success: true,
      affectsExistingContributions: schedule.acceptedContributionsCount > 0,
      auditEntry,
    };
  }

  /**
   * Marks a milestone as locked (read-only) because contributions have been accepted.
   * 
   * Once locked, the milestone's date cannot be changed.
   */
  static lockMilestoneForContributions(
    milestone: CampaignMilestone,
    acceptanceCount: number
  ): CampaignMilestone {
    return {
      ...milestone,
      isLocked: true,
      lockedReason: `${acceptanceCount} contribution(s) accepted for this milestone`,
    };
  }

  /**
   * Determines which milestones are affected by a schedule extension/shortening
   */
  static identifyAffectedMilestones(
    schedule: CampaignSchedule,
    newEndDate: Date
  ): { affected: CampaignMilestone[]; locked: CampaignMilestone[] } {
    const affected = schedule.milestones.filter(
      (m) => m.scheduledDate > newEndDate
    );
    const locked = affected.filter((m) => m.isLocked);

    return { affected, locked };
  }
}
