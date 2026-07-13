import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import {
  RecommendationSnapshotConflictError,
  RecommendationSnapshotContractError,
  RecommendationSnapshotNotFoundError,
  RecommendationSnapshotReadPort,
  RecommendationSnapshotStoreUnavailableError,
  type RecommendationMarketScope,
  type RecommendationProfile,
} from '../../recommendations/RecommendationSnapshotReadPort';

export class RecommendationSnapshotController {
  constructor(private readonly readPort: RecommendationSnapshotReadPort) {
    this.getLatest = this.getLatest.bind(this);
    this.getByDate = this.getByDate.bind(this);
    this.getDetail = this.getDetail.bind(this);
    this.getDiff = this.getDiff.bind(this);
  }

  async getLatest(req: Request, res: Response): Promise<void> {
    try {
      const snapshot = await this.readPort.latest({
        profile: req.query.profile as RecommendationProfile,
        market_scope: req.query.market_scope as RecommendationMarketScope,
      });
      if (!snapshot) {
        res.status(404).json({ error: 'Recommendation snapshot not found' });
        return;
      }
      res.json(snapshot);
    } catch (error: unknown) {
      this.handleError(res, error, 'latest');
    }
  }

  async getByDate(req: Request, res: Response): Promise<void> {
    try {
      const page = await this.readPort.byDate({
        trading_day: req.params.date,
        profile: req.query.profile as RecommendationProfile,
        market_scope: req.query.market_scope as RecommendationMarketScope,
        page: Number(req.query.page),
        page_size: Number(req.query.page_size),
      });
      res.json(page);
    } catch (error: unknown) {
      this.handleError(res, error, 'byDate');
    }
  }

  async getDetail(req: Request, res: Response): Promise<void> {
    try {
      const snapshot = await this.readPort.detail(req.params.snapshot_id);
      if (!snapshot) {
        res.status(404).json({ error: 'Recommendation snapshot not found' });
        return;
      }
      res.json(snapshot);
    } catch (error: unknown) {
      this.handleError(res, error, 'detail');
    }
  }

  async getDiff(req: Request, res: Response): Promise<void> {
    try {
      const diff = await this.readPort.diff(
        String(req.query.base_snapshot_id),
        String(req.query.target_snapshot_id)
      );
      res.json(diff);
    } catch (error: unknown) {
      this.handleError(res, error, 'diff');
    }
  }

  private handleError(res: Response, error: unknown, operation: string): void {
    if (error instanceof RecommendationSnapshotNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof RecommendationSnapshotConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof RecommendationSnapshotContractError) {
      res.status(422).json({ error: error.message });
      return;
    }
    if (error instanceof RecommendationSnapshotStoreUnavailableError) {
      res.status(503).json({ error: error.message });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[RecommendationSnapshotController.${operation}] ${message}`);
    res.status(500).json({ error: 'Failed to browse recommendation snapshots' });
  }
}
