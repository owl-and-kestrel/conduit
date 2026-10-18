import { existsSync, writeFileSync } from 'node:fs';
import { pauseSession } from '../../../src/sessions/session-store.js';

// Pauses every session whose id is passed on the command line, one
// read-modify-write at a time. Used by the session-store concurrency test to
// simulate two independent Conduit processes updating the store at once.
//
// Start barrier: process startup (tsx) takes long enough that two children
// would otherwise rarely overlap. Each child announces itself by writing
// CONDUIT_TEST_READY_FILE, then waits for the test to create
// CONDUIT_TEST_GO_FILE, so both start their writes together. The wait is
// bounded so a broken test cannot leave a child running forever.
const readyFile = process.env.CONDUIT_TEST_READY_FILE;
const goFile = process.env.CONDUIT_TEST_GO_FILE;
if (readyFile && goFile) {
  writeFileSync(readyFile, String(process.pid));
  const deadline = Date.now() + 20_000;
  while (!existsSync(goFile)) {
    if (Date.now() > deadline) {
      console.error('pause-many: start barrier never opened');
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

for (const id of process.argv.slice(2)) {
  await pauseSession(id);
}
