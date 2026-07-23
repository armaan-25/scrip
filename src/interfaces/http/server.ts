import express, { type Request, type Response, type NextFunction } from 'express';
import {
  authorizeTask,
  cancelAction,
  commitAction,
  delegateTaskAllowance,
  reserveAction,
  revokeTask,
  settleTask,
  showReceipt,
  showTask,
  showTaskTree,
} from '../../handlers.js';
import { ApprovalRequiredError, InvalidCredentialError, SpendLimitExceededError } from '../../lease.js';
import type { ScripRuntime } from '../../runtime.js';
import type { ActionType, TaskOutcomeStatus } from '../../store.js';

/**
 * The hosted HTTP surface, for callers that aren't a Node process embedding
 * this library directly (a remote agent, a worker in another language, a
 * distributed orchestrator). No business logic lives here - every route is
 * a thin wrapper over the exact same src/handlers.ts functions the CLI and
 * MCP server call, matching this project's "three thin surfaces, one core"
 * pattern (see ARCHITECTURE.md).
 *
 * Deliberately out of scope, and not silently pretended otherwise: there is
 * no authentication/authorization layer in front of these routes. A real
 * deployment needs its own gateway/API-key/mTLS layer in front of this -
 * see docs/PIVOT_AUDIT.md and the Dockerfile's comments for exactly what's
 * still missing before this is safe to expose publicly.
 */
export function createHttpServer(runtime: ScripRuntime): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/v1/tasks', asyncRoute(async (req, res) => {
    const { budget, taskId, task, allowance, ttlMs } = req.body ?? {};
    if (!budget || !taskId || !task || typeof allowance !== 'number') {
      throw new ValidationError('body must include budget, taskId, task (string), and allowance (number)');
    }
    const issued = await authorizeTask(runtime, { budget, taskId, task, allowance, ttlMs });
    res.status(201).json(issued);
  }));

  app.get('/v1/tasks/:taskId', asyncRoute(async (req, res) => {
    res.json(showTask(runtime, pathParam(req, 'taskId')));
  }));

  app.get('/v1/tasks/:taskId/tree', asyncRoute(async (req, res) => {
    res.json(showTaskTree(runtime, pathParam(req, 'taskId')));
  }));

  app.post('/v1/tasks/:taskId/delegate', asyncRoute(async (req, res) => {
    const credential = requireBearerCredential(req);
    const { agentId, allowance, ttlMs } = req.body ?? {};
    if (!agentId || typeof allowance !== 'number') {
      throw new ValidationError('body must include agentId (string) and allowance (number)');
    }
    const issued = delegateTaskAllowance(runtime, { parentCredential: credential, agentId, allowance, ttlMs });
    res.status(201).json(issued);
  }));

  app.post('/v1/tasks/:taskId/settle', asyncRoute(async (req, res) => {
    const { status, evidence, evidenceDetail } = (req.body ?? {}) as {
      status?: TaskOutcomeStatus;
      evidence?: string;
      evidenceDetail?: unknown;
    };
    const outcome = status ? { status, evidence, evidenceDetail: evidenceDetail as never } : undefined;
    const receipt = await settleTask(runtime, pathParam(req, 'taskId'), outcome);
    res.json(receipt);
  }));

  app.post('/v1/tasks/:taskId/revoke', asyncRoute(async (req, res) => {
    revokeTask(runtime, pathParam(req, 'taskId'));
    res.status(204).end();
  }));

  app.get('/v1/tasks/:taskId/receipt', asyncRoute(async (req, res) => {
    res.json(await showReceipt(runtime, pathParam(req, 'taskId')));
  }));

  app.post('/v1/actions/reserve', asyncRoute(async (req, res) => {
    const credential = requireBearerCredential(req);
    const { actionType, label, maximumCost } = (req.body ?? {}) as {
      actionType?: ActionType;
      label?: string;
      maximumCost?: number;
    };
    if (!actionType || !label || typeof maximumCost !== 'number') {
      throw new ValidationError('body must include actionType, label (string), and maximumCost (number)');
    }
    const reservation = reserveAction(runtime, { credential, actionType, label, maximumCost });
    res.status(201).json(reservation);
  }));

  app.post('/v1/actions/:actionId/commit', asyncRoute(async (req, res) => {
    const { actualCost } = (req.body ?? {}) as { actualCost?: number };
    if (typeof actualCost !== 'number') throw new ValidationError('body must include actualCost (number)');
    commitAction(runtime, pathParam(req, 'actionId'), actualCost);
    res.status(204).end();
  }));

  app.post('/v1/actions/:actionId/cancel', asyncRoute(async (req, res) => {
    cancelAction(runtime, pathParam(req, 'actionId'));
    res.status(204).end();
  }));

  app.use(errorHandler);
  return app;
}

export function startHttpServer(runtime: ScripRuntime, port: number) {
  const app = createHttpServer(runtime);
  return app.listen(port);
}

// ---- request helpers -------------------------------------------------

class ValidationError extends Error {}

/** Express 5 types a route param as string | string[] (for repeating segments); every route here uses a single named param, always a plain string. */
function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw new ValidationError(`Missing path parameter "${name}"`);
  return value;
}

function requireBearerCredential(req: Request): string {
  const header = req.header('authorization');
  const credential = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!credential) throw new ValidationError('Authorization: Bearer <credential> header is required');
  return credential;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const { status, message } = classifyError(error);
  res.status(status).json({ error: message });
}

function classifyError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof InvalidCredentialError) return { status: 401, message };
  if (error instanceof ApprovalRequiredError) return { status: 403, message };
  if (error instanceof SpendLimitExceededError) return { status: 402, message };
  if (error instanceof ValidationError) return { status: 400, message };
  if (message.startsWith('Unknown') || message.startsWith('No settled receipt')) return { status: 404, message };
  return { status: 400, message };
}
