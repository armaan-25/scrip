import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { RampOAuthClient } from '../src/ramp-oauth.js';

async function main() {
  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;
  const baseUrl = process.env.RAMP_API_BASE_URL ?? 'https://demo-api.ramp.com';
  if (!clientId || !clientSecret) {
    console.error('RAMP_CLIENT_ID/RAMP_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }

  const oauth = new RampOAuthClient({
    clientId,
    clientSecret,
    tokenUrl: `${baseUrl}/developer/v1/token`,
    scope: 'users:read',
  });
  const token = await oauth.getAccessToken();

  const response = await fetch(`${baseUrl}/developer/v1/users`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    console.error(`GET /developer/v1/users failed with status ${response.status}: ${await response.text()}`);
    process.exit(1);
  }

  const body = (await response.json()) as {
    data: Array<{ id: string; first_name: string; last_name: string; email: string; role: string }>;
  };
  for (const user of body.data) {
    console.log(`${user.id}  ${user.first_name} ${user.last_name} <${user.email}>  (${user.role})`);
  }
  console.log(`\n${body.data.length} user(s). Copy one id above into RAMP_CARDHOLDER_USER_ID in .env.`);
}

main().catch((error) => {
  console.error('ERROR:', error);
  process.exit(1);
});
