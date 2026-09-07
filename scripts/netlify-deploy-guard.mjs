import { execFileSync } from 'node:child_process';

const context = process.env.CONTEXT || '';

// Branch deploys and Deploy Previews must continue normally.
if (context !== 'production') {
  console.log(`Netlify deploy guard: ${context || 'unknown'} context -> build allowed.`);
  process.exit(1);
}

let message = '';
try {
  message = execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf8' });
} catch (error) {
  console.error('Netlify deploy guard: unable to read the production commit message. Failing closed.', error);
  process.exit(0);
}

const approved = message.includes('[release-approved]');

if (approved) {
  console.log('Netlify deploy guard: explicit [release-approved] marker found -> production build allowed.');
  process.exit(1);
}

console.log('Netlify deploy guard: no [release-approved] marker -> production build skipped.');
process.exit(0);
