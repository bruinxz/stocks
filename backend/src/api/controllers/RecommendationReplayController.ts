import type { Request, Response } from 'express';
import {
  ReplayCliAbortedError,
  ReplayCliInputTooLargeError,
  ReplayCliOutputTooLargeError,
  ReplayCliProtocolError,
  ReplayCliRejectedError,
  ReplayCliTimeoutError,
  ReplayCliUnavailableError,
} from '../../replay/ReplayCliClient';
import type { ReplayJob, ReplayMarketScope, ReplayProfile } from '../../replay/ReplayContract';
import {
  ReplayBackpressureError,
  type ReplayJobSupervisor,
} from '../../replay/ReplayJobSupervisor';
import {
  ReplayPinsConflictError,
  ReplayPinsNotFoundError,
  ReplayPinsStoreUnavailableError,
  type ReplayPinsReadPort,
} from '../../replay/ReplayPinsReadPort';
import { logger } from '../../utils/logger';

export interface RecommendationReplayPort {
  submitAndRun(pins: Parameters<ReplayJobSupervisor['submitAndRun']>[0]): Promise<ReplayJob>;
  status(job_id: string): Promise<ReplayJob>;
}

export class RecommendationReplayController {
  constructor(
    private readonly pins: ReplayPinsReadPort,
    private readonly replay: RecommendationReplayPort
  ) {
    this.submit = this.submit.bind(this);
    this.status = this.status.bind(this);
  }

  async submit(req: Request, res: Response): Promise<void> {
    try {
      const pins = await this.pins.resolve({
        trading_day: req.body.trading_day,
        profile: req.body.profile as ReplayProfile,
        market_scope: req.body.market_scope as ReplayMarketScope,
      });
      const job = await this.replay.submitAndRun(pins);
      res.status(job.status === 'queued' || job.status === 'running' ? 202 : 200).json(job);
    } catch (error: unknown) {
      this.handleError(res, error, 'submit');
    }
  }

  async status(req: Request, res: Response): Promise<void> {
    try {
      res.json(await this.replay.status(String(req.query.job_id)));
    } catch (error: unknown) {
      this.handleError(res, error, 'status');
    }
  }

  private handleError(res: Response, error: unknown, operation: string): void {
    if (error instanceof ReplayPinsNotFoundError) {
      res.status(404).json({ error: 'Replay source capture not found' });
      return;
    }
    if (error instanceof ReplayPinsConflictError) {
      res.status(409).json({ error: 'Replay source capture is ambiguous' });
      return;
    }
    if (error instanceof ReplayPinsStoreUnavailableError) {
      res.status(503).json({ error: 'Replay source capture store is unavailable' });
      return;
    }
    if (error instanceof ReplayBackpressureError) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Replay service is busy' });
      return;
    }
    if (error instanceof ReplayCliInputTooLargeError) {
      res.status(413).json({ error: 'Replay request is too large' });
      return;
    }
    if (error instanceof ReplayCliTimeoutError) {
      res.status(504).json({ error: 'Replay service timed out' });
      return;
    }
    if (error instanceof ReplayCliUnavailableError || error instanceof ReplayCliAbortedError) {
      res.status(503).json({ error: 'Replay service is unavailable' });
      return;
    }
    if (error instanceof ReplayCliOutputTooLargeError || error instanceof ReplayCliProtocolError) {
      res.status(502).json({ error: 'Replay service returned an invalid response' });
      return;
    }
    if (error instanceof ReplayCliRejectedError) {
      switch (error.code) {
        case 'INPUT_TOO_LARGE':
          res.status(413).json({ error: 'Replay request is too large' });
          return;
        case 'REPLAY_JOB_NOT_FOUND':
          res.status(404).json({ error: 'Replay job not found' });
          return;
        case 'REPLAY_CONFLICT':
          res.status(409).json({ error: 'Replay job conflict' });
          return;
        case 'INVALID_REPLAY_PINS':
          res.status(422).json({ error: 'Replay pins are invalid' });
          return;
        case 'REPLAY_RUNTIME_UNAVAILABLE':
        case 'REPLAY_STORE_UNAVAILABLE':
          res.status(503).json({ error: 'Replay service is unavailable' });
          return;
        default:
          res.status(502).json({ error: 'Replay service rejected the request' });
          return;
      }
    }

    logger.error(`[RecommendationReplayController.${operation}] unexpected replay failure`);
    res.status(500).json({ error: 'Failed to process replay job' });
  }
}
