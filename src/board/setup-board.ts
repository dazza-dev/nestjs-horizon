import type { INestApplication } from '@nestjs/common';
import { BoardSetup } from './board.setup';

/** Mounts the dashboard on the application. Call it in `bootstrap()` before `listen()`. */
export function setupSentinelBoard(app: INestApplication): void {
  app.get(BoardSetup).mount(app);
}
