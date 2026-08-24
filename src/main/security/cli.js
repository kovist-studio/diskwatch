'use strict';

// Prints the audit to the console. Pure Node — no Electron — so the checks can
// be exercised without launching the app: `npm run audit`.

const { runAudit, formatAudit } = require('./index');

runAudit()
  .then((audit) => {
    console.log(formatAudit(audit));
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(audit, null, 2));
    }
  })
  .catch((err) => {
    console.error('The audit could not run:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
