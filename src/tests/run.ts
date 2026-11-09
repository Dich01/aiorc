// Test entry point: npm test. env must be imported first so the database
// client opens a throwaway file instead of ./data/aiorc.db.
import './env';
import { runAll } from './harness';
import { stopServer } from './integration/helpers';

// Unit tests: pure functions, no server.
import './unit/engineCore.test';
import './unit/flowValidation.test';
import './unit/evalGrading.test';
import './unit/controlPlane.test';
import './unit/mcpServers.test';
import './unit/outbound.test';

// Integration tests: the real app on an ephemeral port.
import './integration/bootstrap.test';
import './integration/hardening.test';
import './integration/engine.test';
import './integration/audit.test';
import './integration/evals.test';
import './integration/harness.test';
import './integration/runners.test';
import './integration/membership.test';

runAll()
  .then(async failed => {
    await stopServer();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
