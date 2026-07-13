import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import {
  RecommendationSnapshotConflictError,
  RecommendationSnapshotContractError,
  RecommendationSnapshotStoreUnavailableError,
  type RecommendationMarketScope,
  type RecommendationProfile,
} from '../../recommendations/RecommendationSnapshotReadPort';
import {
  ProjectionCliInputTooLargeError,
  ProjectionCliOutputTooLargeError,
  ProjectionCliProtocolError,
  ProjectionCliRejectedError,
  ProjectionCliTimeoutError,
  ProjectionCliUnavailableError,
} from '../../projections/ProjectionCliClient';
import { DailyReportProjectionPort } from '../../projections/DailyReportProjectionService';

export class DailyReportProjectionController {
  constructor(private readonly projections: DailyReportProjectionPort) {
    this.getLatest = this.getLatest.bind(this);
    this.getByDate = this.getByDate.bind(this);
    this.getHistory = this.getHistory.bind(this);
  }

  async getLatest(req: Request, res: Response): Promise<void> {
    try {
      const report = await this.projections.latest({
        profile: req.query.profile as RecommendationProfile,
        market_scope: req.query.market_scope as RecommendationMarketScope,
      });
      if (!report) {
        res.status(404).json({ error: 'Daily report not found' });
        return;
      }
      res.json(report);
    } catch (error: unknown) {
      this.handleError(res, error, 'latest');
    }
  }

  async getByDate(req: Request, res: Response): Promise<void> {
    try {
      const report = await this.projections.byDate({
        trading_day: req.params.date,
        profile: req.query.profile as RecommendationProfile,
        market_scope: req.query.market_scope as RecommendationMarketScope,
      });
      if (!report) {
        res.status(404).json({ error: 'Daily report not found' });
        return;
      }
      res.json(report);
    } catch (error: unknown) {
      this.handleError(res, error, 'byDate');
    }
  }

  async getHistory(req: Request, res: Response): Promise<void> {
    try {
      const history = await this.projections.history({
        query: req.query.query as string | undefined,
        profile: req.query.profile as RecommendationProfile | undefined,
        market_scope: req.query.market_scope as RecommendationMarketScope | undefined,
        from_day: req.query.from_day as string | undefined,
        to_day: req.query.to_day as string | undefined,
      });
      res.json(history);
    } catch (error: unknown) {
      this.handleError(res, error, 'history');
    }
  }

  private handleError(res: Response, error: unknown, operation: string): void {
    if (error instanceof RecommendationSnapshotConflictError) {
      res.status(409).json({ error: 'Recommendation snapshot authority is ambiguous' });
      return;
    }
    if (error instanceof ProjectionCliInputTooLargeError) {
      res.status(413).json({ error: 'Projection input is too large' });
      return;
    }
    if (
      error instanceof RecommendationSnapshotContractError ||
      (error instanceof ProjectionCliRejectedError && error.code === 'CONTRACT_ERROR')
    ) {
      res.status(422).json({ error: 'Recommendation snapshot contract is invalid' });
      return;
    }
    if (
      error instanceof RecommendationSnapshotStoreUnavailableError ||
      error instanceof ProjectionCliUnavailableError
    ) {
      res.status(503).json({ error: 'Daily report projection is unavailable' });
      return;
    }
    if (error instanceof ProjectionCliTimeoutError) {
      res.status(504).json({ error: 'Daily report projection timed out' });
      return;
    }
    if (
      error instanceof ProjectionCliOutputTooLargeError ||
      error instanceof ProjectionCliProtocolError ||
      error instanceof ProjectionCliRejectedError
    ) {
      res.status(502).json({ error: 'Daily report projection failed' });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[DailyReportProjectionController.${operation}] ${message}`);
    res.status(500).json({ error: 'Failed to project daily report' });
  }
}
