import { describe, it, expect, beforeEach } from 'vitest';
import { 
  CampaignScheduleService, 
  CampaignSchedule,
  CampaignMilestone 
} from './campaign-schedule.service';

describe('CampaignScheduleService', () => {
  /**
   * Objective 2: Schedule Review Before Launch Tests
   */
  describe('validateScheduleForReview', () => {
    let validSchedule: Omit<CampaignSchedule, 'state' | 'createdAt' | 'reviewedAt' | 'publishedAt' | 'archivedAt'> & {
      state: 'DRAFT';
      acceptedContributionsCount: number;
    };

    beforeEach(() => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextWeek = new Date(tomorrow);
      nextWeek.setDate(nextWeek.getDate() + 7);

      validSchedule = {
        campaignId: 'camp-123',
        startDate: tomorrow,
        endDate: nextWeek,
        minDurationDays: 3,
        maxDurationDays: 30,
        state: 'DRAFT',
        acceptedContributionsCount: 0,
        milestones: [
          {
            id: 'milestone-1',
            name: 'Planting Phase',
            scheduledDate: tomorrow,
            type: 'PLANTING',
            isLocked: false,
          },
        ],
      };
    });

    it('validates a well-formed schedule', () => {
      const result = CampaignScheduleService.validateScheduleForReview(validSchedule);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects schedule with past start date', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      validSchedule.startDate = pastDate;

      const result = CampaignScheduleService.validateScheduleForReview(validSchedule);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Start date cannot be in the past');
    });

    it('rejects schedule with end date before start date', () => {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      validSchedule.startDate = tomorrow;
      validSchedule.endDate = today;

      const result = CampaignScheduleService.validateScheduleForReview(validSchedule);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('End date must be after start date');
    });

    it('rejects schedule with duration below minimum', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dayAfter = new Date(tomorrow);
      dayAfter.setDate(dayAfter.getDate() + 1);

      validSchedule.startDate = tomorrow;
      validSchedule.endDate = dayAfter;
      validSchedule.minDurationDays = 5;

      const result = CampaignScheduleService.validateScheduleForReview(validSchedule);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least'))).toBe(true);
    });

    it('rejects schedule with duration above maximum', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const later = new Date(tomorrow);
      later.setDate(later.getDate() + 60);

      validSchedule.startDate = tomorrow;
      validSchedule.endDate = later;
      validSchedule.maxDurationDays = 30;

      const result = CampaignScheduleService.validateScheduleForReview(validSchedule);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('cannot exceed'))).toBe(true);
    });

    it('rejects schedule with no milestones', () => {
      validSchedule.milestones = [];

      const result = CampaignScheduleService.validateScheduleForReview(validSchedule);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('At least one milestone must be defined');
    });

    it('rejects schedule with milestone outside date range', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextMonth = new Date(tomorrow);
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      validSchedule.startDate = tomorrow;
      validSchedule.endDate = new Date(tomorrow);
      validSchedule.endDate.setDate(validSchedule.endDate.getDate() + 7);
      validSchedule.milestones[0].scheduledDate = nextMonth;

      const result = CampaignScheduleService.validateScheduleForReview(validSchedule);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('outside'))).toBe(true);
    });
  });

  describe('attemptMilestoneEdit', () => {
    let schedule: CampaignSchedule;
    let milestone: CampaignMilestone;

    beforeEach(() => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextWeek = new Date(tomorrow);
      nextWeek.setDate(nextWeek.getDate() + 7);

      milestone = {
        id: 'milestone-1',
        name: 'Planting Phase',
        scheduledDate: tomorrow,
        type: 'PLANTING',
        isLocked: false,
      };

      schedule = {
        campaignId: 'camp-123',
        startDate: tomorrow,
        endDate: nextWeek,
        minDurationDays: 3,
        maxDurationDays: 30,
        state: 'SCHEDULED',
        acceptedContributionsCount: 0,
        totalAcceptedAmount: BigInt(0),
        milestones: [milestone],
        createdAt: new Date(),
      };
    });

    it('allows editing milestone in DRAFT state', () => {
      schedule.state = 'DRAFT';
      const newDate = new Date(schedule.startDate);
      newDate.setDate(newDate.getDate() + 2);

      const result = CampaignScheduleService.attemptMilestoneEdit(
        schedule,
        'milestone-1',
        newDate,
        'admin-123'
      );

      expect(result.success).toBe(true);
      expect(result.auditEntry).toBeDefined();
    });

    it('forbids editing milestone when campaign is ACTIVE', () => {
      schedule.state = 'ACTIVE';
      const newDate = new Date(schedule.startDate);
      newDate.setDate(newDate.getDate() + 2);

      const result = CampaignScheduleService.attemptMilestoneEdit(
        schedule,
        'milestone-1',
        newDate,
        'admin-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('active');
      expect(result.affectsExistingContributions).toBe(true);
    });

    it('forbids editing locked milestone', () => {
      milestone.isLocked = true;
      milestone.lockedReason = 'Contributions accepted';
      const newDate = new Date(schedule.startDate);
      newDate.setDate(newDate.getDate() + 2);

      const result = CampaignScheduleService.attemptMilestoneEdit(
        schedule,
        'milestone-1',
        newDate,
        'admin-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('locked');
      expect(result.warning).toContain('Contributions');
    });

    it('forbids editing when new date is outside schedule range', () => {
      const outsideDate = new Date(schedule.endDate);
      outsideDate.setDate(outsideDate.getDate() + 5);

      const result = CampaignScheduleService.attemptMilestoneEdit(
        schedule,
        'milestone-1',
        outsideDate,
        'admin-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });

    it('tracks when edit affects accepted contributions', () => {
      schedule.acceptedContributionsCount = 10;
      const newDate = new Date(schedule.startDate);
      newDate.setDate(newDate.getDate() + 2);

      const result = CampaignScheduleService.attemptMilestoneEdit(
        schedule,
        'milestone-1',
        newDate,
        'admin-123'
      );

      expect(result.success).toBe(true);
      expect(result.affectsExistingContributions).toBe(true);
      expect(result.auditEntry?.affectsAcceptedContributions).toBe(true);
    });
  });

  describe('lockMilestoneForContributions', () => {
    it('locks milestone and records acceptance count', () => {
      const milestone: CampaignMilestone = {
        id: 'milestone-1',
        name: 'Planting Phase',
        scheduledDate: new Date(),
        type: 'PLANTING',
        isLocked: false,
      };

      const locked = CampaignScheduleService.lockMilestoneForContributions(milestone, 5);

      expect(locked.isLocked).toBe(true);
      expect(locked.lockedReason).toContain('5 contribution(s)');
    });
  });

  describe('identifyAffectedMilestones', () => {
    it('identifies milestones affected by schedule shortening', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextWeek = new Date(tomorrow);
      nextWeek.setDate(nextWeek.getDate() + 7);

      const milestone1: CampaignMilestone = {
        id: 'milestone-1',
        name: 'Planting Phase',
        scheduledDate: tomorrow,
        type: 'PLANTING',
        isLocked: false,
      };

      const milestone2: CampaignMilestone = {
        id: 'milestone-2',
        name: 'Verification Phase',
        scheduledDate: nextWeek,
        type: 'VERIFICATION',
        isLocked: true,
        lockedReason: 'Contributions accepted',
      };

      const schedule: CampaignSchedule = {
        campaignId: 'camp-123',
        startDate: tomorrow,
        endDate: nextWeek,
        minDurationDays: 3,
        maxDurationDays: 30,
        state: 'SCHEDULED',
        acceptedContributionsCount: 0,
        totalAcceptedAmount: BigInt(0),
        milestones: [milestone1, milestone2],
        createdAt: new Date(),
      };

      // Shorten schedule to exclude milestone2
      const shortenedEnd = new Date(tomorrow);
      shortenedEnd.setDate(shortenedEnd.getDate() + 3);

      const { affected, locked } = CampaignScheduleService.identifyAffectedMilestones(
        schedule,
        shortenedEnd
      );

      expect(affected).toHaveLength(1);
      expect(affected[0].id).toBe('milestone-2');
      expect(locked).toHaveLength(1);
    });
  });
});
